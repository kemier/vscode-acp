/**
 * Minimal MemoryCore v3 HTTP client (strict isolation).
 *
 * Talks to the Gateway `/v3/*` data plane without depending on the unpublished
 * `@tencentdb-agent-memory/memory-sdk-ts-v2` package. Envelope contract matches
 * the SDK: `{ code: 0, data, message, request_id }`.
 */

export interface MemoryIsolation {
  teamId: string;
  agentId: string;
  userId: string;
  sessionId?: string;
  taskId?: string;
}

export interface MemoryHttpClientOptions {
  endpoint: string;
  apiKey: string;
  serviceId: string;
  timeoutMs?: number;
  /** Retries after transient network / 502–504 errors (0 = no retries). */
  retryCount?: number;
  /** Delay between retry attempts (milliseconds). */
  retryDelayMs?: number;
  /** When true, log per-request latency + status to the 'ACP Client' channel. */
  debug?: boolean;
}

export interface AtomicSearchHit {
  id: string;
  type: string;
  content: string;
  score?: number;
}

export interface ScenarioEntry {
  path: string;
  summary?: string;
  created_at?: string;
  updated_at?: string;
}

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: string;
}

interface ApiEnvelope<T> {
  code?: number;
  message?: string;
  request_id?: string;
  data?: T;
}

import { log } from '../../utils/Logger';
import { isRetryableMemoryFetchError, sleep } from './MemoryHttpRetry';

export { isRetryableMemoryFetchError } from './MemoryHttpRetry';

export class MemoryHttpError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly requestId: string = '',
  ) {
    super(message);
    this.name = 'MemoryHttpError';
  }
}

export class MemoryHttpClient {
  private readonly endpoint: string;
  private readonly serviceId: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly retryCount: number;
  private readonly retryDelayMs: number;
  private readonly debug: boolean;

  constructor(opts: MemoryHttpClientOptions) {
    if (!opts.endpoint?.trim()) {
      throw new Error('MemoryHttpClient requires endpoint');
    }
    if (!opts.apiKey?.trim()) {
      throw new Error('MemoryHttpClient requires apiKey');
    }
    if (!opts.serviceId?.trim()) {
      throw new Error('MemoryHttpClient requires serviceId');
    }
    this.endpoint = opts.endpoint.replace(/\/+$/, '');
    this.serviceId = opts.serviceId;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.retryCount = Math.max(0, opts.retryCount ?? 2);
    this.retryDelayMs = Math.max(0, opts.retryDelayMs ?? 1000);
    this.debug = opts.debug === true;
    this.headers = {
      Authorization: `Bearer ${opts.apiKey}`,
      'x-tdai-service-id': opts.serviceId,
      'Content-Type': 'application/json',
    };
  }

  private isolationBody(iso: MemoryIsolation): Record<string, unknown> {
    const body: Record<string, unknown> = {
      team_id: iso.teamId,
      agent_id: iso.agentId,
    };
    // user_id is omitted for profile-scope reads (see readCore).
    if (iso.userId) {
      body.user_id = iso.userId;
    }
    if (iso.sessionId) {
      body.session_id = iso.sessionId;
    }
    if (iso.taskId) {
      body.task_id = iso.taskId;
    }
    return body;
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const maxAttempts = this.retryCount + 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.postOnce<T>(path, body);
      } catch (e) {
        lastError = e;
        const canRetry = attempt < maxAttempts && isRetryableMemoryFetchError(e);
        if (!canRetry) {
          throw e;
        }
        if (this.debug) {
          log(
            `Memory HTTP ${path} retry ${attempt}/${this.retryCount} after ` +
              `${e instanceof Error ? e.message : String(e)}`,
          );
        }
        if (this.retryDelayMs > 0) {
          await sleep(this.retryDelayMs);
        }
      }
    }
    throw lastError;
  }

  private async postOnce<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    // Time the full request (DNS + connect + gateway processing + body read)
    // so recall latency can be attributed to the gateway vs the network.
    const t0 = this.debug ? performance.now() : 0;
    try {
      const response = await fetch(`${this.endpoint}${path}`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const responseText = await response.text().catch(() => '');
      if (this.debug) {
        const elapsed = (performance.now() - t0).toFixed(1);
        log(
          `Memory HTTP ${path} → HTTP ${response.status} in ${elapsed}ms ` +
            `(bytes=${responseText.length}, agent=${body.agent_id ?? '?'})`,
        );
      }
      if (response.ok && responseText.trim() === '') {
        // Some gateway endpoints answer 200 with an empty body when the
        // requested isolation scope has no data. Treat that as "no data"
        // instead of a parse error.
        return {} as T;
      }
      let envelope: ApiEnvelope<T>;
      try {
        envelope = JSON.parse(responseText) as ApiEnvelope<T>;
      } catch {
        throw new MemoryHttpError(
          response.ok ? -1 : response.status,
          responseText || `HTTP ${response.status} returned a non-JSON response`,
        );
      }
      const businessCode = typeof envelope.code === 'number' ? envelope.code : undefined;
      if (!response.ok || businessCode !== 0) {
        throw new MemoryHttpError(
          businessCode && businessCode !== 0 ? businessCode : response.status,
          envelope.message || `HTTP ${response.status}`,
          envelope.request_id || '',
        );
      }
      return (envelope.data ?? {}) as T;
    } catch (e) {
      if (this.debug) {
        const cause = e instanceof Error && e.cause ? ` cause=${JSON.stringify(e.cause)}` : '';
        log(`Memory HTTP ${path} ERROR: ${e instanceof Error ? e.message : String(e)}${cause}`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  searchAtomic(iso: MemoryIsolation, params: { query: string; limit?: number }): Promise<{ items: AtomicSearchHit[] }> {
    // Omit session_id on recall so search aggregates across sessions for
    // this team+agent+user (Model B per-agent memory).
    const { sessionId: _sessionId, ...rest } = iso;
    return this.post('/v3/atomic/search', {
      ...this.isolationBody(rest),
      query: params.query,
      limit: params.limit,
    });
  }

  readCore(iso: MemoryIsolation): Promise<{ content: string | null }> {
    // The L3 persona is generated at profile scope (team_id|agent_id) — the
    // gateway logs it as `scope=team:<team>|agent:<agent>`. Sending user_id
    // narrows the lookup to a per-user profile that does not exist, and the
    // gateway answers 200 with an empty body, so the persona would never be
    // injected. Read at profile scope instead.
    const { sessionId: _sessionId, userId: _userId, ...profile } = iso;
    return this.post('/v3/core/read', this.isolationBody(profile as MemoryIsolation));
  }

  listScenarios(iso: MemoryIsolation): Promise<{ entries: ScenarioEntry[] }> {
    return this.post('/v3/scenario/ls', this.isolationBody({ ...iso, sessionId: undefined }));
  }

  listSkills(
    iso: MemoryIsolation,
    params?: { query?: string; charBudget?: number },
  ): Promise<{ items: Array<{ skill_id: string; name: string; description: string; version: number }> }> {
    const { sessionId: _sessionId, ...rest } = iso;
    // The gateway's /v3/skill/listing answers with a pre-rendered
    // `<available_skills>` markdown block (`listing`) plus structured `hits`
    // (skill_id/name/version). The recall formatter wants structured entries,
    // so parse the block back into items — reading `.items` off the raw
    // response always came up empty (skills=0 in every recall).
    return this.post<{
      mode: 'full' | 'search';
      listing: string;
      hits?: Array<{ skill_id: string; name: string; version: number }>;
    }>('/v3/skill/listing', {
      ...this.isolationBody(rest),
      query: params?.query,
      char_budget: params?.charBudget ?? 8000,
    }).then((res) => {
      const byName = new Map((res.hits ?? []).map((h) => [h.name, h]));
      const items: Array<{ skill_id: string; name: string; description: string; version: number }> = [];
      for (const line of (res.listing ?? '').split('\n')) {
        const m = /^-\s+([^:]+):\s*(.*)$/.exec(line.trim());
        if (!m) {
          continue;
        }
        const name = m[1].trim();
        const hit = byName.get(name);
        items.push({
          skill_id: hit?.skill_id ?? name,
          name,
          description: m[2].trim(),
          version: hit?.version ?? 0,
        });
      }
      return { items };
    });
  }

  /**
   * Skill conversation-add: feed each turn's messages into the skill
   * extraction pipeline. The gateway buffers messages and triggers
   * LLM-based skill extraction when thresholds (bytes/tool-call count)
   * are exceeded. This is a separate pipeline from /v3/conversation/add
   * (memory L1 extraction).
   */
  skillConversationAdd(
    iso: MemoryIsolation,
    params: {
      sessionId: string;
      messages: Array<{ role: string; content: string; timestamp?: string; tool_call_id?: string }>;
    },
  ): Promise<{ status: string }> {
    const { sessionId: _sessionId, ...rest } = iso;
    return this.post('/v3/skill/conversation/add', {
      ...this.isolationBody(rest),
      session_id: params.sessionId,
      messages: params.messages.map((m) => ({
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        tool_call_id: m.tool_call_id,
      })),
    });
  }

  /**
   * Skill force-archive: force the gateway to archive the current per-session
   * skill-extraction buffer, bypassing the ≥10 tool_call / ≥40KB thresholds.
   * The gateway's worker then runs LLM skill extraction on the buffered
   * conversation. Maps to POST /v3/skill/conversation/force-archive.
   *
   * NOTE: the gateway's forceArchiveRequestSchema REQUIRES `space_id` (no
   * fallback to the x-tdai-service-id header, unlike /v3/skill/extract).
   * We pass `this.serviceId`, which equals the x-tdai-service-id header and
   * `settings.serviceId`. `reason` is optional and, when set, is injected
   * into the extractor LLM prompt to prime the extraction intent.
   */
  skillForceArchive(
    iso: MemoryIsolation,
    params: { sessionId: string; reason?: string },
  ): Promise<{ status: string; task_id?: string; archived_at_ms?: number }> {
    const { sessionId: _sessionId, ...rest } = iso;
    return this.post('/v3/skill/conversation/force-archive', {
      ...this.isolationBody(rest),
      space_id: this.serviceId,
      session_id: params.sessionId,
      ...(params.reason ? { reason: params.reason } : {}),
    });
  }

  getSkill(
    iso: MemoryIsolation,
    skillId: string,
  ): Promise<{ skill_id: string; name: string; description: string; content: string; version: number }> {
    const { sessionId: _sessionId, ...rest } = iso;
    return this.post('/v3/skill/get', {
      ...this.isolationBody(rest),
      skill_id: skillId,
      include_content: true,
      include_manifest: false,
    });
  }

  getSkillByName(
    iso: MemoryIsolation,
    skillName: string,
  ): Promise<{ skill_id: string; name: string; description: string; content: string; version: number }> {
    const { sessionId: _sessionId, ...rest } = iso;
    return this.post('/v3/skill/get-by-name', {
      ...this.isolationBody(rest),
      skill_name: skillName,
      include_content: true,
      include_manifest: false,
    });
  }

  searchSkills(
    iso: MemoryIsolation,
    params: { query: string; topK?: number },
  ): Promise<{ items: Array<{ skill_id: string; name: string; description: string; score?: number }> }> {
    const { sessionId: _sessionId, ...rest } = iso;
    return this.post('/v3/skill/search', {
      ...this.isolationBody(rest),
      query: params.query,
      top_k: params.topK ?? 5,
    });
  }

  addConversation(
    iso: MemoryIsolation,
    params: { sessionId: string; messages: ConversationMessage[] },
  ): Promise<{ accepted_ids: string[]; total_count: number }> {
    if (!params.sessionId) {
      throw new Error('addConversation requires sessionId');
    }
    return this.post('/v3/conversation/add', {
      ...this.isolationBody(iso),
      session_id: params.sessionId,
      messages: params.messages,
    });
  }
}

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
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
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
    this.timeoutMs = opts.timeoutMs ?? 15_000;
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
    return this.post('/v3/skill/listing', {
      ...this.isolationBody(rest),
      query: params?.query,
      char_budget: params?.charBudget ?? 8000,
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

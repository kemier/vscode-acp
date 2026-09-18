/**
 * Shared memory for ACP agents via TencentDB MemoryCore (Model B).
 *
 * - team_id / user_id / service_id are shared across all ACP agents
 * - agent_id is per agent type (codex / claude / kiro / …)
 * - Recall injects L1 + L2/L3 for that agent profile before session/prompt
 * - Capture writes L0 conversation turns after the prompt completes
 *
 * Per-prompt injection: every user prompt gets a fresh recall blob (L1
 * memories + L3 persona + L2 scenes + skills). The gateway returns
 * query-relevant top-k memories, so the same memory can appear on
 * consecutive prompts — that's fine. The blob is a per-prompt snapshot,
 * not an accumulating list. After compaction, the next prompt re-injects
 * everything (full path) since the prior blobs were summarized away.
 *
 * Score threshold: L1 memories below `minScore` are excluded. Items
 * without a score (undefined) are always included (gateway may not return
 * scores for all items).
 */
import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { SessionNotification } from '@agentclientprotocol/sdk';

import { buildMemoryBlock } from '../ContextBlockBuilder';
import type { SessionUpdateHandler } from '../../handlers/SessionUpdateHandler';
import { log, logError } from '../../utils/Logger';
import { isMemoryConfigured, readMemorySettings, type MemorySettings } from './MemoryConfig';
import { resolveMemoryAgentId } from './MemoryAgentId';
import { formatRecallContext, type SkillEntry } from './MemoryFormat';
import { formatMemorySkillTools } from './MemorySkillTools';
import { resolveSkillToolsBlockForInject } from './MemoryRecallInject';
import { l1DedupKey, skillDedupKey } from './MemoryDedup';
import { MemoryHttpClient, type MemoryIsolation } from './MemoryHttpClient';
import {
  buildRecallQuery,
  sanitizeMemoryText,
  shouldCaptureL0,
  stripCodeBlocks,
  truncateForCapture,
} from './MemorySanitize';
import {
  shouldIncludeL1WrapperForMode,
  shouldIncludeSkillsFooterForMode,
  type MemoryInjectMode,
} from '../MemoryCacheStability';
import { buildSkillConversationMessages, type SkillToolCall } from './SkillFeed';

interface PendingTurn {
  agentName: string;
  memoryAgentId: string;
  userText: string;
  assistantText: string;
  /** Tool calls seen during this turn (feed the skill pipeline's tool-call threshold). */
  toolCalls: SkillToolCall[];
  startedAt: number;
}

/**
 * Per-session L1 memory IDs that have already been injected into the
 * conversation. Filtered from subsequent recall results to avoid
 * accumulating duplicate `<relevant-memories>` entries across turns.
 *
 * Cleared on:
 *  - Full recall (persona + scenes re-injected, e.g. after compaction)
 *  - Session end / disposal
 *
 * NOT cleared on:
 *  - l1-only recall (the full recall is still in conversation history)
 */
interface SessionL1State {
  injectedIds: Set<string>;
  injectedSkillIds: Set<string>;
}

/**
 * Optional storage hook so the per-session dedup state (injectedIds /
 * injectedSkillIds) survives a VS Code reload / extension-host restart.
 * Without it the state is in-memory only and the first prompt after a
 * restart re-injects the full skill + L1 set even though the agent's own
 * conversation history already contains the earlier injections.
 */
export interface L1StateStorage {
  get(): Record<string, { injectedIds: string[]; injectedSkillIds: string[] }> | undefined;
  update(value: Record<string, { injectedIds: string[]; injectedSkillIds: string[] }>): void;
  delete(): void;
}


export class SharedMemoryProvider {
  private readonly listener: (update: SessionNotification) => void;
  private readonly turns = new Map<string, PendingTurn>();
  /**
   * Delegations already recorded, so a re-sent tool call is not stored twice.
   *
   * codex-acp emits its collab tool call as both `tool_call` and
   * `tool_call_update` with the same rawInput, and a session can repeat the same
   * delegation. Bounded in captureDelegatedTask.
   */
  private readonly seenDelegations = new Set<string>();
  private readonly l1State = new Map<string, SessionL1State>();
  private client: MemoryHttpClient | null = null;
  private cachedSettingsKey = '';
  private skillBridgeBaseUrl = '';

  constructor(
    private readonly sessionUpdateHandler: SessionUpdateHandler,
    private readonly l1StateStorage?: L1StateStorage,
  ) {
    this.listener = (update) => this.onSessionUpdate(update);
    this.sessionUpdateHandler.addListener(this.listener);
    this.restoreL1StateFromStorage();
  }

  dispose(): void {
    this.sessionUpdateHandler.removeListener(this.listener);
    this.turns.clear();
    this.l1State.clear();
    this.client = null;
    this.skillBridgeBaseUrl = '';
  }

  /** Set by extension after MemorySkillBridge starts (localhost curl target). */
  setSkillBridgeBaseUrl(url: string): void {
    this.skillBridgeBaseUrl = url.replace(/\/+$/, '');
  }

  /**
   * Load persisted l1State (if any) into memory on startup so dedup
   * continues across reloads. A session that no longer exists in the
   * history (e.g. deleted) simply never gets a recall call, so its stale
   * entry is harmless; resetL1Dedup removes it on compaction / disposal.
   */
  private restoreL1StateFromStorage(): void {
    if (!this.l1StateStorage) {return;}
    let persisted: Record<string, { injectedIds: string[]; injectedSkillIds: string[] }> | undefined;
    try {
      persisted = this.l1StateStorage.get();
    } catch {
      return;
    }
    if (!persisted) {return;}
    for (const [sid, st] of Object.entries(persisted)) {
      if (!sid || !st) {continue;}
      this.l1State.set(sid, {
        injectedIds: new Set(Array.isArray(st.injectedIds) ? st.injectedIds : []),
        injectedSkillIds: new Set(Array.isArray(st.injectedSkillIds) ? st.injectedSkillIds : []),
      });
    }
  }

  /** Serialize the in-memory l1State to storage (fire-and-forget). */
  private persistL1StateToStorage(): void {
    if (!this.l1StateStorage) {return;}
    try {
      const out: Record<string, { injectedIds: string[]; injectedSkillIds: string[] }> = {};
      for (const [sid, st] of this.l1State.entries()) {
        out[sid] = {
          injectedIds: Array.from(st.injectedIds),
          injectedSkillIds: Array.from(st.injectedSkillIds),
        };
      }
      this.l1StateStorage.update(out);
    } catch {
      // Persistence is best-effort; the in-memory state still works.
    }
  }

  isEnabled(): boolean {
    return isMemoryConfigured(readMemorySettings());
  }

  /** True when verbose recall/inject timing logging is enabled. */
  isDebug(): boolean {
    return this.getSettings().debug === true;
  }

  private getSettings(): MemorySettings {
    return readMemorySettings();
  }

  private getClient(settings: MemorySettings): MemoryHttpClient {
    const key =
      `${settings.endpoint}|${settings.apiKey}|${settings.serviceId}|${settings.timeoutMs}|` +
      `${settings.recallRetryCount}|${settings.recallRetryDelayMs}|${settings.debug}`;
    if (!this.client || this.cachedSettingsKey !== key) {
      this.client = new MemoryHttpClient({
        endpoint: settings.endpoint,
        apiKey: settings.apiKey,
        serviceId: settings.serviceId,
        timeoutMs: settings.timeoutMs,
        retryCount: settings.recallRetryCount,
        retryDelayMs: settings.recallRetryDelayMs,
        debug: settings.debug,
      });
      this.cachedSettingsKey = key;
    }
    return this.client;
  }

  private isolation(settings: MemorySettings, memoryAgentId: string, sessionId?: string): MemoryIsolation {
    return {
      teamId: settings.teamId,
      agentId: memoryAgentId,
      userId: settings.userId,
      sessionId,
    };
  }

  /**
   * Recall memory for the agent profile and return ACP ContentBlocks to prepend.
   * Never throws — recall failures are logged and return [].
   *
   * Every prompt gets a fresh recall: L1 memories (semantic search, score-
   * filtered), L3 persona, L2 scene nav, and skills. No dedup across prompts
   * — each prompt's blob is an independent snapshot.
   */
  async buildRecallBlocks(opts: {
    sessionId: string;
    agentName: string;
    query: string;
    supportsEmbedded: boolean;
    /** Override settings.includePersona for this call (L1-only later turns). */
    includePersona?: boolean;
    /** Override settings.includeSceneNav for this call. */
    includeSceneNav?: boolean;
    /** Override settings.includeSkills for this call (L1-only later turns). */
    includeSkills?: boolean;
    /** Inject <memory_skill_tools> curl recipes (first full profile turn only). */
    includeSkillTools?: boolean;
    /** Recall inject mode — controls incremental formatting (wrapper/footer). */
    injectMode?: MemoryInjectMode;
    /** Epoch ms of the last compaction for this session. When set, L1 recall
     *  is scoped to memories captured in THIS session since that time
     *  (session + time filter). Before the first compaction this is unset and
     *  recall stays global. */
    lastCompactionTime?: number;
  }): Promise<ContentBlock[]> {
    const settings = this.getSettings();
    if (!isMemoryConfigured(settings)) {
      return [];
    }
    if (!opts.query.trim()) {
      return [];
    }

    const memoryAgentId = resolveMemoryAgentId(opts.agentName, settings.agentIdMap);
    const client = this.getClient(settings);
    const iso = this.isolation(settings, memoryAgentId);
    // The raw prompt may carry a previously injected recall blob plus @file /
    // @terminal context and can exceed the gateway's 2048-char query limit.
    // Slash commands (e.g. /compact) are non-local prompts forwarded to the
    // LLM; strip the leading '/' so the semantic query runs on the command
    // name (e.g. "compact") and the full profile (persona + scenes + skills)
    // is injected — otherwise the LLM summarizes with no memory context.
    const query = buildRecallQuery(opts.query.startsWith('/') ? opts.query.slice(1) : opts.query);
    if (!query) {
      return [];
    }

    if (settings.debug) {
      log(
        `Memory recall START: session=${opts.sessionId} agent=${opts.agentName}→${memoryAgentId} ` +
          `queryLen=${query.length} endpoint=${settings.endpoint}`,
      );
    }
    const recallT0 = settings.debug ? performance.now() : 0;

    try {
      const armT0 = settings.debug ? performance.now() : 0;
      const includePersona = opts.includePersona ?? settings.includePersona;
      const includeSceneNav = opts.includeSceneNav ?? settings.includeSceneNav;
      const includeSkills = opts.includeSkills ?? settings.includeSkills;
      const includeSkillTools = opts.includeSkillTools ?? false;
      const [searchResult, personaResult, scenesResult, skillsResult] = await Promise.allSettled([
        client.searchAtomic(iso, { query, limit: settings.recallMaxResults }),
        includePersona ? client.readCore(iso) : Promise.resolve(null),
        includeSceneNav ? client.listScenarios(iso) : Promise.resolve(null),
        includeSkills ? client.listSkills(iso, { query, charBudget: settings.skillCharBudget }) : Promise.resolve(null),
      ]);
      if (settings.debug) {
        // Per-arm wall time (all three ran concurrently, so each is the time
        // from dispatch to its own settlement, not sequential).
        const armElapsed = (performance.now() - armT0).toFixed(1);
        const l1Status =
          searchResult.status === 'fulfilled' ? 'ok' : `fail(${(searchResult.reason as Error)?.message?.slice(0, 80)})`;
        const personaStatus =
          personaResult.status === 'fulfilled'
            ? 'ok'
            : `fail(${(personaResult.reason as Error)?.message?.slice(0, 80)})`;
        const scenesStatus =
          scenesResult.status === 'fulfilled' ? 'ok' : `fail(${(scenesResult.reason as Error)?.message?.slice(0, 80)})`;
        log(
          `Memory recall arms settled in ${armElapsed}ms: L1=${l1Status} persona=${personaStatus} scenes=${scenesStatus}`,
        );
      }

      let l1Items =
        searchResult.status === 'fulfilled'
          ? (searchResult.value.items ?? []).map((i) => ({
              id: i.id,
              content: i.content,
              type: i.type,
              session_id: i.session_id,
              created_at: i.created_at,
              score: i.score,
              source_message_ids: i.source_message_ids,
            }))
          : [];
      if (searchResult.status === 'rejected') {
        logError('Memory recall L1 search failed', searchResult.reason);
      }

      // Score threshold: filter out low-relevance memories below minScore.
      // Items without a score (undefined) are always kept (gateway may not
      // return scores for all items).
      const minScore = settings.minScore;
      if (minScore > 0) {
        const before = l1Items.length;
        l1Items = l1Items.filter((item) => item.score === undefined || item.score >= minScore);
        if (settings.debug && l1Items.length < before) {
          log(`L1 score filter: ${before} → ${l1Items.length} (minScore=${minScore})`);
        }
      }

      // Session + time filter: after a compaction, scope L1 recall to memories
      // captured in THIS session SINCE the last compaction. Memories from
      // earlier in the session (pre-compaction) or from other sessions are
      // excluded, so the post-compaction recall reflects only the current
      // working window. Before the first compaction (lastCompactionTime unset)
      // recall stays global (all sessions, all time).
      if (opts.lastCompactionTime !== undefined) {
        const before = l1Items.length;
        const cutoff = opts.lastCompactionTime;
        l1Items = l1Items.filter((item) => {
          // Must belong to the current session.
          if (item.session_id && item.session_id !== opts.sessionId) {
            return false;
          }
          // Must have been created at/after the last compaction. Items without
          // a created_at (gateway may omit it) are dropped to be safe — we
          // cannot confirm they are in-window.
          if (!item.created_at) {
            return false;
          }
          const created = new Date(item.created_at).getTime();
          return Number.isFinite(created) && created >= cutoff;
        });
        if (settings.debug && l1Items.length < before) {
          log(`L1 session+time filter: ${before} → ${l1Items.length} (session=${opts.sessionId} since=${new Date(cutoff).toISOString()})`);
        }
      }

      // L1 dedup: filter out memory IDs already injected into this session.
      // Full recall resets the ID set (post-compaction: everything is fresh).
      // l1-only recall filters previously-seen IDs and accumulates new ones.
      const isFullRecall = opts.includePersona ?? settings.includePersona;
      const injectMode: MemoryInjectMode = opts.injectMode ?? (isFullRecall ? 'full' : 'l1-only');
      if (isFullRecall) {
        this.l1State.delete(opts.sessionId);
      }
      // Always create the per-session dedup state on the first recall of ANY
      // kind. The previous code only created it when isFullRecall was true,
      // but sessions that run persona=false on every recall (the common case)
      // never got state → the skill/L1 filter was a no-op and the full skill
      // list was re-injected on every prompt.
      const state = (() => {
        let s = this.l1State.get(opts.sessionId);
        if (!s) {
          s = { injectedIds: new Set(), injectedSkillIds: new Set() };
          this.l1State.set(opts.sessionId, s);
        }
        return s;
      })();
      if (state) {
        const before = l1Items.length;
        l1Items = l1Items.filter((item) => {
          const key = l1DedupKey(item);
          return !key || !state.injectedIds.has(key);
        });
        if (settings.debug && l1Items.length < before) {
          log(`L1 dedup: ${before} → ${l1Items.length} (filtered ${before - l1Items.length} already-injected)`);
        }
        for (const item of l1Items) {
          const key = l1DedupKey(item);
          if (key) {
            state.injectedIds.add(key);
          }
        }
      }

      const persona = personaResult.status === 'fulfilled' && personaResult.value ? personaResult.value.content : null;
      if (personaResult.status === 'rejected') {
        logError('Memory recall persona read failed', personaResult.reason);
      }

      const scenes =
        scenesResult.status === 'fulfilled' && scenesResult.value
          ? (scenesResult.value.entries ?? []).map((e) => ({ path: e.path }))
          : [];
      if (scenesResult.status === 'rejected') {
        logError('Memory recall scenario list failed', scenesResult.reason);
      }

      let skills: SkillEntry[] =
        skillsResult.status === 'fulfilled' && skillsResult.value ? (skillsResult.value.items ?? []) : [];
      if (skillsResult.status === 'rejected') {
        logError('Memory recall skill list failed', skillsResult.reason);
      }

      // Skill dedup: filter out skills already injected into this session.
      // Full recall resets (post-compaction: everything is fresh).
      // l1-only recall filters previously-seen skills and accumulates new ones.
      const skillState = this.l1State.get(opts.sessionId);
      if (skillState) {
        const before = skills.length;
        skills = skills.filter((s) => {
          const key = skillDedupKey(s);
          return !key || !skillState.injectedSkillIds.has(key);
        });
        if (settings.debug && skills.length < before) {
          log(`Skill dedup: ${before} → ${skills.length} (filtered ${before - skills.length} already-injected)`);
        }
        for (const s of skills) {
          const key = skillDedupKey(s);
          if (key) {
            skillState.injectedSkillIds.add(key);
          }
        }
      }
      // Persist the (possibly updated) dedup state so it survives a VS Code
      // reload / extension-host restart. The first prompt after restart then
      // still filters already-injected skills/L1 instead of re-injecting the
      // full set.
      this.persistL1StateToStorage();

      const enabledArmResults: PromiseSettledResult<unknown>[] = [searchResult];
      if (includePersona) {
        enabledArmResults.push(personaResult);
      }
      if (includeSceneNav) {
        enabledArmResults.push(scenesResult);
      }
      if (includeSkills) {
        enabledArmResults.push(skillsResult);
      }

      const rawSkillToolsBlock =
        includeSkillTools && includeSkills && this.skillBridgeBaseUrl
          ? formatMemorySkillTools({
              bridgeBaseUrl: this.skillBridgeBaseUrl,
              agentId: memoryAgentId,
            })
          : undefined;

      const skillToolsBlock = resolveSkillToolsBlockForInject(rawSkillToolsBlock, enabledArmResults);
      if (rawSkillToolsBlock && !skillToolsBlock) {
        log(
          `Memory recall: skipped skill-tools-only inject (all ${enabledArmResults.length} recall arm(s) failed) ` +
            `(agent=${opts.agentName}→${memoryAgentId}, session=${opts.sessionId})`,
        );
      }

      const formatted = formatRecallContext(l1Items, persona, scenes, skills, skillToolsBlock, {
        includeL1Wrapper: shouldIncludeL1WrapperForMode(injectMode),
        includeSkillsFooter: shouldIncludeSkillsFooterForMode(injectMode),
        bridgeBaseUrl: this.skillBridgeBaseUrl,
        agentId: memoryAgentId,
      });
      if (!formatted) {
        if (settings.debug) {
          log(
            `Memory recall END (no hits) in ${(performance.now() - recallT0).toFixed(1)}ms ` +
              `(agent=${opts.agentName}→${memoryAgentId}, session=${opts.sessionId})`,
          );
        } else {
          log(`Memory recall: no hits (agent=${opts.agentName}→${memoryAgentId}, session=${opts.sessionId})`);
        }
        return [];
      }

      if (settings.debug) {
        log(
          `Memory recall END: L1=${formatted.l1Count} persona=${formatted.hasPersona} scenes=${formatted.sceneCount} skills=${formatted.skillCount} ` +
            `blobBytes=${formatted.text.length} in ${(performance.now() - recallT0).toFixed(1)}ms ` +
            `(agent=${opts.agentName}→${memoryAgentId})`,
        );
      } else {
        log(
          `Memory recall: L1=${formatted.l1Count} persona=${formatted.hasPersona} scenes=${formatted.sceneCount} skills=${formatted.skillCount} ` +
            `(agent=${opts.agentName}→${memoryAgentId}, session=${opts.sessionId})`,
        );
      }

      const block = buildMemoryBlock(formatted.text, opts.supportsEmbedded, memoryAgentId);
      if (block) {
        return [block];
      }
      // Agents without embeddedContext still need the recall blob; send as
      // a plain text ContentBlock (same approach as legacy <terminal> fallback).
      return [{ type: 'text', text: formatted.text } as ContentBlock];
    } catch (e) {
      logError('Memory recall failed', e);
      return [];
    }
  }

  /**
   * Reset the L1 dedup state for a session. Called after compaction (the
   * conversation history is summarized, so previously-injected memory IDs
   * are no longer in the context window and must be re-injected).
   */
  resetL1Dedup(sessionId: string): void {
    this.l1State.delete(sessionId);
    // Persist the removal so it sticks across a restart (compaction or
    // session disposal must not resurrect stale IDs on next load).
    this.persistL1StateToStorage();
  }
  // (injectedSkillIds lives in the same SessionL1State — cleared together)

  /**
   * Force the gateway to archive the current skill-extraction buffer for a
   * session, bypassing the ≥10 tool_call / ≥40KB threshold. Called after
   * compaction so the summarized conversation can still be turned into a
   * recallable skill (otherwise a session that never crossed the threshold
   * would only ever produce L0/L1 memory, never a skill).
   *
   * Best-effort: a failure is logged but never throws, so a gateway hiccup
   * cannot break the compaction path. No-op when memory is disabled, capture
   * is off, or the session/agent cannot be resolved.
   */
  async flushSkillBuffer(sessionId: string, agentName: string, reason = 'compaction'): Promise<void> {
    const settings = this.getSettings();
    if (!isMemoryConfigured(settings) || !settings.captureEnabled) {
      return;
    }
    if (!sessionId || !agentName.trim()) {
      return;
    }
    try {
      const memoryAgentId = resolveMemoryAgentId(agentName, settings.agentIdMap);
      const client = this.getClient(settings);
      const iso = this.isolation(settings, memoryAgentId, sessionId);
      const result = await client.skillForceArchive(iso, { sessionId, reason });
      log(
        `Memory skill flush: status=${result.status} task_id=${result.task_id ?? ''} ` +
          `(agent=${memoryAgentId}, session=${sessionId}, reason=${reason})`,
      );
    } catch (e) {
      logError('Memory skill flush failed', e);
    }
  }

  /**
   * Capture a compaction summary as memory + skill input.
   *
   * Compaction replaces the conversation with a summary, and the per-turn
   * capture path cannot see it: `beginTurn` deliberately skips slash commands
   * (`/compact` is one), so `endTurn` -> addConversation never runs for that
   * turn. The skill buffer was already force-archived by `flushSkillBuffer`,
   * but the summarized CONTENT itself was lost — the next conversation recalled
   * the pre-compaction fragments instead of the summary that replaced them.
   *
   * Capture it through the same endpoints `endTurn` uses, so the summary becomes
   * ordinary recallable memory and skill-extraction input. Best-effort: memory
   * capture must never break the compaction flow.
   */
  async captureCompactionSummary(sessionId: string, agentName: string, summaryText: string): Promise<void> {
    const settings = this.getSettings();
    if (!isMemoryConfigured(settings) || !settings.captureEnabled) {
      return;
    }
    if (!sessionId || !agentName.trim()) {
      return;
    }
    // Same normalization as endTurn: strip injected context/markup, drop code
    // blocks (they bloat L0 without adding recall value), then bound the size.
    let content = sanitizeMemoryText(summaryText || '');
    content = stripCodeBlocks(content);
    content = truncateForCapture(content);
    if (!shouldCaptureL0(content)) {
      return;
    }
    const messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }> = [
      { role: 'assistant', content, timestamp: new Date().toISOString() },
    ];
    try {
      const memoryAgentId = resolveMemoryAgentId(agentName, settings.agentIdMap);
      const client = this.getClient(settings);
      const iso = this.isolation(settings, memoryAgentId, sessionId);
      const result = await client.addConversation(iso, { sessionId, messages });
      log(
        `Memory capture (compaction summary): ${content.length} bytes → total=${result.total_count} ` +
          `(user=${iso.userId}, team=${iso.teamId}, agent=${memoryAgentId}, session=${sessionId})`,
      );
      try {
        const skillMessages = buildSkillConversationMessages(messages, []);
        await client.skillConversationAdd(iso, { sessionId, messages: skillMessages });
        log(`Skill conversation-add (compaction summary): ${skillMessages.length} msg(s) sent (session=${sessionId})`);
      } catch (skillErr) {
        log(
          `Skill conversation-add (compaction summary) failed (non-fatal): ${(skillErr as Error)?.message ?? skillErr}`,
        );
      }
    } catch (e) {
      logError('Memory capture (compaction summary) failed', e);
    }
  }

  /**
   * Persist what a finished subagent found.
   *
   * A subagent's work is otherwise unrecoverable. Its conversation never leaves
   * ericli's process, its progress is deliberately not forwarded as
   * agent_thought_chunk, and per-turn capture records only the main assistant
   * text plus tool_call TITLES — so its findings never became L0, and therefore
   * could never be promoted to L1/L2/L3 or feed skill extraction. Five parallel
   * subagents produced nothing recallable.
   *
   * Written under the PARENT's memory agent id, not a synthetic one: recall is
   * scoped by isolation(agentId), so a separate id would store the finding and
   * then never surface it in the session that asked for it.
   *
   * The role is `assistant` because the memory core accepts nothing else — it
   * skips any other role on ingest (`role !== "user" && role !== "assistant"`).
   * Provenance therefore lives in the CONTENT, which is also where L1 extraction
   * reads it from (`[id] [role] [timestamp]: content`).
   *
   * The task is kept alongside the summary deliberately: a finding without the
   * question it answers is close to useless months later.
   *
   * Gated by its own setting, default off — a wrong memory is hard to undo once
   * L1/L2/L3 have absorbed it. Best-effort: never throws into the caller.
   */
  async captureSubagentFindings(
    sessionId: string,
    agentName: string,
    finding: {
      id?: string;
      type?: string;
      label?: string;
      task?: string;
      status?: string;
      summary?: string;
      error?: string;
      durationMs?: number;
      toolCallCount?: number;
      compactions?: number;
      unresolvedSkills?: string[];
    },
  ): Promise<void> {
    const settings = this.getSettings();
    if (!isMemoryConfigured(settings) || !settings.captureEnabled) {
      return;
    }
    if (!settings.captureSubagentFindings) {
      return;
    }
    if (!sessionId || !agentName.trim()) {
      return;
    }

    const task = sanitizeMemoryText(String(finding.task ?? '')).trim();
    let body = sanitizeMemoryText(String(finding.summary ?? ''));
    body = stripCodeBlocks(body);
    if (finding.error) {
      // A failed subagent is worth remembering too — it records that the
      // question was asked and what stopped it, which prevents a later session
      // repeating the same dead end.
      body = `${body}\n\nFailed: ${sanitizeMemoryText(String(finding.error))}`.trim();
    }
    if (!task && !body.trim()) {
      return;
    }

    const who = finding.label?.trim() || `${finding.type ?? 'subagent'}-${finding.id ?? '?'}`;
    const caveats: string[] = [];
    if (finding.compactions) {
      // The subagent answered over a digested history, so its summary can look
      // complete while missing detail. Worth carrying into recall.
      caveats.push(`compacted its own context ${finding.compactions}x`);
    }
    if (finding.unresolvedSkills?.length) {
      caveats.push(`could not load skill(s): ${finding.unresolvedSkills.join(', ')}`);
    }

    const content = truncateForCapture(
      [
        `[subagent ${who}${finding.status ? `, ${finding.status}` : ''}] delegated task: ${task || '(unrecorded)'}`,
        '',
        body.trim(),
        caveats.length > 0 ? `\n(caveats: ${caveats.join('; ')})` : '',
      ]
        .join('\n')
        .trim(),
    );
    if (!shouldCaptureL0(content)) {
      return;
    }

    const messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }> = [
      { role: 'assistant', content, timestamp: new Date().toISOString() },
    ];
    try {
      const memoryAgentId = resolveMemoryAgentId(agentName, settings.agentIdMap);
      const client = this.getClient(settings);
      const iso = this.isolation(settings, memoryAgentId, sessionId);
      const result = await client.addConversation(iso, { sessionId, messages });
      log(
        `Memory capture (subagent ${who}): ${content.length} bytes → total=${result.total_count} ` +
          `(user=${iso.userId}, team=${iso.teamId}, agent=${memoryAgentId}, session=${sessionId})`,
      );
      try {
        // Also feed skill extraction. Its buffer otherwise fills with bare tool
        // TITLES — 84 of them in one observed turn — so a subagent's actual
        // findings are the first substantive content it has had to work with.
        const skillMessages = buildSkillConversationMessages(messages, []);
        await client.skillConversationAdd(iso, { sessionId, messages: skillMessages });
        log(`Skill conversation-add (subagent ${who}): ${skillMessages.length} msg(s) sent (session=${sessionId})`);
      } catch (skillErr) {
        log(`Skill conversation-add (subagent) failed (non-fatal): ${(skillErr as Error)?.message ?? skillErr}`);
      }
    } catch (e) {
      logError('Memory capture (subagent findings) failed', e);
    }
  }

  /**
   * Record that a subagent was delegated a task, when the adapter cannot report
   * what it found.
   *
   * Two adapters supply the question but not the answer:
   *   - cursor: `cursor/task` carries `prompt`, `description`, `subagentType`,
   *     `model` and `durationMs`, but its response outcome is only
   *     completed / rejected / cancelled — no summary text;
   *   - codex-acp: the collab tool call carries `prompt` in rawInput, and its
   *     subAgentActivity updates are activity markers with no content.
   *
   * Two others cannot supply anything usable:
   *   - kiro-cli's `_kiro.dev/subagent/list_update` is live status only
   *     (sessionName, status.type, sessionId) and kiro ships as a binary here, so
   *     the payload cannot be enriched from our side;
   *   - pi-acp has no subagent concept at all.
   *
   * Marked "result not reported" deliberately. A memory implying an answer that
   * was never received is worse than no memory: L1 would extract it as fact. What
   * this DOES preserve is that the question was asked and by whom, which is what
   * makes "has this already been tried?" answerable later.
   */
  async captureDelegatedTask(
    sessionId: string,
    agentName: string,
    delegation: { id?: string; type?: string; label?: string; task?: string; durationMs?: number },
  ): Promise<void> {
    const settings = this.getSettings();
    if (!isMemoryConfigured(settings) || !settings.captureEnabled) {
      return;
    }
    if (!settings.captureSubagentFindings) {
      return;
    }
    if (!sessionId || !agentName.trim()) {
      return;
    }
    const task = truncateForCapture(stripCodeBlocks(sanitizeMemoryText(String(delegation.task ?? ''))));
    if (!task.trim()) {
      return;
    }
    const who = delegation.label?.trim() || `${delegation.type ?? 'subagent'}-${delegation.id ?? '?'}`;
    // Dedupe: codex re-sends the collab tool call as tool_call_update, and a
    // repeated identical delegation would otherwise be stored twice.
    const dedupeKey = `${sessionId}::${who}::${task.slice(0, 200)}`;
    if (this.seenDelegations.has(dedupeKey)) {
      return;
    }
    this.seenDelegations.add(dedupeKey);
    if (this.seenDelegations.size > 500) {
      // Bounded — a long session must not grow this without limit.
      this.seenDelegations.clear();
      this.seenDelegations.add(dedupeKey);
    }

    const content = truncateForCapture(
      `[subagent ${who}] delegated task: ${task}\n\n(result not reported by this agent — ` +
        'the task was recorded, the outcome was not)',
    );
    if (!shouldCaptureL0(content)) {
      return;
    }
    const messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }> = [
      { role: 'assistant', content, timestamp: new Date().toISOString() },
    ];
    try {
      const memoryAgentId = resolveMemoryAgentId(agentName, settings.agentIdMap);
      const client = this.getClient(settings);
      const iso = this.isolation(settings, memoryAgentId, sessionId);
      const result = await client.addConversation(iso, { sessionId, messages });
      log(
        `Memory capture (delegated task ${who}): ${content.length} bytes → total=${result.total_count} ` +
          `(agent=${memoryAgentId}, session=${sessionId})`,
      );
    } catch (e) {
      logError('Memory capture (delegated task) failed', e);
    }
  }

  /** Start accumulating assistant text for L0 capture after the turn ends. */
  beginTurn(sessionId: string, agentName: string, userText: string): void {
    const settings = this.getSettings();
    if (!isMemoryConfigured(settings) || !settings.captureEnabled) {
      return;
    }
    if (!userText.trim() || userText.startsWith('/')) {
      return;
    }
    const memoryAgentId = resolveMemoryAgentId(agentName, settings.agentIdMap);
    this.turns.set(sessionId, {
      agentName,
      memoryAgentId,
      userText,
      assistantText: '',
      toolCalls: [],
      startedAt: Date.now(),
    });
  }

  /**
   * Drop a turn's buffer WITHOUT capturing it.
   *
   * For a turn that failed outright (the prompt threw — upstream 503, transport
   * error, killed agent). Capturing that writes a user message paired with empty or
   * half-streamed assistant text into L0, and every retry adds another copy: the
   * embeddings traffic during one 503 burst was visible in the proxy log. Dropping
   * is not optional bookkeeping either — leaving the buffer in place would let the
   * failed text be captured by the NEXT turn's endTurn.
   */
  discardTurn(sessionId: string): void {
    if (this.turns.delete(sessionId)) {
      log(`Memory capture skipped: turn failed (session=${sessionId})`);
    }
  }

  /** Flush L0 capture for a completed (or cancelled) turn. */
  async endTurn(sessionId: string): Promise<void> {
    const turn = this.turns.get(sessionId);
    this.turns.delete(sessionId);
    if (!turn) {
      return;
    }

    const settings = this.getSettings();
    if (!isMemoryConfigured(settings) || !settings.captureEnabled) {
      return;
    }

    const userContent = truncateForCapture(sanitizeMemoryText(turn.userText));
    let assistantContent = sanitizeMemoryText(turn.assistantText);
    assistantContent = stripCodeBlocks(assistantContent);
    assistantContent = truncateForCapture(assistantContent);

    const messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }> = [];
    if (shouldCaptureL0(userContent)) {
      messages.push({
        role: 'user',
        content: userContent,
        timestamp: new Date(turn.startedAt).toISOString(),
      });
    }
    if (shouldCaptureL0(assistantContent)) {
      messages.push({
        role: 'assistant',
        content: assistantContent,
        timestamp: new Date().toISOString(),
      });
    }
    if (messages.length === 0) {
      return;
    }

    try {
      const client = this.getClient(settings);
      const iso = this.isolation(settings, turn.memoryAgentId, sessionId);
      const result = await client.addConversation(iso, { sessionId, messages });
      log(
        `Memory capture: ${messages.length} msg(s) → total=${result.total_count} ` +
          `(user=${iso.userId}, team=${iso.teamId}, agent=${turn.memoryAgentId}, session=${sessionId})`,
      );

      // Skill extraction pipeline: feed the same messages plus the turn's
      // tool calls to the skill conversation-add endpoint. The gateway
      // archives the per-session buffer and triggers LLM-based skill
      // extraction once ≥10 tool_call messages (or ≥40KB) accumulate.
      // Non-fatal: skill extraction is best-effort and independent from
      // memory capture.
      try {
        const skillMessages = buildSkillConversationMessages(messages, turn.toolCalls);
        await client.skillConversationAdd(iso, { sessionId, messages: skillMessages });
        log(
          `Skill conversation-add: ${skillMessages.length} msg(s) sent ` +
            `(${turn.toolCalls.length} tool call(s)) (user=${iso.userId}, session=${sessionId})`,
        );
      } catch (skillErr) {
        log(`Skill conversation-add failed (non-fatal): ${(skillErr as Error)?.message ?? skillErr}`);
      }
    } catch (e) {
      logError('Memory capture failed', e);
    }
  }

  private onSessionUpdate(update: SessionNotification): void {
    const turn = this.turns.get(update.sessionId);
    if (!turn) {
      return;
    }
    const data = update.update as {
      sessionUpdate?: string;
      toolCallId?: string;
      title?: string;
      content?: { type?: string; text?: string };
      rawInput?: Record<string, unknown>;
      _meta?: Record<string, unknown>;
    };
    // A subagent delegation from an adapter that reports the TASK but not the
    // result. codex-acp's collab tool call carries the prompt in rawInput and is
    // identified by _meta.codex.collaboration; cursor's is a dedicated
    // `cursor/task` notification handled separately (see captureDelegatedTask).
    //
    // Recorded as "asked, result not reported" rather than as a finding — a memory
    // that claimed an answer it never received would be worse than none.
    if (data?.sessionUpdate === 'tool_call') {
      const collab = (data._meta as { codex?: { collaboration?: { tool?: string } } } | undefined)
        ?.codex?.collaboration;
      const prompt = typeof data.rawInput?.prompt === 'string' ? data.rawInput.prompt : '';
      if (collab && prompt.trim()) {
        void this.captureDelegatedTask(update.sessionId, turn.agentName, {
          id: data.toolCallId,
          type: collab.tool || 'collab',
          task: prompt,
        }).catch(() => {
          /* best-effort, like every other capture */
        });
      }
    }
    // Tool calls feed the skill pipeline: the gateway archives a session
    // buffer once it holds ≥10 `tool_call`-role messages (or ≥40KB), and only
    // then runs LLM skill extraction. Without them the threshold is
    // unreachable. The initial `tool_call` update carries the title; dedupe
    // by toolCallId so follow-up updates don't double-count.
    if (
      data?.sessionUpdate === 'tool_call' &&
      typeof data.toolCallId === 'string' &&
      data.toolCallId &&
      typeof data.title === 'string'
    ) {
      if (!turn.toolCalls.some((tc) => tc.id === data.toolCallId)) {
        turn.toolCalls.push({ id: data.toolCallId, title: data.title, timestamp: new Date().toISOString() });
      }
      return;
    }
    if (data?.sessionUpdate !== 'agent_message_chunk') {
      return;
    }
    if (data.content?.type === 'text' && typeof data.content.text === 'string') {
      turn.assistantText += data.content.text;
    }
  }
}

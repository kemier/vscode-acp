/**
 * Shared memory for ACP agents via TencentDB MemoryCore (Model B).
 *
 * - team_id / user_id / service_id are shared across all ACP agents
 * - agent_id is per agent type (codex / claude / kiro / …)
 * - Recall injects L1 + L2/L3 for that agent profile before session/prompt
 * - Capture writes L0 conversation turns after the prompt completes
 */
import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { SessionNotification } from '@agentclientprotocol/sdk';

import { buildMemoryBlock } from '../ContextBlockBuilder';
import type { SessionUpdateHandler } from '../../handlers/SessionUpdateHandler';
import { log, logError } from '../../utils/Logger';
import { isMemoryConfigured, readMemorySettings, type MemorySettings } from './MemoryConfig';
import { resolveMemoryAgentId } from './MemoryAgentId';
import { formatRecallContext, type SkillEntry } from './MemoryFormat';
import { MemoryHttpClient, type MemoryIsolation } from './MemoryHttpClient';
import {
  buildRecallQuery,
  sanitizeMemoryText,
  shouldCaptureL0,
  stripCodeBlocks,
  truncateForCapture,
} from './MemorySanitize';
import {
  buildSkillConversationMessages,
  type SkillToolCall,
} from './SkillFeed';

interface PendingTurn {
  agentName: string;
  memoryAgentId: string;
  userText: string;
  assistantText: string;
  /** Tool calls seen during this turn (feed the skill pipeline's tool-call threshold). */
  toolCalls: SkillToolCall[];
  startedAt: number;
}

export class SharedMemoryProvider {
  private readonly listener: (update: SessionNotification) => void;
  private readonly turns = new Map<string, PendingTurn>();
  private client: MemoryHttpClient | null = null;
  private cachedSettingsKey = '';

  constructor(private readonly sessionUpdateHandler: SessionUpdateHandler) {
    this.listener = (update) => this.onSessionUpdate(update);
    this.sessionUpdateHandler.addListener(this.listener);
  }

  dispose(): void {
    this.sessionUpdateHandler.removeListener(this.listener);
    this.turns.clear();
    this.client = null;
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
    const key = `${settings.endpoint}|${settings.apiKey}|${settings.serviceId}|${settings.timeoutMs}|${settings.debug}`;
    if (!this.client || this.cachedSettingsKey !== key) {
      this.client = new MemoryHttpClient({
        endpoint: settings.endpoint,
        apiKey: settings.apiKey,
        serviceId: settings.serviceId,
        timeoutMs: settings.timeoutMs,
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
      const [searchResult, personaResult, scenesResult, skillsResult] = await Promise.allSettled([
        client.searchAtomic(iso, { query, limit: settings.recallMaxResults }),
        includePersona ? client.readCore(iso) : Promise.resolve(null),
        includeSceneNav ? client.listScenarios(iso) : Promise.resolve(null),
        settings.includeSkills
          ? client.listSkills(iso, { query, charBudget: settings.skillCharBudget })
          : Promise.resolve(null),
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

      const l1Items =
        searchResult.status === 'fulfilled'
          ? (searchResult.value.items ?? []).map((i) => ({
              id: i.id,
              content: i.content,
              type: i.type,
              score: i.score,
            }))
          : [];
      if (searchResult.status === 'rejected') {
        logError('Memory recall L1 search failed', searchResult.reason);
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

      const skills: SkillEntry[] =
        skillsResult.status === 'fulfilled' && skillsResult.value ? (skillsResult.value.items ?? []) : [];
      if (skillsResult.status === 'rejected') {
        logError('Memory recall skill list failed', skillsResult.reason);
      }

      const formatted = formatRecallContext(l1Items, persona, scenes, skills);
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
            `(agent=${opts.agentName}→${memoryAgentId})`,
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
          `(agent=${turn.agentName}→${turn.memoryAgentId}, session=${sessionId})`,
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
            `(${turn.toolCalls.length} tool call(s)) (session=${sessionId})`,
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
    };
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

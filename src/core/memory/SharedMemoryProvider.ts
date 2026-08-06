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
import { formatRecallContext } from './MemoryFormat';
import { MemoryHttpClient, type MemoryIsolation } from './MemoryHttpClient';
import { buildRecallQuery, sanitizeMemoryText, shouldCaptureL0, stripCodeBlocks } from './MemorySanitize';

interface PendingTurn {
  agentName: string;
  memoryAgentId: string;
  userText: string;
  assistantText: string;
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

  private getSettings(): MemorySettings {
    return readMemorySettings();
  }

  private getClient(settings: MemorySettings): MemoryHttpClient {
    const key = `${settings.endpoint}|${settings.apiKey}|${settings.serviceId}|${settings.timeoutMs}`;
    if (!this.client || this.cachedSettingsKey !== key) {
      this.client = new MemoryHttpClient({
        endpoint: settings.endpoint,
        apiKey: settings.apiKey,
        serviceId: settings.serviceId,
        timeoutMs: settings.timeoutMs,
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
  }): Promise<ContentBlock[]> {
    const settings = this.getSettings();
    if (!isMemoryConfigured(settings)) {
      return [];
    }
    if (!opts.query.trim() || opts.query.startsWith('/')) {
      return [];
    }

    const memoryAgentId = resolveMemoryAgentId(opts.agentName, settings.agentIdMap);
    const client = this.getClient(settings);
    const iso = this.isolation(settings, memoryAgentId);
    // The raw prompt may carry a previously injected recall blob plus @file /
    // @terminal context and can exceed the gateway's 2048-char query limit.
    const query = buildRecallQuery(opts.query);
    if (!query) {
      return [];
    }

    try {
      const [searchResult, personaResult, scenesResult] = await Promise.allSettled([
        client.searchAtomic(iso, { query, limit: settings.recallMaxResults }),
        settings.includePersona ? client.readCore(iso) : Promise.resolve(null),
        settings.includeSceneNav ? client.listScenarios(iso) : Promise.resolve(null),
      ]);

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

      const formatted = formatRecallContext(l1Items, persona, scenes);
      if (!formatted) {
        log(`Memory recall: no hits (agent=${opts.agentName}→${memoryAgentId}, session=${opts.sessionId})`);
        return [];
      }

      log(
        `Memory recall: L1=${formatted.l1Count} persona=${formatted.hasPersona} scenes=${formatted.sceneCount} ` +
          `(agent=${opts.agentName}→${memoryAgentId})`,
      );

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

    const userContent = sanitizeMemoryText(turn.userText);
    let assistantContent = sanitizeMemoryText(turn.assistantText);
    assistantContent = stripCodeBlocks(assistantContent);

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
      content?: { type?: string; text?: string };
    };
    if (data?.sessionUpdate !== 'agent_message_chunk') {
      return;
    }
    if (data.content?.type === 'text' && typeof data.content.text === 'string') {
      turn.assistantText += data.content.text;
    }
  }
}

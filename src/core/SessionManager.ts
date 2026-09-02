import * as vscode from 'vscode';
import { EventEmitter } from 'node:events';

import type {
  NewSessionResponse,
  PromptResponse,
  InitializeResponse,
  ContentBlock,
  SessionModeState,
  AvailableCommand,
  SessionConfigOption,
  SessionInfo as ProtocolSessionInfo,
  AgentCapabilities,
} from '@agentclientprotocol/sdk';

/**
 * Local type for the legacy `models` field on session responses.
 * The ACP SDK 1.x removed `SessionModelState` — model selection is now
 * handled exclusively via `configOptions` with category `"model"`.
 * We keep this for backward compatibility with agents that still send
 * `models` in their responses.
 */
/** Thrown when an in-flight `session/load` replay is aborted (e.g. agent switch). */
export class SessionLoadCancelledError extends Error {
  constructor() {
    super('Session load cancelled');
    this.name = 'SessionLoadCancelledError';
  }
}

interface SessionModelState {
  currentModelId: string;
  availableModels: Array<{ modelId: string; name?: string; description?: string }>;
}

import { RequestError } from '@agentclientprotocol/sdk';

import { AgentManager } from './AgentManager';
import { ConnectionManager, ConnectionInfo } from './ConnectionManager';
import { SessionUpdateHandler } from '../handlers/SessionUpdateHandler';
import { SessionHistoryStore } from './SessionHistoryStore';
import { getAgentConfig, getAgentConfigs, resolveAgentConfigKey } from '../config/AgentConfig';

// TEMP-DEBUG master switch for the Kiro-resume "Send button stuck" fix
// instrumentation (sendPrompt/sendSlashCommand IN-FLIGHT ADD/DELETE traces).
// Keep false in normal use; flip to true to re-enable when debugging resumes.
const DEBUG_LIVE = false;
import { resolveAgentDisplayName } from '../config/agentDisplayName';
import { log, logError } from '../utils/Logger';
import { sendEvent, sendError } from '../utils/TelemetryManager';

export interface SessionInfo {
  sessionId: string;
  agentId: string;
  agentName: string;
  agentDisplayName: string;
  cwd: string;
  createdAt: string;
  initResponse: InitializeResponse;
  modes: SessionModeState | null;
  models: SessionModelState | null;
  /**
   * Generic session config options (ACP "Session Config Options" — supersedes
   * `modes` / `models`). `null` means the agent did not provide this field.
   * Per spec, when both `configOptions` and `modes` are present, clients
   * should use `configOptions` exclusively.
   */
  configOptions: SessionConfigOption[] | null;
  availableCommands: AvailableCommand[];
  /** Latest title supplied via `session_info_update`, if any. */
  title?: string;
  /** Effort level from `_kiro.dev/metadata` (Kiro CLI). Used to synthesize
   *  a reasoning_effort configOption when the agent doesn't support
   *  session/set_config_option. */
  kiroEffort?: string;
  /** True when configOptions were synthesized from legacy data (not
   *  provided by the agent). Prevents setModel from routing to
   *  setConfigOption (which would cause infinite recursion). */
  synthesizedConfigOptions?: boolean;
}

/**
 * Discovery flags for an agent, derived from `initialize.agentCapabilities`.
 * Populated lazily when {@link SessionManager.ensureConnected} runs.
 */
export interface AgentCapabilitySummary {
  list: boolean;
  load: boolean;
  resume: boolean;
  close: boolean;
  delete: boolean;
  additionalDirectories: boolean;
  fork: boolean;
}

/**
 * A piece of editor-selection context to attach to the next prompt.
 * Re-exported from {@link ContextBlockBuilder} so callers can keep importing
 * it from `SessionManager`.
 */
export type { SelectionContext } from './ContextBlockBuilder';
import { buildSelectionBlock, type SelectionContext } from './ContextBlockBuilder';
import {
  isIncrementalCacheAgent,
  resolveMemoryInjectMode,
  resetMemoryInjectGates,
  shouldInjectSkillToolsForMode,
  shouldInjectSkillsForMode,
  shouldMarkProfileInjectedAfterRecall,
} from './MemoryCacheStability';
import type { SharedMemoryProvider } from './memory/SharedMemoryProvider';
import { readMemorySettings, resolveMemoryAgentId } from './memory/MemoryConfig';

function memoryBlockTextBytes(blocks: ContentBlock[]): number {
  let bytes = 0;
  for (const block of blocks) {
    if (block.type === 'text' && 'text' in block && typeof block.text === 'string') {
      bytes += block.text.length;
    } else if (block.type === 'resource' && 'resource' in block) {
      const text = (block as { resource?: { text?: string } }).resource?.text;
      if (typeof text === 'string') {
        bytes += text.length;
      }
    }
  }
  return bytes;
}

/**
 * Why an agent expansion failed (used to surface a useful tree placeholder).
 */
export type AgentConnectionError = { kind: 'auth-cancelled' } | { kind: 'connect-failed'; message: string };

/**
 * Manages the lifecycle of ACP agent connections.
 *
 * The "session" concept is hidden from the user — they just see agents.
 * Internally we still use ACP sessions for protocol compliance, but the
 * user-facing model is: pick an agent → chat.
 */
export interface SessionManagerEvents {
  'active-session-changed': [sessionId: string | null];
  'clear-chat': [];
  'mode-changed': [sessionId: string, modeId: string];
  'model-changed': [sessionId: string, modelId: string];
  'config-options-changed': [sessionId: string, options: SessionConfigOption[] | null];
  'available-commands-changed': [sessionId: string, commands: AvailableCommand[]];
  'session-info-changed': [sessionId: string, update: any];
  'session-load-start': [sessionId: string, agentName: string];
  'session-load-end': [sessionId: string, agentName: string, ok: boolean];
  'agent-connected': [agentName: string];
  'agent-disconnected': [agentName: string];
  'agent-closed': [agentId: string, code: number | null];
  'agent-error': [agentId: string, error: any];
  'kiro-metadata': [params: any];
  'kiro-subagent-list-update': [params: any];
  'kiro-commands-available': [params: any];
  'kiro-compaction-status': [params: any];
  'kiro-clear-status': [params: any];
  'kiro-goal-status': [params: { sessionId: string; goalSnapshot: any }];
  'session-terminate': [params: any];
  'cursor-task': [params: any];
  'cursor-update-todos': [params: any];
  'cursor-generate-image': [params: any];
  'cursor-ask-question': [params: any, respond: (result: any) => void];
  'cursor-create-plan': [params: any, respond: (result: any) => void];
}

/**
 * Strip the <available_skills>…</available_skills> section from a memory blob.
 * Used by recallMemoryForAgent so a fork does NOT carry the source agent's
 * skill names into the target — the target can only recall its own skills.
 * Handles both the fresh-recall blob and the cached (last-injected) blob.
 */
function stripSkillsSection(text: string): string {
  if (!text || !text.includes('<available_skills>')) {
    return text;
  }
  return text
    .replace(/<available_skills>[\s\S]*?<\/available_skills>\n?/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Replace the agent_id in <memory_skill_tools> curl recipes so a forked
 * session's target agent can immediately use the memory API without
 * waiting for its own first full-injection turn.
 */
function remapSkillToolsForAgent(text: string, agentName: string): string {
  if (!text || !text.includes('<memory_skill_tools>')) {
    return text;
  }
  const memoryAgentId = resolveMemoryAgentId(agentName, readMemorySettings().agentIdMap);
  // Replace agent_id values in the curl -d JSON payloads.
  return text.replace(
    /(<memory_skill_tools>[\s\S]*?)"agent_id":"[^"]*"/g,
    (match, prefix) => prefix + `"agent_id":"${memoryAgentId}"`,
  );
}

export class SessionManager extends EventEmitter {
  on<K extends keyof SessionManagerEvents>(event: K, listener: (...args: SessionManagerEvents[K]) => void): this {
    return super.on(event, listener as any);
  }
  emit<K extends keyof SessionManagerEvents>(event: K, ...args: SessionManagerEvents[K]): boolean {
    return super.emit(event, ...args);
  }

  private sessions: Map<string, SessionInfo> = new Map();
  private activeSessionId: string | null = null;

  /** Maps agentName → activeSessionId for the one-session-per-agent model. */
  private agentSessions: Map<string, string> = new Map();

  /**
   * Buffers session/update payloads that arrive before the corresponding
   * session is registered in `this.sessions`. Drained by createAcpSession
   * once the session is set up. This closes a microtask race between the
   * resolution of `newSession` and the SDK's async notification dispatch.
   */
  private pendingAvailableCommands: Map<string, AvailableCommand[]> = new Map();
  private pendingConfigOptions: Map<string, SessionConfigOption[]> = new Map();
  private pendingTitles: Map<string, string> = new Map();

  /**
   * Cache of `initialize.agentCapabilities` per agent so the tree can render
   * without paying the connect cost on every render.
   */
  private capabilities: Map<string, AgentCapabilitySummary> = new Map();

  /** Set of session IDs that are currently being replayed via `session/load`. */
  private loadingSessionIds: Set<string> = new Set();

  /** Session loads aborted via {@link cancelInFlightSessionLoads}. */
  private cancelledSessionLoads: Set<string> = new Set();

  /** Coalesce duplicate loadSession calls for the same agent + session. */
  private loadSessionPromises: Map<string, Promise<SessionInfo>> = new Map();

  /** Set of session IDs with an in-flight `session/prompt` request. */
  private inFlightPromptSessions: Set<string> = new Set();

  /**
   * Last memory/skills block TEXT injected per session (persona + scenes +
   * available_skills), keyed by sessionId. Populated in sendPrompt after a
   * successful memory recall. Used by forkToAgent to carry the SOURCE agent's
   * injected memory/skills into the forked target session as conversation
   * context — the target then uses its OWN memory/skills on subsequent turns.
   */
  private sessionMemoryBlocks: Map<string, string> = new Map();

  /** The memory/skills block text last injected into the given session ('' if none). */
  getSessionMemoryBlocks(sessionId: string): string {
    return this.sessionMemoryBlocks.get(sessionId) || '';
  }

  /**
   * Recall the memory/skills block text for an agent at fork time. Used by
   * forkToAgent to carry the SOURCE agent's injected memory/skills into the
   * target session. Falls back to a fresh recall (via the memory provider)
   * when the in-memory per-session cache is empty — e.g. after a VS Code
   * reload, where the cache is not persisted across sessions.
   */
  async recallMemoryForAgent(agentName: string, query: string, sourceSessionId?: string): Promise<string> {
    // 1. Prefer the in-memory cache (last injected for this session).
    // At fork time the active session has already switched to the TARGET
    // agent, so we must look up the SOURCE session's cache (the caller
    // passes the source sessionId captured before connectToAgent).
    const cacheKey = sourceSessionId || this.getActiveSession()?.sessionId || '';
    const cached = this.getSessionMemoryBlocks(cacheKey);
    if (cached) {
      return remapSkillToolsForAgent(stripSkillsSection(cached), agentName);
    }
    // 2. Fresh recall of the agent's own profile (persona + scenes).
    // includeSkills=false: the SOURCE agent's skills must NOT be carried into
    // the fork — the target agent can only recall its OWN skills, so carrying
    // the source's skill names would mislead it (it would see skills it cannot
    // invoke). Persona + scenes (the context) are kept.
    if (!this.memoryProvider?.isEnabled()) {
      return '';
    }
    try {
      const blocks = await this.memoryProvider.buildRecallBlocks({
        sessionId: cacheKey,
        agentName,
        query,
        supportsEmbedded: true,
        includeSkills: false,
        includeSkillTools: true,
        injectMode: 'full',
      });
      let joined = (blocks || [])
        .map((b) => {
          const t =
            b.type === 'resource' && (b as { resource?: { text?: string } }).resource?.text
              ? (b as { resource: { text: string } }).resource.text
              : b.type === 'text' && 'text' in b
                ? String((b as { text: string }).text)
                : '';
          return t;
        })
        .filter(Boolean)
        .join('\n\n');
      joined = stripSkillsSection(joined);
      return joined;
    } catch (e) {
      logError('recallMemoryForAgent failed', e);
      return '';
    }
  }

  /**
   * Per-agent load/resume serialization chain.
   *
   * Kiro (and other agents) enforce a single active session per process and
   * stream the replay synchronously right after the session/load request. If
   * two loadSession / resumeSession calls for the same agent overlap (e.g. the
   * user clicks a session while a previous load is still streaming, or the
   * session tree fires several openSession events in quick succession), the
   * later call's `activeSessionId` assignment races with the earlier call's
   * replay — the extension's `handleSessionUpdate` active-session gate then
   * drops the earlier replay's user_message_chunk / agent_* chunks because
   * `update.sessionId !== activeId` at the instant they arrive, and the chat
   * ends up with tool_calls + thoughts but NO user or assistant bubbles.
   *
   * Serializing per agent guarantees each load's replay completes (and its
   * activeSessionId window stays stable) before the next load starts.
   */
  private loadSerialChains: Map<string, Promise<unknown>> = new Map();

  /**
   * Set of session IDs that have already received at least one
   * `session/prompt` in their lifetime. Used to gate memory re-injection for
   * agents on the OpenAI Responses-API incremental path (codex-acp) — see
   * `sendPrompt` and the `firstTurnOfIncrementalSession` comment.
   */
  private promptedSessions: Set<string> = new Set();
  /** Sessions that already got L3 persona + L2 scene nav on a real prompt. */
  private memoryProfileInjectedSessions: Set<string> = new Set();

  /**
   * Returns true if the given session has an in-flight `session/prompt`
   * request (the agent is actively processing a turn). Used by the webview
   * to restore the Stop-button state after a webview dispose/recreate cycle
   * (e.g. switching to Copilot Chat and back).
   */
  isPromptInFlight(sessionId: string): boolean {
    return this.inFlightPromptSessions.has(sessionId);
  }

  /** Client-side session history (optional — only used for tier-2 tree). */
  private historyStore: SessionHistoryStore | null = null;

  /** Optional TencentDB Agent Memory provider (Model B shared team memory). */
  private memoryProvider: SharedMemoryProvider | null = null;

  constructor(
    private readonly agentManager: AgentManager,
    private readonly connectionManager: ConnectionManager,
    private readonly sessionUpdateHandler: SessionUpdateHandler,
  ) {
    super();
  }

  /** Wire in the persistent session-history store (called once at startup). */
  setHistoryStore(store: SessionHistoryStore): void {
    this.historyStore = store;
  }

  /** Wire in shared memory (called once at startup when configured). */
  setMemoryProvider(provider: SharedMemoryProvider): void {
    this.memoryProvider = provider;
  }

  /**
   * Notify that the agent-side conversation context was compacted for the
   * given session (manual `/compact` or engine auto-compaction).
   *
   * Compaction replaces the conversation with an LLM summary, so the
   * previously injected memory/profile block (L3 persona, L2 scenes, and the
   * `<available_skills>` block) is summarized away or truncated — the cached
   * prefix no longer contains it. The KV-cache-stability gate in `sendPrompt`
   * would otherwise keep returning `l1-only` because the sessionId is still
   * present in {@link memoryProfileInjectedSessions}, and the next turn would
   * never re-inject the profile/skills until a brand-new session.
   *
   * Clearing both gates on compaction makes the next real (non-slash) prompt
   * take the `full` path again: persona + scenes + `<available_skills>` are
   * re-fetched from the gateway and injected.
   *
   * Safe to call more than once and for unknown sessions (no-op).
   */
  onContextCompacted(sessionId: string): void {
    resetMemoryInjectGates(sessionId, {
      promptedSessions: this.promptedSessions,
      memoryProfileInjectedSessions: this.memoryProfileInjectedSessions,
    });
    this.memoryProvider?.resetL1Dedup(sessionId);
    // Force the gateway to archive the session's skill-extraction buffer so
    // the summarized conversation can still become a recallable skill. Without
    // this, a session that never crossed the ≥10 tool_call / ≥40KB threshold
    // would only ever produce L0/L1 memory, never a skill. Best-effort: the
    // provider swallows failures internally; the .catch is defense-in-depth.
    const agentName = this.sessions.get(sessionId)?.agentName ?? '';
    if (agentName) {
      void this.memoryProvider
        ?.flushSkillBuffer(sessionId, agentName, 'compaction')
        .catch((e) => logError('flushSkillBuffer on compaction failed', e));
    }
  }

  /** Public accessor for downstream UI. */
  getHistoryStore(): SessionHistoryStore | null {
    return this.historyStore;
  }

  /**
   * Read cached capabilities for an agent. Returns `undefined` if the agent
   * has never been initialized — callers can call {@link ensureConnected}
   * first to populate.
   */
  getCachedCapabilities(agentName: string): AgentCapabilitySummary | undefined {
    return this.capabilities.get(agentName);
  }

  private getWorkspaceCwd(): string {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return cwd || process.cwd();
  }

  private summarizeCapabilities(caps: AgentCapabilities | undefined | null): AgentCapabilitySummary {
    const sc: any = (caps as any)?.sessionCapabilities;
    return {
      list: !!sc?.list,
      load: !!(caps as any)?.loadSession,
      resume: !!sc?.resume,
      close: !!sc?.close,
      delete: !!sc?.delete,
      additionalDirectories: !!sc?.additionalDirectories,
      fork: !!sc?.fork,
    };
  }

  /**
   * Connect to an agent and start chatting.
   * Only one agent can be connected at a time — automatically disconnects
   * any previously connected agent.
   * Internally creates a session via ACP protocol.
   */
  async connectToAgent(agentName: string): Promise<SessionInfo> {
    const resolvedAgentName = resolveAgentConfigKey(agentName);
    if (!resolvedAgentName) {
      const configs = getAgentConfigs();
      throw new Error(`Unknown agent: ${agentName}. Available: ${Object.keys(configs).join(', ')}`);
    }
    if (resolvedAgentName !== agentName) {
      log(`Resolved agent name "${agentName}" → "${resolvedAgentName}"`);
      agentName = resolvedAgentName;
    }

    // If we already have a live session with this agent, reuse it
    const existingSessionId = this.agentSessions.get(agentName);
    if (existingSessionId && this.sessions.has(existingSessionId)) {
      this.activeSessionId = existingSessionId;
      this.emit('active-session-changed', existingSessionId);
      return this.sessions.get(existingSessionId)!;
    }

    // Disconnect any currently connected agent first (single-agent model)
    const currentAgent = this.getActiveAgentName();
    if (currentAgent) {
      await this.disconnectAgent(currentAgent);
    }

    const config = getAgentConfig(agentName);
    if (!config) {
      const configs = getAgentConfigs();
      throw new Error(`Unknown agent: ${agentName}. Available: ${Object.keys(configs).join(', ')}`);
    }

    log(`SessionManager: connecting to agent "${agentName}"`);
    sendEvent('agent/connect.start', { agentName });
    const connectStartTime = Date.now();

    try {
      const workspaceCwd = this.getWorkspaceCwd();

      // Spawn the agent process in workspace cwd
      const agentInstance = this.agentManager.spawnAgent(agentName, config, workspaceCwd);
      const agentId = agentInstance.id;

      // Listen for agent errors/close
      this.agentManager.on('agent-error', (evt: { agentId: string; error: Error }) => {
        if (evt.agentId === agentId) {
          logError(`Agent ${agentName} error`, evt.error);
          this.emit('agent-error', agentId, evt.error);
        }
      });

      this.agentManager.on('agent-closed', (evt: { agentId: string; code: number | null }) => {
        if (evt.agentId === agentId) {
          log(`Agent ${agentName} closed with code ${evt.code}`);
          // Clean up the session for this agent
          const sessionId = this.agentSessions.get(agentName);
          if (sessionId) {
            this.sessions.delete(sessionId);
            this.agentSessions.delete(agentName);
            this.promptedSessions.delete(sessionId);
            this.memoryProfileInjectedSessions.delete(sessionId);
            this.memoryProvider?.resetL1Dedup(sessionId);
            if (this.activeSessionId === sessionId) {
              this.activeSessionId = null;
            }
            this.emit('agent-disconnected', agentName);
            this.emit('active-session-changed', null);
          }
          this.emit('agent-closed', agentId, evt.code);
        }
      });

      // Connect and initialize
      const agentProcess = this.agentManager.getAgent(agentId);
      if (!agentProcess) {
        throw new Error('Agent process not found after spawn');
      }

      let connInfo: ConnectionInfo;
      try {
        connInfo = await this.connectionManager.connect(agentId, agentProcess.process);
      } catch (e) {
        this.agentManager.killAgent(agentId);
        throw e;
      }

      // Wire up _kiro.dev/metadata handler (Kiro CLI sends context usage % and effort)
      this.wireKiroMetadataHandler(connInfo, agentName);

      // Cache capabilities from the initialize response so that
      // disconnectAgent can check session/close support, etc.
      this.capabilities.set(agentName, this.summarizeCapabilities(connInfo.initResponse.agentCapabilities));

      // Create ACP session (with auth handling). The session is already
      // registered in `this.sessions` by createAcpSession so that any
      // notifications arriving during/after newSession can be persisted.
      const sessionInfo = await this.createAcpSession(agentName, agentId, connInfo, workspaceCwd);

      this.agentSessions.set(agentName, sessionInfo.sessionId);
      this.activeSessionId = sessionInfo.sessionId;

      this.emit('agent-connected', agentName);
      this.emit('active-session-changed', sessionInfo.sessionId);

      log(`Connected to agent ${agentName}, session ${sessionInfo.sessionId}`);
      sendEvent('agent/connect.end', { agentName, result: 'success' }, { duration: Date.now() - connectStartTime });
      return sessionInfo;
    } catch (e: any) {
      sendError(
        'agent/connect.end',
        { agentName, result: 'error', errorMessage: e.message || String(e) },
        { duration: Date.now() - connectStartTime },
      );
      throw e;
    }
  }

  /**
   * Start a new conversation with the currently connected agent.
   * Disconnects current session, reconnects, and signals chat to clear.
   */
  async newConversation(): Promise<SessionInfo | null> {
    const activeSession = this.getActiveSession();
    if (!activeSession) {
      return null;
    }

    const agentName = activeSession.agentName;
    await this.disconnectAgent(agentName);
    this.emit('clear-chat');
    return this.connectToAgent(agentName);
  }

  /**
   * Disconnect from an agent: kill process and clean up.
   */
  async disconnectAgent(agentName: string): Promise<void> {
    const sessionId = this.agentSessions.get(agentName);
    if (!sessionId) {
      return;
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    log(`Disconnecting agent ${agentName}`);
    sendEvent('agent/disconnect', { agentName });

    for (const sid of [...this.loadingSessionIds]) {
      const loadingSession = this.sessions.get(sid);
      if (loadingSession?.agentName === agentName) {
        this.cancelSessionLoad(sid);
      }
    }

    const connInfo = this.connectionManager.getConnection(session.agentId);

    // If a prompt turn is in flight, send session/cancel first so the
    // agent can abort gracefully. session/close implies cancellation per
    // the spec, but sending the notification explicitly is more robust
    // for agents that may not implement the implicit cancel.
    // Also cancel any other in-flight prompts on the same agent connection
    // (e.g. a previous session whose prompt never completed before a
    // session switch). Without this, those dangling sendPrompt promises
    // reject with "ACP connection closed" when the agent process is killed.
    if (connInfo) {
      const sessionsToCancel = [sessionId, ...Array.from(this.inFlightPromptSessions).filter((id) => id !== sessionId)];
      for (const sid of sessionsToCancel) {
        if (this.inFlightPromptSessions.has(sid)) {
          try {
            log(`disconnectAgent: cancelling in-flight prompt for ${sid}`);
            await connInfo.connection.cancel({ sessionId: sid });
          } catch (e: any) {
            log(`disconnectAgent: session/cancel error for ${sid} (non-fatal): ${e?.message || e}`);
          }
          this.inFlightPromptSessions.delete(sid);
        }
      }
    }

    // If the agent supports session/close, notify it so it can free
    // server-side resources (cancel ongoing work, release MCP servers, etc.).
    const caps = this.capabilities.get(agentName);
    if (caps?.close && connInfo) {
      try {
        await connInfo.connection.closeSession?.({ sessionId });
        log(`closeSession: agent acknowledged close for ${sessionId}`);
      } catch (e: any) {
        log(`closeSession: agent returned error (non-fatal): ${e?.message || e}`);
      }
    }

    this.inFlightPromptSessions.delete(sessionId);
    this.agentManager.killAgent(session.agentId);
    this.connectionManager.removeConnection(session.agentId);
    this.sessions.delete(sessionId);
    this.agentSessions.delete(agentName);
    this.promptedSessions.delete(sessionId);
    this.memoryProfileInjectedSessions.delete(sessionId);
    this.memoryProvider?.resetL1Dedup(sessionId);

    if (this.activeSessionId === sessionId) {
      this.activeSessionId = null;
    }

    this.emit('agent-disconnected', agentName);
    this.emit('active-session-changed', null);
  }

  /**
   * Clear the active session without killing the agent process.
   * Used when the active session has been deleted — the agent is still
   * connected for new sessions, but the current session is gone.
   */
  async clearActiveSession(): Promise<void> {
    const sessionId = this.activeSessionId;
    if (!sessionId) {
      return;
    }
    const session = this.sessions.get(sessionId);
    const agentName = session?.agentName;

    // Close the session on the agent side if supported (non-fatal on error).
    if (session) {
      const connInfo = this.connectionManager.getConnection(session.agentId);
      const caps = agentName ? this.capabilities.get(agentName) : undefined;
      if (caps?.close && connInfo) {
        try {
          await connInfo.connection.closeSession?.({ sessionId });
        } catch (e: any) {
          log(`clearActiveSession: close error (non-fatal): ${e?.message || e}`);
        }
      }
    }

    // Clean up local session state but keep the agent connection alive.
    this.inFlightPromptSessions.delete(sessionId);
    if (sessionId) {
      this.sessions.delete(sessionId);
      this.promptedSessions.delete(sessionId);
      this.memoryProfileInjectedSessions.delete(sessionId);
      this.memoryProvider?.resetL1Dedup(sessionId);
      if (agentName) {
        this.agentSessions.delete(agentName);
      }
    }
    this.activeSessionId = null;
    this.emit('active-session-changed', null);
  }

  /**
   * Internal: create the ACP session with auth handling.
   */
  private async createAcpSession(
    agentName: string,
    agentId: string,
    connInfo: ConnectionInfo,
    cwd: string,
  ): Promise<SessionInfo> {
    let sessionResponse: NewSessionResponse;
    try {
      sessionResponse = await connInfo.connection.newSession({
        cwd,
        mcpServers: [],
      });
    } catch (e: any) {
      if (!this.isAuthRequiredError(e)) {
        logError('Failed to create session', e);
        this.agentManager.killAgent(agentId);
        throw e;
      }
      // Auth required — interactively authenticate, then retry.
      await this.runAuthFlow(agentName, agentId, connInfo);
      try {
        sessionResponse = await connInfo.connection.newSession({
          cwd,
          mcpServers: [],
        });
      } catch (retryErr) {
        logError('Failed to create session after authentication', retryErr);
        this.agentManager.killAgent(agentId);
        throw retryErr;
      }
    }

    const sessionInfo: SessionInfo = {
      sessionId: sessionResponse.sessionId,
      agentId,
      agentName,
      agentDisplayName: this.displayNameFor(agentName, connInfo.initResponse),
      cwd,
      createdAt: new Date().toISOString(),
      initResponse: connInfo.initResponse,
      modes: sessionResponse.modes ?? null,
      models: (sessionResponse as any).models ?? null,
      configOptions: (sessionResponse as any).configOptions ?? null,
      availableCommands: [],
    };

    // Register the session into the map *synchronously* with newSession's
    // resolution so that any session/update notifications dispatched by the
    // agent (e.g. available_commands_update) can be persisted onto it. If
    // we waited until connectToAgent's continuation, notifications would
    // race and be dropped by handleSessionUpdate.
    this.sessions.set(sessionInfo.sessionId, sessionInfo);
    this.drainPending(sessionInfo);

    // Capture in the local history store so it appears in the tree.
    this.historyStore?.upsertNew(agentName, cwd, sessionInfo.sessionId);

    // If the agent didn't return configOptions (e.g. Kiro CLI only sends
    // legacy modes/models), probe by sending a no-op set_config_option with
    // the current model. Many agents respond with the full configOptions
    // array, which includes thought_level / reasoning_effort pickers.
    if (!sessionInfo.configOptions || sessionInfo.configOptions.length === 0) {
      void this.probeOrSynthesizeConfigOptions(sessionInfo.sessionId);
    }

    return sessionInfo;
  }

  /** Returns true if a thrown error denotes ACP "auth required" (-32000). */
  private isAuthRequiredError(e: any): boolean {
    return (
      (e instanceof RequestError && e.code === -32000) ||
      e?.code === -32000 ||
      (typeof e?.message === 'string' && /auth.?required/i.test(e.message))
    );
  }

  /**
   * Run the interactive auth flow against an already-initialized connection.
   * Throws if the user cancels or auth fails — caller is expected to clean
   * up the agent process.
   */
  private async runAuthFlow(agentName: string, agentId: string, connInfo: ConnectionInfo): Promise<void> {
    const authMethods = connInfo.initResponse.authMethods;
    if (!authMethods || authMethods.length === 0) {
      this.agentManager.killAgent(agentId);
      throw new Error(`Agent "${agentName}" requires authentication but did not advertise any auth methods.`);
    }

    log(`Agent requires authentication. Methods: ${authMethods.map((m) => m.name).join(', ')}`);

    let selectedMethod = authMethods[0];
    if (authMethods.length > 1) {
      const picked = await vscode.window.showQuickPick(
        authMethods.map((m) => ({
          label: m.name,
          description: m.description || '',
          detail: `ID: ${m.id}`,
          method: m,
        })),
        {
          placeHolder: 'Select an authentication method',
          title: `${agentName} requires authentication`,
        },
      );
      if (!picked) {
        this.agentManager.killAgent(agentId);
        throw new Error('Authentication cancelled by user.');
      }
      selectedMethod = picked.method;
    } else {
      const confirm = await vscode.window.showInformationMessage(
        `${agentName} requires authentication via "${selectedMethod.name}".`,
        { modal: true, detail: selectedMethod.description || undefined },
        'Authenticate',
      );
      if (confirm !== 'Authenticate') {
        this.agentManager.killAgent(agentId);
        throw new Error('Authentication cancelled by user.');
      }
    }

    try {
      log(`Authenticating with method: ${selectedMethod.name} (${selectedMethod.id})`);
      await connInfo.connection.authenticate({ methodId: selectedMethod.id });
      log('Authentication successful');
    } catch (authErr: any) {
      logError('Authentication failed', authErr);
      this.agentManager.killAgent(agentId);
      throw new Error(`Authentication failed: ${authErr.message}`);
    }
  }

  /**
   * Drain any buffered state captured before the session was registered.
   * Used by all session-registration paths (new / load / resume).
   */
  private drainPending(sessionInfo: SessionInfo): void {
    const pendingCmds = this.pendingAvailableCommands.get(sessionInfo.sessionId);
    if (pendingCmds) {
      sessionInfo.availableCommands = pendingCmds;
      this.pendingAvailableCommands.delete(sessionInfo.sessionId);
      // Emit so the webview picks up the commands that arrived before the
      // session was registered. Without this, commands sent during session/new
      // (before the response registers the session) are stored on the session
      // but never pushed to the slash-command popup until the next
      // available_commands_update or a full sendCurrentState — so the popup
      // shows only the client-side builtins until the first LLM response.
      this.emit('available-commands-changed', sessionInfo.sessionId, pendingCmds);
    }
    const pendingCfg = this.pendingConfigOptions.get(sessionInfo.sessionId);
    if (pendingCfg !== undefined) {
      sessionInfo.configOptions = pendingCfg;
      this.pendingConfigOptions.delete(sessionInfo.sessionId);
    }
    const pendingTitle = this.pendingTitles.get(sessionInfo.sessionId);
    if (pendingTitle !== undefined) {
      this.pendingTitles.delete(sessionInfo.sessionId);
      // Don't let a buffered agent title overwrite a user-set /rename title.
      const histEntry = this.historyStore?.get(sessionInfo.agentName, sessionInfo.sessionId);
      if (!histEntry?.userRenamed) {
        sessionInfo.title = pendingTitle;
      }
    }
  }

  /**
   * Returns the `promptCapabilities` advertised by the agent for the given
   * session, or `undefined` if unknown.
   */
  getPromptCapabilities(
    sessionId: string,
  ): { embeddedContext?: boolean; image?: boolean; audio?: boolean } | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return undefined;
    }
    const caps = (session.initResponse as any)?.agentCapabilities?.promptCapabilities;
    return caps && typeof caps === 'object' ? caps : undefined;
  }

  /**
   * Send a prompt to the active session.
   *
   * `selections` follows Zed's ACP client convention (`zed-industries/zed`):
   * each entry becomes a leading `resource` (EmbeddedResource) block when the
   * agent supports `promptCapabilities.embeddedContext`, else a `resource_link`
   * block. The URI is `<buffer-uri>#L<startLine>:<endLine>` (1-based,
   * inclusive), matching `MentionUri::Selection::to_uri()` in the Zed source.
   *
   * `contextBlocks` lets the caller prepend already-built ACP blocks (used by
   * the chat webview for file / directory / terminal / diagnostics mentions
   * that have richer URIs than a bare selection). They are inserted before
   * selections so the agent sees broader context first.
   */
  async sendPrompt(
    sessionId: string,
    text: string,
    images?: Array<{ data: string; mimeType: string }>,
    resources?: Array<{ uri: string; text: string; mimeType?: string }>,
    selections?: SelectionContext[],
    contextBlocks?: ContentBlock[],
  ): Promise<PromptResponse> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const connInfo = this.connectionManager.getConnection(session.agentId);
    if (!connInfo) {
      throw new Error(`No connection for agent: ${session.agentId}`);
    }

    log(
      `sendPrompt: session=${sessionId}, text="${text.substring(0, 50)}...", images=${images?.length || 0}, resources=${resources?.length || 0}, selections=${selections?.length || 0}, contextBlocks=${contextBlocks?.length || 0}`,
    );

    const supportsEmbeddedContext = !!this.getPromptCapabilities(sessionId)?.embeddedContext;
    const isSlashCommand = text.startsWith('/');

    const prompt: ContentBlock[] = [];

    // Shared memory: first real prompt prepends L3 persona + L2 scenes + L1.
    // Later turns append L1 only (query-related). Codex included: L1 is new
    // incremental input items (pure append), so previous_response_id prefix
    // is unchanged. Slash commands (e.g. /compact) are intercepted by the
    // agent adapter (pi-acp, codex-acp) based on the message starting with
    // '/'. Memory blocks must come AFTER the user text for slash commands so
    // the adapter's startsWith('/') check still matches. For non-slash
    // commands, memory is prepended (full mode) or appended (l1-only).
    const profileAlreadyInjected = this.memoryProfileInjectedSessions.has(sessionId);
    const memoryInjectMode = !this.memoryProvider?.isEnabled()
      ? 'none'
      : resolveMemoryInjectMode(session.agentName, {
          sessionAlreadyPrompted: this.promptedSessions.has(sessionId),
          profileAlreadyInjected,
          // A slash command is intercepted by the agent, not answered by the
          // model — injecting memory there only risks defeating the agent's
          // command match (see resolveMemoryInjectMode).
          isSlashCommand,
        });
    const memDebug = this.memoryProvider?.isEnabled() && this.memoryProvider.isDebug();
    const sendT0 = memDebug ? performance.now() : 0;
    if (memDebug) {
      log(`Memory inject: recall dispatch @+${(performance.now() - sendT0).toFixed(1)}ms (session=${sessionId})`);
    }
    let pendingL1Blocks: ContentBlock[] = [];
    if (memoryInjectMode !== 'none' && this.memoryProvider) {
      try {
        const memoryBlocks = await this.memoryProvider.buildRecallBlocks({
          sessionId,
          agentName: session.agentName,
          query: text,
          supportsEmbedded: supportsEmbeddedContext,
          includeSkillTools: shouldInjectSkillToolsForMode(memoryInjectMode),
          injectMode: memoryInjectMode,
          ...(memoryInjectMode === 'l1-only'
            ? {
                includePersona: false,
                includeSceneNav: false,
                includeSkills: shouldInjectSkillsForMode(memoryInjectMode),
              }
            : {}),
        });
        if (memDebug) {
          log(
            `Memory inject: recall resolved @+${(performance.now() - sendT0).toFixed(1)}ms ` +
              `(blocks=${memoryBlocks.length}, mode=${memoryInjectMode}, session=${sessionId})`,
          );
        }
        if (memoryBlocks.length > 0) {
          // For slash commands, append memory after the user text so the
          // adapter's startsWith('/') interception still matches. Non-slash
          // commands keep the existing behavior (prepend for full, append
          // for l1-only).
          if (memoryInjectMode === 'full' && !isSlashCommand) {
            prompt.push(...memoryBlocks);
            if (
              shouldMarkProfileInjectedAfterRecall({
                memoryInjectMode,
                memoryBlocksCount: memoryBlocks.length,
              })
            ) {
              this.memoryProfileInjectedSessions.add(sessionId);
            }
          } else {
            pendingL1Blocks = memoryBlocks;
            if (memoryInjectMode === 'full') {
              if (
                shouldMarkProfileInjectedAfterRecall({
                  memoryInjectMode,
                  memoryBlocksCount: memoryBlocks.length,
                })
              ) {
                this.memoryProfileInjectedSessions.add(sessionId);
              }
            }
          }
        }
        const memorySettings = readMemorySettings();
        const memoryAgentId = resolveMemoryAgentId(session.agentName, memorySettings.agentIdMap);
        const blobBytes = memoryBlockTextBytes(memoryBlocks);
        const blockKind = memoryBlocks.length > 0 ? memoryBlocks[0].type : 'none';
        log(
          memoryBlocks.length > 0
            ? `Memory inject: ${memoryBlocks.length} block(s), ${blobBytes} bytes, kind=${blockKind} ` +
                `mode=${memoryInjectMode} (agent=${session.agentName}→${memoryAgentId}, session=${sessionId})`
            : `Memory inject: none mode=${memoryInjectMode} (agent=${session.agentName}→${memoryAgentId}, session=${sessionId})`,
        );
        // Remember the injected memory/skills text per session so a fork to
        // another agent can carry the SOURCE agent's context into the target
        // session. The target then uses its own memory/skills on later turns.
        if (memoryBlocks.length > 0) {
          const joined = memoryBlocks
            .map((b) => {
              const t =
                b.type === 'resource' && (b as { resource?: { text?: string } }).resource?.text
                  ? (b as { resource: { text: string } }).resource.text
                  : b.type === 'text' && 'text' in b
                    ? String((b as { text: string }).text)
                    : '';
              return t;
            })
            .filter(Boolean)
            .join('\n\n');
          if (joined) {
            this.sessionMemoryBlocks.set(sessionId, joined);
          }
        }
        // ── Fork-debug instrumentation ──────────────────────────────────
        // When a conversation is forked to another agent, the target agent's
        // OWN memory/skills are injected (agentName is the TARGET). This log
        // captures exactly what the forked session inherits so we can verify
        // the source agent's skills/persona are NOT carried over. The fork
        // prompt is identifiable by its "conversation from another agent"
        // prefix (the body is a summary now, so accept both wordings).
        if (/^The following is a (?:summary of a )?conversation from another agent/i.test(text)) {
          const forkSkills: string[] = [];
          for (const mb of memoryBlocks) {
            const mbText =
              mb.type === 'resource' && (mb as { resource?: { text?: string } }).resource?.text
                ? (mb as { resource: { text: string } }).resource.text
                : mb.type === 'text' && 'text' in mb
                  ? String((mb as { text: string }).text)
                  : '';
            // Extract skill names from the <available_skills> block:
            //   - **skill-name** (v1): description
            const re = /\*\*([^*]+)\*\*\s*\(v\d+\)/g;
            let m;
            while ((m = re.exec(mbText)) !== null) {
              forkSkills.push(m[1].trim());
            }
          }
          const skillList = forkSkills.length > 0 ? forkSkills.join(', ') : '(none in injected block)';
          // Gate this verbose fork diagnostic behind acp.debug (master debug switch)
          // so it only appears when explicitly enabled, not on every fork.
          if (vscode.workspace.getConfiguration('acp').get<boolean>('debug', false)) {
            log(
              `[FORK-DEBUG] forked prompt → target agent=${session.agentName} (memoryAgentId=${memoryAgentId}) ` +
                `mode=${memoryInjectMode} blocks=${memoryBlocks.length} bytes=${blobBytes} ` +
                `persona=${/user-persona/i.test(memoryBlocks.map((b) => (b as any)?.resource?.text || '').join(''))} ` +
                `skills=[${skillList}]`,
            );
          }
        }
      } catch (e) {
        logError('Memory recall failed', e);
      }
    }

    // Caller-built context blocks (file/directory/terminal/diagnostics
    // mentions) come first so the agent sees the broader workspace context
    // before any specific selection.
    if (contextBlocks && contextBlocks.length > 0) {
      prompt.push(...contextBlocks);
    }

    // Build selection blocks first so the agent sees the referenced code
    // before the user prose (matches Zed, which interleaves resources with
    // the message text but always within the same prompt).
    if (selections && selections.length > 0) {
      for (const sel of selections) {
        if (!sel.text) {
          continue;
        }
        prompt.push(buildSelectionBlock(sel, supportsEmbeddedContext));
      }
    }

    if (images && images.length > 0) {
      for (const img of images) {
        prompt.push({ type: 'image', data: img.data, mimeType: img.mimeType });
      }
    }
    if (resources && resources.length > 0) {
      for (const res of resources) {
        prompt.push({
          type: 'resource',
          resource: { uri: res.uri, text: res.text, mimeType: res.mimeType || 'text/plain' },
        } as any);
      }
    }
    prompt.push({ type: 'text', text });
    if (pendingL1Blocks.length > 0) {
      prompt.push(...pendingL1Blocks);
    }

    this.inFlightPromptSessions.add(sessionId);
    if (DEBUG_LIVE) {
      log(
        `sendPrompt: IN-FLIGHT ADD session=${sessionId} slash=${isSlashCommand} text="${text.substring(0, 40)}" t+${(performance.now() - sendT0).toFixed(1)}ms`,
      );
    }
    this.promptedSessions.add(sessionId);
    if (!isSlashCommand && this.memoryProvider?.isEnabled()) {
      this.memoryProvider.beginTurn(sessionId, session.agentName, text);
    }
    if (memDebug) {
      log(
        `Memory inject: prompt array built (blocks=${prompt.length}), sending session/prompt @+${(performance.now() - sendT0).toFixed(1)}ms ` +
          `(session=${sessionId})`,
      );
    }
    try {
      const response = await connInfo.connection.prompt({
        sessionId,
        prompt,
      });

      if (memDebug) {
        log(
          `Memory inject: session/prompt response received @+${(performance.now() - sendT0).toFixed(1)}ms ` +
            `(stopReason=${response.stopReason}, session=${sessionId})`,
        );
      }
      log(`Prompt response: stopReason=${response.stopReason}`);
      return response;
    } finally {
      this.inFlightPromptSessions.delete(sessionId);
      if (DEBUG_LIVE) {
        log(`sendPrompt: IN-FLIGHT DELETE session=${sessionId} slash=${isSlashCommand}`);
      }
      if (!isSlashCommand && this.memoryProvider) {
        void this.memoryProvider.endTurn(sessionId).catch((e) => logError('Memory capture failed', e));
      }
    }
  }

  /**
   * Cancel an active prompt turn.
   */
  async cancelTurn(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    const connInfo = this.connectionManager.getConnection(session.agentId);
    if (!connInfo) {
      return;
    }

    log(`Cancelling turn for session ${sessionId}`);
    await connInfo.connection.cancel({ sessionId });
  }

  /**
   * Send a steering message to the agent mid-turn without cancelling.
   * Uses a custom `session/steer` notification that EricCLI's
   * ACP server handles by queuing the message and injecting it at the
   * next tool-execution iteration boundary. Codex-acp translates it to
   * a native turn/steer RPC call. Claude-code-acp queues it and drains
   * after the current turn finishes. For agents that don't support this
   * notification, it's silently ignored.
   */
  async steerPrompt(sessionId: string, text: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    const connInfo = this.connectionManager.getConnection(session.agentId);
    if (!connInfo) {
      return;
    }
    try {
      await connInfo.connection.notify('session/steer', { sessionId, text });
      log(`Steered session ${sessionId}: ${text.substring(0, 80)}...`);
    } catch (e: any) {
      log(`steerPrompt: agent does not support session/steer (non-fatal): ${e?.message || e}`);
    }
  }

  /**
   * Kill all running background processes spawned in this session.
   * Sends a custom `session/stop` notification that EricCLI and Codex-ACP
   * handle to terminate spawned processes without interrupting the active
   * turn. For agents that don't support this notification, it's silently
   * ignored.
   */
  async stopProcesses(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    const connInfo = this.connectionManager.getConnection(session.agentId);
    if (!connInfo) {
      return;
    }
    try {
      await connInfo.connection.notify('session/stop', { sessionId });
      log(`Stop processes for session ${sessionId}`);
    } catch (e: any) {
      log(`stopProcesses: agent does not support session/stop (non-fatal): ${e?.message || e}`);
    }
  }

  /**
   * Force-abort an in-flight prompt without waiting for the agent to
   * acknowledge.  This removes the session from the in-flight set so
   * the next sendPrompt() is not blocked.  Used by the cancel fallback
   * timer when the agent ignores session/cancel.
   */
  forceAbortPrompt(sessionId: string): void {
    if (this.inFlightPromptSessions.has(sessionId)) {
      log(`forceAbortPrompt: removing session ${sessionId} from in-flight set`);
      this.inFlightPromptSessions.delete(sessionId);
    }
  }

  /**
   * Force-kill the agent process for a session that ignored session/cancel.
   * Used by the cancel fallback when the agent didn't acknowledge within the
   * timeout — the agent is still running an in-flight LLM call (backpressure
   * retries, sidecar timeout, etc.) and won't stop on its own. Killing the
   * process ensures the user's Stop button actually stops everything, instead
   * of leaving the agent burning CPU/tokens in the background for 30+ seconds.
   * The agent will be respawned on the next sendPrompt().
   */
  forceKillAgentForSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    log(
      `forceKillAgentForSession: killing agent ${session.agentId} for session ${sessionId} (did not acknowledge cancel)`,
    );
    try {
      this.agentManager.killAgent(session.agentId);
    } catch (e) {
      logError(`forceKillAgentForSession: kill failed for ${session.agentId}`, e);
    }
  }

  /**
   * Set the session mode (e.g., plan mode, code mode).
   *
   * If the active session uses `configOptions`, this is transparently
   * routed to `setConfigOption` against the first option whose category is
   * `mode` — this keeps user keybindings working across agents that have
   * migrated to the new API.
   */
  async setMode(sessionId: string, modeId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    // Prefer configOptions if available (spec: clients that support
    // configOptions MUST use it exclusively when both are present)
    if (session.configOptions && session.configOptions.length > 0) {
      const modeOpt = session.configOptions.find((o) => o.category === 'mode');
      if (modeOpt) {
        await this.setConfigOption(sessionId, modeOpt.id, modeId);
        // Persist the mode so it can be restored on resume/load after restart.
        this.historyStore?.setModeId(session.agentName, sessionId, modeId);
        this.emit('mode-changed', sessionId, modeId);
        return;
      }
    }

    const connInfo = this.connectionManager.getConnection(session.agentId);
    if (!connInfo) {
      return;
    }

    await connInfo.connection.setSessionMode({ sessionId, modeId });

    // Update local state
    if (session.modes) {
      session.modes.currentModeId = modeId;
    }
    // Persist the mode so it can be restored on resume/load after restart.
    this.historyStore?.setModeId(session.agentName, sessionId, modeId);
    this.emit('mode-changed', sessionId, modeId);
  }

  /**
   * Set the session model (experimental).
   *
   * If the active session uses `configOptions`, this is transparently
   * routed to `setConfigOption` against the first option whose category is
   * `model`.
   */
  async setModel(sessionId: string, modelId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    // If configOptions are agent-provided (not synthesized), route through
    // setConfigOption. Synthesized configOptions are detected by checking
    // if the model option has id 'model' and the session has no
    // agent-confirmed configOptions (i.e. they were created by
    // synthesizeConfigOptions). In that case, skip to session/set_model.
    if (session.configOptions && session.configOptions.length > 0 && !session.synthesizedConfigOptions) {
      const modelOpt = session.configOptions.find((o: any) => o.category === 'model');
      if (modelOpt) {
        await this.setConfigOption(sessionId, modelOpt.id, modelId);
        return;
      }
    }

    // Try `session/set_config_option` first. If it fails, fall back to the
    // legacy `session/set_model` raw JSON-RPC request (Kiro CLI supports this).
    try {
      const connInfo = this.connectionManager.getConnection(session.agentId);
      if (connInfo) {
        try {
          const response = await connInfo.connection.setSessionConfigOption({
            sessionId,
            configId: 'model',
            value: modelId,
          });
          const options = (response as any)?.configOptions ?? null;
          if (options) {
            this.applyConfigOptions(sessionId, options);
          }
        } catch (e1: any) {
          // set_config_option not supported -- try legacy session/set_model
          log(`setModel: set_config_option failed, trying session/set_model: ${e1?.message ?? e1}`);
          await connInfo.connection.request('session/set_model', { sessionId, modelId });
          log(`setModel: session/set_model succeeded for session ${sessionId}`);
        }
      }
    } catch (e: any) {
      log(`setModel: both set_config_option and session/set_model failed for session ${sessionId}: ${e?.message ?? e}`);
    }

    // Update local model state so the picker reflects the change immediately.
    // The agent may not send a config_option_update push for legacy agents.
    if (session.models) {
      session.models.currentModelId = modelId;
    }
    // Also update synthesized configOptions if present
    if (session.configOptions) {
      const modelOpt = session.configOptions.find((o: any) => o.category === 'model');
      if (modelOpt) {
        modelOpt.currentValue = modelId;
        this.emit('config-options-changed', sessionId, session.configOptions);
      }
      // Show/hide effort picker based on whether the new model supports effort
      this.updateEffortPickerVisibility(session);
    }
    this.emit('model-changed', sessionId, modelId);
  }

  /**
   * Set a generic session config option (ACP "Session Config Options").
   * The agent's response contains the full configOptions array — we
   * replace our local copy so that cascading changes (e.g. changing the
   * model adjusts thought-level options) are reflected.
   *
   * If the agent doesn't support set_config_option (e.g. Kiro CLI), we
   * handle synthesized configOptions locally: model changes are routed
   * through session/set_model, and reasoning_effort changes are sent as
   * /effort slash commands.
   */
  async setConfigOption(sessionId: string, configId: string, value: string): Promise<SessionConfigOption[] | null> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    const connInfo = this.connectionManager.getConnection(session.agentId);
    if (!connInfo) {
      return null;
    }

    try {
      const response = await connInfo.connection.setSessionConfigOption({
        sessionId,
        configId,
        value,
      });
      const options = (response as any)?.configOptions ?? null;
      // Pi's response may have a stale currentValue for the option we just set
      // (get_state is called before the change is reflected). Fix it optimistically.
      if (Array.isArray(options)) {
        for (const opt of options) {
          if (opt && opt.id === configId) {
            opt.currentValue = value;
          }
        }
      }
      this.applyConfigOptions(sessionId, options);
      // Persist the config value so it can be restored on resume/load.
      this.persistConfigValue(session, configId, value);
      return options;
    } catch (e: any) {
      // Agent doesn't support set_config_option (e.g. Kiro CLI).
      // Handle synthesized configOptions locally.
      log(`setConfigOption: set_config_option failed for ${configId}: ${e?.message ?? e}`);
      if (configId === 'model') {
        // Try legacy session/set_model directly (don't call setModel to
        // avoid recursion — setModel routes back to setConfigOption when
        // configOptions are agent-provided).
        try {
          await connInfo.connection.request('session/set_model', { sessionId, modelId: value });
          log(`setConfigOption: session/set_model succeeded for session ${sessionId}`);
        } catch (e2: any) {
          log(`setConfigOption: session/set_model also failed: ${e2?.message ?? e2}`);
        }
        if (session.models) {
          session.models.currentModelId = value;
        }
        // Update the model configOption's currentValue BEFORE calling
        // updateEffortPickerVisibility, otherwise it reads the STALE model
        // value and keeps/creates the effort picker incorrectly (bug:
        // effort picker reappears after switching Claude -> minimax).
        if (session.configOptions) {
          const modelOpt = session.configOptions.find((o: any) => o.category === 'model');
          if (modelOpt) {
            modelOpt.currentValue = value;
          }
        }
        // Show/hide effort picker based on whether the new model supports effort
        this.updateEffortPickerVisibility(session);
        // Emit model-changed so the webview gets updated image support info
        this.emit('model-changed', sessionId, value);
      } else if (configId === 'reasoning_effort') {
        // Kiro doesn't have an RPC for effort; send /effort slash command
        // Skip if the current model doesn't support effort — avoids the
        // "Effort configuration is currently not available on <model>" message
        const modelOpt = session.configOptions?.find((o) => o.category === 'model');
        const currentModel = String(modelOpt?.currentValue || session.models?.currentModelId || '');
        if (!this.modelSupportsEffort(currentModel)) {
          log(`setConfigOption: skipping /effort for model ${currentModel} (not supported)`);
          return session.configOptions ?? null;
        }
        await this.sendSlashCommand(sessionId, `/effort ${value}`);
        session.kiroEffort = value;
      }
      // Update local configOptions state
      if (session.configOptions) {
        const opt = session.configOptions.find((o) => o.id === configId);
        if (opt) {
          opt.currentValue = value;
        }
        this.emit('config-options-changed', sessionId, session.configOptions);
      }
      // Persist even in the fallback path (Kiro etc.)
      this.persistConfigValue(session, configId, value);
      return session.configOptions;
    }
  }

  /**
   * Send a goal control action (pause/clear) to the agent via the
   * `_codex/session/goal_control` extension method.
   * Currently only supported by codex-acp. Other agents will throw silently.
   */
  async goalControl(sessionId: string, action: 'pause' | 'clear'): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      log(`goalControl: session ${sessionId} not found`);
      return;
    }
    const connInfo = this.connectionManager.getConnection(session.agentId);
    if (!connInfo) {
      log(`goalControl: no connection for agent ${session.agentId}`);
      return;
    }
    try {
      await connInfo.connection.request('_codex/session/goal_control', { sessionId, action });
      log(`goalControl: ${action} sent for session ${sessionId}`);
    } catch (e: any) {
      log(`goalControl: ${action} failed for session ${sessionId}: ${e?.message ?? e}`);
    }
  }

  /**
   * Persist a config-option value (mode/model/reasoning_effort) to the
   * history store so it can be restored on resume/load after restart.
   */
  private persistConfigValue(session: SessionInfo, configId: string, value: string): void {
    if (!this.historyStore) {
      return;
    }
    const agentName = session.agentName;
    const sessionId = session.sessionId;
    switch (configId) {
      case 'mode':
        this.historyStore.setModeId(agentName, sessionId, value);
        break;
      case 'model':
        this.historyStore.setModelId(agentName, sessionId, value);
        break;
      case 'reasoning_effort':
        this.historyStore.setReasoningEffort(agentName, sessionId, value);
        break;
      default:
        // Unknown config option — nothing to persist.
        break;
    }
  }

  /**
   * Restore saved config-option values (mode/model/reasoning_effort) from
   * the history store after a session load/resume. Each value is applied
   * via setConfigOption (which routes through the agent's set_config_option
   * RPC when available, or falls back to legacy methods).
   */
  private async restoreConfigOptions(sessionId: string, agentName: string): Promise<void> {
    const entry = this.historyStore?.get(agentName, sessionId);
    if (!entry) {
      return;
    }
    // Restore mode
    if (entry.modeId) {
      try {
        await this.setMode(sessionId, entry.modeId);
      } catch {
        /* non-fatal */
      }
    }
    // Restore model
    if (entry.modelId) {
      try {
        await this.setConfigOption(sessionId, 'model', entry.modelId);
      } catch {
        /* non-fatal */
      }
    }
    // Restore reasoning effort
    if (entry.reasoningEffort) {
      // Skip effort restore if the model doesn't support it
      if (entry.modelId && !this.modelSupportsEffort(entry.modelId)) {
        log(`restoreConfigOptions: skipping effort restore for model ${entry.modelId} (not supported)`);
      } else {
        try {
          await this.setConfigOption(sessionId, 'reasoning_effort', entry.reasoningEffort);
        } catch {
          /* non-fatal */
        }
      }
    }
  }

  /**
   * Send a slash command (e.g. `/effort high`, `/model claude-opus-4.8`) to
   * the agent as a prompt. Kiro CLI processes these server-side and typically
   * responds with a session/update notification rather than a full prompt
   * response. This is used as a fallback when the agent doesn't support
   * session/set_config_option.
   */
  async sendSlashCommand(sessionId: string, command: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    const connInfo = this.connectionManager.getConnection(session.agentId);
    if (!connInfo) {
      return;
    }
    log(`sendSlashCommand: session=${sessionId}, command="${command}"`);
    try {
      this.inFlightPromptSessions.add(sessionId);
      if (DEBUG_LIVE) {
        log(`sendSlashCommand: IN-FLIGHT ADD session=${sessionId} command="${command}"`);
      }
      await connInfo.connection.prompt({
        sessionId,
        prompt: [{ type: 'text', text: command }],
      });
    } catch (e: any) {
      log(`sendSlashCommand: failed for session ${sessionId}: ${e?.message ?? e}`);
    } finally {
      this.inFlightPromptSessions.delete(sessionId);
      if (DEBUG_LIVE) {
        log(`sendSlashCommand: IN-FLIGHT DELETE session=${sessionId} command="${command}"`);
      }
    }
  }

  /**
   * Execute a Kiro CLI slash command via `_kiro.dev/commands/execute`.
   * Kiro expects an adjacently-tagged command object (not a plain string) —
   * see kirodotdev/Kiro#5763. Leading `/` is stripped from the name.
   *
   * Returns any acknowledgment message from the result (message/text/content).
   * Rejects on timeout — compact can take a while, but must not hang forever
   * (Kiro sometimes never replies if the payload fails to deserialize).
   */
  async executeKiroCommand(
    sessionId: string,
    commandName: string,
    args: Record<string, string> = {},
  ): Promise<string | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    const connInfo = this.connectionManager.getConnection(session.agentId);
    if (!connInfo) {
      throw new Error(`No connection for session ${sessionId}`);
    }
    const name = commandName.replace(/^\//, '');
    // Kiro's TuiCommand is an adjacently-tagged enum (`tag=command`,
    // `content=args`). The `args` field must be present — even `{}` —
    // otherwise kiro-cli 2.11+ can fail the request and exit the ACP
    // process (exit 0, "ACP connection closed"). See kirodotdev/Kiro#5763
    // and Kantoku's executeSlashCommand which always sends args.
    const command = {
      command: name,
      args: args && Object.keys(args).length > 0 ? args : {},
    };
    const timeoutMs = name === 'compact' ? 600_000 : 30_000;
    log(
      `executeKiroCommand: session=${sessionId}, command="${name}", timeoutMs=${timeoutMs}, payload=${JSON.stringify(command)}`,
    );
    this.inFlightPromptSessions.add(sessionId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        connInfo.connection.request<any, any>('_kiro.dev/commands/execute', {
          sessionId,
          command,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`Kiro /${name} timed out after ${Math.round(timeoutMs / 1000)}s`));
          }, timeoutMs);
        }),
      ]);
      if (!result || typeof result !== 'object') {
        return typeof result === 'string' ? result : undefined;
      }
      if (typeof result.message === 'string') {
        return result.message;
      }
      if (typeof result.text === 'string') {
        return result.text;
      }
      if (typeof result.content === 'string') {
        return result.content;
      }
      return undefined;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      this.inFlightPromptSessions.delete(sessionId);
    }
  }

  /** True when the configured agent name looks like Kiro CLI. */
  isKiroAgentName(agentName: string | null | undefined): boolean {
    return !!agentName && /kiro/i.test(agentName);
  }

  /**
   * Replace a session's configOptions in place and notify listeners.
   * Used by both the setter response and the `config_option_update`
   * push-notification handler.
   */
  applyConfigOptions(sessionId: string, options: SessionConfigOption[] | null, synthesized = false): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      // Buffer until the session is registered (handles the race where a
      // notification is dispatched before createAcpSession finishes).
      this.pendingConfigOptions.set(sessionId, options ?? []);
      return;
    }
    session.configOptions = options ?? null;
    // Track whether these options were synthesized from legacy data.
    // synthesizeConfigOptions calls us with synthesized=true.
    // Real agent-provided options (from config_option_update or
    // set_config_option response) call with synthesized=false, clearing
    // the flag so setModel knows it can route through setConfigOption.
    session.synthesizedConfigOptions = synthesized;
    this.emit('config-options-changed', sessionId, session.configOptions);
  }

  /**
   * Probe for configOptions by sending a no-op set_config_option with the
   * current model value. If the agent doesn't support set_config_option
   * (e.g. Kiro CLI returns "Method not found"), synthesize configOptions
   * from the legacy `models` field and the `_kiro.dev/metadata` effort
   * so that model/thinking-level pickers still appear.
   */
  private async probeOrSynthesizeConfigOptions(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    // Only probe if we still don't have configOptions.
    if (session.configOptions && session.configOptions.length > 0) {
      return;
    }

    // Determine the current model value to send (no-op set).
    let modelValue: string | undefined;
    if (session.models?.currentModelId) {
      // Legacy models.currentModelId may include effort suffix (e.g. "glm-5.2[high]").
      // Extract just the model part.
      modelValue = session.models.currentModelId.replace(/\[(?:low|medium|high|xhigh|max|none)\]$/, '');
    }
    if (!modelValue) {
      // No model info at all -- try to synthesize from whatever we have.
      this.synthesizeConfigOptions(sessionId);
      return;
    }

    try {
      const connInfo = this.connectionManager.getConnection(session.agentId);
      if (!connInfo) {
        return;
      }
      const response = await connInfo.connection.setSessionConfigOption({
        sessionId,
        configId: 'model',
        value: modelValue,
      });
      const options = (response as any)?.configOptions ?? null;
      if (options && Array.isArray(options) && options.length > 0) {
        this.applyConfigOptions(sessionId, options);
        log(`probeConfigOptions: discovered ${options.length} config options for session ${sessionId}`);
      } else {
        // Agent accepted the call but returned no configOptions -- synthesize.
        this.synthesizeConfigOptions(sessionId);
      }
    } catch (e: any) {
      // Agent doesn't support set_config_option -- synthesize from legacy data.
      log(
        `probeConfigOptions: set_config_option failed for session ${sessionId}: ${e?.message ?? e}, synthesizing from legacy data`,
      );
      this.synthesizeConfigOptions(sessionId);
    }
  }

  /**
   * Extract the default effort level from the Kiro CLI agent's spawn args
   * (e.g. `--effort high`). Kiro only sends `effort` in _kiro.dev/metadata
   * for the first session, so we use this as a fallback for new sessions.
   */
  private getDefaultKiroEffort(agentName: string): string | undefined {
    const configs = getAgentConfigs();
    const config = configs[agentName];
    if (!config?.args) {
      return undefined;
    }
    const effortIdx = config.args.indexOf('--effort');
    if (effortIdx !== -1 && effortIdx + 1 < config.args.length) {
      return config.args[effortIdx + 1];
    }
    return undefined;
  }

  /**
   * Check if a model supports reasoning effort configuration.
   * Kiro CLI returns "Effort configuration is currently not available on
   * <model>" for models that don't support effort. Only Claude models
   * (and models with an effort suffix like glm-5.2[high]) support effort.
   */
  private modelSupportsEffort(modelId: string): boolean {
    if (!modelId) {
      return false;
    }
    // Models with effort suffix (e.g. "glm-5.2[high]", "qwen2.5-14b-1m[none]")
    // encode effort in the model ID — no separate /effort needed.
    if (/\[(?:low|medium|high|xhigh|max|none)\]$/.test(modelId)) {
      return false;
    }
    // Claude models support effort via /effort slash command
    if (/^claude-/i.test(modelId)) {
      return true;
    }
    // All other models (minimax-*, qwen*, auto, etc.) don't support effort
    return false;
  }

  /**
   * Update the visibility of the reasoning_effort config option based on
   * whether the current model supports effort. Called after model changes.
   */
  private updateEffortPickerVisibility(session: SessionInfo): void {
    if (!session.configOptions) {
      return;
    }
    const modelOpt = session.configOptions.find((o: any) => o.category === 'model');
    const currentModel = String(modelOpt?.currentValue || session.models?.currentModelId || '');
    const supportsEffort = this.modelSupportsEffort(currentModel);
    const effortOpt = session.configOptions.find((o: any) => o.id === 'reasoning_effort');
    log(
      `updateEffortPickerVisibility: session=${session.sessionId} model=${currentModel} ` +
        `supportsEffort=${supportsEffort} effortOptExists=${!!effortOpt}`,
    );
    if (supportsEffort) {
      // Ensure effort picker exists
      if (!effortOpt) {
        log(`updateEffortPickerVisibility: adding effort picker (model ${currentModel} supports effort)`);
        session.configOptions.push({
          id: 'reasoning_effort',
          category: 'thought_level',
          name: 'Thinking',
          description: 'Set thinking effort level',
          type: 'select' as any,
          currentValue: session.kiroEffort || 'high',
          options: [
            { value: 'low', name: 'low' },
            { value: 'medium', name: 'medium' },
            { value: 'high', name: 'high' },
            { value: 'xhigh', name: 'xhigh' },
            { value: 'max', name: 'max' },
          ],
        } as any);
        this.emit('config-options-changed', session.sessionId, session.configOptions);
      }
    } else {
      // Remove effort picker for models that don't support effort
      if (effortOpt) {
        log(`updateEffortPickerVisibility: removing effort picker (model ${currentModel} does NOT support effort)`);
        session.configOptions = session.configOptions.filter((o: any) => o.id !== 'reasoning_effort');
        this.emit('config-options-changed', session.sessionId, session.configOptions);
      }
    }
  }

  /**
   * Synthesize configOptions from legacy `models` and the `_kiro.dev/metadata`
   * effort field. This allows agents like Kiro CLI that only support
   * legacy `session/set_model` / slash commands to still get model and
   * thinking-level pickers in the UI.
   */
  private synthesizeConfigOptions(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    if (session.configOptions && session.configOptions.length > 0) {
      return;
    }

    // Extract the default effort level from the Kiro CLI spawn args (e.g. --effort high).
    // Kiro only sends `effort` in _kiro.dev/metadata for the first session,
    // so we need this fallback for new sessions.
    if (!session.kiroEffort) {
      const defaultEffort = this.getDefaultKiroEffort(session.agentName);
      if (defaultEffort) {
        session.kiroEffort = defaultEffort;
      }
    }

    const synthesized: SessionConfigOption[] = [];

    // Model configOption from legacy models field
    if (session.models?.availableModels && session.models.availableModels.length > 0) {
      synthesized.push({
        id: 'model',
        category: 'model',
        name: 'Model',
        description: 'Select the language model',
        type: 'select',
        currentValue: session.models.currentModelId || '',
        options: session.models.availableModels.map((m) => ({
          value: m.modelId,
          name: m.name || m.modelId,
          description: m.description,
        })),
      } as any);
    }

    // Reasoning effort configOption from _kiro.dev/metadata effort
    // For Kiro CLI agents, synthesize a reasoning_effort picker only if
    // Kiro only sends `effort` in _kiro.dev/metadata for the first session
    // (or when effort changes), so we can't rely on it being set for every
    // session. Fall back to the --effort CLI arg or 'high' default.
    const isKiro = session.agentName === 'Kiro CLI';
    // Only show the effort picker if the current model supports effort.
    const currentModelId = session.models?.currentModelId || '';
    const effortSupported = this.modelSupportsEffort(currentModelId);
    if ((session.kiroEffort || isKiro) && effortSupported) {
      // session.kiroEffort was already set from --effort CLI arg above if it was undefined.
      synthesized.push({
        id: 'reasoning_effort',
        category: 'thought_level',
        name: 'Thinking',
        description: 'Set thinking effort level',
        type: 'select',
        currentValue: session.kiroEffort || 'high',
        options: [
          { value: 'low', name: 'low' },
          { value: 'medium', name: 'medium' },
          { value: 'high', name: 'high' },
          { value: 'xhigh', name: 'xhigh' },
          { value: 'max', name: 'max' },
        ],
      } as any);
    }

    if (synthesized.length > 0) {
      log(
        `synthesizeConfigOptions: synthesized ${synthesized.length} config options from legacy data for session ${sessionId}`,
      );
      this.applyConfigOptions(sessionId, synthesized, true);
    }
  }

  /**
   * Replace a session's availableCommands and notify listeners. Buffers
   * the value if the session isn't registered yet (race during creation).
   */
  applyAvailableCommands(sessionId: string, commands: AvailableCommand[]): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.pendingAvailableCommands.set(sessionId, commands);
      return;
    }
    session.availableCommands = commands;
    this.emit('available-commands-changed', sessionId, commands);
  }

  /**
   * Apply a `session_info_update` notification: patches title / updatedAt on
   * the in-memory session and on the persistent history store.
   */
  applySessionInfoUpdate(sessionId: string, update: { title?: string | null; updatedAt?: string | null }): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      // Don't let agent-side session_info_update overwrite a user-set
      // custom title (from /rename). Only block if the user explicitly
      // renamed via /rename (userRenamed flag), not just if any title exists.
      const histEntry = session.agentName ? this.historyStore?.get(session.agentName, sessionId) : undefined;
      const hasCustomTitle = !!histEntry?.userRenamed;
      if (hasCustomTitle && update.title !== undefined) {
        // Keep the user's title; ignore the agent's.
        // Block both string titles (agent auto-title) and null (agent
        // clearing its title) — neither should overwrite a /rename title.
        return;
      }
      if (update.title === null) {
        delete session.title;
      } else if (typeof update.title === 'string') {
        session.title = update.title;
      }
    } else if (typeof update.title === 'string') {
      // Session not registered yet — buffer for drain.
      this.pendingTitles.set(sessionId, update.title);
    }
    // Mirror onto the history store regardless of whether session is live.
    if (this.historyStore && session) {
      this.historyStore.setTitle(session.agentName, sessionId, update.title);
    }
    // Only emit session-info-changed when the update actually carries a
    // title (string or null). When title is undefined (e.g. session_info_update
    // carrying only _meta.codex.goal), emitting would cause the webview to
    // receive title=null and delete the existing title, falling back to the
    // agent name ("Codex") instead of showing the real session title.
    if (update.title !== undefined) {
      this.emit('session-info-changed', sessionId, update);
    }
  }

  /**
   * Record the first user prompt of a session so the history-store tree can
   * use it as a label fallback when no title arrives.
   */
  recordFirstPrompt(sessionId: string, prompt: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || !this.historyStore) {
      return;
    }
    this.historyStore.setFirstPromptIfMissing(session.agentName, sessionId, prompt);
  }

  /** Bump a session's `lastActiveAt` in the history store. */
  touchHistory(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    this.historyStore?.touch(session.agentName, sessionId);
  }

  /**
   * Rename the current session. Sets the title locally (SessionInfo +
   * HistoryStore) and emits `session-info-changed` so the tree and banner
   * update immediately. Works even during streaming — does NOT send anything
   * to the agent (the title is a client-side concept).
   */
  renameSession(sessionId: string, title: string): void {
    const session = this.sessions.get(sessionId);
    const agentName = session?.agentName;
    if (agentName) {
      // Pass cwd so the history entry matches workspace-scoped tree list().
      this.historyStore?.userRename(agentName, sessionId, title, session?.cwd);
    }
    if (session) {
      session.title = title;
    }
    this.emit('session-info-changed', sessionId, { title });
    log(`renameSession: session ${sessionId} renamed to "${title}"`);
  }

  // --- Connection lifecycle (no session) ---

  /**
   * Spawn + initialize + (optionally authenticate) an agent without creating
   * a session. Caches the capability summary. Idempotent.
   *
   * NOTE: this never disconnects the currently-active agent — it is safe to
   * call from the tree view to probe capabilities or list sessions while
   * the user is chatting with a different agent. Callers that want to
   * switch the active session (e.g. loadSession) handle the active-agent
   * teardown themselves.
   */
  async ensureConnected(agentName: string): Promise<ConnectionInfo> {
    const resolvedAgentName = resolveAgentConfigKey(agentName);
    if (!resolvedAgentName) {
      throw new Error(`Unknown agent: ${agentName}.`);
    }
    if (resolvedAgentName !== agentName) {
      log(`Resolved agent name "${agentName}" → "${resolvedAgentName}"`);
      agentName = resolvedAgentName;
    }

    // If we already have a live session with this agent, reuse its connection.
    const existingSessionId = this.agentSessions.get(agentName);
    if (existingSessionId) {
      const existing = this.sessions.get(existingSessionId);
      if (existing) {
        const conn = this.connectionManager.getConnection(existing.agentId);
        if (conn) {
          this.capabilities.set(agentName, this.summarizeCapabilities(conn.initResponse.agentCapabilities));
          return conn;
        }
      }
    }

    // If the agent process is already spawned (e.g. from a previous probe),
    // reuse it instead of spawning a new one.
    for (const instance of this.agentManager.getRunningAgents()) {
      if (instance.name === agentName) {
        const conn = this.connectionManager.getConnection(instance.id);
        if (conn) {
          this.capabilities.set(agentName, this.summarizeCapabilities(conn.initResponse.agentCapabilities));
          return conn;
        }
      }
    }

    const config = getAgentConfig(agentName);
    if (!config) {
      throw new Error(`Unknown agent: ${agentName}.`);
    }

    const workspaceCwd = this.getWorkspaceCwd();
    const agentInstance = this.agentManager.spawnAgent(agentName, config, workspaceCwd);
    const agentId = agentInstance.id;

    const agentProcess = this.agentManager.getAgent(agentId);
    if (!agentProcess) {
      throw new Error('Agent process not found after spawn');
    }

    let connInfo: ConnectionInfo;
    try {
      connInfo = await this.connectionManager.connect(agentId, agentProcess.process);
    } catch (e) {
      this.agentManager.killAgent(agentId);
      throw e;
    }

    this.capabilities.set(agentName, this.summarizeCapabilities(connInfo.initResponse.agentCapabilities));
    // Wire up _kiro.dev/metadata handler — same as connectToAgent.
    // When ensureConnected creates a NEW connection (e.g. loadSession
    // fallthrough after stale session), the handler must be set up so
    // that _kiro.dev/metadata notifications are not silently dropped.
    this.wireKiroMetadataHandler(connInfo, agentName);
    return connInfo;
  }

  /**
   * Wire up Kiro CLI `_kiro.dev/*` notification handlers on a ConnectionInfo.
   * Called from both connectToAgent() and ensureConnected() so metadata,
   * slash-command catalogs, and compaction status are always captured.
   */
  private wireKiroMetadataHandler(connInfo: ConnectionInfo, agentName: string): void {
    connInfo.onKiroMetadata = (params: any) => {
      // Store effort on all sessions for this agent so that
      // synthesizeConfigOptions can pick it up.
      if (params?.effort) {
        for (const session of this.sessions.values()) {
          if (session.agentName === agentName) {
            const wasUndefined = !session.kiroEffort;
            session.kiroEffort = params.effort;
            // If this is the first time we get the effort and the session
            // doesn't have configOptions yet (probeOrSynthesizeConfigOptions
            // may have run before metadata arrived), re-synthesize now.
            if (wasUndefined && (!session.configOptions || session.configOptions.length === 0)) {
              this.synthesizeConfigOptions(session.sessionId);
            } else if (wasUndefined && session.configOptions) {
              // configOptions already exist (possibly synthesized without effort).
              // Add or update the reasoning_effort option.
              // Only add if the current model supports effort.
              const effortOpt = session.configOptions.find((o: any) => o.id === 'reasoning_effort');
              const currentModelId = session.models?.currentModelId || '';
              if (!effortOpt && this.modelSupportsEffort(currentModelId)) {
                session.configOptions.push({
                  id: 'reasoning_effort',
                  category: 'thought_level',
                  name: 'Thinking',
                  description: 'Set thinking effort level',
                  type: 'select' as any,
                  currentValue: params.effort,
                  options: [
                    { value: 'low', name: 'low' },
                    { value: 'medium', name: 'medium' },
                    { value: 'high', name: 'high' },
                    { value: 'xhigh', name: 'xhigh' },
                    { value: 'max', name: 'max' },
                  ],
                } as any);
                this.emit('config-options-changed', session.sessionId, session.configOptions);
              }
            } else {
              // Effort was already known — update currentValue if it changed.
              const effortOpt = session.configOptions?.find((o) => o.id === 'reasoning_effort');
              if (effortOpt && effortOpt.currentValue !== params.effort) {
                effortOpt.currentValue = params.effort;
                this.emit('config-options-changed', session.sessionId, session.configOptions!);
              }
            }
          }
        }
      }
      this.emit('kiro-metadata', params);
    };

    // Wire up _kiro.dev/subagent/list_update handler — Kiro sends live
    // subagent statuses (session names, working/done states) that the
    // webview uses to update per-stage spinners in the crew tool call.
    connInfo.onKiroSubagentListUpdate = (params: any) => {
      this.emit('kiro-subagent-list-update', params);
    };

    // Merge Kiro slash commands into the session's availableCommands so the
    // webview autocomplete shows `/compact` etc. (Kiro does not use the
    // standard ACP available_commands_update for these.)
    connInfo.onKiroCommandsAvailable = (params: any) => {
      const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : undefined;
      const raw = Array.isArray(params?.commands) ? params.commands : [];
      const kiroCmds: AvailableCommand[] = raw
        .map((c: any) => {
          const name = String(c?.name || '')
            .replace(/^\//, '')
            .trim();
          if (!name) {
            return null;
          }
          return {
            name,
            description: typeof c?.description === 'string' ? c.description : '',
          } as AvailableCommand;
        })
        .filter((c: AvailableCommand | null): c is AvailableCommand => !!c);

      if (sessionId && kiroCmds.length > 0) {
        const session = this.sessions.get(sessionId);
        const existing = session?.availableCommands || this.pendingAvailableCommands.get(sessionId) || [];
        const byName = new Map<string, AvailableCommand>();
        for (const c of existing) {
          byName.set(c.name, c);
        }
        for (const c of kiroCmds) {
          byName.set(c.name, c);
        }
        this.applyAvailableCommands(sessionId, [...byName.values()]);
      }
      this.emit('kiro-commands-available', params);
    };

    connInfo.onKiroCompactionStatus = (params: any) => {
      this.emit('kiro-compaction-status', params);
    };

    connInfo.onKiroClearStatus = (params: any) => {
      this.emit('kiro-clear-status', params);
    };

    connInfo.onKiroGoalStatus = (params: any) => {
      // Kiro CLI sends _kiro.dev/goal/status with {state, iteration, maxIterations, message, elapsedSecs, sessionId}
      // Convert to the same goal snapshot format used by codex-acp's session_info_update _meta.codex.goal
      const sessionId = params.sessionId || this.activeSessionId;
      const session = this.sessions.get(sessionId);
      if (session) {
        const kiroGoalStatusMap: Record<string, string> = {
          active: 'active',
          paused: 'paused',
          completed: 'complete',
          blocked: 'blocked',
          cancelled: 'complete',
        };
        const goalSnapshot = {
          objective: params.message || '',
          status: kiroGoalStatusMap[params.state] || params.state || 'active',
          tokenBudget: null,
          iteration: params.iteration,
          maxIterations: params.maxIterations,
          timeUsedSeconds: params.elapsedSecs || 0,
          createdAt: null,
          controlMethod: '_kiro.dev/goal/control',
        };
        (session as any).goalSnapshot = goalSnapshot;
        // Emit so ChatWebviewProvider can forward to webview
        this.emit('kiro-goal-status', { sessionId, goalSnapshot });
      }
    };

    connInfo.onSessionTerminate = (params: any) => {
      this.emit('session-terminate', params);
    };

    // Cursor ACP extension methods (cursor.com/docs/cli/acp).
    connInfo.onCursorMethod = (msg) => {
      const { method, params, id, respond } = msg;
      if (method === 'cursor/task') {
        this.emit('cursor-task', params);
        return true;
      }
      if (method === 'cursor/update_todos') {
        this.emit('cursor-update-todos', params);
        return true;
      }
      if (method === 'cursor/generate_image') {
        this.emit('cursor-generate-image', params);
        return true;
      }
      if (method === 'cursor/ask_question' && id !== undefined && id !== null) {
        this.emit('cursor-ask-question', params, respond);
        return true;
      }
      if (method === 'cursor/create_plan' && id !== undefined && id !== null) {
        this.emit('cursor-create-plan', params, respond);
        return true;
      }
      return false;
    };
  }

  /**
   * List sessions known to an agent (ACP `session/list`).
   * Throws if the agent doesn't advertise the capability.
   */
  async listSessions(
    agentName: string,
    opts: { cwd?: string; cursor?: string } = {},
  ): Promise<{ sessions: ProtocolSessionInfo[]; nextCursor?: string }> {
    const conn = await this.ensureConnected(agentName);
    const caps = this.capabilities.get(agentName);
    if (!caps?.list) {
      throw new Error(`Agent "${agentName}" does not support session/list.`);
    }

    const params: any = {};
    if (opts.cwd) {
      params.cwd = opts.cwd;
    }
    if (opts.cursor) {
      params.cursor = opts.cursor;
    }

    let response: any;
    try {
      response = await conn.connection.listSessions(params);
    } catch (e: any) {
      if (this.isAuthRequiredError(e)) {
        // Auth then retry.
        const agentInfo = this.findAgentIdForConnection(conn);
        if (agentInfo) {
          await this.runAuthFlow(agentName, agentInfo, conn);
          response = await conn.connection.listSessions(params);
        } else {
          throw e;
        }
      } else {
        throw e;
      }
    }

    const sessions: ProtocolSessionInfo[] = response?.sessions ?? [];
    // Reconcile the history store — drop any locally-cached entries that
    // the agent no longer knows about.
    if (this.historyStore && !opts.cursor) {
      this.historyStore.reconcileFromAgent(agentName, new Set(sessions.map((s) => s.sessionId)));
    }
    return { sessions, nextCursor: response?.nextCursor ?? undefined };
  }

  /**
   * Load an existing session, replaying the entire conversation history via
   * `session/update` notifications. Heavyweight. Active session is switched
   * to the loaded session on success.
   *
   * Concurrent loads for the same agent are serialized (per-agent chain) so a
   * later load can never interleave with an earlier load's replay and cause
   * the active-session gate in the extension host to drop replay chunks.
   */
  async loadSession(agentName: string, sessionId: string): Promise<SessionInfo> {
    const dedupeKey = `${agentName}:${sessionId}`;
    const existing = this.loadSessionPromises.get(dedupeKey);
    if (existing) {
      return existing;
    }

    const prev = this.loadSerialChains.get(agentName) ?? Promise.resolve();
    const run = prev.then(() => this.loadSessionImpl(agentName, sessionId));
    this.loadSessionPromises.set(dedupeKey, run);
    run.finally(() => {
      if (this.loadSessionPromises.get(dedupeKey) === run) {
        this.loadSessionPromises.delete(dedupeKey);
      }
    });
    // Keep the chain alive even on rejection so a failed load does not block
    // subsequent loads forever; the error still propagates to the caller.
    this.loadSerialChains.set(
      agentName,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /** Abort every in-flight `session/load` replay. */
  cancelInFlightSessionLoads(): void {
    for (const sessionId of [...this.loadingSessionIds]) {
      this.cancelSessionLoad(sessionId);
    }
  }

  /**
   * Abort in-flight loads except the given target (double-click resume for the
   * same session should coalesce, not cancel).
   */
  cancelInFlightSessionLoadsUnless(agentName: string, sessionId: string): void {
    for (const sid of [...this.loadingSessionIds]) {
      if (sid === sessionId && this.sessions.get(sid)?.agentName === agentName) {
        continue;
      }
      this.cancelSessionLoad(sid);
    }
  }

  /** True when the given session is mid-replay via `session/load`. */
  hasInFlightSessionLoadFor(agentName: string, sessionId: string): boolean {
    return this.loadingSessionIds.has(sessionId) && this.sessions.get(sessionId)?.agentName === agentName;
  }

  private cancelSessionLoad(sessionId: string): void {
    if (!this.loadingSessionIds.has(sessionId)) {
      return;
    }
    this.cancelledSessionLoads.add(sessionId);
    const session = this.sessions.get(sessionId);
    const agentName = session?.agentName;
    this.loadingSessionIds.delete(sessionId);
    this.sessions.delete(sessionId);
    if (agentName) {
      this.agentSessions.delete(agentName);
    }
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = null;
    }
    if (agentName) {
      log(`loadSession: cancelled in-flight replay for ${sessionId}`);
      this.emit('session-load-end', sessionId, agentName, /*ok=*/ false);
    }
  }

  private wasSessionLoadCancelled(sessionId: string): boolean {
    return this.cancelledSessionLoads.has(sessionId);
  }

  private clearSessionLoadCancelled(sessionId: string): void {
    this.cancelledSessionLoads.delete(sessionId);
  }

  private async loadSessionImpl(agentName: string, sessionId: string): Promise<SessionInfo> {
    this.clearSessionLoadCancelled(sessionId);

    // Honor the single-active-session model: if a different agent currently
    // owns the active session, disconnect it before opening this one.
    const currentAgent = this.getActiveAgentName();
    if (currentAgent && currentAgent !== agentName) {
      await this.disconnectAgent(currentAgent);
    }

    const conn = await this.ensureConnected(agentName);
    const caps = this.capabilities.get(agentName);
    if (!caps?.load) {
      throw new Error(`Agent "${agentName}" does not support session/load.`);
    }

    // If the same agent has a different active session, clear it so the
    // load can take over as the new active session.
    const previouslyActive = this.activeSessionId;
    if (previouslyActive && previouslyActive !== sessionId) {
      const prevSession = this.sessions.get(previouslyActive);
      if (prevSession) {
        // Cancel any in-flight prompt on the previous session so its
        // sendPrompt promise doesn't reject with "ACP connection closed"
        // later when the agent is disconnected or the session is deleted.
        if (this.inFlightPromptSessions.has(previouslyActive)) {
          const prevConn = this.connectionManager.getConnection(prevSession.agentId);
          if (prevConn) {
            try {
              log(`loadSession: cancelling in-flight prompt for previous session ${previouslyActive}`);
              await prevConn.connection.cancel({ sessionId: previouslyActive });
            } catch (e: any) {
              log(`loadSession: session/cancel error for ${previouslyActive} (non-fatal): ${e?.message || e}`);
            }
          }
          this.inFlightPromptSessions.delete(previouslyActive);
        }
        this.agentSessions.delete(prevSession.agentName);
      }
      this.sessions.delete(previouslyActive);
      this.activeSessionId = null;
    }

    const cwd = this.getWorkspaceCwd();
    const agentId = this.findAgentIdForConnection(conn);
    if (!agentId) {
      throw new Error(`Unable to locate agent process for "${agentName}".`);
    }

    // Pre-register a placeholder so notifications that arrive during the
    // replay can be associated with the session (closing the same race the
    // pending* buffers handle for session/new).
    const placeholder: SessionInfo = {
      sessionId,
      agentId,
      agentName,
      agentDisplayName: this.displayNameFor(agentName, conn.initResponse),
      cwd,
      createdAt: new Date().toISOString(),
      initResponse: conn.initResponse,
      modes: null,
      models: null,
      configOptions: null,
      availableCommands: [],
    };
    // Restore the renamed title from the history store so it appears in
    // the chat banner immediately on session open (before the agent
    // replays any session_info_update during session/load).
    const histEntry = this.historyStore?.get(agentName, sessionId);
    if (histEntry?.title) {
      placeholder.title = histEntry.title;
    }
    this.sessions.set(sessionId, placeholder);
    this.drainPending(placeholder);
    this.loadingSessionIds.add(sessionId);
    // Mark this session as active up front so handleSessionUpdate forwards
    // the replayed chunks to the webview during the load. Without this,
    // updates arrive before the activeSessionId is set and are dropped.
    this.agentSessions.set(agentName, sessionId);
    this.activeSessionId = sessionId;
    // Emit active-session-changed BEFORE session-load-start so the webview
    // first repaints from the new session state, then immediately enters
    // the loading-overlay state.
    this.emit('agent-connected', agentName);
    this.emit('active-session-changed', sessionId);
    this.emit('session-load-start', sessionId, agentName);

    try {
      const response = await conn.connection.loadSession({
        sessionId,
        cwd,
        mcpServers: [],
      });
      if (this.wasSessionLoadCancelled(sessionId)) {
        this.clearSessionLoadCancelled(sessionId);
        throw new SessionLoadCancelledError();
      }
      // The response carries the latest mode/model/configOptions snapshot.
      placeholder.modes = (response as any).modes ?? null;
      placeholder.models = (response as any).models ?? null;
      placeholder.configOptions = (response as any).configOptions ?? null;

      // Emit config-options-changed so the webview picks up the model/mode
      // from the loaded session. Without this, the picker still shows the
      // defaults from the connectToAgent → newSession call (which created a
      // fresh session with the default model before loadSession overwrote it).
      if (placeholder.configOptions && placeholder.configOptions.length > 0) {
        this.applyConfigOptions(sessionId, placeholder.configOptions);
      }

      // Push the legacy `models` snapshot too. 'active-session-changed' is
      // emitted BEFORE the loadSession request (so the panel switches
      // immediately), which means the webview received its `state` while
      // placeholder.models was still null — and notifyModelsUpdate is only
      // wired to 'model-changed', so nothing told it afterwards. The webview's
      // currentModelId therefore stayed null for the whole resumed session, and
      // the Kiro/EricCLI attach-button rule (which reads currentModelId, not
      // promptCapabilities) hid the image button even on a vision model:
      // observed as `[WV-DIAG] attachBtn: agent="Kiro CLI" model="null"
      // image=true` on a claude-opus-5 session.
      const loadedModelId = placeholder.models?.currentModelId;
      if (loadedModelId) {
        this.emit('model-changed', sessionId, loadedModelId);
      }

      // If the agent didn't return configOptions, probe for them.
      if (!placeholder.configOptions || placeholder.configOptions.length === 0) {
        void this.probeOrSynthesizeConfigOptions(sessionId);
      }

      // A loaded/resumed session already has prior turns — for codex-acp this
      // means the Responses-API server already holds a cached prefix, so the
      // next prompt is a continuation. Mark it as prompted so the KV-cache-
      // stability gate in sendPrompt skips memory re-injection (re-injecting
      // would shift the prefix and invalidate the cached history).
      //
      // For non-incremental agents (Pi, Claude, etc.) the memory block is a
      // plain text ContentBlock prepended to each prompt — there is no KV
      // cache to invalidate. The first prompt after session/load must take
      // the 'full' path so persona + scenes + <available_skills> are
      // injected (the agent has no prior memory context in its context
      // window after a fresh process spawn).
      if (isIncrementalCacheAgent(agentName)) {
        this.promptedSessions.add(sessionId);
        this.memoryProfileInjectedSessions.add(sessionId);
      }
    } catch (e: any) {
      if (this.wasSessionLoadCancelled(sessionId)) {
        this.clearSessionLoadCancelled(sessionId);
        throw new SessionLoadCancelledError();
      }
      this.loadingSessionIds.delete(sessionId);
      this.sessions.delete(sessionId);
      this.agentSessions.delete(agentName);
      if (this.activeSessionId === sessionId) {
        this.activeSessionId = null;
      }

      // If the agent says the session is gone, prune from local history so
      // it doesn't reappear on next refresh.
      // Check both message and data (Kiro puts "Session not found" in data).
      const errData = (e as any)?.data;
      const errDataStr = typeof errData === 'string' ? errData : errData ? JSON.stringify(errData) : '';
      const msg = String(e?.message || '') + ' ' + errDataStr;
      if (/not found|no such|unknown session|no rollout/i.test(msg)) {
        log(`loadSession: pruning stale session ${sessionId} from history (agent says: not found)`);
        this.historyStore?.forget(agentName, sessionId);
        // Don't emit session-load-end with ok=false — that would show
        // "Failed to load session history" in the webview. Instead, silently
        // fall through to creating a new session. The user clicked a stale
        // session — they want to chat with this agent, so give them a fresh
        // session rather than an error.
        log(`loadSession: creating new session for ${agentName} instead`);
        const newSession = await this.createAcpSession(agentName, agentId, conn, cwd);
        this.agentSessions.set(agentName, newSession.sessionId);
        this.activeSessionId = newSession.sessionId;
        // Emit session-load-end with ok=true to dismiss the
        // "Loading conversation history..." overlay.
        this.emit('session-load-end', newSession.sessionId, agentName, /*ok=*/ true);
        this.emit('agent-connected', agentName);
        this.emit('active-session-changed', newSession.sessionId);
        log(`loadSession: created new session ${newSession.sessionId} for ${agentName}`);
        return newSession;
      }

      // For non-"not found" errors, show the error to the user.
      this.emit('session-load-end', sessionId, agentName, /*ok=*/ false);
      this.emit('active-session-changed', null);
      throw e;
    }

    this.loadingSessionIds.delete(sessionId);
    // Drain pending replay notifications BEFORE signalling load-end.
    //
    // Kiro (and other stdio agents) stream the whole session/load replay as a
    // burst of session/update notifications that the SDK dispatches AFTER the
    // session/load response promise resolves. If we emit session-load-end
    // immediately, the webview flips isLoadingSession=false first, and the
    // delayed user_message_chunk / agent_message_chunk replay notifications
    // then hit the `if (!isLoadingSession) break;` gates in the webview and
    // are silently dropped — the replayed chat ends up with tool_calls +
    // thoughts but NO user prompts and NO assistant summaries (exactly the
    // "user msg and summary don't show after resume" bug).
    //
    // Give the notification dispatch a few event-loop turns to flush before
    // signalling load-end. This is a bounded drain (no await on the agent);
    // 100 ms is far beyond any inter-frame jitter and short enough to stay
    // imperceptible to the user.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
    if (this.wasSessionLoadCancelled(sessionId)) {
      this.clearSessionLoadCancelled(sessionId);
      throw new SessionLoadCancelledError();
    }
    this.emit('session-load-end', sessionId, agentName, /*ok=*/ true);

    // Touch history-store activity timestamp.
    this.historyStore?.touch(agentName, sessionId);
    // Restore saved config options (mode/model/reasoning_effort).
    await this.restoreConfigOptions(sessionId, agentName);
    return placeholder;
  }

  /**
   * Resume an existing session without replaying history (light path).
   * Serialized per agent (same chain as loadSession) so a concurrent load or
   * resume for the same agent cannot interleave and flip activeSessionId
   * mid-replay, which would drop that replay's chunks at the active-session
   * gate in the extension host.
   */
  async resumeSession(agentName: string, sessionId: string): Promise<SessionInfo> {
    const prev = this.loadSerialChains.get(agentName) ?? Promise.resolve();
    const run = prev.then(() => this.resumeSessionImpl(agentName, sessionId));
    this.loadSerialChains.set(
      agentName,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async resumeSessionImpl(agentName: string, sessionId: string): Promise<SessionInfo> {
    const currentAgent = this.getActiveAgentName();
    if (currentAgent && currentAgent !== agentName) {
      await this.disconnectAgent(currentAgent);
    }

    const conn = await this.ensureConnected(agentName);
    const caps = this.capabilities.get(agentName);
    if (!caps?.resume) {
      throw new Error(`Agent "${agentName}" does not support session/resume.`);
    }

    // If the same agent has a different active session, clear it.
    const previouslyActive = this.activeSessionId;
    if (previouslyActive && previouslyActive !== sessionId) {
      const prevSession = this.sessions.get(previouslyActive);
      if (prevSession) {
        this.agentSessions.delete(prevSession.agentName);
      }
      this.sessions.delete(previouslyActive);
      this.activeSessionId = null;
    }

    const cwd = this.getWorkspaceCwd();
    const agentId = this.findAgentIdForConnection(conn);
    if (!agentId) {
      throw new Error(`Unable to locate agent process for "${agentName}".`);
    }

    let response: any;
    try {
      response = await conn.connection.resumeSession({
        sessionId,
        mcpServers: [],
        cwd,
      });
    } catch (e: any) {
      const errData = (e as any)?.data;
      const errDataStr = typeof errData === 'string' ? errData : errData ? JSON.stringify(errData) : '';
      const msg = String(e?.message || '') + ' ' + errDataStr;
      if (/not found|no such|unknown session|no rollout/i.test(msg)) {
        this.historyStore?.forget(agentName, sessionId);
      }
      throw e;
    }

    const sessionInfo: SessionInfo = {
      sessionId,
      agentId,
      agentName,
      agentDisplayName: this.displayNameFor(agentName, conn.initResponse),
      cwd,
      createdAt: new Date().toISOString(),
      initResponse: conn.initResponse,
      modes: response?.modes ?? null,
      models: response?.models ?? null,
      configOptions: response?.configOptions ?? null,
      availableCommands: [],
    };
    // Restore the renamed title from the history store so it appears in
    // the chat banner immediately (same as loadSession does).
    const histEntry = this.historyStore?.get(agentName, sessionId);
    if (histEntry?.title) {
      sessionInfo.title = histEntry.title;
    }
    this.sessions.set(sessionId, sessionInfo);
    // A resumed session already has prior turns — for codex-acp this means the
    // Responses-API server holds a cached prefix, so the next prompt is a
    // continuation. Mark as prompted so the KV-cache-stability gate in
    // sendPrompt skips memory re-injection (would shift the prefix otherwise).
    //
    // For non-incremental agents (Pi, Claude, etc.) the memory block is a
    // plain text ContentBlock prepended to each prompt — no KV cache to
    // invalidate. The first prompt after resume must take the 'full' path
    // so persona + scenes + <available_skills> are injected.
    if (isIncrementalCacheAgent(agentName)) {
      this.promptedSessions.add(sessionId);
      this.memoryProfileInjectedSessions.add(sessionId);
    }
    // Set activeSessionId BEFORE drainPending so the 'available-commands-changed'
    // event drainPending emits (for commands buffered during session/new)
    // passes the active-session guard in the extension listener and reaches
    // the webview's slash-command popup.
    this.activeSessionId = sessionId;
    this.drainPending(sessionInfo);
    this.agentSessions.set(agentName, sessionId);
    this.emit('agent-connected', agentName);
    this.emit('active-session-changed', sessionId);

    // Emit config-options-changed so the webview picks up the model/mode
    // from the resumed session (same fix as loadSession).
    if (sessionInfo.configOptions && sessionInfo.configOptions.length > 0) {
      this.applyConfigOptions(sessionId, sessionInfo.configOptions);
    }

    this.historyStore?.touch(agentName, sessionId);
    // Restore saved config options (mode/model/reasoning_effort).
    await this.restoreConfigOptions(sessionId, agentName);
    return sessionInfo;
  }

  /** Return true if a session is currently mid-replay via `session/load`. */
  isLoading(sessionId: string): boolean {
    return this.loadingSessionIds.has(sessionId);
  }

  /** Helper: reverse-lookup agentId for a known ConnectionInfo. */
  private findAgentIdForConnection(conn: ConnectionInfo): string | undefined {
    for (const session of this.sessions.values()) {
      const c = this.connectionManager.getConnection(session.agentId);
      if (c === conn) {
        return session.agentId;
      }
    }
    // Connection without a session — search agentManager's spawned set.
    for (const instance of this.agentManager.getRunningAgents()) {
      if (this.connectionManager.getConnection(instance.id) === conn) {
        return instance.id;
      }
    }
    return undefined;
  }

  // --- Getters ---

  getSession(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  /** All sessions currently held in memory (open or background). */
  getOpenSessions(): SessionInfo[] {
    return Array.from(this.sessions.values());
  }

  getActiveSession(): SessionInfo | undefined {
    if (!this.activeSessionId) {
      return undefined;
    }
    return this.sessions.get(this.activeSessionId);
  }

  getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  /** Get the agent name for the current active session. */
  getActiveAgentName(): string | null {
    const session = this.getActiveSession();
    return session?.agentName ?? null;
  }

  /** Check if a specific agent is currently connected. */
  isAgentConnected(agentName: string): boolean {
    return this.agentSessions.has(agentName);
  }

  /** Get all connected agent names. */
  getConnectedAgentNames(): string[] {
    return Array.from(this.agentSessions.keys());
  }

  getConnectionForSession(sessionId: string): ConnectionInfo | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return undefined;
    }
    return this.connectionManager.getConnection(session.agentId);
  }

  /**
   * Delete a session from the agent's session history (ACP `session/delete`).
   * The agent MUST advertise `sessionCapabilities.delete` for this to succeed.
   * Also removes the session from the local history store.
   */
  async deleteSession(agentName: string, sessionId: string): Promise<void> {
    const conn = await this.ensureConnected(agentName);
    const caps = this.capabilities.get(agentName);
    if (!caps?.delete) {
      throw new Error(`Agent "${agentName}" does not support session/delete`);
    }

    log(`deleteSession: deleting ${sessionId} from agent ${agentName}`);
    await conn.connection.deleteSession?.({ sessionId });

    // Also remove from local history store
    this.historyStore?.forget(agentName, sessionId);
  }

  /**
   * Log out from the agent's authenticated session (ACP `logout`).
   * The agent MUST advertise `auth.logout` capability for this to succeed.
   */
  async logout(agentName: string): Promise<void> {
    const conn = await this.ensureConnected(agentName);

    log(`logout: logging out from agent ${agentName}`);
    await conn.connection.logout?.({});
  }

  /**
   * Fork a session (ACP `session/fork` — experimental).
   * Creates a new session that branches from an existing conversation.
   * The agent MUST advertise `sessionCapabilities.fork` for this to succeed.
   */
  async forkSession(agentName: string, sessionId: string): Promise<SessionInfo> {
    const conn = await this.ensureConnected(agentName);
    const caps = this.capabilities.get(agentName);
    if (!caps) {
      throw new Error(`Agent "${agentName}" capabilities not loaded`);
    }

    // forkSession is still unstable in the SDK — use optional chaining.
    const forkFn = (conn.connection as any).unstable_forkSession;
    if (typeof forkFn !== 'function') {
      log(`forkSession: agent "${agentName}" does not support session/fork — skipping`);
      throw new Error(`Agent "${agentName}" does not support session/fork`);
    }

    const cwd = this.getWorkspaceCwd();
    log(`forkSession: forking ${sessionId} from agent ${agentName}`);
    const response = await forkFn.call(conn.connection, { sessionId, cwd });

    const forkedSessionId = response?.sessionId;
    if (!forkedSessionId) {
      throw new Error('forkSession: agent did not return a sessionId');
    }

    const sessionInfo: SessionInfo = {
      sessionId: forkedSessionId,
      agentId: this.findAgentIdForConnection(conn) ?? '',
      agentName,
      agentDisplayName: this.displayNameFor(agentName, conn.initResponse),
      cwd,
      createdAt: new Date().toISOString(),
      initResponse: conn.initResponse,
      modes: response?.modes ?? null,
      models: null,
      configOptions: response?.configOptions ?? null,
      availableCommands: [],
    };
    this.sessions.set(forkedSessionId, sessionInfo);
    this.drainPending(sessionInfo);
    this.agentSessions.set(agentName, forkedSessionId);
    this.activeSessionId = forkedSessionId;
    this.historyStore?.upsertNew(agentName, cwd, forkedSessionId);
    this.emit('agent-connected', agentName);
    this.emit('active-session-changed', forkedSessionId);
    return sessionInfo;
  }

  // --- Cleanup ---

  private displayNameFor(agentName: string, initResponse: InitializeResponse): string {
    return resolveAgentDisplayName(agentName, {
      displayName: getAgentConfig(agentName)?.displayName,
      agentInfo: initResponse.agentInfo,
    });
  }

  dispose(): void {
    this.agentManager.killAll();
    this.connectionManager.dispose();
    this.sessions.clear();
    this.agentSessions.clear();
    this.promptedSessions.clear();
    this.memoryProfileInjectedSessions.clear();
    this.memoryProvider?.dispose();
  }
}

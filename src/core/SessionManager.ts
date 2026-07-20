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
interface SessionModelState {
  currentModelId: string;
  availableModels: Array<{ modelId: string; name?: string; description?: string }>;
}

import { RequestError } from '@agentclientprotocol/sdk';

import { AgentManager } from './AgentManager';
import { ConnectionManager, ConnectionInfo } from './ConnectionManager';
import { SessionUpdateHandler } from '../handlers/SessionUpdateHandler';
import { SessionHistoryStore } from './SessionHistoryStore';
import { getAgentConfigs } from '../config/AgentConfig';
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
}

/**
 * A piece of editor-selection context to attach to the next prompt.
 * Re-exported from {@link ContextBlockBuilder} so callers can keep importing
 * it from `SessionManager`.
 */
export type { SelectionContext } from './ContextBlockBuilder';
import { buildSelectionBlock, type SelectionContext } from './ContextBlockBuilder';

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

  /** Set of session IDs with an in-flight `session/prompt` request. */
  private inFlightPromptSessions: Set<string> = new Set();

  /** Client-side session history (optional — only used for tier-2 tree). */
  private historyStore: SessionHistoryStore | null = null;

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
    };
  }

  /**
   * Connect to an agent and start chatting.
   * Only one agent can be connected at a time — automatically disconnects
   * any previously connected agent.
   * Internally creates a session via ACP protocol.
   */
  async connectToAgent(agentName: string): Promise<SessionInfo> {
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

    const configs = getAgentConfigs();
    const config = configs[agentName];
    if (!config) {
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

    const connInfo = this.connectionManager.getConnection(session.agentId);

    // If a prompt turn is in flight, send session/cancel first so the
    // agent can abort gracefully. session/close implies cancellation per
    // the spec, but sending the notification explicitly is more robust
    // for agents that may not implement the implicit cancel.
    if (connInfo && this.inFlightPromptSessions.has(sessionId)) {
      try {
        log(`disconnectAgent: cancelling in-flight prompt for ${sessionId}`);
        await connInfo.connection.cancel({ sessionId });
      } catch (e: any) {
        log(`disconnectAgent: session/cancel error (non-fatal): ${e?.message || e}`);
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
      agentDisplayName: connInfo.initResponse.agentInfo?.title || connInfo.initResponse.agentInfo?.name || agentName,
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
    }
    const pendingCfg = this.pendingConfigOptions.get(sessionInfo.sessionId);
    if (pendingCfg !== undefined) {
      sessionInfo.configOptions = pendingCfg;
      this.pendingConfigOptions.delete(sessionInfo.sessionId);
    }
    const pendingTitle = this.pendingTitles.get(sessionInfo.sessionId);
    if (pendingTitle !== undefined) {
      sessionInfo.title = pendingTitle;
      this.pendingTitles.delete(sessionInfo.sessionId);
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

    const prompt: ContentBlock[] = [];

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

    this.inFlightPromptSessions.add(sessionId);
    try {
      const response = await connInfo.connection.prompt({
        sessionId,
        prompt,
      });

      log(`Prompt response: stopReason=${response.stopReason}`);
      return response;
    } finally {
      this.inFlightPromptSessions.delete(sessionId);
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
      await connInfo.connection.prompt({
        sessionId,
        prompt: [{ type: 'text', text: command }],
      });
    } catch (e: any) {
      log(`sendSlashCommand: failed for session ${sessionId}: ${e?.message ?? e}`);
    } finally {
      this.inFlightPromptSessions.delete(sessionId);
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
    const timeoutMs = name === 'compact' ? 180_000 : 30_000;
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
      if (hasCustomTitle && typeof update.title === 'string') {
        // Keep the user's title; ignore the agent's.
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
    this.emit('session-info-changed', sessionId, update);
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

    const configs = getAgentConfigs();
    const config = configs[agentName];
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
   */
  async loadSession(agentName: string, sessionId: string): Promise<SessionInfo> {
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
      agentDisplayName: conn.initResponse.agentInfo?.title || conn.initResponse.agentInfo?.name || agentName,
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
      // The response carries the latest mode/model/configOptions snapshot.
      placeholder.modes = (response as any).modes ?? null;
      placeholder.models = (response as any).models ?? null;
      placeholder.configOptions = (response as any).configOptions ?? null;

      // If the agent didn't return configOptions, probe for them.
      if (!placeholder.configOptions || placeholder.configOptions.length === 0) {
        void this.probeOrSynthesizeConfigOptions(sessionId);
      }
    } catch (e: any) {
      this.loadingSessionIds.delete(sessionId);
      this.sessions.delete(sessionId);
      this.agentSessions.delete(agentName);
      if (this.activeSessionId === sessionId) {
        this.activeSessionId = null;
      }

      // If the agent says the session is gone, prune from local history so
      // it doesn't reappear on next refresh.
      // Check both message and data (Kiro puts "Session not found" in data).
      const msg = String(e?.message || '') + ' ' + String((e as any)?.data || '');
      if (/not found|no such|unknown session/i.test(msg)) {
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
    this.emit('session-load-end', sessionId, agentName, /*ok=*/ true);

    // Touch history-store activity timestamp.
    this.historyStore?.touch(agentName, sessionId);
    // Restore saved config options (mode/model/reasoning_effort).
    await this.restoreConfigOptions(sessionId, agentName);
    return placeholder;
  }

  /**
   * Resume an existing session without replaying history (light path).
   */
  async resumeSession(agentName: string, sessionId: string): Promise<SessionInfo> {
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
        cwd,
        mcpServers: [],
      });
    } catch (e: any) {
      const msg = String(e?.message || '');
      if (/not found|no such|unknown session/i.test(msg)) {
        this.historyStore?.forget(agentName, sessionId);
      }
      throw e;
    }

    const sessionInfo: SessionInfo = {
      sessionId,
      agentId,
      agentName,
      agentDisplayName: conn.initResponse.agentInfo?.title || conn.initResponse.agentInfo?.name || agentName,
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
    this.drainPending(sessionInfo);
    this.agentSessions.set(agentName, sessionId);
    this.activeSessionId = sessionId;
    this.emit('agent-connected', agentName);
    this.emit('active-session-changed', sessionId);

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
      agentDisplayName: conn.initResponse.agentInfo?.title || conn.initResponse.agentInfo?.name || agentName,
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

  dispose(): void {
    this.agentManager.killAll();
    this.connectionManager.dispose();
    this.sessions.clear();
    this.agentSessions.clear();
  }
}

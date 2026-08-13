// Polyfill: zod v4 references `navigator` as a global, but the VS Code
// extension host defines it as a read-only getter that throws
// PendingMigrationError. Override it with a writable value so zod can
// access navigator.userAgent without crashing. This must run before any
// module that transitively imports zod.
try {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  if (desc && desc.get && !desc.set) {
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'node' },
      writable: true,
      configurable: true,
    });
  } else if (typeof (globalThis as any).navigator === 'undefined') {
    (globalThis as any).navigator = { userAgent: 'node' };
  }
} catch {
  // If we can't override, try to define it directly
  try {
    (globalThis as any).navigator = { userAgent: 'node' };
  } catch {}
}

import * as vscode from 'vscode';

import { AgentManager } from './core/AgentManager';
import { ConnectionManager } from './core/ConnectionManager';
import { getAgentConfigs } from './config/AgentConfig';
import { SessionManager } from './core/SessionManager';
import { LocalAgentManager } from './core/LocalAgentManager';
import { NESManager } from './core/NESManager';
import { NESInlineCompletionProvider } from './core/NESInlineCompletionProvider';
import { SessionHistoryStore } from './core/SessionHistoryStore';
import { TerminalOutputStore } from './core/TerminalOutputStore';
import { KiroSessionDiscovery } from './core/KiroSessionDiscovery';
import { SessionUpdateHandler } from './handlers/SessionUpdateHandler';
import { SharedMemoryProvider } from './core/memory/SharedMemoryProvider';
import { describeMemoryConfigSources, isMemoryConfigured, readMemorySettings } from './core/memory/MemoryConfig';
import { SessionTreeProvider } from './ui/SessionTreeProvider';
import { StatusBarManager } from './ui/StatusBarManager';
import { ChatWebviewProvider } from './ui/ChatWebviewProvider';
import { getAgentNames } from './config/AgentConfig';
import { fetchRegistry } from './config/RegistryClient';
import {
  log,
  logError,
  disposeChannels,
  getOutputChannel,
  getTrafficChannel,
  logStderr,
  getStructuredTraffic,
} from './utils/Logger';
import { initTelemetry, sendEvent } from './utils/TelemetryManager';

// Module-level reference so deactivate() can clean up even if
// context.subscriptions disposal was skipped (e.g. VSCode force-quit).
let _sessionManager: SessionManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  log('ACP Client extension activating...');

  // Move to secondary sidebar (right side) on first install
  const movedKey = 'acp.movedToSecondarySidebar';
  if (!context.globalState.get(movedKey)) {
    vscode.commands.executeCommand('workbench.action.moveActivityBarEntryToSecondarySideBar', 'acp-client');
    vscode.commands.executeCommand('workbench.action.alignPanelCenter');
    context.globalState.update(movedKey, true);
  }

  // --- Telemetry ---
  const telemetryReporter = initTelemetry();
  context.subscriptions.push(telemetryReporter);

  // --- Core services ---
  const sessionUpdateHandler = new SessionUpdateHandler();
  const agentManager = new AgentManager();
  // Interleave agent stderr into the ACP Traffic channel so it sits
  // alongside the JSON-RPC frames. Stderr already shows up in `ACP Client`,
  // but having it in `ACP Traffic` is what you usually want when debugging
  // a crashing or misbehaving agent.
  agentManager.on('agent-stderr', ({ agentId, line }) => {
    const inst = agentManager.getAgent(agentId);
    logStderr(inst?.name ?? agentId, line);
  });
  const connectionManager = new ConnectionManager(sessionUpdateHandler);
  const sessionManager = new SessionManager(agentManager, connectionManager, sessionUpdateHandler);
  _sessionManager = sessionManager;

  // --- Local A2A agent management ---
  // When ericli sends `_ericli/a2a/spawn_local`, the IDE spawns a new ACP
  // session (visible chat panel) and routes delegation requests to it.
  const localAgentManager = new LocalAgentManager(
    sessionManager,
    agentManager,
    connectionManager,
    sessionUpdateHandler,
  );
  sessionManager.setLocalAgentManager(localAgentManager);

  // --- NES (Next Edit Suggestions) ---
  // NES is an experimental ACP feature. codex-acp does NOT currently support
  // it; NESManager.start() will log a warning and return false in that case.
  const nesManager = new NESManager();

  // Persistent client-side session-history cache (used as the tier-2 tree
  // source for agents that support session/load or session/resume but not
  // session/list).
  const historyStore = new SessionHistoryStore(context.workspaceState);
  sessionManager.setHistoryStore(historyStore);

  // --- Shared memory (TencentDB Agent Memory, Model B) ---
  // team_id shared across agents; agent_id mapped per ACP agent type.
  const memoryProvider = new SharedMemoryProvider(sessionUpdateHandler);
  sessionManager.setMemoryProvider(memoryProvider);
  context.subscriptions.push({ dispose: () => memoryProvider.dispose() });
  {
    const logMemoryStatus = (reason: string): string => {
      const mem = readMemorySettings();
      const summary = isMemoryConfigured(mem)
        ? `enabled endpoint=${mem.endpoint} team=${mem.teamId} service=${mem.serviceId} ` +
          `user=${mem.userId} recall=${mem.recallMaxResults}`
        : 'idle — acp.memory.* not fully configured (recall/capture disabled)';
      log(`SharedMemoryProvider [${reason}]: ${summary}`);
      for (const line of describeMemoryConfigSources()) {
        log(`SharedMemoryProvider [${reason}]:   ${line}`);
      }
      return summary;
    };
    logMemoryStatus('activate');
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('acp.memory')) {
          logMemoryStatus('settings changed');
        }
      }),
    );
    context.subscriptions.push(
      vscode.commands.registerCommand('acp.showMemoryStatus', () => {
        const summary = logMemoryStatus('command');
        getOutputChannel().show(true);
        vscode.window.showInformationMessage(`ACP shared memory: ${summary}`);
      }),
    );
  }

  // --- Kiro session discovery ---
  // Reads ~/.kiro/sessions/ to surface CLI-spawned sessions in the tree.
  // Kiro CLI does not implement ACP session/list, so without this the only
  // sessions visible are those created from within VS Code.
  const kiroDiscovery = new KiroSessionDiscovery();
  if (kiroDiscovery.isAvailable()) {
    log(`KiroSessionDiscovery: using Kiro home at ${kiroDiscovery.getKiroHome()}`);
  }
  context.subscriptions.push({ dispose: () => kiroDiscovery.removeAllListeners() });
  context.subscriptions.push({ dispose: () => historyStore.dispose() });

  // Seed the last-connected agent from the history store so the webview can
  // offer "Resume <agent>" on the very first restart. Only the
  // SessionHistoryStore is used because it is workspace-scoped (filters
  // by cwd). Global on-disk sessions belong to other workspaces and
  // should not seed the resume button on a new project.
  //
  // Also validate any existing workspaceState value — if the stored
  // session does not exist in the history store for this workspace,
  // clear it so a stale value from another workspace doesn't show a
  // bogus "Resume" button.
  if (!context.workspaceState.get('acp.lastConnectedAgent')) {
    const agentNames = getAgentNames();
    let best: { agent: string; sessionId: string; lastActiveAt: string } | undefined;

    // 1. History store
    for (const name of agentNames) {
      const entries = historyStore.list(name);
      if (entries.length > 0) {
        const top = entries[0];
        if (!best || (top.lastActiveAt || '') > best.lastActiveAt) {
          best = { agent: name, sessionId: top.sessionId, lastActiveAt: top.lastActiveAt || '' };
        }
      }
    }

    if (best) {
      context.workspaceState.update('acp.lastConnectedAgent', best.agent);
      context.workspaceState.update('acp.lastConnectedAgentDisplay', best.agent);
      context.workspaceState.update('acp.lastConnectedSessionId', best.sessionId);
      log(`Seeded last agent from disk: ${best.agent} (session ${best.sessionId})`);
    } else {
      log('No sessions found in history for seeding');
    }
  } else {
    // Validate the existing workspaceState value — make sure the stored
    // agent has at least one session in the history store for THIS workspace.
    // If not, clear it (stale value from old seeding or another workspace).
    const storedAgent = context.workspaceState.get<string>('acp.lastConnectedAgent');
    let hasHistory = false;
    if (storedAgent) {
      for (const name of getAgentNames()) {
        if (historyStore.list(name).length > 0) {
          hasHistory = true;
          break;
        }
      }
    }
    if (!hasHistory) {
      log(`Clearing stale lastConnectedAgent '${storedAgent}' — no sessions in history for this workspace`);
      context.workspaceState.update('acp.lastConnectedAgent', undefined);
      context.workspaceState.update('acp.lastConnectedAgentDisplay', undefined);
      context.workspaceState.update('acp.lastConnectedSessionId', undefined);
    }
  }

  // --- UI ---
  const workspaceCwd = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const sessionTreeProvider = new SessionTreeProvider(
    sessionManager,
    historyStore,
    workspaceCwd,
    context.extensionUri,
    kiroDiscovery,
  );
  const treeView = vscode.window.createTreeView('acp-sessions', {
    treeDataProvider: sessionTreeProvider,
  });

  // Persists oversize @terminal output to a file (instead of inlining tens of
  // thousands of chars into the prompt) and reaps stale files so they don't
  // accumulate across sessions. Created once; the preview+pointer is injected
  // into the terminal resource block at prompt-build time.
  const terminalOutputStore = new TerminalOutputStore(context.globalStorageUri.fsPath);
  terminalOutputStore.reapStale(); // clean up on activation

  const chatWebviewProvider = new ChatWebviewProvider(
    context.extensionUri,
    sessionManager,
    sessionUpdateHandler,
    context.workspaceState,
    terminalOutputStore,
  );
  const chatViewRegistration = vscode.window.registerWebviewViewProvider(
    ChatWebviewProvider.viewType,
    chatWebviewProvider,
    { webviewOptions: { retainContextWhenHidden: true } },
  );

  const statusBarManager = new StatusBarManager(sessionManager);

  // --- NES Inline Completion Provider ---
  // Registers with VS Code's inline completion API. NESManager.start()
  // is called when an agent connects; if the agent doesn't support NES,
  // it logs a warning and no-op.
  const nesProvider = new NESInlineCompletionProvider(nesManager);
  const nesRegistration = vscode.languages.registerInlineCompletionItemProvider({ scheme: 'file' }, nesProvider);
  const nesAcceptCmd = vscode.commands.registerCommand('acp.nesAccept', (id: string) => {
    nesManager.accept(id);
  });
  const nesRejectCmd = vscode.commands.registerCommand('acp.nesReject', (id: string) => {
    nesManager.reject(id, 'rejected');
  });

  // Start NES when an agent connects (if supported)
  sessionManager.on('active-session-changed', () => {
    const session = sessionManager.getActiveSession();
    if (session) {
      const connInfo = connectionManager.getConnection(session.agentId);
      if (connInfo) {
        void nesManager.start(connInfo.connection);
      }
    } else {
      nesProvider.reset();
      nesManager.stop();
    }
  });

  // Notify chat webview when active session changes
  sessionManager.on('active-session-changed', () => {
    // Persist the last connected agent so the webview can offer "Resume"
    // on the next restart (workspaceState survives across restarts).
    const session = sessionManager.getActiveSession();
    if (session) {
      context.workspaceState.update('acp.lastConnectedAgent', session.agentName);
      context.workspaceState.update('acp.lastConnectedAgentDisplay', session.agentDisplayName || session.agentName);
      context.workspaceState.update('acp.lastConnectedSessionId', session.sessionId);
    }
    chatWebviewProvider.notifyActiveSessionChanged();
  });

  // Clear chat when new conversation is started
  sessionManager.on('clear-chat', () => {
    chatWebviewProvider.clearChat(false);
  });

  // Forward mode/model changes to webview
  sessionManager.on('mode-changed', (_sessionId: string, _modeId: string) => {
    const session = sessionManager.getActiveSession();
    if (session?.modes) {
      chatWebviewProvider.notifyModesUpdate(session.modes);
    }
  });

  sessionManager.on('model-changed', (_sessionId: string, _modelId: string) => {
    const session = sessionManager.getActiveSession();
    if (session?.models) {
      chatWebviewProvider.notifyModelsUpdate(session.models);
    }
  });

  // Forward config-option changes to webview (covers model, mode, thought_level, etc.)
  sessionManager.on('config-options-changed', (_sessionId: string, _options: any) => {
    const session = sessionManager.getActiveSession();
    if (session?.configOptions) {
      chatWebviewProvider.notifyConfigOptionsUpdate(session.configOptions);
    }
  });

  // Forward _kiro.dev/metadata notifications to webview (Kiro CLI context usage %, effort)
  sessionManager.on('kiro-metadata', (params: any) => {
    chatWebviewProvider.notifyKiroMetadata(params);
  });

  // Forward _kiro.dev/subagent/list_update to webview (Kiro CLI subagent crew live status)
  sessionManager.on('kiro-subagent-list-update', (params: any) => {
    chatWebviewProvider.notifyKiroSubagentListUpdate(params);
  });

  // Forward Kiro slash-command catalog updates (merged into availableCommands)
  sessionManager.on('available-commands-changed', (sessionId: string, commands: any) => {
    if (sessionId !== sessionManager.getActiveSessionId()) {
      return;
    }
    chatWebviewProvider.notifyAvailableCommands(commands);
  });

  // Forward _kiro.dev/compaction/status (context compaction progress)
  sessionManager.on('kiro-compaction-status', (params: any) => {
    chatWebviewProvider.notifyKiroCompactionStatus(params);
  });

  // Forward _kiro.dev/clear/status (session history clear progress)
  sessionManager.on('kiro-clear-status', (params: any) => {
    chatWebviewProvider.notifyKiroClearStatus(params);
  });

  // Forward _kiro.dev/goal/status (Kiro CLI goal lifecycle)
  sessionManager.on('kiro-goal-status', (params: any) => {
    chatWebviewProvider.notifyKiroGoalStatus(params);
  });

  // Forward _session/terminate (subagent session ended)
  sessionManager.on('session-terminate', (params: any) => {
    chatWebviewProvider.notifySessionTerminate(params);
  });

  // Cursor ACP extensions (cursor/task subagents, todos, ask/plan)
  sessionManager.on('cursor-task', (params: any) => {
    chatWebviewProvider.notifyCursorTask(params);
  });
  sessionManager.on('cursor-update-todos', (params: any) => {
    chatWebviewProvider.notifyCursorUpdateTodos(params);
  });
  sessionManager.on('cursor-generate-image', (params: any) => {
    chatWebviewProvider.notifyCursorGenerateImage(params);
  });
  sessionManager.on('cursor-ask-question', async (params: any, respond: (result: any) => void) => {
    try {
      const questions: any[] = Array.isArray(params?.questions) ? params.questions : [];
      const answers: Array<{ questionId: string; selectedOptionIds: string[] }> = [];
      for (const q of questions) {
        const options: Array<{ id: string; label: string }> = Array.isArray(q?.options) ? q.options : [];
        const items = options.map((o) => ({ label: o.label || o.id, id: o.id }));
        if (items.length === 0) {
          continue;
        }
        const picked = await vscode.window.showQuickPick(items, {
          title: params?.title || 'Cursor agent question',
          placeHolder: q.prompt || 'Select an option',
          canPickMany: !!q.allowMultiple,
          ignoreFocusOut: true,
        });
        if (!picked) {
          respond({ outcome: { outcome: 'cancelled' } });
          return;
        }
        const selected = Array.isArray(picked) ? picked : [picked];
        answers.push({
          questionId: String(q.id),
          selectedOptionIds: selected.map((s: any) => String(s.id)),
        });
      }
      respond({ outcome: { outcome: 'answered', answers } });
    } catch (e: any) {
      respond({ outcome: { outcome: 'skipped', reason: e?.message || 'ask_question failed' } });
    }
  });
  sessionManager.on('cursor-create-plan', async (params: any, respond: (result: any) => void) => {
    try {
      const name = params?.name ? String(params.name) : 'Plan';
      const overview = params?.overview ? String(params.overview) : '';
      const choice = await vscode.window.showInformationMessage(
        overview ? `${name}: ${overview}` : `Approve plan: ${name}?`,
        { modal: true },
        'Accept',
        'Reject',
      );
      if (choice === 'Accept') {
        respond({ outcome: { outcome: 'accepted' } });
        chatWebviewProvider.notifyCursorCreatePlan(params);
      } else if (choice === 'Reject') {
        respond({ outcome: { outcome: 'rejected', reason: 'User rejected' } });
      } else {
        respond({ outcome: { outcome: 'cancelled' } });
      }
    } catch {
      respond({ outcome: { outcome: 'cancelled' } });
    }
  });

  // Session-load replay state — drive the webview overlay.
  sessionManager.on('session-load-start', () => {
    chatWebviewProvider.notifyLoadSessionStart();
  });
  sessionManager.on('session-load-end', (_sessionId: string, _agentName: string, ok: boolean) => {
    chatWebviewProvider.notifyLoadSessionEnd(ok);
    if (ok) {
      // The loadSession response carries modes/models/configOptions for the
      // restored session. Re-send the state so the pickers pick them up
      // (the original `active-session-changed` was emitted before the RPC
      // resolved, when those fields were still null).
      chatWebviewProvider.notifyActiveSessionChanged();
    }
  });

  // Session metadata (title) update — forward to chat banner.
  sessionManager.on('session-info-changed', (sessionId: string, update: any) => {
    if (sessionId !== sessionManager.getActiveSessionId()) {
      return;
    }
    chatWebviewProvider.notifySessionInfoUpdate(update?.title);
  });

  // --- Commands ---

  // Connect to Agent (primary action — inline icon in tree or pick from list)
  const connectAgentCmd = vscode.commands.registerCommand(
    'acp.connectAgent',
    async (agentNameOrItem?: string | any) => {
      // Handle tree item object or string
      let agentName: string | undefined;
      let sessionId: string | undefined;
      if (typeof agentNameOrItem === 'string') {
        agentName = agentNameOrItem;
      } else if (agentNameOrItem?.agentName) {
        agentName = agentNameOrItem.agentName;
        // Restored-session reconnect: the webview passes both agentName
        // and sessionId so we can load the previous session after connecting.
        if (typeof agentNameOrItem.sessionId === 'string') {
          sessionId = agentNameOrItem.sessionId;
        }
      }

      if (!agentName) {
        const agentNames = getAgentNames();
        if (agentNames.length === 0) {
          vscode.window.showWarningMessage('No ACP agents configured. Add agents in Settings > ACP > Agents.');
          return;
        }
        agentName = await vscode.window.showQuickPick(agentNames, {
          placeHolder: 'Select an agent to connect',
          title: 'Connect to Agent',
        });
        if (!agentName) {
          return;
        }
      }

      // If switching agents and there's chat content, confirm
      const currentAgent = sessionManager.getActiveAgentName();
      if (currentAgent && currentAgent !== agentName && chatWebviewProvider.hasChatContent) {
        const choice = await vscode.window.showWarningMessage(
          `Switch to ${agentName}? This will disconnect ${currentAgent} and clear the chat history.`,
          'Switch Agent',
          'Cancel',
        );
        if (choice !== 'Switch Agent') {
          return;
        }
        chatWebviewProvider.clearChat(false);
      }

      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: sessionId ? `Restoring ${agentName} session...` : `Connecting to ${agentName}...`,
            cancellable: false,
          },
          async () => {
            await sessionManager.connectToAgent(agentName!);
            // If we have a previous session ID and the agent supports
            // session/load, restore the session history.
            if (sessionId) {
              const caps = sessionManager.getCachedCapabilities(agentName!);
              if (caps?.load) {
                try {
                  await sessionManager.loadSession(agentName!, sessionId);
                } catch (e: any) {
                  // Session may have expired or been deleted — not fatal.
                  // The user gets a fresh session with the same agent.
                  log(`Failed to restore session ${sessionId}: ${e?.message || e}`);
                }
              }
            }
          },
        );
      } catch (e: any) {
        logError('Failed to connect to agent', e);
        vscode.window.showErrorMessage(`Failed to connect: ${e.message}`);
      }
    },
  );

  // New Conversation (disconnect + clear chat + reconnect same agent)
  const newConversationCmd = vscode.commands.registerCommand('acp.newConversation', async () => {
    // If multiple agents are configured, offer a choice: new session with
    // the current agent, or switch to a different agent.
    const agentNames = getAgentNames();
    if (agentNames.length > 1) {
      const activeSession = sessionManager.getActiveSession();
      // Use agentName (config key, e.g. "codex") for filtering — agentNames
      // are config keys, not display names. Using agentDisplayName here would
      // fail to filter out the current agent ("Codex CLI" !== "codex").
      const currentAgentKey = activeSession?.agentName;
      const currentAgent = activeSession?.agentDisplayName || currentAgentKey;
      const otherAgents = agentNames.filter((n) => n !== currentAgentKey);
      const items: (vscode.QuickPickItem & { action?: 'same' | 'switch'; agentName?: string })[] = [];
      if (currentAgent) {
        items.push({
          label: `$(add) New ${currentAgent} Session`,
          description: 'Start fresh with the same agent',
          action: 'same',
        });
      }
      for (const name of otherAgents) {
        items.push({
          label: `$(plug) Switch to ${name}`,
          description: 'New session with a different agent',
          action: 'switch',
          agentName: name,
        });
      }
      const choice = await vscode.window.showQuickPick(items, {
        placeHolder: 'Start a new session',
        title: 'New Session',
      });
      if (!choice) {
        return;
      }
      if (choice.action === 'switch' && choice.agentName) {
        // Switch to a different agent — disconnect current, connect new
        if (activeSession && chatWebviewProvider.hasChatContent) {
          const confirm = await vscode.window.showWarningMessage(
            `Switch to ${choice.agentName}? This will disconnect ${currentAgent} and clear the chat history.`,
            'Switch Agent',
            'Cancel',
          );
          if (confirm !== 'Switch Agent') {
            return;
          }
        }
        chatWebviewProvider.clearChat(false);
        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Connecting to ${choice.agentName}...`,
              cancellable: false,
            },
            async () => {
              await sessionManager.connectToAgent(choice.agentName!);
            },
          );
        } catch (e: any) {
          logError('Failed to connect to agent', e);
          vscode.window.showErrorMessage(`Failed to connect: ${e.message}`);
        }
        return;
      }
      // action === 'same' — fall through to the normal newConversation logic below
    }

    const activeSession = sessionManager.getActiveSession();
    if (!activeSession) {
      // No active agent — connect to the last-used agent WITHOUT
      // restoring the previous session (this is a "new conversation").
      const lastAgent = context.workspaceState.get<string>('acp.lastConnectedAgent');
      if (lastAgent) {
        // Temporarily clear lastConnectedSessionId so connectAgent
        // doesn't auto-load the old session history.
        const savedSessionId = context.workspaceState.get<string>('acp.lastConnectedSessionId');
        context.workspaceState.update('acp.lastConnectedSessionId', undefined);
        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Starting new conversation with ${lastAgent}...`,
              cancellable: false,
            },
            async () => {
              chatWebviewProvider.clearChat(false);
              await sessionManager.connectToAgent(lastAgent);
            },
          );
        } finally {
          // Restore the saved session ID (the new session will update
          // workspaceState via active-session-changed).
          context.workspaceState.update('acp.lastConnectedSessionId', savedSessionId);
        }
      } else {
        // No last agent — fall back to the agent picker.
        await vscode.commands.executeCommand('acp.connectAgent');
      }
      return;
    }

    // Confirm if there's existing chat content
    if (chatWebviewProvider.hasChatContent) {
      const choice = await vscode.window.showWarningMessage(
        'Start a new conversation? This will clear the current chat history.',
        'New Conversation',
        'Cancel',
      );
      if (choice !== 'New Conversation') {
        return;
      }
    }

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Starting new conversation with ${activeSession.agentDisplayName}...`,
          cancellable: false,
        },
        async () => {
          // Suppress intermediate active-session-changed(null) during
          // disconnect+reconnect — otherwise the webview briefly shows
          // "🔄 Resume <agent>" before the new session is ready.
          chatWebviewProvider.suppressWebviewUpdates = true;
          try {
            await sessionManager.newConversation();
          } finally {
            chatWebviewProvider.suppressWebviewUpdates = false;
            chatWebviewProvider.notifyActiveSessionChanged();
          }
        },
      );
    } catch (e: any) {
      logError('Failed to start new conversation', e);
      vscode.window.showErrorMessage(`Failed to start new conversation: ${e.message}`);
    }
  });

  // Disconnect Agent
  const disconnectAgentCmd = vscode.commands.registerCommand('acp.disconnectAgent', async (item?: any) => {
    const agentName = item?.agentName || sessionManager.getActiveAgentName();
    if (!agentName) {
      vscode.window.showInformationMessage('No agent connected.');
      return;
    }
    await sessionManager.disconnectAgent(agentName);
    vscode.window.showInformationMessage(`Disconnected from ${agentName}.`);
  });

  // Open Chat
  const openChatCmd = vscode.commands.registerCommand('acp.openChat', () => {
    vscode.commands.executeCommand('acp-chat.focus');
  });

  // Send Prompt (from keybinding — just focus chat)
  const sendPromptCmd = vscode.commands.registerCommand('acp.sendPrompt', async () => {
    vscode.commands.executeCommand('acp-chat.focus');
  });

  // Cancel Turn
  const cancelTurnCmd = vscode.commands.registerCommand('acp.cancelTurn', async () => {
    const activeId = sessionManager.getActiveSessionId();
    if (activeId) {
      try {
        await sessionManager.cancelTurn(activeId);
      } catch (e) {
        logError('Cancel failed', e);
      }
    }
  });

  // Toggle Follow Agent — when on, the editor auto-opens whichever file the
  // agent's tool calls advertise via `locations`. Mirrors Zed's `dev::Follow`
  // / `workspace.follow(CollaboratorId::Agent)` (zed-industries/zed::
  // crates/agent_ui/src/conversation_view/thread_view.rs).
  const toggleFollowAgentCmd = vscode.commands.registerCommand('acp.toggleFollowAgent', () => {
    chatWebviewProvider.toggleFollow();
  });

  // Restart Agent
  const restartAgentCmd = vscode.commands.registerCommand('acp.restartAgent', async () => {
    const activeSession = sessionManager.getActiveSession();
    if (!activeSession) {
      return;
    }

    const agentName = activeSession.agentName;
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Restarting ${activeSession.agentDisplayName}...`,
          cancellable: false,
        },
        async () => {
          await sessionManager.disconnectAgent(agentName);
          await sessionManager.connectToAgent(agentName);
        },
      );
      vscode.window.showInformationMessage(`Restarted ${agentName}`);
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to restart: ${e.message}`);
    }
  });

  // Show Log
  const showLogCmd = vscode.commands.registerCommand('acp.showLog', () => {
    sendEvent('command/showLog');
    getOutputChannel().show();
  });

  // Show Traffic
  const showTrafficCmd = vscode.commands.registerCommand('acp.showTraffic', () => {
    sendEvent('command/showTraffic');
    getTrafficChannel().show();
  });

  // Export the structured in-memory traffic ring buffer to a JSON file.
  // Mirrors Zed's `serialize_observed_messages` in
  // `crates/acp_tools/src/acp_tools.rs`. Useful for bug reports — captures
  // the last ~2000 frames in parsed form (incl. request↔response method
  // matching and stderr lines).
  const exportTrafficCmd = vscode.commands.registerCommand('acp.exportTraffic', async () => {
    sendEvent('command/exportTraffic');
    const entries = getStructuredTraffic();
    if (entries.length === 0) {
      vscode.window.showInformationMessage('ACP: traffic ring buffer is empty — nothing to export.');
      return;
    }
    const defaultName = `acp-traffic-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const defaultUri = vscode.workspace.workspaceFolders?.[0]?.uri
      ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, defaultName)
      : vscode.Uri.file(defaultName);
    const target = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { JSON: ['json'] },
      saveLabel: 'Export ACP Traffic',
      title: 'Export ACP Protocol Traffic',
    });
    if (!target) {
      return;
    }
    try {
      const json = JSON.stringify(entries, null, 2);
      await vscode.workspace.fs.writeFile(target, Buffer.from(json, 'utf8'));
      vscode.window.showInformationMessage(`ACP traffic exported (${entries.length} entries) → ${target.fsPath}`);
    } catch (e: any) {
      logError('exportTraffic: write failed', e);
      vscode.window.showErrorMessage(`ACP export failed: ${e.message}`);
    }
  });

  // Set Mode
  const setModeCmd = vscode.commands.registerCommand('acp.setMode', async (modeId?: string) => {
    const activeId = sessionManager.getActiveSessionId();
    if (!activeId) {
      return;
    }

    if (!modeId) {
      modeId =
        (await vscode.window.showInputBox({
          placeHolder: 'Enter mode ID (e.g., "plan", "code")',
          title: 'Set Agent Mode',
        })) || undefined;
    }
    if (modeId) {
      try {
        await sessionManager.setMode(activeId, modeId);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to set mode: ${e.message}`);
      }
    }
  });

  // Set Model
  const setModelCmd = vscode.commands.registerCommand('acp.setModel', async (modelId?: string) => {
    const activeId = sessionManager.getActiveSessionId();
    if (!activeId) {
      return;
    }

    if (!modelId) {
      modelId =
        (await vscode.window.showInputBox({
          placeHolder: 'Enter model ID',
          title: 'Set Agent Model',
        })) || undefined;
    }
    if (modelId) {
      try {
        await sessionManager.setModel(activeId, modelId);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to set model: ${e.message}`);
      }
    }
  });

  // Refresh Agents tree
  const refreshAgentsCmd = vscode.commands.registerCommand('acp.refreshAgents', () => {
    sessionTreeProvider.refresh();
  });

  // Refresh sessions for an agent (or all agents). Invalidates the cached
  // session-list state so the next expansion re-runs `session/list`.
  const refreshSessionsCmd = vscode.commands.registerCommand('acp.refreshSessions', (arg?: any) => {
    const agentName = typeof arg === 'string' ? arg : arg?.agentName;
    sessionTreeProvider.invalidate(agentName);
    // Also refresh Kiro disk discovery cache so newly-created CLI sessions appear.
    kiroDiscovery.refresh();
  });

  // Open (load or resume) a previously-existing session.
  const openSessionCmd = vscode.commands.registerCommand('acp.openSession', async (arg?: any) => {
    const agentName: string | undefined = arg?.agentName;
    const sessionId: string | undefined = arg?.sessionId;
    if (!agentName || !sessionId) {
      vscode.window.showErrorMessage('Open Session: missing agentName/sessionId.');
      return;
    }

    // No-op if it is already the active session.
    if (sessionManager.getActiveSessionId() === sessionId) {
      vscode.commands.executeCommand('acp-chat.focus');
      return;
    }

    // Confirm if there's existing chat content with a different active session.
    if (chatWebviewProvider.hasChatContent) {
      const choice = await vscode.window.showWarningMessage(
        'Open a different session? This will replace the current chat history.',
        'Open Session',
        'Cancel',
      );
      if (choice !== 'Open Session') {
        return;
      }
    }

    try {
      await vscode.commands.executeCommand('acp-chat.focus');
      // Decide load vs resume based on capabilities. Prefer load (replays
      // history) for the richer experience.
      const caps = sessionManager.getCachedCapabilities(agentName);
      if (caps?.load) {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Loading session…`,
            cancellable: false,
          },
          async () => {
            await sessionManager.loadSession(agentName, sessionId);
          },
        );
      } else if (caps?.resume) {
        await sessionManager.resumeSession(agentName, sessionId);
        vscode.window.showInformationMessage('Resumed session (history not replayed).');
      } else {
        vscode.window.showErrorMessage(`Agent "${agentName}" does not support loading or resuming sessions.`);
      }
    } catch (e: any) {
      logError('Failed to open session', e);
      // Stringify error data properly — e.data can be an object like
      // {details: "thread xxx already has an active writer"}, which would
      // otherwise show as "[object Object]".
      const errDataStr = typeof e?.data === 'string'
        ? e.data
        : e?.data && typeof e?.data === 'object'
          ? JSON.stringify(e.data)
          : e?.data ? String(e.data) : '';
      const errDetail = errDataStr ? `${e?.message || 'Error'}: ${errDataStr}` : e?.message || 'Unknown error';
      const combinedMsg = `${e?.message || ''} ${errDataStr}`;

      // Kiro enforces a single owner per session: a terminal `kiro-cli chat`
      // (or another VS Code window) already holds this session, and its ACP
      // server refuses a session/load from this process. Show a clear,
      // actionable message instead of the raw "Internal error" toast, and
      // offer to open a fresh session in this window instead.
      const activeInAnother = /active in another process \(PID (\d+)\)/i.exec(combinedMsg);
      if (activeInAnother) {
        const pid = activeInAnother[1];
        const choice = await vscode.window.showErrorMessage(
          `Session is already open in another process (PID ${pid}) — close it there, or start a fresh session here.`,
          'Start New Session Here',
        );
        if (choice === 'Start New Session Here') {
          try {
            await vscode.commands.executeCommand('acp.newConversation');
          } catch (innerErr: any) {
            vscode.window.showErrorMessage(`Failed to start new session: ${innerErr?.message || innerErr}`);
          }
        }
        return;
      }

      // Codex: thread is actively streaming (has an active writer). The
      // session can't be loaded until the current turn finishes. Show a
      // clear message and offer to retry.
      const activeWriter = /already has an active writer/i.exec(combinedMsg);
      if (activeWriter) {
        const choice = await vscode.window.showErrorMessage(
          `Session is actively streaming. Wait for the current turn to finish, then retry.`,
          'Retry Now',
          'Start New Session',
        );
        if (choice === 'Retry Now') {
          try {
            await vscode.commands.executeCommand('acp.openSession', { sessionId: params?.sessionId, agentName: params?.agentName });
          } catch (innerErr: any) {
            vscode.window.showErrorMessage(`Retry failed: ${innerErr?.message || innerErr}`);
          }
        } else if (choice === 'Start New Session') {
          try {
            await vscode.commands.executeCommand('acp.newConversation');
          } catch (innerErr: any) {
            vscode.window.showErrorMessage(`Failed to start new session: ${innerErr?.message || innerErr}`);
          }
        }
        return;
      }

      vscode.window.showErrorMessage(`Failed to open session: ${errDetail}`);
    }
  });

  // Open a local A2A agent session — loads history WITHOUT switching the
  // active session / disconnecting the parent agent. The local A2A agent
  // runs in its own subprocess; clicking it in the tree should show its
  // conversation history in a read-only view (or switch focus).
  const openLocalAgentSessionCmd = vscode.commands.registerCommand('acp.openLocalAgentSession', async (arg?: any) => {
    const agentName: string | undefined = arg?.agentName;
    const sessionId: string | undefined = arg?.sessionId;
    if (!agentName || !sessionId) {
      return;
    }
    try {
      await vscode.commands.executeCommand('acp-chat.focus');

      // Check if the local A2A agent is dead (process exited). If so,
      // respawn it before loading the session — otherwise loadSession →
      // ensureConnected throws "Unknown agent" because the process is gone
      // and there's no config for dynamically-spawned agents.
      const localAgentMgr = sessionManager.getLocalAgentManager();
      if (localAgentMgr) {
        const localAgent = localAgentMgr.findByAgentName(agentName);
        if (localAgent && localAgent.state === 'dead') {
          log(`openLocalAgentSession: agent '${agentName}' is dead, respawning...`);
          const respawn = await localAgentMgr.respawnDeadAgent(agentName);
          if (!respawn.success) {
            vscode.window.showErrorMessage(
              `Failed to respawn agent '${agentName}': ${respawn.error || 'Unknown error'}`,
            );
            return;
          }
          // The respawned agent has a new session ID — load that instead
          // of the stale one from the tree item.
          if (respawn.sessionId) {
            await sessionManager.loadSession(agentName, respawn.sessionId);
            return;
          }
        }
      }

      // Load the session on the SPAWNED agent's connection.
      // We call loadSession directly — the spawned agent is already
      // connected (registered via registerExternalSession), so
      // ensureConnected will find its connection without spawning a
      // new process. We DO NOT disconnect the parent agent.
      await sessionManager.loadSession(agentName, sessionId);
    } catch (e: any) {
      logError('Failed to open local agent session', e);
      vscode.window.showErrorMessage(`Failed to load local agent session: ${e?.message || 'Unknown error'}`);
    }
  });

  // Pagination cursor: append the next page to the agent-sourced list.
  const loadMoreSessionsCmd = vscode.commands.registerCommand('acp.loadMoreSessions', async (agentName?: string) => {
    if (!agentName) {
      return;
    }
    await sessionTreeProvider.loadMore(agentName);
  });

  // Copy session ID to clipboard (right-click on a session tree item).
  const copySessionIdCmd = vscode.commands.registerCommand('acp.copySessionId', async (arg?: any) => {
    const sessionId = arg?.sessionId;
    if (!sessionId) {
      return;
    }
    await vscode.env.clipboard.writeText(sessionId);
    vscode.window.showInformationMessage(`Copied session ID: ${sessionId}`);
  });

  // Forget a single locally-cached session (right-click on a local session).
  const forgetSessionCmd = vscode.commands.registerCommand('acp.forgetSession', async (arg?: any) => {
    const agentName = arg?.agentName;
    const sessionId = arg?.sessionId;
    if (!agentName || !sessionId) {
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Forget session from local history? This removes it from the sidebar list.`,
      { modal: true },
      'Forget',
    );
    if (confirm !== 'Forget') {
      return;
    }
    sessionTreeProvider.removeSession(agentName, sessionId);
  });

  // Delete Session (ACP session/delete — removes from agent-side history)
  const deleteSessionCmd = vscode.commands.registerCommand('acp.deleteSession', async (arg?: any) => {
    const agentName = arg?.agentName;
    const sessionId = arg?.sessionId;
    if (!agentName || !sessionId) {
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `Delete session "${sessionId}" from the agent's history? This cannot be undone.`,
      { modal: true },
      'Delete',
    );
    if (confirm !== 'Delete') {
      return;
    }

    try {
      await sessionManager.deleteSession(agentName, sessionId);
      vscode.window.setStatusBarMessage(`Session deleted from ${agentName}.`, 5000);
      sessionTreeProvider.removeSession(agentName, sessionId);
      // If the deleted session was the active one, clear the chat so
      // the user doesn't try to prompt a deleted session.
      const activeId = sessionManager.getActiveSessionId();
      if (activeId === sessionId) {
        // Clear stale workspaceState so the webview welcome button does not
        // offer "Resume <agent>" for the session we just deleted.
        context.workspaceState.update('acp.lastConnectedAgent', undefined);
        context.workspaceState.update('acp.lastConnectedAgentDisplay', undefined);
        context.workspaceState.update('acp.lastConnectedSessionId', undefined);
        await sessionManager.clearActiveSession();
        chatWebviewProvider.clearChat();
      }
    } catch (e: any) {
      // Agent-side delete failed (e.g. "no rollout found"). Fall back to local-only removal.
      log(`deleteSession: agent-side delete failed, falling back to local-only: ${e?.message || e}`);
      sessionTreeProvider.removeSession(agentName, sessionId);
      // Also clear chat if this was the active session.
      const activeId = sessionManager.getActiveSessionId();
      if (activeId === sessionId) {
        context.workspaceState.update('acp.lastConnectedAgent', undefined);
        context.workspaceState.update('acp.lastConnectedAgentDisplay', undefined);
        context.workspaceState.update('acp.lastConnectedSessionId', undefined);
        await sessionManager.clearActiveSession();
        chatWebviewProvider.clearChat();
      }
      vscode.window.showWarningMessage(
        `The agent could not delete session "${sessionId}" (it may no longer exist on the agent side). ` +
          `It has been removed from the local history list.`,
      );
    }
  });

  // Logout (ACP logout — terminates authenticated session)
  const logoutCmd = vscode.commands.registerCommand('acp.logout', async (item?: any) => {
    const agentName = item?.agentName || sessionManager.getActiveAgentName();
    if (!agentName) {
      vscode.window.showInformationMessage('No agent connected.');
      return;
    }
    try {
      await sessionManager.logout(agentName);
      vscode.window.showInformationMessage(`Logged out from ${agentName}.`);
    } catch (e: any) {
      vscode.window.showErrorMessage(`Logout failed: ${e?.message || e}`);
    }
  });

  // Fork Session (ACP session/fork — experimental, branches a conversation)
  const forkSessionCmd = vscode.commands.registerCommand('acp.forkSession', async (arg?: any) => {
    const agentName = arg?.agentName || sessionManager.getActiveAgentName();
    const sessionId = arg?.sessionId || sessionManager.getActiveSession()?.sessionId;
    if (!agentName || !sessionId) {
      vscode.window.showInformationMessage('No active session to fork.');
      return;
    }
    try {
      await sessionManager.forkSession(agentName, sessionId);
      // After forking, load the forked session's history into the chat view
      // so the user sees the branched conversation immediately.
      const forkedId = sessionManager.getActiveSessionId();
      if (forkedId && forkedId !== sessionId) {
        const caps = sessionManager.getCachedCapabilities(agentName);
        if (caps?.load) {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Loading forked session…', cancellable: false },
            async () => {
              await sessionManager.loadSession(agentName, forkedId);
            },
          );
        }
      }
      vscode.window.showInformationMessage(`Forked session from ${agentName}.`);
    } catch (e: any) {
      vscode.window.showWarningMessage(`Fork not available: ${e?.message || e}`);
    }
  });

  // Fork to Another Agent — takes the current conversation and continues it
  // in a different agent. Unlike acp.forkSession (same-agent fork via ACP
  // session/fork), this creates a NEW session in a DIFFERENT agent and sends
  // the conversation history as the first prompt.
  const forkToAgentCmd = vscode.commands.registerCommand('acp.forkToAgent', async (arg?: any) => {
    const sourceAgentName = arg?.agentName || sessionManager.getActiveAgentName();
    const sessionId = arg?.sessionId || sessionManager.getActiveSession()?.sessionId;
    if (!sourceAgentName || !sessionId) {
      vscode.window.showInformationMessage('No active session to fork.');
      return;
    }

    // Get available agents (exclude the source agent)
    const configs = getAgentConfigs();
    const otherAgents = Object.entries(configs)
      .filter(([name]) => name !== sourceAgentName)
      .map(([name, cfg]) => ({
        label: cfg.displayName || name,
        description: name,
        detail: cfg.command + ' ' + (cfg.args || []).join(' '),
      }));

    if (otherAgents.length === 0) {
      vscode.window.showInformationMessage('No other agents configured. Add agents in settings (acp.agents).');
      return;
    }

    const picked = await vscode.window.showQuickPick(otherAgents, {
      placeHolder: `Continue conversation from ${sourceAgentName} in...`,
      title: 'Fork to Another Agent',
    });
    if (!picked) return;

    const targetAgentName = picked.description!;

    try {
      // 1. Export the conversation from the webview
      const conversationText = await chatWebviewProvider.requestConversationExport(10000);
      if (!conversationText.trim()) {
        vscode.window.showWarningMessage('No conversation to fork — the session is empty.');
        return;
      }

      // 2. Connect to the target agent and create a new session
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Starting session with ${targetAgentName}...`, cancellable: false },
        async () => {
          await sessionManager.connectToAgent(targetAgentName);
        },
      );

      // 3. Send the conversation as a continuation prompt
      const forkPrompt = [
        'The following is a conversation from another agent. Please continue this conversation:',
        '',
        '---',
        '',
        conversationText,
        '',
        '---',
        '',
        'Please continue from where the conversation left off.',
      ].join('\n');

      const activeSession = sessionManager.getActiveSession();
      if (activeSession) {
        await sessionManager.sendPrompt(activeSession.sessionId, forkPrompt);
      }

      vscode.window.showInformationMessage(`Forked conversation from ${sourceAgentName} to ${targetAgentName}.`);
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to fork to ${targetAgentName}: ${e?.message || e}`);
    }
  });

  // Add Agent Configuration
  const addAgentCmd = vscode.commands.registerCommand('acp.addAgent', async () => {
    const name = await vscode.window.showInputBox({
      prompt: 'Agent name',
      placeHolder: 'my-agent',
      title: 'Add ACP Agent',
    });
    if (!name) {
      return;
    }

    const command = await vscode.window.showInputBox({
      prompt: 'Command to launch the agent',
      placeHolder: 'npx',
      title: 'Agent Command',
    });
    if (!command) {
      return;
    }

    const argsStr = await vscode.window.showInputBox({
      prompt: 'Arguments (space-separated)',
      placeHolder: '-y @my-org/agent',
      title: 'Agent Arguments',
    });
    const args = argsStr ? argsStr.split(/\s+/) : [];

    const config = vscode.workspace.getConfiguration('acp');
    // Write only into the user (Global) layer — do not copy package.json
    // defaults into settings.json (object settings are merged with defaults).
    const inspected = config.inspect<Record<string, any>>('agents');
    const agents: Record<string, any> = { ...(inspected?.globalValue || {}) };
    agents[name] = { command, args };
    await config.update('agents', agents, vscode.ConfigurationTarget.Global);
    sessionTreeProvider.refresh();
    vscode.window.showInformationMessage(`Agent "${name}" added.`);
    sendEvent('agent/added');
  });

  // Remove Agent
  // Sessions are irrelevant — this only edits `acp.agents` settings. Works
  // whether the agent is connected, disconnected, or has never had a session.
  const removeAgentCmd = vscode.commands.registerCommand('acp.removeAgent', async (item?: any) => {
    const config = vscode.workspace.getConfiguration('acp');
    const agentNames = getAgentNames();
    if (agentNames.length === 0) {
      vscode.window.showInformationMessage('No agents configured.');
      return;
    }

    // Tree context menu passes AgentTreeItem (`agentName` / `id`). Command
    // Palette passes nothing → QuickPick. Do not require a live session.
    const name =
      (typeof item?.agentName === 'string' && item.agentName) ||
      (typeof item?.id === 'string' && agentNames.includes(item.id) ? item.id : undefined) ||
      (await vscode.window.showQuickPick(agentNames, {
        placeHolder: 'Select agent to remove',
        title: 'Remove ACP Agent',
      }));
    if (!name) {
      return;
    }

    const confirm = await vscode.window.showWarningMessage(`Remove agent "${name}"?`, { modal: true }, 'Remove');
    if (confirm !== 'Remove') {
      return;
    }

    // Disconnect if connected
    if (sessionManager.isAgentConnected(name)) {
      await sessionManager.disconnectAgent(name);
    }

    // Object settings merge with package.json defaults. Deleting a key from
    // the merged view and writing the rest still leaves built-in agents
    // (e.g. "Kiro CLI") in the default layer, so they reappear in the list.
    // Tombstone with null — same as terminal.integrated.profiles.* removal.
    const inspected = config.inspect<Record<string, any>>('agents');
    const globalAgents: Record<string, any> = { ...(inspected?.globalValue || {}) };
    globalAgents[name] = null;
    await config.update('agents', globalAgents, vscode.ConfigurationTarget.Global);

    // Also tombstone in workspace settings if that layer defines the agent.
    if (inspected?.workspaceValue && Object.prototype.hasOwnProperty.call(inspected.workspaceValue, name)) {
      const workspaceAgents: Record<string, any> = { ...inspected.workspaceValue };
      workspaceAgents[name] = null;
      await config.update('agents', workspaceAgents, vscode.ConfigurationTarget.Workspace);
    }

    sessionTreeProvider.refreshAll();
    vscode.window.showInformationMessage(`Agent "${name}" removed.`);
    sendEvent('agent/removed', { agentName: name });
  });

  // Attach File
  const attachFileCmd = vscode.commands.registerCommand('acp.attachFile', async () => {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Attach',
      title: 'Attach File to Chat',
    });
    if (uris && uris.length > 0) {
      chatWebviewProvider.attachFile(uris[0]);
    }
  });

  // Browse Registry
  const browseRegistryCmd = vscode.commands.registerCommand('acp.browseRegistry', async () => {
    sendEvent('registry/browse');
    try {
      const agents = await fetchRegistry();
      const items = agents.map((a) => ({
        label: a.name,
        description: a.command,
        detail: a.description || '',
      }));
      if (items.length === 0) {
        vscode.window.showInformationMessage('No agents found in registry.');
        return;
      }
      await vscode.window.showQuickPick(items, {
        placeHolder: 'ACP Agent Registry',
        title: 'Available ACP Agents',
      });
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to fetch registry: ${e.message}`);
    }
  });

  // --- Register disposables ---
  context.subscriptions.push(
    treeView,
    chatViewRegistration,
    statusBarManager,
    connectAgentCmd,
    newConversationCmd,
    disconnectAgentCmd,
    openChatCmd,
    sendPromptCmd,
    cancelTurnCmd,
    toggleFollowAgentCmd,
    restartAgentCmd,
    showLogCmd,
    showTrafficCmd,
    exportTrafficCmd,
    setModeCmd,
    setModelCmd,
    refreshAgentsCmd,
    refreshSessionsCmd,
    openSessionCmd,
    openLocalAgentSessionCmd,
    loadMoreSessionsCmd,
    copySessionIdCmd,
    forgetSessionCmd,
    deleteSessionCmd,
    logoutCmd,
    forkSessionCmd,
    forkToAgentCmd,
    nesRegistration,
    nesAcceptCmd,
    nesRejectCmd,
    addAgentCmd,
    removeAgentCmd,
    attachFileCmd,
    browseRegistryCmd,
    {
      dispose: () => {
        sessionManager.dispose();
        sessionUpdateHandler.dispose();
        chatWebviewProvider.dispose();
        sessionTreeProvider.dispose();
        nesManager.dispose();
        disposeChannels();
      },
    },
  );

  sendEvent('extension/activated', {
    version: vscode.extensions.getExtension('formulahendry.acp-client')?.packageJSON?.version ?? 'unknown',
  });
  log('ACP Client extension activated.');

  // --- Workspace / config change refresh ---
  // When a new workspace folder is opened (new repo), the tree view's
  // cached children become stale — the session list for the new cwd is
  // different. Force a full tree refresh so agent details appear
  // immediately without requiring the user to close/reopen the sidebar.
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      log('Workspace folders changed — refreshing session tree.');
      kiroDiscovery?.refresh();
      sessionTreeProvider.refreshAll();
    }),
  );

  // When ACP agent configuration changes in settings.json, refresh the
  // tree so newly-added agents appear without a manual reload.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('acp.agents') || e.affectsConfiguration('acp')) {
        log('ACP configuration changed — refreshing session tree.');
        sessionTreeProvider.refreshAll();
      }
    }),
  );
}

export function deactivate(): Thenable<void> | undefined {
  log('ACP Client extension deactivating...');
  // Ensure agent processes are killed even when context.subscriptions
  // dispose doesn't run (e.g. VSCode force-quit).  The synchronous
  // dispose also avoids the 5-second SIGKILL timeout race.
  if (_sessionManager) {
    _sessionManager.dispose();
    _sessionManager = undefined;
  }
  return undefined;
}

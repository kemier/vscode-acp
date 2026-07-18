import * as vscode from 'vscode';
import type { SessionInfo as ProtocolSessionInfo } from '@agentclientprotocol/sdk';
import { SessionManager, AgentCapabilitySummary } from '../core/SessionManager';
import { SessionHistoryStore, PersistedSessionEntry } from '../core/SessionHistoryStore';
import { getAgentNames, getAgentConfigs } from '../config/AgentConfig';
import { log, logError } from '../utils/Logger';
import { KiroSessionDiscovery, KiroDiscoveredSession } from '../core/KiroSessionDiscovery';
import { cleanSessionTitle } from '../utils/TitleCleaner';

/**
 * Tier-1 — a configured agent. Collapsible only when we believe the agent
 * has any way to expose past sessions (either supports session/list, or has
 * locally-cached entries via {@link SessionHistoryStore}).
 */
export class AgentTreeItem extends vscode.TreeItem {
  constructor(
    public readonly agentName: string,
    public readonly connected: boolean,
    collapsibleState: vscode.TreeItemCollapsibleState,
  ) {
    super(agentName, collapsibleState);

    this.id = agentName;

    if (connected) {
      this.contextValue = 'agent-connected';
      this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('testing.iconPassed'));
      this.description = 'connected';
      this.command = { command: 'acp.openChat', title: 'Open Chat' };
    } else {
      this.contextValue = 'agent-disconnected';
      this.iconPath = new vscode.ThemeIcon('circle-outline');
      this.description = '';
    }

    this.tooltip = connected
      ? `${agentName} — connected\nClick to open chat`
      : `${agentName} — not connected\nUse the plug icon to connect`;
  }
}

/**
 * Tier-2 — a session belonging to an agent. Clicking it routes to
 * `acp.openSession` which calls `session/load` or `session/resume`.
 */
export class SessionTreeItem extends vscode.TreeItem {
  constructor(
    public readonly agentName: string,
    public readonly sessionId: string,
    label: string,
    public readonly isActive: boolean,
    description: string | undefined,
    tooltip: string,
    public readonly source: 'agent' | 'local' | 'kiro',
    extensionUri: vscode.Uri,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    // Include active state in the id so VS Code treats it as a new item
    // when active state changes, forcing a full re-render (including
    // iconPath). Without this, VS Code matches by id and keeps the stale
    // icon. The expansion state of parent agent nodes is preserved
    // separately via expandedAgentNodes tracking.
    this.id = `${agentName}:${sessionId}:${isActive ? 'a' : 'i'}`;
    this.contextValue = source === 'kiro' ? 'session-kiro' : source === 'local' ? 'session-local' : 'session';
    this.description = description;
    this.tooltip = tooltip;
    if (isActive) {
      // Use a custom SVG with green fill instead of ThemeIcon+ThemeColor.
      // VS Code loses ThemeColor on tree item selection/click, turning
      // the green bubble gray. A custom SVG with baked-in color is
      // immune to this rendering bug.
      this.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'active-session.svg');
    } else {
      this.iconPath = new vscode.ThemeIcon('comment-discussion');
    }
    // Attach command to all items (including active) so clicking still
    // focuses the chat. The no-op guard in openSession handles the
    // already-active case. Since the icon is now a custom SVG (not
    // ThemeColor), VS Code won't lose the color on re-render.
    this.command = {
      command: 'acp.openSession',
      title: 'Open Session',
      arguments: [{ agentName, sessionId }],
    };
  }
}

/**
 * A leaf node used to surface status / errors / fallbacks under an agent.
 */
export class InfoTreeItem extends vscode.TreeItem {
  constructor(
    public readonly kind: 'loading' | 'empty' | 'unsupported' | 'error' | 'auth-required' | 'load-more',
    public readonly agentName: string,
    label: string,
    tooltip?: string,
    command?: vscode.Command,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.tooltip = tooltip;
    this.command = command;
    switch (kind) {
      case 'loading':
        this.iconPath = new vscode.ThemeIcon('loading~spin');
        this.contextValue = 'session-info-loading';
        break;
      case 'empty':
        this.iconPath = new vscode.ThemeIcon('inbox');
        this.contextValue = 'session-info-empty';
        break;
      case 'unsupported':
        this.iconPath = new vscode.ThemeIcon('info');
        this.contextValue = 'session-info-unsupported';
        break;
      case 'error':
        this.iconPath = new vscode.ThemeIcon('warning');
        this.contextValue = 'session-info-error';
        break;
      case 'auth-required':
        this.iconPath = new vscode.ThemeIcon('key');
        this.contextValue = 'session-info-auth';
        break;
      case 'load-more':
        this.iconPath = new vscode.ThemeIcon('chevron-down');
        this.contextValue = 'session-info-load-more';
        break;
    }
  }
}

type AgentNode = AgentTreeItem;
type ChildNode = SessionTreeItem | InfoTreeItem;

interface AgentListState {
  state: 'idle' | 'loading' | 'ready' | 'error' | 'unsupported' | 'auth-required';
  /** Agent-provided sessions (only when caps.list is true). */
  agentSessions?: ProtocolSessionInfo[];
  nextCursor?: string;
  error?: string;
  /** Page size from the first successful fetch — used as the backfill target. */
  initialPageSize?: number;
}

/**
 * Tree provider for the ACP Agents view. Tier 1 = agents, tier 2 = sessions.
 *
 * Tier 2 source-of-truth selection per agent:
 *   - If the agent advertises `session/list`: use that (the agent owns the
 *     truth). Local history-store entries for that agent are reconciled
 *     against the server on each list call.
 *   - Else if the agent advertises `session/load` or `session/resume`: use
 *     the local history store as the source.
 *   - Else: a single "not supported" info leaf.
 */
export class SessionTreeProvider implements vscode.TreeDataProvider<AgentNode | ChildNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<AgentNode | ChildNode | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private listStates: Map<string, AgentListState> = new Map();

  /** Tracks currently-expanded agent nodes so refreshAll() can fire
   *  _onDidChangeTreeData for each, forcing VS Code to re-fetch their
   *  children (and thus re-evaluate `isActive` on every SessionTreeItem). */
  private expandedAgentNodes: Map<string, AgentTreeItem> = new Map();

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly historyStore: SessionHistoryStore | null,
    private readonly workspaceCwd: () => string | undefined,
    private readonly extensionUri: vscode.Uri,
    private readonly kiroDiscovery: KiroSessionDiscovery | null = null,
  ) {
    this.sessionManager.on('agent-connected', () => this.refreshAll());
    this.sessionManager.on('agent-disconnected', () => this.refreshAll());
    this.sessionManager.on('active-session-changed', () => {
      // Refresh all expanded agent nodes to re-evaluate isActive on
      // their session items. Don't fire undefined (root) — that causes
      // the entire tree to re-render.
      for (const agentName of this.expandedAgentNodes.keys()) {
        const placeholder = new AgentTreeItem(
          agentName,
          this.sessionManager.isAgentConnected(agentName),
          vscode.TreeItemCollapsibleState.Expanded,
        );
        this._onDidChangeTreeData.fire(placeholder);
      }
    });
    this.sessionManager.on('session-info-changed', (_sessionId, _info) => {
      // Refresh only the affected agent node so session titles are
      // re-evaluated. Do NOT invalidate/delete the list state — the
      // cached session list is still valid, only the title changed.
      const session = this.sessionManager.getActiveSession();
      const agentName = session?.agentName;
      if (agentName) {
        const node = this.expandedAgentNodes.get(agentName);
        if (node) {
          this._onDidChangeTreeData.fire(node);
        } else {
          this._onDidChangeTreeData.fire(undefined);
        }
      } else {
        this.refreshAll();
      }
    });
    if (this.historyStore) {
      // Only refresh the active agent's node — avoids full tree refresh
      // on every touch/persist (which happens on every prompt).
      this.historyStore.onDidChange(() => {
        const session = this.sessionManager.getActiveSession();
        const agentName = session?.agentName;
        if (agentName) {
          // Don't invalidate — just refresh the node so titles are
          // re-evaluated without re-fetching the entire session list.
          const node = this.expandedAgentNodes.get(agentName);
          if (node) {
            this._onDidChangeTreeData.fire(node);
          } else {
            this._onDidChangeTreeData.fire(undefined);
          }
        } else {
          this.refreshAll();
        }
      });
    }

    // When Kiro sessions change on disk, refresh the tree so newly
    // created CLI sessions appear without manual refresh.
    if (this.kiroDiscovery) {
      this.kiroDiscovery.on('did-change', () => this.refreshAll());
    }
  }

  refresh(node?: AgentNode | ChildNode): void {
    this._onDidChangeTreeData.fire(node);
  }

  /**
   * Refresh the root AND all currently-tracked expanded agent nodes.
   *
   * VS Code's tree view caches children of expanded parent nodes. When we
   * fire `_onDidChangeTreeData` with `undefined`, only the root children
   * (agent nodes) are re-fetched — the children of expanded agents keep
   * their stale `isActive` state. To force VS Code to re-fetch children of
   * every expanded agent, we fire the event for each tracked agent node.
   */
  refreshAll(): void {
    // Fire for root first.
    this._onDidChangeTreeData.fire(undefined);
    // Then fire for each tracked agent name so its children are re-fetched.
    // We create a fresh lightweight AgentTreeItem for each — VS Code matches
    // by the `id` property we set, so the object identity doesn't matter.
    for (const agentName of this.expandedAgentNodes.keys()) {
      const placeholder = new AgentTreeItem(
        agentName,
        this.sessionManager.isAgentConnected(agentName),
        vscode.TreeItemCollapsibleState.Expanded,
      );
      this._onDidChangeTreeData.fire(placeholder);
    }
  }

  /**
   * Drop cached state for an agent (or all agents) so the next expansion
   * re-runs `session/list` and re-probes capabilities.
   */
  invalidate(agentName?: string): void {
    if (agentName) {
      this.listStates.delete(agentName);
      // Only refresh the affected agent node, not the entire tree.
      const node = this.expandedAgentNodes.get(agentName);
      if (node) {
        this._onDidChangeTreeData.fire(node);
      } else {
        this._onDidChangeTreeData.fire(undefined);
      }
    } else {
      this.listStates.clear();
      this.refreshAll();
    }
  }

  /**
   * Remove a single session from the cached agent-sourced list without
   * triggering a full re-fetch. Avoids the list → loading → list flash.
   */
  removeSession(agentName: string, sessionId: string): void {
    const state = this.listStates.get(agentName);
    if (state?.state === 'ready' && state.agentSessions) {
      state.agentSessions = state.agentSessions.filter((s) => s.sessionId !== sessionId);
      // If there are more sessions available on the agent (nextCursor),
      // auto-fetch the next page to backfill the removed item so the
      // list doesn't shrink below the page size without user action.
      // Backfill when the visible count drops below the initial page size.
      // loadMore will auto-continue through empty pages until it finds
      // real sessions or runs out of cursors.
      const target = state.initialPageSize ?? 8;
      if (state.nextCursor && state.agentSessions.length < target) {
        void this.loadMore(agentName);
      }
    }
    // Also remove from local history store.
    this.historyStore?.forget(agentName, sessionId);
    // Refresh only the affected agent node.
    const node = this.expandedAgentNodes.get(agentName);
    if (node) {
      this._onDidChangeTreeData.fire(node);
    } else {
      this._onDidChangeTreeData.fire(undefined);
    }
  }

  getTreeItem(element: AgentNode | ChildNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: AgentNode | ChildNode): Promise<(AgentNode | ChildNode)[]> {
    if (!element) {
      return this.getAgentNodes();
    }
    if (element instanceof AgentTreeItem) {
      // Track this agent node as expanded so refreshAll() can force
      // VS Code to re-fetch its children (re-evaluating isActive).
      this.expandedAgentNodes.set(element.agentName, element);
      return this.getAgentChildren(element);
    }
    return [];
  }

  // --- Tier 1 ---

  private getAgentNodes(): AgentTreeItem[] {
    return getAgentNames().map((name) => {
      const caps = this.sessionManager.getCachedCapabilities(name);
      const localCount =
        (this.historyStore?.list(name, this.workspaceCwd()).length ?? 0) +
        (this.isKiroAgent(name) && this.kiroDiscovery?.isAvailable()
          ? this.kiroDiscovery.discover({ cwd: this.workspaceCwd() }).length
          : 0);
      let collapsibleState = this.computeCollapsibleState(name, caps, localCount);
      // Preserve expansion: if this agent was previously expanded, keep it
      // expanded so VS Code re-fetches its children (and re-evaluates
      // isActive on each SessionTreeItem). Without this, the new
      // AgentTreeItem defaults to Collapsed, causing VS Code to collapse
      // the node and skip re-fetching its children — stale icons remain.
      if (this.expandedAgentNodes.has(name) && collapsibleState !== vscode.TreeItemCollapsibleState.None) {
        collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
      }
      return new AgentTreeItem(name, this.sessionManager.isAgentConnected(name), collapsibleState);
    });
  }

  private computeCollapsibleState(
    agentName: string,
    caps: AgentCapabilitySummary | undefined,
    localCount: number,
  ): vscode.TreeItemCollapsibleState {
    // Known unsupported (no list, no load, no resume) AND nothing cached
    // locally → no expand affordance to avoid misleading the user.
    if (caps && !caps.list && !caps.load && !caps.resume && localCount === 0) {
      return vscode.TreeItemCollapsibleState.None;
    }
    // Otherwise default to collapsed; expansion triggers probing/fetching.
    return vscode.TreeItemCollapsibleState.Collapsed;
  }

  // --- Tier 2 ---

  private async getAgentChildren(agent: AgentTreeItem): Promise<ChildNode[]> {
    const name = agent.agentName;
    let caps = this.sessionManager.getCachedCapabilities(name);

    // Capability not yet known — probe lazily.
    if (!caps) {
      const probeResult = await this.probeCapabilities(name);
      if (probeResult.kind === 'auth-cancelled') {
        return [this.authRequiredLeaf(name)];
      }
      if (probeResult.kind === 'error') {
        return [this.errorLeaf(name, probeResult.message)];
      }
      caps = probeResult.caps;
    }

    // Source A — agent supports list: fetch from agent (source of truth).
    if (caps.list) {
      return this.getAgentSourcedChildren(name);
    }

    // Source B — agent supports load and/or resume but not list: merge
    // Kiro-discovered sessions (from disk) and local history entries.
    if (caps.load || caps.resume) {
      return this.getMergedSourcedChildren(name);
    }

    // Source C — no relevant capability. Show an informative leaf so users
    // understand why expanding this agent shows nothing.
    return [
      new InfoTreeItem(
        'unsupported',
        name,
        'Session list not supported',
        'This agent does not advertise session/list, session/load, or session/resume.\n' +
          'You can still start a new chat from the agent row.',
      ),
    ];
  }

  // --- Agent-sourced list ---

  private async getAgentSourcedChildren(agentName: string): Promise<ChildNode[]> {
    const state = this.listStates.get(agentName);
    if (state?.state === 'loading') {
      return [this.loadingLeaf(agentName)];
    }
    if (!state || state.state === 'idle' || state.state === 'error') {
      // Kick off the fetch.
      void this.fetchSessionList(agentName);
      return [this.loadingLeaf(agentName)];
    }
    if (state.state === 'auth-required') {
      return [this.authRequiredLeaf(agentName)];
    }
    if (state.state === 'unsupported') {
      return [new InfoTreeItem('unsupported', agentName, 'Session list not supported')];
    }
    // state === 'ready'
    const activeId = this.sessionManager.getActiveSessionId();
    // Merge in renamed sessions from the history store that aren't in
    // the agent-sourced list. These are sessions the user renamed but
    // that appear on a later page (or the agent no longer returns them).
    // They should always be visible because the user explicitly named them.
    const agentSessions = state.agentSessions ?? [];
    const agentSessionIds = new Set(agentSessions.map((s) => s.sessionId));
    const renamedFromHistory = this.historyStore
      ? this.historyStore.list(agentName).filter((e) => e.title && !agentSessionIds.has(e.sessionId))
      : [];
    const mergedSessions: ProtocolSessionInfo[] = [
      ...agentSessions,
      ...renamedFromHistory.map((e) => ({
        sessionId: e.sessionId,
        cwd: (e.cwd || this.workspaceCwd() || '') as string,
        title: e.title || '',
        updatedAt: e.lastActiveAt,
      })),
    ];
    log(
      `getAgentSourcedChildren: agentName=${agentName}, activeId=${activeId}, agentSessions=${agentSessions.length}, renamedFromHistory=${renamedFromHistory.length}, merged=${mergedSessions.length}`,
    );
    const sessions = mergedSessions.slice().sort((a, b) => {
      // Pin the active session to the very top so it is always the
      // first item the user sees and can click to resume.
      if (a.sessionId === activeId) {
        return -1;
      }
      if (b.sessionId === activeId) {
        return 1;
      }
      // Renamed sessions come before non-renamed ones, each group
      // sorted by most-recently-active first (updatedAt desc).
      // Only consider a session "renamed" if the user explicitly renamed it
      // client-side (via /rename) — not if it has an auto-generated title from the agent.
      // A session is "renamed" if:
      // 1. userRenamed flag is set (new /rename calls), OR
      // 2. historyStore title differs from agent-provided title (legacy renames)
      const aEntry = this.historyStore?.get(agentName, a.sessionId);
      const bEntry = this.historyStore?.get(agentName, b.sessionId);
      const aRenamed = !!(aEntry?.userRenamed || (aEntry?.title && a.title && aEntry.title !== a.title));
      const bRenamed = !!(bEntry?.userRenamed || (bEntry?.title && b.title && bEntry.title !== b.title));
      if (aRenamed !== bRenamed) {
        return aRenamed ? -1 : 1;
      }
      const ta = a.updatedAt ? Date.parse(a.updatedAt) : 0;
      const tb = b.updatedAt ? Date.parse(b.updatedAt) : 0;
      return tb - ta;
    });
    if (sessions.length === 0 && !state.nextCursor) {
      return [new InfoTreeItem('empty', agentName, '(no previous sessions)')];
    }
    const items: ChildNode[] = sessions.map((s) => this.buildAgentSessionItem(agentName, s, activeId));
    if (state.nextCursor) {
      items.push(
        new InfoTreeItem('load-more', agentName, 'Load more…', undefined, {
          command: 'acp.loadMoreSessions',
          title: 'Load more sessions',
          arguments: [agentName],
        }),
      );
    }
    return items;
  }

  private buildAgentSessionItem(
    agentName: string,
    info: ProtocolSessionInfo,
    activeId: string | null,
  ): SessionTreeItem {
    // Prefer client-side title (from @rename / /rename) over the agent's title.
    const localEntry = this.historyStore?.get(agentName, info.sessionId);
    const title = localEntry?.title || info.title || '';
    const label = cleanSessionTitle(title) || shortSessionId(info.sessionId);
    const description = relativeTime(info.updatedAt);
    const tooltip = buildSessionTooltip(agentName, info.sessionId, info.cwd, info.updatedAt, 'agent');
    return new SessionTreeItem(
      agentName,
      info.sessionId,
      label,
      info.sessionId === activeId,
      description,
      tooltip,
      'agent',
      this.extensionUri,
    );
  }

  private async fetchSessionList(agentName: string): Promise<void> {
    this.listStates.set(agentName, { state: 'loading' });
    this.refresh();
    try {
      const result = await this.sessionManager.listSessions(agentName, {
        cwd: this.workspaceCwd(),
      });
      this.listStates.set(agentName, {
        state: 'ready',
        agentSessions: result.sessions,
        nextCursor: result.nextCursor,
        initialPageSize: result.sessions.length,
      });
      // If the first page was very small and there are more pages,
      // auto-fetch additional pages until we have at least MIN_DISPLAY
      // agent-sourced sessions (renamed-from-history items don't count
      // toward this — they're extras on top).
      const MIN_DISPLAY = 10;
      if (result.nextCursor && result.sessions.length < MIN_DISPLAY) {
        void this.loadMore(agentName);
      }
    } catch (e: any) {
      const message = String(e?.message || 'Unknown error');
      logError(`Failed to list sessions for ${agentName}`, e);
      if (/auth|authentication/i.test(message) || /cancelled/i.test(message)) {
        this.listStates.set(agentName, { state: 'auth-required' });
      } else {
        this.listStates.set(agentName, { state: 'error', error: message });
      }
    } finally {
      this.refresh();
    }
  }

  /** Fetch and append the next page (only meaningful for agent-sourced lists). */
  async loadMore(agentName: string): Promise<void> {
    const state = this.listStates.get(agentName);
    if (!state || state.state !== 'ready' || !state.nextCursor) {
      return;
    }
    const cursor = state.nextCursor;
    // If we already have sessions to show, keep them visible during the
    // fetch (no loading spinner flash). Only set 'loading' when the list
    // is empty (initial load).
    const hasItems = (state.agentSessions ?? []).length > 0;
    if (!hasItems) {
      this.listStates.set(agentName, { ...state, state: 'loading' });
      // Only refresh the specific agent node, not the whole tree.
      const node = this.expandedAgentNodes.get(agentName);
      if (node) {
        this._onDidChangeTreeData.fire(node);
      } else {
        this._onDidChangeTreeData.fire(undefined);
      }
    }
    try {
      const result = await this.sessionManager.listSessions(agentName, {
        cwd: this.workspaceCwd(),
        cursor,
      });
      const prev = state.agentSessions ?? [];
      // Filter out any sessions already present (dedup by sessionId).
      const existingIds = new Set(prev.map((s) => s.sessionId));
      // Also dedup against renamed sessions from the history store that
      // are already shown in the merged list — otherwise the agent returns
      // them and they appear as duplicates (or count as "new" when they
      // aren't actually new to the user).
      const renamedIds = this.historyStore
        ? this.historyStore
            .list(agentName)
            .filter((e) => e.title)
            .map((e) => e.sessionId)
        : [];
      for (const id of renamedIds) {
        existingIds.add(id);
      }
      const newSessions = result.sessions.filter((s) => !existingIds.has(s.sessionId));
      this.listStates.set(agentName, {
        state: 'ready',
        agentSessions: [...prev, ...newSessions],
        nextCursor: result.nextCursor,
        initialPageSize: state.initialPageSize,
      });
      // If this page returned 0 new sessions but there's still a nextCursor,
      // auto-continue to the next page. The Codex agent has gaps where
      // some pages return empty but later pages have real sessions.
      // Limit to 5 consecutive empty pages to prevent infinite loops.
      if (newSessions.length === 0 && result.nextCursor) {
        const emptyPages = (state as any)._emptyPages ?? 0;
        if (emptyPages < 5) {
          (this.listStates.get(agentName) as any)._emptyPages = emptyPages + 1;
          // Recurse to fetch the next page.
          return this.loadMore(agentName);
        }
      }
      // Reset the empty page counter when we find sessions.
      delete (this.listStates.get(agentName) as any)._emptyPages;
    } catch (e: any) {
      logError(`Failed to load more sessions for ${agentName}`, e);
      // Roll back to previous ready state.
      this.listStates.set(agentName, {
        state: 'ready',
        agentSessions: state.agentSessions,
        nextCursor: state.nextCursor,
        initialPageSize: state.initialPageSize,
        error: String(e?.message || e),
      });
    } finally {
      // Only refresh the affected agent node, not the entire tree —
      // prevents the list flash after delete/backfill.
      const node = this.expandedAgentNodes.get(agentName);
      if (node) {
        this._onDidChangeTreeData.fire(node);
      } else {
        this._onDidChangeTreeData.fire(undefined);
      }
    }
  }

  // --- Merged source (Kiro disk discovery + local history) ---

  /**
   * Check if the agent is the Kiro CLI (by name or config command).
   * Used to decide whether to query KiroSessionDiscovery for on-disk
   * sessions.
   */
  private isKiroAgent(agentName: string): boolean {
    // The agent name is "Kiro CLI" per the default config. Also check
    // for a case-insensitive substring match to be robust against
    // user-customized names.
    if (/kiro/i.test(agentName)) {
      return true;
    }
    // Also check the config command — the user may have renamed the agent.
    const configs = getAgentConfigs();
    const config = configs[agentName];
    if (config && /kiro/i.test(config.command)) {
      return true;
    }
    return false;
  }

  /**
   * Build the tier-2 children for agents that support `session/load` or
   * `session/resume` but NOT `session/list`. This merges:
   *   1. Kiro sessions discovered on disk (from `~/.kiro/sessions/`) —
   *      includes sessions spawned from the CLI and the IDE.
   *   2. Local history-store entries (sessions created from within VS Code).
   *
   * Sessions are deduplicated by sessionId — if a session appears in both
   * sources, the local history entry wins (it may have a user-set title).
   */
  private getMergedSourcedChildren(agentName: string): ChildNode[] {
    const cwd = this.workspaceCwd();
    const activeId = this.sessionManager.getActiveSessionId();

    // Gather local history entries.
    const localEntries = this.historyStore ? this.historyStore.list(agentName, cwd) : [];

    // Gather Kiro-discovered sessions (only for Kiro CLI agent).
    const isKiro = this.isKiroAgent(agentName);
    const kiroSessions = isKiro && this.kiroDiscovery?.isAvailable() ? this.kiroDiscovery.discover({ cwd }) : [];

    // Build a set of local session IDs for dedup.
    const localIds = new Set(localEntries.map((e) => e.sessionId));

    // Merge: local entries first (they may have renamed titles), then
    // kiro-discovered sessions not already in local.
    const merged: Array<
      { kind: 'local'; entry: PersistedSessionEntry } | { kind: 'kiro'; entry: KiroDiscoveredSession }
    > = [
      ...localEntries.map((e) => ({ kind: 'local' as const, entry: e })),
      ...kiroSessions.filter((s) => !localIds.has(s.sessionId)).map((e) => ({ kind: 'kiro' as const, entry: e })),
    ];

    if (merged.length === 0) {
      return [
        new InfoTreeItem(
          'empty',
          agentName,
          '(no previous sessions)',
          'Sessions you start with this agent will appear here.',
        ),
      ];
    }

    // Pin the active session to the top.
    const ordered = merged.slice().sort((a, b) => {
      if (a.entry.sessionId === activeId) {
        return -1;
      }
      if (b.entry.sessionId === activeId) {
        return 1;
      }
      return 0;
    });

    return ordered.map((item) =>
      item.kind === 'local'
        ? this.buildLocalSessionItem(item.entry, activeId)
        : this.buildKiroSessionItem(item.entry, agentName, activeId),
    );
  }

  /**
   * Build a SessionTreeItem from a Kiro-discovered session (read from
   * `~/.kiro/sessions/` on disk). These sessions can be loaded via
   * `session/load` just like local-history sessions — Kiro CLI advertises
   * `loadSession: true`.
   */
  private buildKiroSessionItem(
    entry: KiroDiscoveredSession,
    agentName: string,
    activeId: string | null,
  ): SessionTreeItem {
    const label = cleanSessionTitle(entry.title || '') || shortSessionId(entry.sessionId);
    const description = relativeTime(entry.lastActiveAt);
    const tooltip = buildSessionTooltip(agentName, entry.sessionId, entry.cwd, entry.lastActiveAt, 'kiro');
    return new SessionTreeItem(
      agentName,
      entry.sessionId,
      label,
      entry.sessionId === activeId,
      description,
      tooltip,
      'kiro',
      this.extensionUri,
    );
  }
  // --- Local-history-store-sourced list ---

  private getLocalSourcedChildren(agentName: string): ChildNode[] {
    if (!this.historyStore) {
      return [
        new InfoTreeItem('unsupported', agentName, 'Session history unavailable', 'No workspace storage is wired up.'),
      ];
    }
    const cwd = this.workspaceCwd();
    const entries = this.historyStore.list(agentName, cwd);
    if (entries.length === 0) {
      return [
        new InfoTreeItem(
          'empty',
          agentName,
          '(no previous sessions)',
          'Sessions you start with this agent will appear here.',
        ),
      ];
    }
    const activeId = this.sessionManager.getActiveSessionId();
    // Pin the active session to the very top for consistency with the
    // agent-sourced list (entries are already sorted by lastActiveAt
    // descending, but the active session should always be first).
    const ordered = entries.slice().sort((a, b) => {
      if (a.sessionId === activeId) {
        return -1;
      }
      if (b.sessionId === activeId) {
        return 1;
      }
      // Renamed sessions (userRenamed) come before non-renamed ones,
      // each group sorted by lastActiveAt descending.
      const aRenamed = !!a.userRenamed;
      const bRenamed = !!b.userRenamed;
      if (aRenamed !== bRenamed) {
        return aRenamed ? -1 : 1;
      }
      const ta = a.lastActiveAt ? Date.parse(a.lastActiveAt) : 0;
      const tb = b.lastActiveAt ? Date.parse(b.lastActiveAt) : 0;
      return tb - ta;
    });
    return ordered.map((e) => this.buildLocalSessionItem(e, activeId));
  }

  private buildLocalSessionItem(entry: PersistedSessionEntry, activeId: string | null): SessionTreeItem {
    const label =
      cleanSessionTitle(entry.title || '') ||
      (entry.firstPrompt?.trim() && truncate(entry.firstPrompt!.trim(), 60)) ||
      shortSessionId(entry.sessionId);
    const description = relativeTime(entry.lastActiveAt);
    const tooltip = buildSessionTooltip(entry.agentName, entry.sessionId, entry.cwd, entry.lastActiveAt, 'local');
    return new SessionTreeItem(
      entry.agentName,
      entry.sessionId,
      label,
      entry.sessionId === activeId,
      description,
      tooltip,
      'local',
      this.extensionUri,
    );
  }

  // --- Capability probe ---

  private async probeCapabilities(
    agentName: string,
  ): Promise<
    { kind: 'ok'; caps: AgentCapabilitySummary } | { kind: 'auth-cancelled' } | { kind: 'error'; message: string }
  > {
    log(`Probing capabilities for agent "${agentName}"…`);
    try {
      await this.sessionManager.ensureConnected(agentName);
      const caps = this.sessionManager.getCachedCapabilities(agentName);
      if (!caps) {
        return { kind: 'error', message: 'Failed to determine agent capabilities.' };
      }
      return { kind: 'ok', caps };
    } catch (e: any) {
      const msg = String(e?.message || e);
      logError(`Capability probe failed for ${agentName}`, e);
      if (/cancelled/i.test(msg)) {
        return { kind: 'auth-cancelled' };
      }
      return { kind: 'error', message: msg };
    }
  }

  // --- Info-leaf factories ---

  private loadingLeaf(agentName: string): InfoTreeItem {
    return new InfoTreeItem('loading', agentName, 'Loading sessions…');
  }

  private authRequiredLeaf(agentName: string): InfoTreeItem {
    return new InfoTreeItem('auth-required', agentName, 'Authentication required', 'Click to retry authentication.', {
      command: 'acp.connectAgent',
      title: 'Retry connect',
      arguments: [agentName],
    });
  }

  private errorLeaf(agentName: string, message: string): InfoTreeItem {
    return new InfoTreeItem('error', agentName, 'Failed to load sessions', message, {
      command: 'acp.refreshSessions',
      title: 'Retry',
      arguments: [agentName],
    });
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

// --- helpers ---

function shortSessionId(id: string): string {
  if (id.length <= 14) {
    return id;
  }
  return id.slice(0, 8) + '…' + id.slice(-4);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function relativeTime(iso: string | null | undefined): string | undefined {
  if (!iso) {
    return undefined;
  }
  const t = Date.parse(iso);
  if (Number.isNaN(t)) {
    return undefined;
  }
  const diff = Date.now() - t;
  if (diff < 0) {
    return 'just now';
  }
  const sec = Math.floor(diff / 1000);
  if (sec < 60) {
    return `${sec}s ago`;
  }
  const min = Math.floor(sec / 60);
  if (min < 60) {
    return `${min}m ago`;
  }
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    return `${hr}h ago`;
  }
  const day = Math.floor(hr / 24);
  if (day < 7) {
    return `${day}d ago`;
  }
  const wk = Math.floor(day / 7);
  if (wk < 5) {
    return `${wk}w ago`;
  }
  const mo = Math.floor(day / 30);
  if (mo < 12) {
    return `${mo}mo ago`;
  }
  const yr = Math.floor(day / 365);
  return `${yr}y ago`;
}

function buildSessionTooltip(
  agentName: string,
  sessionId: string,
  cwd: string | undefined,
  updatedAt: string | undefined | null,
  source: 'agent' | 'local' | 'kiro',
): string {
  const lines = [`Agent: ${agentName}`, `Session: ${sessionId}`];
  if (cwd) {
    lines.push(`cwd: ${cwd}`);
  }
  if (updatedAt) {
    lines.push(`Last active: ${updatedAt}`);
  }
  lines.push(
    source === 'local'
      ? 'Stored locally — agent does not list sessions'
      : source === 'kiro'
        ? 'Discovered from Kiro CLI session files'
        : 'Listed by agent',
  );
  return lines.join('\n');
}

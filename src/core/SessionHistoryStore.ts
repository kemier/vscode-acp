import * as vscode from 'vscode';

/**
 * Persistent client-side cache of past sessions per agent. Used to render the
 * tree-tier-2 (sessions under an agent) for agents that support
 * `session/load` or `session/resume` but do NOT advertise the experimental
 * `session/list` capability.
 *
 * When the agent supports `session/list`, that is the source of truth and
 * this store is NOT consulted (to avoid divergence).
 */
export interface PersistedSessionEntry {
  /** Agent name (as configured by the user). */
  agentName: string;
  /** Working directory the session was created in. */
  cwd: string;
  /** Session ID issued by the agent. */
  sessionId: string;
  /** Title supplied via `session_info_update`, if any. */
  title?: string;
  /** True when the user explicitly renamed via /rename (not agent auto-title). */
  userRenamed?: boolean;
  /** Last-selected mode ID (e.g. "plan", "code", "full-access"). */
  modeId?: string;
  /** Last-selected model ID (e.g. "glm-5.2", "kimi-k2.6"). */
  modelId?: string;
  /** Last-selected reasoning effort (e.g. "low", "high"). */
  reasoningEffort?: string;
  /** First user prompt of the session, used as a label fallback (truncated). */
  firstPrompt?: string;
  /** ISO timestamp when the session was first observed. */
  createdAt: string;
  /** ISO timestamp of the most recent activity (prompt end / update). */
  lastActiveAt: string;
}

/**
 * Versioned shape of the persisted state, so we can migrate later if needed.
 */
interface PersistedShape {
  version: 1;
  entries: PersistedSessionEntry[];
}

const STATE_KEY = 'acp.sessionHistory.v1';
const MAX_PROMPT_LEN = 120;
const DEFAULT_CAP_PER_AGENT = 50;

/**
 * Wraps `workspaceState` storage of {@link PersistedSessionEntry}. Entries are
 * scoped to the current workspace because we filter `session/list` (and our
 * own cache) by the workspace `cwd` — sessions from other workspaces aren't
 * relevant in this view.
 */
export class SessionHistoryStore {
  private entries: PersistedSessionEntry[] = [];
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fires whenever the cache mutates. Tree view subscribes for refresh. */
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly workspaceState: vscode.Memento,
    private readonly capPerAgent: number = DEFAULT_CAP_PER_AGENT,
  ) {
    const raw = this.workspaceState.get<PersistedShape>(STATE_KEY);
    if (raw && raw.version === 1 && Array.isArray(raw.entries)) {
      this.entries = raw.entries;
    } else {
    }
  }

  /**
   * Get entries for a given agent + (optional) workspace cwd, sorted by
   * `lastActiveAt` descending. When `cwd` is omitted all workspace entries
   * for the agent are returned.
   */
  list(agentName: string, cwd?: string): PersistedSessionEntry[] {
    return this.entries
      .filter((e) => e.agentName === agentName && (!cwd || e.cwd === cwd))
      .sort((a, b) => (b.lastActiveAt || '').localeCompare(a.lastActiveAt || ''));
  }

  /**
   * List all renamed sessions across ALL agents, sorted by
   * `lastActiveAt` descending. Used for cross-agent /session autocomplete
   * and summarization.
   */
  listAllRenamed(): PersistedSessionEntry[] {
    return this.entries
      .filter((e) => e.title && e.title.trim().length > 0)
      .sort((a, b) => (b.lastActiveAt || '').localeCompare(a.lastActiveAt || ''));
  }

  /** Look up a specific entry by agent + session id. */
  get(agentName: string, sessionId: string): PersistedSessionEntry | undefined {
    return this.entries.find((e) => e.agentName === agentName && e.sessionId === sessionId);
  }

  /**
   * Insert (or no-op if present) a new session entry. Called when the client
   * successfully creates a session via `session/new`.
   */
  upsertNew(agentName: string, cwd: string, sessionId: string): void {
    const existing = this.get(agentName, sessionId);
    if (existing) {
      // Refresh lastActiveAt so it floats to the top on re-render.
      existing.lastActiveAt = new Date().toISOString();
      this.persist();
      return;
    }
    const now = new Date().toISOString();
    this.entries.push({
      agentName,
      cwd,
      sessionId,
      createdAt: now,
      lastActiveAt: now,
    });
    this.enforceCap(agentName);
    this.persist();
  }

  /** Persist the last-selected mode for a session. */
  setModeId(agentName: string, sessionId: string, modeId: string | null | undefined): void {
    if (modeId === undefined) {
      return;
    }
    let entry = this.get(agentName, sessionId);
    if (!entry) {
      const now = new Date().toISOString();
      entry = {
        agentName,
        cwd: '',
        sessionId,
        createdAt: now,
        lastActiveAt: now,
      };
      this.entries.push(entry);
    }
    if (modeId === null) {
      delete entry.modeId;
    } else {
      entry.modeId = modeId;
    }
    void this.workspaceState.update(STATE_KEY, { version: 1, entries: this.entries });
  }

  /** Persist the last-selected model for a session. */
  setModelId(agentName: string, sessionId: string, modelId: string | null | undefined): void {
    if (modelId === undefined) {
      return;
    }
    let entry = this.get(agentName, sessionId);
    if (!entry) {
      const now = new Date().toISOString();
      entry = {
        agentName,
        cwd: '',
        sessionId,
        createdAt: now,
        lastActiveAt: now,
      };
      this.entries.push(entry);
    }
    if (modelId === null) {
      delete entry.modelId;
    } else {
      entry.modelId = modelId;
    }
    void this.workspaceState.update(STATE_KEY, { version: 1, entries: this.entries });
  }

  /** Persist the last-selected reasoning effort for a session. */
  setReasoningEffort(agentName: string, sessionId: string, effort: string | null | undefined): void {
    if (effort === undefined) {
      return;
    }
    let entry = this.get(agentName, sessionId);
    if (!entry) {
      const now = new Date().toISOString();
      entry = {
        agentName,
        cwd: '',
        sessionId,
        createdAt: now,
        lastActiveAt: now,
      };
      this.entries.push(entry);
    }
    if (effort === null) {
      delete entry.reasoningEffort;
    } else {
      entry.reasoningEffort = effort;
    }
    void this.workspaceState.update(STATE_KEY, { version: 1, entries: this.entries });
  }

  /** Update title from a `session_info_update` notification. */
  setTitle(agentName: string, sessionId: string, title: string | null | undefined): void {
    if (title === undefined) {
      return;
    }
    let entry = this.get(agentName, sessionId);
    if (!entry) {
      // Entry may not exist yet for agent-sourced sessions that were
      // never created locally. Create one so the title persists.
      const now = new Date().toISOString();
      entry = {
        agentName,
        cwd: '',
        sessionId,
        createdAt: now,
        lastActiveAt: now,
      };
      this.entries.push(entry);
    }
    if (title === null) {
      delete entry.title;
    } else if (typeof title === 'string') {
      entry.title = title;
      // Bump lastActiveAt so renamed sessions float to the top.
      entry.lastActiveAt = new Date().toISOString();
    }
    this.persist();
  }
  /** User explicitly renamed a session via /rename. Sets userRenamed flag. */ userRename(
    agentName: string,
    sessionId: string,
    title: string,
  ): void {
    let entry = this.get(agentName, sessionId);
    if (!entry) {
      const now = new Date().toISOString();
      entry = { agentName, cwd: '', sessionId, createdAt: now, lastActiveAt: now };
      this.entries.push(entry);
    }
    entry.title = title;
    entry.userRenamed = true;
    entry.lastActiveAt = new Date().toISOString();
    this.persist();
  }

  /** Record the first user prompt of a session for label fallback. */
  setFirstPromptIfMissing(agentName: string, sessionId: string, prompt: string): void {
    const entry = this.get(agentName, sessionId);
    if (!entry || entry.firstPrompt) {
      return;
    }
    entry.firstPrompt = prompt.slice(0, MAX_PROMPT_LEN);
    // Persist silently — first prompt is just a fallback label, no need
    // to trigger a tree refresh.
    void this.workspaceState.update(STATE_KEY, { version: 1, entries: this.entries });
  }

  /** Bump `lastActiveAt` to now. Called on prompt end / session update. */
  touch(agentName: string, sessionId: string): void {
    const entry = this.get(agentName, sessionId);
    if (!entry) {
      return;
    }
    entry.lastActiveAt = new Date().toISOString();
    // Persist silently — don't fire onDidChange to avoid triggering a
    // tree refresh on every prompt. The tree doesn't need to re-render
    // just because lastActiveAt bumped.
    void this.workspaceState.update(STATE_KEY, { version: 1, entries: this.entries });
  }

  /** Remove a single entry (e.g. after a failed `session/load`). */
  forget(agentName: string, sessionId: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => !(e.agentName === agentName && e.sessionId === sessionId));
    if (this.entries.length !== before) {
      this.persist();
      return true;
    }
    return false;
  }

  /** Remove every entry for an agent. */
  forgetAgent(agentName: string): number {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.agentName !== agentName);
    const removed = before - this.entries.length;
    if (removed > 0) {
      this.persist();
    }
    return removed;
  }

  /**
   * Reconcile against an agent-provided list (called only when the agent
   * supports `session/list`). Keeps the local store consistent with the
   * agent for future use, but the tree itself uses the agent's list directly.
   */
  reconcileFromAgent(agentName: string, knownSessionIds: Set<string>): void {
    let changed = false;
    this.entries = this.entries.filter((e) => {
      if (e.agentName !== agentName) {
        return true;
      }
      if (knownSessionIds.has(e.sessionId)) {
        return true;
      }
      // Don't remove entries with user-set titles — they may be on a
      // later page of the agent's paginated session/list. Removing them
      // would lose the user's custom rename.
      if (e.title) {
        return true;
      }
      changed = true;
      return false;
    });
    if (changed) {
      this.persist();
    }
  }

  private enforceCap(agentName: string): void {
    const forAgent = this.list(agentName);
    if (forAgent.length <= this.capPerAgent) {
      return;
    }
    const surplus = forAgent.slice(this.capPerAgent);
    const stale = new Set(surplus.map((e) => e.sessionId));
    this.entries = this.entries.filter((e) => !(e.agentName === agentName && stale.has(e.sessionId)));
  }

  private persist(): void {
    const payload: PersistedShape = { version: 1, entries: this.entries };
    void this.workspaceState.update(STATE_KEY, payload);
    this._onDidChange.fire();
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

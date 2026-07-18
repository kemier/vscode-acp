/**
 * Helpers for the "Follow Agent" feature — mirrors Zed's
 * `workspace.follow(CollaboratorId::Agent)` flow (`zed-industries/zed::
 * crates/agent_ui/src/conversation_view/thread_view.rs::toggle_following` +
 * `crates/workspace/src/workspace.rs::handle_agent_location_changed`).
 *
 * The ACP protocol attaches `ToolCallLocation[]` to every `tool_call` and
 * `tool_call_update` notification:
 *
 *   interface ToolCallLocation { path: string; line?: number | null; }
 *
 * When following, the client auto-opens the first location of each new tool
 * call at the given line, allowing the user to watch the agent navigate the
 * codebase in real time.
 *
 * The helpers in this module are pure and don't touch vscode APIs, so they
 * can be unit-tested headlessly.
 */

import * as path from 'node:path';

export interface ToolCallLocationLike {
  path: string;
  line?: number | null;
}

export interface ResolvedAgentLocation {
  /** Absolute filesystem path. */
  absPath: string;
  /** 1-based line number; `undefined` when the agent didn't specify one. */
  line: number | undefined;
}

/**
 * Resolve an ACP `ToolCallLocation.path` to an absolute filesystem path.
 *
 *   - Absolute paths are returned as-is (normalised). The path is NOT filtered
 *     against the workspace — when the agent reads / edits a file outside the
 *     active repo (system header, installed dependency, sibling project, …),
 *     the follower opens it just the same. Matches Zed's behaviour.
 *   - Relative paths are resolved against the session `cwd` if supplied,
 *     else the first workspace root. `..` segments that climb above the
 *     anchor are honoured (cross-repo references resolve normally).
 *   - `~/...` is expanded against `homeDir`.
 *
 * Returns `undefined` if no anchor is available for a relative path or the
 * input is empty.
 */
export function resolveAgentLocationPath(
  loc: ToolCallLocationLike,
  opts: { sessionCwd?: string; workspaceRoot?: string; homeDir?: string } = {},
): string | undefined {
  if (!loc || typeof loc.path !== 'string' || loc.path.length === 0) {
    return undefined;
  }
  let p = loc.path;
  if ((p.startsWith('~/') || p === '~') && opts.homeDir) {
    p = p === '~' ? opts.homeDir : path.join(opts.homeDir, p.slice(2));
  }
  if (path.isAbsolute(p)) {
    return path.normalize(p);
  }
  const anchor = opts.sessionCwd ?? opts.workspaceRoot;
  if (!anchor) {
    return undefined;
  }
  return path.normalize(path.join(anchor, p));
}

/**
 * Pick the most useful location out of an `update.locations` array. Mirrors
 * Zed's behaviour of latching onto the FIRST location (`ix = 0`) when a tool
 * call advertises multiple — e.g. a multi-file edit lists each affected file
 * but the agent's logical focus is the first.
 *
 * Returns the resolved `{ absPath, line }` or `undefined` when the array is
 * empty or every entry has an unresolvable path.
 */
export function pickFollowTarget(
  locations: ToolCallLocationLike[] | undefined | null,
  opts: { sessionCwd?: string; workspaceRoot?: string; homeDir?: string } = {},
): ResolvedAgentLocation | undefined {
  if (!locations) {
    return undefined;
  }
  for (const loc of locations) {
    const absPath = resolveAgentLocationPath(loc, opts);
    if (absPath) {
      const line = typeof loc.line === 'number' && loc.line >= 1 ? Math.floor(loc.line) : undefined;
      return { absPath, line };
    }
  }
  return undefined;
}

/**
 * Coalesces a burst of agent-location updates: only the *latest* unique
 * target inside a `flushIntervalMs` window is acted on. Mirrors Zed's
 * behaviour of not flashing the editor through every file when an agent
 * uses a multi-file tool call.
 *
 * Two consecutive updates that resolve to the same `(absPath, line)` are
 * deduplicated even outside the window: the editor never re-opens what
 * it already opened.
 */
export class FollowCoalescer {
  private pending: ResolvedAgentLocation | null = null;
  private last: ResolvedAgentLocation | null = null;
  private timer: unknown = undefined;

  constructor(
    private readonly opts: {
      flushIntervalMs: number;
      onFlush: (target: ResolvedAgentLocation) => void;
      setTimeoutFn?: (fn: () => void, ms: number) => unknown;
      clearTimeoutFn?: (handle: unknown) => void;
    },
  ) {}

  private get _setTimeout(): (fn: () => void, ms: number) => unknown {
    return this.opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms) as unknown);
  }
  private get _clearTimeout(): (h: unknown) => void {
    return this.opts.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Submit a new target. Will fire `onFlush` later unless deduped. */
  submit(target: ResolvedAgentLocation): void {
    if (this.last && sameTarget(this.last, target)) {
      return;
    }
    this.pending = target;
    if (this.timer === undefined) {
      this.timer = this._setTimeout(() => this.flush(), this.opts.flushIntervalMs);
    }
  }

  /** Force-emit the pending target now (if any). */
  flush(): void {
    if (this.timer !== undefined) {
      this._clearTimeout(this.timer);
      this.timer = undefined;
    }
    const pending = this.pending;
    this.pending = null;
    if (!pending) {
      return;
    }
    if (this.last && sameTarget(this.last, pending)) {
      return;
    }
    this.last = pending;
    this.opts.onFlush(pending);
  }

  /** Reset state. Buffered target is dropped without emitting. */
  reset(): void {
    if (this.timer !== undefined) {
      this._clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pending = null;
    this.last = null;
  }
}

function sameTarget(a: ResolvedAgentLocation, b: ResolvedAgentLocation): boolean {
  return a.absPath === b.absPath && a.line === b.line;
}

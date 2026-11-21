/**
 * Quarantine session/update frames produced by a turn that has been superseded.
 *
 * A cancelled turn is not guaranteed to stop emitting. One agent we run waits 10s for the
 * old turn to unwind when a new prompt arrives and then proceeds regardless:
 *
 *   [turn] a turn is still running; aborting it before the new prompt starts
 *   [turn] previous turn did not unwind within 10000ms; starting the new prompt anyway
 *
 * so the old turn's frames arrive interleaved with the new turn's. The webview orders
 * tool groups by history index and a `.turn-tools` wrapper takes the MIN index of its
 * rows, so a straggling command row lands ABOVE the new turn's assistant reply, or merges
 * into an earlier group. Reported as "the command tool title jumps up after the assistant
 * message" after clicking Send Now on a queued message.
 *
 * The server cannot fix this by sequencing alone — proceeding with a live turn is
 * deliberate, so that Send Now is not blocked behind a turn that will not die. So the
 * client identifies superseded frames instead, from a turn id the agent stamps on every
 * session/update under its own `_meta` namespace (`_meta.<agent>.turnId`, a per-session
 * counter that only grows; ACP reserves `_meta` for such implementation-specific data).
 *
 * Deliberately narrow:
 *  - Only frames that carry a turn id are ever dropped. Agents that do not tag (codex-acp,
 *    claude-code-acp, pi-acp, kiro-cli, cursor) are completely unaffected.
 *  - Only frame kinds that affect render ORDER are dropped. Lifecycle and out-of-band
 *    frames still pass, because the client may be waiting on them to settle state.
 */

/** Frame kinds whose placement is ordered by history index, and so can corrupt it. */
const ORDER_BEARING_KINDS: ReadonlySet<string> = new Set([
  'tool_call',
  'tool_call_update',
  'agent_message_chunk',
  'agent_thought_chunk',
]);

export interface TurnTaggedUpdate {
  update?: {
    sessionUpdate?: string;
    _meta?: Record<string, unknown>;
  };
}

/** True for a usable turn id: a positive finite number (0 means no turn has begun). */
function isTurnId(raw: unknown): raw is number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0;
}

/**
 * The turn id a frame declares, or null when it carries none.
 *
 * Read from the first `_meta` namespace object that has a usable `turnId` — the agent's
 * own namespace, whatever it is called — so no agent name is hard-coded here.
 */
export function frameTurnId(notification: TurnTaggedUpdate): number | null {
  const meta = notification?.update?._meta;
  if (!meta || typeof meta !== 'object') {
    return null;
  }
  for (const value of Object.values(meta)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const raw = (value as { turnId?: unknown }).turnId;
      if (isTurnId(raw)) {
        return raw;
      }
    }
  }
  return null;
}

/**
 * Track the newest turn seen per session and decide whether a frame is superseded.
 *
 * Keyed by session id: two conversations advance independently, and a frame from session A
 * must never be judged against session B's turn.
 */
export class SupersededTurnFilter {
  private readonly newestTurn = new Map<string, number>();

  /**
   * Should this frame be dropped?
   *
   * Also advances the per-session high-water mark, so call it exactly once per frame and
   * in arrival order.
   */
  shouldDrop(sessionId: string, notification: TurnTaggedUpdate): boolean {
    const turnId = frameTurnId(notification);
    if (turnId === null) {
      return false; // untagged agent, or a frame emitted before any turn began
    }
    const newest = this.newestTurn.get(sessionId) ?? 0;
    if (turnId > newest) {
      // A new turn has started. Never drop: this frame defines the current turn.
      this.newestTurn.set(sessionId, turnId);
      return false;
    }
    if (turnId === newest) {
      return false;
    }
    // Older than the newest turn seen for this session — the emitting turn was replaced.
    const kind = String(notification?.update?.sessionUpdate ?? '');
    return ORDER_BEARING_KINDS.has(kind);
  }

  /** Newest turn observed for a session; 0 when none. Exposed for diagnostics. */
  newestTurnFor(sessionId: string): number {
    return this.newestTurn.get(sessionId) ?? 0;
  }

  /** Forget a session, e.g. on delete, so the map does not grow without bound. */
  forget(sessionId: string): void {
    this.newestTurn.delete(sessionId);
  }

  reset(): void {
    this.newestTurn.clear();
  }
}

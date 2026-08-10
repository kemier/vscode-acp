/**
 * Coalesces per-token streaming chunks (`agent_message_chunk` /
 * `agent_thought_chunk`) before forwarding them to the webview.
 *
 * Codex (and most LLM agents) emits one notification per LLM delta — typically
 * dozens per second. Forwarding each immediately means a postMessage IPC
 * roundtrip and a traffic-log entry per token. Buffering text for a few
 * milliseconds and flushing one combined chunk per kind reduces both metrics
 * by roughly (tokens/sec × flush_ms / 1000) — usually an order of magnitude.
 *
 * Ordering invariant: callers MUST call `flush()` for a session before
 * forwarding any non-chunk update for that session, so the agent's prose
 * appears in the chat ahead of any tool call / plan / completion marker that
 * followed the buffered tokens.
 *
 * Kind-order invariant: when thought and message chunks arrive in the same
 * window, they must be emitted in arrival order. Emitting message before a
 * still-buffered thought makes the webview finalize the current thought card
 * and open a second one for the delayed thought — consecutive duplicate /
 * split thinking blocks (seen especially with Kiro in collapsed mode).
 */

export type StreamChunkKind = 'message' | 'thought';

export interface StreamCoalescerOptions {
  /** Flush window in milliseconds. */
  flushIntervalMs: number;
  /** Called when the coalescer flushes a batched chunk. */
  onFlush: (
    sessionId: string,
    kind: StreamChunkKind,
    text: string,
    messageId?: string | null,
  ) => void;
  /** Override for setTimeout (testing). */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  /** Override for clearTimeout (testing). */
  clearTimeoutFn?: (handle: unknown) => void;
}

interface SessionBuffer {
  /** Ordered runs of the same kind+messageId; adjacent matching appends merge. */
  runs: Array<{ kind: StreamChunkKind; text: string; messageId?: string | null }>;
  timer?: unknown;
}

export class StreamCoalescer {
  private buffers = new Map<string, SessionBuffer>();
  private readonly opts: StreamCoalescerOptions;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;

  constructor(opts: StreamCoalescerOptions) {
    this.opts = opts;
    this.setTimeoutFn = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms) as unknown);
    this.clearTimeoutFn = opts.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /**
   * Append a text fragment to the buffer for `sessionId`.
   * `messageId` (ACP ContentChunk.messageId) groups chunks into one logical
   * message. Adjacent same-kind chunks with the SAME messageId merge into one
   * run; a messageId change starts a new run so a new message is not fused
   * with the prior one. Undefined messageId (agent doesn't emit one) is
   * treated as its own group — it never merges with a chunk that carries an
   * explicit id, preserving the legacy split-on-tool-boundary behavior.
   */
  append(
    sessionId: string,
    kind: StreamChunkKind,
    text: string,
    messageId?: string | null,
  ): void {
    if (!text) {
      return;
    }
    let buf = this.buffers.get(sessionId);
    if (!buf) {
      buf = { runs: [] };
      this.buffers.set(sessionId, buf);
    }
    const last = buf.runs.length > 0 ? buf.runs[buf.runs.length - 1] : null;
    if (last && last.kind === kind && last.messageId === messageId) {
      last.text += text;
    } else {
      buf.runs.push({ kind, text, messageId: messageId ?? undefined });
    }
    if (buf.timer === undefined) {
      buf.timer = this.setTimeoutFn(() => this.flush(sessionId), this.opts.flushIntervalMs);
    }
  }

  /**
   * Emit any buffered text for `sessionId` immediately and clear the buffer.
   * Safe to call when there's nothing pending (no-op).
   * Runs are emitted in arrival order so thought/message interleaving stays correct.
   */
  flush(sessionId: string): void {
    const buf = this.buffers.get(sessionId);
    if (!buf) {
      return;
    }
    if (buf.timer !== undefined) {
      this.clearTimeoutFn(buf.timer);
      buf.timer = undefined;
    }
    const runs = buf.runs;
    buf.runs = [];
    for (const run of runs) {
      if (run.text) {
        this.opts.onFlush(sessionId, run.kind, run.text, run.messageId);
      }
    }
  }

  /** Drop the buffer for a single session WITHOUT emitting its text. */
  drop(sessionId: string): void {
    const buf = this.buffers.get(sessionId);
    if (!buf) {
      return;
    }
    if (buf.timer !== undefined) {
      this.clearTimeoutFn(buf.timer);
    }
    this.buffers.delete(sessionId);
  }

  /** Drop all buffers without emitting. Used on dispose / clear-chat. */
  dropAll(): void {
    for (const buf of this.buffers.values()) {
      if (buf.timer !== undefined) {
        this.clearTimeoutFn(buf.timer);
      }
    }
    this.buffers.clear();
  }

  /** Internal: testing helper to inspect pending buffer state. */
  _pending(sessionId: string): { msg: string; thought: string } | undefined {
    const buf = this.buffers.get(sessionId);
    if (!buf) {
      return undefined;
    }
    let msg = '';
    let thought = '';
    for (const run of buf.runs) {
      if (run.kind === 'message') {
        msg += run.text;
      } else {
        thought += run.text;
      }
    }
    return { msg, thought };
  }
}

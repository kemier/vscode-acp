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
 */

export type StreamChunkKind = 'message' | 'thought';

export interface StreamCoalescerOptions {
  /** Flush window in milliseconds. */
  flushIntervalMs: number;
  /** Called when the coalescer flushes a batched chunk. */
  onFlush: (sessionId: string, kind: StreamChunkKind, text: string) => void;
  /** Override for setTimeout (testing). */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  /** Override for clearTimeout (testing). */
  clearTimeoutFn?: (handle: unknown) => void;
}

interface SessionBuffer {
  msg: string;
  thought: string;
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

  /** Append a text fragment to the buffer for `sessionId`. */
  append(sessionId: string, kind: StreamChunkKind, text: string): void {
    if (!text) {
      return;
    }
    let buf = this.buffers.get(sessionId);
    if (!buf) {
      buf = { msg: '', thought: '' };
      this.buffers.set(sessionId, buf);
    }
    if (kind === 'message') {
      buf.msg += text;
    } else {
      buf.thought += text;
    }
    if (buf.timer === undefined) {
      buf.timer = this.setTimeoutFn(() => this.flush(sessionId), this.opts.flushIntervalMs);
    }
  }

  /**
   * Emit any buffered text for `sessionId` immediately and clear the buffer.
   * Safe to call when there's nothing pending (no-op).
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
    if (buf.msg) {
      const text = buf.msg;
      buf.msg = '';
      this.opts.onFlush(sessionId, 'message', text);
    }
    if (buf.thought) {
      const text = buf.thought;
      buf.thought = '';
      this.opts.onFlush(sessionId, 'thought', text);
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
    return { msg: buf.msg, thought: buf.thought };
  }
}

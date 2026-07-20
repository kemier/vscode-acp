import * as assert from 'assert';
import { StreamCoalescer, type StreamChunkKind } from '../core/StreamCoalescer';

/**
 * Tiny fake timer that lets us drive `setTimeout` deterministically from tests.
 * Used in lieu of a heavyweight fake-timer library to keep the test suite
 * dependency-free.
 */
class FakeClock {
  private queue: Array<{ id: number; fn: () => void; due: number }> = [];
  private next = 1;
  private now = 0;
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.queue.push({ id, fn, due: this.now + ms });
    this.queue.sort((a, b) => a.due - b.due);
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.queue = this.queue.filter((q) => q.id !== handle);
  }
  /** Advance time by `ms`, firing any timers that come due (in due order). */
  advance(ms: number): void {
    this.now += ms;
    while (this.queue.length > 0 && this.queue[0].due <= this.now) {
      const t = this.queue.shift()!;
      t.fn();
    }
  }
  pendingCount(): number {
    return this.queue.length;
  }
}

interface Emit {
  sessionId: string;
  kind: StreamChunkKind;
  text: string;
}

function makeCoalescer(flushMs = 8) {
  const clock = new FakeClock();
  const emitted: Emit[] = [];
  const coalescer = new StreamCoalescer({
    flushIntervalMs: flushMs,
    onFlush: (sessionId, kind, text) => emitted.push({ sessionId, kind, text }),
    setTimeoutFn: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeoutFn: (h) => clock.clearTimeout(h),
  });
  return { coalescer, clock, emitted };
}

suite('StreamCoalescer', () => {
  test('coalesces N consecutive message chunks into a single flush', () => {
    const { coalescer, clock, emitted } = makeCoalescer(8);
    for (const ch of ['h', 'e', 'l', 'l', 'o']) {
      coalescer.append('s1', 'message', ch);
    }
    assert.strictEqual(emitted.length, 0, 'nothing emitted before flush window');
    clock.advance(10);
    assert.strictEqual(emitted.length, 1, `expected exactly 1 flush, got ${emitted.length}`);
    assert.deepStrictEqual(emitted[0], { sessionId: 's1', kind: 'message', text: 'hello' });
  });

  test('message + thought keep arrival order (no cross-kind merge)', () => {
    const { coalescer, clock, emitted } = makeCoalescer(8);
    coalescer.append('s1', 'message', 'hi ');
    coalescer.append('s1', 'thought', 'thinking…');
    coalescer.append('s1', 'message', 'world');
    clock.advance(10);
    // Kind switches must not merge the two message runs across the thought —
    // that would emit message-before-thought and split thinking cards in the UI.
    assert.strictEqual(emitted.length, 3);
    assert.deepStrictEqual(
      emitted.map((e) => ({ kind: e.kind, text: e.text })),
      [
        { kind: 'message', text: 'hi ' },
        { kind: 'thought', text: 'thinking…' },
        { kind: 'message', text: 'world' },
      ],
    );
  });

  test('thought before message in the same window emits thought first', () => {
    const { coalescer, clock, emitted } = makeCoalescer(8);
    coalescer.append('s1', 'thought', 'reason');
    coalescer.append('s1', 'message', 'answer');
    clock.advance(10);
    assert.strictEqual(emitted.length, 2);
    assert.deepStrictEqual(emitted[0], { sessionId: 's1', kind: 'thought', text: 'reason' });
    assert.deepStrictEqual(emitted[1], { sessionId: 's1', kind: 'message', text: 'answer' });
  });

  test('same-kind runs still coalesce across appends', () => {
    const { coalescer, clock, emitted } = makeCoalescer(8);
    coalescer.append('s1', 'thought', 'a');
    coalescer.append('s1', 'thought', 'b');
    coalescer.append('s1', 'thought', 'c');
    clock.advance(10);
    assert.strictEqual(emitted.length, 1);
    assert.deepStrictEqual(emitted[0], { sessionId: 's1', kind: 'thought', text: 'abc' });
  });

  test('flush() emits immediately and prevents the timer from firing later', () => {
    const { coalescer, clock, emitted } = makeCoalescer(50);
    coalescer.append('s1', 'message', 'now');
    coalescer.flush('s1');
    assert.strictEqual(emitted.length, 1);
    assert.strictEqual(emitted[0].text, 'now');
    clock.advance(100);
    assert.strictEqual(emitted.length, 1, 'no extra flush after manual flush');
    assert.strictEqual(clock.pendingCount(), 0, 'timer was cancelled');
  });

  test('drop() discards buffered text and prevents timer-based emission', () => {
    const { coalescer, clock, emitted } = makeCoalescer(8);
    coalescer.append('s1', 'message', 'discard-me');
    coalescer.drop('s1');
    clock.advance(100);
    assert.strictEqual(emitted.length, 0, 'dropped text must never be emitted');
    assert.strictEqual(clock.pendingCount(), 0);
  });

  test('per-session isolation: dropping one session does not affect another', () => {
    const { coalescer, clock, emitted } = makeCoalescer(8);
    coalescer.append('s1', 'message', 'A');
    coalescer.append('s2', 'message', 'B');
    coalescer.drop('s1');
    clock.advance(10);
    assert.strictEqual(emitted.length, 1);
    assert.deepStrictEqual(emitted[0], { sessionId: 's2', kind: 'message', text: 'B' });
  });

  test('dropAll() clears every session and cancels every timer', () => {
    const { coalescer, clock, emitted } = makeCoalescer(8);
    coalescer.append('s1', 'message', 'X');
    coalescer.append('s2', 'thought', 'Y');
    coalescer.append('s3', 'message', 'Z');
    coalescer.dropAll();
    clock.advance(100);
    assert.strictEqual(emitted.length, 0);
    assert.strictEqual(clock.pendingCount(), 0);
  });

  test('empty text is a no-op (does not schedule a flush)', () => {
    const { coalescer, clock, emitted } = makeCoalescer(8);
    coalescer.append('s1', 'message', '');
    assert.strictEqual(clock.pendingCount(), 0, 'no timer scheduled for empty text');
    clock.advance(10);
    assert.strictEqual(emitted.length, 0);
  });

  test('repeated append on a flushed buffer schedules a fresh timer', () => {
    const { coalescer, clock, emitted } = makeCoalescer(8);
    coalescer.append('s1', 'message', 'a');
    clock.advance(10);
    assert.strictEqual(emitted.length, 1);

    coalescer.append('s1', 'message', 'b');
    clock.advance(10);
    assert.strictEqual(emitted.length, 2);
    assert.strictEqual(emitted[1].text, 'b');
  });

  test('multiple appends within window create only ONE pending timer', () => {
    const { coalescer, clock } = makeCoalescer(8);
    for (const ch of 'helloworld') {
      coalescer.append('s1', 'message', ch);
    }
    assert.strictEqual(clock.pendingCount(), 1, 'one timer for many appends');
  });

  test('flush() on unknown session is a safe no-op', () => {
    const { coalescer, emitted } = makeCoalescer(8);
    coalescer.flush('does-not-exist');
    assert.strictEqual(emitted.length, 0);
  });
});

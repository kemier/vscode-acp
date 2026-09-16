import * as assert from 'assert';
import { SessionUpdateHandler } from '../handlers/SessionUpdateHandler';
import { SupersededTurnFilter, frameTurnId } from '../handlers/SupersededTurnFilter';

/**
 * Frames from a replaced turn must not reach the webview.
 *
 * Clicking Send Now on a queued message posts stopProcesses + cancelTurn, then sends the
 * queued prompt. But a cancelled turn is not guaranteed to stop emitting — ericli waits
 * 10s for it to unwind and then proceeds anyway. Captured live at 02:24 on 2026-09-16:
 *
 *   02:24:43.089  CLIENT → AGENT  session/stop
 *   02:24:43.089  CLIENT → AGENT  session/cancel
 *   02:24:48.493  CLIENT → AGENT  session/prompt
 *   02:24:48.496  [turn] a turn is still running; aborting it before the new prompt starts
 *   02:24:58.523  [turn] previous turn did not unwind within 10000ms; starting anyway
 *
 * The old turn's tool frames then interleave with the new turn's. The webview orders tool
 * groups by history index and a `.turn-tools` wrapper takes the MIN index of its rows, so
 * a straggling command row lands above the new turn's assistant reply or merges into an
 * earlier group — "the command tool title jumps up after the assistant message".
 */

function frame(turnId: number | null, kind: string, sessionId = 'sess-1'): never {
  const meta = turnId === null ? undefined : { ericli: { turnId } };
  return { sessionId, update: { sessionUpdate: kind, _meta: meta } } as never;
}

suite('superseded turn frames are quarantined', () => {
  test('frameTurnId reads the tag, and rejects junk', () => {
    assert.strictEqual(frameTurnId(frame(3, 'tool_call')), 3);
    assert.strictEqual(frameTurnId(frame(null, 'tool_call')), null);
    // 0 means "no turn has begun"; negatives and non-numbers are not ids.
    assert.strictEqual(frameTurnId(frame(0, 'tool_call')), null);
    assert.strictEqual(frameTurnId(frame(-1, 'tool_call')), null);
    assert.strictEqual(frameTurnId({} as never), null);
    assert.strictEqual(frameTurnId({ update: {} } as never), null);
  });

  test('the reported sequence: a straggler from turn 1 is dropped once turn 2 is live', () => {
    const f = new SupersededTurnFilter();
    // Turn 1 runs a command.
    assert.strictEqual(f.shouldDrop('sess-1', frame(1, 'tool_call')), false);
    // Send Now: turn 2 starts and emits.
    assert.strictEqual(f.shouldDrop('sess-1', frame(2, 'tool_call')), false);
    // Turn 1 did not unwind and emits its command's terminal frame.
    assert.strictEqual(f.shouldDrop('sess-1', frame(1, 'tool_call_update')), true);
    assert.strictEqual(f.shouldDrop('sess-1', frame(1, 'tool_call')), true);
    // Turn 2 keeps flowing.
    assert.strictEqual(f.shouldDrop('sess-1', frame(2, 'agent_message_chunk')), false);
  });

  test('every order-bearing kind is dropped when superseded', () => {
    const f = new SupersededTurnFilter();
    f.shouldDrop('s', frame(2, 'tool_call'));
    for (const kind of ['tool_call', 'tool_call_update', 'agent_message_chunk', 'agent_thought_chunk']) {
      assert.strictEqual(f.shouldDrop('s', frame(1, kind)), true, kind);
    }
  });

  test('lifecycle and out-of-band frames still pass when superseded', () => {
    // The client may be waiting on these to settle state; dropping them could wedge it.
    const f = new SupersededTurnFilter();
    f.shouldDrop('s', frame(2, 'tool_call'));
    for (const kind of [
      'usage_update', 'session_info_update', 'available_commands_update',
      'current_mode_update', 'plan', 'user_message_chunk',
    ]) {
      assert.strictEqual(f.shouldDrop('s', frame(1, kind)), false, kind);
    }
  });

  test('an untagged agent is never filtered', () => {
    // codex-acp, claude-code-acp, pi-acp, kiro-cli and cursor do not tag. They must be
    // completely unaffected, including out-of-order-looking sequences.
    const f = new SupersededTurnFilter();
    for (const kind of ['tool_call', 'tool_call_update', 'agent_message_chunk']) {
      assert.strictEqual(f.shouldDrop('s', frame(null, kind)), false, kind);
    }
  });

  test('sessions advance independently', () => {
    const f = new SupersededTurnFilter();
    f.shouldDrop('A', frame(5, 'tool_call', 'A'));
    // Session B is only on turn 1; A being on 5 must not condemn B's frames.
    assert.strictEqual(f.shouldDrop('B', frame(1, 'tool_call', 'B')), false);
    assert.strictEqual(f.newestTurnFor('A'), 5);
    assert.strictEqual(f.newestTurnFor('B'), 1);
  });

  test('the high-water mark only moves forward', () => {
    const f = new SupersededTurnFilter();
    f.shouldDrop('s', frame(3, 'tool_call'));
    f.shouldDrop('s', frame(1, 'tool_call')); // superseded, must not lower the mark
    assert.strictEqual(f.newestTurnFor('s'), 3);
    assert.strictEqual(f.shouldDrop('s', frame(2, 'tool_call')), true);
  });

  test('repeated frames from the current turn are all kept', () => {
    const f = new SupersededTurnFilter();
    for (let i = 0; i < 5; i++) {
      assert.strictEqual(f.shouldDrop('s', frame(4, 'tool_call')), false);
    }
  });

  test('forget resets a session without touching others', () => {
    const f = new SupersededTurnFilter();
    f.shouldDrop('A', frame(9, 'tool_call', 'A'));
    f.shouldDrop('B', frame(9, 'tool_call', 'B'));
    f.forget('A');
    assert.strictEqual(f.newestTurnFor('A'), 0);
    assert.strictEqual(f.newestTurnFor('B'), 9);
  });
});

suite('SessionUpdateHandler applies the filter', () => {
  test('a superseded frame never reaches a listener', () => {
    const h = new SessionUpdateHandler();
    const seen: string[] = [];
    h.addListener((u) => {
      seen.push(String((u as unknown as { update: { sessionUpdate: string } }).update.sessionUpdate));
    });
    h.handleUpdate(frame(1, 'tool_call'));
    h.handleUpdate(frame(2, 'agent_message_chunk'));
    h.handleUpdate(frame(1, 'tool_call_update')); // straggler
    h.handleUpdate(frame(2, 'tool_call'));
    assert.deepStrictEqual(seen, ['tool_call', 'agent_message_chunk', 'tool_call']);
  });

  test('a listener that throws does not stop the rest, and does not corrupt the mark', () => {
    const h = new SessionUpdateHandler();
    const seen: number[] = [];
    h.addListener(() => {
      throw new Error('boom');
    });
    h.addListener(() => seen.push(1));
    h.handleUpdate(frame(1, 'tool_call'));
    assert.deepStrictEqual(seen, [1]);
  });

  test('untagged frames pass through the handler untouched', () => {
    const h = new SessionUpdateHandler();
    let count = 0;
    h.addListener(() => {
      count += 1;
    });
    for (let i = 0; i < 3; i++) h.handleUpdate(frame(null, 'tool_call'));
    assert.strictEqual(count, 3);
  });
});

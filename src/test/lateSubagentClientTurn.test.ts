import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * A late subagent result must actually reach the agent, without a phantom turn.
 *
 * Reported: the agent said "Let me wait for the subagents to report... They should be
 * returning soon", emitted end_turn, and later the panel showed "A background subagent
 * finished after the turn ended" — but the main agent never picked it up. The result sat
 * queued until the user typed something.
 *
 * That was the deliberate trade-off of the previous fix. The agent used to call prompt()
 * itself, which opened a turn the client never asked for: in session 41e95918 that
 * produced 41 session/update notifications against ZERO client-owned session/prompt
 * requests, so the client could never close it and the panel latched. ACP has no
 * agent-initiated turn — the client's REQUEST is the turn.
 *
 * The way out is for the CLIENT to open the turn, since it owns and can close one.
 * ericli marks the notice _meta.subagentLateResult, the webview sends a real prompt with
 * the bubble suppressed, and ericli's steer queue drains the actual result into that
 * turn at its first tool-iteration boundary — so the nudge text carries no payload.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

suite('late subagent results open a client-owned turn', () => {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const at = src.indexOf('update._meta.subagentLateResult');
  const block = src.slice(Math.max(0, at - 1200), at + 1200);

  test('the marker is consumed', () => {
    assert.ok(at > 0, 'subagentLateResult not handled');
  });

  test('it sends a real prompt rather than faking a turn', () => {
    assert.ok(block.includes('handleSend();'), 'must go through the normal send path');
    assert.ok(block.includes('suppressNextUserBubble = true;'), 'the nudge is not shown as a user message');
  });

  test('it only fires when the session is idle', () => {
    // A running turn already absorbs the result through the steer queue, and sending
    // into one would collide with it.
    for (const g of ['!isProcessing', '!isSendingPrompt', '!isLoadingSession']) {
      assert.ok(block.includes(g), `missing guard ${g}`);
    }
  });

  test('it is capped so a follow-up cannot cascade', () => {
    // A follow-up turn can itself spawn subagents.
    assert.ok(block.includes('lateSubagentTurns < LATE_SUBAGENT_TURN_CAP'), 'cap not enforced');
    assert.ok(block.includes('lateSubagentTurns++'), 'counter not advanced');
    assert.ok(src.includes('var LATE_SUBAGENT_TURN_CAP = 5;'), 'cap not declared');
  });

  test('it runs BEFORE the row render and the break', () => {
    // Placed after the break it would be unreachable — which is how the first attempt
    // at this failed.
    const rowAt = src.indexOf('addCommandOutputRow(content.text);', at);
    const breakAt = src.indexOf('break;', at);
    assert.ok(rowAt > at, 'row render should follow the handler');
    assert.ok(breakAt > at, 'break should follow the handler');
    assert.ok(at < rowAt && at < breakAt, 'handler must precede both');
  });

  test('the condition is live, not short-circuited', () => {
    // A source-shape test passes happily against `if (false && ...)`. Assert the guard
    // is reachable, since that is the cheapest way to disable this by accident.
    const cond = src.slice(src.lastIndexOf('if (', at), at);
    assert.ok(!/\(\s*false\s*&&/.test(cond), 'condition must not be short-circuited');
    assert.ok(!/\(\s*0\s*&&/.test(cond), 'condition must not be short-circuited');
  });

  test('the nudge carries no result payload', () => {
    // The payload rides ericli's steer queue; duplicating it here would double-deliver.
    assert.ok(block.includes('Background subagent results have arrived'), 'nudge text present');
    assert.ok(!block.includes('content.text +'), 'must not splice the result into the nudge');
  });
});

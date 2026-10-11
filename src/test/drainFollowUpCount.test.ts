import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * A steered message whose delivered echo lands before promptEnd must still get
 * a follow-up turn.
 *
 * claude-code-acp delivers a steer as a FOLLOW-UP turn after the current turn
 * ends. The webview arms a drain window at promptEnd (drainFollowUpCount) so the
 * follow-up's idle chunks open a client-owned turn instead of being dropped. It
 * used to arm from messageQueue.filter(steered).length — but a steer whose
 * delivered echo (user_message_chunk) landed BEFORE promptEnd was already spliced
 * out of messageQueue by ackSteeredQueueEntry, so the filter armed 0 slots and the
 * follow-up's chunks were dropped: the bubble appeared in chat but no new turn ran
 * (the reported "queued msg shown but no turn" symptom).
 *
 * The fix counts steers SET this turn (steeredThisTurnCount, incremented at both
 * steer sites, reset alongside hasSteeredThisTurn) instead of counting steers
 * still in the queue.
 */

const ROOT = path.resolve(__dirname, '../..');
const provider = fs.readFileSync(path.join(ROOT, 'src/ui/ChatWebviewProvider.ts'), 'utf8');

suite('drain window armed from steers-set-this-turn, not steers-still-queued', () => {
  test('a per-turn counter is declared next to the boolean', () => {
    assert.ok(
      /let hasSteeredThisTurn = false;\s*\n\s*let steeredThisTurnCount = 0;/.test(provider),
      'steeredThisTurnCount declared as a proper let beside hasSteeredThisTurn',
    );
  });

  test('both steer sites increment the counter', () => {
    // The automatic-steer path and the manual-steer path both set the boolean;
    // each must also bump the counter so the count reflects steers SET, not steers
    // that survived in the queue.
    const incs = (provider.match(/hasSteeredThisTurn = true; steeredThisTurnCount\+\+/g) || []).length;
    assert.strictEqual(incs, 2, 'both steer sites increment steeredThisTurnCount');
  });

  test('every boolean reset also resets the counter', () => {
    const resets = (provider.match(/hasSteeredThisTurn = false; steeredThisTurnCount = 0;/g) || []).length;
    // 6 reset sites (setProcessing, load/switch resets, promptEnd tail, etc.) +
    // the declaration line is NOT a reset (it is `let ... = false;` on its own).
    assert.ok(resets >= 6, 'counter reset alongside boolean at every reset site');
  });

  test('the arming site reads the counter, not the queue filter', () => {
    const at = provider.indexOf('drainFollowUpCount = isClaudeAgent() && hasSteeredThisTurn');
    assert.ok(at > 0, 'arming site present');
    const arm = provider.slice(at, at + 200);
    assert.ok(arm.includes('steeredThisTurnCount'), 'arms from the per-turn counter');
    assert.ok(!arm.includes('messageQueue.filter'), 'no longer counts steers still in the queue');
  });

  test('the counter is consumed one slot per follow-up turn (unchanged)', () => {
    // closeClaudeDrainTurn decrements drainFollowUpCount so follow-ups 2..N each
    // get a slot. The fix must not have touched that consumption.
    assert.ok(
      provider.includes('if (drainFollowUpCount > 0) drainFollowUpCount--;'),
      'closeClaudeDrainTurn still consumes one slot per follow-up turn',
    );
  });
});

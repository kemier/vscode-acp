import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Regression: Send Now on a queued /clear raced the Claude drain arm.
 *
 * Observed (2026-11-04): Send Now parked /clear in pendingSendAfterCancel, but
 * claude-drain-turn-end flipped idle and FIFO-drained earlier queue items first.
 * /clear stayed latched, ran later without a UI wipe, then promptEnd drained
 * leftovers into the uncleared panel.
 *
 * Guards:
 *   - drainAfterDrainTurnClose / drainQueue skip while send-now is pending
 *   - /clear delivery uses handleLocalSlashCommand(..., true) to force the wipe
 *   - clearDiscardQueue drops leftovers on the /clear promptEnd
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

suite('Send Now /clear vs Claude drain race', () => {
  let src: string;
  suiteSetup(() => {
    src = fs.readFileSync(SOURCE, 'utf8');
  });

  test('drainAfterDrainTurnClose skips while send-now is pending', () => {
    const at = src.indexOf('function drainAfterDrainTurnClose()');
    assert.ok(at > 0, 'drainAfterDrainTurnClose missing');
    const body = src.slice(at, src.indexOf('\nfunction ', at + 10) > 0
      ? src.indexOf('\n    // Modes / models state', at)
      : at + 800);
    assert.ok(
      body.includes('sendNowPending || pendingSendAfterCancel'),
      'must gate FIFO drain on send-now: ' + body,
    );
    assert.ok(body.includes('SKIPPED — send-now pending'), body);
  });

  test('drainQueue also skips while send-now is pending', () => {
    const at = src.indexOf('function drainQueue()');
    assert.ok(at > 0);
    const body = src.slice(at, at + 900);
    assert.ok(body.includes('sendNowPending || pendingSendAfterCancel'), body);
  });

  test('pendingSendAfterCancel delivers /clear with force wipe', () => {
    const branch = src.indexOf('if (pendingSendAfterCancel) {');
    assert.ok(branch > 0);
    const seg = src.slice(branch, branch + 4500);
    assert.ok(seg.includes("handleLocalSlashCommand('/clear', true)"), seg);
    assert.ok(seg.includes("discardRemainingQueue('send-now-/clear-deliver')"), seg);
  });

  test('promptEnd discards leftovers after a /clear turn', () => {
    assert.ok(src.includes('clearDiscardQueue = true'), ' /clear must arm clearDiscardQueue');
    assert.ok(
      src.includes("discardRemainingQueue('post-/clear-promptEnd')"),
      'promptEnd must flush leftovers after /clear',
    );
  });

  test('handleLocalSlashCommand accepts force to bypass the mid-turn queue gate', () => {
    assert.ok(src.includes('function handleLocalSlashCommand(cmdText, force)'), src);
    const clearAt = src.indexOf("if (text === '/clear') {");
    assert.ok(clearAt > 0);
    const clearBody = src.slice(clearAt, clearAt + 500);
    assert.ok(clearBody.includes('if (isProcessing && !force)'), clearBody);
  });
});

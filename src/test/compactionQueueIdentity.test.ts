import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * flushCompactionMessages must preserve queued user bubbles by ENTRY IDENTITY,
 * not display text.
 *
 * Symptom: manual /compact while 'go on' is queued → 3 'go on' bubbles survive
 * the wipe. The old code keyed the preserve set on queueEntryDisplayText, so a
 * queued 'go on' preserved EVERY prior 'go on' bubble (already-sent turns that
 * belong to the compacted-away conversation). Identity stamps (entry.queueId,
 * carried onto the pushed chatHistory item) mean only the genuinely-queued
 * bubble survives.
 *
 * flushCompactionMessages is DOM-heavy and lives inside the webview template
 * literal, so — like messageQueue.test.ts — we assert the SHIPPED source shape
 * rather than executing it.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

suite('queueMessage stamps an identity id', () => {
  const src = fs.readFileSync(SOURCE, 'utf8');
  test('queueMessage assigns entry.queueId', () => {
    assert.ok(
      /entry\.queueId = 'q-' \+ Date\.now\(\) \+ '-' \+ Math\.random\(\)\.toString\(36\)\.slice\(2, 8\);/.test(src),
      'queueMessage must stamp a unique queueId on every entry',
    );
  });
});

suite('bubble helpers carry queueId onto the chatHistory item', () => {
  const src = fs.readFileSync(SOURCE, 'utf8');
  // All three push the same shape; count that the id is carried.
  const pushes = (src.match(/chatHistory\.push\(\{ kind: 'message', role: 'user', text: _display, queueId: entry\.queueId \}\);/g) || []).length;
  test('addUserBubbleEarly / addUserBubbleMidTurn / addUserBubbleForQueuedEntry all carry queueId', () => {
    assert.strictEqual(pushes, 3, 'exactly the three queued-bubble pushes must carry queueId: got ' + pushes);
  });
  test('no queued-bubble push drops the id (bare text-only push must be gone)', () => {
    const bare = (src.match(/chatHistory\.push\(\{ kind: 'message', role: 'user', text: _display \}\);/g) || []).length;
    assert.strictEqual(bare, 0, 'a queued-bubble push without queueId would let text-matching bugs return');
  });
});

suite('flushCompactionMessages preserves by identity, not text', () => {
  const src = fs.readFileSync(SOURCE, 'utf8');
  test('preserve set is keyed on queueId', () => {
    assert.ok(src.includes('var _queuedIds = {};'), 'the id-keyed preserve set must exist');
    assert.ok(
      /var _mqId = messageQueue\[_mqi\] && messageQueue\[_mqi\]\.queueId;/.test(src),
      'the set must be built from live messageQueue entries\' queueId',
    );
    assert.ok(/if \(_mqId\) _queuedIds\[_mqId\] = true;/.test(src), 'id-keyed insert');
  });
  test('the display-text key is gone', () => {
    assert.ok(!src.includes('var _queuedTexts = {};'), 'text-keyed preservation must not come back');
    assert.ok(!src.includes('queueEntryDisplayText(messageQueue[_mqi])'), 'no display-text keying of the preserve set');
  });
  test('a user bubble is preserved only when its queueId is live', () => {
    assert.ok(/var _qId = _qItem\.queueId;/.test(src), 'read the bubble\'s stamped id');
    assert.ok(/if \(!_qId \|\| !_queuedIds\[_qId\]\) continue;/.test(src), 'drop sent bubbles even when text matches a queued entry');
  });
});

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * "Thinking blocks grouped at the bottom" on resume.
 *
 * agent_thought_chunk had no idle-drop guard, unlike agent_message_chunk. A
 * thought arriving after session/load finished — the replay tail lands once
 * loadSessionEnd has already flipped isLoadingSession to false — was accepted
 * and appended, so it landed after the ENTIRE conversation.
 *
 * Measured on a Kiro resume: the last fold read
 *   R635 T636 R637 A638 … A669 T670 R672 R673 R674 … R681
 * i.e. correct interleaving up to 670, then ten thoughts in a row at the very
 * end of chatHistory (length 683), even though the wire delivered them
 * interleaved (host-post tail: RATtRATtRATt…).
 *
 * The predicate is extracted verbatim from the webview template literal in
 * ChatWebviewProvider.ts, the same pattern as messageQueue.test.ts.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

function loadPredicate(): (
  isLoadingSession: boolean,
  isProcessing: boolean,
  isCompacting: boolean,
  inTailGrace: boolean,
) => boolean {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const start = src.indexOf('function shouldDropIdleThoughtChunk(');
  assert.ok(start >= 0, 'shouldDropIdleThoughtChunk not found in ChatWebviewProvider.ts');
  const end = src.indexOf('\nfunction queueIsMutatingCommand', start);
  assert.ok(end > start, 'end marker after shouldDropIdleThoughtChunk not found');
  const body = src.slice(start, end).trim();
  return new Function(`${body}\nreturn shouldDropIdleThoughtChunk;`)() as any;
}

suite('idle thought-chunk drop (thinking grouped at the bottom)', () => {
  const drop = loadPredicate();

  test('drops a thought that arrives with nothing active', () => {
    // The stale replay tail: load finished, no turn running.
    assert.strictEqual(drop(false, false, false, false), true);
  });

  test('keeps thoughts during session/load replay', () => {
    assert.strictEqual(drop(true, false, false, false), false);
  });

  test('keeps thoughts while a turn is streaming', () => {
    assert.strictEqual(drop(false, true, false, false), false);
  });

  test('keeps thoughts during compaction', () => {
    assert.strictEqual(drop(false, false, true, false), false);
  });

  test('keeps a late final thought inside the turn-tail grace window', () => {
    // Agents (Codex, Kiro, Claude) flush a last chunk just after end_turn.
    assert.strictEqual(drop(false, false, false, true), false);
  });

  test('any active signal is enough to keep the chunk', () => {
    for (const [l, p, c, g] of [
      [true, true, false, false],
      [false, true, true, false],
      [true, false, false, true],
      [true, true, true, true],
    ] as Array<[boolean, boolean, boolean, boolean]>) {
      assert.strictEqual(drop(l, p, c, g), false, `expected keep for ${[l, p, c, g].join(',')}`);
    }
  });
});

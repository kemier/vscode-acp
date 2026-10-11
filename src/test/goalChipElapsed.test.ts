import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The goal chip's elapsed figure must count goal WORK, not wall-clock since the
 * goal was created.
 *
 * The old render computed `Math.max(secs, now - createdAt)`, so idle gaps
 * between prompts folded into the timer — the reported symptom was the chip
 * "continue ticking with the time added from previous" after a finished goal
 * re-armed on a new prompt. The fix (goalElapsedSecs) bases the figure on the
 * adapter's accumulated timeUsedSeconds and adds only the LIVE current turn.
 *
 * This EXTRACTS AND EXECUTES the real function (same pattern as
 * goalPreambleStrip.test.ts) so it cannot drift from the webview literal.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

function loadGoalElapsedSecs(): (
  goalSnapshot: any, isProcessing: boolean, turnStartedAt: number, now: number,
) => number {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const sig = 'function goalElapsedSecs(goalSnapshot, isProcessing, turnStartedAt, now) {';
  const at = src.indexOf(sig);
  assert.ok(at > 0, 'goalElapsedSecs not found in the webview literal');
  const open = src.indexOf('{', at);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') {depth++;}
    else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  assert.ok(end > 0, 'could not brace-match goalElapsedSecs');
  const body = src.slice(at, end).replace(/\\\\/g, '\\');
  assert.ok(!body.includes('${'), `unresolved interpolation: ${body}`);
  // The wall-clock form must be gone — that is the defect this test guards.
  assert.ok(!/Math\.max\(secs/.test(body), 'the wall-clock Math.max form must be removed');
  return new Function(
    'goalSnapshot', 'isProcessing', 'turnStartedAt', 'now',
    `${body}\nreturn goalElapsedSecs(goalSnapshot, isProcessing, turnStartedAt, now);`,
  ) as (g: any, p: boolean, t: number, n: number) => number;
}

const elapsed = loadGoalElapsedSecs();

suite('goal chip elapsed counts work, not wall-clock', () => {
  test('idle session shows the accumulated base unchanged', () => {
    // A goal that spent 120s of work, sitting idle now (isProcessing false).
    const snap = { status: 'active', timeUsedSeconds: 120, createdAt: 1_000_000 };
    assert.strictEqual(elapsed(snap, false, 0, 9_999_999_000), 120);
  });

  test('mid-turn adds only the live current turn', () => {
    // 120s of finished work + a turn that started 5s ago.
    const snap = { status: 'active', timeUsedSeconds: 120, createdAt: 1_000_000 };
    const turnStart = 9_999_999_000 - 5000;
    assert.strictEqual(elapsed(snap, true, turnStart, 9_999_999_000), 125);
  });

  test('the idle gap since creation is NOT counted (the reported symptom)', () => {
    // createdAt long ago, no live turn → base only, never now-createdAt.
    const snap = { status: 'active', timeUsedSeconds: 30, createdAt: 1_000 };
    assert.strictEqual(elapsed(snap, false, 0, 5_000_000), 30);
  });

  test('a paused goal adds nothing live', () => {
    const snap = { status: 'paused', timeUsedSeconds: 42, createdAt: 1_000 };
    assert.strictEqual(elapsed(snap, true, 9_999_999_000 - 5000, 9_999_999_000), 42);
  });

  test('Kiro snapshots (elapsedSecs, no createdAt) use the base', () => {
    const snap = { status: 'active', elapsedSecs: 18, createdAt: null };
    assert.strictEqual(elapsed(snap, false, 0, 9_999_999_000), 18);
  });

  test('missing base defaults to zero', () => {
    const snap = { status: 'active' };
    assert.strictEqual(elapsed(snap, false, 0, 9_999_999_000), 0);
  });
});

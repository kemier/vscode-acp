import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Resume must reveal a tool call's ORIGINAL recorded state.
 *
 * Send Now cancels the turn, which marks the session interrupted. The live
 * cancel path is correct (it fails only *running* stages). But the resume
 * sweeps used to rewrite stages recorded as completed/done/success/terminated
 * to `failed` whenever the session was flagged interrupted — so subagents that
 * genuinely finished showed red after Reload Window. A recorded terminal status
 * is authoritative; only unterminated stages get the failed inference.
 *
 * The spawn-tools stage map is EXTRACTED AND EXECUTED (pure). The two DOM
 * sweeps are asserted structurally on source (same pattern as
 * resumedCrewStageStatus.test.ts) — they need a DOM to run.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');
const src = fs.readFileSync(SOURCE, 'utf8');

function braceMatch(from: number): number {
  const open = src.indexOf('{', from);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

suite('resume preserves recorded terminal stage status', () => {
  test('spawn-tools stage map preserves recorded terminal, fails unterminated', () => {
    const anchor = 'stages: item.rawInput.stages.map(function(st) {';
    const at = src.indexOf(anchor);
    assert.ok(at > 0, 'spawn-tools stage map not found');
    const fnAt = src.indexOf('function(st) {', at);
    const end = braceMatch(fnAt);
    assert.ok(end > 0, 'could not brace-match the spawn stage map');
    const callback = src.slice(fnAt, end).replace(/\\\\/g, '\\');
    assert.ok(!callback.includes('${'), `unresolved interpolation: ${callback}`);
    const run = new Function('stages', `return stages.map(${callback});`) as (s: any[]) => any[];
    const out = run([
      { name: 'a', status: 'completed' },
      { name: 'b', status: 'running' },
      { name: 'c', status: 'done' },
      { name: 'd', status: 'pending' },
      { name: 'e', status: 'failed' },
      { name: 'f', status: 'success' },
      { name: 'g' },
    ]);
    assert.strictEqual(out[0].status, 'completed', 'completed must be preserved');
    assert.strictEqual(out[1].status, 'failed', 'running must be failed');
    assert.strictEqual(out[2].status, 'done', 'done must be preserved');
    assert.strictEqual(out[3].status, 'failed', 'pending must be failed');
    assert.strictEqual(out[4].status, 'failed', 'failed stays failed');
    assert.strictEqual(out[5].status, 'success', 'success must be preserved');
    assert.strictEqual(out[6].status, 'failed', 'missing status must be failed');
  });

  test('subagent-stages sweep no longer downgrades recorded-completed', () => {
    const sig = 'function failInterruptedSubagentStagesInHistory() {';
    const at = src.indexOf(sig);
    assert.ok(at > 0, 'failInterruptedSubagentStagesInHistory not found');
    const end = braceMatch(at);
    assert.ok(end > 0, 'could not brace-match failInterruptedSubagentStagesInHistory');
    const body = src.slice(at, end);
    assert.ok(
      !/sessionInterrupted\s*&&\s*\(\s*st === 'completed'/.test(body),
      'the completed→failed downgrade must be removed',
    );
    assert.ok(
      /if \(st === 'completed' \|\| st === 'done' \|\| st === 'success' \|\| st === 'terminated'\) continue;/.test(body),
      'recorded terminal statuses must be preserved via continue',
    );
  });

  test('DOM crew sweep skips stage icons already terminal', () => {
    const sig = 'function failCompletedCrewsInInterruptedTurn() {';
    const at = src.indexOf(sig);
    assert.ok(at > 0, 'failCompletedCrewsInInterruptedTurn not found');
    const end = braceMatch(at);
    assert.ok(end > 0, 'could not brace-match failCompletedCrewsInInterruptedTurn');
    const body = src.slice(at, end);
    assert.ok(
      /stageIcons\[s\]\.classList\.contains\('completed'\)/.test(body),
      'the DOM stage loop must skip completed icons',
    );
  });

  test('mergePreLoadInterruptedTurn failToolCopy preserves recorded terminal statuses', () => {
    // The 4th force-fail site: mergePreLoadInterruptedTurn re-injects the last
    // turn from the pre-load snapshot when Claude's session/load drops it — the
    // Send Now → Reload Window path. failToolCopy used to stamp EVERY tool call
    // and EVERY stage failed, red-crossing subagents that had completed.
    const sig = 'function failToolCopy(item) {';
    const at = src.indexOf(sig);
    assert.ok(at > 0, 'failToolCopy not found');
    const end = braceMatch(at);
    assert.ok(end > 0, 'could not brace-match failToolCopy');
    const fn = src.slice(at, end).replace(/\\\\/g, '\\');
    assert.ok(!fn.includes('${'), `unresolved interpolation: ${fn}`);
    const failToolCopy = new Function(`return (${fn});`)() as (item: any) => any;
    const out = failToolCopy({
      kind: 'toolCall',
      status: 'completed',
      rawInput: {
        stages: [
          { name: 'a', status: 'completed' },
          { name: 'b', status: 'running' },
          { name: 'c' },
        ],
      },
    });
    assert.strictEqual(out.status, 'completed', 'completed parent must be preserved');
    assert.strictEqual(out.rawInput.stages[0].status, 'completed', 'completed stage must be preserved');
    assert.strictEqual(out.rawInput.stages[1].status, 'failed', 'running stage must be failed');
    assert.strictEqual(out.rawInput.stages[2].status, 'failed', 'missing-status stage must be failed');
    const out2 = failToolCopy({ kind: 'toolCall', status: 'running', rawInput: { stages: [{ status: 'done' }] } });
    assert.strictEqual(out2.status, 'failed', 'running parent must be failed');
    assert.strictEqual(out2.rawInput.stages[0].status, 'done', 'done stage must be preserved under a failed parent');
  });
});

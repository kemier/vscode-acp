import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Plan mode blocks edits. Asking an agent to "implement it" while
 * `collaboration_mode` is still 'plan' gets the code printed in the chat instead
 * of written to disk, because the injected plan-mode preamble treats an execution
 * request as a request to PLAN the execution.
 *
 * Only some agents can leave the mode by themselves — codex via save_plan,
 * claude-code-acp via Claude's ExitPlanMode — and codex's design leaves it to the
 * user entirely. So the client offers the handoff for every agent.
 */
const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

suite('plan mode handoff', () => {
  const src = fs.readFileSync(SOURCE, 'utf8');

  test('plan mode is tracked from the collaboration_mode config option', () => {
    assert.ok(src.indexOf('function planModeValueFrom(opts)') > 0, 'plan-mode reader missing');
    const idx = src.indexOf('function planModeValueFrom(opts)');
    const body = src.slice(idx, idx + 500);
    assert.ok(body.indexOf("o.id === 'collaboration_mode'") > 0, 'must match the option id');
    assert.ok(body.indexOf("o.category === 'collaboration_mode'") > 0, 'must also match the category');
    assert.ok(src.indexOf("collabModeIsPlan = _planVal === 'plan'") > 0, 'mode flag not derived');
  });

  test('the offer needs BOTH plan mode and a plan produced this turn', () => {
    const idx = src.indexOf('function offerImplementPlan()');
    assert.ok(idx > 0, 'offerImplementPlan missing');
    const body = src.slice(idx, idx + 1200);
    assert.ok(
      body.indexOf('if (!collabModeIsPlan || !sawPlanThisTurn || implementPlanRowEl) return;') > 0,
      'guard must require plan mode, a plan this turn, and no duplicate row',
    );
    // Switching back is the whole point.
    assert.ok(body.indexOf("configId: 'collaboration_mode', value: 'default'") > 0, 'must switch to default');
  });

  test('a plan snapshot and a proposed_plan block both arm the offer', () => {
    assert.ok(
      src.indexOf('if ((update.entries || []).length > 0) sawPlanThisTurn = true;') > 0,
      'plan snapshot does not arm the offer',
    );
    assert.ok(
      src.indexOf("String(content.text || '').indexOf('<proposed_plan') >= 0") > 0,
      'proposed_plan text does not arm the offer',
    );
  });

  test('the offer is made at promptEnd and reset on the next promptStart', () => {
    assert.ok(src.indexOf('offerImplementPlan();') > 0, 'offer never made');
    assert.ok(src.indexOf('sawPlanThisTurn = false;') > 0, 'flag never reset');
    assert.ok(src.indexOf('clearImplementPlanRow();') > 0, 'stale row never cleared');
  });

  test('no backticks were introduced inside the webview template literal', () => {
    // The webview HTML is a template literal: a stray backtick truncates it and
    // the whole panel dies with a SyntaxError.
    const start = src.indexOf('function offerImplementPlan()');
    const end = src.indexOf('function setConfigOptionsState(opts)');
    assert.ok(start > 0 && end > start);
    assert.strictEqual(src.slice(start, end).indexOf('`'), -1, 'backtick inside the template literal');
  });
});

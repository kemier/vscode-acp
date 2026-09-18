import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * A task list must not be labelled a plan.
 *
 * ACP has ONE channel for two different things: an ordered strategy (an agent's
 * update_plan tool) and a task tracker. An agent with a task board reuses the plan
 * channel because that is where the plan bar lives, and the webview titled both
 * with a hardcoded "Plan" — so a todo list read as a strategy.
 *
 * The frame carries no kind of its own, so an agent that wants the distinction says
 * so in _meta.acp.plan. Two things this deliberately is NOT:
 *
 *   - not a per-agent name mapping: that labels by WHO sent it rather than what it
 *     is, and needs editing for every new adapter;
 *   - not a protocol change: absent meta keeps "Plan", so every agent that says
 *     nothing renders exactly as before.
 */

const ROOT = path.resolve(__dirname, '../..');
const provider = fs.readFileSync(path.join(ROOT, 'src/ui/ChatWebviewProvider.ts'), 'utf8');

/** Run the real planBarTitle, extracted from the webview literal. */
function loadPlanBarTitle(): (plan: unknown) => string {
  const sig = 'function planBarTitle(plan) {';
  const at = provider.indexOf(sig);
  assert.ok(at > 0, 'planBarTitle not found in the webview literal');
  const open = provider.indexOf('{', at);
  let depth = 0;
  let end = -1;
  for (let i = open; i < provider.length; i++) {
    if (provider[i] === '{') {
      depth++;
    } else if (provider[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  assert.ok(end > 0, 'unbalanced braces in planBarTitle');
  return new Function(`${provider.slice(at, end)}; return planBarTitle;`)() as (p: unknown) => string;
}

suite('plan bar title distinguishes a plan from a todo list', () => {
  const planBarTitle = loadPlanBarTitle();

  test('no meta keeps the old label, so nothing regresses', () => {
    // Every agent that has not opted in sends no hint.
    assert.strictEqual(planBarTitle({ entries: [] }), 'Plan');
    assert.strictEqual(planBarTitle({}), 'Plan');
    assert.strictEqual(planBarTitle(null), 'Plan');
    assert.strictEqual(planBarTitle(undefined), 'Plan');
  });

  test('kind todo renders as Todos', () => {
    assert.strictEqual(planBarTitle({ _meta: { acp: { plan: { kind: 'todo' } } } }), 'Todos');
  });

  test('an explicit title wins over the kind mapping', () => {
    // The agent knows its own vocabulary better than a fixed mapping does: one
    // may call them Tasks, another Steps.
    assert.strictEqual(
      planBarTitle({ _meta: { acp: { plan: { kind: 'todo', title: 'Tasks' } } } }),
      'Tasks',
    );
    assert.strictEqual(planBarTitle({ _meta: { acp: { plan: { title: 'Steps' } } } }), 'Steps');
  });

  test('a blank or non-string title falls back instead of rendering nothing', () => {
    // An empty title would leave the bar with no heading at all.
    assert.strictEqual(planBarTitle({ _meta: { acp: { plan: { title: '   ' } } } }), 'Plan');
    assert.strictEqual(planBarTitle({ _meta: { acp: { plan: { title: 42 } } } }), 'Plan');
    assert.strictEqual(
      planBarTitle({ _meta: { acp: { plan: { kind: 'todo', title: '' } } } }),
      'Todos',
    );
  });

  test('an unknown kind is not invented into a label', () => {
    assert.strictEqual(planBarTitle({ _meta: { acp: { plan: { kind: 'whatever' } } } }), 'Plan');
    assert.strictEqual(planBarTitle({ _meta: { acp: { plan: { kind: 'plan' } } } }), 'Plan');
  });

  test('malformed meta cannot throw — the bar must still render', () => {
    for (const bad of [
      { _meta: null },
      { _meta: {} },
      { _meta: { acp: null } },
      { _meta: { acp: {} } },
      { _meta: { acp: { plan: null } } },
      { _meta: 'nonsense' },
    ]) {
      assert.strictEqual(planBarTitle(bad), 'Plan');
    }
  });

  test('the title is escaped, since an agent supplies it', () => {
    const at = provider.indexOf("'<div class=\"plan-title\">' + escapeHtml(planBarTitle(plan))");
    assert.ok(at > 0, 'agent-supplied title is not HTML-escaped');
  });

  test('it is agent-agnostic — no adapter names in the resolver', () => {
    const sig = 'function planBarTitle(plan) {';
    const body = provider.slice(provider.indexOf(sig), provider.indexOf(sig) + 900);
    for (const name of ['ericli', 'EricCLI', 'codex', 'kiro', 'cursor']) {
      assert.ok(!body.includes(name), `resolver mentions ${name} — label by kind, not by sender`);
    }
  });
});

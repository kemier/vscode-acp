import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Plan approval must show the plan.
 *
 * cursor/create_plan carries a REQUIRED `plan` field — a markdown body describing
 * the whole plan — plus an optional `phases` grouping. The handler read neither:
 * approval was a modal reading "name: overview", so the user approved a plan they
 * could not see, and an accepted plan left no record of what had been agreed.
 *
 * The renderer under test is extracted from the real webview source. It is
 * deliberately agent-neutral: it reads name/overview/plan/todos/phases and does
 * not know which method delivered them.
 */
suite('plan proposal rendering', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts'), 'utf8');

  function extract(signature: string): string {
    const start = src.indexOf(signature);
    assert.ok(start >= 0, `${signature} not found`);
    let depth = 0;
    for (let i = start; i < src.length; i++) {
      if (src[i] === '{') {
        depth++;
      } else if (src[i] === '}' && --depth === 0) {
        return src.slice(start, i + 1);
      }
    }
    throw new Error(`unbalanced braces extracting ${signature}`);
  }

  const format = new Function(
    `${extract('function formatPlanProposal(msg) {')}; return formatPlanProposal;`,
  )() as (msg: unknown) => string;

  // The documented example request, which is what a client is entitled to expect.
  const docExample = {
    name: 'Refactor tabs layout',
    overview: 'Tighten layout behavior and preserve existing UX.',
    plan: '1. Inspect current tab sizing logic.\n2. Update layout calculations.\n3. Verify editor behavior.',
    todos: [
      { id: 'todo-1', content: 'Inspect current tab sizing logic', status: 'completed' },
      { id: 'todo-2', content: 'Update layout calculations', status: 'in_progress' },
      { id: 'todo-3', content: 'Verify editor behavior', status: 'pending' },
    ],
  };

  test('the plan markdown body is present — the whole point of the fix', () => {
    const out = format(docExample);
    assert.ok(out.includes('Inspect current tab sizing logic.'), 'plan body line 1 missing');
    assert.ok(out.includes('Update layout calculations.'), 'plan body line 2 missing');
    assert.ok(out.includes('Verify editor behavior.'), 'plan body line 3 missing');
  });

  test('name and overview are still shown', () => {
    const out = format(docExample);
    assert.ok(out.includes('Refactor tabs layout'));
    assert.ok(out.includes('Tighten layout behavior'));
  });

  test('todo status is distinguishable, including cancelled', () => {
    const out = format({
      todos: [
        { content: 'done thing', status: 'completed' },
        { content: 'running thing', status: 'in_progress' },
        { content: 'later thing', status: 'pending' },
        { content: 'dropped thing', status: 'cancelled' },
      ],
    });
    assert.ok(out.includes('[x] done thing'), 'completed');
    assert.ok(out.includes('[~] running thing'), 'in_progress');
    assert.ok(out.includes('[ ] later thing'), 'pending');
    assert.ok(out.includes('[-] dropped thing'), 'cancelled');
  });

  test('phases are grouped under their names', () => {
    const out = format({
      name: 'Big change',
      phases: [
        { name: 'Investigate', todos: [{ content: 'read the code', status: 'completed' }] },
        { name: 'Implement', todos: [{ content: 'write the code', status: 'pending' }] },
      ],
    });
    assert.ok(out.includes('Investigate'), 'first phase name');
    assert.ok(out.includes('Implement'), 'second phase name');
    assert.ok(out.indexOf('Investigate') < out.indexOf('Implement'), 'phase order preserved');
    assert.ok(out.includes('[x] read the code'));
    assert.ok(out.includes('[ ] write the code'));
  });

  test('phases and todos describe the SAME work — entries are not listed twice', () => {
    // This is the trap: phases group the todos rather than adding to them, so
    // rendering both produces every entry twice.
    const out = format({
      todos: [
        { content: 'alpha', status: 'pending' },
        { content: 'beta', status: 'pending' },
      ],
      phases: [
        { name: 'One', todos: [{ content: 'alpha', status: 'pending' }] },
        { name: 'Two', todos: [{ content: 'beta', status: 'pending' }] },
      ],
    });
    assert.strictEqual(out.split('alpha').length - 1, 1, 'alpha listed more than once');
    assert.strictEqual(out.split('beta').length - 1, 1, 'beta listed more than once');
    assert.ok(out.includes('One') && out.includes('Two'), 'grouping should win when present');
  });

  test('empty phases fall back to the flat list instead of showing nothing', () => {
    const out = format({
      todos: [{ content: 'only entry', status: 'pending' }],
      phases: [{ name: 'Empty phase', todos: [] }],
    });
    assert.ok(out.includes('only entry'), 'the flat list must be used when no phase has entries');
  });

  test('a plan with no todos at all still renders its body', () => {
    const out = format({ name: 'Thinking out loud', plan: 'Just prose, no checklist.' });
    assert.ok(out.includes('Just prose, no checklist.'));
    assert.ok(out.includes('Thinking out loud'));
  });

  test('missing and malformed fields do not throw', () => {
    for (const bad of [
      {},
      { todos: null },
      { phases: null },
      { todos: [null] },
      { phases: [null] },
      { phases: [{ todos: null }] },
      { todos: [{}] },
      { name: 0, overview: 0, plan: 0 },
    ]) {
      const out = format(bad as unknown);
      assert.strictEqual(typeof out, 'string', `${JSON.stringify(bad)} should still yield a string`);
      assert.ok(out.includes('Plan'), 'a heading is always present');
    }
  });

  suite('host wiring', () => {
    const ext = fs.readFileSync(path.resolve(__dirname, '../../src/extension.ts'), 'utf8');
    const handlerStart = ext.indexOf("sessionManager.on('cursor-create-plan'");
    assert.ok(handlerStart > 0, 'create_plan handler not found');
    const handler = (() => {
      let depth = 0;
      for (let i = handlerStart; i < ext.length; i++) {
        if (ext[i] === '{') {
          depth++;
        } else if (ext[i] === '}' && --depth === 0) {
          return ext.slice(handlerStart, i + 1);
        }
      }
      throw new Error('unbalanced braces in the create_plan handler');
    })();

    test('the plan is shown BEFORE the decision is requested', () => {
      const shown = handler.indexOf('notifyPlanProposal');
      const asked = handler.indexOf('askQuestion');
      assert.ok(shown > 0, 'the plan is never shown');
      assert.ok(asked > 0, 'the decision is never requested');
      assert.ok(shown < asked, 'the plan must be on screen before the buttons appear');
    });

    test('all three protocol outcomes are still produced', () => {
      for (const outcome of ["outcome: 'accepted'", "outcome: 'rejected'", "outcome: 'cancelled'"]) {
        assert.ok(handler.includes(outcome), `${outcome} missing`);
      }
    });

    test('the modal fallback carries the plan body, not just the name', () => {
      // askQuestion returns null when there is no webview; the fallback must not
      // regress to the name-only dialog this change exists to remove.
      assert.ok(handler.includes('showInformationMessage'), 'no fallback at all');
      assert.ok(handler.includes('detail:'), 'the fallback must pass a detail body');
      assert.ok(/planBody \|\| overview/.test(handler), 'the fallback should prefer the plan body');
    });

    test('planUri is not fabricated', () => {
      // Optional in the protocol, and we have no document to point at. A
      // synthesised URI would be a claim we cannot honour.
      assert.ok(!handler.includes('planUri:'), 'planUri must not be invented');
    });
  });
});

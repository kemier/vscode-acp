import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Kiro's task board must reach the plan bar.
 *
 * I spent several turns concluding kiro "cannot" show a todo list over ACP, because
 * it sends no `sessionUpdate: "plan"` frame and no `_kiro.dev` task method. Both
 * true, and both irrelevant: the board travels inside an ORDINARY tool_call, with
 * the whole thing in rawInput, which the client already receives and used only for
 * the row title. Captured live:
 *
 *   { "sessionUpdate": "tool_call", "title": "todo_list",
 *     "rawInput": { "command": "create",
 *                   "task_list_description": "…",
 *                   "tasks": [ { "task_description": "…", "details": "…" } ] } }
 *
 *   { "rawInput": { "command": "complete", "completed_task_ids": ["1","2"], … } }
 *
 * So nothing upstream was missing; the data was being dropped here. The lesson is
 * that searching for the SHAPE I expected (a plan frame, a namespaced method) hid
 * data that was in plain sight.
 *
 * Ids are POSITIONAL: create sends no ids, complete refers to "1"/"2", so the
 * numbering is the 1-based order of the create.
 */

const ROOT = path.resolve(__dirname, '../..');
const provider = fs.readFileSync(path.join(ROOT, 'src/ui/ChatWebviewProvider.ts'), 'utf8');

/** Brace-matched body of a webview function, past parameter and return types. */
function bodyOf(signature: string): string {
  const at = provider.indexOf(signature);
  assert.ok(at > 0, `not found: ${signature}`);
  const open = provider.indexOf('{', provider.indexOf(')', at));
  let depth = 0;
  for (let i = open; i < provider.length; i++) {
    if (provider[i] === '{') {
      depth++;
    } else if (provider[i] === '}') {
      depth--;
      if (depth === 0) {
        return provider.slice(at, i + 1);
      }
    }
  }
  throw new Error(`unbalanced braces after ${signature}`);
}

/** The REAL mapper, executed with addPlan captured. */
function harness() {
  const code = bodyOf('function applyKiroTodoList(');
  let captured: any = null;
  const apply = new Function(
    'addPlan',
    `var kiroTodoState = null; ${code}; return applyKiroTodoList;`,
  )((p: any) => {
    captured = p;
  }) as (title: string, toolName: string, rawInput: unknown) => void;
  return { apply, get plan() { return captured; } };
}

const CREATE = {
  command: 'create',
  task_list_description: 'Option C: persist subagent findings into memory',
  tasks: [
    { task_description: 'Map both ends', details: 'copy the delegate pattern' },
    { task_description: 'ericli: emit findings' },
    { task_description: 'Extension: capture' },
  ],
};

suite('kiro todo_list feeds the plan bar', () => {
  test('a create builds the board', () => {
    const h = harness();
    h.apply('todo_list', 'todo_list', CREATE);
    assert.ok(h.plan, 'no plan emitted');
    assert.deepStrictEqual(
      h.plan.entries.map((e: any) => e.content),
      ['Map both ends', 'ericli: emit findings', 'Extension: capture'],
    );
    assert.deepStrictEqual(
      h.plan.entries.map((e: any) => e.status),
      ['pending', 'pending', 'pending'],
    );
  });

  test('it is labelled like every other checklist', () => {
    const h = harness();
    h.apply('todo_list', 'todo_list', CREATE);
    assert.deepStrictEqual(h.plan._meta, { acp: { plan: { kind: 'todo', title: 'Todos' } } });
  });

  test('a complete flips the right entries, by POSITION', () => {
    // The reported payload: completed_task_ids ["1","2"] against a 3-task create.
    const h = harness();
    h.apply('todo_list', 'todo_list', CREATE);
    h.apply('todo_list', 'todo_list', { command: 'complete', completed_task_ids: ['1', '2'] });
    assert.deepStrictEqual(
      h.plan.entries.map((e: any) => e.status),
      ['completed', 'completed', 'pending'],
    );
  });

  test('an out-of-range or junk id is ignored, not crashed on', () => {
    const h = harness();
    h.apply('todo_list', 'todo_list', CREATE);
    h.apply('todo_list', 'todo_list', { command: 'complete', completed_task_ids: ['9', '0', 'x', ''] });
    assert.deepStrictEqual(
      h.plan.entries.map((e: any) => e.status),
      ['pending', 'pending', 'pending'],
    );
  });

  test('add appends, keeping the positional ids stable', () => {
    const h = harness();
    h.apply('todo_list', 'todo_list', CREATE);
    h.apply('todo_list', 'todo_list', { command: 'add', new_tasks: [{ task_description: 'Fourth' }] });
    h.apply('todo_list', 'todo_list', { command: 'complete', completed_task_ids: ['4'] });
    assert.strictEqual(h.plan.entries.length, 4);
    assert.strictEqual(h.plan.entries[3].content, 'Fourth');
    assert.strictEqual(h.plan.entries[3].status, 'completed');
  });

  test('remove drops by position', () => {
    const h = harness();
    h.apply('todo_list', 'todo_list', CREATE);
    h.apply('todo_list', 'todo_list', { command: 'remove', remove_task_ids: ['2'] });
    assert.deepStrictEqual(
      h.plan.entries.map((e: any) => e.content),
      ['Map both ends', 'Extension: capture'],
    );
  });

  test('a list command changes nothing', () => {
    const h = harness();
    h.apply('todo_list', 'todo_list', CREATE);
    const before = h.plan.entries.map((e: any) => e.status).join();
    h.apply('todo_list', 'todo_list', { command: 'list' });
    assert.strictEqual(h.plan.entries.map((e: any) => e.status).join(), before);
  });

  test('an unknown command does not wipe the board', () => {
    const h = harness();
    h.apply('todo_list', 'todo_list', CREATE);
    h.apply('todo_list', 'todo_list', { command: 'reticulate' });
    assert.strictEqual(h.plan.entries.length, 3);
  });

  test('only the todo_list tool triggers it', () => {
    // Matched on the tool NAME plus a command, never on prose — a shell command
    // that mentions todos must not build a board.
    const h = harness();
    h.apply('shell', 'execute_bash', { command: 'grep -rn todo_list src/' });
    assert.strictEqual(h.plan, null);
    // The sharper case: another tool whose rawInput happens to carry a command the
    // mapper understands. Without the tool-name guard this would build a board out
    // of an unrelated CLI invocation — and a weaker version of this test let a
    // mutation that removed the guard pass.
    h.apply('shell', 'execute_bash', {
      command: 'create',
      tasks: [{ task_description: 'not a todo at all' }],
    });
    assert.strictEqual(h.plan, null, 'a non-todo_list tool built a board');
    h.apply('todo_list', 'todo_list', { notACommand: true });
    assert.strictEqual(h.plan, null);
    h.apply('todo_list', 'todo_list', null);
    assert.strictEqual(h.plan, null);
  });

  test('blank task descriptions are dropped', () => {
    const h = harness();
    h.apply('todo_list', 'todo_list', {
      command: 'create',
      tasks: [{ task_description: 'Real' }, { task_description: '   ' }, {}],
    });
    assert.deepStrictEqual(h.plan.entries.map((e: any) => e.content), ['Real']);
  });

  test('a create with no usable tasks emits nothing', () => {
    const h = harness();
    h.apply('todo_list', 'todo_list', { command: 'create', tasks: [] });
    assert.strictEqual(h.plan, null);
  });

  test('the tool row is NOT suppressed', () => {
    // It is a real tool call; hiding it would conceal that the agent touched its
    // task list. Contrast the cursor placeholders right above, which ARE dropped.
    const at = provider.indexOf('applyKiroTodoList(update.title, _tcToolName, update.rawInput)');
    assert.ok(at > 0, 'mapper not wired into the tool_call path');
    const after = provider.slice(at, at + 200);
    assert.ok(!/^\s*break;/m.test(after.split('\n').slice(1, 3).join('\n')), 'row suppressed');
  });

  test('no raw backtick in the added webview code', () => {
    // A backtick inside the template literal terminates it — this exact mistake
    // broke the build while writing this, and is documented in AGENTS.md.
    assert.ok(!bodyOf('function applyKiroTodoList(').includes('`'));
  });
});

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
  // The webview function also calls resumeDiag (a gated diagnostic) and reads
  // isLoadingSession; both must be supplied or the extraction throws — the harness
  // has to track the real dependencies, not a snapshot of them.
  const apply = new Function(
    'addPlan',
    'resumeDiag',
    `var kiroTodoState = null; var isLoadingSession = false; ${code}; return applyKiroTodoList;`,
  )(
    (p: any) => {
      captured = p;
    },
    () => {
      /* diagnostic sink */
    },
  ) as (title: string, toolName: string, rawInput: unknown) => void;
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

/**
 * The board must be dropped with its conversation — but NOT at a turn boundary.
 *
 * kiro sends a create in one turn and completes in LATER turns, referring to tasks
 * by their position in that create. So clearing the state per turn would leave every
 * later complete with nothing to apply to and the board permanently unchecked.
 * Cursor can be cleared per turn because it re-sends its whole list each time.
 *
 * Nothing cleared it at all before this: cursor's board is cleared in five
 * lifecycle places, kiro's in zero, so a previous session's board could outlive it.
 */
suite('kiro board lifecycle', () => {
  test('a reset helper exists next to the state it owns', () => {
    assert.ok(provider.includes('function clearKiroTodoList()'), 'no reset helper');
    const body = bodyOf('function clearKiroTodoList(');
    assert.ok(body.includes('kiroTodoState = null'), 'helper does not reset');
  });

  test('it is called on load, clear and compaction', () => {
    const calls = (provider.match(/clearKiroTodoList === 'function'\) clearKiroTodoList\(\)/g) ?? []).length;
    assert.strictEqual(calls, 3, `expected 3 lifecycle resets, found ${calls}`);
  });

  test('it is NOT called on promptStart or a plain re-render', () => {
    // These two are the cases that would break a create-then-complete-later flow.
    for (const ctx of ["case 'promptStart':", 'function renderChatHistory()']) {
      const at = provider.indexOf(ctx);
      assert.ok(at > 0, `context not found: ${ctx}`);
      // Scan to the next clearCursorTodosPlan in that block and check what follows.
      const cursorAt = provider.indexOf('clearCursorTodosPlan();', at);
      assert.ok(cursorAt > at, `no cursor clear after ${ctx}`);
      const after = provider.slice(cursorAt, cursorAt + 240);
      assert.ok(!after.includes('clearKiroTodoList()'), `kiro board cleared in ${ctx}`);
    }
  });

  test('cursor merge:false does not wipe the kiro board', () => {
    // That is cursor's own replace semantics, not a conversation reset.
    const at = provider.indexOf('if (!params.merge) clearCursorTodosPlan();');
    assert.ok(at > 0, 'cursor merge branch not found');
    assert.ok(
      !provider.slice(at, at + 200).includes('clearKiroTodoList()'),
      'a cursor todo update clears kiro',
    );
  });

  test('a reset makes later completes inert rather than throwing', () => {
    // After a reset the next frame must be a create; a stray complete is ignored.
    const h = harness();
    h.apply('todo_list', 'todo_list', { command: 'complete', completed_task_ids: ['1'] });
    assert.strictEqual(h.plan, null, 'a complete with no board emitted something');
  });
});

suite('the diagnostic trace', () => {
  test('both frames and renders are traced, gated on acp.debugResume', () => {
    // The unchecked-after-resume question could not be answered from the traffic
    // log: the ACP output channel rotates, and the relevant capture was gone twice
    // (once pre-fix, once when the log root rotated on reload). Tracing what the
    // WEBVIEW sees removes the dependency on a log that may not survive.
    assert.ok(provider.includes('[WV-KIROTODO]'), 'frame trace missing');
    assert.ok(provider.includes('[WV-PLANRENDER]'), 'render trace missing');
    // resumeDiag is the existing gate (acp.debugResume) — not a new setting, and
    // silent when the flag is off.
    for (const marker of ['[WV-KIROTODO]', '[WV-PLANRENDER]']) {
      const at = provider.indexOf(marker);
      const before = provider.slice(Math.max(0, at - 120), at);
      assert.ok(before.includes('resumeDiag('), `${marker} not behind resumeDiag`);
    }
  });

  test('the frame trace records what actually decides the outcome', () => {
    const at = provider.indexOf('[WV-KIROTODO]');
    const line = provider.slice(at, provider.indexOf(');', at));
    for (const field of ['cmd=', 'ids=', 'entries=', 'statuses=', 'loading=']) {
      assert.ok(line.includes(field), `trace omits ${field}`);
    }
  });

  test('the render trace shows the statuses that reached the DOM', () => {
    // If the frames arrive correct but the bar renders stale, only this side shows it.
    const at = provider.indexOf('[WV-PLANRENDER]');
    const line = provider.slice(at, provider.indexOf(');', at));
    assert.ok(line.includes('statuses='), 'render trace omits statuses');
    assert.ok(line.includes('loading='), 'render trace omits the replay flag');
  });

  test('no raw backtick — it would terminate the webview literal', () => {
    const at = provider.indexOf('[WV-KIROTODO]');
    assert.ok(!provider.slice(at - 400, at + 600).includes('`'));
  });
});

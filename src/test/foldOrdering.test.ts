import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Regression test for compact-mode fold ordering.
 *
 * Unlike the other webview tests, this does NOT reimplement the logic — it
 * extracts the real `orderCompactFoldContents()` from ChatWebviewProvider.ts
 * (the function lives inside the webview template literal, so it cannot be
 * imported) and runs it against a minimal fake DOM.
 *
 * The bug it guards: tool groups rendered on the live streaming path carried no
 * `data-history-index`, so the sort scored them `Number.MAX_SAFE_INTEGER` and
 * every group sank below the thoughts / interim assistant segments. Expanding a
 * fold mid-turn then showed "all thoughts, then all tools" instead of the real
 * chronology thought → tools → text → tools.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

function extractOrderFunction(): string {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const startIdx = src.indexOf('function orderCompactFoldContents(body) {');
  assert.ok(startIdx >= 0, 'orderCompactFoldContents not found in ChatWebviewProvider.ts');
  const endMarker = '/** Place the visible final assistant summary';
  const endIdx = src.indexOf(endMarker, startIdx);
  assert.ok(endIdx > startIdx, 'end marker after orderCompactFoldContents not found');
  return src.slice(startIdx, endIdx).trim();
}

interface FakeEl {
  className: string;
  children: FakeEl[];
  parentElement: FakeEl | null;
  classList: { contains(c: string): boolean };
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  querySelector(selector: string): FakeEl | null;
  appendChild(child: FakeEl): FakeEl;
}

function makeEl(className: string, historyIndex?: number, foldSortKey?: number): FakeEl {
  const attrs: Record<string, string> = {};
  if (historyIndex !== undefined) {
    attrs['data-history-index'] = String(historyIndex);
  }
  if (foldSortKey !== undefined) {
    attrs['data-fold-sort-key'] = String(foldSortKey);
  }
  const el: FakeEl = {
    className,
    children: [],
    parentElement: null,
    classList: { contains: (c: string) => className.split(' ').indexOf(c) >= 0 },
    getAttribute: (n: string) => (n in attrs ? attrs[n] : null),
    setAttribute: (n: string, v: string) => {
      attrs[n] = String(v);
    },
    querySelector: (selector: string) => {
      if (selector !== '[data-history-index]') {
        return null;
      }
      const walk = (node: FakeEl): FakeEl | null => {
        for (const c of node.children) {
          if (c.getAttribute('data-history-index') !== null) {
            return c;
          }
          const found = walk(c);
          if (found) {
            return found;
          }
        }
        return null;
      };
      return walk(el);
    },
    appendChild: (child: FakeEl) => {
      if (child.parentElement) {
        const siblings = child.parentElement.children;
        const i = siblings.indexOf(child);
        if (i >= 0) {
          siblings.splice(i, 1);
        }
      }
      child.parentElement = el;
      el.children.push(child);
      return child;
    },
  };
  return el;
}

type Spec = Array<[string, number | undefined, number?, number?]>;

function order(spec: Spec): string {
  const vscodeStub = { postMessage: () => undefined };
  const factory = new Function('vscode', 'return (' + extractOrderFunction() + ')');
  const orderCompactFoldContents = factory(vscodeStub) as (body: FakeEl) => void;

  const turn = makeEl('turn');
  const body = makeEl('turn-fold-body');
  turn.appendChild(body);
  for (const [cls, idx, childIdx, foldSortKey] of spec) {
    const el = makeEl(cls, idx, foldSortKey);
    if (childIdx !== undefined) {
      el.appendChild(makeEl('tool-call-inline', childIdx));
    }
    body.appendChild(el);
  }
  orderCompactFoldContents(body);
  return body.children.map((c) => c.className.split(' ')[0]).join(' | ');
}

suite('compact fold ordering', () => {
  test('tool groups without a history stamp keep their interleaved position', () => {
    // Shape observed live in the [WV-ORDER] log: thoughts stamped, tool groups not.
    const result = order([
      ['thought-block', 130],
      ['turn-tools', undefined],
      ['thought-block', 132],
      ['turn-tools', undefined],
      ['message assistant assistant-interim', 136],
      ['turn-tools', undefined],
    ]);
    assert.strictEqual(result, 'thought-block | turn-tools | thought-block | turn-tools | message | turn-tools');
  });

  test('tool groups resolve an index from their stamped rows', () => {
    const result = order([
      ['thought-block', 130],
      ['turn-tools', undefined, 131],
      ['thought-block', 132],
      ['turn-tools', undefined, 133],
      ['message assistant assistant-interim', 136],
      ['turn-tools', undefined, 137],
    ]);
    assert.strictEqual(result, 'thought-block | turn-tools | thought-block | turn-tools | message | turn-tools');
  });

  test('out-of-order DOM is re-sorted by history index', () => {
    const result = order([
      ['turn-tools', 137],
      ['thought-block', 130],
      ['message assistant assistant-interim', 136],
      ['turn-tools', 131],
    ]);
    assert.strictEqual(result, 'thought-block | turn-tools | message | turn-tools');
  });

  test('a mis-indexed trailing tool sorts after the reply without an override', () => {
    // Resume merge can stamp the turn's last tool ABOVE the final reply
    // (tool#318 vs summary#317). This is the raw (buggy) shape: expanding the
    // fold then shows the tool call AFTER the summary.
    const result = order([
      ['turn-tools', 316],
      ['message assistant assistant-interim', 317],
      ['turn-tools', 318],
    ]);
    assert.strictEqual(result, 'turn-tools | message | turn-tools');
  });

  test('data-fold-sort-key pins the demoted summary after the trailing tool', () => {
    // What the fold expander does: the demoted summary is known to be the
    // turn's final reply, so it is pinned behind every completed tool.
    const result = order([
      ['turn-tools', 316],
      ['message assistant assistant-interim', 317, undefined, 318.5],
      ['turn-tools', 318],
    ]);
    assert.strictEqual(result, 'turn-tools | turn-tools | message');
  });

  test('expanding a fold pins the demoted summary via data-fold-sort-key', () => {
    // Source guard: the expand branch must stamp the override, otherwise the
    // index sort drops the reply above the mis-indexed trailing tool again.
    const src = fs.readFileSync(SOURCE, 'utf8');
    const expandIdx = src.indexOf(
      "var _outsideAsst = turn.querySelectorAll(':scope > .message.assistant.assistant-summary');",
    );
    assert.ok(expandIdx > 0, 'fold expand branch missing');
    const after = src.slice(expandIdx, expandIdx + 2000);
    assert.ok(
      after.indexOf("a.setAttribute('data-fold-sort-key'") > 0,
      'expand branch does not pin the demoted summary',
    );
    assert.ok(
      after.indexOf('turnElHasRunningTools(tc)') > 0,
      'expand branch must ignore running tools when computing the pin',
    );
  });

  test('promote never re-homes tool groups out of the fold body', () => {
    // A .turn-tools moved onto the turn itself stays visible while collapsed
    // (compact mode only hides .turn-fold-body), which leaked a stray tool card
    // next to the summary.
    const src = fs.readFileSync(SOURCE, 'utf8');
    const promoteIdx = src.indexOf('function promoteFinalAssistantForTurn(');
    assert.ok(promoteIdx > 0, 'promoteFinalAssistantForTurn missing');
    const body = src.slice(promoteIdx, src.indexOf('function sessionMarkedInterrupted', promoteIdx));
    assert.ok(
      body.indexOf('turn.insertBefore(tc, summaryEl)') < 0,
      'promote must not move tool groups outside the fold body',
    );
  });

  test('the live tool path stamps the history index it just pushed', () => {
    // Guards the addToolCall → stampToolHistoryIndex wiring that produces the
    // stamps the sort depends on.
    const src = fs.readFileSync(SOURCE, 'utf8');
    assert.ok(src.indexOf('function stampToolHistoryIndex(') >= 0, 'stampToolHistoryIndex helper missing');
    const addToolCallIdx = src.indexOf(
      'addToolCallInline(toolCallId, title, status, rawInput, toolKind, locations, null);',
    );
    assert.ok(addToolCallIdx > 0, 'live addToolCallInline call site missing');
    const after = src.slice(addToolCallIdx, addToolCallIdx + 400);
    assert.ok(
      after.indexOf('stampToolHistoryIndex(toolCallId, _tcHistoryIndex)') >= 0,
      'live path does not stamp the tool history index',
    );
  });

  test('a tool arriving after the final assistant text sorts by its stamped row', () => {
    // The case 74b63f7 targets: during streaming the assistant text is committed,
    // then one more tool call arrives. Its .turn-tools wrapper is created after the
    // stamp pass, so the wrapper itself carries no data-history-index — only the tool
    // row inside it does. Without resolving the key from that row the group scores
    // MAX_SAFE_INTEGER and sinks below the assistant, which is what showed up as the
    // last tool rendering together with the final message.
    const result = order([
      ['thought-block', 200],
      ['turn-tools', undefined, 201],
      ['message assistant assistant-interim', 202],
      ['turn-tools', undefined, 203],
    ]);
    assert.strictEqual(
      result,
      'thought-block | turn-tools | message | turn-tools',
      'the trailing tool group must stay after the assistant segment it followed',
    );
  });

  test('an unstamped trailing group keeps its append position, it does not jump the assistant', () => {
    // Same shape but with nothing stamped inside the trailing group at all: the
    // preceding-key + 0.5 rule must keep it where it was appended rather than
    // hoisting it above the assistant text that preceded it.
    const result = order([
      ['thought-block', 200],
      ['message assistant assistant-interim', 202],
      ['turn-tools', undefined],
    ]);
    assert.strictEqual(result, 'thought-block | message | turn-tools');
  });

  test('promptEnd re-sorts AFTER ensureTurnFoldStructure, which reorders after its own sort', () => {
    // ensureTurnFoldStructure sorts the fold body and only THEN lifts the summary
    // assistant out of it (turn.insertBefore / turn.appendChild), so its own sort
    // does not see the final layout. promptEnd therefore has to sort once more,
    // otherwise the last tool group's position is whatever the restructure left.
    const src = fs.readFileSync(SOURCE, 'utf8');
    const fnAt = src.indexOf('function ensureTurnFoldStructure');
    const internalSort = src.indexOf('orderCompactFoldContents(body);', fnAt);
    const liftOut = src.indexOf('summaryAssistants.forEach(function(a) {', internalSort);
    assert.ok(internalSort > 0 && liftOut > internalSort, 'the lift-out must follow the internal sort');

    // The promptEnd call site specifically — ensureTurnFoldStructure is called from
    // several places, and only this one re-fetches _endBody afterwards.
    // lastIndexOf: the first hit is the initial `var _endBody` declaration made
    // before the restructure; the re-fetch after it is the one that matters.
    const reFetch = src.lastIndexOf('_endBody = getTurnFoldBody(currentTurnEl);');
    assert.ok(reFetch > 0, 'promptEnd re-fetches the fold body after restructuring');
    const after = src.slice(reFetch - 400, reFetch + 400);
    assert.ok(after.includes('ensureTurnFoldStructure(currentTurnEl, true);'), after.slice(0, 200));
    assert.ok(
      after.includes('if (_endBody && !suppressFoldOrdering) orderCompactFoldContents(_endBody);'),
      'promptEnd must re-sort the fold body after the restructure',
    );
    // Guarded the same way every other ordering call is, so renderChatHistory is unaffected.
    assert.ok(after.indexOf('suppressFoldOrdering') < after.indexOf('orderCompactFoldContents(_endBody)'));
  });
});

/**
 * A resumed auto-compacted session can replay with ZERO user rows (the
 * compaction fired at the session tail, so the surviving post-compact region is
 * the summary plus the compacting turn's own assistant/tool activity). The
 * render loop opens turns only on user/system/error rows, so all 94 items used
 * to collapse into ONE turn; promoteFinalAssistantForTurn then lifted an
 * arbitrary assistant (the highest history index) to the visible summary while
 * every other message/tool stacked above it inside the fold.
 *
 * The fix: when a history has no user rows, split at each SEALED work unit — an
 * assistant whose turn's tools are all complete and none follow it. This suite
 * extracts the real `userRowlessTurnLooksSealed` from the webview template
 * literal and runs it against a fake DOM (same pattern as the fold-ordering
 * suite above).
 */
function extractSealedFunction(): string {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const startIdx = src.indexOf('function userRowlessTurnLooksSealed(turn) {');
  assert.ok(startIdx >= 0, 'userRowlessTurnLooksSealed not found in ChatWebviewProvider.ts');
  // The function ends at the first "\n  }" that closes it — the next sibling
  // declaration is `var turnThoughts = [];`. Slice to that marker instead of
  // brace-matching so the extractor stays simple and fails loudly if the
  // surrounding code moves.
  const endIdx = src.indexOf('var turnThoughts = [];', startIdx);
  assert.ok(endIdx > startIdx, 'end marker after userRowlessTurnLooksSealed not found');
  return src.slice(startIdx, endIdx).trim();
}

interface FakeNode {
  className: string;
  attrs: Record<string, string>;
  children: FakeNode[];
  getAttribute(name: string): string | null;
  querySelector(sel: string): FakeNode | null;
  querySelectorAll(sel: string): FakeNode[];
  appendChild(c: FakeNode): FakeNode;
}

function makeNode(className: string, historyIndex?: number): FakeNode {
  const node: FakeNode = {
    className,
    attrs: historyIndex !== undefined ? { 'data-history-index': String(historyIndex) } : {},
    children: [],
    getAttribute: (n: string) => (n in node.attrs ? node.attrs[n] : null),
    querySelector: (sel: string) => {
      const all = node.querySelectorAll(sel);
      return all.length ? all[0] : null;
    },
    querySelectorAll: (sel: string) => {
      // Selectors here are single-class ('.tool-call-inline') or
      // compound-class ('.message.assistant'); match the LAST class token in
      // each, which is the most specific and sufficient for these fakes.
      const classes = sel
        .split(',')
        .map((s) => {
          const tokens = s.trim().split(/\s+/).pop() || '';
          const dotted = tokens.split('.').filter(Boolean);
          return dotted.length ? dotted[dotted.length - 1] : '';
        })
        .filter(Boolean);
      const out: FakeNode[] = [];
      const walk = (n: FakeNode): void => {
        for (const c of n.children) {
          if (classes.some((cl) => c.className.split(' ').indexOf(cl) >= 0)) {
            out.push(c);
          }
          walk(c);
        }
      };
      walk(node);
      return out;
    },
    appendChild: (c: FakeNode) => {
      node.children.push(c);
      return c;
    },
  };
  return node;
}

function sealed(spec: Array<[string, number?]>): boolean {
  const factory = new Function('return (' + extractSealedFunction() + ')');
  const fn = factory() as (t: FakeNode) => boolean;
  const turn = makeNode('turn');
  for (const [cls, idx] of spec) {
    // In the real DOM a tool row is a `.tool-call-inline` nested inside its
    // `.turn-tools` wrapper; the helper queries the inner row for its index.
    if (cls === 'turn-tools') {
      const wrapper = makeNode('turn-tools');
      wrapper.appendChild(makeNode('tool-call-inline', idx));
      turn.appendChild(wrapper);
    } else {
      turn.appendChild(makeNode(cls, idx));
    }
  }
  return fn(turn);
}

suite('user-rowless turn splitting', () => {
  test('a turn whose tools all precede its final reply is sealed', () => {
    assert.strictEqual(
      sealed([
        ['turn-tools', 1],
        ['message assistant', 2],
      ]),
      true,
    );
  });

  test('a turn with a tool AFTER its latest reply is not sealed', () => {
    // The reply was not the end of the work unit — the turn is still open.
    assert.strictEqual(
      sealed([
        ['message assistant', 2],
        ['turn-tools', 3],
      ]),
      false,
    );
  });

  test('a still-running tool keeps the turn open', () => {
    assert.strictEqual(
      sealed([
        ['turn-tools', 1],
        ['tc-icon running', 2],
        ['message assistant', 2],
      ]),
      false,
    );
  });

  test('a turn with no assistant cannot be sealed', () => {
    assert.strictEqual(sealed([['turn-tools', 1]]), false);
  });

  test('the split is wired into the assistant branch of renderChatHistory', () => {
    // Source guard: the helper existing is not enough — it must be consulted
    // (and the turn reset) on the assistant path, gated on a user-rowless history.
    const src = fs.readFileSync(SOURCE, 'utf8');
    const callIdx = src.indexOf('userRowlessTurnLooksSealed(currentTurnEl)');
    assert.ok(callIdx > 0, 'the sealed check is never called');
    const before = src.slice(callIdx - 400, callIdx);
    assert.ok(before.indexOf('!_historyHasUserRows') >= 0, 'the split must be gated on a user-rowless history');
    const after = src.slice(callIdx, callIdx + 400);
    assert.ok(
      after.indexOf('currentTurnEl = null') >= 0,
      'the split must reset the current turn so the next row opens a new one',
    );
    assert.ok(
      src.indexOf('var _historyHasUserRows = false;') >= 0,
      'the user-row scan must exist in renderChatHistory',
    );
  });
});

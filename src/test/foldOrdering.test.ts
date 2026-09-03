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

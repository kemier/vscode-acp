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
});

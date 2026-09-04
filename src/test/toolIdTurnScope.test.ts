import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * "Send Now" mixed the interrupted turn into the new one.
 *
 * Reported symptoms: the running tool call showed failed, its result then showed
 * again under the NEW prompt, and the old turn's assistant text appeared in the
 * new turn before the new answer streamed.
 *
 * Cause is a tool-call id collision across turns. Traffic log 06:25:51-52 shows
 * the cancelled turn reaching tc-8 and the replacement turn opening at tc-1 —
 * codex declared its counter inside the per-turn prompt handler, so numbering
 * restarted. On the client, `toolCalls` was never cleared between turns and DOM
 * ids are 'tc-' + wireId, so the new turn's tc-1 resolved to the PREVIOUS turn's
 * element (getElementById returns the older of two duplicate ids).
 *
 * The agent side now mints ids from session state; this guards the client so any
 * agent that reuses ids cannot cross turns either.
 *
 * The real functions are extracted from the webview template literal (they cannot
 * be imported) and run against DOM stubs — same pattern as foldOrdering.test.ts
 * and sendNowOrdering.test.ts.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

function extractFn(name: string, endMarker: string): string {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' not found in ChatWebviewProvider.ts');
  const end = src.indexOf(endMarker, start);
  assert.ok(end > start, 'end marker after ' + name + ' not found');
  return src.slice(start, end).trim();
}

interface FakeEl {
  id: string;
  attrs: Record<string, string>;
  setAttribute: (k: string, v: string) => void;
  getAttribute: (k: string) => string | null;
  removeAttribute: (k: string) => void;
}

function makeEl(id: string, attrs: Record<string, string> = {}): FakeEl {
  const el: FakeEl = {
    id,
    attrs: { ...attrs },
    setAttribute(k, v) {
      el.attrs[k] = String(v);
    },
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(el.attrs, k) ? el.attrs[k] : null;
    },
    removeAttribute(k) {
      delete el.attrs[k];
    },
  };
  return el;
}

interface Harness {
  retire: () => number;
  lookup: (id: string) => any;
  register: (id: string, el: FakeEl) => void;
  liveKeys: () => string[];
}

function makeHarness(all: FakeEl[]): Harness {
  const retireBody = extractFn('retireToolCallRegistry', '\n  function lookupToolCallEl(');
  const lookupBody = extractFn('lookupToolCallEl', '\n  /**');

  const factory = new Function(
    'all',
    `
    let toolCalls = {};
    let retiredToolCalls = {};
    let toolIdRetireGen = 0;
    const document = {
      querySelectorAll: function (sel) {
        if (sel !== '[data-tool-call-id]') return [];
        return all.filter(function (e) { return e.getAttribute('data-tool-call-id') !== null; });
      },
      // Duplicate ids resolve to the FIRST match, exactly like the browser.
      getElementById: function (id) {
        for (var i = 0; i < all.length; i++) { if (all[i].id === id) return all[i]; }
        return null;
      },
    };
    function toolCallElementId(id) { return 'tc-' + String(id || ''); }
    function toolCallIdLookupKeys(id) { return [String(id || '')]; }
    ${retireBody}
    ${lookupBody}
    return {
      retire: retireToolCallRegistry,
      lookup: lookupToolCallEl,
      register: function (id, el) { toolCalls[id] = el; },
      liveKeys: function () { return Object.keys(toolCalls); },
    };
  `,
  );
  return factory(all) as Harness;
}

suite('tool-call ids are scoped to their turn', () => {
  test('a new turn reusing tc-1 does not resolve to the previous turn element', () => {
    const oldRow = makeEl('tc-tc-1', { 'data-tool-call-id': 'tc-1' });
    const all = [oldRow];
    const h = makeHarness(all);
    h.register('tc-1', oldRow);

    // Sanity: before the boundary the id resolves to the old row.
    assert.strictEqual(h.lookup('tc-1'), oldRow);

    // The user hits Send Now → the turn closes and a new one opens.
    assert.strictEqual(h.retire(), 1, 'one row should be retired');
    assert.deepStrictEqual(h.liveKeys(), [], 'the live registry must be empty');

    // The replacement turn creates its own tc-1.
    const newRow = makeEl('tc-tc-1', { 'data-tool-call-id': 'tc-1' });
    all.push(newRow);
    h.register('tc-1', newRow);

    assert.strictEqual(h.lookup('tc-1'), newRow, 'must resolve to the NEW turn row, not the old one');
  });

  test('retiring renames the DOM id so getElementById cannot return the old row', () => {
    const oldRow = makeEl('tc-tc-1', { 'data-tool-call-id': 'tc-1' });
    const all = [oldRow];
    const h = makeHarness(all);
    h.register('tc-1', oldRow);
    h.retire();

    assert.strictEqual(oldRow.id, 'retired-0-tc-tc-1');
    assert.strictEqual(oldRow.getAttribute('data-live-tool-el-id'), 'tc-tc-1');
    // Stage selectors keyed on the live attribute must no longer match it.
    assert.strictEqual(oldRow.getAttribute('data-tool-call-id'), null);
    assert.strictEqual(oldRow.getAttribute('data-retired-tool-call-id'), 'tc-1');

    // With nothing live under that id, the retired row is still reachable so a
    // late update from the closed turn can finish it.
    assert.strictEqual(h.lookup('tc-1'), oldRow, 'no live tc-1: falls back to the retired row');
  });

  test('a late update from the cancelled turn lands on its original row', () => {
    // The agent started a tool 750ms AFTER the cancel and reported it later.
    const oldRow = makeEl('tc-tc-8', { 'data-tool-call-id': 'tc-8' });
    const all = [oldRow];
    const h = makeHarness(all);
    h.register('tc-8', oldRow);
    h.retire();

    const newRow = makeEl('tc-tc-1', { 'data-tool-call-id': 'tc-1' });
    all.push(newRow);
    h.register('tc-1', newRow);

    assert.strictEqual(h.lookup('tc-8'), oldRow, 'the late tc-8 update belongs to the turn that made it');
    assert.strictEqual(h.lookup('tc-1'), newRow, 'and must not be confused with the new turn');
  });

  test('both turn-opening paths retire the registry, and the agent mints unique ids', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    // addMessage('user', …) — normal send.
    assert.ok(
      /if \(role === 'user'\) \{[\s\S]{0,600}?retireToolCallRegistry\(\)/.test(src),
      'addMessage user path must retire the registry',
    );
    // addUserBubbleForQueuedEntry — the Send Now path.
    assert.ok(
      /addUserBubbleForQueuedEntry[\s\S]{0,900}?retireToolCallRegistry\(\)/.test(src),
      'the Send Now bubble path must retire the registry',
    );
  });
});

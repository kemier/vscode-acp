import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * "Send Now" ordering regression.
 *
 * Clicking Send Now on a queued message while a turn is in flight used to add
 * the user bubble straight away. addUserBubbleForQueuedEntry resets
 * currentTurnEl, so every tool_call / chunk the cancelled turn still emitted
 * opened a FRESH turn BELOW the new bubble — the queued message rendered ABOVE
 * the prior turn's own commands, i.e. before the work it was meant to interrupt.
 *
 * Correct behaviour: request the cancel, and let the promptEnd drain path add
 * the bubble once the prior turn has closed, so the message lands after it.
 *
 * The real function is extracted out of the webview template literal in
 * ChatWebviewProvider.ts (it cannot be imported) and run against stubs, the
 * same pattern as foldOrdering.test.ts / mergeReplayOrderAuthority.test.ts.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

function extractSendQueuedMessageNow(): string {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const start = src.indexOf('function sendQueuedMessageNow(index) {');
  assert.ok(start >= 0, 'sendQueuedMessageNow not found in ChatWebviewProvider.ts');
  const endMarker = '\n// Pure decision helpers for the message queue.';
  const end = src.indexOf(endMarker, start);
  assert.ok(end > start, 'end marker after sendQueuedMessageNow not found');
  return src.slice(start, end).trim();
}

interface Harness {
  calls: string[];
  posted: any[];
  queue: any[];
  pending: any;
  statusText: string;
  run: (index: number) => void;
}

function makeHarness(opts: { isProcessing: boolean; queue: any[] }): Harness {
  const body = extractSendQueuedMessageNow();
  const calls: string[] = [];
  const posted: any[] = [];
  const state = {
    messageQueue: opts.queue,
    isProcessing: opts.isProcessing,
    pendingSendAfterCancel: null as any,
    hasSentPrompt: false,
    isSendingPrompt: false,
    statusEl: { textContent: '' },
  };

  const factory = new Function(
    'state',
    'calls',
    'posted',
    `
    let messageQueue = state.messageQueue;
    let isProcessing = state.isProcessing;
    let pendingSendAfterCancel = state.pendingSendAfterCancel;
    let hasSentPrompt = state.hasSentPrompt;
    let isSendingPrompt = state.isSendingPrompt;
    const statusEl = state.statusEl;
    const vscode = { postMessage: (m) => { posted.push(m); } };
    function renderQueue() { calls.push('renderQueue'); }
    function addUserBubbleForQueuedEntry(e) { calls.push('addUserBubble:' + e.text); }
    function handleLocalSlashCommand() { calls.push('localSlash'); return false; }
    function setProcessing() { calls.push('setProcessing'); }
    ${body}
    return function(index) {
      sendQueuedMessageNow(index);
      state.pendingSendAfterCancel = pendingSendAfterCancel;
      state.messageQueue = messageQueue;
    };
  `,
  );

  const run = factory(state, calls, posted) as (index: number) => void;
  return {
    calls,
    posted,
    get queue() {
      return state.messageQueue;
    },
    get pending() {
      return state.pendingSendAfterCancel;
    },
    get statusText() {
      return state.statusEl.textContent;
    },
    run,
  };
}

suite('Send Now ordering (queued message vs the turn it interrupts)', () => {
  test('while processing: cancels and does NOT add the bubble yet', () => {
    const h = makeHarness({ isProcessing: true, queue: [{ text: 'do the thing', images: [] }] });
    h.run(0);

    assert.deepStrictEqual(
      h.posted.map((m) => m.type),
      ['cancelTurn'],
      'must request the cancel and must not send the prompt yet',
    );
    assert.ok(
      !h.calls.some((c) => c.startsWith('addUserBubble')),
      'the bubble must NOT be added before the cancelled turn closes: ' + JSON.stringify(h.calls),
    );
    assert.ok(h.pending, 'the entry must be parked for the promptEnd drain path');
    assert.strictEqual(h.pending.text, 'do the thing');
    assert.ok(
      !h.pending.bubbleShown,
      'bubbleShown must stay falsy so the promptEnd path adds the bubble',
    );
    assert.strictEqual(h.queue.length, 0, 'entry is removed from the visible queue');
  });

  test('while processing: gives immediate feedback on the status line, not a chat row', () => {
    const h = makeHarness({ isProcessing: true, queue: [{ text: 'hi', images: [] }] });
    h.run(0);
    assert.match(h.statusText, /Interrupting/i);
  });

  test('when idle: sends immediately and shows the bubble', () => {
    const h = makeHarness({ isProcessing: false, queue: [{ text: 'run tests', images: [] }] });
    h.run(0);

    assert.ok(
      h.calls.some((c) => c === 'addUserBubble:run tests'),
      'idle path shows the bubble right away: ' + JSON.stringify(h.calls),
    );
    assert.deepStrictEqual(h.posted.map((m) => m.type), ['sendPrompt']);
    assert.strictEqual(h.posted[0].text, 'run tests');
    assert.ok(!h.pending, 'nothing is parked when there was no turn to cancel');
  });

  test('out-of-range index is a no-op', () => {
    const h = makeHarness({ isProcessing: true, queue: [{ text: 'a', images: [] }] });
    h.run(5);
    h.run(-1);
    assert.deepStrictEqual(h.posted, []);
    assert.deepStrictEqual(h.calls, []);
    assert.strictEqual(h.queue.length, 1);
  });
});

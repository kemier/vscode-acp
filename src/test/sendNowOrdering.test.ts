import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { QUEUE_ENTRY_HELPERS_SRC } from './webviewQueueHelpers';

/**
 * "Send Now" ordering regression.
 *
 * Clicking Send Now on a queued message while a turn is in flight now sends
 * a mid-turn steer (session/steer → stdin write) so the agent deals with it
 * in real time, matching happier's Send Now behavior. The entry is re-added
 * to the queue with steered/steerPending set, so the ack path
 * (markSteeredEntryBubbleShown / ackSteeredQueueEntry) adds the bubble at
 * the right position.
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
    ${QUEUE_ENTRY_HELPERS_SRC}
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
  test('while processing: steers into the running turn, does NOT add the bubble yet', () => {
    const h = makeHarness({ isProcessing: true, queue: [{ text: 'do the thing', images: [] }] });
    h.run(0);

    // The isProcessing path sends a steerPrompt (mid-turn stdin write) and a
    // debugLog. No cancelTurn, no stopProcesses.
    const types = h.posted.map((m) => m.type);
    assert.ok(types.includes('steerPrompt'), 'must send a mid-turn steer: ' + JSON.stringify(types));
    assert.ok(!types.includes('cancelTurn'), 'must NOT cancel the turn');
    assert.ok(!types.includes('stopProcesses'), 'must NOT kill processes');
    assert.ok(
      !h.calls.some((c) => c.startsWith('addUserBubble')),
      'the bubble must NOT be added before the steer echo arrives: ' + JSON.stringify(h.calls),
    );
    // The entry is re-added to the queue with steered/steerPending set.
    assert.strictEqual(h.queue.length, 1, 'entry is re-added to the queue for the ack path');
    assert.ok(h.queue[0].steered, 'entry must be marked as steered');
    assert.ok(h.queue[0].steerPending, 'entry must be marked as steerPending');
  });

  test('while processing: gives immediate feedback on the status line, not a chat row', () => {
    const h = makeHarness({ isProcessing: true, queue: [{ text: 'hi', images: [] }] });
    h.run(0);
    assert.match(h.statusText, /Sent into the running turn/i);
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

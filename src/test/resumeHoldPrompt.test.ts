import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * A prompt typed while a session/load replay is on screen must not be sent, and
 * must not have its bubble injected into the replaying transcript.
 *
 * The original bug: handleSend() guarded on hasActiveSession / isSendingPrompt /
 * isCompacting / isProcessing but NOT on isLoadingSession, so a prompt typed
 * during a resume fell straight through to the sendPrompt post. The host then
 * saw promptSentWhileLoading=true and posted a userBubble to compensate for the
 * bubble the webview never rendered — which is exactly what put the message in
 * the middle of the replaying history, with a turn started against a
 * half-built transcript.
 *
 * The second bug, and what these tests now pin: the hold was gated on
 * isLoadingSession, but showSessionConnected clears that flag ~30ms BEFORE
 * handleLoadSessionEnd drains (the host defers loadSessionEnd by
 * LOAD_END_TAIL_FLUSH_MS to flush the replay tail). A prompt typed in that gap
 * took the normal send path and rendered immediately; the held prompt then
 * drained after it, so the FIRST message appeared AFTER the second. The hold is
 * therefore gated on replayHoldActive, which spans the whole load, and holds a
 * FIFO queue so typed order is preserved.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

/**
 * Return the brace-balanced body of the `if` that starts at `start`.
 *
 * Needed because a comment between two guards can mention a symbol the next
 * guard uses (e.g. "a sendPrompt was just posted by drainQueue" above the
 * isSendingPrompt guard), so slicing to the next guard's text over-reads.
 */
function extractHoldBlock(src: string, start: number): string {
  const open = src.indexOf('{', start);
  assert.ok(open > start, 'no block after the guard');
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') { depth++; }
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) { return src.slice(start, i + 1); }
    }
  }
  assert.fail('unbalanced block');
}

function extractFn(name: string): string {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' not found');
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') { depth++; }
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) { break; }
    }
  }
  return src.slice(start, i + 1);
}

suite('a prompt typed during a resume replay is held, not sent', () => {
  test('handleSend guards on replayHoldActive before the queue/send branches', () => {
    const send = extractFn('handleSend');
    const guard = send.indexOf('if (replayHoldActive)');
    assert.ok(guard > 0, 'handleSend must guard on replayHoldActive');

    // The hold must win over the branches that would queue or drop the text.
    const sendingGuard = send.indexOf('if (isSendingPrompt)');
    const compactGuard = send.indexOf('if (isCompacting || isClearing)');
    const processingGuard = send.indexOf('if (isProcessing &&');
    assert.ok(guard < sendingGuard, 'replayHoldActive guard must precede isSendingPrompt');
    assert.ok(guard < compactGuard, 'replayHoldActive guard must precede the compacting guard');
    assert.ok(guard < processingGuard, 'replayHoldActive guard must precede the isProcessing guard');
  });

  test('the hold is NOT gated on isLoadingSession', () => {
    // The regression: showSessionConnected clears isLoadingSession before the
    // drain, so gating on it left a window where a prompt was sent immediately
    // and the held prompt drained after it.
    const send = extractFn('handleSend');
    const guard = send.indexOf('if (replayHoldActive)');
    const block = extractHoldBlock(send, guard);
    assert.ok(
      !block.includes('isLoadingSession'),
      'the hold must not depend on isLoadingSession — it is cleared ~30ms before the drain',
    );
  });

  test('the held prompt is stored, and nothing is posted', () => {
    const send = extractFn('handleSend');
    const guard = send.indexOf('if (replayHoldActive)');
    // Bound the block at the hold's own closing brace, not at the next guard's
    // text — the isSendingPrompt guard is preceded by a comment that mentions
    // sendPrompt, which would otherwise be mistaken for a real call.
    const block = extractHoldBlock(send, guard);
    assert.ok(block.includes('pendingResumeSends.push({'), 'must push onto the hold queue');
    assert.ok(block.includes('return;'), 'must return without sending');
    assert.ok(!block.includes('vscode.postMessage'), 'must NOT post anything while loading');
    assert.ok(!block.includes("addMessage('user'"), 'must NOT render a user bubble mid-replay');
  });

  test('attachments ride along with the held text', () => {
    const send = extractFn('handleSend');
    const guard = send.indexOf('if (replayHoldActive)');
    const block = extractHoldBlock(send, guard);
    assert.ok(block.includes('pendingImages.splice(0)'), 'must claim pending images');
    assert.ok(block.includes('pendingVideoAttached'), 'must claim the pending video');
  });

  test('the hold queue and window are module-level state, not locals', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    assert.ok(src.includes('let pendingResumeSends = [];'), 'hold queue must be declared');
    assert.ok(src.includes('let replayHoldActive = false;'), 'hold window flag must be declared');
  });
});

suite('the hold window spans the whole load, not just isLoadingSession', () => {
  test('handleLoadSessionStart opens the window', () => {
    const start = extractFn('handleLoadSessionStart');
    assert.ok(start.includes('replayHoldActive = true;'), 'must open the hold window on load start');
  });

  test('handleLoadSessionEnd closes the window', () => {
    const end = extractFn('handleLoadSessionEnd');
    assert.ok(end.includes('replayHoldActive = false;'), 'must close the hold window on load end');
  });

  test('the window is closed BEFORE the drain loop, not after', () => {
    // handleSend() re-checks replayHoldActive on entry. Closing it after the
    // loop would re-hold every drained prompt and the drain would spin; closing
    // it before also means a prompt typed during the drain is not held forever
    // with no later drain to release it.
    const end = extractFn('handleLoadSessionEnd');
    const close = end.indexOf('replayHoldActive = false;');
    const drain = end.indexOf('if (pendingResumeSends.length > 0)');
    assert.ok(close > 0 && drain > 0, 'both the close and the drain must exist');
    assert.ok(close < drain, 'the window must be closed before draining');
  });
});

suite('the held prompts drain only after the replay is fully rendered', () => {
  test('handleLoadSessionEnd drains the hold queue', () => {
    const end = extractFn('handleLoadSessionEnd');
    assert.ok(end.includes('if (pendingResumeSends.length > 0)'), 'must check the hold queue');
    assert.ok(end.includes('pendingResumeSends = [];'), 'must clear the queue before sending');
    assert.ok(end.includes('handleSend();'), 'must re-enter the normal send path');
  });

  test('the drain runs after the snapshot merge and the rebuild', () => {
    const end = extractFn('handleLoadSessionEnd');
    const drain = end.indexOf('if (pendingResumeSends.length > 0)');
    assert.ok(drain > 0, 'drain block not found');
    // The merge/rebuild markers must all precede the drain, or the bubble lands
    // inside the replaying history instead of at the bottom.
    for (const marker of ['renderChatHistory', 'forceCollapseTurnFolds', 'scrollToBottom']) {
      const at = end.indexOf(marker);
      assert.ok(at >= 0, marker + ' not found in handleLoadSessionEnd');
      assert.ok(at < drain, marker + ' must run before the drain');
    }
  });

  test('the drain runs in typed order (FIFO)', () => {
    // The reordering bug: the held prompt was drained after a later prompt that
    // had taken the normal send path. Draining must walk the queue front-to-back
    // so the transcript matches what the user typed.
    const end = extractFn('handleLoadSessionEnd');
    const drain = end.indexOf('if (pendingResumeSends.length > 0)');
    const block = end.slice(drain);
    const loop = block.indexOf('for (var _hs = 0; _hs < _heldSends.length; _hs++)');
    const send = block.indexOf('handleSend();');
    assert.ok(loop > 0, 'must iterate the held queue in order');
    assert.ok(send > loop, 'handleSend must be called inside the ordered loop');
    assert.ok(
      !block.includes('_heldSends.pop()'),
      'must not pop — that reverses typed order',
    );
  });

  test('the drain restores text and attachments before sending', () => {
    const end = extractFn('handleLoadSessionEnd');
    const drain = end.indexOf('if (pendingResumeSends.length > 0)');
    const block = end.slice(drain);
    const setText = block.indexOf('promptInput.value = _heldSend.text');
    const pushImages = block.indexOf('pendingImages.push(');
    const send = block.indexOf('handleSend();');
    assert.ok(setText > 0, 'must restore the held text');
    assert.ok(pushImages > 0 && pushImages < send, 'must restore images before sending');
    assert.ok(send > setText, 'must send after restoring');
  });
});

suite('the hold cannot leak across sessions', () => {
  test('handleLoadSessionStart clears the queue and reopens the window', () => {
    const start = extractFn('handleLoadSessionStart');
    assert.ok(start.includes('pendingResumeSends = [];'), 'must clear the hold queue on a new load');
    // It must be cleared alongside the other per-session resets, not after the
    // DOM wipe, so a hold from session A cannot drain into session B.
    const queueReset = start.indexOf('messageQueue = [];');
    const holdReset = start.indexOf('pendingResumeSends = [];');
    assert.ok(queueReset > 0 && holdReset > queueReset, 'clear the hold with the queue reset');
    // The window is reopened AFTER the clear, so the new load is covered.
    const open = start.indexOf('replayHoldActive = true;');
    assert.ok(open > holdReset, 'the hold window must open after the queue is cleared');
  });
});

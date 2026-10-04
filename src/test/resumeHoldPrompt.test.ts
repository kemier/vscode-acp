import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * A prompt typed while a session/load replay is on screen must not be sent, and
 * must not have its bubble injected into the replaying transcript.
 *
 * The bug: handleSend() guarded on hasActiveSession / isSendingPrompt /
 * isCompacting / isProcessing but NOT on isLoadingSession, so a prompt typed
 * during a resume fell straight through to the sendPrompt post. The host then
 * saw promptSentWhileLoading=true and posted a userBubble to compensate for the
 * bubble the webview never rendered — which is exactly what put the message in
 * the middle of the replaying history, with a turn started against a
 * half-built transcript.
 *
 * The fix holds the prompt in pendingResumeSend and drains it from
 * handleLoadSessionEnd, after the replay tail commit and the snapshot merge, so
 * it appears at the bottom and starts a turn as if typed after the resume.
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
  test('handleSend guards on isLoadingSession before the queue/send branches', () => {
    const send = extractFn('handleSend');
    const guard = send.indexOf('if (isLoadingSession)');
    assert.ok(guard > 0, 'handleSend must guard on isLoadingSession');

    // The hold must win over the branches that would queue or drop the text.
    const sendingGuard = send.indexOf('if (isSendingPrompt)');
    const compactGuard = send.indexOf('if (isCompacting || isClearing)');
    const processingGuard = send.indexOf('if (isProcessing &&');
    assert.ok(guard < sendingGuard, 'isLoadingSession guard must precede isSendingPrompt');
    assert.ok(guard < compactGuard, 'isLoadingSession guard must precede the compacting guard');
    assert.ok(guard < processingGuard, 'isLoadingSession guard must precede the isProcessing guard');
  });

  test('the held prompt is stored, and nothing is posted', () => {
    const send = extractFn('handleSend');
    const guard = send.indexOf('if (isLoadingSession)');
    // Bound the block at the hold's own closing brace, not at the next guard's
    // text — the isSendingPrompt guard is preceded by a comment that mentions
    // sendPrompt, which would otherwise be mistaken for a real call.
    const block = extractHoldBlock(send, guard);
    assert.ok(block.includes('pendingResumeSend = {'), 'must assign the hold slot');
    assert.ok(block.includes('return;'), 'must return without sending');
    assert.ok(!block.includes('vscode.postMessage'), 'must NOT post anything while loading');
    assert.ok(!block.includes("addMessage('user'"), 'must NOT render a user bubble mid-replay');
  });

  test('attachments ride along with the held text', () => {
    const send = extractFn('handleSend');
    const guard = send.indexOf('if (isLoadingSession)');
    const block = extractHoldBlock(send, guard);
    assert.ok(block.includes('pendingImages.splice(0)'), 'must claim pending images');
    assert.ok(block.includes('pendingVideoAttached'), 'must claim the pending video');
  });

  test('the hold slot is module-level state, not a local', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    assert.ok(src.includes('let pendingResumeSend = null;'), 'hold slot must be declared');
  });
});

suite('the held prompt drains only after the replay is fully rendered', () => {
  test('handleLoadSessionEnd drains the hold', () => {
    const end = extractFn('handleLoadSessionEnd');
    assert.ok(end.includes('if (pendingResumeSend)'), 'must check the hold');
    assert.ok(end.includes('pendingResumeSend = null;'), 'must clear the slot before sending');
    assert.ok(end.includes('handleSend();'), 'must re-enter the normal send path');
  });

  test('the drain runs after the snapshot merge and the rebuild', () => {
    const end = extractFn('handleLoadSessionEnd');
    const drain = end.indexOf('if (pendingResumeSend)');
    assert.ok(drain > 0, 'drain block not found');
    // The merge/rebuild markers must all precede the drain, or the bubble lands
    // inside the replaying history instead of at the bottom.
    for (const marker of ['renderChatHistory', 'forceCollapseTurnFolds', 'scrollToBottom']) {
      const at = end.indexOf(marker);
      assert.ok(at >= 0, marker + ' not found in handleLoadSessionEnd');
      assert.ok(at < drain, marker + ' must run before the drain');
    }
  });

  test('the drain restores text and attachments before sending', () => {
    const end = extractFn('handleLoadSessionEnd');
    const drain = end.indexOf('if (pendingResumeSend)');
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
  test('handleLoadSessionStart clears the hold', () => {
    const start = extractFn('handleLoadSessionStart');
    assert.ok(start.includes('pendingResumeSend = null;'), 'must clear the hold on a new load');
    // It must be cleared alongside the other per-session resets, not after the
    // DOM wipe, so a hold from session A cannot drain into session B.
    const queueReset = start.indexOf('messageQueue = [];');
    const holdReset = start.indexOf('pendingResumeSend = null;');
    assert.ok(queueReset > 0 && holdReset > queueReset, 'clear the hold with the queue reset');
  });
});

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * @clipboard on a QUEUED message must capture what was copied when it was written.
 *
 * Session 41e95918 shows both outcomes. Sent directly, the mention resolved:
 *
 *   [0]   <context ref="zed:///agent/clipboard">Collection Sync 2026-09-06 ...</context>
 *   [219] <context ref="zed:///agent/clipboard">Tile Stack</context>
 *
 * Queued, it did not — three arrived with the mention still literal and no content:
 *
 *   [3]   [User interjection]: @clipboard and this
 *   [141] [User interjection]: @clipboard also do same for this subsections
 *   [222] [User interjection]: @clipboard those links in markdown preview can't click
 *
 * Two distinct causes. A queued message is delivered on the STEER path
 * (handleSteerPrompt -> sessionManager.steerPrompt), which performs no context
 * resolution at all — only handleSendPrompt does. And the clipboard is volatile shared
 * state, so resolving at drain time would attach whatever was copied LAST rather than
 * what the user had copied minutes earlier.
 *
 * Both are answered by snapshotting at QUEUE time. The snapshot is stored BESIDE the
 * text (entry.clipboard), not substituted into it: every send path expands it through
 * queueEntryPromptText, so the payload is inline on the wire whichever path delivers
 * it, while the chip and the bubble show a `[Clipboard: N lines]` pill instead of a
 * 1300-character blob.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');
const src = fs.readFileSync(SOURCE, 'utf8');

suite('queued @clipboard is snapshotted at queue time', () => {
  test('queueMessage requests a snapshot when the mention is present', () => {
    const at = src.indexOf('function queueMessage(text, images, videoAttached) {');
    assert.ok(at > 0, 'queueMessage not found');
    const body = src.slice(at, at + 2200);
    assert.ok(body.includes("type: 'resolveClipboardForQueue'"), 'must request the snapshot');
    assert.ok(body.includes('entry.clipboardToken'), 'must tag the entry so the reply can find it');
  });

  test('the request is keyed, not a single global slot', () => {
    // Several messages can be queued; a shared slot would give them all the same content.
    const at = src.indexOf('function queueMessage(text, images, videoAttached) {');
    const body = src.slice(at, at + 2200);
    assert.ok(body.includes("'clip-' + Date.now()"), 'token must be unique per entry');
  });

  test('the host reads the clipboard and replies with the token', () => {
    const at = src.indexOf("case 'resolveClipboardForQueue'");
    assert.ok(at > 0, 'host case not found');
    const body = src.slice(at, at + 700);
    assert.ok(body.includes('vscode.env.clipboard.readText()'), 'must read the clipboard');
    assert.ok(body.includes("type: 'clipboardForQueue'"), 'must reply');
    assert.ok(body.includes('token: message.token'), 'must echo the token');
    assert.ok(body.includes('catch'), 'a read failure must not break queueing');
  });

  test('the reply stores the snapshot beside the text and drops the mention', () => {
    const at = src.indexOf("case 'clipboardForQueue'");
    assert.ok(at > 0, 'webview handler not found');
    const body = src.slice(at, at + 1800);
    assert.ok(body.includes('_qe.clipboardToken !== msg.token'), 'must match by token');
    assert.ok(body.includes('_qe.clipboard = { text: _clip }'), 'snapshot kept out of the display text');
    assert.ok(body.includes('replace(/@clipboard'), 'mention removed');
    assert.ok(body.includes('delete _qe.clipboardToken'), 'token cleared after use');
  });

  test('an empty clipboard warns at queue time, not silently on drain', () => {
    const at = src.indexOf("case 'clipboardForQueue'");
    const body = src.slice(at, at + 1800);
    assert.ok(body.includes('was empty when this message was queued'), 'must say when');
    assert.ok(body.includes("type: 'showWarning'"), 'must surface it');
  });

  test('the host can surface a webview warning', () => {
    const at = src.indexOf("case 'showWarning':");
    assert.ok(at > 0, 'showWarning host case missing — the warning would vanish');
    assert.ok(src.slice(at, at + 200).includes('showWarningMessage'), 'must use the editor UI');
  });

  test('the inline block is collapsed to a pill in the displayed bubble', () => {
    // Otherwise the replayed bubble would show the raw payload. See
    // clipboardResumeStrip.test.ts for the per-agent replay shapes.
    assert.ok(
      src.includes("stripTag(displayText, 'clipboard', function(b) { return contextTagPill('clipboard', b); })"),
      'clipboard block replaced',
    );
  });

  test('every send path expands the snapshot; no display path does', () => {
    // A payload left in entry.text made the chip and the bubble show the whole blob;
    // a payload expanded only in one send path would silently drop it in the others.
    const expanders = src.split('queueEntryPromptText(entry)').length - 1;
    assert.ok(expanders >= 5, `all send paths must expand, found ${expanders}`);
    // Matched as patterns, not literals: the drained sendPrompt sites also pass a
    // `selections: []` override now, to stop the host re-reading the editor and
    // attaching a live selection on top of the snapshot already in the text.
    for (const [label, re] of [
      [
        'sendPrompt',
        /vscode\.postMessage\(\{\s*type: 'sendPrompt', text: queueEntryPromptText\(entry\) \|\| ' ', images: entry\.images,/,
      ],
      ['steerPrompt', /vscode\.postMessage\(\{ type: 'steerPrompt', text: queueEntryPromptText\(entry\) \|\| ' ' \}\)/],
    ] as Array<[string, RegExp]>) {
      assert.ok(re.test(src), `send path not expanding the snapshot: ${label}`);
    }
    const bubbleAt = src.indexOf('function addUserBubbleForQueuedEntry(entry) {');
    assert.ok(bubbleAt > 0, 'addUserBubbleForQueuedEntry not found');
    const bubble = src.slice(bubbleAt, bubbleAt + 700);
    assert.ok(bubble.includes('queueEntryDisplayText(entry)'), 'the bubble must show the pill');
    assert.ok(!bubble.includes('queueEntryPromptText'), 'the bubble must never carry the payload');
  });

  test('a steered entry is matched against what was actually sent', () => {
    // The echo mirrors the expanded text, so matching on the typed text alone would
    // never ack a clipboard message and it would be delivered twice.
    const at = src.indexOf('function ackSteeredQueueEntry(echoText) {');
    assert.ok(at > 0, 'ackSteeredQueueEntry not found');
    const body = src.slice(at, at + 900);
    assert.ok(body.includes('steerEchoMatchesEntry(queueEntryPromptText(e), echoText)'), 'must match the sent form');
  });

  test('editing a queued message restores the mention, not the stale snapshot', () => {
    const at = src.indexOf('function editQueuedMessage(index) {');
    assert.ok(at > 0, 'editQueuedMessage not found');
    const body = src.slice(at, at + 900);
    assert.ok(body.includes("'@clipboard '"), 'the mention goes back in the composer');
  });
});

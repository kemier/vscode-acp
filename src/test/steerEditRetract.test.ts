import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Editing an already-steered queued message must RETRACT the adapter-side
 * steer, not just pull the chip back into the composer.
 *
 * Symptom (2026-10-10 session, claude-code-acp): user queued a steer, then
 * edited it in place ("…//yea" → "…//yes"). The client queue spliced the
 * entry, but claude-code-acp's steerQueues still held the PRE-edit text; the
 * re-typed text arrived as a second session/steer. drainSteerQueue then ran
 * twice (14:53:23 and 14:55:23) — two follow-up turns, two answers, two
 * bubbles for one edit.
 *
 * Send Now (sendQueuedMessageNow) already retracts via steerPromptRemove
 * (host notify session/steer-remove → adapter handleSteerRemove splices the
 * queue and acks user_message_removed). editQueuedMessage must do the same
 * BEFORE splicing the client entry: the retract text must be the entry's
 * EXPANDED prompt text (queueEntryPromptText) — that is what was sent, and
 * the adapter matches by collapseSteerText of the sent text.
 *
 * editQueuedMessage lives inside the webview template literal and drives the
 * DOM, so — like queuedClipboardSnapshot.test.ts — we assert the shipped
 * source shape rather than executing it.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

suite('editing a steered queue entry retracts the adapter steer', () => {
  const src = fs.readFileSync(SOURCE, 'utf8');

  test('editQueuedMessage retracts a steered entry before splicing', () => {
    const at = src.indexOf('function editQueuedMessage(index) {');
    assert.ok(at > 0, 'editQueuedMessage not found');
    const body = src.slice(at, at + 3000);
    assert.ok(
      body.includes("if (entry.steered) {\n      vscode.postMessage({ type: 'steerPromptRemove', text: queueEntryPromptText(entry) || '' });\n    }"),
      'edit must send steerPromptRemove when the entry was already steered',
    );
    // The retract must come BEFORE the client splice: the adapter queue still
    // holds the pre-edit text at that point; after the splice the entry is
    // gone and the retract text could not be recovered.
    const retractAt = body.indexOf("type: 'steerPromptRemove'");
    const spliceAt = body.indexOf('messageQueue.splice(index, 1)');
    assert.ok(retractAt >= 0 && spliceAt >= 0 && retractAt < spliceAt,
      'retract must precede the queue splice');
  });

  test('retract uses the expanded prompt text (what the agent holds)', () => {
    const at = src.indexOf('function editQueuedMessage(index) {');
    const body = src.slice(at, at + 3000);
    assert.ok(
      body.includes("steerPromptRemove', text: queueEntryPromptText(entry)"),
      'adapter matches by collapseSteerText of the SENT text — expanded form',
    );
  });

  test('Send Now keeps its retract (regression guard)', () => {
    const at = src.indexOf('function sendQueuedMessageNow(index) {');
    assert.ok(at > 0, 'sendQueuedMessageNow not found');
    const body = src.slice(at, at + 2500);
    assert.ok(body.includes("if (entry.steered) {"), 'Send Now still retracts steered entries');
    assert.ok(body.includes("type: 'steerPromptRemove'"), 'Send Now still sends the retract');
  });
});

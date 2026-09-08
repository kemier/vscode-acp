import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * A slash command typed while a turn streams must not end that turn.
 *
 * The webview deliberately lets slash commands past its send queue:
 *
 *   // Allow slash commands through during streaming — the agent
 *   // handles read-only commands (e.g. /ps, /status) without
 *   // interrupting the in-progress LLM turn.
 *   if (isProcessing && !text.startsWith('/')) { handleQueue(); return; }
 *
 * ericli now honours that: read-only commands (/tools, /a2a list, /ps, /stats,
 * /skills list, /index status) are answered from a live snapshot above
 * abortInFlightTurn(), so the streaming turn survives on the agent side.
 *
 * The snapshot still resolves its OWN session/prompt with
 * `stopReason: 'end_turn'`, in milliseconds. Left unguarded, the extension's
 * slash branch treats that as the current turn's terminal response:
 *
 *   - `_cancelGeneration++` makes the STREAMING turn's eventual response
 *     gen-stale, so its promptEnd is suppressed and the turn never ends;
 *   - the snapshot's own end_turn then posts promptEnd — hiding Stop and
 *     draining the queue while the agent is still streaming the real answer;
 *   - a second `promptStart` makes the webview treat this as a new turn and
 *     clear its messageId grouping state mid-stream.
 *
 * Slash commands take a DEDICATED branch in handleSendPrompt (`if
 * (text.startsWith('/'))`) with its own try/finally — they never reach the main
 * prompt path — so the guard has to live there. The behaviour needs a live
 * agent; the state the branch must not touch is exactly what breaks, so that is
 * asserted on the real source.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

/** The dedicated slash-command branch inside handleSendPrompt. */
function slashBranch(): string {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const method = src.indexOf('private async handleSendPrompt(');
  assert.ok(method >= 0, 'handleSendPrompt not found');
  const start = src.indexOf("if (text.startsWith('/')) {", method);
  assert.ok(start > method, 'slash-command branch not found in handleSendPrompt');
  // The branch ends at its `return;` followed by the closing brace.
  const end = src.indexOf('\n      return;\n    }\n', start);
  assert.ok(end > start, 'end of slash-command branch not found');
  return src.slice(start, end);
}

suite('mid-turn slash command does not steal turn state', () => {
  const branch = slashBranch();

  test('classifies a command sent during a pending turn as side-channel', () => {
    assert.ok(
      branch.includes('const isSideChannelSlash = this._pendingPromptSessionId === activeId;'),
      'the slash branch must classify a command sent while a turn is already pending ' +
        'for this session as a side-channel request',
    );
  });

  test('does not post a second promptStart for a side-channel command', () => {
    const detect = branch.indexOf('const isSideChannelSlash =');
    const start = branch.indexOf("this.postMessage({ type: 'promptStart' });");
    assert.ok(detect >= 0 && start >= 0, 'markers not found');
    assert.ok(detect < start, 'the check must be evaluated before promptStart is posted');
    assert.ok(
      branch.slice(Math.max(0, start - 120), start).includes('if (!isSideChannelSlash) {'),
      'promptStart must be skipped for a side-channel command — the running turn ' +
        'already has the turn open, and a second promptStart resets messageId grouping',
    );
  });

  test('does not bump the cancel generation for a side-channel command', () => {
    const bump = branch.indexOf('this._cancelGeneration++;');
    assert.ok(bump >= 0, 'generation bump not found in the slash branch');
    assert.ok(
      branch.slice(Math.max(0, bump - 200), bump).includes('if (!isSideChannelSlash) {'),
      'a side-channel command must NOT bump _cancelGeneration — that generation ' +
        "belongs to the running turn, and bumping it makes the turn's own response " +
        'look stale so its promptEnd is suppressed',
    );
  });

  test('never posts promptEnd for a side-channel command', () => {
    const guard = branch.indexOf('if (isSideChannelSlash) {');
    const promptEnd = branch.indexOf("type: 'promptEnd'");
    assert.ok(guard >= 0, 'side-channel guard not found in the finally block');
    assert.ok(promptEnd >= 0, 'promptEnd post not found');
    assert.ok(
      guard < promptEnd,
      'the promptEnd post must sit inside the non-side-channel branch, otherwise a ' +
        'snapshot ends the turn in the UI while the agent is still streaming',
    );
    const sideChannelArm = branch.slice(guard, branch.indexOf('} else {', guard));
    assert.ok(sideChannelArm.length > 0, 'side-channel arm not found');
    assert.ok(
      !sideChannelArm.includes("type: 'promptEnd'"),
      'the side-channel arm must not post promptEnd',
    );
    assert.ok(
      !sideChannelArm.includes('this._cancelFallbackTimer = null;'),
      "the side-channel arm must not clear the running turn's cancel fallback timer",
    );
    assert.ok(
      !sideChannelArm.includes('this._pendingPromptSessionId = null;'),
      "the side-channel arm must not release the running turn's pending session",
    );
  });

  test('a normal (idle) slash command still owns the turn state', () => {
    const elseAt = branch.indexOf('} else {', branch.indexOf('if (isSideChannelSlash) {'));
    assert.ok(elseAt >= 0, 'non-side-channel arm not found');
    const normalArm = branch.slice(elseAt);
    assert.ok(
      normalArm.includes('this._pendingPromptSessionId = null;'),
      'an idle slash command must still release the pending session',
    );
    assert.ok(
      normalArm.includes("type: 'promptEnd'"),
      'an idle slash command must still post promptEnd — behaviour is unchanged when ' +
        'no turn is running',
    );
  });

  test('the buffered stream is flushed for both arms', () => {
    const flush = branch.indexOf('this.streamCoalescer.flush(activeId);');
    const guard = branch.indexOf('if (isSideChannelSlash) {', flush);
    assert.ok(flush >= 0 && guard > flush, 'flush must happen before the arms split');
  });
});

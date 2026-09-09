import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * "Send Now" stopped working after the first interrupt.
 *
 * Measured in an codex session:
 *
 *   06:36:10  Cancelling turn for session c5015617…
 *   06:36:15  Cancel fallback: agent did not acknowledge within 5s, forcing promptEnd
 *   06:36:15  sendPrompt: …                      ← queued message drained, worked
 *   06:36:23  Prompt response: stopReason=cancelled   ← the OLD prompt, 13s late
 *   06:38:22  Cancelling turn for session c5015617…   ← LAST LINE of the log
 *
 * The second cancel produced no `Cancel fallback` line at all, so no promptEnd
 * was ever posted: the turn never ended, the queued message never drained, and
 * the "Interrupting" status stayed up.
 *
 * Cause: handleSendPrompt cleared _cancelFallbackTimer and _pendingPromptSessionId
 * BEFORE its stale-generation guard. The 13s-late resolution of the abandoned
 * prompt therefore wiped state that already belonged to the NEW prompt, and the
 * next fallback's `_pendingPromptSessionId === activeId` guard was false.
 *
 * Both mutations must sit AFTER the guard. This test asserts that ordering on
 * the real source for both the success and the error path — the behaviour needs
 * a live agent, but the ordering is exactly what broke.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

/**
 * The region of handleSendPrompt from the point the MAIN prompt is registered
 * (`_pendingPromptSessionId = activeId`) to the end of the method.
 *
 * Scoping matters: an earlier slash-command branch in the same method has its
 * own try/catch that also clears this state, so a naive indexOf over the whole
 * method matches that one instead.
 */
function mainPromptRegion(): { success: string; error: string } {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const start = src.indexOf('private async handleSendPrompt(');
  assert.ok(start >= 0, 'handleSendPrompt not found');
  const end = src.indexOf('\n  private ', start + 10);
  assert.ok(end > start, 'end of handleSendPrompt not found');
  const body = src.slice(start, end);

  const register = body.lastIndexOf('this._pendingPromptSessionId = activeId;');
  assert.ok(register >= 0, 'main prompt registration not found');
  const afterRegister = body.slice(register);

  // The LAST catch in the method is the main prompt's error path.
  const catchAt = afterRegister.lastIndexOf('} catch (e: any) {');
  assert.ok(catchAt >= 0, 'main catch block not found');
  return { success: afterRegister.slice(0, catchAt), error: afterRegister.slice(catchAt) };
}

suite('cancel fallback state ownership (Send Now after a late cancel)', () => {
  const { success, error } = mainPromptRegion();

  test('success path: staleness guard precedes clearing the fallback timer', () => {
    const guard = success.indexOf('stale response (gen');
    const clear = success.indexOf('this._cancelFallbackTimer = null;');
    assert.ok(guard >= 0, 'stale-response guard not found');
    assert.ok(clear >= 0, 'fallback-timer clear not found');
    assert.ok(
      guard < clear,
      'the stale-generation guard must come BEFORE clearing _cancelFallbackTimer, ' +
        'otherwise a superseded prompt resolving late strands the next cancel',
    );
  });

  test('success path: staleness guard precedes nulling the pending session', () => {
    const guard = success.indexOf('stale response (gen');
    const nulled = success.indexOf('this._pendingPromptSessionId = null;');
    assert.ok(nulled >= 0, 'pending-session reset not found');
    assert.ok(guard < nulled, 'the guard must come BEFORE nulling _pendingPromptSessionId');
  });

  test('error path: staleness guard precedes both resets', () => {
    const guard = error.indexOf('stale error (gen');
    const clear = error.indexOf('this._cancelFallbackTimer = null;');
    const nulled = error.indexOf('this._pendingPromptSessionId = null;');
    assert.ok(guard >= 0 && clear >= 0 && nulled >= 0, 'error-path markers not found');
    assert.ok(guard < clear, 'error path: guard must precede the timer clear');
    assert.ok(guard < nulled, 'error path: guard must precede the pending-session reset');
  });

  test('the fallback still keys on ownership, and is never unconditional', () => {
    // The guard was split into named conditions when a SECOND legitimate case was
    // added (an agent-initiated turn, below). The ordering fix this suite protects is
    // unaffected: ownership is still required on the client-owned path, so a wiped
    // _pendingPromptSessionId still means "do not fire" for a prompt the client owns.
    const src = fs.readFileSync(SOURCE, 'utf8');
    assert.ok(
      src.includes('const ownedByClient = this._pendingPromptSessionId === activeId;'),
      'ownership must still be computed from the pending session',
    );
    assert.ok(
      src.includes('if ((ownedByClient || agentInitiated) && this._cancelGeneration === cancelGen)'),
      'the fallback must remain gated — ownership OR an agent-initiated turn, AND the ' +
        'generation check; never unconditional',
    );
  });

  test('an agent-initiated turn can also be rescued, gated on no in-flight prompt', () => {
    // ericli used to call prompt() itself to deliver a late subagent result, so the
    // panel showed a turn while _pendingPromptSessionId was null. No ordering fix can
    // make the ownership path true there — the client never registered a prompt — so
    // Stop had no effect at all and only a reload cleared it.
    //
    // The discriminator is the SessionManager's in-flight set, not the webview: if it
    // holds no prompt for this session there is no newer prompt whose state could be
    // stolen, which is exactly what distinguishes this from the ordering bug above.
    const src = fs.readFileSync(SOURCE, 'utf8');
    assert.ok(
      src.includes('!ownedByClient && !this.sessionManager.isPromptInFlight(activeId)'),
      'the agent-initiated path must require that no prompt is in flight',
    );
  });
});

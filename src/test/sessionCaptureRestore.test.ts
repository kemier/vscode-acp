import * as assert from 'assert';
import { needsRestoreAfterCapture } from '../core/SessionCaptureRestore';

suite('SessionCaptureRestore.needsRestoreAfterCapture', () => {
  // Regression: a cross-agent /session lookup that matched a Kiro CLI session
  // left an EricLI session morphed to Kiro/Claude models because the restore
  // was skipped whenever the (foreign) active session was truthy after the
  // capture. The restore must fire whenever the post-capture (agent, session)
  // differs from the original — even if the post-capture session is non-null.
  test('cross-agent capture leaves a truthy foreign session active → restore required', () => {
    const original = { agent: 'EricLI', sessionId: 'eric-1234' };
    // kiro load succeeded: active is now Kiro CLI / kiro session (both truthy)
    assert.strictEqual(needsRestoreAfterCapture(original, 'Kiro CLI', 'kiro-5678'), true);
  });

  test('same agent, different session after capture → restore required', () => {
    const original = { agent: 'EricLI', sessionId: 'eric-1234' };
    assert.strictEqual(needsRestoreAfterCapture(original, 'EricLI', 'eric-9999'), true);
  });

  test('same agent, same session after capture → no restore needed', () => {
    const original = { agent: 'EricLI', sessionId: 'eric-1234' };
    assert.strictEqual(needsRestoreAfterCapture(original, 'EricLI', 'eric-1234'), false);
  });

  test('post-capture active session null (capture threw) → restore required', () => {
    const original = { agent: 'EricLI', sessionId: 'eric-1234' };
    assert.strictEqual(needsRestoreAfterCapture(original, null, null), true);
  });

  test('no original session to restore to (caller had no active session) → no restore', () => {
    const original = { agent: 'EricLI', sessionId: null };
    // nothing to restore — never morph a caller that had no active session
    assert.strictEqual(needsRestoreAfterCapture(original, 'Kiro CLI', 'kiro-5678'), false);
    assert.strictEqual(needsRestoreAfterCapture(original, null, null), false);
  });

  test('post-capture agent null but session somehow set → restore required (agent mismatch)', () => {
    const original = { agent: 'EricLI', sessionId: 'eric-1234' };
    assert.strictEqual(needsRestoreAfterCapture(original, null, 'eric-1234'), true);
  });
});

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * A failed turn must not be written to memory.
 *
 * endTurn is called from a `finally`, so a prompt that THREW — upstream 503,
 * transport error, killed agent — was captured anyway: a user message paired with
 * empty or half-streamed assistant text, and another copy on every retry. During one
 * 503 burst the resulting embeddings traffic was visible in the proxy log.
 *
 * A CANCELLED turn is still captured on purpose: the user interrupted a real answer,
 * and that exchange is worth remembering. Only an outright failure is discarded.
 */

const ROOT = path.resolve(__dirname, '../..');
const SM = fs.readFileSync(path.resolve(ROOT, 'src/core/SessionManager.ts'), 'utf8');
const PROVIDER = fs.readFileSync(path.resolve(ROOT, 'src/core/memory/SharedMemoryProvider.ts'), 'utf8');

suite('memory is not captured for a failed turn', () => {
  test('the prompt failure is recorded and rethrown, not swallowed', () => {
    assert.ok(SM.includes('let turnFailed = false;'), 'outcome must be tracked');
    const at = SM.indexOf('} catch (err) {\n      turnFailed = true;\n      throw err;');
    assert.ok(at > 0, 'the catch must set the flag AND rethrow — swallowing would hide the error');
  });

  test('a failed turn discards the buffer instead of capturing it', () => {
    const at = SM.indexOf('if (turnFailed) {');
    assert.ok(at > 0, 'capture must be gated on the outcome');
    const body = SM.slice(at, at + 700);
    assert.ok(body.includes('this.memoryProvider.discardTurn(sessionId)'), 'must discard');
    assert.ok(body.includes('this.memoryProvider.endTurn(sessionId)'), 'a good turn still captures');
  });

  test('discarding actually clears the buffer, so the next turn cannot inherit it', () => {
    assert.ok(PROVIDER.includes('discardTurn(sessionId: string): void'), 'provider needs the method');
    const at = PROVIDER.indexOf('discardTurn(sessionId: string): void');
    const body = PROVIDER.slice(at, at + 300);
    assert.ok(body.includes('this.turns.delete(sessionId)'), 'the buffer must be removed');
    assert.ok(body.includes('Memory capture skipped'), 'and the skip must be visible in the log');
  });

  test('a cancelled turn is still captured — that is a real exchange', () => {
    // The gate keys on a thrown prompt, not on stopReason, so cancelled keeps
    // flowing through endTurn as before.
    assert.ok(!SM.includes("stopReason === 'cancelled'"), 'must not start filtering by stopReason');
    assert.ok(PROVIDER.includes('Flush L0 capture for a completed (or cancelled) turn.'));
  });
});

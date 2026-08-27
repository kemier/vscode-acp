import * as assert from 'assert';
import { isRetryableMemoryFetchError } from '../core/memory/MemoryHttpRetry';
import { resolveSkillToolsBlockForInject } from '../core/memory/MemoryRecallInject';

suite('MemoryRecallInject', () => {
  const toolsBlock = '<memory_skill_tools>\ncurl recipes\n</memory_skill_tools>';

  test('resolveSkillToolsBlockForInject keeps block when at least one arm succeeded', () => {
    const result = resolveSkillToolsBlockForInject(toolsBlock, [
      { status: 'rejected', reason: new Error('fetch failed') },
      { status: 'fulfilled', value: { content: null } },
    ]);
    assert.strictEqual(result, toolsBlock);
  });

  test('resolveSkillToolsBlockForInject drops block when all enabled arms failed', () => {
    const result = resolveSkillToolsBlockForInject(toolsBlock, [
      { status: 'rejected', reason: new Error('fetch failed') },
      { status: 'rejected', reason: new Error('fetch failed') },
    ]);
    assert.strictEqual(result, undefined);
  });

  test('resolveSkillToolsBlockForInject keeps block on empty arm list', () => {
    assert.strictEqual(resolveSkillToolsBlockForInject(toolsBlock, []), toolsBlock);
  });
});

suite('MemoryHttpClient.isRetryableMemoryFetchError', () => {
  test('retries fetch failed and connection errors', () => {
    assert.strictEqual(isRetryableMemoryFetchError(new TypeError('fetch failed')), true);
    const err = new TypeError('failed') as Error & { cause: { code: string } };
    err.cause = { code: 'ECONNREFUSED' };
    assert.strictEqual(isRetryableMemoryFetchError(err), true);
  });

  test('does not retry abort or business errors', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    assert.strictEqual(isRetryableMemoryFetchError(abort), false);
    const unauthorized = new Error('unauthorized');
    unauthorized.name = 'MemoryHttpError';
    (unauthorized as Error & { code: number }).code = 401;
    assert.strictEqual(isRetryableMemoryFetchError(unauthorized), false);
  });

  test('retries gateway 502–504', () => {
    const unavailable = new Error('unavailable');
    unavailable.name = 'MemoryHttpError';
    (unavailable as Error & { code: number }).code = 503;
    assert.strictEqual(isRetryableMemoryFetchError(unavailable), true);
  });
});

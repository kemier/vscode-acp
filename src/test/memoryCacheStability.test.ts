import * as assert from 'assert';
import {
  isIncrementalCacheAgent,
  resolveMemoryInjectMode,
  shouldInjectMemoryForTurn,
} from '../core/MemoryCacheStability';

suite('MemoryCacheStability', () => {
  suite('isIncrementalCacheAgent', () => {
    test('codex-acp is the incremental-path agent', () => {
      assert.strictEqual(isIncrementalCacheAgent('codex-acp'), true);
      assert.strictEqual(isIncrementalCacheAgent('Codex-ACP'), true);
    });

    test('non-codex agents are NOT incremental-path', () => {
      assert.strictEqual(isIncrementalCacheAgent('claude-code-acp'), false);
      assert.strictEqual(isIncrementalCacheAgent('Pi Agent'), false);
    });
  });

  suite('resolveMemoryInjectMode', () => {
    test('first real prompt gets persona+scenes+L1 for every agent', () => {
      const opts = { sessionAlreadyPrompted: false, profileAlreadyInjected: false };
      assert.strictEqual(resolveMemoryInjectMode('Pi Agent', opts), 'full');
      assert.strictEqual(resolveMemoryInjectMode('claude-code-acp', opts), 'full');
      assert.strictEqual(resolveMemoryInjectMode('codex-acp', opts), 'full');
    });

    test('later turns inject L1 only (persona already in history) including Codex', () => {
      const opts = { sessionAlreadyPrompted: true, profileAlreadyInjected: true };
      assert.strictEqual(resolveMemoryInjectMode('Pi Agent', opts), 'l1-only');
      assert.strictEqual(resolveMemoryInjectMode('claude-code-acp', opts), 'l1-only');
      assert.strictEqual(resolveMemoryInjectMode('codex-acp', opts), 'l1-only');
    });

    test('Codex after a slash-first session still gets full on the first real prompt', () => {
      assert.strictEqual(
        resolveMemoryInjectMode('codex-acp', { sessionAlreadyPrompted: true, profileAlreadyInjected: false }),
        'full',
      );
    });
  });

  suite('shouldInjectMemoryForTurn', () => {
    test('all agents attach recall on later turns (L1); slash/disabled handled by caller', () => {
      assert.strictEqual(shouldInjectMemoryForTurn('claude-code-acp', true), true);
      assert.strictEqual(shouldInjectMemoryForTurn('codex-acp', true), true);
    });
  });
});

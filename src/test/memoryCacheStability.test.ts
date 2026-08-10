import * as assert from 'assert';
import { isIncrementalCacheAgent, shouldInjectMemoryForTurn } from '../core/MemoryCacheStability';

suite('MemoryCacheStability (codex-acp KV-cache gate)', () => {
  // Regression: vscode-acp re-injected the shared-memory recall blob at the
  // prefix of every codex-acp user turn. The recall content varies turn-to-turn
  // (L1 vector search shifts as L0 captures accumulate), so the leading bytes
  // of every cached user message changed → the Responses-API `previous_response_id`
  // prefix cache diverged at the first memory block and the entire cached
  // history was invalidated (proxy warned "msg_diff: PREFIX CHANGED"). The fix:
  // inject memory only on the FIRST turn of a codex-acp session — the block is
  // carried forward in the cached prefix via previous_response_id.

  suite('isIncrementalCacheAgent', () => {
    test('codex-acp is the incremental-path agent', () => {
      assert.strictEqual(isIncrementalCacheAgent('codex-acp'), true);
      assert.strictEqual(isIncrementalCacheAgent('Codex-ACP'), true);
    });

    test('non-codex agents are NOT incremental-path (no server prefix cache)', () => {
      assert.strictEqual(isIncrementalCacheAgent('claude-code-acp'), false);
      assert.strictEqual(isIncrementalCacheAgent('EricLI'), false);
      assert.strictEqual(isIncrementalCacheAgent('Kiro CLI'), false);
    });
  });

  suite('shouldInjectMemoryForTurn', () => {
    test('non-codex agents: inject every turn (no cache to invalidate)', () => {
      assert.strictEqual(shouldInjectMemoryForTurn('claude-code-acp', false), true);
      assert.strictEqual(shouldInjectMemoryForTurn('claude-code-acp', true), true);
      assert.strictEqual(shouldInjectMemoryForTurn('EricLI', true), true);
      assert.strictEqual(shouldInjectMemoryForTurn('Kiro CLI', true), true);
    });

    test('codex-acp: inject on the FIRST turn (no cached prefix yet)', () => {
      assert.strictEqual(shouldInjectMemoryForTurn('codex-acp', false), true);
    });

    test('codex-acp: SKIP on subsequent turns (memory already in cached prefix)', () => {
      assert.strictEqual(shouldInjectMemoryForTurn('codex-acp', true), false);
    });

    test('codex-acp: SKIP after a loaded/resumed session (prior turns → cached prefix exists)', () => {
      // A resumed session already has a server-side cached prefix, so the next
      // prompt is a continuation — re-injecting would shift the prefix.
      assert.strictEqual(shouldInjectMemoryForTurn('codex-acp', true), false);
    });
  });
});

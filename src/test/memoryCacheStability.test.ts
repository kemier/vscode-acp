import * as assert from 'assert';
import {
  isIncrementalCacheAgent,
  resolveMemoryInjectMode,
  shouldInjectMemoryForTurn,
  resetMemoryInjectGates,
  type MemoryInjectGates,
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

  suite('resetMemoryInjectGates', () => {
    function makeGates(...sessions: string[]): MemoryInjectGates {
      return {
        promptedSessions: new Set(sessions),
        memoryProfileInjectedSessions: new Set(sessions),
      };
    }

    function modeFor(
      gates: MemoryInjectGates,
      sessionId: string,
      agentName = 'codex-acp',
    ): ReturnType<typeof resolveMemoryInjectMode> {
      return resolveMemoryInjectMode(agentName, {
        sessionAlreadyPrompted: gates.promptedSessions.has(sessionId),
        profileAlreadyInjected: gates.memoryProfileInjectedSessions.has(sessionId),
      });
    }

    test('after compaction the memory gate resets to full (profile was summarized away)', () => {
      const gates = makeGates('sess-1');
      // Before compaction the session was already prompted with profile →
      // gate returns l1-only for the current turn (what would wrongly happen
      // after compaction if the gate were not reset).
      assert.strictEqual(modeFor(gates, 'sess-1'), 'l1-only');

      resetMemoryInjectGates('sess-1', gates);

      assert.strictEqual(gates.promptedSessions.has('sess-1'), false);
      assert.strictEqual(gates.memoryProfileInjectedSessions.has('sess-1'), false);
      // Next real prompt re-injects persona + scenes + <available_skills>.
      assert.strictEqual(modeFor(gates, 'sess-1'), 'full');
    });

    test('reset does not touch other sessions', () => {
      const gates = makeGates('sess-1', 'sess-2');
      resetMemoryInjectGates('sess-1', gates);
      assert.strictEqual(gates.promptedSessions.has('sess-2'), true);
      assert.strictEqual(gates.memoryProfileInjectedSessions.has('sess-2'), true);
      // sess-2 is untouched → still l1-only for its own turns.
      assert.strictEqual(modeFor(gates, 'sess-2'), 'l1-only');
    });

    test('reset is a no-op for unknown sessions', () => {
      const gates = makeGates('sess-1');
      resetMemoryInjectGates('never-prompted', gates);
      assert.strictEqual(gates.promptedSessions.size, 1);
      assert.strictEqual(gates.memoryProfileInjectedSessions.size, 1);
    });

    test('reset is a no-op for empty sessionId', () => {
      const gates = makeGates('sess-1');
      resetMemoryInjectGates('', gates);
      assert.strictEqual(gates.promptedSessions.size, 1);
      assert.strictEqual(gates.memoryProfileInjectedSessions.size, 1);
    });

    test('reset is idempotent', () => {
      const gates = makeGates('sess-1');
      resetMemoryInjectGates('sess-1', gates);
      resetMemoryInjectGates('sess-1', gates);
      assert.strictEqual(gates.promptedSessions.size, 0);
      assert.strictEqual(gates.memoryProfileInjectedSessions.size, 0);
    });

    test('compaction reset applies to every agent, not just codex-acp', () => {
      for (const agent of ['codex-acp', 'claude-code-acp', 'Pi Agent']) {
        const gates = makeGates('sess-1');
        resetMemoryInjectGates('sess-1', gates);
        assert.strictEqual(modeFor(gates, 'sess-1', agent), 'full', `agent=${agent}`);
      }
    });
  });

  suite('shouldInjectMemoryForTurn', () => {
    test('all agents attach recall on later turns (L1); slash/disabled handled by caller', () => {
      assert.strictEqual(shouldInjectMemoryForTurn('claude-code-acp', true), true);
      assert.strictEqual(shouldInjectMemoryForTurn('codex-acp', true), true);
    });
  });
});

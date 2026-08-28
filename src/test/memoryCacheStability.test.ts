import * as assert from 'assert';
import {
  isIncrementalCacheAgent,
  resolveMemoryInjectMode,
  shouldInjectMemoryForTurn,
  shouldInjectSkillsForMode,
  shouldInjectSkillToolsForMode,
  shouldIncludeL1WrapperForMode,
  shouldIncludeSkillsFooterForMode,
  shouldMarkProfileInjectedAfterRecall,
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

    test('Codex after slash with profile already injected gets l1-only on next turn', () => {
      assert.strictEqual(
        resolveMemoryInjectMode('codex-acp', { sessionAlreadyPrompted: true, profileAlreadyInjected: true }),
        'l1-only',
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

  suite('shouldInjectSkillsForMode (per-prompt semantic skills)', () => {
    test('skills are injected on full mode', () => {
      assert.strictEqual(shouldInjectSkillsForMode('full'), true);
    });

    test('skills are injected on l1-only turns (semantic-search, deduped by SharedMemoryProvider)', () => {
      assert.strictEqual(shouldInjectSkillsForMode('l1-only'), true);
    });

    test('skills are NOT injected when memory is disabled', () => {
      assert.strictEqual(shouldInjectSkillsForMode('none'), false);
    });

    test('after compaction skills are re-injected (dedup state cleared by resetL1Dedup)', () => {
      // The compaction path: gates reset → full mode → skills injected.
      // Dedup state is cleared by resetL1Dedup so all skills are fresh.
      const gates = { promptedSessions: new Set<string>(['sess-1']), memoryProfileInjectedSessions: new Set<string>(['sess-1']) };
      const before = resolveMemoryInjectMode('codex-acp', {
        sessionAlreadyPrompted: gates.promptedSessions.has('sess-1'),
        profileAlreadyInjected: gates.memoryProfileInjectedSessions.has('sess-1'),
      });
      assert.strictEqual(before, 'l1-only');
      assert.strictEqual(shouldInjectSkillsForMode(before), true);

      resetMemoryInjectGates('sess-1', gates);
      const after = resolveMemoryInjectMode('codex-acp', {
        sessionAlreadyPrompted: gates.promptedSessions.has('sess-1'),
        profileAlreadyInjected: gates.memoryProfileInjectedSessions.has('sess-1'),
      });
      assert.strictEqual(after, 'full');
      assert.strictEqual(shouldInjectSkillsForMode(after), true);
    });
  });

  suite('shouldInjectSkillToolsForMode (curl recipe once per profile)', () => {
    test('skill tools block only on full mode', () => {
      assert.strictEqual(shouldInjectSkillToolsForMode('full'), true);
      assert.strictEqual(shouldInjectSkillToolsForMode('l1-only'), false);
      assert.strictEqual(shouldInjectSkillToolsForMode('none'), false);
    });

    test('after compaction full mode re-injects skill tools', () => {
      const gates = {
        promptedSessions: new Set<string>(['sess-1']),
        memoryProfileInjectedSessions: new Set<string>(['sess-1']),
      };
      assert.strictEqual(shouldInjectSkillToolsForMode(resolveMemoryInjectMode('codex-acp', {
        sessionAlreadyPrompted: gates.promptedSessions.has('sess-1'),
        profileAlreadyInjected: gates.memoryProfileInjectedSessions.has('sess-1'),
      })), false);

      resetMemoryInjectGates('sess-1', gates);
      assert.strictEqual(shouldInjectSkillToolsForMode(resolveMemoryInjectMode('codex-acp', {
        sessionAlreadyPrompted: gates.promptedSessions.has('sess-1'),
        profileAlreadyInjected: gates.memoryProfileInjectedSessions.has('sess-1'),
      })), true);
    });
  });

  suite('shouldIncludeSkillsFooterForMode', () => {
    test('footer on every memory-enabled turn (self-contained memory_skill_view recipe)', () => {
      assert.strictEqual(shouldIncludeSkillsFooterForMode('full'), true);
      assert.strictEqual(shouldIncludeSkillsFooterForMode('l1-only'), true);
      assert.strictEqual(shouldIncludeSkillsFooterForMode('none'), false);
    });
  });

  suite('shouldIncludeL1WrapperForMode', () => {
    test('wrapper only on full mode', () => {
      assert.strictEqual(shouldIncludeL1WrapperForMode('full'), true);
      assert.strictEqual(shouldIncludeL1WrapperForMode('l1-only'), false);
      assert.strictEqual(shouldIncludeL1WrapperForMode('none'), false);
    });
  });

  suite('shouldMarkProfileInjectedAfterRecall', () => {
    test('marks after successful full inject including slash commands', () => {
      assert.strictEqual(
        shouldMarkProfileInjectedAfterRecall({ memoryInjectMode: 'full', memoryBlocksCount: 1 }),
        true,
      );
    });

    test('does not mark when full inject returned no blocks', () => {
      assert.strictEqual(
        shouldMarkProfileInjectedAfterRecall({ memoryInjectMode: 'full', memoryBlocksCount: 0 }),
        false,
      );
    });

    test('does not mark on l1-only turns', () => {
      assert.strictEqual(
        shouldMarkProfileInjectedAfterRecall({ memoryInjectMode: 'l1-only', memoryBlocksCount: 1 }),
        false,
      );
    });
  });
});

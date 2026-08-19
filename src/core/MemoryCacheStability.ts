/**
 * Memory injection policy for ACP prompts.
 *
 * Two layers:
 *
 * - **L3 persona + L2 scene nav** are agent-profile scoped and do not depend
 *   on the current question. They go on the first real (non-slash) prompt so
 *   later turns reuse them from conversation history.
 * - **L1 atomics** are a semantic search against the current user text
 *   (`/v3/atomic/search`, top-k). Those are injected every real user prompt.
 *
 * Placement (KV-cache):
 * - `full` — prepend persona/scenes/L1 before the user text (first real turn).
 * - `l1-only` — **append** L1 after the user text. For codex-acp this becomes
 *   extra `input` items on a `previous_response_id` request, which the proxy
 *   concatenates onto the cached conversation (pure append — no prefix change).
 *   Prepending L1 would still append at the Responses-API item list, but
 *   putting it after the user text keeps the new turn's leading bytes stable
 *   if blocks are concatenated into one user message (Pi / Claude).
 */

const CODEX_ACP_PATTERN = /codex/i;

/** What recall to attach on this user turn. */
export type MemoryInjectMode = 'none' | 'full' | 'l1-only';

/** True for agents on the OpenAI Responses-API incremental path (codex-acp). */
export function isIncrementalCacheAgent(agentName: string): boolean {
  return CODEX_ACP_PATTERN.test(agentName);
}

/**
 * Decide what memory to attach for this turn.
 *
 * All agents: persona+scenes+L1 until the profile blob has been sent, then
 * L1 only. Codex is included — later L1 is appended, not prepended, so the
 * cached prefix from `previous_response_id` stays intact.
 */
export function resolveMemoryInjectMode(
  _agentName: string,
  opts: { sessionAlreadyPrompted: boolean; profileAlreadyInjected: boolean },
): MemoryInjectMode {
  void opts.sessionAlreadyPrompted;
  return opts.profileAlreadyInjected ? 'l1-only' : 'full';
}

/**
 * Whether the <available_skills> block should be injected on this turn.
 *
 * Skills are agent-profile scoped (like persona + scenes): they are injected
 * once, on the first full prompt, and reused from conversation history on
 * later turns. On l1-only turns we do NOT re-fetch/re-inject skills — that
 * would duplicate the same skill list on every prompt in the session. After
 * compaction the gates reset to 'full', so skills are re-injected then.
 */
export function shouldInjectSkillsForMode(mode: MemoryInjectMode): boolean {
  return mode === 'full';
}

/** The two per-session gates that `resolveMemoryInjectMode` keys off. */
export interface MemoryInjectGates {
  promptedSessions: Set<string>;
  memoryProfileInjectedSessions: Set<string>;
}

/**
 * Reset the memory-inject gates for a session after its context was
 * compacted. Compaction summarizes/truncates the previously injected
 * profile block (persona + scenes + `<available_skills>`) away, so the next
 * prompt must take the `full` path again — keeping the gates set would send
 * only `l1-only` forever (until a brand-new session).
 *
 * Implemented as a pure function (per the team's pure-function SOP) so it
 * can be unit-tested without instantiating the dependency-heavy
 * `SessionManager`. `SessionManager.onContextCompacted` delegates here.
 *
 * No-op for empty `sessionId` or sessions not present in either set.
 */
export function resetMemoryInjectGates(
  sessionId: string,
  gates: MemoryInjectGates,
): void {
  if (!sessionId) {
    return;
  }
  gates.promptedSessions.delete(sessionId);
  gates.memoryProfileInjectedSessions.delete(sessionId);
}

/** True when any recall blob should be attached (full or L1-only). */
export function shouldInjectMemoryForTurn(_agentName: string, _sessionAlreadyPrompted: boolean): boolean {
  return true;
}

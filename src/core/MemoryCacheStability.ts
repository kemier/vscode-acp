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
  opts: { sessionAlreadyPrompted: boolean; profileAlreadyInjected: boolean; isSlashCommand?: boolean },
): MemoryInjectMode {
  void opts.sessionAlreadyPrompted;
  // A slash command is not an LLM turn — the agent intercepts it — so memory is
  // both useless and harmful there. Appending 5.8 KB after "/compact" made
  // ericli's `userText.trim() === '/compact'` guard miss, the command fell
  // through to the LLM, and the panel showed "Compacting conversation..." while
  // a fresh chat round started. Agents whose interception is token-based are
  // unaffected either way, so skipping is strictly safer.
  if (opts.isSlashCommand) {
    return 'none';
  }
  return opts.profileAlreadyInjected ? 'l1-only' : 'full';
}

/**
 * Whether the <available_skills> block should be injected on this turn.
 *
 * Skills are semantic-search results (query-relevant), so they are
 * injected on every prompt — both `full` and `l1-only` modes. Dedup
 * is handled by `SharedMemoryProvider` (tracks injected skill IDs
 * per session, filters on subsequent recalls, resets on compaction).
 *
 * The static <memory_skill_tools> curl block is NOT included here —
 * see `shouldInjectSkillToolsForMode` (first `full` turn only).
 *
 * Returns false only for `none` mode (memory disabled).
 */
export function shouldInjectSkillsForMode(mode: MemoryInjectMode): boolean {
  return mode !== 'none';
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
export function resetMemoryInjectGates(sessionId: string, gates: MemoryInjectGates): void {
  if (!sessionId) {
    return;
  }
  gates.promptedSessions.delete(sessionId);
  gates.memoryProfileInjectedSessions.delete(sessionId);
}

/**
 * Whether the <memory_skill_tools> curl recipe block should be injected on this turn.
 *
 * Unlike <available_skills> (semantic, per-prompt), the tools block is static
 * (~700 chars). Inject once on the first `full` profile turn; later `l1-only`
 * turns rely on conversation history for curl usage. Resets after compaction
 * (next prompt is `full` again).
 */
export function shouldInjectSkillToolsForMode(mode: MemoryInjectMode): boolean {
  return mode !== 'none';
}

/**
 * Whether the <available_skills> footer boilerplate should be injected on this turn.
 *
 * The footer carries the self-contained memory_skill_view curl recipe (when a
 * bridge base URL is configured), so it must be injected on EVERY turn — not
 * just the first `full` profile turn. Mid-chat `l1-only` turns list new skills
 * and the agent needs the recipe in its current context to load them via the
 * memory API instead of falling back to the filesystem. Returns false only for
 * `none` mode (memory disabled).
 */
export function shouldIncludeSkillsFooterForMode(mode: MemoryInjectMode): boolean {
  return mode !== 'none';
}

/**
 * Whether L1 bullets should be wrapped in `<relevant-memories>` on this turn.
 *
 * The wrapper is injected once on the first `full` profile turn. Later
 * `l1-only` turns append bare bullet lines (content deduped by id/hash).
 */
export function shouldIncludeL1WrapperForMode(mode: MemoryInjectMode): boolean {
  return mode === 'full';
}

/**
 * Mark the session profile gate after a successful full recall inject.
 *
 * Includes slash commands: if `/compact` (etc.) already prepended persona +
 * scenes into the transcript, the next real prompt should be `l1-only`, not
 * a duplicate full profile.
 */
export function shouldMarkProfileInjectedAfterRecall(opts: {
  memoryInjectMode: MemoryInjectMode;
  memoryBlocksCount: number;
}): boolean {
  return opts.memoryInjectMode === 'full' && opts.memoryBlocksCount > 0;
}

/** True when any recall blob should be attached (full or L1-only). */
export function shouldInjectMemoryForTurn(_agentName: string, _sessionAlreadyPrompted: boolean): boolean {
  return true;
}

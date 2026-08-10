/**
 * Pure helper for the codex-acp KV-cache-stability gate.
 *
 * codex-acp is the only ACP agent on the OpenAI Responses-API incremental path
 * (`previous_response_id`). The proxy maintains a server-side prefix cache
 * keyed on the exact byte sequence of the conversation. vscode-acp injects the
 * shared-memory recall blob at the *prefix* of every prompt
 * (`SessionManager.sendPrompt` pushes `memoryBlocks` before the user text),
 * and the recall content varies turn-to-turn (the L1 vector search shifts as
 * L0 captures accumulate). Re-injecting a different blob at the prefix of every
 * user turn diverges the prefix at the first memory block and invalidates the
 * entire cached history — the proxy warns
 * `msg_diff: PREFIX CHANGED (KV-cache break!)` and the backend must re-prefill
 * the full context.
 *
 * The first turn's memory block is already carried forward in the cached prefix
 * via `previous_response_id`, so re-injecting on later turns is both redundant
 * AND destabilizing for codex-acp specifically. claude-code-acp and ericli
 * re-send the full conversation every turn (no server cache), so they are
 * unaffected and continue to receive fresh recall each turn.
 */

/**
 * Agent names matching this pattern are treated as codex-acp (the Responses-API
 * incremental path). `/codex/i` mirrors the MemoryAgentId built-in heuristic.
 */
const CODEX_ACP_PATTERN = /codex/i;

/** True for agents on the OpenAI Responses-API incremental path (codex-acp). */
export function isIncrementalCacheAgent(agentName: string): boolean {
  return CODEX_ACP_PATTERN.test(agentName);
}

/**
 * Decide whether memory recall should be injected for this turn.
 *
 * Returns true (inject memory) when:
 *  - the agent is NOT on the incremental cache path (claude-code-acp, ericli,
 *    kiro, …) — they have no server-side prefix cache, so fresh recall every
 *    turn is free; OR
 *  - the agent IS on the incremental path but this is its first prompt in the
 *    session (no cached prefix exists yet to invalidate).
 *
 * Returns false (skip injection) when the agent is on the incremental path AND
 * the session has already been prompted (or loaded/resumed with prior turns) —
 * the memory block from the first turn is already in the cached prefix via
 * `previous_response_id`, and re-injecting would shift the prefix and break
 * the KV cache.
 */
export function shouldInjectMemoryForTurn(agentName: string, sessionAlreadyPrompted: boolean): boolean {
  if (!isIncrementalCacheAgent(agentName)) {
    return true;
  }
  // codex-acp: only inject on the first turn of the session.
  return !sessionAlreadyPrompted;
}

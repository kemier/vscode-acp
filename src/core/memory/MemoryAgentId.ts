/**
 * Model B agent_id mapping — pure helpers (no vscode dependency).
 *
 * Shared team_id across ACP agents; each agent type maps to its own
 * MemoryCore agent_id so L2/L3 profiles stay separate.
 */

/** Built-in name → agent_id heuristics for common ACP agents. */
const BUILTIN_AGENT_ID_RULES: Array<{ test: RegExp; id: string }> = [
  { test: /claude/i, id: 'claude' },
  { test: /codex/i, id: 'codex' },
  { test: /kiro/i, id: 'kiro' },
  { test: /cursor/i, id: 'cursor' },
  { test: /hermes/i, id: 'hermes' },
  { test: /eric/i, id: 'ericli' },
  { test: /gemini/i, id: 'gemini' },
  { test: /qwen/i, id: 'qwen' },
  { test: /opencode/i, id: 'opencode' },
  { test: /openclaw/i, id: 'openclaw' },
  { test: /copilot/i, id: 'copilot' },
];

/**
 * Map an ACP agent display/config name to a MemoryCore `agent_id` (Model B).
 * Explicit `agentIdMap` entries win; otherwise built-in heuristics; otherwise
 * a sanitized slug of the agent name.
 */
export function resolveMemoryAgentId(agentName: string, agentIdMap: Record<string, string> = {}): string {
  const trimmed = agentName.trim();
  if (!trimmed) {
    throw new Error('resolveMemoryAgentId requires a non-empty agentName');
  }

  if (agentIdMap[trimmed]) {
    return agentIdMap[trimmed];
  }
  const lower = trimmed.toLowerCase();
  for (const [key, value] of Object.entries(agentIdMap)) {
    if (key.toLowerCase() === lower) {
      return value;
    }
  }

  for (const rule of BUILTIN_AGENT_ID_RULES) {
    if (rule.test.test(trimmed)) {
      return rule.id;
    }
  }

  const slug = lower
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  if (!slug) {
    throw new Error(`Cannot derive memory agent_id from agent name "${agentName}"`);
  }
  return slug;
}

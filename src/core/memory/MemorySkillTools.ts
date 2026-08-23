/**
 * Injects read-only memory-skill tool recipes for the Cursor/ACP path.
 *
 * The LLM does not get native tools here — it uses Shell curl against the
 * extension-hosted MemorySkillBridge (localhost, no API key in the prompt).
 */

export interface MemorySkillToolsOptions {
  /** Bridge base URL, e.g. http://127.0.0.1:8126 */
  bridgeBaseUrl: string;
  /** MemoryCore agent_id for the active ACP agent (Model B). */
  agentId: string;
}

export function formatMemorySkillTools(opts: MemorySkillToolsOptions): string {
  const base = opts.bridgeBaseUrl.replace(/\/+$/, '');
  const agentId = opts.agentId.replace(/"/g, '\\"');

  return [
    '<memory_skill_tools>',
    'The <available_skills> block above lists **name + description only**.',
    'Before following a memory skill — or when one skill references another as a prerequisite —',
    'load the full SKILL.md with **memory_skill_view** (Shell curl).',
    '',
    '  <tool name="memory_skill_view">',
    `    curl -sf -X POST ${base}/view \\`,
    `      -H 'Content-Type: application/json' \\`,
    `      -d '{"name":"<skill-name>","agent_id":"${agentId}"}'`,
    '    use: Load full SKILL.md for a memory skill by name. Use names from <available_skills>,',
    '         skill_search results, or backtick references inside another skill (e.g. prerequisites).',
    '         Returns JSON: { name, description, version, content }.',
    '  </tool>',
    '',
    '  <tool name="memory_skill_search">',
    `    curl -sf -X POST ${base}/search \\`,
    `      -H 'Content-Type: application/json' \\`,
    `      -d '{"query":"<keywords>","agent_id":"${agentId}"}'`,
    '    use: Semantic search across team memory skills when the skill you need is not listed above.',
    '  </tool>',
    '',
    'Err on the side of loading — prerequisite skills are often NOT listed in <available_skills>.',
    '</memory_skill_tools>',
  ].join('\n');
}

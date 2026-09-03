/**
 * Injects read-only memory-skill tool recipes for the Cursor/ACP path.
 *
 * The LLM does not get native tools here — it uses Shell against the
 * extension-hosted MemorySkillBridge (localhost, no API key in the prompt).
 *
 * On Windows the recipe uses Invoke-RestMethod (PowerShell-safe). On other
 * platforms it uses curl with single-quoted JSON (POSIX shells).
 */

export interface MemorySkillToolsOptions {
  /** Bridge base URL, e.g. http://127.0.0.1:8126 */
  bridgeBaseUrl: string;
  /** MemoryCore agent_id for the active ACP agent (Model B). */
  agentId: string;
  /** Override platform detection (defaults to process.platform). */
  platform?: NodeJS.Platform;
}

export type SkillBridgeShell = 'win32' | 'posix';

export function resolveSkillBridgeShell(platform: NodeJS.Platform = process.platform): SkillBridgeShell {
  return platform === 'win32' ? 'win32' : 'posix';
}

/** One-line POST /view recipe for the active shell. */
export function formatSkillBridgeViewCommand(
  bridgeBaseUrl: string,
  agentId: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const base = bridgeBaseUrl.replace(/\/+$/, '');
  const id = agentId.replace(/'/g, '').replace(/"/g, '\\"');
  if (resolveSkillBridgeShell(platform) === 'win32') {
    // PowerShell: single-quoted -Body keeps JSON double-quotes intact.
    // Do not use bare `curl` — it aliases to Invoke-WebRequest.
    return (
      `Invoke-RestMethod -Method Post -Uri '${base}/view' ` +
      `-ContentType 'application/json' ` +
      `-Body '{"name":"<skill-name>","agent_id":"${id}"}'`
    );
  }
  return (
    `curl -sf -X POST ${base}/view ` +
    `-H 'Content-Type: application/json' ` +
    `-d '{"name":"<skill-name>","agent_id":"${id}"}'`
  );
}

/** One-line POST /search recipe for the active shell. */
export function formatSkillBridgeSearchCommand(
  bridgeBaseUrl: string,
  agentId: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const base = bridgeBaseUrl.replace(/\/+$/, '');
  const id = agentId.replace(/'/g, '').replace(/"/g, '\\"');
  if (resolveSkillBridgeShell(platform) === 'win32') {
    return (
      `Invoke-RestMethod -Method Post -Uri '${base}/search' ` +
      `-ContentType 'application/json' ` +
      `-Body '{"query":"<keywords>","agent_id":"${id}"}'`
    );
  }
  return (
    `curl -sf -X POST ${base}/search ` +
    `-H 'Content-Type: application/json' ` +
    `-d '{"query":"<keywords>","agent_id":"${id}"}'`
  );
}

/**
 * One-line POST recipe for a bridge endpoint taking a single JSON body.
 *
 * conversation-lookup and memory-search arrived with `curl -sf` hardcoded and the
 * -H/-d parts as separate array entries, so on Windows they printed a command
 * PowerShell cannot run (bare `curl` aliases to Invoke-WebRequest) and everywhere
 * else the flags landed on their own lines. Mirrors the view/search builders.
 */
export function formatSkillBridgePostCommand(
  bridgeBaseUrl: string,
  endpoint: string,
  bodyJson: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const base = bridgeBaseUrl.replace(/\/+$/, '');
  const path = endpoint.replace(/^\/+/, '');
  if (resolveSkillBridgeShell(platform) === 'win32') {
    return (
      `Invoke-RestMethod -Method Post -Uri '${base}/${path}' ` +
      `-ContentType 'application/json' ` +
      `-Body '${bodyJson}'`
    );
  }
  return (
    `curl -sf -X POST ${base}/${path} ` +
    `-H 'Content-Type: application/json' ` +
    `-d '${bodyJson}'`
  );
}

export function formatMemorySkillTools(opts: MemorySkillToolsOptions): string {
  const platform = opts.platform ?? process.platform;
  const viewCmd = formatSkillBridgeViewCommand(opts.bridgeBaseUrl, opts.agentId, platform);
  const searchCmd = formatSkillBridgeSearchCommand(opts.bridgeBaseUrl, opts.agentId, platform);
  const id = opts.agentId.replace(/'/g, '').replace(/"/g, '\\"');
  const lookupCmd = formatSkillBridgePostCommand(
    opts.bridgeBaseUrl,
    'conversation-lookup',
    `{"conversation_ids":["<id1>","<id2>"],"agent_id":"${id}"}`,
    platform,
  );
  const memorySearchCmd = formatSkillBridgePostCommand(
    opts.bridgeBaseUrl,
    'memory-search',
    `{"query":"<keywords>","agent_id":"${id}"}`,
    platform,
  );
  const shellHint =
    resolveSkillBridgeShell(platform) === 'win32'
      ? 'Shell Invoke-RestMethod (PowerShell — do not use the `curl` alias)'
      : 'Shell curl';

  return [
    '<memory_skill_tools>',
    'The <available_skills> block above lists **name + description only**.',
    'Before following a memory skill — or when one skill references another as a prerequisite —',
    `load the full SKILL.md with **memory_skill_view** (${shellHint}).`,
    '',
    '  <tool name="memory_skill_view">',
    `    ${viewCmd}`,
    '    use: Load full SKILL.md for a memory skill by name. Use names from <available_skills>,',
    '         skill_search results, or backtick references inside another skill (e.g. prerequisites).',
    '         Returns JSON: { name, description, version, content }.',
    '  </tool>',
    '',
    '  <tool name="memory_skill_search">',
    `    ${searchCmd}`,
    '    use: Semantic search across team memory skills when the skill you need is not listed above.',
    '  </tool>',
    '',
    '  <tool name="memory_conversation_lookup">',
    `    ${lookupCmd}`,
    '    use: Get raw L0 conversation details (tool calls, results, messages) for',
    '         specific conversation IDs referenced by L1 memories. The source_message_ids',
    '         field in search results provides the IDs to look up.',
    '  </tool>',
    '',
    '  <tool name="memory_memory_search">',
    `    ${memorySearchCmd}`,
    '    use: Semantic search across L1 memories (facts, preferences, decisions,',
    '         work history). Returns scored results with source_message_ids for',
    '         drill-down. Use when you need to recall something from past work.',
    '  </tool>',
    '',
    'Err on the side of loading — prerequisite skills are often NOT listed in <available_skills>.',
    '</memory_skill_tools>',
  ].join('\n');
}

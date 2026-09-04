/**
 * Format MemoryCore recall results for ACP prompt injection.
 */

import {
  formatSkillBridgeSearchCommand,
  formatSkillBridgeUpdateCommand,
  formatSkillBridgeViewCommand,
} from './MemorySkillTools';

export interface L1MemoryItem {
  id?: string;
  content: string;
  type?: string;
  score?: number;
}

export interface SceneNavEntry {
  path: string;
}

export interface SkillEntry {
  skill_id: string;
  name: string;
  description: string;
  version: number;
}

export interface FormattedRecall {
  /** Combined markdown injected as an ACP memory ContentBlock. */
  text: string;
  l1Count: number;
  hasPersona: boolean;
  sceneCount: number;
  skillCount: number;
}

/** Maximum character length per individual L1 memory item. Some memories
 *  are long paragraphs; truncate to keep the total recall block bounded. */
const MAX_L1_ITEM_CHARS = 500;

export interface FormatRecallOptions {
  /** Wrap L1 bullets in `<relevant-memories>` (first full profile turn only). */
  includeL1Wrapper?: boolean;
  /** Append skills footer boilerplate (every turn when memory enabled). */
  includeSkillsFooter?: boolean;
  /** MemorySkillBridge base URL, e.g. http://127.0.0.1:8127. When set and the
   *  footer is included, the footer embeds the self-contained memory_skill_view
   *  recipe so later l1-only turns don't rely on recalling it from the
   *  first full profile turn. */
  bridgeBaseUrl?: string;
  /** MemoryCore agent_id for the active ACP agent (Model B). Used to fill the
   *  self-contained memory_skill_view recipe's agent_id, so the footer is
   *  directly usable without the agent substituting a placeholder. */
  agentId?: string;
  /** Override host platform for recipe formatting (defaults to process.platform). */
  platform?: NodeJS.Platform;
}

export function formatL1Memories(items: L1MemoryItem[], opts?: { includeWrapper?: boolean }): string | undefined {
  if (items.length === 0) {
    return undefined;
  }
  const includeWrapper = opts?.includeWrapper !== false;
  const lines: string[] = [];
  if (includeWrapper) {
    lines.push('<relevant-memories>', '');
  }
  for (const item of items) {
    const typeTag = item.type ? `[${item.type}] ` : '';
    let text = item.content;
    if (text.length > MAX_L1_ITEM_CHARS) {
      text = text.slice(0, MAX_L1_ITEM_CHARS) + '…';
    }
    lines.push(`- ${typeTag}${text}`);
  }
  if (includeWrapper) {
    lines.push('', '</relevant-memories>');
  }
  return lines.join('\n');
}

/** Maximum character budget for the L3 persona block. The persona is injected
 *  on every turn for non-incremental agents (claude-code-acp, ericli) and
 *  carries the full "Team Operating Doctrine" + scene navigation index (L2).
 *  The scene index sits near the END of the persona, so the cap must be large
 *  enough to keep it: a 2000-char cap truncated the persona before the scene
 *  section, silently dropping L2 scenario memory. 4000 chars (~1000 tokens)
 *  keeps the doctrine + scene index while still bounding the overhead. */
const MAX_PERSONA_CHARS = 4000;

export function formatPersona(persona: string | null | undefined): string | undefined {
  if (!persona?.trim()) {
    return undefined;
  }
  let trimmed = persona.trim();
  if (trimmed.length > MAX_PERSONA_CHARS) {
    trimmed = trimmed.slice(0, MAX_PERSONA_CHARS) + '\n…(persona truncated)';
  }
  return `<user-persona>\n${trimmed}\n</user-persona>`;
}

export function formatSkills(
  skills: SkillEntry[],
  opts?: {
    includeFooter?: boolean;
    bridgeBaseUrl?: string;
    agentId?: string;
    platform?: NodeJS.Platform;
  },
): string | undefined {
  if (skills.length === 0) {
    return undefined;
  }
  const includeFooter = opts?.includeFooter !== false;
  const base = opts?.bridgeBaseUrl?.replace(/\/+$/, '') || '';
  const agentId = opts?.agentId || '';
  const platform = opts?.platform ?? process.platform;
  const lines: string[] = ['<available_skills>', ''];
  for (const s of skills) {
    lines.push(`- **${s.name}** (v${s.version}): ${s.description}`);
  }
  if (includeFooter) {
    lines.push('');
    lines.push('These are memory-injected skills (metadata only — not full SKILL.md).');
    if (base) {
      // Self-contained recipe so later l1-only turns don't need to recall the
      // syntax from the first full profile turn (platform-aware for Windows).
      lines.push('Load full SKILL.md from the memory system (NOT the filesystem — memory skills are API-only):');
      lines.push(`  ${formatSkillBridgeViewCommand(base, agentId, platform)}`);
      lines.push('Search for a skill not listed above:');
      lines.push(`  ${formatSkillBridgeSearchCommand(base, agentId, platform)}`);
      lines.push('Update a stale skill\'s content (full SKILL.md overwrite; resolve skill_id via view/search):');
      lines.push(`  ${formatSkillBridgeUpdateCommand(base, agentId, platform)}`);
      lines.push('');
      lines.push('If /view returns SKILL_NOT_FOUND (HTTP 502), the skill is FILESYSTEM-only, not in memory.');
      lines.push('Read it directly: `cat ~/.cli-4-ericai/skills/<name>/SKILL.md` (or the Read tool).');
      lines.push('Do NOT retry the API for a skill that returned SKILL_NOT_FOUND.');
    } else {
      lines.push(
        'Load full instructions with memory_skill_view (Shell; recipe on first profile turn — see session history).',
      );
    }
    lines.push('Filesystem skills (e.g. ~/.cursor/skills-cursor/) are loaded via the Read tool — NOT the API above. If /view returns SKILL_NOT_FOUND, the skill is filesystem-only: read `~/.cli-4-ericai/skills/<name>/SKILL.md` directly.');
  }
  lines.push('</available_skills>');
  return lines.join('\n');
}

/** Maximum number of scene nav entries to include. Each entry is a path +
 *  summary that can be 100+ chars; with 14+ scenes this adds 2.5K+ chars
 *  (~600 tokens) per turn. Cap at 8 entries to keep the overhead reasonable. */
const MAX_SCENE_ENTRIES = 8;

export function formatSceneNav(scenes: SceneNavEntry[]): string | undefined {
  if (scenes.length === 0) {
    return undefined;
  }
  const lines: string[] = [
    '## Scene Navigation',
    '*Agent-profile scenario index (L2). Paths are relative to this agent memory profile.*',
    '',
  ];
  const capped = scenes.slice(0, MAX_SCENE_ENTRIES);
  for (const scene of capped) {
    lines.push(`- \`${scene.path}\``);
  }
  if (scenes.length > MAX_SCENE_ENTRIES) {
    lines.push(`- _(+${scenes.length - MAX_SCENE_ENTRIES} more scenes — read from memory to view)_`);
  }
  return lines.join('\n');
}

/**
 * Hard cap on the total <agent-memory> blob size (chars). Final safety net
 * after per-section caps. Even if the gateway returns unbounded L1 content
 * (the /v3/atomic/search endpoint does NOT apply maxCharsPerMemory/
 * maxTotalRecallChars — those only run in the OpenClaw recall hook path),
 * the blob injected into the prompt is bounded. ~8000 chars ≈ 2000 tokens.
 */
const MAX_TOTAL_BLOB_CHARS = 9000;

/**
 * Assemble the <agent-memory> blob from already-formatted section parts, then
 * enforce MAX_TOTAL_BLOB_CHARS by DROPPING whole sections in priority order
 * (least valuable first) instead of blind end-truncation.
 *
 * Old behavior sliced the blob from the end, which cut the persona's embedded
 * L2 scene index and the skill list mid-entry. Now, when over budget we shed:
 *   1. skill entries (re-fetchable via the footer recipe) — down to none
 *   2. the dedicated L2 scene-nav block (persona keeps its own scene index)
 *   3. L1 items beyond the first (the top-ranked memory is kept)
 * and only as a last resort hard-slice the remainder. This guarantees the L3
 * persona (with its scene index) and at least the top L1 memory survive.
 */
function buildBlobWithPriorityDrop(
  l1: string | undefined,
  personaBlock: string | undefined,
  sceneBlock: string | undefined,
  skills: SkillEntry[],
  skillToolsBlock: string | undefined,
  skillOpts: { includeFooter: boolean; bridgeBaseUrl?: string; agentId?: string; platform?: NodeJS.Platform },
): string | undefined {
  const assemble = (keptSkills: SkillEntry[], includeScene: boolean, keptL1: string | undefined): string | undefined => {
    const parts: string[] = [];
    if (keptL1) {
      parts.push(keptL1);
    }
    if (personaBlock) {
      parts.push(personaBlock);
    }
    if (includeScene && sceneBlock) {
      parts.push(sceneBlock);
    }
    const skillBlock = formatSkills(keptSkills, skillOpts);
    if (skillBlock) {
      parts.push(skillBlock);
    }
    if (skillToolsBlock?.trim()) {
      parts.push(skillToolsBlock.trim());
    }
    if (parts.length === 0) {
      return undefined;
    }
    return `<agent-memory>\n${parts.join('\n\n')}\n</agent-memory>`;
  };

  const fits = (blob: string | undefined): boolean => !!blob && blob.length <= MAX_TOTAL_BLOB_CHARS;

  // 1. Full blob. If it fits, done.
  let blob = assemble(skills, true, l1);
  if (fits(blob)) {
    return blob;
  }
  // 2. Drop skill entries one at a time (keep the footer so the recipe stays).
  for (let n = skills.length - 1; n >= 0; n--) {
    blob = assemble(skills.slice(0, n), true, l1);
    if (fits(blob)) {
      return blob;
    }
  }
  // 3. Drop the dedicated scene-nav block (persona keeps its embedded index).
  blob = assemble([], false, l1);
  if (fits(blob)) {
    return blob;
  }
  // 4. Drop L1 items beyond the first (top-ranked memory is most relevant).
  if (l1 && l1.split('\n').filter((ln) => ln.startsWith('- ')).length > 1) {
    const firstItem = l1.split('\n').find((ln) => ln.startsWith('- '));
    const keptL1 = l1.includes('<relevant-memories>')
      ? `<relevant-memories>\n${firstItem}\n</relevant-memories>`
      : (firstItem ?? l1);
    blob = assemble([], false, keptL1);
    if (fits(blob)) {
      return blob;
    }
  }
  // 5. Last resort: hard-slice the minimal blob (persona + top L1).
  const minimal = assemble([], false, l1);
  if (!minimal) {
    return undefined;
  }
  if (minimal.length <= MAX_TOTAL_BLOB_CHARS) {
    return minimal;
  }
  return minimal.slice(0, MAX_TOTAL_BLOB_CHARS - 20) + '\n…</agent-memory>';
}

/**
 * Build a single injectable recall blob for ACP ContentBlocks.
 * Combines L1 (dynamic) + L3 persona + L2 scene nav + skills (Model B agent profile).
 */
export function formatRecallContext(
  l1Items: L1MemoryItem[],
  persona: string | null | undefined,
  scenes: SceneNavEntry[],
  skills: SkillEntry[] = [],
  skillToolsBlock?: string,
  formatOpts?: FormatRecallOptions,
): FormattedRecall | undefined {
  const includeL1Wrapper = formatOpts?.includeL1Wrapper !== false;
  const includeSkillsFooter = formatOpts?.includeSkillsFooter !== false;
  const bridgeBaseUrl = formatOpts?.bridgeBaseUrl;
  const agentId = formatOpts?.agentId;
  const platform = formatOpts?.platform;

  const l1 = formatL1Memories(l1Items, { includeWrapper: includeL1Wrapper });
  const personaBlock = formatPersona(persona);
  const sceneBlock = formatSceneNav(scenes);
  const sceneSuppressed = !!persona && persona.includes('Scene Navigation');

  const blob = buildBlobWithPriorityDrop(l1, personaBlock, sceneSuppressed ? undefined : sceneBlock, skills, skillToolsBlock, {
    includeFooter: includeSkillsFooter,
    bridgeBaseUrl,
    agentId,
    platform,
  });
  if (!blob) {
    return undefined;
  }
  return {
    text: blob,
    l1Count: l1Items.length,
    hasPersona: !!personaBlock,
    sceneCount: scenes.length,
    skillCount: skills.length,
  };
}

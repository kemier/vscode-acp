/**
 * Format MemoryCore recall results for ACP prompt injection.
 */

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

export function formatL1Memories(items: L1MemoryItem[]): string | undefined {
  if (items.length === 0) {
    return undefined;
  }
  const lines: string[] = ['<relevant-memories>', ''];
  for (const item of items) {
    const typeTag = item.type ? `[${item.type}] ` : '';
    let text = item.content;
    if (text.length > MAX_L1_ITEM_CHARS) {
      text = text.slice(0, MAX_L1_ITEM_CHARS) + '…';
    }
    lines.push(`- ${typeTag}${text}`);
  }
  lines.push('', '</relevant-memories>');
  return lines.join('\n');
}

/** Maximum character budget for the L3 persona block. The persona is injected
 *  on every turn for non-incremental agents (claude-code-acp, ericli) and
 *  carries the full "Team Operating Doctrine" + scene navigation index.
 *  Without a cap, the persona grows unbounded as scene blocks accumulate,
 *  consuming 5K+ chars (~1.4K tokens) per turn — a significant fraction of
 *  the 196K context window when the conversation is long. Truncate at 3K
 *  chars (~750 tokens) to keep the overhead bounded. */
const MAX_PERSONA_CHARS = 2000;

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

export function formatSkills(skills: SkillEntry[]): string | undefined {
  if (skills.length === 0) {
    return undefined;
  }
  const lines: string[] = ['<available_skills>', ''];
  for (const s of skills) {
    lines.push(`- **${s.name}** (v${s.version}): ${s.description}`);
  }
  lines.push('');
  lines.push('These are memory-injected skills extracted from past conversations.');
  lines.push('Their full instructions are already loaded in this block — follow them when relevant.');
  lines.push('Filesystem skills (e.g. ~/.codex/skills/) are loaded separately via the Skill tool.');
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
const MAX_TOTAL_BLOB_CHARS = 8000;

/**
 * Build a single injectable recall blob for ACP ContentBlocks.
 * Combines L1 (dynamic) + L3 persona + L2 scene nav + skills (Model B agent profile).
 */
export function formatRecallContext(
  l1Items: L1MemoryItem[],
  persona: string | null | undefined,
  scenes: SceneNavEntry[],
  skills: SkillEntry[] = [],
): FormattedRecall | undefined {
  const parts: string[] = [];
  const l1 = formatL1Memories(l1Items);
  if (l1) {
    parts.push(l1);
  }
  const personaBlock = formatPersona(persona);
  if (personaBlock) {
    parts.push(personaBlock);
  }
  const sceneBlock = formatSceneNav(scenes);
  if (sceneBlock && (!persona || !persona.includes('Scene Navigation'))) {
    parts.push(sceneBlock);
  }
  const skillBlock = formatSkills(skills);
  if (skillBlock) {
    parts.push(skillBlock);
  }
  if (parts.length === 0) {
    return undefined;
  }
  let blob = `<agent-memory>\n${parts.join('\n\n')}\n</agent-memory>`;
  // Final safety net: cap the total blob size. If per-section caps weren't
  // enough (e.g. many L1 items, large persona from gateway), truncate from
  // the end to preserve the prefix (L1 memories are most relevant).
  if (blob.length > MAX_TOTAL_BLOB_CHARS) {
    blob = blob.slice(0, MAX_TOTAL_BLOB_CHARS - 20) + '\n…</agent-memory>';
  }
  return {
    text: blob,
    l1Count: l1Items.length,
    hasPersona: !!personaBlock,
    sceneCount: scenes.length,
    skillCount: skills.length,
  };
}

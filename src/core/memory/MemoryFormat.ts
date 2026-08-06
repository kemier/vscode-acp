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

export interface FormattedRecall {
  /** Combined markdown injected as an ACP memory ContentBlock. */
  text: string;
  l1Count: number;
  hasPersona: boolean;
  sceneCount: number;
}

export function formatL1Memories(items: L1MemoryItem[]): string | undefined {
  if (items.length === 0) {
    return undefined;
  }
  const lines: string[] = ['<relevant-memories>', ''];
  for (const item of items) {
    const typeTag = item.type ? `[${item.type}] ` : '';
    lines.push(`- ${typeTag}${item.content}`);
  }
  lines.push('', '</relevant-memories>');
  return lines.join('\n');
}

export function formatPersona(persona: string | null | undefined): string | undefined {
  if (!persona?.trim()) {
    return undefined;
  }
  return `<user-persona>\n${persona.trim()}\n</user-persona>`;
}

export function formatSceneNav(scenes: SceneNavEntry[]): string | undefined {
  if (scenes.length === 0) {
    return undefined;
  }
  const lines: string[] = [
    '## Scene Navigation',
    '*Agent-profile scenario index (L2). Paths are relative to this agent memory profile.*',
    '',
  ];
  for (const scene of scenes) {
    lines.push(`- \`${scene.path}\``);
  }
  return lines.join('\n');
}

/**
 * Build a single injectable recall blob for ACP ContentBlocks.
 * Combines L1 (dynamic) + L3 persona + L2 scene nav (Model B agent profile).
 */
export function formatRecallContext(
  l1Items: L1MemoryItem[],
  persona: string | null | undefined,
  scenes: SceneNavEntry[],
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
  if (parts.length === 0) {
    return undefined;
  }
  return {
    text: `<agent-memory>\n${parts.join('\n\n')}\n</agent-memory>`,
    l1Count: l1Items.length,
    hasPersona: !!personaBlock,
    sceneCount: scenes.length,
  };
}

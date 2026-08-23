/**
 * Per-session dedup keys for L1 memories and skills.
 *
 * Prefer stable gateway IDs; fall back to content hash when id is missing
 * so the same item is not re-injected every turn.
 */
import { createHash } from 'crypto';

import type { L1MemoryItem, SkillEntry } from './MemoryFormat';

function contentHash(content: string): string {
  const normalized = content.trim();
  if (!normalized) {
    return '';
  }
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/** Dedup key for an L1 memory item (id or content hash). */
export function l1DedupKey(item: L1MemoryItem): string | undefined {
  if (item.id?.trim()) {
    return item.id.trim();
  }
  const h = contentHash(item.content);
  return h ? `h:${h}` : undefined;
}

/** Dedup key for a skill entry (skill_id or name+description hash). */
export function skillDedupKey(skill: SkillEntry): string | undefined {
  if (skill.skill_id?.trim()) {
    return skill.skill_id.trim();
  }
  const h = contentHash(`${skill.name}\0${skill.description}`);
  return h ? `h:${h}` : undefined;
}

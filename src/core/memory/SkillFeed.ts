/**
 * Skill-pipeline message building (pure — unit-testable without vscode).
 *
 * The memory gateway's skill extraction pipeline archives a per-session
 * buffer once it holds ≥10 `tool_call`-role messages (or ≥40KB of bytes) and
 * only then runs LLM-based skill extraction. Turns must therefore forward
 * their tool calls as `tool_call` messages; user/assistant text alone can
 * never reach the threshold.
 */
import { truncateForCapture } from './MemorySanitize';

/** Bound on tool_call messages forwarded per turn to the skill pipeline. */
export const MAX_SKILL_TOOL_CALLS_PER_TURN = 200;

export interface SkillToolCall {
  id: string;
  title: string;
  timestamp: string;
}

export interface SkillConversationMessage {
  role: string;
  content: string;
  timestamp?: string;
  tool_call_id?: string;
}

/**
 * Build the skill-pipeline message list for a turn: user text first, then the
 * turn's tool calls (each as a `tool_call`-role message), then the assistant
 * text. Tool calls are deduped by id and capped so a long tool-heavy turn
 * can't blow up the request.
 */
export function buildSkillConversationMessages(
  messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }>,
  toolCalls: SkillToolCall[],
): SkillConversationMessage[] {
  const result: SkillConversationMessage[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      result.push({ role: 'user', content: m.content, timestamp: m.timestamp });
    }
  }
  const seen = new Set<string>();
  let added = 0;
  for (const tc of toolCalls) {
    if (added >= MAX_SKILL_TOOL_CALLS_PER_TURN) {
      break;
    }
    if (!tc.id || !tc.title || seen.has(tc.id)) {
      continue;
    }
    seen.add(tc.id);
    result.push({
      role: 'tool_call',
      content: truncateForCapture(tc.title),
      tool_call_id: tc.id,
      timestamp: tc.timestamp,
    });
    added++;
  }
  for (const m of messages) {
    if (m.role === 'assistant') {
      result.push({ role: 'assistant', content: m.content, timestamp: m.timestamp });
    }
  }
  return result;
}

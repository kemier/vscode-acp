/**
 * Client-side sanitization for L0 capture.
 * Mirrors TencentDB-Agent-Memory OpenClaw plugin sanitize helpers so injected
 * recall blobs are not written back into memory (feedback loop).
 */

/** Strip injected memory tags + media markers before L0 capture. */
export function sanitizeMemoryText(text: string): string {
  let cleaned = text;

  cleaned = cleaned.replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>/g, '');
  cleaned = cleaned.replace(/<user-persona>[\s\S]*?<\/user-persona>/g, '');
  cleaned = cleaned.replace(/<relevant-scenes>[\s\S]*?<\/relevant-scenes>/g, '');
  cleaned = cleaned.replace(/<scene-navigation>[\s\S]*?<\/scene-navigation>/g, '');
  cleaned = cleaned.replace(/<memory-tools-guide>[\s\S]*?<\/memory-tools-guide>/g, '');
  cleaned = cleaned.replace(/<agent-memory>[\s\S]*?<\/agent-memory>/g, '');

  cleaned = cleaned.replace(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/gi, '');
  cleaned = cleaned
    .replace(/\0/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return cleaned;
}

/** Strip fenced code blocks from assistant replies before L0 capture. */
export function stripCodeBlocks(text: string): string {
  return text
    .replace(/```[^\n]*\n[\s\S]*?```/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Gateway limit for /v3/atomic/search `query` (characters). */
export const RECALL_QUERY_MAX_CHARS = 2048;

/**
 * Build the L1 search query from the raw prompt text.
 *
 * Two things must be removed or the search fails outright:
 * - Previously injected recall blobs and workspace context blocks. Echoing a
 *   recall payload back as the query is a feedback loop and drowns the real
 *   question.
 * - Anything past the gateway's 2048-character limit — it rejects the whole
 *   request with "Too big: expected string to have <=2048 characters", so a
 *   long prompt silently returned zero hits.
 */
export function buildRecallQuery(text: string): string {
  let query = sanitizeMemoryText(text || '');
  query = query.replace(/<context\b[\s\S]*?<\/context>/g, '');
  query = query.replace(/<(open_files|terminal|problems|selection|file|folder)\b[\s\S]*?<\/\1>/g, '');
  query = query.replace(/\n{3,}/g, '\n\n').trim();
  if (query.length > RECALL_QUERY_MAX_CHARS) {
    query = query.slice(0, RECALL_QUERY_MAX_CHARS).trim();
  }
  return query;
}

/** Drop empty / slash-command / bootstrap noise from L0 capture. */ export function shouldCaptureL0(
  text: string,
): boolean {
  if (!text || !text.trim()) {
    return false;
  }
  const t = text.trim();
  if (t.startsWith('/')) {
    return false;
  }
  if (t === '(session bootstrap)') {
    return false;
  }
  if (t.startsWith('A new session was started via')) {
    return false;
  }
  if (/^NO_REPLY\s*$/.test(t)) {
    return false;
  }
  return true;
}

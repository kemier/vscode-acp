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
  // Strip the flattened memory recall that the agent echoes back into the
  // user message: codex's ACP server renders an embeddedContext resource as
  //   [@memory](vscode-acp:///memory/<id>)
  //   <context ref="vscode-acp:///memory/<id>">…blob…</context>
  // Capturing that verbatim would re-write the recall blob as L0 → feedback
  // loop (the recalled text keeps reinforcing itself turn after turn).
  cleaned = cleaned.replace(/\[@memory\]\(vscode-acp:\/\/\/memory\/[^)]*\)\s*/gi, '');
  cleaned = cleaned.replace(/<context\s+ref="vscode-acp:\/\/\/memory\/[^"]*"[\s\S]*?<\/context>/gi, '');

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
 * Gateway limit for /v3/conversation/add `content` (characters).
 * `conversationItemSchema` caps each message's content at `z.string().min(1).max(8192)`;
 * a longer message makes the whole batch 400 with
 * "messages.N.content: Too big: expected string to have <=8192 characters".
 * The gateway logs the reason only in the response envelope (not server-side),
 * so an over-long capture silently fails — hence truncating client-side.
 */
export const CAPTURE_CONTENT_MAX_CHARS = 8192;

/**
 * Truncate L0 capture text to the gateway's per-message `content` cap.
 * Mirrors `buildRecallQuery`'s approach for the recall path: the gateway
 * rejects the whole request when any single message exceeds its schema limit,
 * so the client (configurator) must shape the data to fit rather than rely on
 * the gateway to clamp. Keeps the tail so the truncation point is visible.
 */
export function truncateForCapture(text: string): string {
  if (text.length <= CAPTURE_CONTENT_MAX_CHARS) {
    return text;
  }
  return text.slice(0, CAPTURE_CONTENT_MAX_CHARS - 1).trimEnd();
}

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
  query = query.replace(/<(open_files|terminal|problems|selection|file|folder|clipboard)\b[\s\S]*?<\/\1>/g, '');
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
  // Drop summarizer instruction-echo fragments before they pollute memory.
  // Observed on DeepSeek-V4-Flash: the codex empty-reply summarizer once
  // echoed its own instruction as the assistant message ("Note: The summary
  // must be based strictly on the actual tool results shown above…"), and
  // capture wrote it into L0, whose recall then re-injected it into every
  // later turn (feedback loop). These are machine instructions, never real
  // conversation content worth remembering.
  const lower = t.toLowerCase();
  if (
    lower.startsWith('note: the summary') ||
    lower.startsWith('note: summarize') ||
    lower.startsWith('do not fabricate') ||
    lower.startsWith('do not invent') ||
    lower.startsWith('never fabricate') ||
    lower.includes('based strictly on the actual tool results') ||
    lower.includes('report that honestly')
  ) {
    return false;
  }
  return true;
}

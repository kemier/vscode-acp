import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ConversationExportItem } from './conversationExport';

/**
 * Read a Kiro session transcript straight off disk.
 *
 * Why: a session owned by another process (a terminal `kiro-cli chat`) cannot be
 * loaded over ACP — kiro answers session/load with "active in another process
 * (PID n)" — so the chat panel has nothing to export and fork-to-agent had no
 * source at all. Forking only reads, so reading the transcript is legitimate.
 *
 * The transcript is easy to miss because it sits NEXT TO the metadata: the `.json`
 * beside it holds only session_id / cwd / title / session_state, which makes it
 * look as though kiro keeps no local history. The messages are in the sibling
 * `.jsonl`:
 *
 *   ~/.kiro/sessions/cli/<session-id>.jsonl               (kiro-cli sessions)
 *   ~/.kiro/sessions/<hash>/sess_<uuid>/messages.jsonl    (IDE sessions)
 *
 * Each line is {version, kind, data}, with kind one of:
 *   Prompt           — a user turn; data.content[] blocks, text in {kind:'text',data}
 *   AssistantMessage — an assistant turn, same content shape
 *   ToolResults      — tool output, skipped: a fork wants the conversation, not the
 *                     file dumps. One 206-line transcript was 705 KB, nearly all of
 *                     it tool results.
 */

/** A transcript line as kiro writes it. */
interface KiroTranscriptRecord {
  version?: unknown;
  kind?: string;
  data?: {
    message_id?: string;
    content?: Array<{ kind?: string; data?: unknown }>;
  };
}

/** Kiro's data directory, honouring KIRO_HOME like KiroSessionDiscovery does. */
export function resolveKiroHomeDir(): string {
  const fromEnv = process.env.KIRO_HOME;
  if (fromEnv && fromEnv.trim()) {
    return fromEnv.trim();
  }
  return path.join(os.homedir(), '.kiro');
}

/** Plain text of a Prompt / AssistantMessage record. */
function textFromContent(content: Array<{ kind?: string; data?: unknown }> | undefined): string {
  if (!Array.isArray(content)) {
    return '';
  }
  const parts: string[] = [];
  for (const block of content) {
    if (block && block.kind === 'text' && typeof block.data === 'string') {
      parts.push(block.data);
    }
  }
  return parts.join('\n').trim();
}

/**
 * Candidate transcript paths for a session id, cheapest first.
 *
 * Exported for the test: the directory layout is the fragile part here, not the
 * parsing. IDE sessions live under a workspace-hash directory, so the hash has to
 * be discovered rather than derived.
 */
export function kiroTranscriptCandidates(sessionId: string, kiroHome = resolveKiroHomeDir()): string[] {
  const bare = String(sessionId || '')
    .trim()
    .replace(/^sess_/, '');
  if (!bare) {
    return [];
  }
  const sessions = path.join(kiroHome, 'sessions');
  const candidates = [path.join(sessions, 'cli', `${bare}.jsonl`)];
  let hashDirs: string[] = [];
  try {
    hashDirs = fs
      .readdirSync(sessions, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== 'cli')
      .map((e) => e.name);
  } catch {
    hashDirs = [];
  }
  for (const hash of hashDirs) {
    candidates.push(path.join(sessions, hash, `sess_${bare}`, 'messages.jsonl'));
  }
  return candidates;
}

/**
 * Parse transcript lines into the shape the conversation exporter consumes.
 *
 * Exported separately so the parser is testable without touching a real disk.
 */
export function parseKiroTranscript(jsonl: string): ConversationExportItem[] {
  const items: ConversationExportItem[] = [];
  for (const line of String(jsonl || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let record: KiroTranscriptRecord;
    try {
      record = JSON.parse(trimmed) as KiroTranscriptRecord;
    } catch {
      // A half-written final line is normal while the session is live in another
      // process — skip it instead of abandoning the whole transcript.
      continue;
    }
    const kind = record?.kind;
    if (kind !== 'Prompt' && kind !== 'AssistantMessage') {
      continue;
    }
    const text = textFromContent(record?.data?.content);
    if (!text) {
      continue;
    }
    items.push({
      kind: 'message',
      role: kind === 'Prompt' ? 'user' : 'assistant',
      text,
    });
  }
  return items;
}

/**
 * Read a session's transcript, or [] when there is none.
 *
 * Never throws: a fork falling back to this must not fail because a path is
 * missing or unreadable.
 */
export function readKiroTranscript(sessionId: string, kiroHome = resolveKiroHomeDir()): ConversationExportItem[] {
  for (const candidate of kiroTranscriptCandidates(sessionId, kiroHome)) {
    try {
      if (!fs.existsSync(candidate)) {
        continue;
      }
      const items = parseKiroTranscript(fs.readFileSync(candidate, 'utf8'));
      if (items.length > 0) {
        return items;
      }
    } catch {
      // Unreadable candidate — try the next.
    }
  }
  return [];
}

/**
 * Where a replay can start, for a session kiro has compacted or cleared.
 *
 * `session/load` replays the WHOLE append-only rollout: measured on a 9.3 MB
 * transcript (2849 records, `Compaction` at record 1550) the load took 13.1 s —
 * 2.35 s for kiro to open and parse the file, then 1538 frames — and the first
 * replayed `user_message_chunk` was byte-identical to record 0. Half of that is
 * conversation kiro itself already dropped from the model's context, so showing
 * it is misleading as well as slow.
 *
 * Kiro sends no marker for the boundary, so it has to be recovered from disk.
 * `summary` is the `Compaction.summary` kiro never replays (a `Clear` has none).
 * `resumeAfterTexts` are the text blocks of the first Prompt AFTER the boundary:
 * the replay arrives in file order, so the first `user_message_chunk` matching one
 * of them is where the surviving conversation starts.
 */
export interface KiroCompactionBoundary {
  /** Record index of the last Compaction / Clear. */
  recordIndex: number;
  /** 'Compaction' or 'Clear' — a Clear has no summary. */
  kind: string;
  /** The summary kiro folds the dropped turns into, or '' for a Clear. */
  summary: string;
  /** Text blocks of the first Prompt after the boundary, longest first. */
  resumeAfterTexts: string[];
  /** How many Prompt records the boundary drops (for the divider label + logs). */
  droppedPrompts: number;
  /** How many records in total predate the boundary (for logs). */
  droppedRecords: number;
}

/** Parse the boundary out of transcript text. Exported for tests. */
export function parseKiroCompactionBoundary(jsonl: string): KiroCompactionBoundary | null {
  const records: KiroTranscriptRecord[] = [];
  for (const line of String(jsonl || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      records.push(JSON.parse(trimmed) as KiroTranscriptRecord);
    } catch {
      // Half-written final line while the session is live — keep the position so
      // record indices stay meaningful.
      records.push({ kind: '<unparsed>' });
    }
  }
  let boundary = -1;
  for (let i = 0; i < records.length; i++) {
    const kind = records[i]?.kind;
    if (kind === 'Compaction' || kind === 'Clear') {
      boundary = i;
    }
  }
  if (boundary < 0) {
    return null;
  }
  // The first Prompt after the boundary is the anchor. Without one there is
  // nothing to resume at (the compaction is the tail of the file), and dropping
  // the whole replay on a guess is not worth it — leave the session alone.
  let anchor: KiroTranscriptRecord | null = null;
  for (let i = boundary + 1; i < records.length; i++) {
    if (records[i]?.kind === 'Prompt') {
      anchor = records[i];
      break;
    }
  }
  if (!anchor) {
    return null;
  }
  const blocks: string[] = [];
  for (const block of anchor.data?.content || []) {
    if (block && block.kind === 'text' && typeof block.data === 'string' && block.data.trim()) {
      blocks.push(block.data.trim());
    }
  }
  if (blocks.length === 0) {
    return null;
  }
  // Longest first: the injected memory blob and the typed text both arrive as
  // their own chunk, and the longest block is the most distinctive anchor.
  blocks.sort((a, b) => b.length - a.length);
  let droppedPrompts = 0;
  for (let i = 0; i < boundary; i++) {
    if (records[i]?.kind === 'Prompt') {
      droppedPrompts++;
    }
  }
  const data = records[boundary]?.data as { summary?: unknown } | undefined;
  return {
    recordIndex: boundary,
    kind: String(records[boundary]?.kind || ''),
    summary: typeof data?.summary === 'string' ? data.summary : '',
    resumeAfterTexts: blocks,
    droppedPrompts,
    droppedRecords: boundary,
  };
}

/** Read the compaction boundary for a session, or null. Never throws. */
export function readKiroCompactionBoundary(
  sessionId: string,
  kiroHome = resolveKiroHomeDir(),
): KiroCompactionBoundary | null {
  for (const candidate of kiroTranscriptCandidates(sessionId, kiroHome)) {
    try {
      if (!fs.existsSync(candidate)) {
        continue;
      }
      const boundary = parseKiroCompactionBoundary(fs.readFileSync(candidate, 'utf8'));
      if (boundary) {
        return boundary;
      }
    } catch {
      // Unreadable candidate — try the next.
    }
  }
  return null;
}

/**
 * Whether a replayed chunk is the boundary anchor.
 *
 * Compared on a prefix, not equality: the extension prepends its memory recall to
 * the prompt it sends, agents may append their own context, and a chunk can carry
 * either. A short anchor is rejected outright — matching on "ok" would cut the
 * conversation at the wrong turn.
 */
export function isKiroResumeAnchor(boundary: KiroCompactionBoundary | null, chunkText: string): boolean {
  if (!boundary) {
    return false;
  }
  const text = String(chunkText || '').trim();
  if (!text) {
    return false;
  }
  for (const anchor of boundary.resumeAfterTexts) {
    if (anchor.length < 24) {
      continue;
    }
    const probe = anchor.slice(0, 200);
    if (text === anchor || text.indexOf(probe) === 0 || anchor.indexOf(text.slice(0, 200)) === 0) {
      return true;
    }
  }
  return false;
}

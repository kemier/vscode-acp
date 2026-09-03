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
export function readKiroTranscript(
  sessionId: string,
  kiroHome = resolveKiroHomeDir(),
): ConversationExportItem[] {
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

/**
 * Workaround for Cursor ACP omitting tool args on the wire.
 *
 * Cursor emits tool_call with title stubs ("Read File", "grep") and
 * rawInput: {}. Full args live in ~/.cursor/acp-sessions/<sessionId>/store.db
 * (and legacy ~/.cursor/chats/.../store.db). See Cursor forum + cursor-acp-enriched.
 *
 * This module reads that SQLite DB (via `sqlite3` CLI or node:sqlite) and
 * recovers args so the chat UI can show paths / patterns / commands.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface EnrichedCursorToolCall {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  title: string;
  locations?: Array<{ path: string; line?: number }>;
}

export function isCursorAgentName(agentName: string | null | undefined): boolean {
  return !!agentName && /cursor/i.test(agentName);
}

export function isEmptyRawInput(rawInput: unknown): boolean {
  if (rawInput == null) return true;
  if (typeof rawInput !== 'object' || Array.isArray(rawInput)) return false;
  return Object.keys(rawInput as Record<string, unknown>).length === 0;
}

/** Stub titles Cursor ACP sends before (or instead of) real args. */
const CURSOR_STUB_TITLES = new Set([
  '',
  'read file',
  'edit file',
  'write file',
  'delete file',
  'read',
  'write',
  'edit',
  'delete',
  'grep',
  'find',
  'search',
  'shell',
  'bash',
  'terminal',
  'run',
  'list directory',
  'glob',
  'mcp: tool',
]);

export function isCursorStubToolTitle(title: unknown): boolean {
  if (typeof title !== 'string') return true;
  const t = title.trim().toLowerCase();
  if (!t) return true;
  if (CURSOR_STUB_TITLES.has(t)) return true;
  if (/^mcp:\s/i.test(t)) return true;
  return false;
}

export function needsCursorToolEnrichment(update: {
  sessionUpdate?: string;
  toolCallId?: string;
  title?: string;
  rawInput?: unknown;
}): boolean {
  const kind = update?.sessionUpdate;
  if (kind !== 'tool_call' && kind !== 'tool_call_update') return false;
  if (!update.toolCallId) return false;
  return isEmptyRawInput(update.rawInput) && isCursorStubToolTitle(update.title);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Parse args that may be an object or a JSON / Python-repr string. */
export function parseCursorToolArgs(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  const obj = asRecord(raw);
  if (obj) return { ...obj };
  if (typeof raw !== 'string') return {};
  const s = raw.trim();
  if (!s) return {};
  try {
    const parsed = JSON.parse(s);
    const rec = asRecord(parsed);
    return rec ? { ...rec } : {};
  } catch {
    // Python-ish dict repr: {'path': '/x', 'limit': 20}
    try {
      const jsonish = s
        .replace(/'/g, '"')
        .replace(/\bTrue\b/g, 'true')
        .replace(/\bFalse\b/g, 'false')
        .replace(/\bNone\b/g, 'null');
      const parsed = JSON.parse(jsonish);
      const rec = asRecord(parsed);
      return rec ? { ...rec } : {};
    } catch {
      return {};
    }
  }
}

export function extractPathFromArgs(args: Record<string, unknown>): string | undefined {
  for (const key of ['path', 'file_path', 'filePath', 'target_file', 'targetFile', 'directory', 'target_directory']) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/** Path / directory / glob scope for search tools when path is absent. */
export function extractSearchScope(args: Record<string, unknown>): string | undefined {
  const pathArg = extractPathFromArgs(args);
  if (pathArg) return pathArg;
  for (const key of ['glob', 'glob_pattern', 'globPattern']) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/** Kind bucket for ordinal batch-matching (grep vs glob must not share a queue). */
export function cursorToolMatchKind(
  toolName: string | undefined,
  title: string | undefined,
  toolKind?: string | undefined,
): 'read' | 'grep' | 'glob' | 'edit' | 'write' | 'shell' | 'other' {
  const n = (toolName || '').trim().toLowerCase();
  const t = (title || '').trim().toLowerCase();
  const k = (toolKind || '').trim().toLowerCase();
  if (n === 'read' || n === 'read_file' || n === 'readfile' || t === 'read file' || t.startsWith('read ') || k === 'read') {
    return 'read';
  }
  if (
    n === 'glob' ||
    n === 'find' ||
    n === 'listdir' ||
    n === 'list_dir' ||
    t === 'find' ||
    t === 'glob' ||
    t.startsWith('find ')
  ) {
    return 'glob';
  }
  if (
    n === 'grep' ||
    n === 'rg' ||
    n === 'ripgrep' ||
    t === 'grep' ||
    t === 'search' ||
    t.startsWith('grep ') ||
    k === 'fetch'
  ) {
    return 'grep';
  }
  if (
    n === 'streplace' ||
    n === 'strreplace' ||
    n === 'str_replace' ||
    n === 'edit' ||
    n === 'applypatch' ||
    t === 'edit file' ||
    t.startsWith('edit ') ||
    t.startsWith('strreplace ') ||
    k === 'edit'
  ) {
    return 'edit';
  }
  if (n === 'write' || n === 'write_file' || t === 'write file' || t.startsWith('write ')) return 'write';
  if (n === 'shell' || n === 'bash' || n === 'run' || k === 'execute') return 'shell';
  if (k === 'search') {
    // ACP toolKind alone — disambiguate from enriched title prefix when possible.
    if (t.startsWith('find ')) return 'glob';
    if (t.startsWith('grep ')) return 'grep';
    return 'grep';
  }
  return 'other';
}

export function formatCursorEnrichedTitle(
  toolName: string,
  args: Record<string, unknown>,
  fallbackTitle?: string,
): string {
  const pathArg = extractPathFromArgs(args);
  const pattern =
    (typeof args.pattern === 'string' && args.pattern) ||
    (typeof args.query === 'string' && args.query) ||
    (typeof args.regex === 'string' && args.regex) ||
    undefined;
  const command = args.command;
  const cmdStr = Array.isArray(command)
    ? command.map(String).join(' ')
    : typeof command === 'string'
      ? command
      : undefined;

  const name = (toolName || '').trim();
  const lower = name.toLowerCase();

  if (lower === 'read' || lower === 'read_file' || lower === 'readfile') {
    return pathArg ? `Read ${pathArg}` : fallbackTitle || 'Read File';
  }
  if (lower === 'write' || lower === 'write_file' || lower === 'writefile') {
    return pathArg ? `Write ${pathArg}` : fallbackTitle || 'Write File';
  }
  if (lower === 'streplace' || lower === 'strreplace' || lower === 'str_replace' || lower === 'edit' || lower === 'applypatch') {
    return pathArg ? `Edit ${pathArg}` : fallbackTitle || 'Edit File';
  }
  if (lower === 'delete' || lower === 'delete_file') {
    return pathArg ? `Delete ${pathArg}` : fallbackTitle || 'Delete File';
  }
  if (lower === 'grep' || lower === 'rg' || lower === 'search') {
    const scope = extractSearchScope(args);
    if (pattern && scope) return `grep ${JSON.stringify(pattern)} ${scope}`;
    if (pattern) return `grep ${JSON.stringify(pattern)}`;
    if (scope) return `grep ${scope}`;
    return fallbackTitle || 'grep';
  }
  if (lower === 'glob' || lower === 'find' || lower === 'listdir' || lower === 'list_dir') {
    const globPat =
      pattern ||
      (typeof args.glob_pattern === 'string' && args.glob_pattern) ||
      (typeof args.globPattern === 'string' && args.globPattern) ||
      undefined;
    if (globPat && pathArg) return `Find ${JSON.stringify(globPat)} in ${pathArg}`;
    if (globPat) return `Find ${JSON.stringify(globPat)}`;
    if (pathArg) return `Find ${pathArg}`;
    return fallbackTitle || 'Find';
  }
  if (lower === 'shell' || lower === 'bash' || lower === 'run_terminal_cmd' || lower === 'run') {
    if (cmdStr) {
      const oneLine = cmdStr.replace(/\s+/g, ' ').trim();
      return oneLine.length > 120 ? oneLine.slice(0, 117) + '...' : oneLine;
    }
    return fallbackTitle || 'Shell';
  }

  if (pathArg && pattern) return `${name || 'Tool'} ${JSON.stringify(pattern)} ${pathArg}`;
  if (pathArg) return `${name || fallbackTitle || 'Tool'} ${pathArg}`;
  if (pattern) return `${name || fallbackTitle || 'Tool'} ${JSON.stringify(pattern)}`;
  if (cmdStr) return cmdStr.length > 120 ? cmdStr.slice(0, 117) + '...' : cmdStr;
  return fallbackTitle || name || 'Tool Call';
}

export function locationsFromCursorArgs(args: Record<string, unknown>): Array<{ path: string; line?: number }> | undefined {
  const filePath = extractPathFromArgs(args);
  if (!filePath) return undefined;
  const lineRaw = args.line ?? args.lineNumber ?? args.offset ?? args.start_line;
  const line =
    typeof lineRaw === 'number' && Number.isFinite(lineRaw)
      ? lineRaw
      : typeof lineRaw === 'string' && /^\d+$/.test(lineRaw)
        ? Number(lineRaw)
        : undefined;
  return line != null ? [{ path: filePath, line }] : [{ path: filePath }];
}

interface ToolCallPart {
  type?: string;
  toolCallId?: string;
  toolName?: string;
  name?: string;
  args?: unknown;
  input?: unknown;
  arguments?: unknown;
}

function collectToolCallsFromBlob(obj: unknown, into: Map<string, EnrichedCursorToolCall>): void {
  if (!obj || typeof obj !== 'object') return;
  const rec = obj as Record<string, unknown>;
  const content = rec.content;
  if (!Array.isArray(content)) return;

  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const p = part as ToolCallPart;
    if (p.type !== 'tool-call' && p.type !== 'tool_call') continue;
    const toolCallId = typeof p.toolCallId === 'string' ? p.toolCallId : undefined;
    if (!toolCallId) continue;
    const toolName = String(p.toolName || p.name || '').trim();
    const args = parseCursorToolArgs(p.args ?? p.input ?? p.arguments);
    into.set(toolCallId, {
      toolCallId,
      toolName,
      args,
      title: formatCursorEnrichedTitle(toolName, args),
      locations: locationsFromCursorArgs(args),
    });
  }
}

/** Pure: scan JSON blob texts and return tool calls keyed by toolCallId. */
export function indexToolCallsFromBlobTexts(texts: string[]): Map<string, EnrichedCursorToolCall> {
  const map = new Map<string, EnrichedCursorToolCall>();
  for (const text of texts) {
    if (!text || text[0] !== '{' && text[0] !== '[') continue;
    try {
      const obj = JSON.parse(text);
      collectToolCallsFromBlob(obj, map);
    } catch {
      // ignore non-JSON / partial blobs
    }
  }
  return map;
}

/** True when store.db has real content (ACP often creates a 0-byte stub). */
export function isUsableCursorStore(dbPath: string | null | undefined): boolean {
  if (!dbPath) return false;
  try {
    return fs.statSync(dbPath).size > 256;
  } catch {
    return false;
  }
}

export function findCursorSessionStorePath(
  sessionId: string,
  cursorDir: string = path.join(os.homedir(), '.cursor'),
): string | null {
  if (!sessionId) return null;

  const flat = path.join(cursorDir, 'acp-sessions', sessionId, 'store.db');
  if (isUsableCursorStore(flat)) return flat;
  // Prefer usable DB; keep empty stub path only as last resort for callers
  // that need to know the canonical location exists.
  const flatExists = fs.existsSync(flat);

  const chatsRoot = path.join(cursorDir, 'chats');
  if (fs.existsSync(chatsRoot)) {
    try {
      for (const hash of fs.readdirSync(chatsRoot)) {
        const candidate = path.join(chatsRoot, hash, sessionId, 'store.db');
        if (isUsableCursorStore(candidate)) return candidate;
      }
    } catch {
      // ignore
    }
  }
  return flatExists ? flat : null;
}

/**
 * Recent non-empty Cursor session stores, newest first.
 * ACP session UUID often differs from the agent chat UUID that actually
 * receives tool-call blobs — callers search these as a fallback.
 */
/** Skip multi-hundred-MB stores on fallback LIKE scans (each miss costs >1s). */
const MAX_FALLBACK_STORE_BYTES = 120 * 1024 * 1024;

export function listRecentCursorStorePaths(
  cursorDir: string = path.join(os.homedir(), '.cursor'),
  limit: number = 12,
  maxBytes: number = MAX_FALLBACK_STORE_BYTES,
): string[] {
  const sessionsRoot = path.join(cursorDir, 'acp-sessions');
  if (!fs.existsSync(sessionsRoot)) return [];
  const scored: Array<{ p: string; mtime: number }> = [];
  try {
    for (const name of fs.readdirSync(sessionsRoot)) {
      const dbPath = path.join(sessionsRoot, name, 'store.db');
      try {
        const st = fs.statSync(dbPath);
        if (st.size > 256 && st.size <= maxBytes) {
          scored.push({ p: dbPath, mtime: st.mtimeMs });
        }
      } catch {
        // skip
      }
    }
  } catch {
    return [];
  }
  scored.sort((a, b) => b.mtime - a.mtime);
  return scored.slice(0, limit).map((s) => s.p);
}

function blobDataToText(d: unknown): string {
  if (typeof d === 'string') return d;
  if (Buffer.isBuffer(d)) return d.toString('utf8');
  if (d instanceof Uint8Array) return Buffer.from(d).toString('utf8');
  return '';
}

async function readBlobTextsViaNodeSqlite(dbPath: string): Promise<string[]> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => {
      prepare: (sql: string) => { all: (...params: unknown[]) => Array<{ data: unknown }> };
      close: () => void;
    };
  };
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare('SELECT data FROM blobs ORDER BY rowid').all();
    return rows.map((r) => blobDataToText(r.data)).filter((t) => t.length > 0 && (t[0] === '{' || t[0] === '['));
  } finally {
    db.close();
  }
}

async function readBlobTextsViaSqliteCli(dbPath: string): Promise<string[]> {
  // Full-table CAST…AS TEXT via `sqlite3 -json` hangs / emits invalid UTF-8 on
  // Cursor stores (multi-MB blobs + mixed binary). Prefer a Python reader that
  // decodes with replacement and skips non-JSON rows. Fall back to a size-capped
  // sqlite3 query only for small JSON blobs.
  try {
    const script = [
      'import sqlite3,json,sys',
      'db=sys.argv[1]',
      'conn=sqlite3.connect(db)',
      'out=[]',
      'for (data,) in conn.execute("SELECT data FROM blobs ORDER BY rowid"):',
      '  if isinstance(data, memoryview): data=bytes(data)',
      '  if isinstance(data, bytes):',
      '    if not data or data[0] not in (123,91): continue',
      '    # Skip multi-MB conversation dumps — tool-calls live in small msgs.',
      '    if len(data) > 512*1024: continue',
      '    text=data.decode("utf-8","replace")',
      '  else:',
      '    text=str(data or "")',
      '    if not text or text[0] not in "{[": continue',
      '    if len(text) > 512*1024: continue',
      '  out.append(text)',
      'print(json.dumps(out))',
    ].join('\n');
    const { stdout } = await execFileAsync('python3', ['-c', script, dbPath], {
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8',
    });
    if (!stdout.trim()) return [];
    const rows = JSON.parse(stdout) as string[];
    return Array.isArray(rows) ? rows.filter((t) => typeof t === 'string' && t.length > 0) : [];
  } catch {
    // Last resort: only small JSON-looking rows via sqlite3 CLI.
    try {
      const { stdout } = await execFileAsync(
        'sqlite3',
        [
          '-json',
          dbPath,
          `SELECT CAST(data AS TEXT) AS data FROM blobs WHERE length(data) < 200000 AND (substr(data,1,1)='{' OR substr(data,1,1)='[')`,
        ],
        { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      );
      if (!stdout.trim()) return [];
      const rows = JSON.parse(stdout) as Array<{ data?: string }>;
      return rows.map((r) => (typeof r.data === 'string' ? r.data : '')).filter(Boolean);
    } catch {
      return [];
    }
  }
}

async function readBlobTexts(dbPath: string): Promise<string[]> {
  try {
    return await readBlobTextsViaNodeSqlite(dbPath);
  } catch {
    return readBlobTextsViaSqliteCli(dbPath);
  }
}

/**
 * Fast path: pull only blobs that mention this toolCallId prefix, then index
 * tool-call parts. Avoids scanning multi-MB conversation dumps on every poll.
 */
export async function loadEnrichedToolCallsByPrefix(
  dbPath: string,
  toolCallId: string,
): Promise<Map<string, EnrichedCursorToolCall>> {
  const prefix = toolCallIdPrefix(toolCallId);
  if (!prefix || !dbPath) return new Map();
  const texts = await readBlobsMatchingSubstring(dbPath, prefix);
  return indexToolCallsFromBlobTexts(texts);
}

async function readBlobsMatchingSubstring(dbPath: string, needle: string): Promise<string[]> {
  if (!needle) return [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => {
        prepare: (sql: string) => { all: (...params: unknown[]) => Array<{ data: unknown }> };
        close: () => void;
      };
    };
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db
        .prepare(
          `SELECT data FROM blobs WHERE data LIKE ? AND length(data) < 1048576 LIMIT 40`,
        )
        .all('%' + needle + '%');
      return rows
        .map((r) => blobDataToText(r.data))
        .filter((t) => t.length > 0 && (t[0] === '{' || t[0] === '['));
    } finally {
      db.close();
    }
  } catch {
    // Python fallback — UTF-8 safe, size-capped.
    try {
      const script = [
        'import sqlite3,json,sys',
        'db,needle=sys.argv[1],sys.argv[2]',
        'conn=sqlite3.connect(db)',
        'out=[]',
        'for (data,) in conn.execute("SELECT data FROM blobs WHERE data LIKE ? LIMIT 40", ("%"+needle+"%",)):',
        '  if isinstance(data, memoryview): data=bytes(data)',
        '  if isinstance(data, bytes):',
        '    if not data or data[0] not in (123,91): continue',
        '    if len(data) > 1024*1024: continue',
        '    text=data.decode("utf-8","replace")',
        '  else:',
        '    text=str(data or "")',
        '    if not text or text[0] not in "{[": continue',
        '    if len(text) > 1024*1024: continue',
        '  out.append(text)',
        'print(json.dumps(out))',
      ].join('\n');
      const { stdout } = await execFileAsync('python3', ['-c', script, dbPath, needle], {
        maxBuffer: 32 * 1024 * 1024,
        encoding: 'utf8',
      });
      if (!stdout.trim()) return [];
      const rows = JSON.parse(stdout) as string[];
      return Array.isArray(rows) ? rows.filter((t) => typeof t === 'string' && t.length > 0) : [];
    } catch {
      return [];
    }
  }
}

/** Wire IDs are `call-…\nfc_…` — prefix before the newline uniquely IDs the call. */
export function toolCallIdPrefix(toolCallId: string): string {
  if (!toolCallId) return '';
  return toolCallId.split(/\n|\\n/)[0] || toolCallId;
}

function isUsableEnrichment(hit: EnrichedCursorToolCall | null | undefined): hit is EnrichedCursorToolCall {
  return !!hit && (Object.keys(hit.args).length > 0 || !!hit.toolName);
}

/** Exported for tests — resolve a wire toolCallId against an indexed map. */
export function lookupEnriched(
  index: Map<string, EnrichedCursorToolCall> | null | undefined,
  toolCallId: string,
): EnrichedCursorToolCall | null {
  if (!index || !toolCallId) return null;
  const direct = index.get(toolCallId);
  if (isUsableEnrichment(direct)) return direct;
  // Wire IDs use a real newline before fc_*; some blobs keep the escaped form.
  if (toolCallId.includes('\n')) {
    const alt = toolCallId.replace(/\n/g, '\\n');
    const hit = index.get(alt);
    if (isUsableEnrichment(hit)) return hit;
  } else if (toolCallId.includes('\\n')) {
    const alt = toolCallId.replace(/\\n/g, '\n');
    const hit = index.get(alt);
    if (isUsableEnrichment(hit)) return hit;
  }
  // Prefer call-… prefix (unique per tool). Do NOT fall through to a shared
  // fc_* batch id — parallel Read/Grep/Edit share the same fc_ UUID stem and
  // only differ by call-…-N / fc_…_N suffix.
  const prefix = toolCallIdPrefix(toolCallId);
  if (prefix) {
    for (const [key, hit] of index) {
      if (!isUsableEnrichment(hit)) continue;
      if (key === prefix || key.startsWith(prefix + '\n') || key.startsWith(prefix + '\\n')) {
        return hit;
      }
    }
  }
  // Last resort: exact fc_* token (including _N suffix) must be unique.
  const fcMatch = toolCallId.match(/fc_[A-Za-z0-9_-]+/);
  const fc = fcMatch ? fcMatch[0] : '';
  if (fc) {
    const hits: EnrichedCursorToolCall[] = [];
    for (const [key, hit] of index) {
      if (!isUsableEnrichment(hit)) continue;
      if (key.includes(fc)) hits.push(hit);
    }
    if (hits.length === 1) return hits[0];
  }
  return isUsableEnrichment(direct) ? direct : null;
}

/**
 * Locate a non-empty store.db that contains this toolCallId.
 * Needed because Cursor ACP session UUID ≠ agent chat UUID that owns blobs.
 */
export async function findStoreContainingToolCallId(
  toolCallId: string,
  cursorDir: string = path.join(os.homedir(), '.cursor'),
  excludePath?: string | null,
): Promise<string | null> {
  if (!toolCallId) return null;
  // Wire IDs are "call-…\nfc_…"; JSON blobs escape the newline as "\\n".
  // Searching the call- UUID prefix avoids newline mismatch and is enough
  // to identify the owning store.
  const prefix = toolCallIdPrefix(toolCallId);
  for (const dbPath of listRecentCursorStorePaths(cursorDir, 16)) {
    if (excludePath && path.resolve(dbPath) === path.resolve(excludePath)) continue;
    try {
      if (await storeBlobContainsSubstring(dbPath, prefix)) return dbPath;
    } catch {
      // try next store
    }
  }
  return null;
}

async function storeBlobContainsSubstring(dbPath: string, needle: string): Promise<boolean> {
  if (!needle) return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => {
        prepare: (sql: string) => {
          get: (...params: unknown[]) => unknown;
        };
        close: () => void;
      };
    };
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db
        .prepare('SELECT 1 AS ok FROM blobs WHERE data LIKE ? LIMIT 1')
        .get('%' + needle + '%');
      return !!row;
    } finally {
      db.close();
    }
  } catch {
    const texts = await readBlobTexts(dbPath);
    return texts.some((t) => t.includes(needle));
  }
}

export class CursorSessionToolEnricher {
  private dbPath: string | null | undefined;
  private index: Map<string, EnrichedCursorToolCall> | null = null;
  private lastScanMs = 0;
  private dbMtimeMs = 0;
  private searchedFallback = false;
  private lastFallbackSearchMs = 0;

  constructor(
    private readonly sessionId: string,
    private readonly cursorDir: string = path.join(os.homedir(), '.cursor'),
  ) {}

  private resolvePrimaryDbPath(): string | null {
    return findCursorSessionStorePath(this.sessionId, this.cursorDir);
  }

  /** Drop cached path/index (e.g. after session switch). */
  invalidate(): void {
    this.dbPath = undefined;
    this.index = null;
    this.lastScanMs = 0;
    this.dbMtimeMs = 0;
    this.searchedFallback = false;
    this.lastFallbackSearchMs = 0;
  }

  private async ensureDbPath(toolCallId: string): Promise<string | null> {
    const primary = this.resolvePrimaryDbPath();

    // Prefer this session's store whenever it has real content. Live tool
    // blobs appear here a few hundred ms after the ACP tool_call — keep
    // polling THIS file instead of LIKE-scanning every other multi-100MB
    // store on each miss (that burned the enrich timeout for Read/Grep).
    if (primary && isUsableCursorStore(primary)) {
      this.dbPath = primary;
      return primary;
    }

    if (this.dbPath && isUsableCursorStore(this.dbPath)) {
      try {
        if (await storeBlobContainsSubstring(this.dbPath, toolCallIdPrefix(toolCallId))) {
          return this.dbPath;
        }
      } catch {
        // fall through
      }
    }

    // Empty/missing primary — search recent stores, but at most once / 1.5s.
    const now = Date.now();
    if (this.searchedFallback && now - this.lastFallbackSearchMs < 1500) {
      return this.dbPath && isUsableCursorStore(this.dbPath) ? this.dbPath : null;
    }
    this.lastFallbackSearchMs = now;
    this.searchedFallback = true;

    const found = await findStoreContainingToolCallId(toolCallId, this.cursorDir, primary);
    if (found) {
      this.dbPath = found;
      return found;
    }

    this.dbPath = primary;
    return this.dbPath && isUsableCursorStore(this.dbPath) ? this.dbPath : null;
  }

  /**
   * Load every tool-call currently indexed in this session's store.
   * Used after session/load so stub "Read File" / "grep" titles get paths
   * even when wire IDs are synthetic replay-*.
   */
  async listEnrichedTools(): Promise<EnrichedCursorToolCall[]> {
    const primary = this.resolvePrimaryDbPath();
    const dbPath =
      (primary && isUsableCursorStore(primary) ? primary : null) ||
      (this.dbPath && isUsableCursorStore(this.dbPath) ? this.dbPath : null) ||
      (await this.ensureDbPath('call-'));
    if (!dbPath || !isUsableCursorStore(dbPath)) return [];
    try {
      const mtime = fs.statSync(dbPath).mtimeMs;
      if (this.index && this.dbPath === dbPath && mtime === this.dbMtimeMs && this.index.size > 0) {
        this.lastScanMs = Date.now();
        return Array.from(this.index.values());
      }
      const texts = await readBlobTexts(dbPath);
      const map = indexToolCallsFromBlobTexts(texts);
      this.index = map;
      this.dbPath = dbPath;
      this.lastScanMs = Date.now();
      this.dbMtimeMs = mtime;
      return Array.from(map.values());
    } catch {
      return [];
    }
  }

  private async refreshIndex(toolCallId: string): Promise<Map<string, EnrichedCursorToolCall>> {
    const dbPath = await this.ensureDbPath(toolCallId);
    if (!dbPath) {
      this.index = new Map();
      return this.index;
    }
    try {
      const mtime = fs.statSync(dbPath).mtimeMs;
      // Targeted prefix query first — cheap, UTF-8 safe, finds the tool even
      // when a full-table scan is too heavy for the sqlite3 CLI fallback.
      const targeted = await loadEnrichedToolCallsByPrefix(dbPath, toolCallId);
      const targetedHit = lookupEnriched(targeted, toolCallId);
      if (targetedHit) {
        if (!this.index) this.index = new Map();
        for (const [k, v] of targeted) this.index.set(k, v);
        this.dbMtimeMs = mtime;
        this.lastScanMs = Date.now();
        return this.index;
      }

      if (this.index && mtime === this.dbMtimeMs) {
        this.lastScanMs = Date.now();
        return this.index;
      }
      const texts = await readBlobTexts(dbPath);
      this.index = indexToolCallsFromBlobTexts(texts);
      // Merge any targeted rows we already saw (full scan may skip huge blobs).
      for (const [k, v] of targeted) this.index.set(k, v);
      this.dbMtimeMs = mtime;
      this.lastScanMs = Date.now();
      return this.index;
    } catch (e: any) {
      void e;
      this.index = this.index ?? new Map();
      return this.index;
    }
  }

  /**
   * Look up tool args by toolCallId. Polls store.db until found or timeout.
   */
  async enrich(
    toolCallId: string,
    options?: { timeoutMs?: number },
  ): Promise<EnrichedCursorToolCall | null> {
    // Cursor often writes the tool blob 1–3s after the ACP stub tool_call.
    // Keep polling the session store (not every other store) long enough.
    const timeoutMs = options?.timeoutMs ?? 12000;
    const deadline = Date.now() + timeoutMs;
    let delay = 0;

    while (Date.now() <= deadline) {
      // Cheap prefix query every iteration — later tools in a turn often land
      // after the index mtime tick; avoid blocking on a full blob scan.
      const dbPath = await this.ensureDbPath(toolCallId);
      if (dbPath) {
        const targeted = await loadEnrichedToolCallsByPrefix(dbPath, toolCallId);
        const prefixHit = lookupEnriched(targeted, toolCallId);
        if (prefixHit) {
          if (!this.index) this.index = new Map();
          for (const [k, v] of targeted) this.index.set(k, v);
          this.lastScanMs = Date.now();
          return prefixHit;
        }
      }
      // Full re-scan at most every ~40ms when prefix still misses.
      if (!this.index || Date.now() - this.lastScanMs >= 40) {
        await this.refreshIndex(toolCallId);
      }
      const hit = lookupEnriched(this.index, toolCallId);
      if (hit) return hit;
      if (delay > 0 && Date.now() + delay > deadline) break;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      delay = delay === 0 ? 30 : Math.min(delay * 2, 200);
    }

    await this.refreshIndex(toolCallId);
    return lookupEnriched(this.index, toolCallId);
  }
}

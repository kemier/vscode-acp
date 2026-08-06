import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { log } from '../utils/Logger';

/**
 * Thresholds for persisting large terminal output to a file instead of
 * inlining it verbatim into the prompt.
 *
 * Terminal output (e.g. a big build log or `git log`) can run to tens or
 * hundreds of thousands of characters. Inlining all of it bloats the model's
 * context window and, for thinking models like GLM-5.2, dramatically slows
 * prefill — sometimes to the point of a per-call timeout that aborts the turn
 * (see the premature-end_turn incident). Instead, once output exceeds
 * {@link INLINE_MAX_CHARS}, we keep a head+tail preview inline and persist the
 * full output to a file the agent can `read_file` on demand.
 */
export const INLINE_MAX_CHARS = 8_000;
/** How many chars of head/tail to keep in the inline preview. */
export const PREVIEW_HEAD_CHARS = 3_000;
export const PREVIEW_TAIL_CHARS = 3_000;

/**
 * Persisted-file lifecycle. Files accumulate one per oversize `@terminal`
 * attachment; without reaping they'd grow without bound across sessions.
 * Reaping runs on every {@link persist} and once on activation.
 */
const MAX_PERSISTED_FILES = 50;
const MAX_PERSISTED_AGE_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Result of deciding whether to persist terminal output.
 * - `kind: 'inline'` — output is small enough to inline verbatim.
 * - `kind: 'persisted'` — full output saved to `filePath`; `text` is a
 *   head+tail preview + a pointer telling the agent to read the file.
 */
export type TerminalPersistResult =
  { kind: 'inline'; text: string } | { kind: 'persisted'; text: string; filePath: string };

/**
 * Pure truncation + pointer formatting (no I/O). Exported so it can be unit
 * tested without a filesystem.
 */
export function formatTruncatedPreview(
  output: string,
  filePath: string,
  headChars = PREVIEW_HEAD_CHARS,
  tailChars = PREVIEW_TAIL_CHARS,
): string {
  const totalLines = output.split('\n').length;
  const head = output.slice(0, headChars);
  const tail = output.slice(Math.max(output.length - tailChars, 0));
  const omittedChars = output.length - head.length - tail.length;
  const fileUri = `file://${filePath}`;
  return (
    `[terminal output — ${output.length} chars, ${totalLines} lines; truncated below]\n` +
    `--- head ---\n${head}\n` +
    `--- ... ${omittedChars} chars omitted ... ---\n` +
    `--- tail ---\n${tail}\n` +
    `--- end ---\n` +
    `Full output saved to: ${fileUri}\n` +
    `Use the read_file / read_text_file tool with that path to view the complete content.`
  );
}

/** Decide whether output is small enough to inline. Pure. */
export function shouldPersist(output: string, maxInline = INLINE_MAX_CHARS): boolean {
  return output.length > maxInline;
}

/**
 * Owns the directory where oversize terminal output is persisted, and reaps
 * stale files so they don't accumulate. Created once in `activate()` with the
 * extension's global-storage path (writable on vscode-server / SSH) and wired
 * into {@link ChatWebviewProvider} → `buildTerminalBlock`.
 */
export class TerminalOutputStore {
  private readonly dir: string;

  constructor(globalStorageUriPath: string) {
    // globalStorageUriPath is the extension's persistent per-machine dir
    // (e.g. ~/.vscode-server/data/User/globalStorage/<publisher>.<name>).
    // Fall back to os.tmpdir() if it is somehow empty.
    this.dir = path.join(globalStorageUriPath || os.tmpdir(), 'terminal-output');
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch (err) {
      log(`[TerminalOutputStore] mkdir failed (${err}); falling back to tmpdir`);
      this.dir = path.join(os.tmpdir(), 'acp-terminal-output');
      try {
        fs.mkdirSync(this.dir, { recursive: true });
      } catch {
        /* best-effort; persist() will report failure */
      }
    }
  }

  /**
   * If `output` is small, return it inline. Otherwise persist the full output
   * to a file and return a truncated preview + a read-file pointer. Never
   * throws — on any I/O failure it falls back to inlining the original output
   * (so a storage glitch can't break `@terminal` entirely).
   */
  persist(output: string): TerminalPersistResult {
    if (!shouldPersist(output)) {
      return { kind: 'inline', text: output };
    }
    // Reap opportunistically on each persist — bounded, cheap, and keeps the
    // dir from growing without a separate timer.
    this.reapStale();
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filePath = path.join(this.dir, `terminal-${stamp}-${process.pid}.txt`);
      fs.writeFileSync(filePath, output, 'utf8');
      log(`[TerminalOutputStore] persisted ${output.length} chars → ${filePath}`);
      return { kind: 'persisted', text: formatTruncatedPreview(output, filePath), filePath };
    } catch (err) {
      log(`[TerminalOutputStore] persist failed (${err}); inlining full output`);
      return { kind: 'inline', text: output };
    }
  }

  /**
   * Delete persisted files that are too old or exceed the count cap. Keeps the
   * newest {@link MAX_PERSISTED_FILES} files and anything younger than
   * {@link MAX_PERSISTED_AGE_MS}; removes the rest. Safe to call on activation
   * and on each persist.
   */
  reapStale(): void {
    let entries: { name: string; mtime: number }[];
    try {
      entries = fs
        .readdirSync(this.dir)
        .map((name) => {
          try {
            return { name, mtime: fs.statSync(path.join(this.dir, name)).mtimeMs };
          } catch {
            return { name, mtime: 0 };
          }
        })
        .filter((e) => e.mtime > 0);
    } catch {
      return; // dir not readable / doesn't exist
    }
    const now = Date.now();
    const stale = entries.filter((e) => now - e.mtime > MAX_PERSISTED_AGE_MS);
    // Beyond age, also enforce a count cap: keep the newest N.
    const kept = entries
      .filter((e) => now - e.mtime <= MAX_PERSISTED_AGE_MS)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(MAX_PERSISTED_FILES);
    for (const e of [...stale, ...kept]) {
      try {
        fs.unlinkSync(path.join(this.dir, e.name));
        log(`[TerminalOutputStore] reaped stale file: ${e.name}`);
      } catch {
        /* ignore — best-effort */
      }
    }
  }
}

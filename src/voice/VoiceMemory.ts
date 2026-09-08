import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Voice Memory — a text-artifact correction layer for dictation, inspired by
 * NVIDIA's "Voice Memory for Agentic Speech Recognition" (arXiv:2607.26410).
 *
 * The paper's core finding shapes this file: in the low-error regime the
 * corrector's operative skill is RESTRAINT — most edits a naive LLM corrector
 * makes are harmful (it "fixes" tokens that were already correct). So:
 *
 *  - Phase 1 is a deterministic replacement dictionary (zero over-correction
 *    risk) applied before anything else.
 *  - Phase 2's LLM corrector reads a human-readable memory.md whose rules are
 *    mostly suppressive, and abstains by default.
 *  - Phase 3 learns from the user's own edits of inserted transcripts
 *    (feedback JSONL) through a human-gated review command — no automatic
 * weight or prompt mutation.
 */

/** One recorded dictation outcome, appended to voice-feedback.jsonl. */
export interface VoiceFeedbackEntry {
  ts: number;
  sessionId: string | null;
  /** Raw STT hypothesis, before dictionary/corrector. */
  stt: string;
  /** What was inserted into the composer (after dictionary + corrector). */
  inserted: string;
  /** What the user actually sent (only when kind === 'edited'). */
  final?: string;
  /**
   * 'accept' = sent verbatim (rule: don't touch); 'edited' = user fixed it
   * (learning signal); 'replaced' = user wholesale rewrote the transcript —
   * NOT a correction signal, recorded only as a usefulness metric. Mining
   * rules from replacements produced poison rules like 为什么→why.
   */
  kind: 'accept' | 'edited' | 'replaced';
}

/**
 * Normalized character-level similarity in [0,1] (1 - levenshtein/maxLen).
 * Used to tell "user corrected a few tokens" (learning signal) apart from
 * "user deleted the dictation and typed a different message" (noise).
 */
export function textSimilarity(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  if (x.length === 0 || y.length === 0) {
    return x.length === y.length ? 1 : 0;
  }
  // Levenshtein DP, one row.
  let prev = new Array<number>(y.length + 1);
  for (let j = 0; j <= y.length; j++) {
    prev[j] = j;
  }
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[y.length] / Math.max(x.length, y.length);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Apply the user's deterministic correction dictionary.
 * ASCII keys that start/end with a word char get word-boundary matching so
 * "SAP" → "ACP" doesn't mangle "ASAP"; CJK and mixed keys use plain replace.
 * Longest-key-first so overlapping entries resolve deterministically.
 */
export function applyCorrections(text: string, corrections: Record<string, string>): string {
  let out = text;
  const keys = Object.keys(corrections)
    .filter((k) => k.length > 0)
    .sort((a, b) => b.length - a.length);
  for (const from of keys) {
    const to = corrections[from];
    if (/^[A-Za-z0-9]([A-Za-z0-9 .+#'_-]*[A-Za-z0-9.+#])?$/.test(from)) {
      out = out.replace(new RegExp(`\\b${escapeRe(from)}\\b`, 'g'), to);
    } else {
      out = out.split(from).join(to);
    }
  }
  return out;
}

/** Seed memory written on first use — restraint-first, per the paper. */
export const DEFAULT_MEMORY = `# Voice Memory — vscode-acp dictation corrector

Default action: ABSTAIN. Only change a token when a rule below clearly applies.
When in doubt, output the input unchanged.

## Hard rules (always apply)
- Chinese output must be Simplified Chinese (简体中文) — convert any Traditional characters (e.g. 記憶→记忆, 轉寫→转写).
- Keep code, shell commands, file paths, URLs, and identifiers verbatim.
- Never normalize numbers, dates, casing, or spelling conventions on your own.
- Never translate; preserve the English/中文 mix exactly as dictated.

## Domain terms for this user
- "ACP" = Agent Client Protocol — fix misrecognitions like "SAP" / "ATP" when the topic is the protocol.
- Project names: vscode-acp, codex-acp.
- Tech terms: vLLM, KV cache, Transformer, Whisper, FunASR, Qwen, SoX.
- Common misrecognitions in ASR context: 机翼→记忆, 转动→转写.
`;

/**
 * Owns the on-disk artifacts:
 *  - voice-memory.md              (the auditable rule file the corrector reads)
 *  - voice-feedback.<host>.jsonl  (dictation outcomes used by the review command)
 *
 * Feedback files are PER-HOST so they can sync via Syncthing: each machine only
 * appends to its own file, which makes the append-only pattern conflict-free
 * under bidirectional sync. readFeedback() merges every voice-feedback*.jsonl
 * in the directory, so a review on any machine sees all machines' feedback;
 * clearFeedback() deletes them all (deletions propagate through sync).
 */
export class VoiceMemoryStore {
  readonly memoryPath: string;
  /** This host's own append target: voice-feedback.<hostId>.jsonl */
  readonly feedbackPath: string;
  readonly hostId: string;
  private migrated: Promise<void> | null = null;

  constructor(memoryPathSetting?: string) {
    const dir = path.join(os.homedir(), '.vscode-acp');
    this.memoryPath =
      memoryPathSetting && memoryPathSetting.trim() ? memoryPathSetting.trim() : path.join(dir, 'voice-memory.md');
    this.hostId = VoiceMemoryStore.machineId();
    this.feedbackPath = path.join(path.dirname(this.memoryPath), `voice-feedback.${this.hostId}.jsonl`);
  }

  /**
   * Per-machine shard key for the feedback file. Hostname alone is NOT
   * enough — the user's Mac and Windows box are BOTH named "workstation",
   * which would make both append to one synced file (the conflict scenario
   * per-host files exist to avoid). Platform + username disambiguate.
   */
  private static machineId(): string {
    let username = '';
    try {
      username = os.userInfo().username;
    } catch {
      // no passwd entry / odd environment — hostname+platform still help
    }
    const raw = `${os.hostname()}-${process.platform}-${username}`;
    const h = raw
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return h || 'host';
  }

  /** Fold a pre-split voice-feedback.jsonl into this host's file, once. */
  private ensureMigrated(): Promise<void> {
    if (!this.migrated) {
      this.migrated = (async () => {
        const legacy = path.join(path.dirname(this.memoryPath), 'voice-feedback.jsonl');
        let raw: string;
        try {
          raw = await fs.promises.readFile(legacy, 'utf8');
        } catch {
          return; // no legacy file
        }
        try {
          if (raw.trim()) {
            await fs.promises.appendFile(this.feedbackPath, raw.endsWith('\n') ? raw : raw + '\n', 'utf8');
          }
          await fs.promises.unlink(legacy);
        } catch {
          // leave legacy in place; a later run retries
        }
      })();
    }
    return this.migrated;
  }

  /** Load the memory file, seeding the default on first use. */
  async loadMemory(): Promise<string> {
    try {
      return await fs.promises.readFile(this.memoryPath, 'utf8');
    } catch {
      await this.saveMemory(DEFAULT_MEMORY);
      return DEFAULT_MEMORY;
    }
  }

  async saveMemory(content: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.memoryPath), { recursive: true });
    await fs.promises.writeFile(this.memoryPath, content, 'utf8');
  }

  async appendFeedback(entry: VoiceFeedbackEntry): Promise<void> {
    await this.ensureMigrated();
    await fs.promises.mkdir(path.dirname(this.feedbackPath), { recursive: true });
    await fs.promises.appendFile(this.feedbackPath, JSON.stringify(entry) + '\n', 'utf8');
  }

  /** All voice-feedback*.jsonl files in the directory, merged and time-sorted. */
  private async feedbackFiles(): Promise<string[]> {
    const dir = path.dirname(this.memoryPath);
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      return [];
    }
    return names.filter((n) => /^voice-feedback(\..+)?\.jsonl$/.test(n)).map((n) => path.join(dir, n));
  }

  async readFeedback(): Promise<VoiceFeedbackEntry[]> {
    await this.ensureMigrated();
    const out: VoiceFeedbackEntry[] = [];
    for (const file of await this.feedbackFiles()) {
      let raw: string;
      try {
        raw = await fs.promises.readFile(file, 'utf8');
      } catch {
        continue;
      }
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t) {
          continue;
        }
        try {
          const e = JSON.parse(t) as VoiceFeedbackEntry;
          if (typeof e.stt === 'string' && typeof e.inserted === 'string') {
            out.push(e);
          }
        } catch {
          // skip corrupt line
        }
      }
    }
    out.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
    return out;
  }

  /** Clear ALL hosts' feedback logs after a review has consumed them. */
  async clearFeedback(): Promise<void> {
    await this.ensureMigrated();
    const files = await this.feedbackFiles();
    await Promise.all(files.map((f) => fs.promises.unlink(f).catch(() => undefined)));
  }
}

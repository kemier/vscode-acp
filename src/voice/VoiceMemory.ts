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
  /** 'accept' = sent verbatim (rule: don't touch); 'edited' = user fixed it (learning signal). */
  kind: 'accept' | 'edited';
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
 * Owns the two on-disk artifacts:
 *  - voice-memory.md      (the auditable rule file the corrector reads)
 *  - voice-feedback.jsonl (dictation outcomes used by the review command)
 */
export class VoiceMemoryStore {
  readonly memoryPath: string;
  readonly feedbackPath: string;

  constructor(memoryPathSetting?: string) {
    const dir = path.join(os.homedir(), '.vscode-acp');
    this.memoryPath =
      memoryPathSetting && memoryPathSetting.trim()
        ? memoryPathSetting.trim()
        : path.join(dir, 'voice-memory.md');
    this.feedbackPath = path.join(path.dirname(this.memoryPath), 'voice-feedback.jsonl');
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
    await fs.promises.mkdir(path.dirname(this.feedbackPath), { recursive: true });
    await fs.promises.appendFile(this.feedbackPath, JSON.stringify(entry) + '\n', 'utf8');
  }

  async readFeedback(): Promise<VoiceFeedbackEntry[]> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(this.feedbackPath, 'utf8');
    } catch {
      return [];
    }
    const out: VoiceFeedbackEntry[] = [];
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
    return out;
  }

  /** Clear the feedback log after a review has consumed it. */
  async clearFeedback(): Promise<void> {
    await fs.promises.writeFile(this.feedbackPath, '', 'utf8').catch(() => undefined);
  }
}

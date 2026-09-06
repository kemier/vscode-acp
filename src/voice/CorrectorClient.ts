import { log } from '../utils/Logger';

/**
 * Phase 2 "listener" corrector (Voice Memory, arXiv:2607.26410): a frozen
 * OpenAI-compatible chat model reads the memory.md rules and decides per
 * transcript to ACT (fix clear ASR errors) or ABSTAIN (return unchanged).
 *
 * Every failure path fails OPEN to the raw transcript — a broken corrector
 * must never block or mangle dictation. The paper's central result (harmful
 * edits dominate in the low-error regime) is enforced structurally here:
 * restraint-biased prompt + an over-edit length guard.
 */

export interface CorrectorConfig {
  enabled: boolean;
  /** OpenAI-compatible chat completions URL, e.g. http://127.0.0.1:8008/v1/chat/completions */
  endpoint: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
}

export interface CorrectionResult {
  text: string;
  /** true when the corrector changed anything (for logging/feedback). */
  acted: boolean;
}

const SYSTEM_PROMPT = `You are a restrained corrector for speech-recognition transcripts of English/中文 mixed dictation to a coding assistant.

You are given a memory file of correction rules and one ASR hypothesis. Decide: ACT (fix clear recognition errors covered by the rules) or ABSTAIN (return the input unchanged).

Hard requirements:
- Output ONLY the final transcript text. No explanations, no quotes, no markdown fences.
- Default to ABSTAIN. Most hypotheses are already correct.
- Keep code, shell commands, file paths, URLs, and identifiers verbatim.
- Never normalize numbers, casing, punctuation, or spelling conventions unless a memory rule says to.
- Never translate, summarize, or complete sentences; preserve the English/中文 mix as dictated.
- If unsure, return the input exactly.

Memory file:
---
%s
---`;

export async function correctTranscript(
  transcript: string,
  memory: string,
  cfg: CorrectorConfig,
): Promise<CorrectionResult> {
  const input = transcript;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, cfg.timeoutMs));
    let res: Response;
    try {
      res = await fetch(cfg.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT.replace('%s', memory) },
            { role: 'user', content: transcript },
          ],
          temperature: 0,
          stream: false,
          // Ollama: keep thinking out of the transcript; other servers ignore it.
          think: false,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      log(`[voice] corrector HTTP ${res.status} — keeping raw transcript`);
      return { text: input, acted: false };
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    // Strip <think>…</think> defensively in case the server ignored think:false.
    const out = (data.choices?.[0]?.message?.content ?? '')
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .trim();
    if (!out) {
      log('[voice] corrector returned empty — keeping raw transcript');
      return { text: input, acted: false };
    }
    // Over-edit guard: a correction that changes length by more than half
    // (or 20 chars) is almost certainly the over-correction failure mode the
    // paper warns about — abstain instead.
    if (Math.abs(out.length - input.length) > Math.max(20, input.length * 0.5)) {
      log(`[voice] corrector over-edit guard tripped (${input.length} → ${out.length}) — abstaining`);
      return { text: input, acted: false };
    }
    return { text: out, acted: out !== input };
  } catch (err) {
    log(`[voice] corrector failed (${err instanceof Error ? err.message : String(err)}) — keeping raw transcript`);
    return { text: input, acted: false };
  }
}

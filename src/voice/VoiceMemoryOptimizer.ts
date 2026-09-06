import { CorrectorConfig } from './CorrectorClient';
import { VoiceFeedbackEntry } from './VoiceMemory';

/**
 * Phase 3 "thinker" (Voice Memory, arXiv:2607.26410): revises memory.md from
 * scored rollouts. Two deliberate deviations from the paper's Algorithm 1:
 *
 *  - The acceptance gate is a HUMAN reviewing a diff (acp.reviewVoiceMemory),
 *    not an automatic held-out WER score — we have no reference transcripts,
 *    and the user's accept/reject is the ground truth for their own dictation.
 *  - Feedback comes from real usage: 'edited' entries (user fixed the
 *    transcript before sending) are the failure rollouts; 'accept' entries
 *    (sent verbatim) are the success rollouts that teach restraint.
 */

const OPTIMIZER_PROMPT = `You maintain the memory file of a restrained ASR-transcript corrector (English/中文 mixed coding-assistant dictation). The corrector reads this file at inference and decides per transcript whether to ACT or ABSTAIN.

You are given:
1. The current memory file.
2. Feedback from real usage:
   - "edited" pairs: the STT hypothesis and the user's hand-corrected final text — these are correction opportunities the pipeline missed or got wrong.
   - "accept" entries: transcripts sent verbatim — patterns the corrector must NOT touch.

Propose a revised memory file. Constraints:
- Bounded edits: add, modify, or remove AT MOST 10 rules.
- Prefer suppressive rules ("keep X verbatim", "do not normalize Y") — over-correction is the main failure mode.
- Every new correction rule must be justified by at least one "edited" pair. Quote the pair in an HTML comment after the rule, e.g. <!-- 机翼→记忆 -->.
- Do NOT encode one-off content (specific sentences, names said once). Only durable vocabulary and conventions.
- Keep the file under 4 KB, Markdown, same section structure as the current file.
- Output ONLY the full revised memory file. No explanations, no markdown fences.`;

export async function proposeMemoryUpdate(
  currentMemory: string,
  feedback: VoiceFeedbackEntry[],
  cfg: CorrectorConfig,
): Promise<string> {
  const edited = feedback.filter((f) => f.kind === 'edited' && f.final);
  const accepted = feedback.filter((f) => f.kind === 'accept');
  const feedbackBlock = [
    '## Feedback',
    '',
    '### Edited pairs (STT → user final)',
    ...edited.slice(-50).map((f) => `- STT: ${JSON.stringify(f.stt)}\n  FINAL: ${JSON.stringify(f.final)}`),
    '',
    '### Accepted verbatim (do not touch patterns like these)',
    ...accepted.slice(-20).map((f) => `- ${JSON.stringify(f.inserted)}`),
  ].join('\n');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(5000, cfg.timeoutMs * 4));
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
          { role: 'system', content: OPTIMIZER_PROMPT },
          {
            role: 'user',
            content: `## Current memory file\n\n${currentMemory}\n\n${feedbackBlock}`,
          },
        ],
        temperature: 0,
        stream: false,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`Voice memory optimizer: HTTP ${res.status} from ${cfg.endpoint}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const proposal = data.choices?.[0]?.message?.content?.trim() ?? '';
  if (!proposal) {
    throw new Error('Voice memory optimizer: empty proposal');
  }
  // Strip a markdown fence if the model wrapped the file despite instructions.
  const fenced = proposal.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/);
  return fenced ? fenced[1].trim() + '\n' : proposal;
}

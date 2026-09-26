import type { JevClient, JevQuestion, JevResponse } from './JevClient';

/**
 * The "jev_judge" native tool — one native tool, three judgment kinds.
 *
 * The repo's AGENTS.md defines a whole battery of judgments this agent loop
 * keeps making by hand (audit §1–§9: link liveness, anchor integrity,
 * hint/question relevance, advance-link hygiene, LaTeX parity, no-fake
 * verification, version currency, pointer integrity, table sanity). Each of
 * those is a *closed* semantic judgment — exactly the shape Jev answers
 * natively with a calibrated probability instead of an LLM paragraph.
 *
 * This module turns a judgment request into a batch of atomic Jev questions
 * (choice / score / noul), runs them in one parallel call, and renders a
 * compact verdict summary the agent can branch on.
 *
 * Pure functions only — no vscode imports — so it unit-tests under the
 * vscode-shim harness.
 */

// --- Request shape (what the agent passes as tool arguments) --------------

export interface JudgementSpec {
  /** Stable id for the answer map. */
  id: string;
  /** What Jev is deciding. */
  kind: 'choice' | 'score' | 'noul';
  /** The question text ("Does this command destroy data?"). */
  instructions: string;
  /** choice: option → rubric; score: ordered level descriptions; noul: optional {true,false}. */
  criteria?: Record<string, string | null> | string[] | { true?: string; false?: string };
}

export interface JudgeRequest {
  /** The material to evaluate: file contents, a diff, a URL batch, a README/讲义 pair, ... */
  state: string | object | unknown[];
  /** What we want decided. One call fans out all judgements in parallel. */
  judgements: JudgementSpec[];
}

// --- Validation -------------------------------------------------------------

export interface ValidationIssue {
  path: string;
  message: string;
}

export function validateJudgeRequest(req: Partial<JudgeRequest> | null | undefined): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!req || typeof req !== 'object') {
    return [{ path: '', message: 'jev_judge expects { state, judgements }' }];
  }
  if (req.state === undefined || req.state === null || req.state === '') {
    issues.push({ path: 'state', message: 'state is required (the material to judge)' });
  }
  if (!Array.isArray(req.judgements) || req.judgements.length === 0) {
    issues.push({ path: 'judgements', message: 'judgements must be a non-empty array' });
    return issues;
  }
  const seen = new Set<string>();
  req.judgements.forEach((j: any, i) => {
    const at = `judgements[${i}]`;
    if (!j || typeof j !== 'object') {
      issues.push({ path: at, message: 'not an object' });
      return;
    }
    if (typeof j.id !== 'string' || !j.id) {
      issues.push({ path: `${at}.id`, message: 'id is required' });
    } else if (seen.has(j.id)) {
      issues.push({ path: `${at}.id`, message: `duplicate id "${j.id}"` });
    } else {
      seen.add(j.id);
    }
    if (!['choice', 'score', 'noul'].includes(j.kind)) {
      issues.push({ path: `${at}.kind`, message: 'kind must be choice | score | noul' });
    }
    if (typeof j.instructions !== 'string' || !j.instructions.trim()) {
      issues.push({ path: `${at}.instructions`, message: 'instructions is required' });
    }
    if (j.kind === 'choice') {
      const n = j.criteria && typeof j.criteria === 'object' && !Array.isArray(j.criteria)
        ? Object.keys(j.criteria).length
        : 0;
      if (n < 2) {issues.push({ path: `${at}.criteria`, message: 'choice needs >= 2 options' });}
      if (n > 255) {issues.push({ path: `${at}.criteria`, message: 'choice supports at most 255 options' });}
    }
    if (j.kind === 'score') {
      const n = Array.isArray(j.criteria) ? j.criteria.length : 0;
      if (n < 2 || n > 10) {issues.push({ path: `${at}.criteria`, message: 'score needs 2–10 ordered levels' });}
    }
  });
  return issues;
}

/** Convert validated JudgementSpecs into the wire question map. */
export function toQuestionMap(judgements: JudgementSpec[]): Record<string, JevQuestion> {
  const map: Record<string, JevQuestion> = {};
  for (const j of judgements) {
    if (j.kind === 'noul') {
      map[j.id] = { type: 'noul', instructions: j.instructions, criteria: j.criteria as any };
    } else if (j.kind === 'choice') {
      map[j.id] = { type: 'choice', instructions: j.instructions, criteria: (j.criteria ?? {}) as Record<string, string | null> };
    } else {
      map[j.id] = { type: 'score', instructions: j.instructions, criteria: (j.criteria ?? []) as string[] };
    }
  }
  return map;
}

// --- Rendering --------------------------------------------------------------

export interface JudgementVerdict {
  id: string;
  kind: string;
  /** choice: the option; score: numeric score; noul: P(yes). */
  value: string | number;
  confidence: number | null;
  /** Full distribution when present (choice/score). */
  probabilities?: Record<string, number>;
}

export function extractVerdicts(judgements: JudgementSpec[], resp: JevResponse): JudgementVerdict[] {
  const out: JudgementVerdict[] = [];
  for (const j of judgements) {
    const a = resp.answers[j.id];
    if (!a) {continue;}
    if (a.type === 'noul') {
      out.push({ id: j.id, kind: 'noul', value: a.noul, confidence: null });
    } else if (a.type === 'choice') {
      out.push({ id: j.id, kind: 'choice', value: a.choice, confidence: a.confidence, probabilities: a.probabilities });
    } else if (a.type === 'score') {
      out.push({ id: j.id, kind: 'score', value: a.score, confidence: a.confidence, probabilities: a.probabilities });
    }
  }
  return out;
}

/**
 * Format verdicts as compact text for the tool result. Below `lowConfidence`
 * the verdict is flagged LOW-CONFIDENCE so the agent escalates to the LLM
 * or the user instead of acting on it (Jev guidance: confidence gates
 * automation).
 */
export function formatVerdicts(
  verdicts: JudgementVerdict[],
  opts: { lowConfidence?: number; model?: string; inputTokens?: number } = {},
): string {
  const low = opts.lowConfidence ?? 0.5;
  const lines: string[] = [];
  lines.push(`jev_judge (${opts.model ?? 'jev'}): ${verdicts.length} judgement(s)`);
  for (const v of verdicts) {
    const conf = v.confidence === null ? '' : ` confidence=${v.confidence.toFixed(2)}${v.confidence < low ? ' LOW-CONFIDENCE — escalate' : ''}`;
    if (v.kind === 'noul') {
      const p = v.value as number;
      lines.push(`- ${v.id}: P(yes)=${p.toFixed(2)}${p >= 1 - low ? ' → yes' : p <= low ? ' → no' : ' → uncertain — escalate'}`);
    } else if (v.kind === 'choice') {
      lines.push(`- ${v.id}: ${v.value}${conf}`);
      if (v.probabilities) {
        const dist = Object.entries(v.probabilities)
          .sort((a, b) => b[1] - a[1])
          .map(([k, p]) => `${k}=${p.toFixed(2)}`)
          .join(' ');
        lines.push(`    dist: ${dist}`);
      }
    } else {
      lines.push(`- ${v.id}: score=${typeof v.value === 'number' ? v.value.toFixed(2) : v.value}${conf}`);
    }
  }
  if (opts.inputTokens !== undefined) {
    lines.push(`usage: ${opts.inputTokens} input tokens (output free)`);
  }
  return lines.join('\n');
}

// --- Tool handler glue ------------------------------------------------------

export interface JudgeToolDeps {
  client: JevClient;
  log: (msg: string) => void;
}

/**
 * Execute a jev_judge tool call. Returns markdown text (tool-call content
 * shape). Never throws: validation errors and Jev unavailability come back as
 * readable text so the agent can fall back to its own reasoning.
 */
export async function executeJudgeTool(
  params: unknown,
  deps: JudgeToolDeps,
): Promise<string> {
  const req = params as Partial<JudgeRequest>;
  const issues = validateJudgeRequest(req);
  if (issues.length > 0) {
    return `jev_judge: invalid request\n${issues.map((i) => `- ${i.path || '(root)'}: ${i.message}`).join('\n')}`;
  }
  const full = req as JudgeRequest;
  deps.log(`JevTool: judging ${full.judgements.length} question(s)`);
  const resp = await deps.client.decide(full.state, toQuestionMap(full.judgements));
  if (!resp) {
    return 'jev_judge: Jev unavailable (disabled, no API key, timeout, or upstream error). Fall back to your own reasoning.';
  }
  const verdicts = extractVerdicts(full.judgements, resp);
  if (verdicts.length === 0) {
    return 'jev_judge: Jev returned no answers.';
  }
  return formatVerdicts(verdicts, {
    model: resp.model,
    inputTokens: resp.usage?.input_tokens,
  });
}

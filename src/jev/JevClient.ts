import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Jev (TypeSafe System One) decision client.
 *
 * Jev is NOT an LLM — it does not generate text. It evaluates a `state`
 * against typed `questions` and returns probability distributions:
 *   - noul   → P(yes) in [0,1]
 *   - choice → { choice, probabilities, confidence }
 *   - score  → { score, probabilities, confidence }
 *
 * Wire API (hosted TypeSafe and self-hosted OpenJev are identical):
 *   POST {baseUrl}/v1/systemone
 *   Authorization: Bearer <key>
 *   { "state": ..., "model": "jev-latest", "questions": { id: {...} } }
 *   → { "model": "jev-1.13.0", "answers": { id: {...} }, "usage": {...} }
 *
 * See docs/jev-integration-spec.md for the full integration design.
 *
 * This module is dependency-free (global fetch, Node >= 18) and pure where
 * possible so it is unit-testable with the vscode-shim harness.
 */

// --- Wire types -----------------------------------------------------------

export type JevQuestion =
  | { type: 'noul'; instructions: string | object | unknown[]; criteria?: { true?: string; false?: string } }
  | { type: 'choice'; instructions: string | object | unknown[]; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string | object | unknown[]; criteria: string[] };

export type JevAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number };

export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens: number; output_tokens: number };
}

export interface JevClientConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

// --- Config plumbing ------------------------------------------------------

export interface JevSettings {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

const DEFAULTS: JevSettings = {
  enabled: false,
  baseUrl: 'http://127.0.0.1:8317',
  apiKey: '',
  model: 'laya',
  timeoutMs: 5000,
};

/**
 * Read the raw `acp.jev.*` block from a VS Code settings JSON file, or null when
 * the file is absent/unreadable/malformed. Used as a fallback so Machine-scope
 * settings (data/Machine/settings.json) are visible — `workspace.getConfiguration`
 * only merges default + User + Workspace for application-scope keys and does NOT
 * include Machine settings, which is where a shared-server operator places
 * per-machine keys. Returns the value of the full key (e.g. 'acp.jev.enabled').
 */
function readSettingsFileValue(file: string, key: string): unknown {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? (obj as Record<string, unknown>)[key] : undefined;
  } catch {
    return undefined;
  }
}

/** Candidate Machine settings file paths (remote-server + desktop layouts). */
function machineSettingsCandidates(): string[] {
  const home = os.homedir();
  return [
    // VS Code Server (remote / this deployment): data/Machine/settings.json
    path.join(home, '.vscode-server', 'data', 'Machine', 'settings.json'),
    // Code - OSS / insiders server variants
    path.join(home, '.vscode-oss-server', 'data', 'Machine', 'settings.json'),
    // Desktop Linux (less likely but harmless to check)
    path.join(home, '.config', 'Code', 'Machine', 'settings.json'),
  ];
}

/**
 * Resolve a single `acp.<key>` setting. Prefers the effective (User/Workspace)
 * value from `getConfiguration`; when that is still at the default, falls back
 * to the Machine settings file so Machine-only settings (the shared-server case)
 * are honored. `def` is the declared default.
 */
function resolveAcpSetting<T>(cfg: vscode.WorkspaceConfiguration, key: string, def: T): T {
  const eff = cfg.get<T>(key, def);
  if (eff !== def) {
    return eff;
  }
  // In the unit-test shim, __acpTestJevSettings fully controls acp.jev.* values
  // (a test may explicitly set enabled:false, which equals the default and would
  // otherwise be clobbered by the Machine-file fallback). When the hook is
  // active, trust it and skip the file read.
  if ((globalThis as { __acpTestJevSettings?: unknown }).__acpTestJevSettings) {
    return eff;
  }
  for (const file of machineSettingsCandidates()) {
    const v = readSettingsFileValue(file, `acp.${key}`);
    if (v !== undefined) {
      return v as T;
    }
  }
  return def;
}

/** Read acp.jev.* settings, falling back to env (JEV_BASE_URL / TYPESAFE_API_KEY). */
export function readJevSettings(): JevSettings {
  const cfg = vscode.workspace.getConfiguration('acp');
  const envKey = typeof process !== 'undefined' ? process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY || '' : '';
  const envUrl = typeof process !== 'undefined' ? process.env.JEV_BASE_URL || '' : '';
  return {
    enabled: resolveAcpSetting<boolean>(cfg, 'jev.enabled', DEFAULTS.enabled),
    baseUrl: (resolveAcpSetting<string>(cfg, 'jev.baseUrl', DEFAULTS.baseUrl) || envUrl || DEFAULTS.baseUrl).replace(/\/+$/, ''),
    apiKey: resolveAcpSetting<string>(cfg, 'jev.apiKey', '') || envKey,
    model: resolveAcpSetting<string>(cfg, 'jev.model', DEFAULTS.model),
    timeoutMs: resolveAcpSetting<number>(cfg, 'jev.timeoutMs', DEFAULTS.timeoutMs),
  };
}

// --- Pure request/response helpers (unit-testable) -------------------------

export function buildJevRequestBody(state: string | object | unknown[], questions: Record<string, JevQuestion>, model: string) {
  return { state, model, questions };
}

/**
 * Validate a response shape. Returns null when the payload is not a usable
 * Jev response (wrong status handled by caller; this checks the body).
 */
export function parseJevResponse(json: unknown): JevResponse | null {
  if (!json || typeof json !== 'object') {return null;}
  const j = json as any;
  if (typeof j.model !== 'string' || !j.answers || typeof j.answers !== 'object') {return null;}
  return j as JevResponse;
}

/** Extract the noul probability for a given question id; null when absent. */
export function noulValue(resp: JevResponse, id: string): number | null {
  const a = resp.answers[id];
  if (!a || a.type !== 'noul' || typeof a.noul !== 'number') {return null;}
  return a.noul;
}

/** Extract the chosen option for a choice question; null when absent. */
export function choiceValue(resp: JevResponse, id: string): { choice: string; confidence: number } | null {
  const a = resp.answers[id];
  if (!a || a.type !== 'choice' || typeof a.choice !== 'string') {return null;}
  return { choice: a.choice, confidence: typeof a.confidence === 'number' ? a.confidence : 0 };
}

// --- HTTP client ----------------------------------------------------------

const RETRY_STATUSES = new Set([429, 529]);

export class JevClient {
  constructor(private readonly cfg: JevClientConfig) {}

  /**
   * Evaluate `state` against `questions`. Resolves with the parsed response,
   * or null on any failure (timeout, non-2xx after one retry, bad body).
   * Never throws — callers treat null as "Jev unavailable" and fall through.
   */
  async decide(
    state: string | object | unknown[],
    questions: Record<string, JevQuestion>,
  ): Promise<JevResponse | null> {
    if (!this.cfg.apiKey) {
      return null;
    }
    const body = JSON.stringify(buildJevRequestBody(state, questions, this.cfg.model));
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(`${this.cfg.baseUrl}/v1/systemone`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.cfg.apiKey}`,
          },
          body,
          signal: AbortSignal.timeout(this.cfg.timeoutMs),
        });
        if (res.ok) {
          return parseJevResponse(await res.json());
        }
        if (RETRY_STATUSES.has(res.status) && attempt === 0) {
          await sleep(200);
          continue;
        }
        return null;
      } catch {
        return null; // timeout / network — fail open
      }
    }
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

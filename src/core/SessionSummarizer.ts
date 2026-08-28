/**
 * Shared session summarizer: responses-vllm-proxy primary with an
 * OpenAI-compatible fallback.
 *
 * Two callers need identical behaviour:
 *   - the /session slash command (summarize another session on demand);
 *   - acp.forkToAgent (send the target agent a summary instead of the raw
 *     transcript — a fork used to re-embed the whole conversation as one text
 *     block, which pushed the target past its context window immediately).
 *
 * This module is vscode-free so it stays unit-testable under plain mocha
 * (same constraint as src/core/SessionSummaryFallback.ts).
 */
import {
  summarizeViaChatCompletions,
  type FallbackSummarySettings,
  type SessionSummaryResult,
} from './SessionSummaryFallback';

export interface SummarizerSettings extends FallbackSummarySettings {
  /** vLLM proxy base URL (no trailing slash). */
  endpoint: string;
  /** Optional Bearer token when the proxy has api-keys configured. */
  apiKey: string;
  /** Model alias resolved by the proxy. Empty = auto-select. */
  model: string;
}

export interface SummarizeMessage {
  role: string;
  content: string;
}

/** Full URL for POST /v1/summarize-session on the vLLM proxy. */
export function buildSummarizeUrl(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, '')}/v1/summarize-session`;
}

/** True when both a fallback endpoint and key are configured. */
export function isFallbackConfigured(settings: SummarizerSettings): boolean {
  return !!(settings.fallbackEndpoint && settings.fallbackApiKey);
}

/**
 * Summarize via the proxy, falling back to the OpenAI-compatible endpoint when
 * one is configured. Throws an Error describing every attempt that failed, so
 * the caller can surface a single actionable message.
 */
export async function summarizeSession(
  title: string,
  messages: SummarizeMessage[],
  settings: SummarizerSettings,
  fetchImpl: typeof fetch = fetch,
): Promise<SessionSummaryResult> {
  let primaryError: string;
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (settings.apiKey) {
      headers.Authorization = `Bearer ${settings.apiKey}`;
    }
    const response = await fetchImpl(buildSummarizeUrl(settings.endpoint), {
      method: 'POST',
      headers,
      body: JSON.stringify({ title, messages, model: settings.model || undefined }),
      signal: AbortSignal.timeout(settings.timeoutMs),
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`HTTP ${response.status} ${errText.slice(0, 200)}`);
    }
    const data = (await response.json()) as SessionSummaryResult;
    if (!data || typeof data.summary !== 'string' || !data.summary.trim()) {
      throw new Error('response had no summary');
    }
    return { summary: data.summary.trim(), model: data.model || settings.model };
  } catch (e: unknown) {
    primaryError = e instanceof Error ? e.message : String(e);
  }

  if (!isFallbackConfigured(settings)) {
    throw new Error(`summarize failed (${primaryError}); no fallback endpoint configured`);
  }
  try {
    return await summarizeViaChatCompletions(title, messages, settings);
  } catch (e: unknown) {
    const fallbackError = e instanceof Error ? e.message : String(e);
    throw new Error(`summarize failed (${primaryError}); fallback failed (${fallbackError})`);
  }
}

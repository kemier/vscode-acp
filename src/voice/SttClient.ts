import * as fs from 'fs';
import * as path from 'path';

/**
 * OpenAI-compatible speech-to-text client.
 *
 * POSTs a WAV file as multipart/form-data to `{endpoint}` (default
 * whisper.cpp server's /v1/audio/transcriptions). The same API shape is
 * served by whisper.cpp `whisper-server`, FunASR's FastAPI wrapper, and
 * vLLM's transcription endpoint for Qwen3-ASR — so the extension stays
 * provider-agnostic and the model choice lives entirely in local config.
 *
 * The `prompt` field is the contextual-biasing lever for tech vocabulary:
 * whisper.cpp forwards it as the decoder initial prompt, which measurably
 * improves recognition of terms named in it (product names, "vLLM", "DCP"…).
 */

export interface SttConfig {
  /** Full URL, e.g. http://127.0.0.1:8080/v1/audio/transcriptions */
  endpoint: string;
  /** Model name sent in the form body (whisper.cpp ignores it; wrappers use it). */
  model: string;
  /** Optional Bearer token for endpoints that require auth. */
  apiKey: string;
  /** ISO language code; empty string = auto-detect (required for EN+ZH mixing). */
  language: string;
  /** Contextual-biasing prompt (tech terms); empty string = omit. */
  prompt: string;
  /** Request timeout in milliseconds. */
  timeoutMs: number;
}

export class SttError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'SttError';
  }
}

export async function transcribeAudio(filePath: string, cfg: SttConfig): Promise<string> {
  if (!cfg.endpoint.trim()) {
    throw new SttError(
      'Voice input: acp.voice.stt.endpoint is not configured. Start a local STT server ' +
        '(e.g. whisper.cpp `whisper-server -m ggml-large-v3-turbo.bin`) and set the endpoint.',
    );
  }

  const audio = await fs.promises.readFile(filePath);
  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/wav' }), path.basename(filePath));
  form.append('model', cfg.model || 'whisper-1');
  form.append('response_format', 'json');
  if (cfg.language.trim()) {
    form.append('language', cfg.language.trim());
  }
  if (cfg.prompt.trim()) {
    form.append('prompt', cfg.prompt.trim());
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, cfg.timeoutMs));
  try {
    const headers: Record<string, string> = {};
    if (cfg.apiKey.trim()) {
      headers['authorization'] = `Bearer ${cfg.apiKey.trim()}`;
    }
    const res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers,
      body: form,
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 300);
      throw new SttError(`Voice input: STT endpoint returned HTTP ${res.status}. ${body}`, res.status);
    }
    const json = (await res.json()) as { text?: unknown };
    const text = typeof json?.text === 'string' ? json.text.trim() : '';
    if (!text) {
      throw new SttError('Voice input: STT returned an empty transcript (silence or unrecognized speech).');
    }
    return text;
  } catch (err) {
    if (err instanceof SttError) {
      throw err;
    }
    if (err instanceof Error && err.name === 'AbortError') {
      throw new SttError(`Voice input: STT request timed out after ${cfg.timeoutMs}ms.`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new SttError(`Voice input: STT request failed — ${msg}. Is the local STT server running?`);
  } finally {
    clearTimeout(timeout);
  }
}

import * as fs from 'fs';
import * as path from 'path';
import { log } from '../utils/Logger';

/**
 * OpenAI-compatible speech-to-text client.
 *
 * POSTs a WAV file as multipart/form-data to `{endpoint}`. Two endpoint
 * shapes work, both returning `{"text": "..."}`:
 *  - whisper.cpp `whisper-server`: POST /inference (default port 8080)
 *  - OpenAI-compatible: POST /v1/audio/transcriptions (FunASR FastAPI
 *    wrappers, vLLM serving Qwen3-ASR)
 * The extension stays provider-agnostic; the model choice lives in config.
 *
 * The `prompt` field is the contextual-biasing lever for tech vocabulary:
 * whisper.cpp forwards it as the decoder initial prompt, which measurably
 * improves recognition of terms named in it (product names, "vLLM", "DCP"…).
 */

export interface SttConfig {
  /** Full URL, e.g. http://127.0.0.1:8080/inference (whisper.cpp) or .../v1/audio/transcriptions (OpenAI-compatible) */
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

/**
 * Smallest valid 16 kHz mono 16-bit WAV: `ms` of digital silence.
 * Used to poke the STT server so it loads its model before the real take
 * arrives (see `warmupStt`).
 */
export function buildSilentWav(ms = 120): Buffer {
  const sampleRate = 16000;
  const frames = Math.max(1, Math.round((sampleRate * ms) / 1000));
  const data = Buffer.alloc(frames * 2); // zeros = silence
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * Fire-and-forget model warm-up.
 *
 * Measured against the EricAI-backed endpoint: a request that has to load
 * `whisper-large-v3-turbo` takes ~45–60 s, while any request after that takes
 * 0.1–0.3 s. The model is unloaded again when idle, so the FIRST take after a
 * pause is the one that times out. Sending a 120 ms silent clip when recording
 * starts moves that load into the window where the user is still speaking.
 *
 * Never throws and never blocks the take: the caller does not await it.
 */
/**
 * Liveness probe: send the warm-up clip and report what the backend actually
 * said. Used by `ACP: Voice Input Diagnostics` so "is the STT model up?" is one
 * command instead of a curl session — the Ray deployment disappears often
 * enough that this is the first question worth asking.
 */
export async function probeStt(cfg: SttConfig): Promise<{ ok: boolean; ms: number; detail: string; source?: string }> {
  const t0 = Date.now();
  if (!cfg.endpoint.trim()) {
    return { ok: false, ms: 0, detail: 'acp.voice.stt.endpoint is not configured' };
  }
  try {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(buildSilentWav())], { type: 'audio/wav' }), 'probe.wav');
    form.append('model', cfg.model || 'whisper-1');
    form.append('response_format', 'json');
    const headers: Record<string, string> = {};
    if (cfg.apiKey.trim()) {
      headers['authorization'] = `Bearer ${cfg.apiKey.trim()}`;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1000, cfg.timeoutMs));
    try {
      const res = await fetch(cfg.endpoint, {
        method: 'POST',
        headers,
        body: form,
        signal: controller.signal,
      });
      const raw = await res.text().catch(() => '');
      const ms = Date.now() - t0;
      if (!res.ok) {
        return { ok: false, ms, detail: `HTTP ${res.status}: ${raw.slice(0, 200)}` };
      }
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { ok: false, ms, detail: `unparseable response: ${raw.slice(0, 160)}` };
      }
      const embedded = extractEmbeddedError(parsed);
      if (embedded) {
        return { ok: false, ms, detail: embedded.message.slice(0, 220) };
      }
      // A silent clip legitimately transcribes to nothing, so reaching here with
      // a `text` field (even empty) means the model answered.
      const hasText = typeof (parsed as { text?: unknown })?.text === 'string';
      const source = describeSttSource(res.headers.get('x-stt-source'));
      return hasText
        ? { ok: true, ms, detail: 'model answered', source }
        : { ok: false, ms, detail: `no text field: ${raw.slice(0, 160)}`, source };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    return {
      ok: false,
      ms: Date.now() - t0,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function warmupStt(cfg: SttConfig): Promise<void> {
  if (!cfg.endpoint.trim()) {
    return;
  }
  const t0 = Date.now();
  try {
    const form = new FormData();
    // Copy into a plain Uint8Array: Node's Buffer may be backed by a
    // SharedArrayBuffer, which BlobPart does not accept.
    form.append('file', new Blob([new Uint8Array(buildSilentWav())], { type: 'audio/wav' }), 'warmup.wav');
    form.append('model', cfg.model || 'whisper-1');
    form.append('response_format', 'json');
    const headers: Record<string, string> = {};
    if (cfg.apiKey.trim()) {
      headers['authorization'] = `Bearer ${cfg.apiKey.trim()}`;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1000, cfg.timeoutMs));
    try {
      const res = await fetch(cfg.endpoint, {
        method: 'POST',
        headers,
        body: form,
        signal: controller.signal,
      });
      const raw = await res.text().catch(() => '');
      // A 200 can still carry {"error":{...DeploymentUnavailableError...}}, in
      // which case nothing was warmed and saying "HTTP 200" would be a lie.
      let embedded: { message: string } | null = null;
      try {
        embedded = extractEmbeddedError(JSON.parse(raw));
      } catch {
        embedded = null;
      }
      if (embedded) {
        log(
          `[voice] STT warm-up did NOT warm the model after ${Date.now() - t0}ms — ` +
            `backend said: ${embedded.message.slice(0, 160)}`,
        );
      } else {
        log(`[voice] STT warm-up finished in ${Date.now() - t0}ms (HTTP ${res.status})`);
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    // Warm-up is best-effort; the real request reports any actual problem.
    log(`[voice] STT warm-up failed after ${Date.now() - t0}ms: ${String(err)}`);
  }
}

/**
 * True for backend states that resolve by waiting: Ray Serve reports a
 * scaled-down or restarting deployment as `DeploymentUnavailableError`, and a
 * cold deployment can take ~45–60 s to come up. Retrying inside the request
 * timeout turns those into a slow success instead of a lost take.
 */
/**
 * Human label for the `x-stt-source` header ericai-proxy sets when it answers
 * from the local whisper.cpp fallback instead of the shared Ray cluster.
 * Absent header = the shared backend produced the transcript.
 */
export function describeSttSource(header: string | null): string {
  if (!header) {
    return 'shared cluster';
  }
  return header === 'local-whisper-cpp' ? 'local whisper.cpp' : header;
}

export function isTransientSttError(message: string): boolean {
  return /Deployment\s*Unavailable|Service\s*Unavailable|temporarily unavailable|overloaded|\b50[234]\b|ECONNRESET|socket hang up/i.test(
    message,
  );
}

/**
 * Extract an error carried *inside* a 200 response.
 *
 * The EricAI/Ray backend answers `HTTP 200` with
 * `{"error":{"message":"...DeploymentUnavailableError...","code":500}}` and no
 * `text` field. Treating that as an empty transcript (which the code used to
 * do) blamed the microphone for a backend outage — the single most misleading
 * failure mode this feature had.
 */
export function extractEmbeddedError(json: unknown): { message: string; code?: number } | null {
  if (!json || typeof json !== 'object') {
    return null;
  }
  const err = (json as { error?: unknown }).error;
  if (!err) {
    return null;
  }
  if (typeof err === 'string') {
    return { message: err };
  }
  if (typeof err === 'object') {
    const e = err as { message?: unknown; type?: unknown; code?: unknown };
    const message =
      typeof e.message === 'string'
        ? e.message
        : typeof e.type === 'string'
          ? e.type
          : JSON.stringify(err).slice(0, 300);
    return { message, code: typeof e.code === 'number' ? e.code : undefined };
  }
  return null;
}

/** One transcription attempt. Throws SttError; callers handle retries. */
async function postTranscription(
  filePath: string,
  cfg: SttConfig,
  timeoutMs: number,
): Promise<{ text: string; source: string }> {
  const audio = await fs.promises.readFile(filePath);
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), path.basename(filePath));
  form.append('model', cfg.model || 'whisper-1');
  form.append('response_format', 'json');
  if (cfg.language.trim()) {
    form.append('language', cfg.language.trim());
  }
  if (cfg.prompt.trim()) {
    form.append('prompt', cfg.prompt.trim());
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
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
    // Check for an in-body error BEFORE judging the transcript: a 200 with an
    // error object means the backend never looked at the audio.
    const embedded = extractEmbeddedError(json);
    if (embedded) {
      throw new SttError(`Voice input: STT backend error — ${embedded.message}`, embedded.code ?? undefined);
    }
    const text = typeof json?.text === 'string' ? json.text.trim() : '';
    if (!text) {
      throw new SttError('Voice input: STT returned an empty transcript (silence or unrecognized speech).');
    }
    return { text, source: describeSttSource(res.headers.get('x-stt-source')) };
  } catch (err) {
    if (err instanceof SttError) {
      throw err;
    }
    if (err instanceof Error && err.name === 'AbortError') {
      throw new SttError(`Voice input: STT request timed out after ${timeoutMs}ms.`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new SttError(`Voice input: STT request failed — ${msg}. Is the local STT server running?`);
  } finally {
    clearTimeout(timeout);
  }
}

export async function transcribeAudio(filePath: string, cfg: SttConfig): Promise<string> {
  if (!cfg.endpoint.trim()) {
    throw new SttError(
      'Voice input: acp.voice.stt.endpoint is not configured. Start a local STT server ' +
        '(e.g. whisper.cpp `whisper-server -m ggml-large-v3-turbo.bin`) and set the endpoint.',
    );
  }

  // Retry only the transient class, and only while the caller's overall budget
  // lasts. A scaled-down Ray deployment rejects in ~100 ms, so several attempts
  // cost nothing; a genuine outage still reports the real backend message.
  const deadline = Date.now() + Math.max(1000, cfg.timeoutMs);
  const delays = [2000, 4000, 8000, 12000];
  let attempt = 0;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new SttError(`Voice input: STT request timed out after ${cfg.timeoutMs}ms.`);
    }
    try {
      const { text, source } = await postTranscription(filePath, cfg, remaining);
      log(`[voice] transcribed by ${source}`);
      return text;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const delay = delays[Math.min(attempt, delays.length - 1)];
      if (!isTransientSttError(message) || Date.now() + delay >= deadline) {
        throw err;
      }
      attempt += 1;
      log(`[voice] STT attempt ${attempt} failed (${message.slice(0, 120)}); retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

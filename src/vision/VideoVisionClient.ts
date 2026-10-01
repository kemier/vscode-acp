import * as fs from 'fs';
import * as path from 'path';
import { log, logError } from '../utils/Logger';

/**
 * OpenAI-compatible video understanding client (StepFun / Qwen / OpenRouter).
 *
 * Sends `{ type: "video_url", video_url: { url } }` plus a text instruction.
 * Short clips use a data URI; larger clips prefer StepFun Files API
 * (`stepfile://`) when the endpoint base looks like StepFun.
 *
 * See docs/vision-models.md for the provider matrix.
 */

export interface VisionConfig {
  /** Base URL ending with /v1, e.g. https://api.stepfun.com/v1 */
  endpoint: string;
  apiKey: string;
  model: string;
  /** openai-compat (default) — Gemini reserved for a later adapter. */
  provider: 'openai-compat' | 'gemini';
  timeoutMs: number;
  /** Files larger than this use Files API when available (bytes). */
  inlineMaxBytes: number;
  /** User instruction sent with the video. */
  prompt: string;
}

export class VisionError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'VisionError';
  }
}

export function readVisionConfigFromWorkspace(get: (key: string, def: any) => any): VisionConfig {
  return {
    endpoint: String(get('endpoint', 'https://api.stepfun.com/v1') || ''),
    apiKey: String(get('apiKey', '') || ''),
    model: String(get('model', 'step-5-preview') || 'step-5-preview'),
    provider: (get('provider', 'openai-compat') as VisionConfig['provider']) || 'openai-compat',
    timeoutMs: Number(get('timeoutMs', 180000)) || 180000,
    inlineMaxBytes: Number(get('inlineMaxBytes', 15 * 1024 * 1024)) || 15 * 1024 * 1024,
    prompt: String(
      get(
        'prompt',
        'Summarize what is happening on screen. Call out UI text, errors, and any actionable details relevant to a coding assistant.',
      ) || '',
    ),
  };
}

function chatCompletionsUrl(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

function filesUrl(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, '');
  if (/\/v1$/i.test(base)) return `${base}/files`;
  if (/\/chat\/completions$/i.test(base)) return base.replace(/\/chat\/completions$/i, '/files');
  return `${base}/v1/files`;
}

function looksLikeStepfun(endpoint: string): boolean {
  return /stepfun\.(com|ai|cn)/i.test(endpoint);
}

/**
 * Build the video_url content part. Exported for unit tests.
 */
export function buildVideoUrlPart(url: string): { type: 'video_url'; video_url: { url: string } } {
  return { type: 'video_url', video_url: { url } };
}

export function buildVisionMessages(
  videoUrl: string,
  prompt: string,
): Array<{ role: 'user'; content: Array<Record<string, unknown>> }> {
  return [
    {
      role: 'user',
      content: [buildVideoUrlPart(videoUrl), { type: 'text', text: prompt }],
    },
  ];
}

async function uploadStepfile(cfg: VisionConfig, filePath: string, signal: AbortSignal): Promise<string> {
  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('purpose', 'storage');
  form.append('file', new Blob([buf], { type: 'video/mp4' }), path.basename(filePath) || 'take.mp4');

  const headers: Record<string, string> = {};
  if (cfg.apiKey.trim()) {
    headers.authorization = `Bearer ${cfg.apiKey.trim()}`;
  }

  const res = await fetch(filesUrl(cfg.endpoint), { method: 'POST', headers, body: form, signal });
  const bodyText = await res.text();
  if (!res.ok) {
    throw new VisionError(`Vision Files API HTTP ${res.status}: ${bodyText.slice(0, 400)}`, res.status);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new VisionError(`Vision Files API returned non-JSON: ${bodyText.slice(0, 200)}`);
  }
  const id = parsed?.id || parsed?.file_id || parsed?.data?.id;
  if (!id || typeof id !== 'string') {
    throw new VisionError(`Vision Files API response missing id: ${bodyText.slice(0, 200)}`);
  }
  return `stepfile://${id}`;
}

function extractAssistantText(parsed: any): string {
  const choice = parsed?.choices?.[0];
  const content = choice?.message?.content ?? choice?.text ?? parsed?.output_text;
  if (typeof content === 'string' && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    const parts = content
      .map((c: any) => (typeof c === 'string' ? c : c?.text || ''))
      .filter(Boolean);
    if (parts.length) return parts.join('\n').trim();
  }
  throw new VisionError('Vision API returned an empty assistant message.');
}

/**
 * Analyze a local MP4 and return the model's text summary.
 */
export async function analyzeVideo(filePath: string, cfg: VisionConfig): Promise<string> {
  if (cfg.provider === 'gemini') {
    throw new VisionError('Vision provider "gemini" is not implemented yet; set acp.vision.provider to openai-compat.');
  }
  if (!cfg.endpoint.trim()) {
    throw new VisionError('acp.vision.endpoint is not configured.');
  }
  if (!fs.existsSync(filePath)) {
    throw new VisionError(`Video file not found: ${filePath}`);
  }

  const bytes = fs.statSync(filePath).size;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  try {
    let videoUrl: string;
    if (bytes > cfg.inlineMaxBytes && looksLikeStepfun(cfg.endpoint)) {
      log(`[vision] uploading ${bytes} bytes via Files API`);
      videoUrl = await uploadStepfile(cfg, filePath, controller.signal);
    } else {
      if (bytes > cfg.inlineMaxBytes) {
        log(
          `[vision] file is ${bytes} bytes (> inlineMaxBytes ${cfg.inlineMaxBytes}); inlining as base64 anyway (endpoint is not StepFun)`,
        );
      }
      const b64 = fs.readFileSync(filePath).toString('base64');
      videoUrl = `data:video/mp4;base64,${b64}`;
    }

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cfg.apiKey.trim()) {
      headers.authorization = `Bearer ${cfg.apiKey.trim()}`;
    }

    const body = {
      model: cfg.model || 'step-5-preview',
      messages: buildVisionMessages(videoUrl, cfg.prompt || 'Describe this screen recording.'),
    };

    const url = chatCompletionsUrl(cfg.endpoint);
    log(`[vision] POST ${url} model=${body.model} video=${videoUrl.startsWith('stepfile://') ? videoUrl : `data-uri(${bytes}B)`}`);
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new VisionError(`Vision API HTTP ${res.status}: ${text.slice(0, 500)}`, res.status);
    }
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new VisionError(`Vision API returned non-JSON: ${text.slice(0, 200)}`);
    }
    return extractAssistantText(parsed);
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new VisionError(`Vision API timed out after ${cfg.timeoutMs}ms`);
    }
    if (err instanceof VisionError) throw err;
    logError('[vision] analyzeVideo failed', err);
    throw new VisionError(`Vision API failed: ${String(err?.message || err)}`);
  } finally {
    clearTimeout(timer);
  }
}

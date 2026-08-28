import * as assert from 'assert';

/**
 * Tests for the shared session summarizer used by /session and acp.forkToAgent.
 *
 * The fork previously sent the raw transcript to the target agent, which
 * re-embedded the whole conversation as one text block and pushed the target
 * past its context window on the first prompt. It now sends a summary, so the
 * summarize path must behave predictably: use the proxy when it works, fall
 * back only when a fallback is configured, and fail with an actionable message
 * otherwise (never silently return the raw transcript).
 */

import {
  buildSummarizeUrl,
  isFallbackConfigured,
  summarizeSession,
  type SummarizerSettings,
} from '../core/SessionSummarizer';

const baseSettings: SummarizerSettings = {
  endpoint: 'http://127.0.0.1:8317',
  apiKey: '',
  model: 'qwen38-27b',
  timeoutMs: 10_000,
  fallbackEndpoint: '',
  fallbackApiKey: '',
  fallbackModel: 'deepseek-v4-flash',
};

/** Minimal fetch double: returns queued responses in order. */
function fakeFetch(responses: Array<{ ok: boolean; status?: number; body?: unknown; text?: string }>) {
  const calls: Array<{ url: string; body: any }> = [];
  const impl = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
    const r = responses.shift();
    if (!r) {
      throw new Error('unexpected extra fetch call');
    }
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      json: async () => r.body,
      text: async () => r.text ?? '',
    } as any;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

suite('SessionSummarizer', () => {
  test('buildSummarizeUrl appends the proxy path and strips trailing slashes', () => {
    assert.strictEqual(buildSummarizeUrl('http://h:1'), 'http://h:1/v1/summarize-session');
    assert.strictEqual(buildSummarizeUrl('http://h:1///'), 'http://h:1/v1/summarize-session');
  });

  test('isFallbackConfigured requires both endpoint and key', () => {
    assert.strictEqual(isFallbackConfigured(baseSettings), false);
    assert.strictEqual(isFallbackConfigured({ ...baseSettings, fallbackEndpoint: 'https://x' }), false);
    assert.strictEqual(isFallbackConfigured({ ...baseSettings, fallbackApiKey: 'k' }), false);
    assert.strictEqual(
      isFallbackConfigured({ ...baseSettings, fallbackEndpoint: 'https://x', fallbackApiKey: 'k' }),
      true,
    );
  });

  test('returns the proxy summary and forwards title/messages/model', async () => {
    const { impl, calls } = fakeFetch([{ ok: true, body: { summary: '  a summary  ', model: 'qwen38-27b' } }]);
    const messages = [
      { role: 'user', content: 'User: do a thing' },
      { role: 'assistant', content: 'Assistant: done' },
    ];
    const out = await summarizeSession('Forked from ericli', messages, baseSettings, impl);
    assert.strictEqual(out.summary, 'a summary');
    assert.strictEqual(out.model, 'qwen38-27b');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'http://127.0.0.1:8317/v1/summarize-session');
    assert.strictEqual(calls[0].body.title, 'Forked from ericli');
    assert.deepStrictEqual(calls[0].body.messages, messages);
    assert.strictEqual(calls[0].body.model, 'qwen38-27b');
  });

  test('treats a blank proxy summary as a failure', async () => {
    const { impl } = fakeFetch([{ ok: true, body: { summary: '   ' } }]);
    await assert.rejects(
      () => summarizeSession('t', [{ role: 'user', content: 'x' }], baseSettings, impl),
      /no summary/,
    );
  });

  test('reports the proxy error and the missing fallback, and does not retry', async () => {
    const { impl, calls } = fakeFetch([{ ok: false, status: 503, text: 'backend down' }]);
    await assert.rejects(
      () => summarizeSession('t', [{ role: 'user', content: 'x' }], baseSettings, impl),
      (e: Error) => {
        assert.match(e.message, /HTTP 503/);
        assert.match(e.message, /backend down/);
        assert.match(e.message, /no fallback endpoint configured/);
        return true;
      },
    );
    // No fallback configured — exactly one call.
    assert.strictEqual(calls.length, 1);
  });

  test('never resolves to the raw transcript on failure', async () => {
    const { impl } = fakeFetch([{ ok: false, status: 500, text: 'boom' }]);
    let resolved: unknown = 'not-called';
    try {
      resolved = await summarizeSession('t', [{ role: 'user', content: 'the whole transcript' }], baseSettings, impl);
      assert.fail('should have thrown');
    } catch {
      assert.strictEqual(resolved, 'not-called');
    }
  });
});

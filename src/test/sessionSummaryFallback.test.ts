import * as assert from 'assert';
import {
  buildChatCompletionsUrl,
  buildFallbackMessages,
  parseChatCompletionsSummary,
  summarizeViaChatCompletions,
} from '../core/SessionSummaryFallback';

const SETTINGS = {
  fallbackEndpoint: 'https://api.deepseek.com',
  fallbackApiKey: 'sk-test',
  fallbackModel: 'deepseek-v4-flash',
  timeoutMs: 10_000,
};

/** Swap globalThis.fetch with a canned responder; the fn gets the captured (url, init). */
async function withFetchStub<T>(
  status: number,
  body: unknown,
  fn: (captured: { url: string; init: RequestInit }) => Promise<T>,
): Promise<T> {
  const captured: { url: string; init: RequestInit } = { url: '', init: {} };
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    captured.url = String(input);
    captured.init = init || {};
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      json: async () => body,
    } as any;
  }) as any;
  try {
    return await fn(captured);
  } finally {
    globalThis.fetch = original;
  }
}

suite('SessionSummaryFallback.buildChatCompletionsUrl', () => {
  test('plain base → /v1/chat/completions', () => {
    assert.strictEqual(
      buildChatCompletionsUrl('https://api.deepseek.com'),
      'https://api.deepseek.com/v1/chat/completions',
    );
  });

  test('trailing slash stripped', () => {
    assert.strictEqual(
      buildChatCompletionsUrl('https://api.deepseek.com/'),
      'https://api.deepseek.com/v1/chat/completions',
    );
  });

  test('base already ending in /v1 → no /v1/v1 duplication', () => {
    assert.strictEqual(
      buildChatCompletionsUrl('http://127.0.0.1:8000/v1'),
      'http://127.0.0.1:8000/v1/chat/completions',
    );
  });
});

suite('SessionSummaryFallback.buildFallbackMessages', () => {
  test('system prompt is first, tail messages follow in order', () => {
    const msgs = buildFallbackMessages('My Session', [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' },
    ]);
    assert.strictEqual(msgs.length, 3);
    assert.strictEqual(msgs[0].role, 'system');
    assert.ok(msgs[0].content.includes('"My Session"'));
    assert.strictEqual(msgs[1].role, 'user');
    assert.strictEqual(msgs[1].content, 'hi');
    assert.strictEqual(msgs[2].role, 'assistant');
  });

  test('session longer than cap → only the tail is kept', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ role: 'user' as const, content: 'm' + i }));
    const msgs = buildFallbackMessages('T', many);
    // 60 tail messages + system
    assert.strictEqual(msgs.length, 61);
    assert.strictEqual(msgs[1].content, 'm40');
    assert.strictEqual(msgs[60].content, 'm99');
  });

  test('unknown roles normalized to user', () => {
    const msgs = buildFallbackMessages('T', [{ role: 'system', content: 'injected' }]);
    assert.strictEqual(msgs[1].role, 'user');
    assert.strictEqual(msgs[1].content, 'injected');
  });

  test('overlong content truncated to tail window', () => {
    const msgs = buildFallbackMessages('T', [{ role: 'user', content: 'x'.repeat(20_000) }]);
    assert.strictEqual(msgs[1].content.length, 8000);
  });
});

suite('SessionSummaryFallback.parseChatCompletionsSummary', () => {
  test('extracts choices[0].message.content', () => {
    assert.strictEqual(
      parseChatCompletionsSummary({ choices: [{ message: { content: '  the summary  ' } }] }),
      'the summary',
    );
  });

  test('missing content → throws', () => {
    assert.throws(() => parseChatCompletionsSummary({ choices: [{ message: {} }] }));
    assert.throws(() => parseChatCompletionsSummary({ choices: [] }));
    assert.throws(() => parseChatCompletionsSummary({}));
  });

  test('empty string content → throws', () => {
    assert.throws(() => parseChatCompletionsSummary({ choices: [{ message: { content: '   ' } }] }));
  });
});

suite('SessionSummaryFallback.summarizeViaChatCompletions', () => {
  test('posts chat-completions request and returns the summary', async () => {
    const result = await withFetchStub(200, { choices: [{ message: { content: 'done' } }] }, async () =>
      summarizeViaChatCompletions('S', [{ role: 'user', content: 'q' }], SETTINGS),
    );
    assert.deepStrictEqual(result, { summary: 'done', model: 'deepseek-v4-flash' });
  });

  test('request shape: URL, bearer auth, model, and messages', async () => {
    await withFetchStub(200, { choices: [{ message: { content: 'ok' } }] }, async (cap) => {
      await summarizeViaChatCompletions('T', [{ role: 'user', content: 'hi' }], SETTINGS);
      assert.strictEqual(cap.url, 'https://api.deepseek.com/v1/chat/completions');
      assert.strictEqual((cap.init.headers as any).Authorization, 'Bearer sk-test');
      const body = JSON.parse(String(cap.init.body));
      assert.strictEqual(body.model, 'deepseek-v4-flash');
      assert.strictEqual(body.stream, false);
      assert.strictEqual(body.messages.length, 2);
      assert.strictEqual(body.messages[0].role, 'system');
    });
  });

  test('non-OK response → throws with status and body', async () => {
    await assert.rejects(
      withFetchStub(401, 'unauthorized', async () => {
        await summarizeViaChatCompletions('T', [{ role: 'user', content: 'hi' }], SETTINGS);
      }),
      /fallback HTTP 401/,
    );
  });

  test('malformed response → throws', async () => {
    await assert.rejects(
      withFetchStub(200, { foo: 1 }, async () => {
        await summarizeViaChatCompletions('T', [{ role: 'user', content: 'hi' }], SETTINGS);
      }),
      /no choices\[0\]\.message\.content/,
    );
  });
});

import * as assert from 'assert';
import { describeSttSource, extractEmbeddedError, isTransientSttError } from '../voice/SttClient';

/**
 * The EricAI/Ray backend answers `HTTP 200` with
 * `{"error":{"message":"...DeploymentUnavailableError...","code":500}}` and no
 * `text` when the Whisper deployment is scaled down. Reading that as an empty
 * transcript blamed the microphone for a backend outage — the takes were fine
 * (peak 99 %, speech-like spectrum) while the model was simply not running.
 * These tests pin the detection so the misdiagnosis cannot come back.
 */
suite('SttClient error surfacing', () => {
  test('detects the Ray DeploymentUnavailableError carried in a 200 body', () => {
    const body = {
      generated_text: null,
      text: undefined,
      error: {
        message:
          "ray.serve.exceptions.DeploymentUnavailableError: Deployment(name='VLLMOpenAI3Deployment:openai--whisper-large-v3-turbo')",
        code: 500,
        type: 'DeploymentUnavailableError',
      },
    };
    const err = extractEmbeddedError(body);
    assert.ok(err, 'error object must be detected');
    assert.strictEqual(err?.code, 500);
    assert.ok(/DeploymentUnavailableError/.test(err!.message));
    // …and it must be classified as worth retrying: Ray brings the deployment
    // back on demand, which is a wait, not a failure.
    assert.strictEqual(isTransientSttError(err!.message), true);
  });

  test('accepts a plain-string error field', () => {
    assert.strictEqual(extractEmbeddedError({ error: 'model is loading' })?.message, 'model is loading');
  });

  test('falls back to the type when no message is present', () => {
    assert.strictEqual(extractEmbeddedError({ error: { type: 'ServiceUnavailable' } })?.message, 'ServiceUnavailable');
  });

  test('a successful transcription body is not treated as an error', () => {
    assert.strictEqual(extractEmbeddedError({ text: 'hello world' }), null);
    assert.strictEqual(extractEmbeddedError({ text: 'x', error: null }), null);
    assert.strictEqual(extractEmbeddedError(null), null);
    assert.strictEqual(extractEmbeddedError('nonsense'), null);
  });

  test('transient classification covers waits but not real failures', () => {
    for (const m of [
      'DeploymentUnavailableError',
      'Service Unavailable',
      'HTTP 503',
      'upstream 502 bad gateway',
      'socket hang up',
      'ECONNRESET',
    ]) {
      assert.strictEqual(isTransientSttError(m), true, m);
    }
    for (const m of [
      'Voice input: STT returned an empty transcript (silence or unrecognized speech).',
      'HTTP 401 unauthorized',
      'model not found',
    ]) {
      assert.strictEqual(isTransientSttError(m), false, m);
    }
  });

  test('names which model produced the transcript', () => {
    // ericai-proxy stamps this header only when its local whisper.cpp fallback
    // answered; without it the shared Ray cluster did the work. Latency alone
    // (0.1-0.3s cluster vs ~3s local) should not be what the user has to infer.
    assert.strictEqual(describeSttSource('local-whisper-cpp'), 'local whisper.cpp');
    assert.strictEqual(describeSttSource(null), 'shared cluster');
    // An unknown source is passed through rather than mislabelled.
    assert.strictEqual(describeSttSource('some-other-gateway'), 'some-other-gateway');
  });
});

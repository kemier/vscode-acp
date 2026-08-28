import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { decodeTemplate } from './templateDecode';

/**
 * Regression test for the codex-acp internal retry-boundary handling:
 *
 * codex-acp retries transient failures (upstream 503 "model at capacity", or
 * a transport-level stream disconnect) silently INSIDE prompt() — the
 * extension host / webview see no second promptStart. codex-acp emits a
 * one-line "… — retrying with backoff" agent_message_chunk at the start of
 * attempt #2. Without handling, the webview fuses that notice + the failed
 * attempt's abandoned partial reply into the current bubble, and attempt #2's
 * fresh reply renders as a SECOND assistant message after what looked like an
 * end_turn.
 *
 * The webview logic lives inside the ChatWebviewProvider template literal, so
 * we extract the decision fragments from source (same technique as
 * webviewScriptParse.test.ts / fallbackMessageId.test.ts).
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

function extractRetryBoundaryFragment(): string {
  const src = fs.readFileSync(SOURCE, 'utf8').replace(/\r\n/g, '\n');
  const sig = 'function isRetryBoundaryNotice(text) {';
  const startIdx = src.indexOf(sig);
  assert.ok(startIdx >= 0, 'isRetryBoundaryNotice not found in ChatWebviewProvider.ts');
  const after = src.slice(startIdx);
  const endIdx = after.indexOf('\n    }\n');
  assert.ok(endIdx > 0, 'end of isRetryBoundaryNotice not found');
  // `'\n    }\n'` is 6 chars (`}` sits at offset 5); slice up to AND including
  // the closing brace of isRetryBoundaryNotice.
  return after.slice(0, endIdx + 6);
}

function loadRetryBoundaryCheck(): (text: string) => boolean {
  // Decode the template-literal escapes first: the fragment is raw template
  // text, and the browser only ever sees the collapsed form.
  const factory = new Function(
    `
      ${decodeTemplate(extractRetryBoundaryFragment())}
      return isRetryBoundaryNotice;
    `,
  );
  return factory() as (text: string) => boolean;
}

suite('retryBoundaryNotice', () => {
  test('extracts the retry boundary predicate from ChatWebviewProvider source', () => {
    const fn = loadRetryBoundaryCheck();
    assert.strictEqual(typeof fn, 'function');
  });

  test('recognizes codex-acp "model at capacity" retry notices', () => {
    const fn = loadRetryBoundaryCheck();
    assert.strictEqual(fn('The model is at capacity — retrying with backoff (attempt 1/5).'), true);
    assert.strictEqual(fn('The model is at capacity — retrying with backoff (attempt 2/5).'), true);
    assert.strictEqual(fn('The model is at capacity — retrying with backoff…'), true);
  });

  test('recognizes codex-acp "connection dropped" retry notices', () => {
    const fn = loadRetryBoundaryCheck();
    assert.strictEqual(fn('The connection dropped mid-stream — retrying with backoff (attempt 1/5).'), true);
    assert.strictEqual(fn('The connection dropped mid-stream — retrying with backoff…'), true);
  });

  test('rejects normal assistant replies that merely quote the phrase', () => {
    const fn = loadRetryBoundaryCheck();
    assert.strictEqual(fn('I noticed the connection dropped mid-stream, but it is fine now.'), false);
    assert.strictEqual(fn('You can retry with backoff if it fails.'), false);
    assert.strictEqual(fn('The model is at capacity, so I will retry shortly.'), false);
    assert.strictEqual(fn(''), false);
    assert.strictEqual(fn(null as unknown as string), false);
  });

  test('rejects unrelated notices and non-retry text', () => {
    const fn = loadRetryBoundaryCheck();
    assert.strictEqual(fn('*Context compacted to fit the model context window.*'), false);
    assert.strictEqual(fn('Warning: Heads up! Something notable happened.'), false);
    assert.strictEqual(fn('— Conversation interrupted —'), false);
  });
});

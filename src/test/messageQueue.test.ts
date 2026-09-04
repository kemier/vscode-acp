import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Tests for the webview message-queue decision helpers.
 *
 * The queue logic lives inside ChatWebviewProvider's single HTML template
 * literal and cannot be imported. Following the established pattern from
 * foldOrdering.test.ts / cleanUserMessage.test.ts, we extract the REAL
 * functions verbatim from the source so they can never drift from production.
 *
 * Requirements under test (see docs/QUEUE-BEHAVIOR.md):
 *   1. Every message typed while a turn is processing is queued — it is never
 *      steered mid-turn and never dropped.
 *   2. Queued messages drain strictly FIFO, ONE per agent turn.
 *   3. In the transition tick (sendPrompt posted, promptStart not yet
 *      received) a new message is queued, never sent concurrently.
 *   4. Local slash commands that do not start a turn (/rename, /ps, /stop,
 *      /session) chain the NEXT queued message immediately; commands that do
 *      start a turn (/compact, /clear) make the next message wait.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

/**
 * The queue helpers live inside ChatWebviewProvider's single HTML template
 * literal, so the SHIPPED script is not the raw .ts text: the template literal
 * processes escape sequences at runtime (`\\/` becomes `/`, `\\n` newline,
 * etc.). Evaluating the raw source would silently diverge from production —
 * a single-backslash regex like `/^\/(compact...)/` reads fine in raw .ts but
 * collapses to `/^/(compact...)/` in the emitted webview and crashes it with
 * 'Invalid or unexpected token'.
 *
 * To test what ACTUALLY runs, unescape a double backslash to a single one,
 * mimicking the template literal's escape processing. Plain text and regex
 * character classes without escapes are unaffected, so this is exact for the
 * two helpers under test. This unescaping is a deliberate mirror of the
 * runtime behaviour, NOT a general regex-altering transform — the regex in
 * this source block stays the same shape as the source file's array of
 * slash-commands.
 */
function asRenderedWebview(srcText: string): string {
  return srcText.replace(/\\\\/g, '\\');
}

function extractFunction(name: string): (...args: any[]) => any {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const startIdx = src.indexOf('function ' + name + '(');
  assert.ok(startIdx >= 0, name + ' not found in ChatWebviewProvider.ts');
  const bodyStart = src.indexOf('{', startIdx);
  let depth = 1;
  let i = bodyStart + 1;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === '{') {
      depth++;
    } else if (src[i] === '}') {
      depth--;
    }
  }
  const fnSrc = src.slice(startIdx, i);
  return new Function('return (' + asRenderedWebview(fnSrc) + ')')() as (...args: any[]) => any;
}

suite('webview template-literal escape parity', () => {
  test('queue helpers render to valid JavaScript under template-literal unescaping', () => {
    // The helpers live in a template literal: the webview executes the
    // ESCAPE-PROCESSED text, not the raw .ts. A single-backslash regex in the
    // source (e.g. /^\/clear\b/) collapses to /^/clear b/ in the emitted
    // script and crashes the whole webview with 'Invalid or unexpected token'.
    // This test proves the fix: after doubling every backslash, the rendered
    // form is parseable and behaves identically.
    const src = fs.readFileSync(SOURCE, 'utf8');
    for (const name of ['queueIsMutatingCommand', 'queueDrainStartedTurn', 'agentSupportsSteering']) {
      const startIdx = src.indexOf('function ' + name + '(');
      assert.ok(startIdx >= 0, name + ' not found in ChatWebviewProvider.ts');
      const bodyStart = src.indexOf('{', startIdx);
      let depth = 1;
      let i = bodyStart + 1;
      for (; i < src.length && depth > 0; i++) {
        if (src[i] === '{') {
          depth++;
        } else if (src[i] === '}') {
          depth--;
        }
      }
      const fnSrc = src.slice(startIdx, i);
      const rendered = asRenderedWebview(fnSrc);
      assert.doesNotThrow(
        () => new Function('return (' + rendered + ')'),
        `${name} must render to valid JS inside the webview template literal`,
      );
    }
  });
});

suite('messageQueue.queueIsMutatingCommand', () => {
  const queueIsMutatingCommand = extractFunction('queueIsMutatingCommand');

  test('compaction commands are mutating', () => {
    assert.strictEqual(queueIsMutatingCommand('/compact'), true);
    assert.strictEqual(queueIsMutatingCommand('/summarize'), true);
    assert.strictEqual(queueIsMutatingCommand('/compress now'), true);
    assert.strictEqual(queueIsMutatingCommand('/COMPACT'), true);
  });

  test('/clear is mutating', () => {
    assert.strictEqual(queueIsMutatingCommand('/clear'), true);
  });

  test('/index build variants are mutating', () => {
    assert.strictEqual(queueIsMutatingCommand('/index build'), true);
    assert.strictEqual(queueIsMutatingCommand('/index rebuild foo'), true);
    assert.strictEqual(queueIsMutatingCommand('/index refresh'), true);
    assert.strictEqual(queueIsMutatingCommand('/index update'), true);
    assert.strictEqual(queueIsMutatingCommand('/index embed'), true);
    assert.strictEqual(queueIsMutatingCommand('/index clear'), true);
    assert.strictEqual(queueIsMutatingCommand('/index delete'), true);
  });

  test('read-only and ordinary messages are NOT mutating', () => {
    assert.strictEqual(queueIsMutatingCommand('/ps'), false);
    assert.strictEqual(queueIsMutatingCommand('/status'), false);
    assert.strictEqual(queueIsMutatingCommand('/rename foo'), false);
    assert.strictEqual(queueIsMutatingCommand('/session old'), false);
    assert.strictEqual(queueIsMutatingCommand('/stop'), false);
    assert.strictEqual(queueIsMutatingCommand('fix the bug'), false);
    // A mutation word mid-sentence is not a command.
    assert.strictEqual(queueIsMutatingCommand('please clear the cache'), false);
  });
});

suite('messageQueue.queueDrainStartedTurn', () => {
  const queueDrainStartedTurn = extractFunction('queueDrainStartedTurn');

  test('a drained message sent as a prompt starts a turn', () => {
    assert.strictEqual(queueDrainStartedTurn(false, false, false), true);
  });

  test('a local slash command that set isProcessing starts a turn', () => {
    assert.strictEqual(queueDrainStartedTurn(true, true, true), true);
  });

  test('a local slash command that stayed idle does NOT start a turn', () => {
    assert.strictEqual(queueDrainStartedTurn(true, false, false), false);
  });

  test('defensive: anything still processing counts as a started turn', () => {
    assert.strictEqual(queueDrainStartedTurn(true, false, true), true);
  });
});

suite('messageQueue.agentSupportsSteering', () => {
  const agentSupportsSteering = extractFunction('agentSupportsSteering');

  test('Option B: every agent is deferred-queue (steering disabled)', () => {
    // Option B disables mid-turn steering for ALL agents via agentSupportsSteering.
    // Mid-turn messages are queued FIFO and drained after the current turn's
    // promptEnd (auto-steer uses a separate gate).
    assert.strictEqual(agentSupportsSteering('Codex CLI'), false);
    assert.strictEqual(agentSupportsSteering('codex-acp'), false);
    assert.strictEqual(agentSupportsSteering('claude-code'), false);
    assert.strictEqual(agentSupportsSteering('Kiro'), false);
    assert.strictEqual(agentSupportsSteering(''), false);
    assert.strictEqual(agentSupportsSteering(undefined), false);
  });
});

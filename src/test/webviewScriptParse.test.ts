import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { decodeTemplate } from './templateDecode';

/**
 * Regression guard for webview script parse breaks.
 *
 * The chat webview script lives inside an HTML template literal in
 * ChatWebviewProvider.ts. Template literals collapse escapes, so a regex or
 * string that looks fine in the raw .ts (e.g. lastIndexOf('\\')) can emit
 * invalid JS ('\') that kills the entire script with "Invalid or unexpected
 * token" — the panel renders static HTML forever and nothing (resume, send,
 * welcome buttons) responds.
 *
 * This test simulates the template-literal escape processing and parses the
 * emitted script, catching that class of bug. It is NOT a full simulation
 * (${...} interpolations are replaced with ""), but escape-collapse errors
 * are the failure mode we guard against.
 */

const PROVIDER = path.join(__dirname, '..', '..', 'src', 'ui', 'ChatWebviewProvider.ts');

/** Extract the webview <script> body from the provider's HTML template literal. */
function extractWebviewScript(source: string): string {
  const htmlStart = source.indexOf('<!DOCTYPE html>');
  const htmlEnd = source.lastIndexOf('</html>');
  assert.ok(htmlStart >= 0 && htmlEnd > htmlStart, 'html template not found');
  const html = source.slice(htmlStart, htmlEnd + '</html>'.length);
  const scriptStart = html.indexOf('<script nonce=');
  const tagEnd = html.indexOf('>', scriptStart);
  const scriptEnd = html.lastIndexOf('</script>');
  assert.ok(scriptStart >= 0 && scriptEnd > tagEnd, 'webview script tag not found');
  return html.slice(tagEnd + 1, scriptEnd);
}

suite('webviewScriptParse', () => {
  test('emitted webview script parses after template-literal escape collapse', () => {
    const source = fs.readFileSync(PROVIDER, 'utf8');
    const emitted = decodeTemplate(extractWebviewScript(source));
    // new Function parses without executing — exactly the failure mode the
    // browser hits ("Uncaught SyntaxError: Invalid or unexpected token").
    assert.doesNotThrow(() => new Function(emitted), 'emitted webview script must parse');
  });

  test('EricCLI image support helper gates vision models by name', () => {
    const source = fs.readFileSync(PROVIDER, 'utf8');
    const emitted = decodeTemplate(extractWebviewScript(source));
    // Pull the helper function declaration out of the emitted script and eval
    // just that fragment (the full script needs browser globals like
    // acquireVsCodeApi/window that don't exist under node). This still runs
    // through the template-literal-uneseaped text, so it guards the escape
    // collapse AND the regex semantics in one assertion.
    const match = emitted.match(/function ericliModelSupportsImage\([^)]*\)\s*\{[^}]*\}/);
    assert.ok(match, 'ericliModelSupportsImage function must exist in the emitted webview script');
    const helper = new Function(`return (${match[0]});`)();
    assert.strictEqual(typeof helper, 'function', 'ericliModelSupportsImage must be a function');
    assert.strictEqual(helper('kimi-k2.6'), true, 'kimi-k2.6 is vision-capable');
    assert.strictEqual(helper('kimi-k2.7-code'), true, 'kimi-k2.7-code is vision-capable');
    assert.strictEqual(helper('Qwen3.8-27B'), true, 'Qwen3.8-27B is vision-capable');
    assert.strictEqual(helper('qwen3.6-35b'), true, 'qwen3.6-35b is vision-capable');
    assert.strictEqual(helper('gemma-4-31B-it'), true, 'gemma-4-31B-it is vision-capable');
    assert.strictEqual(helper('glm-5.2'), false, 'glm-5.2 is text-only');
    assert.strictEqual(helper('deepseek-v4-flash'), false, 'deepseek-v4-flash is text-only');
    assert.strictEqual(helper('Qwen3-Coder-480B'), false, 'Qwen3-Coder-480B is text-only');
    assert.strictEqual(helper('gpt-oss-42m-v2'), false, 'gpt-oss is text-only');
  });

  test('isSessionInterruptNotice only matches real interrupt notices', () => {
    // Regression: the notice regex was written /^\[Request interrupted by user\]/i
    // with SINGLE backslashes inside the HTML template literal. The template
    // collapsed \[ -> [ and \] -> ], turning the escaped brackets into a
    // character CLASS: /^[Request interrupted by user]/i. That matches any text
    // whose first character is one of " BDEINPQRSTUYbdeinpqrstuy" — so during
    // session/load replay, ordinary prompts like "then implement C" or
    // "backport" were classified as interrupt notices, pushed into chatHistory
    // as hidden notice rows instead of rendered user bubbles, and excluded from
    // countRealUserMessages. Result: the last user messages vanished on resume.
    const source = fs.readFileSync(PROVIDER, 'utf8');
    const emitted = decodeTemplate(extractWebviewScript(source));
    const match = emitted.match(/function isSessionInterruptNotice\([^)]*\)\s*\{[^}]*\}/);
    assert.ok(match, 'isSessionInterruptNotice must exist in the emitted webview script');
    const isNotice = new Function(`return (${match[0]});`)() as (t: string) => boolean;

    // Real notices still detected.
    assert.strictEqual(isNotice('[Request interrupted by user]'), true);
    assert.strictEqual(isNotice('[Request interrupted by user] for tool use'), true);
    assert.strictEqual(isNotice('Request interrupted by user'), true);
    assert.strictEqual(isNotice('Request interrupted by user.'), true);
    assert.strictEqual(isNotice('— Conversation interrupted —'), true);

    // Ordinary prompts must NOT be swallowed. Each of these starts with a
    // character that the collapsed character class matched.
    for (const prompt of [
      'then implement C',
      'backport',
      'These are memory-injected skills (metadata only)',
      'debug this please',
      'is the build green?',
      'run the tests',
      'update the docs',
      'no, use the other branch',
      'yes',
      'push it',
      'Explain the diff',
      ' leading space prompt',
    ]) {
      assert.strictEqual(isNotice(prompt), false, `must not classify as interrupt notice: ${prompt}`);
    }
    assert.strictEqual(isNotice(''), false);
  });

  test('webview template literal has no collapsed single-backslash regex escapes', () => {
    // Generic guard for the whole defect class. Inside the HTML template
    // literal every regex/string escape must be written with DOUBLE
    // backslashes (\\s, \\[, \\.) — a single backslash before a
    // regex-meaningful character is silently eaten and changes the pattern's
    // meaning without any syntax error.
    const source = fs.readFileSync(PROVIDER, 'utf8');
    const raw = extractWebviewScript(source);
    const suspicious = /(^|[^\\])\\([[\].+*?(){}|/sSdDwWbBAZ-])/;
    const offenders: string[] = [];
    raw.split('\n').forEach((line, idx) => {
      const m = suspicious.exec(line);
      if (!m) {
        return;
      }
      // Ignore matches that live inside a line comment.
      const commentAt = line.indexOf('//');
      if (commentAt >= 0 && (m.index ?? 0) >= commentAt) {
        return;
      }
      offenders.push(`${idx + 1}: ${line.trim()}`);
    });
    assert.deepStrictEqual(
      offenders,
      [],
      `single-backslash escapes inside the webview template literal (must be doubled):\n${offenders.join('\n')}`,
    );
  });

  test('inbound message switch handles host-initiated sendPrompt (fork-to-agent)', () => {
    // Regression: dispatchPrompt() (host -> webview) posts { type:
    // 'sendPrompt', text } to forward the fork-to-agent export, but the
    // webview's inbound switch had no 'sendPrompt' case, so every fork
    // export was silently dropped (no user bubble, no session/prompt) —
    // the user saw "Forked conversation…" but the target agent received
    // nothing. The 'sendPrompt' case must exist in the INBOUND
    // (window 'message') handler — not just the outbound vscode.postMessage
    // sites, which are indistinguishable from a naive string search.
    const source = fs.readFileSync(PROVIDER, 'utf8');
    const emitted = decodeTemplate(extractWebviewScript(source));
    // Isolate the inbound handler switch (starts at "switch (msg.type)")
    // and require a 'sendPrompt' case inside it.
    const switchIdx = emitted.indexOf('switch (msg.type)');
    assert.ok(switchIdx >= 0, 'inbound message switch must exist');
    // The case block: case 'sendPrompt': ... break; — search a bounded
    // region of the switch (it is long; the case must appear before the
    // handler's closing brace).
    const region = emitted.slice(switchIdx, switchIdx + 60000);
    const hasInboundCase = /case\s+'sendPrompt'[^]*?\bhandleSend\(\)/.test(region);
    assert.ok(
      hasInboundCase,
      'inbound switch must route sendPrompt through handleSend() (fork-to-agent was silently dropped without it)',
    );
  });
});

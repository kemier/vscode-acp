import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

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

/** Simulate untagged template literal escape processing on the raw template content. */
function decodeTemplate(raw: string): string {
  let out = '';
  let i = 0;
  const escapes: Record<string, string> = {
    n: '\n',
    t: '\t',
    r: '\r',
    b: '\b',
    f: '\f',
    v: '\v',
    '0': '\0',
  };
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '$' && raw[i + 1] === '{') {
      // Interpolation: skip balanced braces, emit a placeholder expression.
      let depth = 1;
      i += 2;
      while (depth > 0 && i < raw.length) {
        if (raw[i] === '{') {
          depth++;
        } else if (raw[i] === '}') {
          depth--;
        }
        i++;
      }
      out += '""';
      continue;
    }
    if (ch === '\\') {
      const nx = raw[i + 1];
      if (nx === 'u') {
        out += '"x"';
        i += 2;
        if (raw[i] === '{') {
          while (i < raw.length && raw[i] !== '}') {
            i++;
          }
          i++;
        } else {
          i += 4;
        }
        continue;
      }
      if (nx === 'x') {
        out += '"x"';
        i += 6;
        continue;
      }
      if (nx === '`' || nx === '$') {
        out += nx;
        i += 2;
        continue;
      }
      if (nx === '\n') {
        out += '\n';
        i += 2;
        continue;
      }
      if (escapes[nx] !== undefined) {
        out += escapes[nx];
        i += 2;
        continue;
      }
      // Unrecognized escape: backslash is dropped (e.g. \/ -> /). This is the
      // collapse that breaks regex/string literals written with single backslashes.
      out += nx;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

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
      'inbound switch must route sendPrompt through handleSend() (fork-to-agent was silently dropped without it)'
    );
  });
});

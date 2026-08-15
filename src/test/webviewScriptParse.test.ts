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
});

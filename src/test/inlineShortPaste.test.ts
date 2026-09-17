import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { INLINE_PASTE_MAX_CHARS } from '../ui/ChatWebviewProvider';

/**
 * A short paste belongs where the caret is, not in a pill.
 *
 * Every text paste was converted into a `@clipboard` attachment. Typing
 *
 *   i click + button to spawn new session while it is streaming, but the '' msg …
 *
 * and pasting between the quotes lifted the pasted words out into a
 * [Clipboard: 2 lines] pill, leaving '' empty. The pasted text was
 * "ACP connection closed" — 21 characters, nothing that needs an attachment.
 *
 * The conversion exists so a large blob is not dumped into the composer twice
 * (raw text AND a clipboard block). That reasoning does not apply to a short
 * snippet, so size and shape now decide. Caret context was deliberately NOT
 * used: the caret's surroundings are invisible to the user and would make the
 * same paste behave differently in unpredictable ways.
 *
 * This EXECUTES the helper as the webview will see it — extracted from the
 * template literal with the escapes collapsed the way the literal collapses
 * them. That matters: the newline test is written `\\n` in the .ts so the
 * emitted JS contains `\n`, and getting that wrong would silently make the
 * check match a literal backslash-n instead of a newline.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

function loadIsPayloadSizedPaste(): (text: string) => boolean {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const sig = 'function isPayloadSizedPaste(text) {';
  const at = src.indexOf(sig);
  assert.ok(at > 0, 'isPayloadSizedPaste not found in the webview literal');
  const open = src.indexOf('{', at);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  assert.ok(end > 0, 'could not brace-match isPayloadSizedPaste');
  let body = src.slice(at, end);
  // The webview lives in a template literal: collapse `\\` to `\` and expand the
  // ${...} interpolation, exactly as the literal does when the HTML is built.
  body = body
    .replace(/\\\\/g, '\\')
    .replace('${INLINE_PASTE_MAX_CHARS}', String(INLINE_PASTE_MAX_CHARS));
  assert.ok(
    !body.includes('${'),
    `unresolved interpolation in the extracted helper: ${body}`,
  );
  // eslint-disable-next-line no-new-func
  return new Function('text', `${body}\nreturn isPayloadSizedPaste(text);`) as (t: string) => boolean;
}

suite('short pastes stay inline', () => {
  const isPayload = loadIsPayloadSizedPaste();

  test('the reported paste is treated as prose, not a payload', () => {
    // Exactly what was on the clipboard, trailing newlines included.
    assert.strictEqual(isPayload('ACP connection closed\r\n\n'), false);
  });

  test('a trailing newline does not make a one-line copy multi-line', () => {
    // Copying a line almost always carries its newline; that must not decide it.
    for (const t of ['hello\n', 'hello\r\n', '  hello  \n\n', 'hello']) {
      assert.strictEqual(isPayload(t), false, `should be inline: ${JSON.stringify(t)}`);
    }
  });

  test('genuinely multi-line text is still attached', () => {
    for (const t of [
      'line one\nline two',
      'function f() {\n  return 1;\n}',
      'a\n\nb',
    ]) {
      assert.strictEqual(isPayload(t), true, `should attach: ${JSON.stringify(t)}`);
    }
  });

  test('a long single line is still attached', () => {
    const long = 'x'.repeat(INLINE_PASTE_MAX_CHARS + 1);
    assert.strictEqual(isPayload(long), true);
  });

  test('the threshold boundary is inclusive of inline', () => {
    assert.strictEqual(isPayload('x'.repeat(INLINE_PASTE_MAX_CHARS)), false);
    assert.strictEqual(isPayload('x'.repeat(INLINE_PASTE_MAX_CHARS + 1)), true);
  });

  test('empty or whitespace-only text is neither', () => {
    // The caller already rejects these; the helper must not claim them.
    for (const t of ['', '   ', '\n\n', null as unknown as string]) {
      assert.strictEqual(isPayload(t), false, `should be false: ${JSON.stringify(t)}`);
    }
  });

  test('the newline check survives template-literal escaping', () => {
    // If `\\n` in the .ts were written `\n` (or `\\\\n`), the emitted regex/string
    // would test for the wrong thing and multi-line pastes would stop attaching.
    // A literal backslash-n is NOT a newline and must stay inline.
    assert.strictEqual(isPayload('no real newline here: \\n'), false);
    assert.strictEqual(isPayload('real\nnewline'), true);
  });
});

suite('the paste handler consults the size gate', () => {
  const src = fs.readFileSync(SOURCE, 'utf8');

  test('conversion is gated, and preventDefault sits inside the gate', () => {
    const at = src.indexOf("const text = e.clipboardData && e.clipboardData.getData('text/plain');");
    assert.ok(at > 0, 'paste handler not found');
    const body = src.slice(at, at + 500);
    assert.ok(body.includes('isPayloadSizedPaste(text)'), 'paste handler does not consult the size gate');
    // Falling through without preventDefault is what lets the browser insert the
    // text at the caret — the whole point of the fix.
    const gateAt = body.indexOf('isPayloadSizedPaste(text)');
    const preventAt = body.indexOf('e.preventDefault()');
    assert.ok(preventAt > gateAt, 'preventDefault must be inside the gated branch');
  });
});

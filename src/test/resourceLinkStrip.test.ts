import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Regression test for resource_link JSON leaking into the user bubble.
 *
 * Kiro prepends its file attachments to the prompt as JSON-stringified
 * ContentBlocks, concatenated with no separator:
 *
 *   {"name":"foo.ts","uri":"file:///abs/foo.ts","type":"resource_link"}
 *
 * cleanUserMessage stripped those, but only from the FRONT of the string and
 * only BEFORE the <context> / <agent-memory> tag strips. The real layout puts
 * the memory blob first, then the links, then the typed text — so the scan saw
 * a leading '<', bailed on the first character, and the raw JSON survived into
 * the bubble on every session/load replay. Stripping now runs again after the
 * tag strips, which is when those links become leading.
 *
 * Like foldOrdering.test.ts and unansweredPrompts.test.ts, this extracts the
 * REAL stripLeadingResourceLinkJson() from the webview template literal rather
 * than reimplementing it.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

function loadStripper(): (text: string) => string {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const startIdx = src.indexOf('function stripLeadingResourceLinkJson(text) {');
  assert.ok(startIdx >= 0, 'stripLeadingResourceLinkJson not found');
  const endMarker = 'function cleanUserMessage(rawText) {';
  const endIdx = src.indexOf(endMarker, startIdx);
  assert.ok(endIdx > startIdx, 'end marker not found');
  const body = src.slice(startIdx, endIdx).replace(/\\\\/g, '\\');
   
  return new Function(body + '\nreturn stripLeadingResourceLinkJson;')() as (t: string) => string;
}

const link = (name: string, uri: string) =>
  JSON.stringify({ name, uri, type: 'resource_link' });

suite('stripLeadingResourceLinkJson', () => {
  const strip = loadStripper();

  test('strips a single leading link', () => {
    const text = link('foo.ts', 'file:///abs/foo.ts') + 'hello';
    assert.strictEqual(strip(text), 'hello');
  });

  test('strips a run of concatenated links', () => {
    const text =
      link('a', 'file:///a') + link('b', 'file:///b') + link('c', 'file:///c') + 'real text';
    assert.strictEqual(strip(text), 'real text');
  });

  test('strips the malformed fragment names seen in the wild', () => {
    // These come from backtick-ish fragments being resolved against the
    // workspace root: `/  ,  `,  path`  ...`)
    const text =
      link('path`', 'file:///workspace/git/ezennin/vscode-acp/path%60') +
      link('`,', 'file:///workspace/git/ezennin/vscode-acp/%60%2C') +
      link('...`)', 'file:///workspace/git/ezennin/vscode-acp/...%60%29') +
      link('`', 'file:///workspace/git/ezennin/vscode-acp/%60') +
      link('`/', 'file:///workspace/git/ezennin/vscode-acp/%60/') +
      'strip this in vscode-acp after resume';
    assert.strictEqual(strip(text), 'strip this in vscode-acp after resume');
  });

  test('handles a name containing a closing brace', () => {
    const text = link('weird}name', 'file:///abs/w') + 'after';
    assert.strictEqual(strip(text), 'after');
  });

  test('tolerates whitespace between links', () => {
    const text = '  ' + link('a', 'file:///a') + '\n ' + link('b', 'file:///b') + ' tail';
    assert.strictEqual(strip(text), ' tail');
  });

  test('leaves a non-resource_link JSON object alone', () => {
    const text = JSON.stringify({ type: 'text', text: 'hi' }) + 'rest';
    assert.strictEqual(strip(text), text, 'only resource_link blocks are consumed');
  });

  test('leaves plain text and tag-led text untouched', () => {
    assert.strictEqual(strip('just a message'), 'just a message');
    assert.strictEqual(strip('<agent-memory>x</agent-memory>hi'), '<agent-memory>x</agent-memory>hi');
  });

  test('handles empty and nullish input', () => {
    assert.strictEqual(strip(''), '');
    assert.strictEqual(strip(undefined as unknown as string), '');
    assert.strictEqual(strip(null as unknown as string), '');
  });

  test('does not hang on an unterminated object', () => {
    const text = '{"name":"a","uri":"file:///a","type":"resource_link"';
    assert.strictEqual(strip(text), text, 'no closing brace: left as-is');
  });
});

/**
 * The stripper alone was not enough. Both render paths fall back to the RAW
 * text when cleanUserMessage() empties a message, so that a session/load prompt
 * is never silently dropped:
 *
 *   if (rawFallback && !isSessionInterruptNotice(...) && !isMachineContextOnly(...))
 *     cleanedNew = rawFallback;
 *
 * session/load replays each stored content block as its OWN user_message_chunk,
 * so an attachment arrives alone as a single resource_link JSON object.
 * cleanUserMessage stripped it to empty, then this fallback put it straight
 * back — the ACP log showed exactly that: "UMC chunk: len=96" followed by
 * "UMC load-turn: len=96". isMachineContextOnly now recognises the shape.
 */
function loadIsMachineContextOnly(): (text: string) => boolean {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const grab = (name: string, endMarker: string) => {
    const s = src.indexOf('function ' + name + '(');
    assert.ok(s >= 0, name + ' not found');
    const e = src.indexOf(endMarker, s);
    assert.ok(e > s, 'end marker for ' + name + ' not found');
    return src.slice(s, e).replace(/\\\\/g, '\\');
  };
  const predicate = grab('isMachineContextOnly', '/**\n    * Truncate a session title');
  const stripper = grab('stripLeadingResourceLinkJson', 'function cleanUserMessage(rawText) {');
   
  return new Function(
    stripper + '\n' + predicate + '\nreturn isMachineContextOnly;',
  )() as (t: string) => boolean;
}

suite('isMachineContextOnly', () => {
  const isMachineOnly = loadIsMachineContextOnly();

  test('treats a lone resource_link chunk as machine context', () => {
    assert.strictEqual(isMachineOnly(link('path`', 'file:///workspace/git/ezennin/vscode-acp/path%60')), true);
  });

  test('treats a run of resource_link chunks as machine context', () => {
    assert.strictEqual(isMachineOnly(link('a', 'file:///a') + link('b', 'file:///b')), true);
  });

  test('still treats a closed memory block as machine context', () => {
    assert.strictEqual(isMachineOnly('<agent-memory>blob</agent-memory>'), true);
  });

  test('does NOT treat a real prompt as machine context', () => {
    assert.strictEqual(isMachineOnly('check acp log'), false);
  });

  test('does NOT treat a link followed by real text as machine-only', () => {
    // cleanUserMessage would keep the real text here, so the fallback must not
    // suppress the message.
    assert.strictEqual(isMachineOnly(link('a', 'file:///a') + 'real question'), false);
  });

  test('blank input counts as machine context (nothing to show)', () => {
    assert.strictEqual(isMachineOnly(''), true);
    assert.strictEqual(isMachineOnly('   \n'), true);
  });
});

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { decodeTemplate } from './templateDecode';

/**
 * Pasting must produce a mention the host will actually resolve.
 *
 * Reported: typing "check those testcases in this folder:" and then pasting produced
 * "check those testcases in this folder:@clipboard". The composer showed the mention,
 * so it looked attached — but NOTHING was attached. The bare mention went to the agent,
 * which then tried to find a clipboard file over the shell (cat /tmp/ericli_clipboard*,
 * find ~/.cli-4-ericai -name '*clipboard*') and failed.
 *
 * The cause is a contradiction between two halves of the feature. hasLeadingClipboardMention
 * only attaches when the text before the mention is empty or ends in a newline —
 * mid-sentence "@clipboard" is deliberately prose, so asking a question *about* the
 * feature cannot hijack the clipboard. But the paste handler inserted the mention at
 * the caret, which is usually mid-line. So the half that inserts the mention could
 * place it where the half that resolves it refuses to look.
 *
 * A paste is an unambiguous request to attach, so the insertion now guarantees a line
 * start. The prose rule is untouched.
 */
const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

/** The REAL host rule, so this cannot drift from what actually decides. */
function loadHostRule(): (t: string) => boolean {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const at = src.indexOf('function hasLeadingClipboardMention(t: string): boolean {');
  assert.ok(at > 0, 'host hasLeadingClipboardMention not found');
  const body = src.slice(at, src.indexOf('\n    }', at) + 6);
  // Strip the TS annotations so it can be evaluated as plain JS.
  const js = body
    .replace('(t: string): boolean', '(t)')
    .replace(/let m: RegExpExecArray \| null;/, 'let m;')
    .replace(/const src = String\(t \|\| ''\);/, "const src = String(t || '');");
  return new Function(js + '\nreturn hasLeadingClipboardMention;')() as (t: string) => boolean;
}

/** Replay the webview's paste insertion for a given caret position. */
function pasteAt(value: string, caret: number): string {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const at = src.indexOf('var needsNewline =');
  assert.ok(at > 0, 'the paste insertion guard not found');
  const line = decodeTemplate(src.slice(at, src.indexOf('\n', at)));
  const before = value.slice(0, caret);
  const after = value.slice(caret);
  const needsNewline = new Function('before', line + '\nreturn needsNewline;')(before) as boolean;
  const insert = (needsNewline ? '\n' : '') + '@clipboard ';
  return before + insert + after;
}

suite('paste-to-clipboard inserts a resolvable mention', () => {
  test('the reported input now attaches', () => {
    const rule = loadHostRule();
    const typed = 'check those testcases in this folder:';
    // Before: the caret insertion produced an unresolvable mention.
    assert.strictEqual(rule(typed + '@clipboard '), false, 'the old behaviour did not attach');
    // After: the paste puts it on its own line.
    const pasted = pasteAt(typed, typed.length);
    assert.strictEqual(rule(pasted), true, 'must attach now: ' + JSON.stringify(pasted));
  });

  test('an empty composer needs no extra newline', () => {
    const rule = loadHostRule();
    const out = pasteAt('', 0);
    assert.strictEqual(out, '@clipboard ', 'no leading blank line: ' + JSON.stringify(out));
    assert.strictEqual(rule(out), true);
  });

  test('a caret already at a line start needs no extra newline', () => {
    const rule = loadHostRule();
    const typed = 'first line\n';
    const out = pasteAt(typed, typed.length);
    assert.strictEqual(out, 'first line\n@clipboard ');
    assert.strictEqual(rule(out), true);
  });

  test('trailing indentation still counts as a line start', () => {
    const rule = loadHostRule();
    const typed = 'first line\n  ';
    const out = pasteAt(typed, typed.length);
    assert.ok(!out.includes('\n\n'), 'must not add a second newline: ' + JSON.stringify(out));
    assert.strictEqual(rule(out), true);
  });

  test('text after the caret is preserved', () => {
    const value = 'before|after';
    const out = pasteAt(value, 'before'.length);
    assert.ok(out.endsWith('|after'), 'the tail must survive: ' + JSON.stringify(out));
    assert.strictEqual(loadHostRule()(out), true);
  });

  test('mid-sentence prose is still NOT treated as an attach request', () => {
    // The rule this fix must not weaken: a question about the feature stays prose.
    const rule = loadHostRule();
    assert.strictEqual(rule('how does @clipboard work?'), false);
    assert.strictEqual(rule('check this folder:@clipboard'), false);
  });

  test('an unresolvable mention is reported instead of sent silently', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    // A typed mid-line mention cannot be auto-fixed — the user may have meant prose —
    // so the send path says why nothing was attached.
    assert.ok(
      src.includes('@clipboard only attaches at the start of a line.'),
      'the send path must warn about an unresolvable mention',
    );
    assert.ok(
      src.includes('!hasLeadingClipboardMention(text) && hasMentionOutsideContext(text,'),
      'and only when a mention is present but unresolvable',
    );
    // Prose-only scanning. A mention sitting INSIDE an already-attached payload is not
    // the user asking for anything, and warning about it would be noise — the same rule
    // the @terminal and @problems resolvers follow, enforced by mentionScan.test.ts.
    assert.ok(!src.includes('/@clipboard\\b/i.test(text)'), 'must not scan the raw text');
  });
});

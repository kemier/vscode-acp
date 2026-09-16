import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { decodeTemplate } from './templateDecode';

/**
 * Pasting text inserts an INLINE @clipboard mention, and says it was pasted.
 *
 * The host only attaches a TYPED mention that sits at a line start: mid-sentence
 * "@clipboard" is treated as prose, so asking "how does @clipboard work?" cannot hijack the
 * clipboard. Position is the only signal a typed mention carries.
 *
 * An earlier fix satisfied that rule by making paste prepend a newline. It resolved
 * correctly but broke the sentence being written — typing "i see ", pasting, then
 * " this has" produced:
 *
 *   i see
 *   @clipboard this has
 *
 * A paste is unambiguous intent, so the intent now travels with the message
 * (`clipboardPasted`) instead of the mention being moved. The host attaches a pasted
 * mention wherever it sits, and position still governs typed ones.
 */
const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

/** The webview's untyped copy of the leading-mention test. */
function loadHasLeadingMention(): (t: string) => boolean {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const needle = 'function hasLeadingClipboardMention(';
  for (let at = src.indexOf(needle); at >= 0; at = src.indexOf(needle, at + 1)) {
    if (src.slice(at, src.indexOf('{', at)).includes(':')) {
      continue; // host-side typed declaration
    }
    let i = src.indexOf('{', at);
    let depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '{') {
        depth++;
      } else if (src[i] === '}') {
        depth--;
        if (depth === 0) {
          break;
        }
      }
    }
    const js = decodeTemplate(src.slice(at, i + 1));
    return new Function(js + '\nreturn hasLeadingClipboardMention;')() as (t: string) => boolean;
  }
  throw new Error('no untyped hasLeadingClipboardMention');
}

/** Replay the webview's paste insertion at a caret position. */
function pasteAt(value: string, caret: number): string {
  const before = value.slice(0, caret);
  const after = value.slice(caret);
  // Mirrors the handler: a plain inline insert, no repositioning.
  return before + '@clipboard ' + after;
}

const SRC = fs.readFileSync(SOURCE, 'utf8');

suite('paste-to-clipboard inserts an inline mention', () => {
  test('the reported case stays on one line', () => {
    // "i see " + paste + " this has"
    const afterPaste = pasteAt('i see ', 6);
    assert.strictEqual(afterPaste, 'i see @clipboard ');
    const full = afterPaste + 'this has';
    assert.ok(!full.includes('\n'), `must not break the line: ${JSON.stringify(full)}`);
    assert.strictEqual(full, 'i see @clipboard this has');
  });

  test('text after the caret is preserved', () => {
    assert.strictEqual(pasteAt('check this folder', 6), 'check @clipboard this folder');
  });

  test('an empty composer is unchanged in behaviour', () => {
    assert.strictEqual(pasteAt('', 0), '@clipboard ');
  });

  test('the handler no longer inserts a newline', () => {
    // The whole point of the change. A regression would silently restore the two-line
    // composer, which is invisible to every other assertion here.
    assert.ok(
      !SRC.includes('var needsNewline ='),
      'the newline-prepending guard must be gone',
    );
    assert.ok(
      SRC.includes("const insert = '@clipboard ';"),
      'paste should insert the bare inline mention',
    );
  });

  test('paste intent is recorded and sent', () => {
    assert.ok(SRC.includes('clipboardPastedPending = true;'), 'paste must record intent');
    assert.ok(
      /clipboardPasted: pastedNow/.test(SRC),
      'the send must carry the paste flag',
    );
    // Cleared on send, so a later typed mention is judged on position alone.
    assert.ok(SRC.includes('clipboardPastedPending = false;'), 'the flag must be cleared');
  });

  test('the flag is only sent when the mention survived editing', () => {
    // The user may paste and then delete the mention; claiming a paste then would attach
    // the clipboard to a message that no longer asks for it.
    assert.ok(
      /pastedNow = clipboardPastedPending && \/@clipboard/.test(SRC),
      'the flag must be gated on the mention still being present',
    );
  });

  test('the host resolves a pasted mention regardless of position', () => {
    assert.ok(
      SRC.includes('hasLeadingClipboardMention(text) || !!clipboardPasted'),
      'the resolver must accept either a leading mention or a pasted one',
    );
    // And the warning must not fire for a paste — it resolves fine.
    assert.ok(
      SRC.includes('if (!clipboardMentionResolves && hasMentionOutsideContext('),
      'the mid-sentence warning must be gated on the same condition',
    );
  });

  test('a TYPED mid-sentence mention still does not resolve on its own', () => {
    // The guard that stops "how does @clipboard work?" from hijacking the clipboard.
    const hasLeading = loadHasLeadingMention();
    assert.strictEqual(hasLeading('how does @clipboard work?'), false);
    assert.strictEqual(hasLeading('check this folder:@clipboard'), false);
    // Still true at a line start, or at the very beginning.
    assert.strictEqual(hasLeading('@clipboard'), true);
    assert.strictEqual(hasLeading('look:\n@clipboard'), true);
    assert.strictEqual(hasLeading('  @clipboard'), true);
  });
});

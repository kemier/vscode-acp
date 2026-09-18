import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  pastedLiteralRanges,
  indexInRanges,
  hasMentionOutsideContext,
} from '../core/MentionScan';

/**
 * A mention that arrived by PASTE is a quote, not a request.
 *
 * A mention only attaches at a line start: mid-sentence "@clipboard" is prose, so a
 * question about the feature cannot hijack the clipboard. That rule reads position —
 * and a paste is free to put a word at position 0 without the user meaning anything
 * by it.
 *
 * Reported 2026-09-18T07:50 (ACP Traffic line 65685). The clipboard held a sentence
 * quoting the warning itself, beginning with the literal word "@clipboard". Pasting
 * it made that word leading, so the send stripped it and attached the clipboard —
 * whose content was the same sentence:
 *
 *   <clipboard>
 *   @clipboard only attaches at the start of a line. Put it on its own line …
 *   </clipboard>
 *
 *   only attaches at the start of a line. Put it on its own line …
 *   ^ the subject was eaten; the sentence no longer says what it is about
 *
 * Position cannot separate these two cases, because position is what the paste
 * changed. Provenance can, so the webview now reports which strings were pasted.
 *
 * Note the loop this closes: the pasted text was the warning about where mentions
 * attach, so the old code warned about it again while mangling it.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

/** The exact text from the report. */
const QUOTE =
  '@clipboard only attaches at the start of a line. Put it on its own line (or at the ' +
  'very start of the message) — mid-sentence it is treated as ordinary text.';

suite('pasted mentions are literal', () => {
  test('the reported case no longer resolves', () => {
    const composed = QUOTE + ' // check this from acp log';
    // Typed, this WOULD be a request — position says leading.
    assert.strictEqual(hasMentionOutsideContext(composed, /@clipboard\b/i), true);
    // Pasted, it is the quote it looks like.
    assert.strictEqual(hasMentionOutsideContext(composed, /@clipboard\b/i, [QUOTE]), false);
  });

  test('a mention the user typed alongside pasted text still resolves', () => {
    // The provenance rule must not disable the feature for the rest of the message.
    const composed = QUOTE + '\n@clipboard';
    assert.strictEqual(hasMentionOutsideContext(composed, /@clipboard\b/i, [QUOTE]), true);
  });

  test('ranges cover exactly the pasted span', () => {
    const composed = 'see: ' + QUOTE + ' end';
    const ranges = pastedLiteralRanges(composed, [QUOTE]);
    assert.strictEqual(ranges.length, 1);
    assert.strictEqual(ranges[0].start, 5);
    assert.strictEqual(ranges[0].end, 5 + QUOTE.length);
    assert.ok(indexInRanges(composed.indexOf('@clipboard'), ranges));
    assert.ok(!indexInRanges(0, ranges));
  });

  test('the same text pasted twice is covered in both places', () => {
    const composed = QUOTE + '\nand again:\n' + QUOTE;
    const ranges = pastedLiteralRanges(composed, [QUOTE]);
    assert.strictEqual(ranges.length, 2);
    assert.strictEqual(hasMentionOutsideContext(composed, /@clipboard\b/i, [QUOTE]), false);
  });

  test('editing inside the pasted text hands it back to the user', () => {
    // The match lapses, so the mention becomes a request again — correct, they have
    // since made it their own words.
    const edited = QUOTE.replace('ordinary text', 'plain text');
    assert.strictEqual(hasMentionOutsideContext(edited, /@clipboard\b/i, [QUOTE]), true);
  });

  test('a trivial needle cannot disable mention resolution', () => {
    // A one-char or blank entry would match everywhere and silently switch the
    // feature off for the whole message.
    for (const junk of ['', ' ', '\n', 'a']) {
      assert.deepStrictEqual(pastedLiteralRanges('@clipboard here', [junk]), []);
      assert.strictEqual(hasMentionOutsideContext('@clipboard here', /@clipboard\b/i, [junk]), true);
    }
  });

  test('an empty needle cannot spin the scan forever', () => {
    // indexOf CLAMPS its start index for an empty needle: 'abc'.indexOf('', 99) is 3.
    // So `at` sticks at src.length while the cursor climbs, and the loop appends a
    // range per iteration forever. Removing the length guard turned this into a 4 GB
    // OOM that killed the whole test run rather than failing an assertion.
    const ranges = pastedLiteralRanges('@clipboard here', ['']);
    assert.deepStrictEqual(ranges, []);
  });

  test('the loop terminates even if the length guard is relaxed', () => {
    // The guard above makes the clamping case unreachable, so this second brake is
    // deliberately untestable through the public API — assert it is still in the
    // source, or a future edit could drop it and restore the OOM silently.
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/core/MentionScan.ts'),
      'utf8',
    );
    const at = src.indexOf('export function pastedLiteralRanges');
    assert.ok(at > 0, 'pastedLiteralRanges not found');
    const body = src.slice(at, src.indexOf('\n}', at));
    assert.ok(body.includes('if (next <= i) {'), 'monotonic-progress brake removed');
    // And a large, varied needle set still returns promptly.
    const many = Array.from({ length: 200 }, (_, k) => 'x'.repeat((k % 7) + 2));
    const t0 = Date.now();
    pastedLiteralRanges('xxxxxx @clipboard xxxxxx'.repeat(50), many);
    assert.ok(Date.now() - t0 < 2000, 'scan took too long');
  });

  test('no pasted texts behaves exactly as before', () => {
    assert.deepStrictEqual(pastedLiteralRanges('@clipboard', undefined), []);
    assert.deepStrictEqual(pastedLiteralRanges('@clipboard', []), []);
    assert.strictEqual(hasMentionOutsideContext('@clipboard', /@clipboard\b/i), true);
    assert.strictEqual(hasMentionOutsideContext('@clipboard', /@clipboard\b/i, []), true);
  });

  test('the whole mention family is covered, not just clipboard', () => {
    for (const name of ['terminal', 'problems', 'selection', 'open_files']) {
      const quoted = '@' + name + ' pastes as text too, per the docs.';
      const re = new RegExp('@' + name + '\\b', 'i');
      assert.strictEqual(hasMentionOutsideContext(quoted, re), true, name + ' typed');
      assert.strictEqual(hasMentionOutsideContext(quoted, re, [quoted]), false, name + ' pasted');
    }
  });

  test('payload interiors are still ignored (the older rule is intact)', () => {
    const withBlock = '<clipboard>\n@clipboard quoted inside a payload\n</clipboard>';
    assert.strictEqual(hasMentionOutsideContext(withBlock, /@clipboard\b/i), false);
  });
});

suite('host and webview agree on provenance', () => {
  const src = fs.readFileSync(SOURCE, 'utf8');

  test('the host reads the pasted texts when deciding a leading mention', () => {
    const at = src.indexOf('function hasLeadingClipboardMention(t: string): boolean');
    assert.ok(at > 0, 'host helper not found');
    const body = src.slice(at, src.indexOf('\n    }', at));
    assert.ok(body.includes('pastedLiteralRanges(src, pastedLiteralTexts)'), 'ranges not computed');
    assert.ok(body.includes('indexInRanges(m.index, pasted)'), 'mention position not checked');
  });

  test('the warning does not fire for a quoted mention', () => {
    // Otherwise copying the warning and pasting it back re-triggers it, which is
    // literally how this was reported.
    const at = src.indexOf('const clipboardMentionResolves =');
    const around = src.slice(at, at + 400);
    assert.ok(
      around.includes('hasMentionOutsideContext(text, /@clipboard\\b/i, pastedLiteralTexts)'),
      'warning still scans without provenance',
    );
  });

  test('the webview records an inline paste that carries a mention', () => {
    assert.ok(
      src.includes('pastedLiteralTexts.push(String(text));'),
      'inline paste does not record its text',
    );
    // Must be the fall-through branch: the attachment branch already has its own
    // payload list, and recording there would suppress a real attachment.
    const push = src.indexOf('pastedLiteralTexts.push(String(text));');
    const before = src.slice(Math.max(0, push - 900), push);
    assert.ok(before.includes('} else if (text &&'), 'not on the non-attachment path');
  });

  test('the send carries them to the host, then clears them', () => {
    assert.ok(src.includes('pastedLiteralTexts: literalTexts'), 'not sent');
    const at = src.indexOf('var literalTexts = pastedLiteralTexts.slice();');
    assert.ok(at > 0, 'not snapshotted before the post');
    assert.ok(
      src.slice(at, at + 400).includes('pastedLiteralTexts = [];'),
      'not cleared, so it would leak into the next message',
    );
  });

  test('the host accepts the array defensively', () => {
    assert.ok(
      src.includes('Array.isArray(message.pastedLiteralTexts) ? message.pastedLiteralTexts : undefined'),
      'host does not guard the incoming value',
    );
  });

  test('the webview regex survives the template literal', () => {
    // Written \\b in the .ts so the emitted JS has \b. A single backslash would
    // make it match a literal "b" and the recording would never fire.
    const at = src.indexOf('} else if (text && /@(clipboard|terminal');
    assert.ok(at > 0, 'guard not found');
    const line = src.slice(at, src.indexOf('\n', at));
    assert.ok(line.includes('\\\\b'), 'escape not doubled for the template literal');
    // And the family must match MentionScan's, or the two disagree about what a
    // mention is.
    for (const name of ['clipboard', 'terminal', 'problems', 'selection', 'open_files']) {
      assert.ok(line.includes(name), 'webview guard omits @' + name);
    }
  });
});

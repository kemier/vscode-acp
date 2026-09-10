import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  contextBlockRanges,
  proseRanges,
  hasMentionOutsideContext,
  matchMentionsOutsideContext,
  replaceMentionOutsideContext,
  escapeForRegExp,
} from '../core/MentionScan';
import { wrapClipboardPayload } from '../core/ContextBlockBuilder';

/**
 * A mention quoted inside an attached payload is not a request.
 *
 * Reported with a verbatim reproduction. The clipboard held the text of an earlier
 * warning, which itself starts with "@clipboard: …". Queueing "@clipboard <comment>"
 * expands to
 *
 *   <clipboard>
 *   @clipboard: the clipboard was empty when this message
 *   </clipboard>
 *
 *   : the clipboard was empty when this message queued  , before deploy…
 *
 * and the send path then scanned that WHOLE string for "@clipboard". It found the
 * one inside the payload, so it attached the clipboard a second time and deleted
 * the mention from the quoted text, producing two nested blocks and three mangled
 * copies of the same sentence.
 *
 * This predates the pill change: the substituted-inline version had the same defect
 * (its comment even claimed the resolver "finds no mention and stays out of it" —
 * true only while the payload does not contain one).
 */

suite('mentions are scanned in prose, not inside attached payloads', () => {
  const WARNING = '@clipboard: the clipboard was empty when this message';

  test('the reported case attaches once and leaves the payload byte-identical', () => {
    // What the queue expands to, verbatim.
    const expanded = `${wrapClipboardPayload(WARNING)}\n\n: the clipboard was empty when this message queued  , before deploy of fix has this issue also`;

    // The send path's test: is there a request to resolve?
    assert.strictEqual(
      hasMentionOutsideContext(expanded, /@clipboard\b/i),
      false,
      'the only mention lives inside the payload — resolving again double-attaches',
    );
    // And its removal step must not edit the payload.
    assert.strictEqual(replaceMentionOutsideContext(expanded, /@clipboard\b/gi, ''), expanded);
    assert.ok(expanded.indexOf(WARNING) > 0, 'the quoted "@clipboard" survives verbatim');
    assert.strictEqual(expanded.split('<clipboard>').length - 1, 1, 'exactly one block');
  });

  test('a real request beside a quoted one resolves exactly once', () => {
    const text = `${wrapClipboardPayload(WARNING)}\n\n@clipboard explain it`;
    assert.strictEqual(hasMentionOutsideContext(text, /@clipboard\b/i), true);
    const stripped = replaceMentionOutsideContext(text, /@clipboard\b/gi, '');
    assert.ok(stripped.indexOf(WARNING) > 0, 'the payload keeps its own mention');
    assert.ok(stripped.trim().endsWith('explain it'), stripped);
    assert.strictEqual(stripped.indexOf('@clipboard explain it'), -1, 'the real mention is consumed');
  });

  test('the hazard is cross-mention, not clipboard-specific', () => {
    // A pasted snippet that talks about @terminal / @problems must not attach them.
    const text = `<clipboard>\nrun @terminal then check @problems\n</clipboard>\n\nsummarise`;
    assert.strictEqual(hasMentionOutsideContext(text, /@terminal\b/i), false);
    assert.strictEqual(hasMentionOutsideContext(text, /@problems\b/i), false);
    // Inlined terminal/problems fallbacks are payload too.
    const inlined = '<terminal name="bash">\n$ echo @clipboard\n</terminal>\n\nwhat failed?';
    assert.strictEqual(hasMentionOutsideContext(inlined, /@clipboard\b/i), false);
  });

  test('@file: / @folder: are collected from prose only, and removed there', () => {
    const text = `<clipboard>\nsee @file:secrets.env\n</clipboard>\n\ncompare with @file:src/main.ts`;
    assert.deepStrictEqual(matchMentionsOutsideContext(text, /@file:([^\s]+)/gi), ['@file:src/main.ts']);
    const removed = replaceMentionOutsideContext(text, new RegExp(escapeForRegExp('@file:src/main.ts'), 'g'), '');
    assert.ok(removed.indexOf('@file:secrets.env') > 0, 'the quoted path stays quoted');
    assert.ok(removed.indexOf('@file:src/main.ts') < 0, 'the requested one is consumed');
  });

  test('block ranges cover the tags the send path inlines', () => {
    for (const tag of ['clipboard', 'terminal', 'problems', 'selection', 'context', 'agent-memory']) {
      const text = `<${tag} a="1">body</${tag}>tail`;
      assert.deepStrictEqual(
        contextBlockRanges(text),
        [{ start: 0, end: text.length - 'tail'.length }],
        `${tag} must be opaque`,
      );
    }
  });

  test('an unclosed tag is prose, not a black hole to end of message', () => {
    // Swallowing the rest would silently drop the real prompt.
    const text = 'why is <clipboard not stripped? @clipboard explain';
    assert.deepStrictEqual(contextBlockRanges(text), []);
    assert.strictEqual(hasMentionOutsideContext(text, /@clipboard\b/i), true);
  });

  test('no blocks at all means every position is prose', () => {
    const text = '@clipboard summarise this';
    assert.deepStrictEqual(proseRanges(text), [{ start: 0, end: text.length }]);
    assert.strictEqual(replaceMentionOutsideContext(text, /@clipboard\b/gi, '').trim(), 'summarise this');
  });

  test('several payloads in one message are all skipped', () => {
    const text = [wrapClipboardPayload('@clipboard one'), wrapClipboardPayload('@clipboard two'), '@clipboard go'].join(
      '\n\n',
    );
    assert.deepStrictEqual(matchMentionsOutsideContext(text, /@clipboard\b/gi), ['@clipboard']);
    const stripped = replaceMentionOutsideContext(text, /@clipboard\b/gi, '');
    assert.strictEqual(stripped.split('@clipboard').length - 1, 2, 'both payload mentions survive');
  });
});

suite('the send path uses prose-only scanning for every mention', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts'), 'utf8');
  // Bound the search to the resolver, so a match in the webview script cannot pass.
  const at = src.indexOf('const contextBlocks: ContentBlock[] = [];');
  const resolver = src.slice(at, src.indexOf('this._cancelGeneration++', at));

  test('no mention is tested against the raw text any more', () => {
    assert.ok(at > 0, 'context resolver not found');
    for (const raw of [
      '/@terminal\\b/i.test(text)',
      '/@clipboard\\b/i.test(text)',
      '/@problems\\b/i.test(text)',
      'text.match(/@file:',
      'text.match(/@folder:',
    ]) {
      assert.ok(!resolver.includes(raw), `raw scan still present: ${raw}`);
    }
  });

  test('and no mention is removed from the raw text either', () => {
    for (const raw of [
      "text.replace(/@terminal\\b/gi, '')",
      "text.replace(/@clipboard\\b/gi, '')",
      "text.replace(/@problems\\b/gi, '')",
      "text.replace(match, '')",
    ]) {
      assert.ok(!resolver.includes(raw), `raw removal still present: ${raw}`);
    }
  });

  test('all five mentions go through the prose-only helpers', () => {
    for (const mention of ['@terminal', '@clipboard', '@problems']) {
      assert.ok(
        resolver.includes(`hasMentionOutsideContext(text, /${mention}\\b/i)`),
        `${mention} must be scanned in prose only`,
      );
    }
    assert.ok(resolver.includes('matchMentionsOutsideContext(text, /@file:'), '@file: must be collected from prose');
    assert.ok(
      resolver.includes('matchMentionsOutsideContext(text, /@folder:'),
      '@folder: must be collected from prose',
    );
    // Five mentions, seven calls: @file:/@folder: strip their match from the wire
    // text AND from the prose copy the panel is told about (see proseText).
    for (const removal of [
      "replaceMentionOutsideContext(text, /@terminal\\b/gi, '')",
      "replaceMentionOutsideContext(text, /@clipboard\\b/gi, '')",
      "replaceMentionOutsideContext(text, /@problems\\b/gi, '')",
      "replaceMentionOutsideContext(text, new RegExp(escapeForRegExp(match), 'g'), '')",
      "replaceMentionOutsideContext(proseText, new RegExp(escapeForRegExp(match), 'g'), '')",
    ]) {
      assert.ok(resolver.includes(removal), `removal not prose-only: ${removal}`);
    }
    assert.ok(
      resolver.split('replaceMentionOutsideContext(').length - 1 >= 5,
      'every removal must go through the prose-only helper',
    );
  });
});

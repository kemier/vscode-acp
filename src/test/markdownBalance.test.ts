import * as assert from 'assert';
import { Marked } from 'marked';
import { createMathExtension } from '../utils/markdownMath';
import {
  balanceMarkdownForPartialRender,
  hasOpenFence,
  hasUnclosedInlineCode,
  stripLoneTrailingFence,
} from '../utils/markdownBalance';

// Mirrors the production marked configuration in ChatWebviewProvider.
const parse = (md: string): string => {
  const m = new Marked();
  m.use(createMathExtension());
  m.setOptions({ breaks: true, gfm: true });
  return m.parse(md) as string;
};

suite('markdownBalance', () => {
  suite('balanceMarkdownForPartialRender', () => {
    test('returns complete, balanced text unchanged', () => {
      const md = 'Here is `code` and a fence:\n\n```\nx = 1\n```\nDone.';
      assert.strictEqual(balanceMarkdownForPartialRender(md), md);
    });

    test('returns plain prose with no backticks unchanged', () => {
      const md = 'Just a normal sentence with no code at all.';
      assert.strictEqual(balanceMarkdownForPartialRender(md), md);
    });

    test('closes an open fenced code block', () => {
      // Mid-stream: fence opened, code being written, no closer yet.
      const partial = 'Here is the code:\n\n```\ndef foo():';
      const out = balanceMarkdownForPartialRender(partial);
      assert.ok(out.endsWith('```'), `expected trailing fence: ${JSON.stringify(out)}`);
      assert.ok(out.startsWith(partial), 'should only append, not mutate');
    });

    test('closes an open fence even with trailing prose after it', () => {
      // The hazard: prose lands after an open fence and marked would render it
      // as code. The balancer must still close the fence.
      const partial = '```\ncode line\nthis is still code';
      const out = balanceMarkdownForPartialRender(partial);
      assert.ok(out.endsWith('```'), `expected trailing fence: ${JSON.stringify(out)}`);
    });

    test('does not close a fence that is already closed', () => {
      const complete = '```\ncode\n```\nnow prose';
      assert.strictEqual(balanceMarkdownForPartialRender(complete), complete);
    });

    test('handles multiple fences (open/close pairs) and leaves them as-is', () => {
      const md = '```\na\n```\nprose\n```\nb\n```';
      assert.strictEqual(balanceMarkdownForPartialRender(md), md);
    });

    test('closes the second fence when only one of two is closed', () => {
      const partial = '```\na\n```\nprose\n```\nb';
      const out = balanceMarkdownForPartialRender(partial);
      assert.ok(out.endsWith('```'), `expected trailing fence: ${JSON.stringify(out)}`);
    });

    test('leaves a trailing lone inline backtick untouched (no false code span)', () => {
      // A stray backtick at the end (e.g. quoting user input that ends with
      // `) renders literally in marked. Auto-closing it would create a false
      // <code> capsule (`"), I need` -> <code>"), I need</code>).
      const partial = 'The character class ... or ). I need `';
      assert.strictEqual(balanceMarkdownForPartialRender(partial), partial);
    });

    test('leaves balanced inline backticks alone', () => {
      const md = 'Use `code` and `more`.';
      assert.strictEqual(balanceMarkdownForPartialRender(md), md);
    });

    test('does not count fence backticks toward inline balance', () => {
      // ``` has 3 backticks (even? no — 3 is odd, but it is a FENCE, not inline).
      // A single unclosed fence must close as a fence, NOT also append an
      // inline backtick (which would produce ````\`).
      const partial = '```\ncode';
      const out = balanceMarkdownForPartialRender(partial);
      assert.ok(out.endsWith('```'), `expected only fence close: ${JSON.stringify(out)}`);
      assert.ok(!out.endsWith('````'), 'must not over-close');
    });

    test('leaves an inline backtick after a closed fence untouched', () => {
      // Closed fence + one lone inline backtick. The backtick renders
      // literally in marked; no auto-close (which would create a capsule).
      const partial = '```\ncode\n```\nthen `unmatched';
      const out = balanceMarkdownForPartialRender(partial);
      assert.strictEqual(out, partial);
    });
  });

  suite('multi-line inline code span repair (bullets not aligned)', () => {
    // A single-backtick code span CANNOT contain a newline (CommonMark). When
    // the model writes one inside a list item, marked breaks the span at the
    // newline AND terminates the list, demoting the following items into a
    // paragraph. These tests pin the repair: sole span -> fenced block (list
    // stays aligned); multiple spans on a line -> newlines collapsed.

    test('a sole multi-line span in a list item becomes an indented fenced block', () => {
      // The exact shape from the reported bug: item 2 quotes a tag that the
      // model put on the next line after the opening backtick.
      const md =
        'The screenshot shows:\n' +
        '1. Assistant message: "Done."\n' +
        '2. User bubble: `' + '\n' + '<local-command-caveat>...</local-command-caveat>`' + '\n' +
        '3. next item\n';
      const out = balanceMarkdownForPartialRender(md);
      // The span must be converted to a fence, indented so it stays in the item.
      assert.ok(out.includes('\n   ```\n'), `expected indented fence opener: ${JSON.stringify(out)}`);
      // Render it and confirm the list stays a single <ol> with item 2 holding a code block.
      const html = parse(out);
      assert.ok(html.includes('<ol'), `expected a list: ${html}`);
      // Item 2 must contain a <pre><code> INSIDE its <li>, and item 3 must
      // still be a <li> of the same list (not demoted into a <p>).
      assert.ok(/<li>User bubble: <pre><code>/.test(html), `item 2 should hold a code block: ${html}`);
      assert.ok(/<li>next item<\/li>/.test(html), `item 3 should stay a list item: ${html}`);
      // The stray-backtick collapse (item 3 in a <p>) must NOT happen.
      const listCount = (html.match(/<li>/g) || []).length;
      assert.strictEqual(listCount, 3, `expected all 3 items to stay list items: ${html}`);
    });

    test('multiple multi-line spans on one list item collapse to inline code', () => {
      // Item with three spans separated by " + " — the sole-span fence rule
      // does not apply, so newlines collapse and the list stays aligned.
      const md =
        '1. a\n' +
        '2. User bubble: `' + '\n' + '<command-name>x</command-name>` + `' + '\n' + '<command-message>` + `' + '\n' + '<command-args>`\n' +
        '3. c\n';
      const out = balanceMarkdownForPartialRender(md);
      const html = parse(out);
      // No fence should be introduced (multi-span), and all items stay in the list.
      assert.ok(!out.includes('```'), `no fence for multi-span item: ${JSON.stringify(out)}`);
      const listCount = (html.match(/<li>/g) || []).length;
      assert.strictEqual(listCount, 3, `all 3 items stay list items: ${html}`);
    });

    test('a multi-line span outside a list becomes a standalone fenced block', () => {
      const md = 'Here is the tag: `' + '\n' + '<foo>bar</foo>`' + '\nAfter.';
      const out = balanceMarkdownForPartialRender(md);
      const html = parse(out);
      assert.ok(html.includes('<pre><code>'), `expected a code block: ${html}`);
      assert.ok(html.includes('After.'), `trailing text preserved: ${html}`);
    });

    test('a balanced single-line span is left unchanged', () => {
      const md = 'Use `code` and `more` here.';
      assert.strictEqual(balanceMarkdownForPartialRender(md), md);
    });

    test('complete message with a sole multi-line span renders as one aligned list', () => {
      // The full reported message (session 01d25a08, line 5567), trimmed to the
      // list. Items 2-5 quote snippets; item 2 is a sole span, item 3 has three.
      const md =
        'The screenshot shows:\n' +
        '1. Assistant message: "Done."\n' +
        '2. User bubble: `' + '\n' + '<local-command-caveat>...</local-command-caveat>`\n' +
        '3. User bubble: `' + '\n' + '<command-name>/list-agents</command-name>` + `' + '\n' + '<command-message>` + `' + '\n' + '<command-args>`\n' +
        '4. User bubble: `Clipboard: 5 lines` + `//what this...`\n' +
        '5. User bubble: `is acp model...`\n';
      const html = parse(balanceMarkdownForPartialRender(md));
      // All 5 items must remain list items of a single ordered list.
      const listCount = (html.match(/<li>/g) || []).length;
      assert.strictEqual(listCount, 5, `all 5 items stay in the list: ${html}`);
      // Item 2 (sole span) holds a code block; item 3 (multi-span) holds inline code.
      assert.ok(/<li>User bubble: <pre><code>/.test(html), `item 2 code block: ${html}`);
      assert.ok(/<li>User bubble: <code>/.test(html), `item 3 inline code: ${html}`);
    });
  });

  suite('end-to-end: marked.parse on balanced partial text', () => {
    test('open fence no longer swallows trailing prose as a code block', () => {
      // Before the fix, marked parses this partial text and treats everything
      // after ``` as <pre><code>, so "thisIsProse" lands inside <code>. After
      // balancing, the appended closer ends the block and prose renders as text.
      const partial = 'Intro text\n\n```\ncode line\nthisIsProseShouldNotBeCode';
      const html = parse(balanceMarkdownForPartialRender(partial));
      // The code block content ("code line") is inside <pre><code>.
      assert.ok(/<pre>|<code/.test(html), `expected a code block: ${html}`);
      // But trailing prose after the (now-closed) fence should be a paragraph,
      // not buried inside the code block. marked renders the post-fence line as
      // its own <p> once the fence is closed.
      assert.ok(/<p>/.test(html), `expected a paragraph for trailing prose: ${html}`);
    });

    test('a stray trailing backtick renders literally, not as a code capsule', () => {
      // Regression: the old balancer appended a closing backtick to "`), I need",
      // turning it into <code>"), I need</code> — a false capsule. marked renders
      // a trailing lone backtick literally, so leave it alone.
      const partial =
        'The character class [([0-9a-f]{8})] matches a single char that is (, [, 0-9, a-f, {, 8, or ). I need `';
      const html = parse(balanceMarkdownForPartialRender(partial));
      assert.ok(html.includes('I need `'), `expected literal backtick: ${html}`);
      assert.ok(!html.includes('<code>'), `no code capsule expected: ${html}`);
    });

    test('complete balanced reply renders identically with and without balancing', () => {
      const md = '## Title\n\n`inline` code and\n\n```\nfenced\n```\n\nFinal line.';
      assert.strictEqual(parse(balanceMarkdownForPartialRender(md)), parse(md));
    });
  });

  suite('hasOpenFence', () => {
    test('true when text ends inside an unclosed fence', () => {
      // The fence-swallow hazard: model opened ```regex with a .+" inside and
      // a tool-call boundary committed before the closing fence arrived.
      assert.ok(hasOpenFence('Here is the pattern:\n\n```regex\n.+"'));
      assert.ok(hasOpenFence('```\ncode line'));
    });

    test('false when the fence is properly closed', () => {
      assert.ok(!hasOpenFence('```\ncode\n```\nnow prose'));
      assert.ok(!hasOpenFence('```regex\n.+"\n```\ntrailing prose'));
    });

    test('false for plain prose with no fence at all', () => {
      assert.ok(!hasOpenFence('just a normal sentence'));
      assert.ok(!hasOpenFence('inline `code` only'));
    });

    test('false when multiple open/close pairs are all balanced', () => {
      assert.ok(!hasOpenFence('```\na\n```\nprose\n```\nb\n```'));
    });

    test('true when only the first of two fences is closed', () => {
      assert.ok(hasOpenFence('```\na\n```\nprose\n```\nb'));
    });

    test('agrees with balanceMarkdownForPartialRender on when to close', () => {
      // hasOpenFence must return true exactly when the balancer would append a
      // closer — they share the same pairing logic.
      const cases = [
        '```\ncode',
        '```\ncode\n```',
        'intro\n```regex\n.+"\nstill code',
        'plain prose',
        '```\na\n```\n```\nb',
      ];
      for (const c of cases) {
        const balanced = balanceMarkdownForPartialRender(c);
        const expectedOpen = balanced !== c; // balancer appended a closer
        assert.strictEqual(
          hasOpenFence(c),
          expectedOpen,
          `mismatch for ${JSON.stringify(c)}: hasOpenFence=${hasOpenFence(c)} balancerChanged=${expectedOpen}`,
      );
    }
  });

  suite('hasUnclosedInlineCode', () => {
    test('true when an inline code span is split across a boundary (odd count)', () => {
      // The opening backtick committed; the closer lands in a later segment.
      // "The log shows `session/" has ONE single-backtick run -> odd.
      assert.ok(hasUnclosedInlineCode('The log shows `session/'));
      assert.ok(hasUnclosedInlineCode('see `ChatWebviewProvider.ts: for it'));
    });

    test('true when a trailing closer is unpaired (opener in a prior segment)', () => {
      // Odd count too — the defer-guard treats this conservatively so the
      // committed source stays whole until the next segment makes it even.
      // "`steer and ChatWebviewProvider.ts:" has ONE single-backtick run.
      assert.ok(hasUnclosedInlineCode('`steer and ChatWebviewProvider.ts:'));
    });

    test('false when all inline spans are balanced (even count)', () => {
      assert.ok(!hasUnclosedInlineCode('Use `code` and `more`.'));
      assert.ok(!hasUnclosedInlineCode('a `b c` d `e f` g'));
      assert.ok(!hasUnclosedInlineCode('see `main.ts` for it'));
      // Two single-backtick runs (one balanced span) -> even.
      assert.ok(!hasUnclosedInlineCode('log shows `31889c4` after'));
    });

    test('false for plain prose with no backticks', () => {
      assert.ok(!hasUnclosedInlineCode('Just a normal sentence.'));
    });

    test('does not count multi-backtick (fence) runs toward the inline count', () => {
      // A lone unclosed fence is a FENCE (hasOpenFence's job), not an inline
      // span — the inline count must stay even (0 single-backtick runs).
      assert.ok(!hasUnclosedInlineCode('intro\n```\ncode'));
      // A balanced inline span plus an open fence: inline count is 2 (even).
      assert.ok(!hasUnclosedInlineCode('see `x` and then:\n```\ncode'));
    });

    test('distinguishes inline-unclosed from fence-unclosed', () => {
      // Fence open, no inline spans -> hasOpenFence true, inline false.
      assert.ok(hasOpenFence('```\ncode'));
      assert.ok(!hasUnclosedInlineCode('```\ncode'));
      // Inline unclosed (odd), no fence -> hasOpenFence false, inline true.
      assert.ok(!hasOpenFence('log shows `session/'));
      assert.ok(hasUnclosedInlineCode('log shows `session/'));
    });
  });

  suite('stripLoneTrailingFence', () => {
    test('strips a lone empty trailing fence, keeping the prose', () => {
      const text = 'grep -c "handleSummarizeSessionCommand" .../extension.js\n```';
      assert.strictEqual(
        stripLoneTrailingFence(text),
        'grep -c "handleSummarizeSessionCommand" .../extension.js',
      );
    });

    test('strips the fence plus trailing whitespace', () => {
      const text = 'Actually wait — the messages showed content as multi-line:\n```\n   \n';
      assert.strictEqual(
        stripLoneTrailingFence(text),
        'Actually wait — the messages showed content as multi-line:',
      );
    });

    test('whole segment is only an empty fence — returns empty string', () => {
      assert.strictEqual(stripLoneTrailingFence('```'), '');
      assert.strictEqual(stripLoneTrailingFence('```\n  \n'), '');
    });

    test('unterminated fence WITH content is preserved (partial code)', () => {
      const text = 'code:\n\n```\n<tool_call>\n<function=execute_command>\n</tool_call>';
      assert.strictEqual(stripLoneTrailingFence(text), null);
    });

    test('properly closed fence is untouched', () => {
      const text = '```js\nconsole.log(1);\n```';
      assert.strictEqual(stripLoneTrailingFence(text), null);
    });

    test('plain prose with no fence is untouched', () => {
      const text = 'Just a normal answer.';
      assert.strictEqual(stripLoneTrailingFence(text), null);
    });

    test('fence in the middle of text (not trailing) is untouched', () => {
      const text = 'trailing prose ``` more';
      assert.strictEqual(stripLoneTrailingFence(text), null);
    });

    test('balanced render after strip no longer produces an empty code block', () => {
      // The bug: balanceMarkdownForPartialRender closes an open fence and
      // renders an empty <pre><code>. stripLoneTrailingFence removes the
      // fence first so the final render is plain prose.
      const interrupted = 'Actually wait — the messages showed content as multi-line:\n```';
      const stripped = stripLoneTrailingFence(interrupted) as string;
      assert.ok(stripped !== null);
      assert.ok(!stripped.includes('```'), 'no fence should remain');
      const html = parse(stripped);
      assert.ok(!html.includes('<pre><code>'), 'no empty code block should render');
      assert.ok(html.includes('multi-line:'), 'prose must survive');
    });
  });
});

  suite('fence detection requires a line start (CommonMark)', () => {
    // Reported: an assistant message rendered a trailing EMPTY code block with a Copy
    // button. Its first paragraph read:
    //
    //   "...after line 9540, the closing ``` of the PagedAttention section)..."
    //
    // That run is mid-sentence, so marked renders it literally — correctly. But the
    // balancer matched every ``` run regardless of position, judged a fence open, and
    // appended a closing run. The appended run DID start a line, so it became an opener
    // with nothing after it: an empty <pre><code> at the end of the message.
    const PROSE_WITH_INLINE_RUN =
      'I will insert after the PagedAttention block (after line 9540, the closing ' +
      '``` of the PagedAttention section). Let me make the first edit.';

    test('a mid-sentence run is not treated as an open fence', () => {
      assert.strictEqual(hasOpenFence(PROSE_WITH_INLINE_RUN), false);
    });

    test('and nothing is appended to it', () => {
      assert.strictEqual(
        balanceMarkdownForPartialRender(PROSE_WITH_INLINE_RUN),
        PROSE_WITH_INLINE_RUN,
      );
    });

    test('a real fence at line start is still detected', () => {
      assert.strictEqual(hasOpenFence('here:\n```\ncode'), true);
      assert.ok(balanceMarkdownForPartialRender('here:\n```\ncode').endsWith('```'));
    });

    test('an indented fence (up to 3 spaces) still counts', () => {
      assert.strictEqual(hasOpenFence('here:\n   ```\ncode'), true);
    });

    test('a 4-space indented run is code, not a fence', () => {
      // 4 spaces is an indented code block in CommonMark, not a fence opener.
      assert.strictEqual(hasOpenFence('here:\n    ```\ncode'), false);
    });

    test('two mid-sentence runs do not pair into a fence either', () => {
      const t = 'use ``` to open and ``` to close a block';
      assert.strictEqual(hasOpenFence(t), false);
      assert.strictEqual(balanceMarkdownForPartialRender(t), t);
    });
  });
});

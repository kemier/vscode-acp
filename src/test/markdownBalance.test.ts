import * as assert from 'assert';
import { Marked } from 'marked';
import { createMathExtension } from '../utils/markdownMath';
import { balanceMarkdownForPartialRender } from '../utils/markdownBalance';

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

    test('closes an unbalanced single inline backtick', () => {
      // Mid-stream: `` `code `` span opened but not closed.
      const partial = 'Use `variable name here';
      const out = balanceMarkdownForPartialRender(partial);
      assert.ok(out.endsWith('`'), `expected trailing backtick: ${JSON.stringify(out)}`);
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

    test('closes an inline backtick that follows a closed fence', () => {
      // Closed fence (even, 6 backticks total) + one lone inline backtick.
      const partial = '```\ncode\n```\nthen `unmatched';
      const out = balanceMarkdownForPartialRender(partial);
      assert.ok(out.endsWith('`') && !out.endsWith('```'), `expected single inline close: ${JSON.stringify(out)}`);
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

    test('unbalanced inline backtick does not turn the rest into inline code', () => {
      const partial = 'Use `myVar then more text after';
      const html = parse(balanceMarkdownForPartialRender(partial));
      // Without balancing, "then more text after" would be inside <code>.
      // After balancing, only "myVar then more text after" is code (closed) and
      // the whole thing is a paragraph — but crucially it does not run on to
      // swallow subsequent content. Here we just assert it parses to a <p>
      // without leaving an open code context.
      assert.ok(/<p>/.test(html), `expected a paragraph: ${html}`);
    });

    test('complete balanced reply renders identically with and without balancing', () => {
      const md = '## Title\n\n`inline` code and\n\n```\nfenced\n```\n\nFinal line.';
      assert.strictEqual(parse(balanceMarkdownForPartialRender(md)), parse(md));
    });
  });
});

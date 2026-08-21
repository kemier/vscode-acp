import * as assert from 'assert';
import { Marked } from 'marked';
import { createMathExtension } from '../utils/markdownMath';
import {
  balanceMarkdownForPartialRender,
  hasOpenFence,
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
});

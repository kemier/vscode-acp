import * as assert from 'assert';
import { Marked } from 'marked';
import { ACP_MATH_SPLIT_RE, createMathExtension } from '../utils/markdownMath';

suite('markdownMath', () => {
  const parse = (md: string): string => {
    const m = new Marked();
    m.use(createMathExtension());
    m.setOptions({ breaks: true, gfm: true });
    return m.parse(md) as string;
  };

  // A `$$...$$` span must not swallow a sentence. The tokenizer is lazy ACROSS newlines,
  // so it takes everything between one `$$` and the next and asks looksLikeMath about the
  // whole thing. The signal check counts `_`, `^`, `=` and any TeX command as proof of
  // math — fine for a formula, catastrophic for a sentence containing one. Reported live
  // while the session was editing `k_t` formulas in `讲义_transmla.md`: both carry an
  // underscore, so a paragraph discussing them rendered as one long horizontally
  // scrolling KaTeX block with every space collapsed.
  suite('prose is never swallowed as math', () => {
    const PROSE = "` block. There's no closing ``` — so the whole rest is inside an "
      + 'open fence. The original structure was one fenced block';

    test('a sentence containing an incidental math character stays prose', () => {
      const carriers: Record<string, string> = {
        'underscore (k_t, filename)': ' in 讲义_transmla.md',
        'equals': ' where x = 1',
        'caret': ' at line^39',
        'backslash command': String.raw` \text{x}`,
        'nothing at all': '',
      };
      for (const [why, tail] of Object.entries(carriers)) {
        const html = parse(`$$${PROSE}${tail}$$`);
        assert.ok(!html.includes('acp-math'), `${why} must stay prose: ${html.slice(0, 160)}`);
      }
    });

    test('a fence marker or doubled backtick is never math', () => {
      for (const md of ['$$see ``` here$$', '$$use ``code`` inline$$', '$$~~~ fence$$']) {
        assert.ok(!parse(md).includes('acp-math'), md);
      }
    });

    test('genuine formulas still render, including shapes the veto could catch', () => {
      const good = [
        '$$k_t = W_k h_t$$',
        '$$总数据量 = 批次 × 序列长度 × 隐藏维度$$',
        String.raw`$$\begin{aligned} a &= b + c \\ d &= e + f \end{aligned}$$`,
        String.raw`$$S = \frac{QK^\top}{\sqrt{d_k}} + \text{bias}$$`,
      ];
      for (const md of good) {
        assert.ok(parse(md).includes('acp-math'), `should be math: ${md}`);
      }
    });

    test('the veto needs BOTH many words and sentence punctuation', () => {
      // Many tokens, no sentence stop -> still math (aligned equations look like this).
      assert.ok(parse(String.raw`$$a = b + c + d + e + f + g + h + i + j$$`).includes('acp-math'));
      // A sentence stop with few words -> still math (x = 1. is a formula).
      assert.ok(parse('$$x = 1.$$').includes('acp-math'));
    });
  });

  // CJK math was silently dropped. The content guard demanded an ASCII letter or digit,
  // so a formula whose identifiers are Chinese has none — the operators are the only
  // ASCII present — and it fell through to a paragraph, rendering as literal `$$` text.
  // Observed in a Chinese course document: `$$元素值 = ...$$` and `$$scale编码 = ...$$` sat
  // on adjacent lines and only the second rendered, purely because of the word "scale".
  // That asymmetry is what made it look like a fence/render fault.
  suite('CJK math', () => {
    test('renders display math whose identifiers are CJK', () => {
      for (const md of ['$$元素值 = ...$$', '$$总数据量 = 批次 × 长度$$', '$$scale编码 = ...$$']) {
        const html = parse(md);
        assert.ok(html.includes('acp-math'), `should be math: ${md}`);
        assert.ok(!html.includes('$$'), `delimiters should be consumed: ${md}`);
      }
    });

    test('renders adjacent CJK and ASCII formulas alike', () => {
      // The reported pair, in the order they appeared.
      const html = parse('$$元素值 = ...$$\n$$scale编码 = ...$$');
      assert.strictEqual((html.match(/<acp-math/g) ?? []).length, 2, html);
    });

    test('renders inline CJK math', () => {
      assert.ok(parse(String.raw`维度是 \(输入维度\) 的函数`).includes('<acp-math>'));
    });

    test('still rejects a delimiter placeholder with no letters or digits', () => {
      // The guard exists for this: LLMs write \[ ... \] when DESCRIBING delimiters.
      // Widening it to Unicode must not let a bare ellipsis through.
      for (const md of [String.raw`the math is wrapped in \[ ... \] delimiters`, String.raw`\[ ... \]`]) {
        assert.ok(!parse(md).includes('acp-math'), `should stay prose: ${md}`);
      }
    });
  });

  test('renders inline \\(...\\) as KaTeX', () => {
    const html = parse(String.raw`Score \(S=QK^\top/\sqrt{d}\) in HBM`);
    assert.ok(html.includes('<acp-math>'), html);
    assert.ok(html.includes('katex'), html);
    assert.ok(!html.includes('\\('), `delimiters should be consumed: ${html}`);
    assert.ok(!html.includes('data-display'), 'inline must not be display mode');
  });

  test('renders multiple inline math expressions in one paragraph', () => {
    const html = parse(String.raw`From \(O(N^2)\) down to \(O(Nd)\).`);
    const matches = html.match(/<acp-math>/g) ?? [];
    assert.strictEqual(matches.length, 2, html);
  });

  test('renders display \\[...\\] as KaTeX', () => {
    const html = parse(String.raw`Before

\[
\text{hello}
\]

After`);
    assert.ok(html.includes('<acp-math data-display="1">'), html);
    assert.ok(html.includes('katex'), html);
    assert.ok(html.includes('Before') && html.includes('After'), html);
    assert.ok(!html.includes('\\['), `delimiters should be consumed: ${html}`);
  });

  test('renders $$ display math', () => {
    const html = parse('$$\nx^2+y^2\n$$');
    assert.ok(html.includes('<acp-math data-display="1">'), html);
    assert.ok(html.includes('katex'), html);
  });

  test('leaves fenced code alone (does not treat \\( as math)', () => {
    const html = parse('```\n\\(not math\\)\n```');
    assert.ok(!html.includes('<acp-math'), html);
    assert.ok(html.includes('<pre>') || html.includes('<code>'), html);
  });

  test('leaves inline code alone', () => {
    // Markdown: Use `\(x\)` literally
    const html = parse('Use `\\(x\\)` literally');
    assert.ok(!html.includes('<acp-math'), html);
  });

  test('does not treat bare $currency$ as math', () => {
    const html = parse('Costs $12 and $34 more');
    assert.ok(!html.includes('<acp-math'), html);
    assert.ok(html.includes('$12') || html.includes('12'), html);
  });

  test('invalid TeX does not throw and still wraps output', () => {
    assert.doesNotThrow(() => {
      const html = parse(String.raw`Bad \(\frac{1}{\) formula`);
      assert.ok(typeof html === 'string' && html.length > 0, html);
    });
  });

  test('does not treat escaped-punctuation prose as math (regex char class)', () => {
    // LLM describes regex metacharacters with LaTeX-escaped punctuation.
    // Regression: this used to swallow the whole span into \(...\) KaTeX.
    const html = parse(String.raw`matches a single char that is \(, \[, 0-9, a-f, \{, 8, or \). I need`);
    assert.ok(!html.includes('<acp-math'), html);
    // marked de-escapes the \( to ( — the key regression check is that the
    // span is NOT swallowed by the math tokenizer and prose survives verbatim.
    assert.ok(html.includes('matches a single char that is'), html);
    assert.ok(html.includes('0-9') && html.includes('a-f') && html.includes('or )'), html);
  });

  test('does not treat a wrapped regex as display math', () => {
    // Model wraps the whole char class in \[...\].
    const html = parse(String.raw`I need \[[([0-9a-f]{8})]\] for the UUID pattern.`);
    assert.ok(!html.includes('<acp-math'), html);
    assert.ok(html.includes('[([0-9a-f]{8})]'), html);
    assert.ok(html.includes('for the UUID pattern'), html);
  });

  test('still renders genuine math with commands', () => {
    const html = parse(String.raw`Score \(S=QK^\top/\sqrt{d}\) in HBM`);
    assert.ok(html.includes('<acp-math>'), html);
    assert.ok(html.includes('katex'), html);
  });

  test('still renders inline math with superscript', () => {
    const html = parse(String.raw`From \(O(N^2)\) down to \(O(Nd)\).`);
    assert.strictEqual((html.match(/<acp-math>/g) ?? []).length, 2, html);
  });

  test('still renders display math with \text', () => {
    const html = parse(String.raw`Before

\[
\text{hello}
\]

After`);
    assert.ok(html.includes('<acp-math data-display="1">'), html);
    assert.ok(html.includes('Before') && html.includes('After'), html);
  });
  test('mixed markdown keeps headings/lists around math', () => {
    const html = parse(String.raw`## Idea

- Q, K, V — \(O(Nd)\)
- Max \(m_i\)

Done`);
    assert.ok(html.includes('<h2') || html.includes('<h2>'), html);
    assert.ok(html.includes('<li>'), html);
    assert.ok((html.match(/<acp-math>/g) ?? []).length >= 2, html);
  });

  test('ACP_MATH_SPLIT_RE skips rendered math blocks for linkify', () => {
    const html = parse(String.raw`See \(ConfigDataPrivate\) and path`);
    assert.ok(html.includes('<acp-math>'), html);
    const re = new RegExp(`(${ACP_MATH_SPLIT_RE}|<a\\s[^>]*>.*?</a>)`, 'gs');
    const parts = html.split(re);
    // Odd parts are skipped segments; at least one should be the acp-math wrapper.
    const skipped = parts.filter((_, i) => i % 2 === 1);
    assert.ok(
      skipped.some((p) => p.startsWith('<acp-math')),
      `expected acp-math in skipped parts: ${JSON.stringify(skipped.slice(0, 3))}`,
    );
  });
});

/**
 * A math delimiter QUOTED in prose must not be rendered as math.
 *
 * Reported as a streaming render bug and reproduced byte for byte. A block-level
 * marked extension is offered start() so the paragraph tokenizer knows where to
 * stop, and that cut ignores inline context — so a `\[` inside a code span split
 * the paragraph there. The sentence
 *
 *   the math is wrapped in **`\[ ... \]`** delimiters
 *
 * rendered as a paragraph ending in a literal "**`", then a centred KaTeX block
 * containing "…", then a third paragraph starting "`** delimiters": both the bold
 * and the code span broken open. Conversations about math delimiters are common
 * enough that this shape has to be rejected before the cut.
 */
suite('markdownMath: delimiters quoted in prose', () => {
  const parse = (md: string): string => {
    const m = new Marked();
    m.use(createMathExtension());
    m.setOptions({ breaks: true, gfm: true });
    return m.parse(md) as string;
  };

  const BOLD_CODE = 'the math is wrapped in **`\\[ ... \\]`** delimiters';

  test('the reported sentence renders as bold code, not as math', () => {
    const html = parse(BOLD_CODE);
    assert.ok(!html.includes('acp-math'), `a quoted delimiter is not math: ${html}`);
    assert.ok(html.includes('<strong><code>'), `bold + code span must survive: ${html}`);
    assert.ok(!html.includes('**'), `no literal bold marker may leak: ${html}`);
    assert.strictEqual((html.match(/<p>/g) ?? []).length, 1, `must stay ONE paragraph: ${html}`);
  });

  test('an ellipsis placeholder is not math even unquoted', () => {
    // How these conversations write ABOUT delimiters. The compact-form rule accepted
    // it (no whitespace, under 40 chars) and rendered a centred ellipsis.
    assert.ok(!parse('\\[ ... \\]').includes('acp-math'));
    assert.ok(!parse('$$ ... $$').includes('acp-math'));
  });

  test('a fenced block containing \\[ is untouched', () => {
    const html = parse('```\n\\[\n\\mathrm{LSE}_r = m_r\n\\]\n```');
    assert.ok(!html.includes('acp-math'), html);
    assert.ok(html.includes('<pre><code>'), html);
  });

  test('real math still renders, beside a code span and after it', () => {
    const inline = parse('In `file.md` the value is \\(x^2\\) exactly');
    assert.ok(inline.includes('<acp-math>'), `real math must still render: ${inline}`);
    assert.ok(inline.includes('<code>file.md</code>'), inline);
    const display = parse('Result:\n\n\\[\nE = mc^2\n\\]\n');
    assert.ok(display.includes('<acp-math data-display="1">'), display);
  });

  test('a code span earlier in the line does not block later real math', () => {
    // Backtick parity, not "any backtick before it": the span is closed here.
    const html = parse('Given `n` items, \\(O(n^2)\\) holds');
    assert.ok(html.includes('<acp-math>'), html);
  });
});

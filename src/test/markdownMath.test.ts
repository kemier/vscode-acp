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

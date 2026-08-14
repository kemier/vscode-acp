import katex from 'katex';
import type { MarkedExtension, Tokens } from 'marked';

/**
 * True when the text between `\(`/`\[` and the matching `\)`/`\]` looks like
 * actual math. Blocks math-extension false positives on prose that merely
 * contains LaTeX-escaped punctuation (regex char classes, shell tokens).
 *
 * LLMs frequently describe regex metacharacters / shell tokens / punctuation
 * using LaTeX-escaped forms: `\(, \[, 0-9, a-f, \{, 8, or \)`. Without a
 * content guard the inline tokenizer matches the FIRST `\(` and the LAST `\)`
 * in the paragraph, swallowing all prose between them and rendering it as
 * KaTeX (visible as red/garbage LaTeX). We demand at least one explicit math
 * signal before treating a span as math:
 *   - a backslash command (`\sqrt`, `\frac`, `\text`, ...)
 *   - a super/subscript or accent (`^`, `_`, `~`)
 *   - an equality sign (`=`)
 * Genuine LLM math virtually always carries one of these, while an escaped
 * punctuation enumeration (`\( \` \[ \` ...`) never does.
 */
function looksLikeMath(tex: string): boolean {
  const t = tex.trim();
  if (!t) {
    return false;
  }
  // Strong math signals: TeX command, super/subscript/accent, equality.
  if (/(?:\\[A-Za-z@]+\b|[\^_~]|=)/.test(t)) {
    return true;
  }
  // Square brackets inside an otherwise operator-free span are a regex /
  // shell char-class listing (`[([0-9a-f]{8})]`), not math. Real math uses
  // `\left[ \right]` (a command, already caught above).
  if (/[[\]]/.test(t) && !/(?:\\left|\\right|\\big[gl]?\[)/.test(t)) {
    return false;
  }
  // Escaped-punctuation enumeration — the false-positive shape. LLMs writing
  // about regex/shell tokens emit `\(, \[, \{, \)` etc. as a list. Real math
  // spans never contain more than one escaped punctuation char (and even one
  // only appears in set notation like `\{a, b\}`). Two or more means prose.
  const escapedPunct = t.match(/\\[()[\]{}_,.!?;:<>"]/g) ?? [];
  if (escapedPunct.length >= 2) {
    return false;
  }
  // Comma/space separated enumeration with prose words — a list, not math.
  if (/(?:, | or | and )/.test(t)) {
    return false;
  }
  // Compact function-application / identifier form: `O(Nd)`, `O(1)`,
  // `ConfigDataPrivate`, `x`. No spaces, short. This keeps legitimate inline
  // math that happens to lack operators rendering correctly.
  if (!/\s/.test(t) && t.length >= 1 && t.length <= 40) {
    return true;
  }
  return false;
}

/**
 * Render TeX to KaTeX HTML wrapped in a custom element so post-processors
 * (auto-linkify) can skip the whole subtree without choking on nested spans.
 */
function renderKatex(tex: string, displayMode: boolean): string {
  const html = katex.renderToString(tex, {
    throwOnError: false,
    displayMode,
    strict: 'ignore',
    output: 'html',
  });
  return `<acp-math${displayMode ? ' data-display="1"' : ''}>${html}</acp-math>`;
}

/**
 * Marked extension for LLM-style math delimiters:
 * - inline: `\(...\)`
 * - display: `\[...\]` and `$$...$$`
 *
 * Single `$...$` is intentionally unsupported — too many false positives with
 * currency and shell variables. Prefer `\(...\)` (what Cursor/Codex emit).
 */
export function createMathExtension(): MarkedExtension {
  return {
    extensions: [
      {
        name: 'blockKatex',
        level: 'block',
        start(src: string): number | undefined {
          const bracket = src.indexOf('\\[');
          const dollars = src.indexOf('$$');
          if (bracket < 0) {
            return dollars < 0 ? undefined : dollars;
          }
          if (dollars < 0) {
            return bracket;
          }
          return Math.min(bracket, dollars);
        },
        tokenizer(src: string): Tokens.Generic | undefined {
          let m = /^\\\[([\s\S]+?)\\\]/.exec(src);
          if (m && looksLikeMath(m[1])) {
            return { type: 'blockKatex', raw: m[0], text: m[1].trim() };
          }
          m = /^\$\$([\s\S]+?)\$\$/.exec(src);
          if (m && looksLikeMath(m[1])) {
            return { type: 'blockKatex', raw: m[0], text: m[1].trim() };
          }
          return undefined;
        },
        renderer(token: Tokens.Generic): string {
          return `${renderKatex(String(token.text ?? ''), true)}\n`;
        },
      },
      {
        name: 'inlineKatex',
        level: 'inline',
        start(src: string): number | undefined {
          const i = src.indexOf('\\(');
          return i < 0 ? undefined : i;
        },
        tokenizer(src: string): Tokens.Generic | undefined {
          const m = /^\\\(([\s\S]+?)\\\)/.exec(src);
          if (!m || !looksLikeMath(m[1])) {
            return undefined;
          }
          return { type: 'inlineKatex', raw: m[0], text: m[1].trim() };
        },
        renderer(token: Tokens.Generic): string {
          return renderKatex(String(token.text ?? ''), false);
        },
      },
    ],
  };
}

/** Regex fragment: skip rendered math when splitting HTML for auto-linkify. */
export const ACP_MATH_SPLIT_RE = '<acp-math\\b[^>]*>[\\s\\S]*?</acp-math>';

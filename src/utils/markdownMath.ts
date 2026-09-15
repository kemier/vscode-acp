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
  // No letter and no digit means no math. This is what let `\[ ... \]` render:
  // LLMs write that as a PLACEHOLDER when describing delimiters ("the math is
  // wrapped in `\[ ... \]`"), and the compact-form rule at the bottom accepted it
  // because an ellipsis has no whitespace and is under 40 chars. It rendered as a
  // centred KaTeX "…" in the middle of a sentence.
  //
  // Unicode-aware on purpose. An ASCII-only class silently rejected every CJK
  // formula, because the label carries the meaning and the operators are the only
  // ASCII present: `$$元素值 = ...$$` and `$$总数据量 = 批次 × 长度$$` both fell through
  // to a paragraph and rendered as literal `$$` text, while `$$scale编码 = ...$$`
  // beside them rendered correctly purely because of the word "scale". Observed in a
  // Chinese course document, where it looked like a fence/render fault.
  // `\p{L}\p{N}` still rejects the `\[ ... \]` placeholder — an ellipsis has neither.
  if (!/[\p{L}\p{N}]/u.test(t)) {
    return false;
  }
  // PROSE VETO — runs before the strong-signal check on purpose.
  //
  // The signal check treats `_`, `^`, `=` and any `\command` as proof of math. That is
  // fine for a formula but catastrophic for a SENTENCE that happens to contain one,
  // because the `$$...$$` tokenizer is lazy across newlines: it takes everything from
  // one `$$` to the next and hands the whole span here. Reported live while the session
  // was editing `k_t` formulas in `讲义_transmla.md` — both contain an underscore, so a
  // paragraph discussing them passed the signal check and rendered as one long
  // horizontally-scrolling KaTeX block with every space collapsed:
  //
  //   'block.There'snoclosing''''—sothewholerestisinsideanopenfence.
  //
  // Two things a formula never contains, and prose about markdown always does:
  //  1. A code-fence marker or a doubled backtick. TeX has no use for either.
  if (/```|~~~|``/.test(t)) {
    return false;
  }
  //  2. Several words AND sentence punctuation. Required together, so a multi-line
  //     aligned equation (many whitespace-separated tokens, no sentence stops) still
  //     renders, while an English or Chinese sentence does not.
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length >= 8 && /[.!?。！？；][\s"')\]]|[.!?。！？；]$/.test(t)) {
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
 * True when `idx` in `src` sits inside code — a fenced block or an inline span.
 *
 * A block-level marked extension is offered `start()` so the paragraph tokenizer
 * knows where to stop, and that cut happens with no regard for inline context. So
 * a `\[` inside an inline code span split the paragraph there, and the sentence
 *
 *   the math is wrapped in **`\[ ... \]`** delimiters
 *
 * rendered as: a paragraph ending in a literal "**`", a centred KaTeX block, and a
 * third paragraph starting "`** delimiters" — with the bold and the code span both
 * broken open. Text ABOUT math delimiters is common in these conversations, so the
 * candidate has to be rejected before the cut.
 *
 * Fenced blocks were already safe (their own tokenizer consumes the fence before
 * the extension sees a block boundary) but are checked anyway: `start()` scans the
 * whole remaining source, not just the current block.
 */
function isInsideCode(src: string, idx: number): boolean {
  const before = src.slice(0, idx);
  const fences = before.match(/^[ \t]*(?:```|~~~)/gm) ?? [];
  if (fences.length % 2 === 1) {
    return true;
  }
  // Inline spans do not cross a blank line, so only the current line matters.
  const lineStart = before.lastIndexOf('\n') + 1;
  const ticks = before.slice(lineStart).match(/`+/g) ?? [];
  return ticks.length % 2 === 1;
}

/** First occurrence of `needle` that is not inside code, or -1. */
function firstOutsideCode(src: string, needle: string): number {
  let from = 0;
  for (;;) {
    const i = src.indexOf(needle, from);
    if (i < 0) {
      return -1;
    }
    if (!isInsideCode(src, i)) {
      return i;
    }
    from = i + needle.length;
  }
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
          const bracket = firstOutsideCode(src, '\\[');
          const dollars = firstOutsideCode(src, '$$');
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
          const i = firstOutsideCode(src, '\\(');
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

import katex from 'katex';
import type { MarkedExtension, Tokens } from 'marked';

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
          if (m) {
            return { type: 'blockKatex', raw: m[0], text: m[1].trim() };
          }
          m = /^\$\$([\s\S]+?)\$\$/.exec(src);
          if (m) {
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
          if (!m) {
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

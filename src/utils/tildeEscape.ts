/**
 * Escape `~` in plain prose that GFM (marked, gfm: true) would misparse as the
 * delimiter of a single-tilde strikethrough.
 *
 * marked's GFM tokenizer treats a single `~` flanked by non-whitespace on the
 * right as the START of a strikethrough, pairing it with the next such `~`. So
 * model prose like `baseline~26 and throttled~260` or `fs@vsfo-N:~$ /
 * root@vsfo-N:~#` renders a line through the middle of the text. A `~` inside
 * a backtick code span (e.g. `~/.netrc`, `~/.cargo/bin/rtk`) is protected and
 * never strikes; a `~` followed by a space (e.g. `~ 173`) also never strikes.
 *
 * This function escapes only the strike-risk shape: a single `~` in plain
 * prose (not inside a code span) whose next character is non-whitespace. Runs
 * of `~~` (a real `~~text~~` strikethrough) are left intact. It is
 * code-span-aware and safe to run on partial (streaming) text — it never
 * crosses a backtick boundary.
 */
export function escapeUnbalancedTildes(text: string): string {
  if (!text.includes('~')) return text;
  let out = '';
  let inCode = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '`') {
      inCode = !inCode;
      out += c;
      continue;
    }
    if (c === '~' && !inCode) {
      // Already escaped (a backslash precedes it) — leave it, so the function
      // is idempotent if ever run twice on the same text.
      if (out.endsWith('\\')) {
        out += c;
        continue;
      }
      // Count the run of ~. A run of >= 2 is a real ~~...~~ strikethrough:
      // copy it verbatim so genuine strikethrough is preserved.
      let run = 1;
      while (text[i + run] === '~') run++;
      if (run >= 2) {
        for (let k = 0; k < run; k++) out += '~';
        i += run - 1;
        continue;
      }
      // Single ~ in plain prose: strike risk only when glued to a
      // non-whitespace char on the right (the model's "approximate ~" shape).
      const nxt = text[i + 1];
      if (nxt && nxt !== ' ' && nxt !== '\n') {
        out += '\\~';
        continue;
      }
    }
    out += c;
  }
  return out;
}

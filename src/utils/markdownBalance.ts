/**
 * Close unterminated markdown code spans so PARTIAL text renders cleanly.
 *
 * `renderMarkdown` is called on INCOMPLETE assistant text in two situations:
 *  - streaming render (~every 80ms, on the text accumulated so far), and
 *  - interim commits at tool-call boundaries (`commitCurrentTextSegment`
 *    with `interim: true`), which permanently commit the text-so-far and
 *    reset the buffer — so any closing fence/backtick that arrives later
 *    lands in a SEPARATE history entry.
 *
 * If the model is mid-way through writing a fenced block (```` ``` ````) or an
 * inline code span (`` ` ``), the partial text has an unbalanced delimiter.
 * marked then treats everything after the opening delimiter as code and
 * renders the assistant's prose as a code block — permanently, for an
 * interim-committed segment. This appends the missing closing delimiter(s) so
 * the partial text is always well-formed markdown. A complete, balanced reply
 * has matching open/close counts, so nothing is appended and the final render
 * is unaffected.
 */

/**
 * Returns text with any open fenced code block closed and any unbalanced
 * inline code backticks closed, so marked.parse renders it without treating
 * trailing prose as code.
 */
export function balanceMarkdownForPartialRender(text: string): string {
  // --- Fenced code blocks (``` or longer runs) ---
  // Pair up fences of length >= 3. If one is left open, close it with a
  // matching-length run so marked ends the <pre><code> block.
  const fenceMatches = text.match(/```+/g);
  if (fenceMatches) {
    let openFenceLen = 0;
    for (const f of fenceMatches) {
      if (f.length >= 3) {
        if (openFenceLen === f.length) {
          openFenceLen = 0; // closes the open fence
        } else if (openFenceLen === 0) {
          openFenceLen = f.length; // opens a fence
        }
        // A different-length run while one is open: treat as content, ignore.
      }
    }
    if (openFenceLen > 0) {
      return text + '\n' + '`'.repeat(openFenceLen);
    }
  }

  // --- Inline code spans (single backtick, not part of a ```+ run) ---
  // Strip fence runs first so their backticks aren't counted here, then close
  // a lone opening backtick so marked doesn't render the rest as inline code.
  const withoutFences = text.replace(/```+/g, '');
  const inlineBackticks = (withoutFences.match(/`/g) || []).length;
  if (inlineBackticks % 2 !== 0) {
    return text + '`';
  }
  return text;
}

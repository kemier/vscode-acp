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
 * If the model is mid-way through writing a fenced block (```` ``` ````), the
 * partial text has an unbalanced `` ``` `` run. marked then treats everything
 * after the opening fence as code — including the assistant's trailing prose —
 * until a closing fence arrives. This closes the open fence so the partial
 * text is always well-formed markdown.
 *
 * NOTE: inline code spans (single `` ` `` backticks) are deliberately NOT
 * auto-balanced. marked renders a trailing lone backtick as literal text
 * (verified: `` `stray `` -> ``<p>... `stray</p>``, it never swallows
 * following prose into a <code> span). Closing an odd inline backtick instead
 * CREATES a false <code> capsule: quoting user input that itself ends with a
 * stray backtick (e.g. `` `"), I need ``) gets "balanced" into
 * <code>"), I need</code> — exactly the false "capsule" rendering users
 * reported on messages like `The character class ... or ). I need ``.
 * Fences are the only delimiter where marked swallows trailing prose, so
 * fences are the only thing we balance.
 */

/**
 * Returns text with any open fenced code block closed, so marked.parse
 * renders it without treating trailing prose as code. Inline code backticks
 * are left alone — marked renders stray backticks literally (see above).
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

  return text;
}

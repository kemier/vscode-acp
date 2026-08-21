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

/**
 * True if `text` ends inside an unclosed fenced code block (an open ``` run
 * with no matching close). Used to decide whether an INTERIM commit is safe.
 *
 * The fence-swallow bug: when an assistant message is split across a tool
 * boundary (text → tool → text) and the model had opened a fenced block in
 * the first segment, the closing fence lands in a LATER segment. Interim-
 * committing the first segment traps everything after the opening fence
 * (including trailing prose) inside a <pre><code> block — the dark "shadow"
 * box users reported, with the in-fence content wrapping across lines.
 *
 * The fix: don't interim-commit a segment that ends mid-fence. Keep it
 * buffered in currentAssistantText (the streaming render still shows it,
 * balanced) and let it commit at the next boundary — or at promptEnd, where
 * the full text is available and the fence is either genuinely closed by
 * the model or balanced for the final render.
 */
export function hasOpenFence(text: string): boolean {
  const fenceMatches = text.match(/```+/g);
  if (!fenceMatches) { return false; }
  let openFenceLen = 0;
  for (const f of fenceMatches) {
    if (f.length >= 3) {
      if (openFenceLen === f.length) {
        openFenceLen = 0; // closes the open fence
      } else if (openFenceLen === 0) {
        openFenceLen = f.length; // opens a fence
      }
    }
  }
  return openFenceLen > 0;
}

/**
 * Strip a LONE EMPTY trailing fence run from text that ends inside an open
 * fenced code block.
 *
 * Used by the webview's INTERRUPTED commit path (`commitCurrentTextSegment`
 * with `interrupted: true`). When a turn is cancelled right after the model
 * opened a fenced block but streamed nothing after the opener (only
 * whitespace), the final render's `balanceMarkdownForPartialRender` closes
 * the open fence and leaves a PERMANENT empty `<pre><code>` box — the "empty
 * code fence started block" artifact. The normal streaming path self-heals
 * because the next chunk triggers a fresh render; an interrupted commit has
 * no next chunk, so the empty fence must be removed at commit time.
 *
 * Fences that DO have real content after the opener (unterminated but
 * non-empty code) are left intact so the partial reply is preserved as code.
 *
 * Returns null when there is nothing to strip (no open fence, or the trailing
 * fence run has content after it). Otherwise returns the text with the lone
 * trailing fence removed.
 */
export function stripLoneTrailingFence(text: string): string | null {
  // Parity with hasOpenFence: only operate when the text is inside an
  // open fence — otherwise the trailing run is part of a balanced pair and
  // must not be touched.
  if (!hasOpenFence(text)) { return null; }
  // The trailing fence run may be followed only by whitespace to EOL.
  const loneFenceRe = /```+[\s]*$/;
  if (!loneFenceRe.test(text)) { return null; }
  const stripped = text.replace(loneFenceRe, '').replace(/\s+$/, '');
  return stripped;
}

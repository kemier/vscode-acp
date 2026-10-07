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
/**
 * Fence runs that actually OPEN or CLOSE a fenced block.
 *
 * CommonMark requires a fence to begin a line (up to three leading spaces). A run in
 * the MIDDLE of a line is not a fence — marked renders it literally.
 *
 * Matching every ``` run regardless of position produced a visible artifact: an
 * assistant message reading "after line 9540, the closing ``` of the PagedAttention
 * section" has one mid-sentence run, so the text was judged to have an open fence and a
 * closing run was appended. marked had rendered that prose literally (correctly), so the
 * appended run became an opener with nothing after it — an empty code block at the end
 * of the message, complete with a Copy button.
 *
 * Anchored with the m flag and an optional 0-3 space indent, so only real fences count.
 */
function fenceRuns(text: string): string[] {
  const out: string[] = [];
  const re = /^ {0,3}(```+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(m[1] as string);
  }
  return out;
}

/**
 * Compute the leading indent needed for a fenced block to stay INSIDE a list
 * item. A fenced block on the same line column as a list item's marker
 * (e.g. 0-2 spaces for "1. ") ends the item and escapes into the document
 * body, which collapses the surrounding list. A fence indented to the item's
 * CONTENT column renders as a code block inside the <li> and the list
 * continues. Returns 0 when the line is not a list item (no indent needed).
 *
 * lineBefore is the text on the current line up to (not including) the point
 * where the fence would open. For "2. User bubble:" the marker is "2." and the
 * content column is 3; we use the larger of the content column and
 * (lead + marker + 1) — the minimum indent CommonMark needs to keep the block
 * attached to the item.
 */
function listContentIndent(lineBefore: string): number {
  const m = lineBefore.match(/^(\s*)(\d+\.|\-|\*|\+)(\s+)(.*)$/);
  if (!m) {return 0;}
  const lead = m[1].length;
  const marker = m[2].length;
  const space = m[3].length;
  const contentCol = lead + marker + space;
  return Math.max(contentCol, lead + marker + 1);
}

/**
 * Repair single-backtick inline code spans that CONTAIN A NEWLINE.
 *
 * A CommonMark inline code span CANNOT hold a line break. When the model
 * writes a list item like:
 *
 *     2. User bubble: `<newline><local-command-caveat>...</local-command-caveat>`
 *
 * the backtick opens, the span content starts on the next line, and marked
 * breaks the span at the newline. The consequences, in a numbered/bulleted
 * list:
 *   - the item's stray backtick renders literally,
 *   - the list is terminated at that newline (a list item cannot span a blank
 *     line), so every FOLLOWING item is demoted out of the <ol>/<ul> into a
 *     <p> paragraph,
 *   - the remaining backticks pair up into wrong inline <code> capsules.
 *
 * This is the "bullets not aligned" bug: item 1 stays a list item, item 2
 * ends in a stray backtick, and items 3+ become a mis-indented paragraph with
 * their numbers rendered as code pills.
 *
 * The model's INTENT was to show the snippet as code. Two repairs, chosen by
 * how many spans share the item line:
 *   - TIER 1 (sole span on the line): convert to a FENCED block, indented to
 *     the list content column so it stays inside the <li>. Full fidelity — the
 *     multi-line snippet renders as a code block and the list stays aligned.
 *   - TIER 2 (multiple spans on the line, or not in a list): collapse the
 *     newlines inside the span to spaces, making it a valid single-line
 *     inline <code>. It no longer breaks the list.
 *
 * A balanced single-line span (`code`) and any fenced block (```) are left
 * untouched — this only fires on the malformed newline-in-span case.
 */
export function repairMultiLineInlineCode(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (text[i] !== '`') {
      out += text[i];
      i++;
      continue;
    }
    // Count the backtick run that opens here.
    let run = 0;
    while (i + run < n && text[i + run] === '`') {run++;}
    const openLen = run;
    // Find the matching closing run of the SAME length. A longer run is a
    // fence (handled by the fence balancer) or a different span — not our
    // closer, so skip past it.
    let j = i + openLen;
    let closeIdx = -1;
    while (j < n) {
      if (text[j] === '`') {
        let r = 0;
        while (j + r < n && text[j + r] === '`') {r++;}
        if (r === openLen) {
          closeIdx = j;
          break;
        }
        j += r;
      } else {
        j++;
      }
    }
    if (closeIdx < 0) {
      // No matching closer — emit the run and let the rest be scanned.
      out += '`'.repeat(openLen);
      i += openLen;
      continue;
    }
    const content = text.slice(i + openLen, closeIdx);
    const isMultiLineSpan = openLen === 1 && content.includes('\n');
    if (isMultiLineSpan) {
      // Is this span the ONLY backtick span on its line?
      const lineStart = text.lastIndexOf('\n', i) + 1;
      const eolAfter = text.indexOf('\n', closeIdx);
      const lineEnd = eolAfter < 0 ? n : eolAfter;
      const lineText = text.slice(lineStart, lineEnd);
      const backticksOnLine = (lineText.match(/`/g) || []).length;
      const soleOnLine = backticksOnLine === 2; // exactly this open + close
      if (soleOnLine) {
        // TIER 1: fenced block, indented to the list content column.
        const lineBefore = text.slice(lineStart, i);
        const indent = listContentIndent(lineBefore);
        const pad = indent > 0 ? ' '.repeat(indent) : '';
        let body = content;
        if (body.startsWith('\n')) {body = body.slice(1);}
        if (body.endsWith('\n')) {body = body.slice(0, -1);}
        out += '\n' + pad + '```\n';
        for (const l of body.split('\n')) {out += pad + l + '\n';}
        out += pad + '```';
      } else {
        // TIER 2: collapse newlines so it is a valid single-line inline span.
        out += '`' + content.replace(/\n+/g, ' ') + '`';
      }
      i = closeIdx + openLen;
      continue;
    }
    // Not a multi-line single-backtick span: emit open run + content + close
    // run verbatim.
    out += text.slice(i, closeIdx + openLen);
    i = closeIdx + openLen;
  }
  return out;
}

export function balanceMarkdownForPartialRender(text: string): string {
  // --- Inline code spans that contain a newline ---
  // A single-backtick span cannot hold a line break (CommonMark). When the
  // model writes one inside a list item, the newline breaks the span AND
  // terminates the list, demoting the following items into a paragraph —
  // the "bullets not aligned" artifact. Repair these FIRST, so any fenced
  // block the repair introduces is counted by the fence pairing below.
  const repaired = repairMultiLineInlineCode(text);

  // --- Fenced code blocks (``` or longer runs) ---
  // Pair up fences of length >= 3. If one is left open, close it with a
  // matching-length run so marked ends the <pre><code> block.
  const fenceMatches = fenceRuns(repaired);
  if (fenceMatches.length > 0) {
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
      return repaired + '\n' + '`'.repeat(openFenceLen);
    }
  }

  return repaired;
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
  // Run the same inline-span repair the balancer uses, so the fence pairing
  // here matches what balanceMarkdownForPartialRender will actually render.
  // Without this, a segment whose multi-line span the repair converts to a
  // (still-open, partial) fence could be interim-committed as if it had no
  // open fence.
  const fenceMatches = fenceRuns(repairMultiLineInlineCode(text));
  if (fenceMatches.length === 0) { return false; }
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
  // Must START a line (a mid-sentence run is prose, not a fence) AND be the last
  // content in the text. No `m` flag: with it, `$` matches end-of-LINE and a fence
  // with code after it on later lines would match, stripping a partial code block
  // that must be preserved.
  const loneFenceRe = /(?:^|\n) {0,3}```+[\s]*$/;
  if (!loneFenceRe.test(text)) { return null; }
  const stripped = text.replace(loneFenceRe, '').replace(/\s+$/, '');
  return stripped;
}

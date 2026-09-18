/**
 * Mention scanning that ignores text INSIDE an already-inlined context block.
 *
 * `@terminal` / `@clipboard` / `@problems` / `@file:` / `@folder:` are resolved by
 * scanning the outgoing prompt text. That text is not always purely what the user
 * typed: a payload can already be inlined into it — the `<clipboard>` snapshot a
 * queued message carries, or the `<terminal>` / `<problems>` fallback used for
 * agents without `embeddedContext`. A naive scan then treats the payload's own
 * words as user intent.
 *
 * Observed: the clipboard held the text of an earlier warning, which itself began
 * with "@clipboard: …". Sending it produced TWO nested blocks, and the mention was
 * deleted from inside the payload:
 *
 *   <clipboard>
 *   @clipboard: the clipboard was empty when this message      <- attached a second time
 *   </clipboard>
 *
 *   <clipboard>
 *   : the clipboard was empty when this message                <- payload, mention eaten
 *   </clipboard>
 *
 * The same hazard applies across mentions: a pasted snippet mentioning `@terminal`
 * would attach the terminal buffer and lose the word from the quoted text.
 *
 * So a mention only counts when it lies OUTSIDE every context block, and removal
 * only touches those positions. Content is never rewritten.
 */

/**
 * Tags whose bodies are payload, not prose.
 *
 * Kept in sync with the blocks the send path inlines and the webview's
 * `cleanUserMessage` strips.
 */
const OPAQUE_TAGS = [
  'clipboard',
  'terminal',
  'problems',
  'selection',
  'open_files',
  'file',
  'folder',
  'context',
  'agent-memory',
];

export interface Range {
  start: number;
  end: number;
}

/** Merge overlapping/adjacent ranges, sorted by start. */
function merge(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/**
 * Spans covered by an inlined context block, `<tag …>…</tag>` inclusive.
 *
 * An UNCLOSED opening tag is ignored rather than treated as running to the end of
 * the text: the user may simply have typed `<file` mid-sentence, and swallowing the
 * rest of their message would silently drop the real prompt.
 */
export function contextBlockRanges(text: string): Range[] {
  const src = String(text || '');
  const ranges: Range[] = [];
  for (const tag of OPAQUE_TAGS) {
    const open = `<${tag}`;
    const close = `</${tag}>`;
    let i = 0;
    for (;;) {
      const start = src.indexOf(open, i);
      if (start < 0) {
        break;
      }
      const end = src.indexOf(close, start);
      if (end < 0) {
        break;
      }
      ranges.push({ start, end: end + close.length });
      i = end + close.length;
    }
  }
  return merge(ranges);
}

/**
 * Spans occupied by text the user PASTED, which is quoted content rather than
 * prose they authored.
 *
 * A mention only counts when it lies outside every context block — but that rule
 * assumes the payload is already wrapped in a tag. Text pasted inline is not:
 * a short paste deliberately falls through to the caret as raw characters (see
 * isPayloadSizedPaste), so a mention inside it sits in plain prose position and
 * is indistinguishable from one the user typed to request an attachment.
 *
 * Observed 2026-09-18T07:50, ACP Traffic line 65685. The clipboard held a sentence
 * that began with the literal word "@clipboard" (a quote of the warning about where
 * mentions attach). Pasting it put that word at offset 0, the leading-mention rule
 * fired, and the send stripped the word and attached the clipboard — whose content
 * was the same sentence:
 *
 *   <clipboard>
 *   @clipboard only attaches at the start of a line. Put it on its own line …
 *   </clipboard>
 *
 *   only attaches at the start of a line. Put it on its own line …
 *   ^ subject eaten; the sentence no longer says what it is about
 *
 * The position rule cannot separate these, because position is exactly what the
 * paste changed. Provenance can: the webview knows which strings arrived by paste
 * and sends them along, so a mention inside one is read as the quote it is.
 *
 * Matched by exact occurrence rather than remembered offsets: if the user edits
 * inside the pasted text the match lapses and the mention becomes a request again,
 * which is the right outcome — they have since made it their own words.
 */
export function pastedLiteralRanges(text: string, pastedTexts?: readonly string[]): Range[] {
  const src = String(text || '');
  if (!Array.isArray(pastedTexts) || pastedTexts.length === 0) {
    return [];
  }
  const ranges: Range[] = [];
  for (const raw of pastedTexts) {
    const needle = String(raw ?? '');
    // A short needle (or one that is only whitespace) would match everywhere and
    // silently disable mention resolution; require something substantive.
    if (needle.trim().length < 2) {
      continue;
    }
    let i = 0;
    for (;;) {
      const at = src.indexOf(needle, i);
      if (at < 0) {
        break;
      }
      ranges.push({ start: at, end: at + needle.length });
      // Progress must be monotonic, and indexOf does not guarantee it: for an empty
      // needle it CLAMPS the start index, so indexOf('', 99) returns src.length and
      // `at` sticks there while `i` climbs — an infinite loop that appends a range per
      // iteration until the process dies. Verified: with the length guard above
      // relaxed, this OOM-killed the whole test run (4 GB) instead of failing an
      // assertion. The guard makes it unreachable; this makes it impossible.
      const next = at + needle.length;
      if (next <= i) {
        break;
      }
      i = next;
    }
  }
  return merge(ranges);
}

/** True when `index` falls inside any of `ranges`. */
export function indexInRanges(index: number, ranges: readonly Range[]): boolean {
  return ranges.some((r) => index >= r.start && index < r.end);
}

/** The complement of {@link contextBlockRanges}: the parts that are user prose. */
export function proseRanges(text: string): Range[] {
  const src = String(text || '');
  const blocks = contextBlockRanges(src);
  const out: Range[] = [];
  let cursor = 0;
  for (const b of blocks) {
    if (b.start > cursor) {
      out.push({ start: cursor, end: b.start });
    }
    cursor = Math.max(cursor, b.end);
  }
  if (cursor < src.length) {
    out.push({ start: cursor, end: src.length });
  }
  return out;
}

function withFlags(re: RegExp, flags: string): RegExp {
  const merged = Array.from(new Set((re.flags + flags).split(''))).join('');
  return new RegExp(re.source, merged);
}

/**
 * True when the pattern occurs in prose — inside a payload does not count, and
 * neither does inside text the user pasted (see {@link pastedLiteralRanges}).
 */
export function hasMentionOutsideContext(
  text: string,
  re: RegExp,
  pastedTexts?: readonly string[],
): boolean {
  const src = String(text || '');
  const probe = withFlags(re, 'g');
  const pasted = pastedLiteralRanges(src, pastedTexts);
  return proseRanges(src).some((r) => {
    probe.lastIndex = 0;
    const slice = src.slice(r.start, r.end);
    for (;;) {
      const m = probe.exec(slice);
      if (m === null) {
        return false;
      }
      if (!indexInRanges(r.start + m.index, pasted)) {
        return true;
      }
      if (m[0] === '') {
        probe.lastIndex++;
      }
    }
  });
}

/**
 * Source of truth for "this text is nothing but a context mention".
 *
 * Kept as a string so the webview (a separate realm that cannot import this
 * module) can build the identical regex inline; `bareContextMentionParity`
 * asserts the two stay in step.
 */
export const BARE_CONTEXT_MENTION_SOURCE =
  '^[\\s]*@(clipboard|terminal|problems|selection|open_files)[\\s:]*$';

/**
 * True when `text` carries no content of its own — it is just a context
 * mention such as "@clipboard".
 *
 * This is the degenerate case of the hazard described at the top of this file.
 * There, the clipboard held text that BEGAN with a mention and the scan ate the
 * word out of the payload; the fix was to ignore payload interiors. But when the
 * clipboard holds ONLY the mention, ignoring interiors is not enough:
 *
 *   paste "@clipboard"  ->  composer inserts "@clipboard " (identical to the
 *                           pasted text) and records "@clipboard" as the payload
 *   send                ->  <clipboard>@clipboard</clipboard>
 *
 * The block carries zero information, the chip claims "Clipboard: 1 line", and
 * the user's literal intent (paste the word) is lost. Worse, it is
 * self-amplifying: because the inserted mention is byte-identical to the
 * content, copying the composer and pasting again reproduces it — which is how
 * two identical empty blocks appeared in one message.
 *
 * `@file:` / `@folder:` are deliberately absent: those carry a path after the
 * colon, so they are never contentless.
 */
export function isBareContextMention(text: string): boolean {
  const src = String(text ?? '');
  if (!src.trim()) {
    return false; // empty is a different condition, handled by callers
  }
  return new RegExp(BARE_CONTEXT_MENTION_SOURCE, 'i').test(src);
}

/** Every match of the pattern that occurs in prose, in order. */
export function matchMentionsOutsideContext(text: string, re: RegExp): string[] {
  const src = String(text || '');
  const probe = withFlags(re, 'g');
  const found: string[] = [];
  for (const r of proseRanges(src)) {
    probe.lastIndex = 0;
    const segment = src.slice(r.start, r.end);
    let m: RegExpExecArray | null;
    while ((m = probe.exec(segment)) !== null) {
      found.push(m[0]);
      if (m[0] === '') {
        probe.lastIndex++;
      }
    }
  }
  return found;
}

/**
 * Replace the pattern in prose only, leaving inlined payloads byte-identical.
 * Payload spans are copied through verbatim.
 */
export function replaceMentionOutsideContext(text: string, re: RegExp, replacement: string): string {
  const src = String(text || '');
  const probe = withFlags(re, 'g');
  const prose = proseRanges(src);
  let out = '';
  let cursor = 0;
  for (const r of prose) {
    out += src.slice(cursor, r.start); // payload span, untouched
    probe.lastIndex = 0;
    out += src.slice(r.start, r.end).replace(probe, replacement);
    cursor = r.end;
  }
  out += src.slice(cursor);
  return out;
}

/** Escape a literal for use inside a RegExp (used to remove an exact mention). */
export function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

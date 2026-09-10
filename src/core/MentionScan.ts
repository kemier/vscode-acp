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

/** True when the pattern occurs in prose — inside a payload does not count. */
export function hasMentionOutsideContext(text: string, re: RegExp): boolean {
  const src = String(text || '');
  const probe = withFlags(re, 'g');
  return proseRanges(src).some((r) => {
    probe.lastIndex = 0;
    return probe.test(src.slice(r.start, r.end));
  });
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

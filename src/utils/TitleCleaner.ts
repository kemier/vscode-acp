/**
 * Shared utility for cleaning session titles.
 *
 * Codex-acp (and other agents) may use the raw user message text — including
 * `[@Symbol](file:///absolute/path?symbol=Symbol#L123)` context links, JSON
 * resource_link blocks, `<context>` tags, etc. — as the session title.
 *
 * This strips those context artifacts so titles display cleanly in the
 * session banner, sidebar, and webview state.
 *
 * This is the ext-host-side counterpart of the webview's `cleanUserMessage()`
 * function. Both implement the same stripping logic using string-based parsing
 * (no regex) to avoid template-literal backslash mangling.
 */

/** Strip leading markdown-style context reference links from a title. */
function stripLeadingContextLinks(text: string): string {
  let displayText = text;
  while (true) {
    // Trim leading whitespace
    let start = 0;
    while (start < displayText.length) {
      const c = displayText.charCodeAt(start);
      if (c === 32 || c === 10 || c === 13 || c === 9) {
        start++;
      } else {
        break;
      }
    }
    const trimmed = displayText.substring(start);
    if (trimmed.charCodeAt(0) !== 91 /* '[' */) {
      break;
    }
    const closeBracket = trimmed.indexOf('](');
    if (closeBracket < 0) {
      break;
    }
    const closeParen = trimmed.indexOf(')', closeBracket + 2);
    if (closeParen < 0) {
      break;
    }
    // Check the URI part has a scheme: letters followed by ://
    const uriPart = trimmed.substring(closeBracket + 2, closeParen);
    const colonSlash = uriPart.indexOf('://');
    if (colonSlash < 1) {
      break;
    }
    // Verify scheme is all letters/digits/+/./-
    let validScheme = true;
    for (let si = 0; si < colonSlash; si++) {
      const sc = uriPart.charCodeAt(si);
      if (!((sc >= 97 && sc <= 122) || (sc >= 48 && sc <= 57) || sc === 43 || sc === 46 || sc === 45)) {
        validScheme = false;
        break;
      }
    }
    if (!validScheme) {
      break;
    }
    displayText = trimmed.substring(closeParen + 1);
  }
  return displayText;
}

/** Strip leading JSON-stringified resource_link blocks (Kiro format). */
function stripLeadingResourceLinks(text: string): string {
  let displayText = text;
  while (true) {
    let jsonStart = 0;
    while (jsonStart < displayText.length) {
      const c = displayText.charCodeAt(jsonStart);
      if (c === 32 || c === 10 || c === 13 || c === 9) {
        jsonStart++;
      } else {
        break;
      }
    }
    if (displayText.charCodeAt(jsonStart) !== 123 /* '{' */) {
      break;
    }
    const jsonEnd = displayText.indexOf('}', jsonStart);
    if (jsonEnd < 0) {
      break;
    }
    const jsonStr = displayText.substring(jsonStart, jsonEnd + 1);
    try {
      const parsed = JSON.parse(jsonStr);
      if (parsed && parsed.type === 'resource_link' && typeof parsed.uri === 'string') {
        displayText = displayText.substring(jsonEnd + 1);
        continue;
      }
    } catch {
      /* not valid JSON, stop */
    }
    break;
  }
  return displayText;
}

/** Strip leading <context ref="...">...</context> blocks. */
function stripContextTags(text: string): string {
  const openTag = '<context';
  const closeTag = '</context>';
  let result = '';
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf(openTag, i);
    if (start === -1) {
      result += text.slice(i);
      break;
    }
    result += text.slice(i, start);
    const end = text.indexOf(closeTag, start);
    if (end === -1) {
      break;
    }
    i = end + closeTag.length;
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 10 || c === 13 || c === 9) {
        i++;
      } else {
        break;
      }
    }
  }
  return result;
}

/** Strip bare zed:/// URIs (without [@...] wrapper). */
function stripBareZedUris(text: string): string {
  const zedProto = 'zed:///';
  let result = text;
  let zedIdx = result.indexOf(zedProto);
  while (zedIdx !== -1) {
    let zedEnd = zedIdx + zedProto.length;
    while (zedEnd < result.length) {
      const c = result.charCodeAt(zedEnd);
      if (c === 32 || c === 10 || c === 13 || c === 9) {
        break;
      }
      zedEnd++;
    }
    result = result.slice(0, zedIdx) + result.slice(zedEnd);
    zedIdx = result.indexOf(zedProto);
  }
  return result;
}

/**
 * Clean a session title by stripping context reference links, JSON
 * resource_link blocks, `<context>` tags, and bare zed:/// URIs.
 *
 * Returns the cleaned title, or empty string if the result is empty
 * (so callers can fall back to agent name or "Agent").
 */
/** Strip Cursor Agent's trailing "Additional ACP context:" dump from a title. */
function stripAdditionalAcpContext(text: string): string {
  const marker = 'Additional ACP context:';
  const idx = text.indexOf(marker);
  if (idx < 0) {
    return text;
  }
  let cut = idx;
  while (cut > 0) {
    const c = text.charCodeAt(cut - 1);
    if (c === 32 || c === 10 || c === 13 || c === 9) {
      cut--;
    } else {
      break;
    }
  }
  return text.substring(0, cut);
}

export function cleanSessionTitle(title: string | null | undefined): string {
  if (!title) {
    return '';
  }
  let cleaned = title;
  cleaned = stripLeadingContextLinks(cleaned);
  cleaned = stripLeadingResourceLinks(cleaned);
  cleaned = stripContextTags(cleaned);
  cleaned = stripBareZedUris(cleaned);
  cleaned = stripAdditionalAcpContext(cleaned);
  // Trim trailing whitespace
  let end = cleaned.length;
  while (end > 0) {
    const ch = cleaned.charCodeAt(end - 1);
    if (ch === 32 || ch === 10 || ch === 13 || ch === 9) {
      end--;
    } else {
      break;
    }
  }
  cleaned = cleaned.slice(0, end);
  // Trim leading whitespace
  let start = 0;
  while (start < cleaned.length) {
    const ch = cleaned.charCodeAt(start);
    if (ch === 32 || ch === 10 || ch === 13 || ch === 9) {
      start++;
    } else {
      break;
    }
  }
  cleaned = cleaned.slice(start);
  // Truncate to a reasonable length for display in the session tree and banner.
  // Agents (especially codex-acp) use the raw user prompt as the session title;
  // pasting a large block of text would otherwise flood the sidebar label.
  const MAX_TITLE_LEN = 120;
  if (cleaned.length > MAX_TITLE_LEN) {
    // Try to break at a word boundary near the limit.
    let cut = cleaned.lastIndexOf(' ', MAX_TITLE_LEN);
    if (cut < MAX_TITLE_LEN * 0.6) cut = MAX_TITLE_LEN;
    cleaned = cleaned.slice(0, cut) + '…';
  }
  return cleaned;
}

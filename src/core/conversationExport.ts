/**
 * Build the plain-text export of a conversation for the fork-to-agent feature.
 *
 * acp.forkToAgent takes the current conversation and continues it in a
 * different agent. The source conversation cannot be replayed via
 * session/load - the ACP LoadSessionRequest schema has no history payload,
 * so the target agent can only receive the context as text. To minimize the
 * loss, this export includes not just the user/assistant messages but also the
 * reasoning blocks (thoughts) and the tool-call actions + inputs, so the
 * forked agent sees the work that was done, not just the prose.
 *
 * This is a pure function (no vscode/webview dependency) so it can be unit
 * tested directly. The webview requestConversationExport handler calls it
 * with the chatHistory items.
 */

export interface ConversationExportItem {
  kind: 'message' | 'thought' | 'toolCall' | string;
  role?: string;
  text?: unknown;
  title?: unknown;
  toolCallId?: unknown;
  status?: unknown;
  rawInput?: unknown;
}

/**
 * True when a message body is nothing but JSON-stringified ACP resource_link
 * blocks, e.g.
 *
 *   {"name":"path`","uri":"file:///abs/path%60","type":"resource_link"}
 *
 * session/load replays each stored content block as its own
 * user_message_chunk, so a file attachment arrives alone in this shape. A
 * webview fallback used to restore that raw JSON into chatHistory when the
 * cleaner emptied it, which meant fork-to-agent then carried the JSON into the
 * NEW conversation as a "User:" line — and the fork's own resume replayed it
 * again. The webview no longer writes it, but history already polluted by an
 * earlier build still holds those rows, so the export filters them here too.
 *
 * Only leading blocks are consumed: a message that has an attachment followed
 * by real prose is genuine content and must be exported intact.
 */
export function isResourceLinkJsonOnly(text: string): boolean {
  let rest = String(text ?? '').trim();
  if (!rest) {
    return false;
  }
  let consumedAny = false;
  // Bounded: a message carries a handful of attachments, not thousands.
  for (let guard = 0; guard < 200 && rest.startsWith('{'); guard++) {
    let matchedTo = -1;
    // The "name" is arbitrary text and may itself contain '}', so try each
    // closing brace until one parses.
    for (let probe = rest.indexOf('}'); probe >= 0; probe = rest.indexOf('}', probe + 1)) {
      try {
        const parsed = JSON.parse(rest.slice(0, probe + 1)) as { type?: unknown; uri?: unknown };
        if (parsed && parsed.type === 'resource_link' && typeof parsed.uri === 'string') {
          matchedTo = probe + 1;
        }
        // Parsed cleanly — this is the object boundary either way.
        break;
      } catch {
        /* not a complete object yet — widen */
      }
    }
    if (matchedTo < 0) {
      break;
    }
    rest = rest.slice(matchedTo).trim();
    consumedAny = true;
  }
  return consumedAny && rest.length === 0;
}

/**
 * Convert a single chatHistory item into its export line(s), or null if the
 * item should be skipped (empty, slash-command-only, subagent-result markers).
 */
export function exportConversationItem(item: ConversationExportItem): string | null {
  if (!item) {
    return null;
  }
  // Never carry a compaction boundary marker itself (a "Context compacting"
  // tool call, a "*Context compacted*" line, a system notice, or a
  // compaction_update) into a fork — it is protocol noise, not content.
  if (isCompactionBoundaryItem(item)) {
    return null;
  }
  if (item.kind === 'message') {
    if (item.role === 'user') {
      const text = typeof item.text === 'string' ? item.text : '';
      if (!text.trim()) {
        return null;
      }
      if (text.startsWith('[Subagent result]')) {
        return null;
      }
      if (isResourceLinkJsonOnly(text)) {
        return null;
      }
      return 'User: ' + text;
    }
    if (item.role === 'assistant') {
      const text = typeof item.text === 'string' ? item.text : '';
      if (!text.trim()) {
        return null;
      }
      if (isResourceLinkJsonOnly(text)) {
        return null;
      }
      return 'Assistant: ' + text;
    }
    return null;
  }
  if (item.kind === 'thought') {
    const text = typeof item.text === 'string' ? item.text : '';
    if (!text.trim()) {
      return null;
    }
    return '(reasoning) ' + text;
  }
  if (item.kind === 'toolCall') {
    const name = (typeof item.title === 'string' && item.title) || (typeof item.toolCallId === 'string' && item.toolCallId) || 'tool';
    const status = typeof item.status === 'string' ? item.status : '';
    let input = '';
    if (typeof item.rawInput === 'string') {
      input = item.rawInput;
    } else if (item.rawInput && typeof item.rawInput === 'object') {
      try {
        input = JSON.stringify(item.rawInput);
      } catch {
        input = '';
      }
    }
    let line = 'Tool: ' + name;
    if (status) {
      line += ' [' + status + ']';
    }
    if (input && input.trim()) {
      line += '\n' + input;
    }
    return line;
  }
  return null;
}

/**
 * True when an item marks a context-compaction boundary in the session.
 *
 * A fork/export must NOT carry pre-compaction history into the new agent —
 * compaction already replaced that content with a summary, so re-sending it
 * inflates the target's token usage (a compacted 200k session can balloon to
 * 700k+ when the full pre-compaction transcript is embedded as one text block).
 * But each ACP adapter signals compaction differently, so we accept every
 * shape seen in the wild:
 *
 *   - kiro-cli   : tool_call "Context compacting" + _meta.contextCompaction
 *   - codex-acp  : assistant text "*Context compacted to fit the model's ..."
 *   - claude-code-acp: tool_call_update "Context compacted" + _meta.contextCompaction
 *   - pi-acp     : tool_call "Context compacting"/"compacted" + _meta.contextCompaction
 *   - generic    : system message whose text mentions "compacted"
 *   - future     : ACP session-compaction RFD compaction_update (status completed)
 */
export function isCompactionBoundaryItem(item: ConversationExportItem): boolean {
  if (!item) {
    return false;
  }
  // Most reliable: adapters that set _meta.contextCompaction on the tool call.
  const meta = (item as any)._meta as Record<string, unknown> | undefined;
  if (meta && meta.contextCompaction === true) {
    return true;
  }
  // Future-proof: ACP session-compaction RFD (compaction_update).
  if (item.kind === 'compaction_update') {
    const status = typeof item.status === 'string' ? item.status.toLowerCase() : '';
    if (status === 'completed' || status === '' || status === 'in_progress') {
      return true;
    }
  }
  // Tool calls titled "Context compacting" / "Context compacted" (kiro, pi,
  // claude-code) even when _meta is absent.
  if (item.kind === 'toolCall') {
    const title = typeof item.title === 'string' ? item.title.toLowerCase() : '';
    if (title.includes('compact') && title.includes('context')) {
      return true;
    }
  }
  // Text markers: codex emits an assistant "*Context compacted ...*" line;
  // some adapters emit a system notice mentioning "compacted".
  if (item.kind === 'message') {
    const text = typeof item.text === 'string' ? item.text.toLowerCase() : '';
    if (text.includes('compacted') || text.includes('compacting')) {
      return true;
    }
  }
  return false;
}

/**
 * Return the index of the first compaction-boundary item in `items`, or -1 if
 * the conversation has never been compacted. Items at or after this index are
 * the post-compaction history (including the retained summary / recent turns)
 * and are the only ones a fork should carry.
 */
export function findCompactionBoundary(items: ConversationExportItem[]): number {
  for (let i = 0; i < items.length; i++) {
    if (isCompactionBoundaryItem(items[i])) {
      return i;
    }
  }
  return -1;
}

/**
 * Build the full export text for a conversation. Items are joined with blank
 * lines so each turn/block is visually separate in the forked agent prompt.
 *
 * If the conversation was compacted at some point, only the post-compaction
 * history (from the first compaction boundary onward) is exported. This keeps
 * the forked agent's context aligned with what the source agent actually used,
 * instead of re-embedding the entire pre-compaction transcript and blowing up
 * the target's token usage.
 */
export function exportConversation(items: ConversationExportItem[]): string {
  const boundary = findCompactionBoundary(items);
  // Start AFTER the boundary marker: the marker itself (a "Context compacting"
  // tool call, a "*Context compacted*" line, or a compaction_update) is
  // protocol noise, not content the forked agent needs. Post-compaction turns
  // (the retained summary / recent messages) begin after it.
  const start = boundary >= 0 ? boundary + 1 : 0;
  const parts: string[] = [];
  for (let i = start; i < items.length; i++) {
    const line = exportConversationItem(items[i]);
    if (line !== null) {
      parts.push(line);
    }
  }
  return parts.join('\n\n');
}

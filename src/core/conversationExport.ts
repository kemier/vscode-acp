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
 * Convert a single chatHistory item into its export line(s), or null if the
 * item should be skipped (empty, slash-command-only, subagent-result markers).
 */
export function exportConversationItem(item: ConversationExportItem): string | null {
  if (!item) {
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
      return 'User: ' + text;
    }
    if (item.role === 'assistant') {
      const text = typeof item.text === 'string' ? item.text : '';
      if (!text.trim()) {
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
 * Build the full export text for a conversation. Items are joined with blank
 * lines so each turn/block is visually separate in the forked agent prompt.
 */
export function exportConversation(items: ConversationExportItem[]): string {
  const parts: string[] = [];
  for (const item of items) {
    const line = exportConversationItem(item);
    if (line !== null) {
      parts.push(line);
    }
  }
  return parts.join('\n\n');
}

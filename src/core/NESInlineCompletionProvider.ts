import * as vscode from 'vscode';

import type { NESManager, NESSuggestion } from './NESManager';
import { log } from '../utils/Logger';

/**
 * VS Code InlineCompletionItemProvider that bridges NES suggestions
 * from an ACP agent to VS Code's inline completion UI (ghost text).
 *
 * Lifecycle:
 * - VS Code calls provideInlineCompletionItems on typing / cursor move
 * - We call NESManager.suggest() which calls unstable_suggestNes
 * - The returned edit suggestions are converted to InlineCompletionItems
 * - On accept (Tab), the command fires NESManager.accept()
 * - On dismiss (next request), we fire NESManager.reject() for the previous
 */
export class NESInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private currentSuggestionId: string | null = null;

  constructor(private readonly nesManager: NESManager) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | null> {
    if (!this.nesManager.isActive) {
      return null;
    }
    if (document.uri.scheme !== 'file') {
      return null;
    }

    if (this.currentSuggestionId) {
      this.nesManager.reject(this.currentSuggestionId, 'replaced');
      this.currentSuggestionId = null;
    }

    const triggerKind = context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke ? 'manual' : 'automatic';

    const suggestions = await this.nesManager.suggest(document, position, triggerKind, token);
    if (!suggestions || suggestions.length === 0 || token.isCancellationRequested) {
      return null;
    }

    const suggestion = suggestions.find((s) => s.kind === 'edit');
    if (!suggestion || !suggestion.edits || suggestion.edits.length === 0) {
      return null;
    }
    if (suggestion.uri && suggestion.uri !== document.uri.toString()) {
      return null;
    }

    this.currentSuggestionId = suggestion.id;
    const items = this.convertToInlineCompletions(suggestion);
    log(`NESInlineCompletionProvider: returning ${items.length} item(s) for suggestion ${suggestion.id}`);
    return items;
  }

  reset(): void {
    this.currentSuggestionId = null;
  }

  private convertToInlineCompletions(suggestion: NESSuggestion): vscode.InlineCompletionItem[] {
    const items: vscode.InlineCompletionItem[] = [];
    for (const edit of suggestion.edits) {
      const range = new vscode.Range(
        edit.range.start.line,
        edit.range.start.character,
        edit.range.end.line,
        edit.range.end.character,
      );
      const item = new vscode.InlineCompletionItem(edit.newText, range, {
        title: 'Accept NES',
        command: 'acp.nesAccept',
        arguments: [suggestion.id],
      });
      (item as any).isInlineEdit = true;
      (item as any).showRange = range;
      items.push(item);
    }
    return items;
  }
}

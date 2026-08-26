import * as assert from 'assert';
import { exportConversation, exportConversationItem, isResourceLinkJsonOnly, type ConversationExportItem } from '../core/conversationExport';

/**
 * Unit tests for the fork-to-agent conversation export.
 *
 * The webview requestConversationExport handler inlines this logic (the
 * webview script cannot import TS modules), so this pure module is the
 * tested reference implementation. The test documents the expected output
 * format: user/assistant messages, reasoning blocks, and tool-call actions.
 */

suite('conversationExport', () => {
  test('exports user and assistant messages', () => {
    const items: ConversationExportItem[] = [
      { kind: 'message', role: 'user', text: 'hello' },
      { kind: 'message', role: 'assistant', text: 'hi there' },
    ];
    const result = exportConversation(items);
    assert.strictEqual(result, 'User: hello' + '\n' + '\n' + 'Assistant: hi there');
  });

  test('skips empty and subagent-result user messages', () => {
    const items: ConversationExportItem[] = [
      { kind: 'message', role: 'user', text: '  ' },
      { kind: 'message', role: 'user', text: '[Subagent result] done' },
      { kind: 'message', role: 'user', text: 'real question' },
    ];
    const result = exportConversation(items);
    assert.strictEqual(result, 'User: real question');
  });

  test('exports reasoning blocks', () => {
    const items: ConversationExportItem[] = [
      { kind: 'thought', text: 'I should check the config' },
    ];
    const result = exportConversation(items);
    assert.strictEqual(result, '(reasoning) I should check the config');
  });

  test('exports tool calls with title, status, and string input', () => {
    const items: ConversationExportItem[] = [
      { kind: 'toolCall', title: 'edit_file', status: 'completed', rawInput: 'path: src/a.ts' },
    ];
    const result = exportConversation(items);
    assert.strictEqual(result, 'Tool: edit_file [completed]' + '\n' + 'path: src/a.ts');
  });

  test('exports tool calls with object input as JSON', () => {
    const items: ConversationExportItem[] = [
      { kind: 'toolCall', title: 'apply_patch', rawInput: { file: 'b.ts', ops: 2 } },
    ];
    const result = exportConversation(items);
    assert.strictEqual(result, 'Tool: apply_patch' + '\n' + JSON.stringify({ file: 'b.ts', ops: 2 }));
  });

  test('falls back to toolCallId when title is missing', () => {
    const items: ConversationExportItem[] = [
      { kind: 'toolCall', toolCallId: 'tc-7', rawInput: 'cmd' },
    ];
    const result = exportConversation(items);
    assert.strictEqual(result, 'Tool: tc-7' + '\n' + 'cmd');
  });

  test('joins multiple blocks with blank lines', () => {
    const items: ConversationExportItem[] = [
      { kind: 'message', role: 'user', text: 'a' },
      { kind: 'thought', text: 'b' },
      { kind: 'toolCall', title: 'c', rawInput: 'd' },
    ];
    const result = exportConversation(items);
    assert.strictEqual(
      result,
      'User: a' + '\n' + '\n' + '(reasoning) b' + '\n' + '\n' + 'Tool: c' + '\n' + 'd',
    );
  });

  test('null/undefined items are skipped', () => {
    const items: ConversationExportItem[] = [
      null as unknown as ConversationExportItem,
      { kind: 'message', role: 'user', text: 'only me' },
    ];
    const result = exportConversation(items);
    assert.strictEqual(result, 'User: only me');
  });

  test('unknown kinds are skipped', () => {
    const result = exportConversationItem({ kind: 'system', text: 'x' } as ConversationExportItem);
    assert.strictEqual(result, null);
  });

  /**
   * Fork-to-agent used to carry replayed resource_link JSON into the NEW
   * conversation. session/load replays each stored content block as its own
   * user_message_chunk, so an attachment arrives alone as
   * {"name":...,"uri":...,"type":"resource_link"}; a webview fallback restored
   * that raw JSON into chatHistory when the cleaner emptied it, the export
   * emitted it as a "User:" line, and the fork's own resume replayed it again.
   * The webview no longer writes those rows, but history polluted by an earlier
   * build still holds them — so the export filters them as well.
   */
  const rlink = (name: string, uri: string) =>
    JSON.stringify({ name, uri, type: 'resource_link' });

  test('skips messages that are only resource_link JSON', () => {
    assert.strictEqual(
      exportConversationItem({
        kind: 'message',
        role: 'user',
        text: rlink('path`', 'file:///workspace/git/ezennin/vscode-acp/path%60'),
      } as ConversationExportItem),
      null,
    );
    assert.strictEqual(
      exportConversationItem({
        kind: 'message',
        role: 'assistant',
        text: rlink('a', 'file:///a') + rlink('b', 'file:///b'),
      } as ConversationExportItem),
      null,
    );
  });

  test('keeps a message that has an attachment followed by real prose', () => {
    const text = rlink('a', 'file:///a') + 'what changed here?';
    assert.strictEqual(
      exportConversationItem({ kind: 'message', role: 'user', text } as ConversationExportItem),
      'User: ' + text,
      'genuine content must survive intact',
    );
  });

  test('resource_link-only rows drop out of a full export', () => {
    const items: ConversationExportItem[] = [
      { kind: 'message', role: 'user', text: rlink('`/', 'file:///workspace/git/ezennin/vscode-acp/%60/') },
      { kind: 'message', role: 'user', text: 'check acp log' },
      { kind: 'message', role: 'assistant', text: 'looking now' },
    ];
    assert.strictEqual(exportConversation(items), 'User: check acp log\n\nAssistant: looking now');
  });

  test('isResourceLinkJsonOnly leaves ordinary text and non-link JSON alone', () => {
    assert.strictEqual(isResourceLinkJsonOnly('hello'), false);
    assert.strictEqual(isResourceLinkJsonOnly(''), false, 'empty is handled by the caller');
    assert.strictEqual(isResourceLinkJsonOnly(JSON.stringify({ type: 'text', text: 'x' })), false);
    assert.strictEqual(isResourceLinkJsonOnly(rlink('weird}name', 'file:///w')), true);
  });
});

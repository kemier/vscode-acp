import * as assert from 'assert';
import { exportConversation, exportConversationItem, type ConversationExportItem } from '../core/conversationExport';

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
});

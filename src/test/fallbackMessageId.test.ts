import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Regression test for the webview's synthetic per-turn messageId fallback for
 * agents that never emit a real `messageId` (legacy Kiro CLI, older ericli).
 *
 * Without the fallback, kiro-cli streams `agent_message_chunk` with no
 * messageId, so vscode-acp's bubble-grouping key (messageId) is null on every
 * chunk -> every sentence lands as its own assistant bubble
 * (hasCurrentAssistantEl=false on every chunk) and text after a tool-call
 * split never reattaches to the committed bubble.
 *
 * The webview logic lives inside the ChatWebviewProvider template literal, so
 * we extract the decision fragment from source and evaluate it in a fresh
 * scope (same technique as crewStageLabel.test.ts).
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

function extractFallbackFragment(): string {
  const src = fs.readFileSync(SOURCE, 'utf8');
  // Exact opener of the decision fragment in the agent_message_chunk handler.
  const sig = "var _incomingMessageId = typeof update.messageId === 'string' ? update.messageId : null;";
  const startIdx = src.indexOf(sig);
  assert.ok(startIdx >= 0, 'messageId fallback fragment not found in ChatWebviewProvider.ts');
  // End: the `if (` block that follows the fallback assignment
  // (`!currentAssistantEl && _incomingMessageId && ...`).
  const after = src.slice(startIdx);
  const endMarker = '\n          if (\n            !currentAssistantEl &&';
  const endIdx = after.indexOf(endMarker);
  assert.ok(endIdx > 0, 'end of fallback fragment not found');
  return after.slice(0, endIdx).trim();
}

suite('fallbackMessageId', () => {
  test('extracts the fallback fragment from ChatWebviewProvider source', () => {
    const frag = extractFallbackFragment();
    assert.ok(frag.includes('fallbackMessageId'), `expected fallback ref: ${frag}`);
    assert.ok(frag.includes('sawRealMessageIdThisTurn'), `expected flag ref: ${frag}`);
  });

  test('chunks without a real messageId get the synthetic per-turn id', () => {
    const fallbackMessageId = 'turn-fallback-xyz';
    let sawRealMessageIdThisTurn = false;
    // eslint-disable-next-line no-new-func
    const fn = new Function(
      'update',
      'fallbackMessageId',
      'sawRealMessageIdThisTurn',
      `
        ${extractFallbackFragment()}
        return _incomingMessageId;
      `,
    );
    assert.strictEqual(fn({}, fallbackMessageId, sawRealMessageIdThisTurn), 'turn-fallback-xyz');
    assert.strictEqual(fn({ messageId: undefined }, fallbackMessageId, sawRealMessageIdThisTurn), 'turn-fallback-xyz');
    assert.strictEqual(fn({ messageId: null }, fallbackMessageId, sawRealMessageIdThisTurn), 'turn-fallback-xyz');
  });

  test('real messageId wins once seen (agents control grouping)', () => {
    const fallbackMessageId = 'turn-fallback-xyz';
    let sawRealMessageIdThisTurn = false;
    // eslint-disable-next-line no-new-func
    const fn = new Function(
      'update',
      'fallbackMessageId',
      'sawRealMessageIdThisTurn',
      `
        ${extractFallbackFragment()}
        return { _incomingMessageId: _incomingMessageId, saw: sawRealMessageIdThisTurn };
      `,
    );
    const first = fn({ messageId: 'real-1' }, fallbackMessageId, sawRealMessageIdThisTurn);
    sawRealMessageIdThisTurn = first.saw;
    const second = fn({}, fallbackMessageId, sawRealMessageIdThisTurn);
    assert.strictEqual(first._incomingMessageId, 'real-1');
    assert.strictEqual(first.saw, true);
    assert.strictEqual(second._incomingMessageId, null);
    assert.strictEqual(second.saw, true);
  });
});

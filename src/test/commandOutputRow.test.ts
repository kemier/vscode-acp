import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Slash-command output renders as a transient SNAPSHOT row, not conversation.
 *
 * A command answered mid-turn used to be adopted by the running turn. The chunk
 * carried a new messageId, so the webview committed the in-flight assistant
 * bubble and — in compact mode — moveAssistantIntoFold() demoted the command's
 * answer into that turn's COLLAPSED fold:
 *
 *   function moveAssistantIntoFold(assistantEl) {
 *     if (!assistantEl || !currentTurnEl || !compactMode) return;
 *     assistantEl.classList.add('assistant-interim');
 *     var body = ensureCurrentTurnFold();
 *     if (body) body.appendChild(assistantEl);
 *   }
 *
 * So "/goal clear" and "/a2a register local x" appeared inside an unrelated
 * turn's collapsed block instead of next to the command. Nothing was lost — it
 * was filed under a turn it had nothing to do with.
 *
 * Root cause: side-channel prompts get no promptStart/promptEnd (so they cannot
 * steal turn state), which also leaves their output with no turn of its own, and
 * the nearest turn adopts it.
 *
 * Fix chain, all three links asserted here:
 *   1. ericli marks the chunk with _meta.commandOutput (ACP reserves _meta on
 *      ContentChunk for exactly this);
 *   2. the host BYPASSES the stream coalescer for it — the coalescer carries only
 *      (kind, text, messageId) and re-synthesises the chunk, which would drop the
 *      marker before the webview ever saw it;
 *   3. the webview renders it via addCommandOutputRow() and stops, never touching
 *      currentAssistantEl / currentTurnEl / chatHistory.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

suite('slash-command output renders as a transient snapshot row', () => {
  const src = fs.readFileSync(SOURCE, 'utf8');

  test('the host bypasses the coalescer for marked command output', () => {
    // Without the bypass the marker is stripped and the webview branch is dead.
    const at = src.indexOf(
      "if (updateKind === 'agent_message_chunk' && updateData?._meta?.commandOutput) {",
    );
    assert.ok(at > 0, 'coalescer bypass for command output not found');
    const block = src.slice(at, at + 600);
    assert.ok(
      block.includes('this.streamCoalescer.flush(update.sessionId);'),
      'must flush buffered text first so ordering against it is preserved',
    );
    assert.ok(block.includes("type: 'sessionUpdate'"), 'must forward the update itself');
    assert.ok(block.includes('update: update.update'), 'must forward it UNTOUCHED so _meta survives');
  });

  test('the bypass runs BEFORE the coalescer append', () => {
    const bypass = src.indexOf("updateData?._meta?.commandOutput");
    const append = src.indexOf('this.streamCoalescer.append(');
    assert.ok(bypass > 0 && append > 0);
    assert.ok(bypass < append, 'a bypass after the append would never be reached');
  });

  test('the webview renders marked chunks as their own row and stops', () => {
    const at = src.indexOf('update._meta && update._meta.commandOutput) {');
    assert.ok(at > 0, 'webview command-output branch not found');
    // Window widened: the branch also handles _meta.subagentLateResult (opening a
    // client-owned turn) before rendering, so the row call sits further down. The
    // property asserted is unchanged — this branch renders the row and stops.
    const block = src.slice(at, at + 1600);
    assert.ok(block.includes('addCommandOutputRow(content.text);'), 'must use the snapshot row');
    assert.ok(block.includes('break;'), 'must stop — assistant/turn state is not its business');
  });

  test('the webview branch precedes the assistant-text accumulation', () => {
    // It must short-circuit before anything that could adopt it into a turn.
    // currentAssistantText += content.text is the first such step inside the
    // agent_message_chunk case; everything that folds or commits follows it.
    const branch = src.indexOf('update._meta && update._meta.commandOutput) {');
    const accumulate = src.indexOf('currentAssistantText += content.text;');
    assert.ok(branch > 0 && accumulate > 0, 'anchors not found');
    assert.ok(
      branch < accumulate,
      'the command-output branch must come before the chunk is accumulated as ' +
        'assistant text, or it will already have been adopted by the turn',
    );
  });

  test('the snapshot row is NOT entered into chatHistory', () => {
    // The agent deliberately does not persist slash output, so this must vanish
    // on reload too — otherwise the webview would restore a row the agent has
    // no record of.
    const at = src.indexOf('function addCommandOutputRow(text) {');
    assert.ok(at > 0, 'addCommandOutputRow not found');
    const body = src.slice(at, src.indexOf('\n   }', at));
    assert.ok(body.includes("addMessageDOM('system', text)"), 'must use the DOM-only helper');
    assert.ok(
      !body.includes('chatHistory'),
      'must not touch chatHistory — addMessage() would persist it into the snapshot',
    );
  });

  test('the row is a transient snapshot: vanishes after 3s or on the next message', () => {
    // A snapshot answers its question and then goes stale. It must NOT linger
    // beside the conversation: it auto-removes after 3s (like the compact
    // notice), or sooner when the next user/assistant message arrives.
    const at = src.indexOf('function addCommandOutputRow(text) {');
    assert.ok(at > 0, 'addCommandOutputRow not found');
    const body = src.slice(at, src.indexOf('\n   }', at));
    assert.ok(body.includes('setTimeout'), 'must auto-remove after 3s');
    assert.ok(body.includes('3000'), 'the snapshot window is 3s');
    // And the next user/assistant message clears any live snapshot row.
    // (The call precedes the function definition — function declarations are
    // hoisted — so assert on presence, not position.)
    const clearAt = src.indexOf('function clearCommandOutputRows() {');
    assert.ok(clearAt > 0, 'clearCommandOutputRows not found');
    assert.ok(
      src.includes('clearCommandOutputRows();'),
      'a new user/assistant message must clear live snapshot rows',
    );
  });

  test('it is styled as terminal-style output, outside any turn fold', () => {
    const at = src.indexOf('.message.command-output {');
    assert.ok(at > 0, 'command-output CSS not found');
    const css = src.slice(at, at + 420);
    assert.ok(css.includes('white-space: pre-wrap'), 'payload is preformatted text');
    assert.ok(css.includes('align-self: flex-start'), 'left-aligned like ps-output');
    assert.ok(css.includes('font-style: normal'), 'must override the italic .message.system rule');
  });
});

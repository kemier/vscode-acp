import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * A detached spawn's children must not be failed when the parent completes.
 *
 * Reported: the main agent launched 3 subagents, said "They'll return as messages
 * when done", ended the turn — and the crew spun forever even though some children
 * had finished. Asking "all subagents are finished?" then turned all of them red.
 *
 * Two places shared one wrong assumption, "parent completed => children finished":
 *
 *   ericli   cleared its spawn_parallel stage tracking in onToolCall, so
 *            onSubagentProgress's guard swallowed every per-stage completion and no
 *            stage ever got its check mark.
 *   webview  force-marks any running/pending stage FAILED once the parent tool call
 *            is 'completed' (the reconciliation pass below).
 *
 * A DETACHED spawn_parallel completes on its launch ack ("Launched N subagent(s) in
 * the background") while all N children keep working, so both rules fire at the
 * wrong moment. ericli now marks such completions _meta.subagentsDetached, and this
 * side must honour it.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

suite('detached spawn stages survive the parent completing', () => {
  const src = fs.readFileSync(SOURCE, 'utf8');

  test('the force-fail is gated on the parent NOT being detached', () => {
    const at = src.indexOf('var parentDetached =');
    assert.ok(at > 0, 'parentDetached not computed');
    const block = src.slice(at, at + 900);
    assert.ok(
      block.includes('if (parentDone && !parentDetached) {'),
      'a detached parent must not trigger the stage force-fail',
    );
  });

  test('it reads the persisted field, not the transient _meta', () => {
    // chatHistory toolCall entries do not keep _meta, and the reconciliation pass
    // runs over chatHistory — reading _meta there would always be undefined.
    const at = src.indexOf('var parentDetached =');
    const line = src.slice(at, src.indexOf(';', at));
    assert.ok(line.includes('item.subagentsDetached'), 'must use the persisted flag');
    assert.ok(!line.includes('item._meta'), 'must not depend on transient _meta');
  });

  test('the marker is persisted onto the history entry when it arrives', () => {
    const at = src.indexOf('update._meta.subagentsDetached');
    assert.ok(at > 0, 'marker not consumed on tool_call_update');
    const block = src.slice(at, at + 700);
    assert.ok(block.includes('subagentsDetached = true'), 'writes the flag');
    assert.ok(block.includes('toolCallIdsMatch'), 'matches the right tool call');
    assert.ok(block.includes('saveState()'), 'survives a reload');
  });

  test('the non-detached force-fail behaviour is preserved', () => {
    // A genuinely interrupted blocking spawn must still mark its children failed.
    const at = src.indexOf('if (parentDone && !parentDetached) {');
    const block = src.slice(at, at + 700);
    assert.ok(block.includes("status: 'failed'"), 'blocking spawns still reconcile to failed');
  });
});

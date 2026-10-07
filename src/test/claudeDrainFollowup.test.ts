import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * claude-code-acp background steer drain — the "queued msg shown at the end,
 * then nothing continues" symptom.
 *
 * Wire trace (20261007T080030 window1, 4-ACP Traffic.log):
 *
 *   05:58:15 session/steer (27 chars) → user_message_accepted → user_message_chunk
 *   05:58:49 Turn result: stopReason=success   ← model never consumed the steer
 *   05:58:49 "Mid-turn steer ignored by end_turn (no tool_use after) — re-queueing"
 *   05:58:49 "Draining steer message"          ← adapter streams a FOLLOW-UP turn
 *   05:58:49 RESPONSE end_turn                 ← promptEnd; client goes idle
 *   05:59:10+ usage_update / tool_call / text  ← drain turn, dropped by the
 *                                                idle-chunk guard → nothing rendered
 *
 * The adapter owns the re-send; the client owns the render. promptEnd arms
 * drainFollowUpExpected (claude agent + steer delivered this turn); the first
 * idle agent_message_chunk / tool_call opens a client-owned turn via
 * openClaudeDrainTurnIfNeeded; the adapter's tail session_info_update closes
 * it via closeClaudeDrainTurn. This pins the pure opener extracted from the
 * webview template as in modelIdFromConfigOptions.test.ts.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

function loadOpener(): any {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const start = src.indexOf('function openClaudeDrainTurnIfNeeded() {');
  assert.ok(start >= 0, 'openClaudeDrainTurnIfNeeded not found in ChatWebviewProvider.ts');
  const end = src.indexOf('\n/**', start);
  assert.ok(end > start, 'end marker after openClaudeDrainTurnIfNeeded not found');
  const fnSrc = src.slice(start, end).trim();
  // Harness: the extracted function closes over these, so the driver can flip
  // the flags per call exactly as the webview's message handlers do.
  return new Function(`
    var claudeDrainTurnOpen = false;
    var drainFollowUpExpected = false;
    var isForceCancelled = false;
    var isClaudeAgent = function() { return true; };
    var opened = 0;
    function setProcessing(v, caller) { opened++; }
    var vscode = { postMessage: function(m) {} };
    ${fnSrc}
    return function(exp, cancelled, claude) {
      claudeDrainTurnOpen = false;
      drainFollowUpExpected = exp;
      isForceCancelled = cancelled;
      isClaudeAgent = function() { return claude; };
      opened = 0;
      const r = openClaudeDrainTurnIfNeeded();
      return { r: r, opened: opened, open: claudeDrainTurnOpen };
    };
  `)();
}

suite('claude steer-drain follow-up turn opener', () => {
  const drive = loadOpener();

  test('unarmed end_turn keeps the old drop behavior', () => {
    const res = drive(false, false, true);
    assert.strictEqual(res.r, false, 'no turn opened when no drain was expected');
    assert.strictEqual(res.open, false);
  });

  test('armed claude end_turn opens the drain turn', () => {
    const res = drive(true, false, true);
    assert.strictEqual(res.r, true, 'idle event is adopted into the drain turn');
    assert.strictEqual(res.open, true);
    assert.strictEqual(res.opened, 1, 'setProcessing(true) flips Stop on');
  });

  test('non-claude agents never open a drain turn', () => {
    // Kiro's late replay tail must keep being dropped ("thoughts grouped at
    // the bottom" regression guard).
    const res = drive(true, false, false);
    assert.strictEqual(res.r, false);
    assert.strictEqual(res.open, false);
  });

  test('a cancelled turn does not arm a drain window', () => {
    const res = drive(true, true, true);
    assert.strictEqual(res.r, false);
    assert.strictEqual(res.open, false);
  });

  test('already-open drain turn adopts further events', () => {
    // Second idle event of the same drain turn: the guard re-enters with
    // claudeDrainTurnOpen true → returns true without re-opening.
    const fn = loadOpenerRaw();
    function loadOpenerRaw(): any {
      const src = fs.readFileSync(SOURCE, 'utf8');
      const start = src.indexOf('function openClaudeDrainTurnIfNeeded() {');
      const end = src.indexOf('\n/**', start);
      const fnSrc = src.slice(start, end).trim();
      return new Function(`
        var claudeDrainTurnOpen = true;
        var drainFollowUpExpected = false;
        var isForceCancelled = false;
        var isClaudeAgent = function() { return true; };
        var opened = 0;
        function setProcessing(v, caller) { opened++; }
        var vscode = { postMessage: function(m) {} };
        ${fnSrc}
        return openClaudeDrainTurnIfNeeded;
      `)();
    }
    const r = fn();
    assert.strictEqual(r, true, 'mid-drain events keep processing');
  });
});

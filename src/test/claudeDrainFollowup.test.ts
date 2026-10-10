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
 * drainFollowUpCount (one slot per steered entry queued this turn); the first
 * idle agent_message_chunk / tool_call opens a client-owned turn via
 * openClaudeDrainTurnIfNeeded; the adapter's tail session_info_update closes
 * it via closeClaudeDrainTurn. The counter (not a one-shot boolean) is the
 * point: a stray session_info_update (goal snapshot) closes ONE follow-up turn
 * but leaves the count live, so follow-ups 2..N re-open a fresh drain turn
 * instead of being dropped. This pins the pure opener + closer extracted from
 * the webview template as in modelIdFromConfigOptions.test.ts.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

/**
 * Brace-match a top-level `function NAME(...) {` body. The opener is followed
 * by a `/**` doc comment (the old `indexOf('\n/**')` marker worked), but the
 * closer is followed by ordinary code, so brace matching is the robust end.
 */
function extractFn(name: string): string {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' not found in ChatWebviewProvider.ts');
  const bodyStart = src.indexOf('{', start);
  let depth = 1;
  let i = bodyStart + 1;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
  }
  return src.slice(start, i);
}

function loadOpener(): any {
  const fnSrc = extractFn('openClaudeDrainTurnIfNeeded');
  // Harness: the extracted function closes over these, so the driver can flip
  // the flags per call exactly as the webview's message handlers do.
  return new Function(`
    var claudeDrainTurnOpen = false;
    var drainFollowUpCount = 0;
    var isForceCancelled = false;
    var isClaudeAgent = function() { return true; };
    var opened = 0;
    function setProcessing(v, caller) { opened++; }
    var vscode = { postMessage: function(m) {} };
    ${fnSrc}
    return function(count, cancelled, claude) {
      claudeDrainTurnOpen = false;
      drainFollowUpCount = count;
      isForceCancelled = cancelled;
      isClaudeAgent = function() { return claude; };
      opened = 0;
      const r = openClaudeDrainTurnIfNeeded();
      return { r: r, opened: opened, open: claudeDrainTurnOpen, count: drainFollowUpCount };
    };
  `)();
}

suite('claude steer-drain follow-up turn opener', () => {
  const drive = loadOpener();

  test('unarmed end_turn keeps the old drop behavior', () => {
    const res = drive(0, false, true);
    assert.strictEqual(res.r, false, 'no turn opened when no drain was expected');
    assert.strictEqual(res.open, false);
  });

  test('armed claude end_turn opens the drain turn', () => {
    const res = drive(1, false, true);
    assert.strictEqual(res.r, true, 'idle event is adopted into the drain turn');
    assert.strictEqual(res.open, true);
    assert.strictEqual(res.opened, 1, 'setProcessing(true) flips Stop on');
    // The opener must NOT consume the slot — the closer does.
    assert.strictEqual(res.count, 1, 'open does not decrement the count');
  });

  test('non-claude agents never open a drain turn', () => {
    // Kiro's late replay tail must keep being dropped ("thoughts grouped at
    // the bottom" regression guard).
    const res = drive(1, false, false);
    assert.strictEqual(res.r, false);
    assert.strictEqual(res.open, false);
  });

  test('a cancelled turn does not arm a drain window', () => {
    const res = drive(1, true, true);
    assert.strictEqual(res.r, false);
    assert.strictEqual(res.open, false);
  });

  test('already-open drain turn adopts further events', () => {
    // Second idle event of the same drain turn: the guard re-enters with
    // claudeDrainTurnOpen true → returns true without re-opening.
    const fnSrc = extractFn('openClaudeDrainTurnIfNeeded');
    const fn = new Function(`
      var claudeDrainTurnOpen = true;
      var drainFollowUpCount = 0;
      var isForceCancelled = false;
      var isClaudeAgent = function() { return true; };
      var opened = 0;
      function setProcessing(v, caller) { opened++; }
      var vscode = { postMessage: function(m) {} };
      ${fnSrc}
      return openClaudeDrainTurnIfNeeded;
    `)();
    const r = fn();
    assert.strictEqual(r, true, 'mid-drain events keep processing');
  });
});

/**
 * The multi-steer regression: queue 3 messages mid-turn. promptEnd arms
 * drainFollowUpCount=3. Each follow-up turn opens (openClaudeDrainTurnIfNeeded)
 * then closes (closeClaudeDrainTurn) on its session_info_update. With the old
 * one-shot boolean, the first close cleared the flag and follow-ups 2 and 3 hit
 * an unarmed opener → dropped. With the counter, all 3 open, and the 4th open
 * (no steer left) returns false.
 */
suite('multi-steer drain: all follow-ups get a turn', () => {
  const opener = extractFn('openClaudeDrainTurnIfNeeded');
  const closer = extractFn('closeClaudeDrainTurn');
  // Stub every global the closer touches so its body runs without the DOM.
  const cycle = new Function(`
    var claudeDrainTurnOpen = false;
    var drainFollowUpCount = 0;
    var isForceCancelled = false;
    var isClaudeAgent = function() { return true; };
    var chatHistory = [];
    var currentTurnEl = null, currentToolsListEl = null, currentToolsCountEl = null, currentToolCount = 0;
    var compactMode = false;
    var currentAssistantEl = null, currentAssistantText = '';
    var isSendingPrompt = false, isCompacting = false, isProcessing = false;
    var turnTailGraceUntil = 0;
    var messageQueue = [];
    var TURN_TAIL_GRACE_MS = 250;
    function saveState() {}
    function refreshPsPanelIfVisible() {}
    function ensureTurnFoldStructure(a, b) {}
    function commitCurrentTextSegment() {}
    function drainQueue() {}
    var opened = 0, closed = 0;
    function setProcessing(v, caller) { if (v) opened++; else closed++; }
    var vscode = { postMessage: function(m) {} };
    ${opener}
    ${closer}
    return function(steerCount) {
      drainFollowUpCount = steerCount;
      var opens = 0;
      for (var n = 0; n < steerCount + 1; n++) {
        if (openClaudeDrainTurnIfNeeded()) opens++;
        else break;
        closeClaudeDrainTurn();
      }
      return { opens: opens, count: drainFollowUpCount };
    };
  `)();

  test('3 steers open 3 drain turns, not 1', () => {
    const res = cycle(3);
    assert.strictEqual(res.opens, 3, 'each follow-up gets its own client-owned turn');
    assert.strictEqual(res.count, 0, 'all three slots consumed');
  });

  test('a single steer still opens exactly one turn', () => {
    const res = cycle(1);
    assert.strictEqual(res.opens, 1);
    assert.strictEqual(res.count, 0);
  });
});

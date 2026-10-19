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
    if (src[i] === '{') {
      depth++;
    } else if (src[i] === '}') {
      depth--;
    }
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
  // closeClaudeDrainTurn defers its idle flip via armDrainTurnIdle once the
  // commit had a live element; the FIFO drain moved into
  // drainAfterDrainTurnClose. Extract all three so the closer's body resolves.
  const armIdle = extractFn('armDrainTurnIdle');
  const releaseIdle = extractFn('releaseDrainTurnIdle');
  const afterDrain = extractFn('drainAfterDrainTurnClose');
  // Stub every global the closer touches so its body runs without the DOM.
  const cycle = new Function(`
    var claudeDrainTurnOpen = false;
    var drainFollowUpCount = 0;
    var drainTurnIdlePending = null;
    var historyRenderGen = 0;
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
    // The fallback timer is real in the webview; stub the scheduler so the
    // cycle test stays synchronous and leaks no timers. Shadow the globals the
    // extracted source calls by name (setTimeout/clearTimeout).
    var _timerSeq = 0;
    function setTimeout(fn, ms) { _timerSeq++; return _timerSeq; }
    function clearTimeout(t) {}
    ${opener}
    ${armIdle}
    ${releaseIdle}
    ${afterDrain}
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

/**
 * The "no response after end_turn" symptom (2026-10-14). closeClaudeDrainTurn
 * committed the drain reply and flipped isProcessing=false in the same tick, so
 * the spinner/Stop state went idle ~155ms BEFORE the committed render
 * round-tripped — the turn looked finished on an empty bubble. Observed in
 * 1-ACP Client.log: `setProcessing: true → false caller=claude-drain-turn-end`
 * at 02:38:03.435, then `DISCARDED (stale gen=84 current=85)` at .444/.517, and
 * the painted render only at .590. The fix latches the idle flip on the render
 * ack (releaseDrainTurnIdle) with a bounded fallback timer.
 */
suite('deferred drain-turn idle flip', () => {
  const arm = extractFn('armDrainTurnIdle');
  const release = extractFn('releaseDrainTurnIdle');
  const afterDrain = extractFn('drainAfterDrainTurnClose');
  const closer = extractFn('closeClaudeDrainTurn');

  function harness(): any {
    return new Function(`
      var claudeDrainTurnOpen = true;
      var drainFollowUpCount = 0;
      var drainTurnIdlePending = null;
      var historyRenderGen = 7;
      var isForceCancelled = false;
      var isClaudeAgent = function() { return true; };
      var chatHistory = [];
      var currentTurnEl = null, currentToolsListEl = null, currentToolsCountEl = null, currentToolCount = 0;
      var compactMode = false;
      var currentAssistantEl = null, currentAssistantText = '';
      var isSendingPrompt = false, isCompacting = false, isProcessing = true;
      var turnTailGraceUntil = 0;
      var messageQueue = [];
      var TURN_TAIL_GRACE_MS = 250;
      function saveState() {}
      function refreshPsPanelIfVisible() {}
      function ensureTurnFoldStructure(a, b) {}
      function commitCurrentTextSegment() {}
      function drainQueue() {}
      var idleFlips = 0, drains = 0;
      function setProcessing(v, caller) { if (!v) idleFlips++; }
      var vscode = { postMessage: function(m) {} };
      var _timerSeq = 0, _firedFns = [];
      function setTimeout(fn, ms) { _timerSeq++; _firedFns.push(fn); return _timerSeq; }
      function clearTimeout(t) {}
      ${arm}
      ${release}
      ${afterDrain}
      ${closer}
      return {
        close: function(hadEl) {
          claudeDrainTurnOpen = true;
          currentAssistantEl = hadEl ? { classList: { add: function(){} } } : null;
          currentAssistantText = hadEl ? 'reply' : '';
          // Mirror the real commit: it pushes the assistant row BEFORE the
          // latch reads chatHistory.length - 1 for the committed index.
          commitCurrentTextSegment = function() {
            if (currentAssistantEl) { chatHistory.push({ kind: 'message', role: 'assistant', text: currentAssistantText }); }
            currentAssistantEl = null;
          };
          closeClaudeDrainTurn();
          return { pending: drainTurnIdlePending, idleFlips: idleFlips };
        },
        release: function() { var before = idleFlips; releaseDrainTurnIdle(); return { idleFlips: idleFlips, delta: idleFlips - before, pending: drainTurnIdlePending }; },
        pending: function() { return drainTurnIdlePending; },
        fireFallback: function() { var fns = _firedFns.slice(); _firedFns = []; fns.forEach(function(f){ f(); }); return { idleFlips: idleFlips }; },
      };
    `)();
  }

  test('a commit WITH a live element arms the latch and does NOT flip idle yet', () => {
    const h = harness();
    const res = h.close(true);
    assert.ok(res.pending, 'latch armed');
    assert.strictEqual(res.pending.index, 0, 'latches the just-committed index');
    assert.strictEqual(res.pending.hgen, 7, 'latches the current history gen');
    assert.strictEqual(res.idleFlips, 0, 'processing stays on until the render ack');
  });

  test('the render ack releases the latch and flips idle exactly once', () => {
    const h = harness();
    h.close(true);
    const rel = h.release();
    assert.strictEqual(rel.delta, 1, 'idle flipped once on ack');
    assert.strictEqual(rel.pending, null, 'latch cleared');
    // A second release (e.g. a duplicate ack) is a no-op.
    const again = h.release();
    assert.strictEqual(again.delta, 0, 'double release does not flip twice');
  });

  test('the fallback timer releases a latch whose ack never came', () => {
    const h = harness();
    h.close(true);
    const res = h.fireFallback();
    assert.strictEqual(res.idleFlips, 1, 'fallback flips idle so processing cannot wedge');
    assert.strictEqual(h.pending(), null, 'latch cleared by the fallback');
  });

  test('a commit with NO live element flips idle immediately', () => {
    const h = harness();
    const res = h.close(false);
    assert.strictEqual(res.pending, null, 'nothing to wait for — no latch');
    assert.strictEqual(res.idleFlips, 1, 'empty drain commit still ends the turn');
  });

  test('re-arming replaces the previous latch and clears its timer', () => {
    const h = harness();
    h.close(true);
    const first = h.pending();
    h.close(true);
    const second = h.pending();
    assert.ok(second, 'second arm still has a latch');
    assert.notStrictEqual(second, first, 'a fresh latch object replaces the old one');
    assert.strictEqual(h.release().delta, 1, 'only one idle flip survives the re-arm');
  });
});

suite('claude drain Stop stays up across the end_turn gap', () => {
  const drive = new Function(`
    ${extractFn('armClaudeDrainStopIfNeeded')}
    var claudeDrainTurnOpen = false;
    var drainFollowUpCount = 0;
    var isForceCancelled = false;
    var isProcessing = false;
    var calls = [];
    function isClaudeAgent() { return true; }
    function setProcessing(v, caller) { isProcessing = v; calls.push(caller); }
    var vscode = { postMessage: function() {} };
    return function(count, cancelled) {
      claudeDrainTurnOpen = false;
      drainFollowUpCount = count;
      isForceCancelled = cancelled;
      isProcessing = false;
      calls = [];
      var held = armClaudeDrainStopIfNeeded();
      return { held: held, open: claudeDrainTurnOpen, processing: isProcessing, calls: calls };
    };
  `)();

  test('a steered follow-up holds Stop in the same turn as promptEnd', () => {
    const r = drive(1, false);
    assert.strictEqual(r.held, true);
    assert.strictEqual(r.open, true, 'drain turn is open before the first chunk');
    assert.strictEqual(r.processing, true);
    assert.deepStrictEqual(r.calls, ['promptEnd-claude-drain-armed']);
  });

  test('an idle end_turn with nothing queued does not hold Stop', () => {
    const r = drive(0, false);
    assert.strictEqual(r.held, false);
    assert.strictEqual(r.open, false);
    assert.strictEqual(r.processing, false);
  });

  test('a forced cancel does not hold Stop', () => {
    const r = drive(1, true);
    assert.strictEqual(r.held, false);
    assert.strictEqual(r.open, false);
  });
});

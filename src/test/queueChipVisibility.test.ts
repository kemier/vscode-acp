import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * A message queued mid-turn showed no chip until the turn ended.
 *
 * The reported symptom was "the queued message is invisible during streaming,
 * then appears after end_turn" — and pressing Stop made it appear in the panel
 * and start a new turn, which is drainQueue's normal behaviour. That last part is
 * the important clue: drainQueue can only dequeue an entry that IS in
 * messageQueue, so handleQueue -> queueMessage -> renderQueue had all run and the
 * chip HAD been appended. Executing the real renderQueue against a stub DOM
 * confirmed it: one chip appended, container displayed, no exception thrown.
 *
 * The chip was in the DOM with a used height of zero.
 *
 * .msg-queue declares overflow-y:auto, and a flex item whose overflow is not
 * visible has an automatic minimum size of 0 rather than its content height. Its
 * siblings in .input-area could not give way instead: .input-resize-handle and
 * .input-toolbar are flex-shrink:0, and .input-editor-wrap is flex-basis:0% so it
 * contributes nothing to shrink. Once .input-area has an explicit pixel height —
 * which applyInputHeight gives it as soon as the resize handle is dragged — the
 * queue strip was the only item the flex algorithm could take space from, so it
 * absorbed the entire deficit and flattened to nothing.
 */
const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

function cssBlock(selector: string): string {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const start = src.indexOf(selector + ' {');
  assert.ok(start >= 0, 'CSS block not found: ' + selector);
  const end = src.indexOf('}', start);
  assert.ok(end > start, 'unterminated CSS block: ' + selector);
  return src.slice(start, end);
}

function fnBody(name: string): string {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' not found');
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') {
      depth++;
    } else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        break;
      }
    }
  }
  return src.slice(start, i + 1);
}

suite('a message queued mid-turn renders a visible chip', () => {
  test('the queue strip cannot be shrunk away by the composer', () => {
    const block = cssBlock('.msg-queue');
    // The scroll container is what makes the automatic minimum size 0, so the
    // explicit shrink guard is the only thing keeping the strip measurable.
    assert.ok(block.includes('overflow-y: auto'), 'expected the strip to stay scrollable: ' + block);
    assert.ok(
      /flex-shrink:\s*0/.test(block),
      '.msg-queue must be flex-shrink:0 — it is a scroll container inside a ' +
        'fixed-height column flex parent, so without this the flex algorithm ' +
        'crushes it to zero height and the chip renders invisibly: ' +
        block,
    );
  });

  test('the queue label is likewise not a shrink target', () => {
    assert.ok(
      /flex-shrink:\s*0/.test(cssBlock('.msg-queue-label')),
      '.msg-queue-label must not absorb the deficit either',
    );
  });

  test('renderQueue restores the stylesheet display value instead of block', () => {
    const fn = fnBody('renderQueue');
    assert.ok(
      fn.includes("msgQueueEl.style.display = 'flex'"),
      "renderQueue must set display 'flex': the stylesheet lays .msg-queue out " +
        'as a wrapping flex row with a gap, and an inline block overrode it: ' +
        fn.slice(0, 400),
    );
    assert.ok(
      !fn.includes("msgQueueEl.style.display = 'block'"),
      'renderQueue must not force display:block on the flex container',
    );
  });

  test('renderQueue reports the measured box, not just the intended style', () => {
    const fn = fnBody('renderQueue');
    assert.ok(
      fn.includes('reportQueueVisibility()'),
      'renderQueue must hand off to the visibility probe after appending chips',
    );
    const probe = fnBody('reportQueueVisibility');
    // offsetHeight is the whole point: every other signal (queue length, child
    // count, display) said the chip was fine while it was zero-height.
    assert.ok(probe.includes('offsetHeight'), 'the probe must measure used height: ' + probe);
    assert.ok(
      probe.includes('requestAnimationFrame'),
      'measure after layout has settled, not synchronously after appendChild',
    );
    assert.ok(probe.includes('VERDICT=CRUSHED'), 'the probe must name the zero-height failure so a repro is greppable');
  });

  test('the chip-visibility markers actually reach the log', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    const start = src.indexOf('const RESUME_DIAG_MARKERS');
    const end = src.indexOf('];', start);
    const markers = src.slice(start, end);
    // These were emitted all along and filtered out here, which is why every
    // earlier repro produced an empty log.
    for (const marker of ['[WV-PROBE]', '[DRAIN-DBG]', '[WV-QUEUEVIS]', '[WV-ERROR]']) {
      assert.ok(markers.includes(marker), 'RESUME_DIAG_MARKERS must forward ' + marker);
    }
  });

  test('uncaught webview errors are forwarded instead of swallowed', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    assert.ok(
      src.includes("window.addEventListener('error'"),
      'the webview must report uncaught errors — a throw inside a render ' +
        'function otherwise leaves a half-built DOM and no trace',
    );
    assert.ok(src.includes("window.addEventListener('unhandledrejection'"), 'rejected promises must be reported too');
    assert.ok(src.includes('[WV-ERROR]'), 'errors must carry the [WV-ERROR] marker');
  });

  test('the verbose resume traces stay out of both ungated lists', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    const start = src.indexOf('const WEBVIEW_ALWAYS_LOG_MARKERS');
    assert.ok(start > 0, 'WEBVIEW_ALWAYS_LOG_MARKERS must exist');
    const always = src.slice(start, src.indexOf('];', start));
    const qStart = src.indexOf('const WEBVIEW_QUEUE_DEBUG_MARKERS');
    const gated = src.slice(qStart, src.indexOf('];', qStart));
    // [WV-PROBE] and [DRAIN-DBG] fire far more often than one line per submission and
    // belong to the resume investigation, so they stay under acp.debugResume alone.
    for (const marker of ['[WV-PROBE]', '[DRAIN-DBG]']) {
      assert.ok(!always.includes(marker), marker + ' must not be always-on');
      assert.ok(!gated.includes(marker), marker + ' belongs to the resume gate, not this one');
    }
  });

  test('the visibility probe can see past the strip itself', () => {
    const probe = fnBody('reportQueueVisibility');
    // offsetHeight alone cannot distinguish "crushed" from "fine but hidden by a
    // parent" or "laid out off-screen", which are different bugs.
    assert.ok(probe.includes('getBoundingClientRect'), 'must compare against the viewport');
    assert.ok(probe.includes('onScreen='), 'must state whether the strip is on screen');
    assert.ok(probe.includes('ancestors='), 'must report the ancestor chain');
    assert.ok(probe.includes('parentElement'), 'must actually walk parents');
  });

  test('faults reach a file, not only the flush-timed output channel', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    // During the reproduction the window's output_logging_* directory held
    // 2-ACP Traffic.log at 360 KB and no 1-ACP Client.log at all, so every
    // always-logged fault line was still unreadable.
    assert.ok(src.includes('appendWebviewFault'), 'a file-backed fault sink must exist');
    assert.ok(src.includes('webview-faults.log'), 'faults must land in a named file');
    const at = src.indexOf('private appendWebviewFault(');
    assert.ok(at > 0, 'appendWebviewFault must be a method on the provider');
    const fn = src.slice(at, src.indexOf('\n  }', at));
    assert.ok(fn.includes('appendFileSync'), 'the write must be synchronous to survive a live turn');
    assert.ok(!fn.includes('isDebugResume'), 'the fault sink must not be gated by a setting');
  });

  test('faults are ungated; queue traces are gated but kept', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    const always = src.slice(
      src.indexOf('const WEBVIEW_ALWAYS_LOG_MARKERS'),
      src.indexOf('];', src.indexOf('const WEBVIEW_ALWAYS_LOG_MARKERS')),
    );
    const gated = src.slice(
      src.indexOf('const WEBVIEW_QUEUE_DEBUG_MARKERS'),
      src.indexOf('];', src.indexOf('const WEBVIEW_QUEUE_DEBUG_MARKERS')),
    );
    // An uncaught exception is a defect that already happened and emits nothing in a
    // healthy session, so there is no cost to leaving it on — and a demonstrated cost
    // to gating it: a ReferenceError in queueMessage stayed invisible for sessions.
    assert.ok(always.includes('[WV-ERROR]'), 'uncaught errors must never be gated');
    for (const chatty of ['[WV-QUEUE]', '[WV-QUEUEVIS]']) {
      assert.ok(!always.includes(chatty), chatty + ' is per-keystroke and must be gated');
      assert.ok(gated.includes(chatty), chatty + ' must still be available behind the gate');
    }
  });

  test('the queue gate is its own setting, not acp.debugResume', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    const at = src.indexOf('private isDebugWebviewQueue()');
    assert.ok(at > 0, 'a dedicated gate must exist');
    const fn = src.slice(at, src.indexOf('\n  }', at));
    // acp.debugResume declares no scope, defaults to `window`, and a remote window
    // reads Machine settings above User settings — it resolved false while appearing
    // enabled. Reusing it would inherit that trap.
    assert.ok(fn.includes("get<boolean>('debugWebviewQueue', false)"), fn);
    assert.ok(!fn.includes('debugResume'), 'must not piggyback on acp.debugResume');

    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')) as {
      contributes: { configuration: { properties: Record<string, { default: unknown; scope?: string }> } };
    };
    const prop = pkg.contributes.configuration.properties['acp.debugWebviewQueue'];
    assert.ok(prop, 'the setting must be declared so it is discoverable in the UI');
    assert.strictEqual(prop.default, false, 'diagnostics stay off by default');
    // Declared explicitly so nobody has to rediscover the Machine-vs-User precedence.
    assert.strictEqual(prop.scope, 'window', 'scope must be explicit');
  });

  test('the gate is applied in the webview, not just host-side', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    // Discarding host-side would still pay for a layout read and an ancestor walk on
    // every render, plus a postMessage per submission.
    const emit = fnBody('wvQueueLog');
    assert.ok(emit.includes('if (!debugWebviewQueueEnabled) return;'), emit);
    const probe = fnBody('reportQueueVisibility');
    assert.ok(
      probe.includes('if (!debugWebviewQueueEnabled) return;'),
      'the measurement must not run when the gate is off: ' + probe.slice(0, 300),
    );
    // The flag has to reach the webview, and the webview default must match the
    // setting default so behaviour is the same before the first state message.
    assert.ok(src.includes('debugWebviewQueue: this.isDebugWebviewQueue(),'), 'host must push the flag');
    assert.ok(
      src.includes("if (typeof msg.debugWebviewQueue === 'boolean') debugWebviewQueueEnabled = msg.debugWebviewQueue;"),
      'webview must store the pushed flag',
    );
    assert.ok(src.includes('let debugWebviewQueueEnabled = false;'), 'webview default must be off');
  });

  test('uncaught errors are still reported with the gate off', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    // The error listeners must not consult the gate, otherwise turning diagnostics
    // off restores the exact blindness this whole investigation ran into.
    const at = src.indexOf("window.addEventListener('error'");
    const listener = src.slice(at, at + 900);
    assert.ok(!listener.includes('debugWebviewQueueEnabled'), 'error reporting must be unconditional');
    const rej = src.indexOf("window.addEventListener('unhandledrejection'");
    assert.ok(
      !src.slice(rej, rej + 500).includes('debugWebviewQueueEnabled'),
      'rejection reporting must be unconditional',
    );
  });

  test('the fault file is size-capped', () => {
    const at = fs.readFileSync(SOURCE, 'utf8').indexOf('private appendWebviewFault(');
    const fn = fs.readFileSync(SOURCE, 'utf8').slice(at, at + 1400);
    assert.ok(fn.includes('statSync'), 'must check the current size');
    assert.ok(fn.includes('renameSync'), 'must rotate rather than grow without bound');
  });

  test('the always-log branch runs before the debugResume gate', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    const at = src.indexOf("case 'debugLog'");
    assert.ok(at > 0, 'the debugLog handler must exist');
    const body = src.slice(at, at + 1600);
    const always = body.indexOf('isAlwaysLoggedWebviewMessage');
    const gated = body.indexOf('isDebugResume()');
    assert.ok(always > 0, 'the handler must consult the always-log list');
    assert.ok(gated > 0, 'the gated path must still exist for verbose traces');
    assert.ok(always < gated, 'faults must be logged before any setting is consulted');
  });

  test('every composer branch records the decision it took', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    // No chip, no session/steer and no sendPrompt are three ABSENCES that look
    // identical whether the text was queued and mis-rendered, swallowed by a
    // handleSend guard, or never handled at all — and those need different fixes.
    for (const decision of [
      "wvQueueLog('QUEUED'",
      "wvQueueLog('STEERED'",
      "wvQueueLog('DRAINED'",
      "wvQueueLog('steer:SKIP'",
      "wvQueueLog('send:POSTING'",
      "wvQueueLog('send:queueing-midturn'",
      "wvQueueLog('send:GUARD-no-active-session'",
      "wvQueueLog('handleQueue:DROP-empty'",
    ]) {
      assert.ok(src.includes(decision), 'missing decision probe: ' + decision);
    }
  });

  test('each steer bail-out names the gate that stopped it', () => {
    const fn = fnBody('maybeAutoSteerNext');
    const returns = (fn.match(/return false;/g) || []).length;
    const logged = (fn.match(/wvQueueLog\('steer:SKIP'/g) || []).length;
    assert.ok(returns > 0, 'maybeAutoSteerNext must have bail-out paths');
    assert.strictEqual(logged, returns, 'every steer bail-out needs its own logged reason');
  });
});

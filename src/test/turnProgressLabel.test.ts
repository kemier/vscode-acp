import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * A running turn showed a bare spinner and nothing else, so a slow agent was
 * indistinguishable from a hung one. Measured on one codex turn after
 * auto-compaction: 47s, then 99s, then 120s with no frames at all — over four
 * minutes where the only signal was a spinner, reported as "it lasted several
 * minutes to finally make the send button inactivated".
 *
 * The fix is deliberately in the client and agent-independent: nothing in ACP
 * requires an agent to emit progress while it thinks, and every adapter goes quiet
 * during a long model call.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

function extractFn(name: string): string {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' not found');
  // Balance braces from the function's opening brace.
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') {depth++;}
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) {break;}
    }
  }
  return src.slice(start, i + 1);
}

function loadLabelFn(): (elapsedMs: number, idleMs: number) => string {
  const body = extractFn('formatTurnStatusLabel');
  const factory = new Function(`${body}; return formatTurnStatusLabel;`);
  return factory() as (elapsedMs: number, idleMs: number) => string;
}

suite('turn progress label', () => {
  test('shows elapsed time in minutes and seconds', () => {
    const f = loadLabelFn();
    assert.strictEqual(f(0, 0), '0s');
    assert.strictEqual(f(9_000, 0), '9s');
    assert.strictEqual(f(107_000, 0), '1m 47s');
    assert.strictEqual(f(266_000, 0), '4m 26s');
  });

  test('adds the idle figure only once silence is the interesting part', () => {
    const f = loadLabelFn();
    // Frames arriving steadily: no idle noise.
    assert.strictEqual(f(30_000, 5_000), '30s');
    assert.strictEqual(f(30_000, 19_999), '30s');
    // The 120s silent model call from the measured turn.
    assert.ok(f(266_000, 120_000).indexOf('4m 26s') === 0);
    assert.ok(/waiting on agent 2m 0s$/.test(f(266_000, 120_000)), f(266_000, 120_000));
  });

  test('never renders negative or NaN-ish values', () => {
    const f = loadLabelFn();
    assert.strictEqual(f(-5_000, -5_000), '0s');
  });

  test('the ticker is started and cleared by setProcessing, and clock is not restarted', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    assert.ok(src.includes('if (!turnTicker) turnTicker = setInterval(refreshTurnStatusLabel, 1000);'));
    assert.ok(src.includes('if (turnTicker) { clearInterval(turnTicker); turnTicker = null; }'));
    // Re-entry through setProcessing(true) must keep the same turn clock.
    assert.ok(src.includes('if (!turnStartedAt) turnStartedAt = Date.now();'));
  });

  test('a labeled pill is never overwritten, and only agent frames count as liveness', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    const fn = extractFn('refreshTurnStatusLabel');
    // A compaction / clearing pill owns the status area while it is up.
    assert.ok(fn.includes('if (isCompacting || isClearing) return;'), fn);
    // The label lives in its own element (7dae53e) rather than being appended into
    // statusEl, so it cannot clobber the spinner or a pill; it hides itself when no
    // turn is running.
    assert.ok(fn.includes("getElementById('turn-elapsed-label')"), fn);
    assert.ok(fn.includes('if (!isProcessing)'), fn);
    assert.ok(!fn.includes('statusEl.innerHTML'), 'must never rewrite the status area');
    // Client-side chatter must not reset the idle figure.
    assert.ok(src.includes("_wvMsgType !== 'debugLog' && _wvMsgType !== 'state'"));
    assert.ok(src.includes('.turn-elapsed {'), 'the label needs its muted style');
    assert.ok(src.includes('id="turn-elapsed-label"'), 'and its dedicated element');
  });
});

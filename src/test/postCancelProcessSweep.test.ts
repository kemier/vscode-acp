import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Post-cancel process sweep.
 *
 * "Send Now" and Stop kill the turn's spawned processes BEFORE session/cancel
 * (the kill-before-cancel design), but a tool spawned in the race between that
 * sweep and the agent acknowledging the cancel escapes it — in the field a
 * poll_bear.sh (sleep 60 + ssh in a loop) outlived its cancelled turn by 2.5
 * hours, invisible in the UI but still hitting the remote host.
 *
 * Fix: promptEnd with stopReason 'cancelled' fires a second `stopProcesses`
 * sweep — promptEnd only arrives once the host has acknowledged the cancel and
 * the turn's child has closed, so the late stragglers are exactly what a
 * second sweep reaps. It must be suppressed while a session/load replay is in
 * flight (the cancelled turn belongs to the pre-load session) and must not
 * show the "Killed N processes" notice (the kill is an interrupt side effect,
 * not an explicit /stop).
 *
 * The sweep lives inside the webview template literal (it cannot be imported),
 * so this extracts the real fragment and runs it against stubs — the same
 * pattern as foldOrdering.test.ts / sendNowOrdering.test.ts.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

function extractSweepFragment(): string {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const start = src.indexOf("var _wasCancelled = msg.stopReason === 'cancelled';");
  assert.ok(start >= 0, 'post-cancel sweep fragment not found in ChatWebviewProvider.ts');
  const endMarker = '// ── Premature end_turn detection';
  const end = src.indexOf(endMarker, start);
  assert.ok(end > start, 'end marker after the sweep fragment not found');
  return src.slice(start, end).trim();
}

interface Harness {
  posted: any[];
  wasCancelled: boolean;
  run: (stopReason: string | undefined, isLoading: boolean) => void;
}

function makeHarness(): Harness {
  const body = extractSweepFragment();
  const posted: any[] = [];
  const state = { wasCancelled: false };
  const factory = new Function(
    'msg',
    'isLoadingSession',
    'posted',
    'state',
    `
    const vscode = { postMessage: (m) => { posted.push(m); } };
    function markSessionInterrupted() {}
    ${body}
    state.wasCancelled = _wasCancelled;
  `,
  );
  const run = (stopReason: string | undefined, isLoading: boolean) =>
    factory({ stopReason }, isLoading, posted, state) as unknown as void;
  return {
    posted,
    get wasCancelled() {
      return state.wasCancelled;
    },
    run: run as (stopReason: string | undefined, isLoading: boolean) => void,
  };
}

suite('Post-cancel process sweep (promptEnd cancelled)', () => {
  test('a cancelled promptEnd re-sweeps the turn processes, notice suppressed', () => {
    const h = makeHarness();
    h.run('cancelled', false);
    assert.strictEqual(h.wasCancelled, true);
    const sweeps = h.posted.filter((m) => m.type === 'stopProcesses');
    assert.strictEqual(sweeps.length, 1, 'exactly one sweep: ' + JSON.stringify(h.posted));
    assert.strictEqual(
      sweeps[0].suppressNotice,
      true,
      'the interrupt side-effect kill must not show the "Killed N processes" notice',
    );
  });

  test('a normal end_turn does NOT sweep', () => {
    const h = makeHarness();
    h.run('end_turn', false);
    assert.strictEqual(h.wasCancelled, false);
    assert.deepStrictEqual(
      h.posted.filter((m) => m.type === 'stopProcesses'),
      [],
      'only cancelled turns get the straggler sweep — a completed turn owns no live processes',
    );
  });

  test('no sweep while a session/load replay is in flight', () => {
    const h = makeHarness();
    h.run('cancelled', true);
    assert.deepStrictEqual(
      h.posted.filter((m) => m.type === 'stopProcesses'),
      [],
      'during load replay the cancelled turn belongs to the pre-load session',
    );
  });
});

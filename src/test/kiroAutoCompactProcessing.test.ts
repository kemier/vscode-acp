import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * After a kiro-cli AUTO-compaction the composer button flipped back to "Send"
 * while the agent was still streaming — the turn was live but uncontrollable:
 * the user could not stop it, and the button lied about the state.
 *
 * finalizeKiroCompact cleared the processing latch unconditionally. That is
 * right for a MANUAL /compact, which runs through _kiro.dev/commands/execute
 * and therefore produces no promptEnd — nothing else would ever clear it.
 *
 * It is wrong for auto-compaction: the agent compacts because the context
 * filled up mid-turn and then continues streaming the SAME reply. The
 * pendingPostCompactChunks buffer exists precisely to hold that continuation,
 * which is direct evidence the turn outlives the compaction. promptEnd is the
 * only honest terminator there, and the traffic log confirms it always arrives
 * (every completed turn carries a stopReason).
 *
 * manualCompacting already distinguishes the two: the status-RPC entry sets it
 * false ("Status RPC covers auto-compaction too — not a user /compact"), while
 * a manual /compact keeps it true because isCompacting is already set before
 * the RPC lands, so that branch is skipped. The ericli/contextCompaction paths
 * follow the same rule — only failed or cancelled compactions clear the latch.
 *
 * These tests EXECUTE the real extracted function body rather than scanning a
 * fixed-length source window, which silently stops covering the code the moment
 * an unrelated edit lengthens the region.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

/** The whole `function finalizeKiroCompact(notice) { ... }` body, brace-matched. */
function extractFinalizeKiroCompact(): string {
  const src = fs.readFileSync(SOURCE, 'utf8').replace(/\r\n/g, '\n');
  const sig = 'function finalizeKiroCompact(notice) {';
  const at = src.indexOf(sig);
  assert.ok(at >= 0, 'finalizeKiroCompact not found in ChatWebviewProvider.ts');
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') { depth++; } else if (src[i] === '}') {
      if (--depth === 0) { return src.slice(at, i + 1); }
    }
  }
  assert.fail('could not brace-match finalizeKiroCompact');
}

/**
 * Run the real finalizeKiroCompact with stubbed collaborators and report which
 * setProcessing calls it made.
 */
function runFinalize(opts: { isCompacting: boolean; manualCompacting: boolean; hasWarning?: boolean }) {
  const calls: Array<{ value: boolean; reason: string }> = [];
  const flushed: string[] = [];
  const fn = new Function(
    'state',
    'calls',
    'flushed',
    `
      let isCompacting = state.isCompacting;
      let manualCompacting = state.manualCompacting;
      let kiroCompactWatchdog = null;
      let compactedNoticeText = '';
      let compactedWarningText = state.hasWarning ? 'warn' : '';
      function clearTimeout() {}
      function hideCompactionProgress() { flushed.push('hideCompactionProgress'); }
      function flushCompactionMessages() { flushed.push('flushCompactionMessages'); }
      function scheduleCompactionFlush() { flushed.push('scheduleCompactionFlush'); }
      function setProcessing(value, reason) { calls.push({ value: value, reason: reason }); }
      ${extractFinalizeKiroCompact()}
      finalizeKiroCompact('Conversation compacted.');
      return { notice: compactedNoticeText };
    `,
  );
  const out = fn(opts, calls, flushed);
  return { calls, flushed, notice: out.notice as string };
}

suite('kiro compaction keeps the Stop button during an auto-compacted turn', () => {
  test('auto-compaction does NOT clear the processing latch', () => {
    const { calls } = runFinalize({ isCompacting: true, manualCompacting: false });
    const cleared = calls.filter((c) => c.value === false);
    assert.deepStrictEqual(
      cleared,
      [],
      `auto-compaction must leave the turn active for promptEnd; got ${JSON.stringify(calls)}`,
    );
  });

  test('manual /compact DOES clear the latch (no promptEnd will arrive)', () => {
    const { calls } = runFinalize({ isCompacting: true, manualCompacting: true });
    const cleared = calls.filter((c) => c.value === false);
    assert.strictEqual(cleared.length, 1, `manual /compact must end the turn; got ${JSON.stringify(calls)}`);
    // The reason string is what makes a future regression diagnosable in the log.
    assert.ok(/manual/.test(cleared[0].reason), `reason should name the manual path: ${cleared[0].reason}`);
  });

  test('the compaction notice and flush still happen in both modes', () => {
    for (const manualCompacting of [true, false]) {
      const { flushed, notice } = runFinalize({ isCompacting: true, manualCompacting });
      assert.ok(
        flushed.includes('hideCompactionProgress'),
        `progress not hidden (manual=${manualCompacting})`,
      );
      assert.ok(
        flushed.includes('flushCompactionMessages'),
        `history not flushed (manual=${manualCompacting})`,
      );
      assert.strictEqual(notice, 'Conversation compacted.', `notice lost (manual=${manualCompacting})`);
    }
  });

  test('a warning defers the flush instead of dropping it, in both modes', () => {
    for (const manualCompacting of [true, false]) {
      const { flushed } = runFinalize({ isCompacting: true, manualCompacting, hasWarning: true });
      assert.ok(
        flushed.includes('scheduleCompactionFlush'),
        `warning path must defer the flush (manual=${manualCompacting})`,
      );
    }
  });

  test('does nothing at all when no compaction is in progress', () => {
    const { calls, flushed } = runFinalize({ isCompacting: false, manualCompacting: true });
    assert.deepStrictEqual(calls, [], 'must not touch processing outside a compaction');
    assert.deepStrictEqual(flushed, [], 'must not flush outside a compaction');
  });
});

suite('successful compaction never clears processing (cross-agent rule)', () => {
  const src = fs.readFileSync(SOURCE, 'utf8');

  test('every setProcessing(false) tied to compaction names a terminal outcome', () => {
    // A successful compaction is an interlude inside a turn for every agent that
    // auto-compacts, so only a manual invocation or a terminal outcome
    // (failed / cancelled / timeout / error / cleared) may drop the latch.
    const reasons = Array.from(src.matchAll(/setProcessing\(false,\s*'([^']+)'\)/g)).map((m) => m[1]);
    const compactionReasons = reasons.filter((r) => /compact/i.test(r));
    assert.ok(compactionReasons.length > 0, 'no compaction-related setProcessing(false) found');
    for (const reason of compactionReasons) {
      assert.ok(
        /fail|cancel|timeout|error|clear|manual/i.test(reason),
        `"${reason}" clears the Stop button on a compaction that is not terminal or manual — ` +
          'an auto-compacted turn keeps streaming and must wait for promptEnd',
      );
    }
  });
});

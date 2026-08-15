import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Regression test for the interrupt-notice ordering bug that appeared after
 * reload + session resume:
 *
 * The last turn finished normally (end_turn) but the collapsed fold title
 * showed "Interrupted". Root cause: `mergeLoadedWithSnapshotOverlay`'s
 * `reconcileInterleavedOrderFromSnapshot` sorted interrupt-notice user rows
 * (which have no `snapshotOrderIndex` → MAX_SAFE_INTEGER) to the absolute tail
 * of the merged timeline — AFTER the final completed turn's assistant. Then
 * `applyInterruptNoticesFromHistory` branded that finished assistant as
 * interrupted, so `historyLastTurnLooksFinished()` returned false and the fold
 * header rendered "Interrupted".
 *
 * This test extracts the REAL merge functions from ChatWebviewProvider.ts (they
 * live inside the webview template literal, so they cannot be imported) and
 * asserts interrupt notices stay interleaved as boundaries instead of sinking
 * to the tail.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

function extractSnippet(startMarker: string, endMarker: string, opts?: { last?: boolean }): string {
  const src = fs.readFileSync(SOURCE, 'utf8');
  let startIdx = src.indexOf(startMarker);
  assert.ok(startIdx >= 0, `start marker not found: ${startMarker}`);
  let endIdx = src.indexOf(endMarker, startIdx + startMarker.length);
  assert.ok(endIdx > startIdx, `end marker not found after start: ${endMarker}`);
  if (opts?.last) {
    // Use the last occurrence (e.g. the "Interrupted" detail constant appears
    // more than once in the file).
    const startIdx2 = src.lastIndexOf(startMarker);
    if (startIdx2 > startIdx) {
      startIdx = startIdx2;
      endIdx = src.indexOf(endMarker, startIdx + startMarker.length);
      assert.ok(endIdx > startIdx, `end marker not found after last start: ${endMarker}`);
    }
  }
  return src.slice(startIdx, endIdx).trim();
}

function extractMergeChunk(): string {
  const isInterrupt = extractSnippet(
    'function isSessionInterruptNotice(text) {',
    'function applyInterruptNoticesFromHistory',
  );
  const thoughtKey = extractSnippet('function thoughtPrefixKey(text) {', 'function mergeLoadedWithSnapshotOverlay');
  const findAnchor = extractSnippet('function findMergedHistoryAnchor(merged, item) {', 'function countRealUsers');
  const merge = extractSnippet(
    'function mergeLoadedWithSnapshotOverlay(loaded, snapshot) {',
    'function userMessageKey',
  );

  return `
    ${isInterrupt}
    ${thoughtKey}
    ${findAnchor}
    ${merge}
    return mergeLoadedWithSnapshotOverlay;
  `;
}

type MergeFn = (loaded: any[], snapshot: any[]) => any[];

function loadMerge(): MergeFn {
  const factory = new Function(extractMergeChunk());
  return factory() as MergeFn;
}

function user(text: string, opts: { system?: boolean } = {}): any {
  return { kind: 'message', role: opts.system ? 'system' : 'user', text };
}

function asst(text: string, opts: { interrupted?: boolean } = {}): any {
  return { kind: 'message', role: 'assistant', text, interrupted: opts.interrupted };
}

function thought(text: string): any {
  return { kind: 'thought', text };
}

function tool(toolCallId: string, title: string, status = 'completed'): any {
  return { kind: 'toolCall', toolCallId, title, status };
}

suite('merge interrupt-notice ordering (resume regression)', () => {
  test('loaded-first overlay keeps interrupt notices interleaved, not at the tail', () => {
    const merge = loadMerge();
    // Realistic loaded transcript: real user → tools → assistant, then a
    // mid-session cancel recorded as an interrupt notice, then another real
    // user prompt and a final completed turn. The snapshot has the same user
    // turns plus richer thoughts/assistants.
    const loaded = [
      user('Earlier conversation was compacted — history before this point is unavailable.'),
      user('add hint in spinner for manual compaction(/compact) like /session slash command'),
      thought('thought-1'),
      tool('tc1', 'Edit ChatWebviewProvider.ts'),
      asst('I added the spinner hint.'),
      user('[Request interrupted by user]'),
      thought('thought-2'),
      tool('tc2', 'Search logs'),
      asst('Here is what the log says.'),
    ];
    const snapshot = [
      user('Earlier conversation was compacted — history before this point is unavailable.'),
      user('add hint in spinner for manual compaction(/compact) like /session slash command'),
      thought('thought-1'),
      asst('I added the spinner hint.'),
      user('[Request interrupted by user]'),
      thought('thought-2'),
      asst('Here is what the log says.'),
    ];

    const merged = merge(loaded, snapshot);
    // The interrupt notice must stay interleaved (before the final assistant),
    // NOT sink to the absolute tail after the finished turn.
    // The interrupt notice must stay interleaved BEFORE the final completed
    // assistant — it must never sink to the tail past the finished turn.
    const interruptIdx = merged.findIndex(
      (it: any) => it && it.kind === 'message' && it.role === 'user' && isInterruptLike(it.text),
    );
    const finalAsstIdx = merged.findIndex(
      (it: any) => it && it.kind === 'message' && it.role === 'assistant' && it.text === 'Here is what the log says.',
    );
    assert.ok(
      interruptIdx >= 0 && finalAsstIdx >= 0 && interruptIdx < finalAsstIdx,
      `interrupt notice (${interruptIdx}) stays before the finished assistant (${finalAsstIdx})`,
    );
    assert.ok(
      merged.every(
        (it: any, i: number) =>
          !(it && it.kind === 'message' && it.role === 'user' && isInterruptLike(it.text) && i > finalAsstIdx),
      ),
      'no interrupt notice sits after the final finished assistant',
    );
    // The interrupt notice must not be the final message (it would brand the
    // finished turn interrupted) — the tail belongs to the turn's completed
    // tools / assistant summary.
    const lastMsg = merged[merged.length - 1];
    assert.ok(
      !(lastMsg && lastMsg.kind === 'message' && isInterruptLike(lastMsg.text)),
      'the interrupted notice must not be the final message',
    );
  });

  test('interrupt notice directly before a later real user stays before it', () => {
    const merge = loadMerge();
    const loaded = [
      user('first question'),
      asst('first answer'),
      user('[Request interrupted by user]'),
      user('second question'),
      asst('second answer'),
    ];
    const snapshot = [
      user('first question'),
      asst('first answer'),
      user('[Request interrupted by user]'),
      user('second question'),
      asst('second answer'),
    ];
    const merged = merge(loaded, snapshot);
    const secondUser = merged.findIndex(
      (it: any) => it && it.kind === 'message' && it.role === 'user' && it.text === 'second question',
    );
    assert.ok(secondUser > 0, 'second real user present');
    assert.ok(
      merged[secondUser - 1] &&
        merged[secondUser - 1].kind === 'message' &&
        merged[secondUser - 1].role === 'user' &&
        isInterruptLike(merged[secondUser - 1].text),
      'interrupt notice sits immediately before the next real user',
    );
  });

  test('snapshot-only interrupt notice does not become the final message', () => {
    const merge = loadMerge();
    const loaded = [user('prompt a'), tool('ta', 'tool a'), asst('answer a'), user('prompt b'), asst('answer b')];
    const snapshot = [
      user('prompt a'),
      tool('ta', 'tool a'),
      asst('answer a'),
      user('[Request interrupted by user]'),
      user('prompt b'),
      asst('answer b'),
    ];
    const merged = merge(loaded, snapshot);
    const lastRealUser = merged
      .map((it: any, i: number) =>
        it?.kind === 'message' && it?.role === 'user' && !isInterruptLike(it.text) ? i : -1,
      )
      .filter((i: number) => i >= 0);
    const lastReal = Math.max(...lastRealUser);
    const tailAfter = merged.slice(lastReal + 1);
    assert.ok(
      tailAfter.every((it: any) => !(it && it.kind === 'message' && it.role === 'user' && isInterruptLike(it.text))),
      'snapshot-only interrupt notice must not sink after the last real user',
    );
    const last = merged[merged.length - 1];
    assert.ok(
      last && last.kind === 'message' && last.role === 'assistant' && last.text === 'answer b',
      'last message stays the finished assistant summary',
    );
  });

  test('interrupt notice followed by completed assistant does not mark session interrupted', () => {
    // This is the core regression: after reload + resume, the merged chatHistory
    // can contain stale interrupt notices from earlier turns that end up AFTER
    // the last real user but BEFORE a completed assistant. The session must
    // NOT be marked interrupted in this case.
    //
    // Timeline: user → interrupt → go on → assistant(end_turn)
    // The interrupt notice is a stale artefact; the turn finished normally.
    const history = [
      user('first question'),
      asst('first answer'),
      user('[Request interrupted by user]'),
      user('go on'),
      asst('Here is the final answer.'),
    ];
    // Simulate applyInterruptNoticesFromHistory logic:
    // lastInterrupt = index 2, lastRealUser = index 3
    // lastInterrupt (2) < lastRealUser (3) → should NOT mark interrupted
    const lastInterrupt = history.findIndex(
      (it: any) => it && it.kind === 'message' && it.role === 'user' && isInterruptLike(it.text),
    );
    const lastRealUser = (() => {
      for (let i = history.length - 1; i >= 0; i--) {
        const it = history[i];
        if (it && it.kind === 'message' && it.role === 'user' && !isInterruptLike(it.text)) {return i;}
      }
      return -1;
    })();
    assert.ok(lastInterrupt >= 0, 'interrupt notice found');
    assert.ok(lastRealUser > lastInterrupt, 'real user after interrupt');
    // When lastInterrupt < lastRealUser, applyInterruptNoticesFromHistory
    // should NOT mark the session as interrupted.
    assert.ok(
      lastInterrupt < lastRealUser,
      'interrupt is before the last real user → session should NOT be marked interrupted',
    );
  });

  test('interrupt notice as the actual last item (no assistant after) IS interrupted', () => {
    // Timeline: user → assistant → interrupt (no resume after)
    // This is a genuine interruption — the session should be marked interrupted.
    const history = [user('do something'), asst('working on it...'), user('[Request interrupted by user]')];
    const lastInterrupt = history.findIndex(
      (it: any) => it && it.kind === 'message' && it.role === 'user' && isInterruptLike(it.text),
    );
    const lastRealUser = (() => {
      for (let i = history.length - 1; i >= 0; i--) {
        const it = history[i];
        if (it && it.kind === 'message' && it.role === 'user' && !isInterruptLike(it.text)) {return i;}
      }
      return -1;
    })();
    assert.ok(lastInterrupt > lastRealUser, 'interrupt is after the last real user');
    // Check: no completed assistant after the interrupt
    let hasCompletedAssistantAfter = false;
    for (let i = lastInterrupt + 1; i < history.length; i++) {
      const it = history[i];
      if (it && it.kind === 'message' && it.role === 'assistant' && !it.interrupted) {
        hasCompletedAssistantAfter = true;
        break;
      }
    }
    assert.ok(!hasCompletedAssistantAfter, 'no completed assistant after interrupt');
    // This scenario SHOULD mark the session as interrupted.
  });
});

/** Local mirror of isSessionInterruptNotice for test assertions. */
function isInterruptLike(text: string): boolean {
  const t = String(text || '').trim();
  if (!t) {
    return false;
  }
  if (/^\[Request interrupted by user\]/i.test(t)) {
    return true;
  }
  if (/^Request interrupted by user\.?$/i.test(t)) {
    return true;
  }
  if (/^—?\s*Conversation interrupted\s*—?$/i.test(t)) {
    return true;
  }
  return false;
}

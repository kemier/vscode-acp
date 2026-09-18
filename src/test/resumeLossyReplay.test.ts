import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { REPLAY_CHUNK_LINE_CAP, replayChunkPreview, shouldTraceReplayChunk } from '../utils/Logger';

/**
 * Covers the two halves of the "resumed Kiro session lost its summary" fix:
 *
 * 1. Diagnosis — assistant/thought chunks are normally dropped from the traffic
 *    log (token deltas), which made the replay chronology invisible. They are
 *    now traced while a session/load is unanswered.
 * 2. Repair — Kiro's session/load omits every assistant record that carries no
 *    tool call (each end-of-turn reply). The webview repairs that from a
 *    snapshot, but the snapshot only covered the last session on screen, so
 *    A → B → A came back without the summary. A per-session archive supplies it.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

suite('replay chunk tracing', () => {
  test('traces chunks only while a session/load is unanswered', () => {
    assert.strictEqual(shouldTraceReplayChunk(['session/load'], 0), true);
    assert.strictEqual(shouldTraceReplayChunk(['session/prompt'], 0), false);
    assert.strictEqual(shouldTraceReplayChunk([], 0), false);
    // Concurrent requests: the load anywhere in the pending set counts.
    assert.strictEqual(shouldTraceReplayChunk(['session/prompt', 'session/load'], 0), true);
  });

  test('stops tracing at the per-load cap', () => {
    assert.strictEqual(shouldTraceReplayChunk(['session/load'], REPLAY_CHUNK_LINE_CAP - 1), true);
    assert.strictEqual(shouldTraceReplayChunk(['session/load'], REPLAY_CHUNK_LINE_CAP), false);
  });

  test('previews are single-line and length-capped', () => {
    assert.strictEqual(replayChunkPreview('  hello\n  world\t '), 'hello world');
    assert.strictEqual(replayChunkPreview(undefined), '');
    const long = replayChunkPreview('x'.repeat(200));
    assert.strictEqual(long.length, 71);
    assert.ok(long.endsWith('…'));
  });
});

suite('per-session history archive', () => {
  function loadArchiveFns() {
    const src = fs.readFileSync(SOURCE, 'utf8');
    const start = src.indexOf('var SESSION_ARCHIVE_MAX_SESSIONS =');
    assert.ok(start > 0, 'SESSION_ARCHIVE_MAX_SESSIONS not found');
    const end = src.indexOf('let previousSessionId', start);
    assert.ok(end > start, 'end marker after archiveSessionHistory not found');
    const body = src.slice(start, end);
    const factory = new Function(
      body +
        '\nreturn { archiveSessionHistory: archiveSessionHistory, store: sessionHistoryArchive, order: sessionHistoryArchiveOrder, max: SESSION_ARCHIVE_MAX_SESSIONS };',
    );
    return factory() as {
      archiveSessionHistory: (id: string | null, items: unknown[] | null) => void;
      store: Record<string, unknown[]>;
      order: string[];
      max: number;
    };
  }

  test('archives a copy per session and ignores empty input', () => {
    const a = loadArchiveFns();
    const items = [{ kind: 'message', role: 'assistant', text: 'summary' }];
    a.archiveSessionHistory('sess-1', items);
    assert.deepStrictEqual(a.store['sess-1'], items);
    assert.notStrictEqual(a.store['sess-1'], items, 'must store a copy, not the live array');

    a.archiveSessionHistory(null, items);
    a.archiveSessionHistory('sess-2', []);
    a.archiveSessionHistory('sess-3', null);
    assert.deepStrictEqual(Object.keys(a.store), ['sess-1']);
  });

  test('re-archiving a session does not grow the eviction order', () => {
    const a = loadArchiveFns();
    a.archiveSessionHistory('sess-1', [{ kind: 'thought' }]);
    a.archiveSessionHistory('sess-1', [{ kind: 'thought' }, { kind: 'toolCall' }]);
    assert.deepStrictEqual(a.order, ['sess-1']);
    assert.strictEqual(a.store['sess-1'].length, 2);
  });

  test('evicts the oldest session past the cap', () => {
    const a = loadArchiveFns();
    for (let i = 0; i <= a.max; i++) {
      a.archiveSessionHistory('sess-' + i, [{ kind: 'message', role: 'assistant' }]);
    }
    assert.strictEqual(a.order.length, a.max);
    assert.strictEqual(a.store['sess-0'], undefined, 'oldest session must be evicted');
    assert.ok(a.store['sess-' + a.max], 'newest session must be kept');
  });

  test('the load path archives the outgoing session and falls back on switch-back', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    assert.ok(
      src.indexOf('archiveSessionHistory(preLoadSnapshotSessionId, preLoadChatHistorySnapshot);') > 0,
      'load start does not archive the outgoing session history',
    );
    const endIdx = src.indexOf('function handleLoadSessionEnd(ok) {');
    assert.ok(endIdx > 0, 'handleLoadSessionEnd not found');
    const head = src.slice(endIdx, endIdx + 3200);
    assert.ok(
      head.indexOf('sessionHistoryArchive[_archiveCurId]') > 0,
      'handleLoadSessionEnd does not fall back to the archived history',
    );
    assert.ok(
      head.indexOf('preLoadSnapshotSessionId = _archiveCurId;') > 0,
      'archived snapshot must be relabelled to the loaded session or the merge is skipped',
    );
  });
});

/**
 * The pre-load turn merge re-adds what the replay dropped. It used to treat
 * EVERY snapshot thought as missing, so a replay that already carried the
 * turn's thoughts got them spliced back in as one block at the end of the turn
 * — thinking cards bunched at the bottom, right before the summary.
 *
 * Runs the real filter predicate out of ChatWebviewProvider.ts.
 */
suite('pre-load turn merge dedupe', () => {
  type Item = Record<string, unknown>;

  function runFilter(
    snap: Item[],
    loaded: { toolIds?: string[]; thoughts?: string[]; assistantTexts?: string[] },
  ): Item[] {
    const src = fs.readFileSync(SOURCE, 'utf8');
    const start = src.indexOf('var missing = collectSnapTurn(false).filter(function(item) {');
    assert.ok(start > 0, 'missing-item filter not found');
    const end = src.indexOf('if (!missing.length) return false;', start);
    assert.ok(end > start, 'end of missing-item filter not found');
    const code = src.slice(start, end).replace('collectSnapTurn(false)', 'SNAP');

    const haveIds: Record<string, boolean> = {};
    for (const id of loaded.toolIds || []) {
      haveIds[id] = true;
    }
    const thoughtPrefixKey = (text: unknown) =>
      String(text || '')
        .trim()
        .slice(0, 120);
    const loadedThoughtKeys: Record<string, boolean> = {};
    for (const t of loaded.thoughts || []) {
      loadedThoughtKeys[thoughtPrefixKey(t)] = true;
    }
    const loadedAssistantTexts: Record<string, boolean> = {};
    for (const t of loaded.assistantTexts || []) {
      loadedAssistantTexts[String(t).trim()] = true;
    }
    const factory = new Function(
      'SNAP',
      'haveIds',
      'loadedThoughtKeys',
      'loadedAssistantTexts',
      'isSessionInterruptNotice',
      'thoughtPrefixKey',
      code + '\nreturn missing;',
    );
    return factory(
      snap,
      haveIds,
      loadedThoughtKeys,
      loadedAssistantTexts,
      (t: string) => /^\[Request interrupted by user\]/i.test(String(t || '').trim()),
      thoughtPrefixKey,
    ) as Item[];
  }

  test('a thought the replay already delivered is not re-added', () => {
    const missing = runFilter([{ kind: 'thought', text: 'Checking the fold order' }], {
      thoughts: ['Checking the fold order'],
    });
    assert.deepStrictEqual(missing, []);
  });

  test('a thought only the snapshot has is still re-added', () => {
    const missing = runFilter(
      [
        { kind: 'thought', text: 'Replayed one' },
        { kind: 'thought', text: 'Dropped by the replay' },
      ],
      { thoughts: ['Replayed one'] },
    );
    assert.strictEqual(missing.length, 1);
    assert.strictEqual(missing[0].text, 'Dropped by the replay');
  });

  test('thought matching tolerates a truncated/streamed copy', () => {
    const long = 'x'.repeat(200);
    const missing = runFilter([{ kind: 'thought', text: long }], { thoughts: [long.slice(0, 120) + ' more'] });
    assert.deepStrictEqual(missing, [], 'first 120 chars must be enough to match');
  });

  test('assistant and tool dedupe still hold', () => {
    const missing = runFilter(
      [
        { kind: 'message', role: 'assistant', text: 'already replayed' },
        { kind: 'message', role: 'assistant', text: 'the dropped summary' },
        { kind: 'toolCall', toolCallId: 'tc-1' },
        { kind: 'toolCall', toolCallId: 'tc-2' },
        { kind: 'message', role: 'user', text: '[Request interrupted by user]' },
      ],
      { assistantTexts: ['already replayed'], toolIds: ['tc-1'] },
    );
    assert.deepStrictEqual(
      missing.map((m) => m.text || m.toolCallId),
      ['the dropped summary', 'tc-2'],
    );
  });
});

suite('replay tail after load end', () => {
  test('loadSessionEnd is deferred past the coalescer interval and re-flushes', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    const constMatch = src.match(/const LOAD_END_TAIL_FLUSH_MS = (\d+);/);
    assert.ok(constMatch, 'LOAD_END_TAIL_FLUSH_MS not defined');
    const delay = Number(constMatch![1]);
    const intervalMatch = src.match(/flushIntervalMs: (\d+),/);
    assert.ok(intervalMatch, 'coalescer flushIntervalMs not found');
    assert.ok(
      delay > Number(intervalMatch![1]),
      `load-end delay (${delay}ms) must exceed the coalescer interval (${intervalMatch![1]}ms)`,
    );

    const idx = src.indexOf('notifyLoadSessionEnd(ok: boolean): void {');
    assert.ok(idx > 0, 'notifyLoadSessionEnd not found');
    // Brace-matched, not a fixed character window. A 2400-char slice used to sit
    // here and it broke the moment the method grew — the assertions below are
    // about ORDER inside the method, so the bound must be the method itself.
    const body = (() => {
      const open = src.indexOf('{', idx);
      let depth = 0;
      for (let i = open; i < src.length; i++) {
        if (src[i] === '{') {
          depth++;
        } else if (src[i] === '}') {
          depth--;
          if (depth === 0) {
            return src.slice(idx, i + 1);
          }
        }
      }
      return '';
    })();
    assert.ok(body.length > 0, 'could not brace-match notifyLoadSessionEnd');
    assert.ok(
      body.indexOf('setTimeout(() => {') > 0 && body.indexOf('LOAD_END_TAIL_FLUSH_MS') > 0,
      'loadSessionEnd must be posted from the deferred callback',
    );
    const flushIdx = body.lastIndexOf('this.streamCoalescer.flush(activeId);');
    const postIdx = body.indexOf("this.postMessage({ type: 'loadSessionEnd', ok });");
    assert.ok(flushIdx > 0 && postIdx > flushIdx, 'the final flush must run BEFORE loadSessionEnd is posted');
  });

  test('a straggling reply after the replay is adopted, not dropped', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    // The window must be armed once the replay is on screen…
    assert.ok(
      src.indexOf('loadTailGraceUntil = Date.now() + LOAD_TAIL_GRACE_MS;') > 0,
      'the load-tail grace window is never armed',
    );
    // …consulted by the message drop guard…
    const dropIdx = src.indexOf(
      'if (!isLoadingSession && !isProcessing && !isCompacting && !_inTailGrace && !_inLoadTailGrace) {',
    );
    assert.ok(dropIdx > 0, 'the message drop guard does not consider the load-tail window');
    // …and NOT by the thought guard, or a resumed session grows a stray
    // Thinking card at the bottom again.
    const thoughtGuard = src.slice(
      src.indexOf('shouldDropIdleThoughtChunk(isLoadingSession'),
      src.indexOf('shouldDropIdleThoughtChunk(isLoadingSession') + 200,
    );
    assert.ok(thoughtGuard.indexOf('loadTailGrace') < 0, 'thoughts must keep their idle-drop guard');
    // The adopted chunk needs an explicit commit + promote (no promptEnd comes).
    const adoptIdx = src.indexOf('function adoptLoadTailChunk(len) {');
    assert.ok(adoptIdx > 0, 'adoptLoadTailChunk missing');
    const adopt = src.slice(adoptIdx, adoptIdx + 1400);
    assert.ok(adopt.indexOf('finalizeCurrentAssistantTurn();') > 0, 'straggler is never committed to chatHistory');
    assert.ok(adopt.indexOf('promoteFinalAssistantForTurn(_turn)') > 0, 'promote is not re-run for the straggler');
    assert.ok(adopt.indexOf('saveState();') > 0, 'the adopted straggler is not persisted');
  });

  test('a dropped replay tail chunk is visible in the resume diagnostics', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    const markers = src.slice(
      src.indexOf('const RESUME_DIAG_MARKERS = ['),
      src.indexOf('function isResumeDiagWebviewMessage'),
    );
    assert.ok(markers.indexOf("'[WV-CHUNK-DROP]'") > 0, 'the chunk-drop marker must be logged under acp.debugResume');
    assert.ok(markers.indexOf("'[WV-LOAD-TAIL]'") > 0, 'the load-tail flush marker must be logged');
  });
});

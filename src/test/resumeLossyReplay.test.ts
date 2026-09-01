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
    const head = src.slice(endIdx, endIdx + 1600);
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

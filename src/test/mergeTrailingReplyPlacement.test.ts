import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Regression test for "the second resume loses the summary again".
 *
 * Measured chain (codex / vllm session e100b277):
 *  1. session/load does not replay the turn's final reply.
 *  2. The snapshot merge re-injects it — but insertSnapshotItem's generic
 *     backward walk asked findMergedToolAnchorOrdinal for the ordinal of the
 *     ITEM BEING INSERTED (snapIndex) instead of the ordinal of the ANCHOR tool.
 *     A same-titled tool from the last turn therefore mapped onto an occurrence
 *     in the middle of the history, and the reply was spliced in there:
 *     "insertSnapshotItem(assistant): snapIdx=249 generic-walk inserted at
 *     merged[81] (tail=false)".
 *  3. That corrupted history became the NEXT resume's snapshot, so the reply
 *     was then re-inserted at 81 forever and the last turn never got it back:
 *     "snapIdx=81 anchored BEFORE next=message:assistant at merged[81]".
 *
 * Runs the real merge out of ChatWebviewProvider.ts.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

function extractSnippet(startMarker: string, endMarker: string): string {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const startIdx = src.indexOf(startMarker);
  assert.ok(startIdx >= 0, `start marker not found: ${startMarker}`);
  const endIdx = src.indexOf(endMarker, startIdx + startMarker.length);
  assert.ok(endIdx > startIdx, `end marker not found after start: ${endMarker}`);
  return src.slice(startIdx, endIdx).trim();
}

type MergeFn = (loaded: any[], snapshot: any[]) => any[];

function loadMerge(): MergeFn {
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
  const factory = new Function(`
    ${isInterrupt}
    ${thoughtKey}
    ${findAnchor}
    ${merge}
    return mergeLoadedWithSnapshotOverlay;
  `);
  return factory() as MergeFn;
}

const user = (text: string) => ({ kind: 'message', role: 'user', text });
const asst = (text: string) => ({ kind: 'message', role: 'assistant', text });
const tool = (toolCallId: string, title: string) => ({ kind: 'toolCall', toolCallId, title, status: 'completed' });

const shape = (rows: any[]): string[] =>
  rows.map((r) => (r.kind === 'toolCall' ? 'tool:' + r.title : r.kind === 'message' ? r.role + ':' + r.text : r.kind));

suite('merge trailing reply placement (second-resume regression)', () => {
  test('a trailing reply the replay dropped is appended, not spliced into an earlier turn', () => {
    const merge = loadMerge();

    // codex numbers replay tool ids per load (tc-1, tc-2, …), so the
    // snapshot's last-turn tool id collides with a DIFFERENT tool in the new
    // replay. findMergedHistoryAnchor then anchored the last turn's tool onto
    // that earlier occurrence and the generic walk dropped the reply there.
    const snapshot = [
      user('q1'),
      tool('tc-1', 'ls'),
      tool('tc-2', 'cat a'),
      asst('a1'),
      user('q2'),
      tool('tc-3', 'grep x'),
      tool('tc-2', 'grep y'),
      asst('THE SUMMARY'),
    ];
    const loaded = [
      user('q1'),
      tool('tc-1', 'ls'),
      tool('tc-2', 'cat a'),
      asst('a1'),
      user('q2'),
      tool('tc-3', 'grep x'),
      tool('tc-4', 'grep y'),
    ];

    const merged = merge(loaded, snapshot);

    assert.deepStrictEqual(shape(merged), [
      'user:q1',
      'tool:ls',
      'tool:cat a',
      'assistant:a1',
      'user:q2',
      'tool:grep x',
      'tool:grep y',
      'assistant:THE SUMMARY',
    ]);
    assert.strictEqual(
      shape(merged)[merged.length - 1],
      'assistant:THE SUMMARY',
      'the final reply must end the timeline, not land in an earlier turn',
    );
  });

  test('re-merging the repaired history is stable (no drift on the next resume)', () => {
    const merge = loadMerge();
    const repaired = [
      user('q1'),
      tool('tc-1', 'ls'),
      tool('tc-2', 'cat a'),
      asst('a1'),
      user('q2'),
      tool('tc-3', 'grep x'),
      tool('tc-2', 'grep y'),
      asst('THE SUMMARY'),
    ];
    const loaded = [
      user('q1'),
      tool('tc-1', 'ls'),
      tool('tc-2', 'cat a'),
      asst('a1'),
      user('q2'),
      tool('tc-3', 'grep x'),
      tool('tc-4', 'grep y'),
    ];
    const merged = merge(loaded, repaired);
    assert.deepStrictEqual(shape(merged), shape(repaired), 'a second resume must reproduce the same order');
  });

  test('a snapshot that already holds the reply in the WRONG place self-heals', () => {
    const merge = loadMerge();
    // What two bad resumes left on disk: the reply spliced into turn 1.
    const corrupted = [
      user('q1'),
      tool('tc-1', 'ls'),
      asst('THE SUMMARY'),
      asst('a1'),
      user('q2'),
      tool('tc-3', 'grep x'),
      tool('tc-2', 'grep y'),
    ];
    // The replay tail is now committed BEFORE the merge, so the loaded timeline
    // ends with the reply in true wire order.
    const loaded = [
      user('q1'),
      tool('tc-1', 'ls'),
      asst('a1'),
      user('q2'),
      tool('tc-3', 'grep x'),
      tool('tc-4', 'grep y'),
      asst('THE SUMMARY'),
    ];

    const merged = merge(loaded, corrupted);
    const summaries = shape(merged).filter((r) => r === 'assistant:THE SUMMARY');
    assert.strictEqual(summaries.length, 1, 'the stale copy must be deduped, not added again');
    assert.strictEqual(
      shape(merged)[merged.length - 1],
      'assistant:THE SUMMARY',
      'the surviving copy must be the one at the end',
    );
  });

  test('the replay tail is committed BEFORE the snapshot merge', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    const endIdx = src.indexOf('function handleLoadSessionEnd(ok) {');
    assert.ok(endIdx > 0, 'handleLoadSessionEnd not found');
    const body = src.slice(endIdx, endIdx + 30000);
    const commitIdx = body.indexOf("'[WV-LOAD-TAIL] committing replay tail reply before merge");
    const mergeIdx = body.indexOf('chatHistory = mergeLoadedWithSnapshotOverlay(');
    assert.ok(commitIdx > 0, 'the replay tail is never committed in handleLoadSessionEnd');
    assert.ok(mergeIdx > 0, 'the snapshot merge call moved');
    assert.ok(commitIdx < mergeIdx, 'the commit must happen BEFORE the merge or the stale copy wins');
    assert.ok(
      body.indexOf('but that text is ALREADY in the snapshot') < 0,
      'the merge must no longer discard the authoritative replay tail',
    );
  });

  test('the ordinal helper is asked for the ANCHOR tool position, never the inserted item', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    assert.ok(
      src.indexOf('findMergedToolAnchorOrdinal(merged, prev, snapshot, before)') > 0,
      'backward walk must pass the anchor tool index',
    );
    assert.ok(
      src.indexOf('findMergedToolAnchorOrdinal(merged, nextItem, snapshot, after2)') > 0,
      'forward walk must pass the anchor tool index',
    );
    assert.strictEqual(
      src.split('findMergedToolAnchorOrdinal(merged, prev, snapshot, snapIndex)').length - 1,
      0,
      'the inserted item index must not be used as a tool ordinal',
    );
  });
});

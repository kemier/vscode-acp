import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Regression test for the "tool calls and assistant messages grouped per
 * section instead of interleaved" bug after reload + session resume.
 *
 * The agent's session/load replay is the transcript chronology, so it is
 * authoritative for the order of every row it contains. The merge used to score
 * EVERY row in a turn by its position in the webview snapshot
 * (`snapshotOrderIndex`) and sort, which made the snapshot authoritative
 * instead. Two ways that broke a correct replay:
 *
 *   1. a row whose snapshot slot was missing scored MAX_SAFE_INTEGER and sank
 *      behind every matched row — all tools first, then every reply;
 *   2. when the slots did match, the snapshot's order was re-imposed verbatim
 *      over the replay's.
 *
 * Because the merged result is persisted by saveState, a wrong order became the
 * next snapshot and was re-imposed on every later resume.
 *
 * Measured on a real ericli session: the agent replayed a turn as
 * `U T A T A T A T A T A T A A` while the panel rendered one 6-tool block
 * followed by all 7 replies.
 *
 * Like the sibling merge tests, this extracts the REAL function out of
 * ChatWebviewProvider.ts (it lives inside the webview template literal and
 * cannot be imported).
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

function user(text: string): any {
  return { kind: 'message', role: 'user', text };
}
function asst(text: string): any {
  return { kind: 'message', role: 'assistant', text };
}
function thought(text: string): any {
  return { kind: 'thought', text };
}
function tool(toolCallId: string, title: string): any {
  return { kind: 'toolCall', toolCallId, title, status: 'completed' };
}

function shape(rows: any[]): string[] {
  return rows.map((r) => {
    if (r.kind === 'toolCall') {
      return 'tool:' + r.title;
    }
    if (r.kind === 'thought') {
      return 'thought:' + r.text;
    }
    if (r.kind === 'message') {
      return r.role + ':' + r.text;
    }
    return r.kind;
  });
}

suite('merge: replay order is authoritative (resume grouping regression)', () => {
  test('a grouped snapshot cannot regroup an interleaved replay', () => {
    const merge = loadMerge();

    // The agent replays the true chronology: text, then the tool that text
    // introduced, repeatedly.
    const loaded = [
      user('check the log'),
      asst("I'll find the latest log."),
      tool('tc-1', 'find log'),
      asst('The latest is exthost6.'),
      tool('tc-2', 'read log'),
      asst('Found the diagnostics.'),
      tool('tc-3', 'grep ui'),
      asst('Here is the answer.'),
    ];

    // A stale snapshot from an earlier bad resume, where the same turn was
    // persisted GROUPED. It must not be able to re-impose that shape.
    const snapshot = [
      user('check the log'),
      tool('tc-1', 'find log'),
      tool('tc-2', 'read log'),
      tool('tc-3', 'grep ui'),
      asst("I'll find the latest log."),
      asst('The latest is exthost6.'),
      asst('Found the diagnostics.'),
      asst('Here is the answer.'),
    ];

    assert.deepStrictEqual(
      shape(merge(loaded, snapshot)),
      shape(loaded),
      'the replay order must survive the merge: a grouped snapshot must not ' +
        'hoist every tool ahead of the replies that introduced them',
    );
  });

  test('replay rows missing from the snapshot keep their replay position', () => {
    const merge = loadMerge();

    // Snapshot text drifted (live streaming assembled it differently), so these
    // assistants have no exact snapshot counterpart. They must stay put rather
    // than sink to the end of the turn.
    const loaded = [
      user('go'),
      asst('step one'),
      tool('tc-1', 'read A'),
      asst('step two'),
      tool('tc-2', 'read B'),
      asst('done'),
    ];
    const snapshot = [
      user('go'),
      tool('tc-1', 'read A'),
      tool('tc-2', 'read B'),
      asst('done'),
    ];

    assert.deepStrictEqual(
      shape(merge(loaded, snapshot)),
      shape(loaded),
      'unmatched replay rows must not sink behind the matched tools',
    );
  });

  test('snapshot-only thoughts still interleave into the replay', () => {
    const merge = loadMerge();

    // The agent does not replay thought chunks, so they exist only in the
    // snapshot and must be re-inserted at their true positions.
    const loaded = [
      user('go'),
      asst('planning'),
      tool('tc-1', 'read A'),
      asst('now B'),
      tool('tc-2', 'read B'),
      asst('done'),
    ];
    const snapshot = [
      user('go'),
      thought('thinking about A'),
      asst('planning'),
      tool('tc-1', 'read A'),
      thought('thinking about B'),
      asst('now B'),
      tool('tc-2', 'read B'),
      asst('done'),
    ];

    const merged = shape(merge(loaded, snapshot));
    assert.ok(
      merged.indexOf('thought:thinking about A') >= 0 &&
        merged.indexOf('thought:thinking about B') >= 0,
      'snapshot-only thoughts must survive the merge: ' + JSON.stringify(merged),
    );
    // Every replay row keeps its relative order.
    const replayRows = shape(loaded);
    const positions = replayRows.map((r) => merged.indexOf(r));
    assert.ok(
      positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1])),
      'replay rows must keep their relative order after thought insertion: ' +
        JSON.stringify(merged),
    );
    // The second thought must not be hoisted above the first tool.
    assert.ok(
      merged.indexOf('thought:thinking about B') > merged.indexOf('tool:read A'),
      'thoughts must stay in their own turn segment: ' + JSON.stringify(merged),
    );
  });
});

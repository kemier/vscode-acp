import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Regression test for the "tool calls grouped at the top" bug seen after
 * reload + session resume.
 *
 * A turn that repeats the same tool title (several Edit of one file) rendered
 * with every Edit hoisted into a single block and all the thinking pushed
 * underneath, even though live streaming had shown them interleaved.
 *
 * Root cause: `reconcileInterleavedOrderFromSnapshot` sorts each turn by
 * `snapshotOrderIndex`, and for tool calls that helper matched on title and
 * returned the FIRST matching snapshot slot. Every same-title Edit therefore
 * shared one sort key and collapsed together, while the thoughts between them
 * kept their own (higher) keys and sorted after the whole block.
 *
 * The fix makes the lookup claim snapshot slots, so the Nth same-title tool
 * resolves to the Nth matching slot and the real interleaving survives.
 *
 * Like the sibling merge test, this extracts the REAL functions out of
 * ChatWebviewProvider.ts (they live inside the webview template literal and
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

/** Compact shape of the merged timeline, for readable assertions. */
function shape(rows: any[]): string[] {
  return rows.map((r) => {
    if (r.kind === 'toolCall') return 'tool:' + r.title;
    if (r.kind === 'thought') return 'thought:' + r.text;
    if (r.kind === 'message') return r.role + ':' + r.text;
    return r.kind;
  });
}

suite('merge duplicate-tool interleaving (resume regression)', () => {
  test('repeated same-title tools stay interleaved with the thoughts between them', () => {
    const merge = loadMerge();

    const EDIT = "Edit 'SharedMemoryProvider.ts'";

    // Live/webview snapshot: the order the user actually watched stream in.
    const snapshot = [
      user('add persistence'),
      tool('call_1', EDIT),
      thought('first thinking step'),
      tool('call_2', EDIT),
      thought('second thinking step'),
      tool('call_3', EDIT),
      asst('Done, persistence added.'),
    ];

    // session/load replay: same tools in the same order, but the agent does not
    // replay thought chunks, and the tool ids are synthetic so only the title
    // can be matched. This is what makes the three Edits indistinguishable.
    const loaded = [
      user('add persistence'),
      tool('replay-0-0', EDIT),
      tool('replay-0-1', EDIT),
      tool('replay-0-2', EDIT),
      asst('Done, persistence added.'),
    ];

    const merged = merge(loaded, snapshot);

    assert.deepStrictEqual(
      shape(merged),
      [
        'user:add persistence',
        'tool:' + EDIT,
        'thought:first thinking step',
        'tool:' + EDIT,
        'thought:second thinking step',
        'tool:' + EDIT,
        'assistant:Done, persistence added.',
      ],
      'the three identical Edits must stay interleaved with the thoughts that ' +
        'ran between them, not collapse into one leading block',
    );
  });

  test('no thought is dropped and no tool is duplicated by the merge', () => {
    const merge = loadMerge();
    const EDIT = "Edit 'ChatWebviewProvider.ts'";

    const snapshot = [
      user('fix it'),
      thought('t0 before any tool'),
      tool('call_a', EDIT),
      thought('t1'),
      tool('call_b', EDIT),
      thought('t2'),
      tool('call_c', EDIT),
      thought('t3'),
      asst('fixed'),
    ];
    const loaded = [
      user('fix it'),
      tool('replay-1-0', EDIT),
      tool('replay-1-1', EDIT),
      tool('replay-1-2', EDIT),
      asst('fixed'),
    ];

    const merged = merge(loaded, snapshot);

    const thoughts = merged.filter((r) => r.kind === 'thought').map((r) => r.text);
    assert.deepStrictEqual(
      thoughts,
      ['t0 before any tool', 't1', 't2', 't3'],
      'all four thoughts survive the merge, in snapshot order',
    );

    const tools = merged.filter((r) => r.kind === 'toolCall');
    assert.strictEqual(tools.length, 3, 'exactly the three replayed tools, no duplicates');

    // The leading thought must precede the first tool, and each later thought
    // must sit between two tools rather than after all of them.
    const kinds = merged.map((r) => r.kind);
    const firstTool = kinds.indexOf('toolCall');
    const lastTool = kinds.lastIndexOf('toolCall');
    const t0 = merged.findIndex((r) => r.kind === 'thought' && r.text === 't0 before any tool');
    const t1 = merged.findIndex((r) => r.kind === 'thought' && r.text === 't1');
    const t2 = merged.findIndex((r) => r.kind === 'thought' && r.text === 't2');
    assert.ok(t0 < firstTool, 't0 stays before the first tool');
    assert.ok(t1 > firstTool && t1 < lastTool, 't1 stays between tools, not after the block');
    assert.ok(t2 > t1 && t2 < lastTool, 't2 stays between tools, not after the block');
  });

  test('distinct tool titles are unaffected (no regression)', () => {
    const merge = loadMerge();
    const snapshot = [
      user('go'),
      thought('think a'),
      tool('call_1', 'Read file.ts'),
      thought('think b'),
      tool('call_2', 'Search logs'),
      asst('done'),
    ];
    const loaded = [
      user('go'),
      tool('replay-2-0', 'Read file.ts'),
      tool('replay-2-1', 'Search logs'),
      asst('done'),
    ];

    const merged = merge(loaded, snapshot);
    assert.deepStrictEqual(shape(merged), [
      'user:go',
      'thought:think a',
      'tool:Read file.ts',
      'thought:think b',
      'tool:Search logs',
      'assistant:done',
    ]);
  });
});

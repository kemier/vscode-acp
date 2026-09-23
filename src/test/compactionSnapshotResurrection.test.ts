import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Regression: "pre-compaction user messages reappear as stray orphans after
 * resume" (claude-code-acp).
 *
 * Measured chain (session 67d66e19, transcript 01d25a08):
 *  1. claude-code-acp's session/load replay truncates at the CLI's compaction
 *     banner (isCompactSummary) and emits ONLY the post-compact turns:
 *     loaded = message:user=7, assistant=111, toolCall=124.
 *  2. The webview snapshot (saved before the load) still holds the FULL
 *     pre-compaction history: message:user=19, assistant=215, toolCall=266.
 *  3. The compaction-boundary slice in handleLoadSessionEnd is keyed on a
 *     "compacted" system row that claude-code-acp's replay does NOT emit, so it
 *     never fires and the full snapshot is merged.
 *  4. mergeLoadedWithSnapshotOverlay + mergeMissingUsersFromSnapshot then
 *     resurrect the 14 pre-compaction user prompts (and their assistant/tool
 *     rows) — appended with no matching reply: "[WV-MERGE] loaded-first
 *     overlay: 292 items … injectedSnapUsers=14".
 *
 * The fix keys "was this turn compacted away" to whether the turn's user
 * boundary survived in the loaded replay. Runs the real merge out of
 * ChatWebviewProvider.ts.
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

function loadFns() {
  const isInterrupt = extractSnippet(
    'function isSessionInterruptNotice(text) {',
    'function applyInterruptNoticesFromHistory',
  );
  const thoughtKey = extractSnippet(
    'function thoughtPrefixKey(text) {',
    'function mergeLoadedWithSnapshotOverlay',
  );
  const isMachineContextOnly = extractSnippet(
    'function isMachineContextOnly(rawText) {',
    'function truncateForBanner',
  );
  const countRealUsers = extractSnippet('function countRealUsers(arr) {', 'function realUserEntries');
  const realUserEntries = extractSnippet('function realUserEntries(arr) {', 'function thoughtPrefixKey');
  const userMessageKey = extractSnippet(
    'function userMessageKey(text) {',
    'function mergeMissingUsersFromLoaded',
  );
  const findAnchor = extractSnippet(
    'function findMergedHistoryAnchor(merged, item) {',
    'function countRealUsers',
  );
  const merge = extractSnippet(
    'function mergeLoadedWithSnapshotOverlay(loaded, snapshot) {',
    'function userMessageKey',
  );
  const mergeMissingUsers = extractSnippet(
    'function mergeMissingUsersFromSnapshot(merged, snapshot) {',
    'function mergePreLoadInterruptedTurn',
  );
  const factory = new Function(`
    // Stub for stripLeadingResourceLinkJson — isMachineContextOnly uses it only
    // to detect all-resource_link JSON rows, which these fixtures never contain.
    function stripLeadingResourceLinkJson(t) { return String(t == null ? '' : t); }
    ${isMachineContextOnly}
    // Stub for cleanUserMessage — it drags in the whole context-stripper
    // closure; for these fixtures a plain trim is a faithful equivalent (the
    // guard under test compares trimmed text).
    function cleanUserMessage(t) { return String(t == null ? '' : t).trim(); }
    ${userMessageKey}
    ${isInterrupt}
    ${thoughtKey}
    ${countRealUsers}
    ${realUserEntries}
    ${findAnchor}
    ${merge}
    ${mergeMissingUsers}
    return { mergeLoadedWithSnapshotOverlay, mergeMissingUsersFromSnapshot };
  `);
  return factory() as {
    mergeLoadedWithSnapshotOverlay: (loaded: any[], snapshot: any[]) => any[];
    mergeMissingUsersFromSnapshot: (merged: any[], snapshot: any[]) => number;
  };
}

const user = (text: string) => ({ kind: 'message', role: 'user', text });
const asst = (text: string) => ({ kind: 'message', role: 'assistant', text });
const tool = (toolCallId: string, title: string) => ({
  kind: 'toolCall',
  toolCallId,
  title,
  status: 'completed',
});

const users = (rows: any[]): string[] =>
  rows.filter((r) => r.kind === 'message' && r.role === 'user').map((r) => r.text);
const assistants = (rows: any[]): string[] =>
  rows.filter((r) => r.kind === 'message' && r.role === 'assistant').map((r) => r.text);
const tools = (rows: any[]): string[] =>
  rows.filter((r) => r.kind === 'toolCall').map((r) => r.title);

// Snapshot: 3 turns. Turn 1 is PRE-compaction (its user prompt + tool + reply
// are absent from the loaded replay). Turns 2 and 3 survive compaction.
function fixture() {
  const snapshot = [
    user('pre-compact question'),
    tool('s-1', 'cat pre'),
    asst('pre-compact reply'),
    user('post-compact A'),
    tool('s-2', 'grep x'),
    asst('reply A'),
    user('post-compact B'),
    tool('s-3', 'ls'),
    asst('reply B'),
  ];
  // What claude-code-acp's truncated session/load replay produced.
  const loaded = [
    user('post-compact A'),
    tool('r-2', 'grep x'),
    asst('reply A'),
    user('post-compact B'),
    tool('r-3', 'ls'),
    asst('reply B'),
  ];
  return { snapshot, loaded };
}

suite('compaction: pre-compaction snapshot rows are not resurrected on resume', () => {
  test('mergeMissingUsersFromSnapshot skips the compacted-away user prompt', () => {
    const { mergeLoadedWithSnapshotOverlay, mergeMissingUsersFromSnapshot } = loadFns();
    const { snapshot, loaded } = fixture();

    const merged = mergeLoadedWithSnapshotOverlay(loaded, snapshot);
    const injected = mergeMissingUsersFromSnapshot(merged, snapshot);

    // The one user prompt that was compacted away must NOT be re-injected.
    assert.deepStrictEqual(users(merged), ['post-compact A', 'post-compact B']);
    assert.strictEqual(
      injected,
      0,
      'no snapshot user row is missing from a correctly-truncated replay',
    );
  });

  test('the overlay does not resurrect compacted-away assistant or tool rows', () => {
    const { mergeLoadedWithSnapshotOverlay } = loadFns();
    const { snapshot, loaded } = fixture();

    const merged = mergeLoadedWithSnapshotOverlay(loaded, snapshot);

    assert.deepStrictEqual(assistants(merged), ['reply A', 'reply B']);
    assert.deepStrictEqual(tools(merged), ['grep x', 'ls']);
    // The compacted turn left no trace at all — no orphan user, assistant,
    // or tool row from it.
    assert.ok(!users(merged).includes('pre-compact question'));
    assert.ok(!assistants(merged).includes('pre-compact reply'));
    assert.ok(!tools(merged).includes('cat pre'));
  });

  test('a replay that dropped a LIVE (post-compact) turn still recovers it', () => {
    // Guards against the fix being over-broad: the guard must only suppress
    // rows whose user turn is genuinely ABSENT from the loaded replay. When
    // the user prompt survives but the agent dropped its reply (lossy replay),
    // the snapshot must still supply the assistant.
    const { mergeLoadedWithSnapshotOverlay, mergeMissingUsersFromSnapshot } = loadFns();

    const snapshot = [
      user('q1'),
      tool('s-1', 'ls'),
      asst('THE SUMMARY'),
    ];
    const loaded = [user('q1'), tool('r-1', 'ls')]; // reply dropped

    const merged = mergeLoadedWithSnapshotOverlay(loaded, snapshot);
    mergeMissingUsersFromSnapshot(merged, snapshot);

    assert.deepStrictEqual(users(merged), ['q1']);
    assert.ok(
      assistants(merged).includes('THE SUMMARY'),
      'the dropped reply for a live turn must still be recovered',
    );
  });
});

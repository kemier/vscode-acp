import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * A snapshot row the replay lacks must land next to its snapshot neighbour, not
 * at the end of the turn.
 *
 * Observed on a resumed ericli session (06803f97). The turn ran:
 *
 *   tool(ls …/claude-code-acp/)
 *   assistant "claude-code-acp 仓库是独立的 ACP bridge … 让我看看这个入口文件"   <- 99 chars
 *   tool(Grep 'src' for 'kiro|Kiro')
 *   assistant "claude-code-acp 源码里只有一处提到 kiro …"
 *   tool(Read …/src/agent.ts)
 *   assistant "找到了。… ## 答案 …"                                        <- final answer
 *
 * session/load replayed everything except that first assistant segment, so the
 * merge restored it — correctly, it is real content the agent never sent back —
 * but spliced it at `insertAt`, which is chatHistory.length when no later user
 * message exists. It rendered as a stray preamble BELOW the final answer.
 *
 * The diagnostics showed the restore was not a duplicate: assistant snap=17,
 * loaded=17, and the final render had 17 unique assistant texts. Only the
 * position was wrong.
 *
 * The replay stays authoritative for the order of every row it CONTAINS —
 * mergeReplayOrderAuthority records what happened when snapshot order was
 * re-imposed over it ("all tools first, then every reply"). This test pins the
 * complementary rule: rows the replay does NOT contain are anchored to the
 * snapshot row before them.
 *
 * Executes the REAL merge body extracted from the webview template literal.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

type Item = {
  kind: string;
  role?: string;
  text?: string;
  toolCallId?: string;
  title?: string;
  status?: string;
};

/**
 * Extract the anchored-insert block and run it over a loaded/snapshot pair.
 *
 * Only the placement logic is extracted: the surrounding function needs the
 * whole webview (renderQueue, markSessionInterrupted, postMessage, …). The
 * `missing` set and the loaded index maps are the inputs it actually consumes.
 */
function runPlacement(loaded: Item[], snapTurn: Item[], loadedLastUserIdx: number): Item[] {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const start = src.indexOf('      function loadedIndexOfSnapItem(it) {');
  assert.ok(start > 0, 'loadedIndexOfSnapItem not found — did the merge change?');
  const endMarker = '        Array.prototype.splice.apply(chatHistory, [insertAt, 0].concat(missing));\n      }';
  const end = src.indexOf(endMarker, start);
  assert.ok(end > start, 'end of the placement block not found');
  const block = src.slice(start, end + endMarker.length);

  // Build the loaded index maps the same way the merge does.
  const loadedToolIdx: Record<string, number> = {};
  const loadedAssistantIdx: Record<string, number> = {};
  const loadedThoughtIdx: Record<string, number> = {};
  for (let k = loadedLastUserIdx + 1; k < loaded.length; k++) {
    const cur = loaded[k];
    if (!cur) {continue;}
    if (cur.kind === 'message' && cur.role === 'user') {break;}
    if (cur.kind === 'toolCall' && cur.toolCallId && !(cur.toolCallId in loadedToolIdx)) {
      loadedToolIdx[cur.toolCallId] = k;
    }
    if (cur.kind === 'message' && cur.role === 'assistant' && cur.text) {
      const key = String(cur.text).trim();
      if (!(key in loadedAssistantIdx)) {loadedAssistantIdx[key] = k;}
    }
  }
  // Rows present in the snapshot turn but absent from the loaded list.
  const missing = snapTurn.filter((s) => {
    if (s.kind === 'toolCall') {return !(s.toolCallId && s.toolCallId in loadedToolIdx);}
    if (s.kind === 'message' && s.role === 'assistant') {
      return !(String(s.text || '').trim() in loadedAssistantIdx);
    }
    return false;
  });

  const chatHistory = loaded.slice();
  const fn = new Function(
    'chatHistory', 'missing', 'insertAt', 'collectSnapTurn',
    'loadedToolIdx', 'loadedAssistantIdx', 'loadedThoughtIdx', 'thoughtPrefixKey',
    `${block}\nreturn { canAnchor: _canAnchor, groups: _groups.length };`,
  );
  const out = fn(
    chatHistory, missing, chatHistory.length, () => snapTurn,
    loadedToolIdx, loadedAssistantIdx, loadedThoughtIdx,
    (t: string) => String(t).slice(0, 120),
  ) as { canAnchor: boolean; groups: number };
  assert.ok(out.canAnchor || missing.length === 0, 'expected the anchored path to engage');
  return chatHistory;
}

const asst = (text: string): Item => ({ kind: 'message', role: 'assistant', text });
const tool = (id: string, title: string): Item => ({ kind: 'toolCall', toolCallId: id, title, status: 'completed' });
const usr = (text: string): Item => ({ kind: 'message', role: 'user', text });

suite('merge places a missing snapshot row next to its neighbour', () => {
  const PREAMBLE = 'claude-code-acp 仓库是独立的 ACP bridge，让我看看这个入口文件，确认它没有引用 kiro-cli。';
  const MID = 'claude-code-acp 源码里只有一处提到 kiro——是注释。';
  const FINAL = '找到了。这就是你问的答案。\n\n## 答案\n\nclaude-code-acp 并没有指向 kiro-cli。';

  // The snapshot holds the full turn as the webview rendered it live.
  const snapTurn: Item[] = [
    tool('tc-1150', 'ls -la .../claude-code-acp/'),
    asst(PREAMBLE),
    tool('tc-1163', "Grep 'src' for 'kiro|Kiro'"),
    asst(MID),
    tool('tc-1170', 'Read .../src/agent.ts'),
    asst(FINAL),
  ];

  // The replay delivered everything EXCEPT the preamble segment.
  const loaded: Item[] = [
    usr('why claude-code-acp point to kiro-cli'),
    tool('tc-1150', 'ls -la .../claude-code-acp/'),
    tool('tc-1163', "Grep 'src' for 'kiro|Kiro'"),
    asst(MID),
    tool('tc-1170', 'Read .../src/agent.ts'),
    asst(FINAL),
  ];

  test('the restored preamble lands after its tool call, not after the final answer', () => {
    const merged = runPlacement(loaded, snapTurn, 0);
    const texts = merged.map((i) => (i.kind === 'toolCall' ? `tool:${i.toolCallId}` : String(i.text).slice(0, 20)));

    const preambleIdx = merged.findIndex((i) => i.text === PREAMBLE);
    const finalIdx = merged.findIndex((i) => i.text === FINAL);
    const lsIdx = merged.findIndex((i) => i.toolCallId === 'tc-1150');
    const grepIdx = merged.findIndex((i) => i.toolCallId === 'tc-1163');

    assert.ok(preambleIdx > 0, `preamble missing from merge: ${texts.join(' | ')}`);
    // The defect: it used to be appended last, below the final answer.
    assert.ok(
      preambleIdx < finalIdx,
      `preamble must precede the final answer, got preamble@${preambleIdx} final@${finalIdx}: ${texts.join(' | ')}`,
    );
    // And it belongs specifically between its two tool calls.
    assert.ok(
      preambleIdx > lsIdx && preambleIdx < grepIdx,
      `preamble must sit between tc-1150 and tc-1163, got ${preambleIdx} (ls@${lsIdx} grep@${grepIdx})`,
    );
  });

  test('the replay order of the rows it delivered is untouched', () => {
    const merged = runPlacement(loaded, snapTurn, 0);
    // mergeReplayOrderAuthority: the replay is authoritative for what it carries.
    const delivered = merged
      .filter((i) => i.text !== PREAMBLE)
      .map((i) => (i.kind === 'toolCall' ? `tool:${i.toolCallId}` : `msg:${String(i.text).slice(0, 12)}`));
    const expected = loaded.map((i) =>
      i.kind === 'toolCall' ? `tool:${i.toolCallId}` : `msg:${String(i.text).slice(0, 12)}`,
    );
    assert.deepStrictEqual(delivered, expected);
  });

  test('nothing is lost and nothing is duplicated', () => {
    const merged = runPlacement(loaded, snapTurn, 0);
    assert.strictEqual(merged.length, loaded.length + 1, 'exactly one row should be added');
    const assistantTexts = merged.filter((i) => i.role === 'assistant').map((i) => i.text);
    assert.strictEqual(new Set(assistantTexts).size, assistantTexts.length, 'duplicate assistant text');
    for (const t of [PREAMBLE, MID, FINAL]) {
      assert.ok(assistantTexts.includes(t), `lost assistant text: ${t.slice(0, 24)}`);
    }
  });

  test('several missing rows keep their snapshot order between anchors', () => {
    const A = 'first missing segment';
    const B = 'second missing segment';
    const snap: Item[] = [tool('t1', 'one'), asst(A), asst(B), tool('t2', 'two'), asst('kept')];
    const load: Item[] = [usr('q'), tool('t1', 'one'), tool('t2', 'two'), asst('kept')];
    const merged = runPlacement(load, snap, 0);
    const ia = merged.findIndex((i) => i.text === A);
    const ib = merged.findIndex((i) => i.text === B);
    const it2 = merged.findIndex((i) => i.toolCallId === 't2');
    assert.ok(ia < ib, 'snapshot order between the two missing rows must hold');
    assert.ok(ib < it2, 'both must land before the next matched row');
  });

  test('a trailing missing row still goes last', () => {
    // When the snapshot row genuinely IS the last thing, the end is correct.
    const TAIL = 'trailing interim segment';
    const snap: Item[] = [tool('t1', 'one'), asst('kept'), asst(TAIL)];
    const load: Item[] = [usr('q'), tool('t1', 'one'), asst('kept')];
    const merged = runPlacement(load, snap, 0);
    assert.strictEqual(merged[merged.length - 1].text, TAIL);
  });
});

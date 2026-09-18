import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseKiroCompactionBoundary,
  isKiroResumeAnchor,
  readKiroCompactionBoundary,
} from '../core/KiroTranscriptReader';

/**
 * kiro-cli replays everything, including what it already compacted away.
 *
 * Measured on session 2d37974b (9.3 MB, 2849 records, `Compaction` at record 1550):
 * `session/load` took 13.09 s — 2.35 s for kiro to open and parse the file, then
 * 10.74 s streaming 1538 frames — and emitted 1366 `tool_call`s, which is exactly
 * the total number of toolUse blocks in the WHOLE file. The first replayed
 * `user_message_chunk` was byte-identical to record 0. So 35 of 86 prompts and
 * ~740 of 1338 tool results were conversation kiro itself had already dropped from
 * the model's context: slow to render, and misleading to read.
 *
 * kiro sends no marker for the boundary and never replays the `Compaction.summary`
 * either, so both have to be recovered from the transcript on disk.
 */

const CLEAR = JSON.stringify({ version: 1, kind: 'Clear', data: {} });

function prompt(text: string, extra?: string): string {
  const content: Array<{ kind: string; data: string }> = [];
  if (extra) {
    content.push({ kind: 'text', data: extra });
  }
  content.push({ kind: 'text', data: text });
  return JSON.stringify({ version: 1, kind: 'Prompt', data: { content } });
}

function assistant(text: string): string {
  return JSON.stringify({
    version: 1,
    kind: 'AssistantMessage',
    data: { content: [{ kind: 'text', data: text }] },
  });
}

function compaction(summary: string): string {
  return JSON.stringify({ version: 1, kind: 'Compaction', data: { summary, strategy: '{}' } });
}

const SURVIVOR = 'now check why the resumed session is slow after compaction';
const MEMORY_BLOB = '<agent-memory>\n- [work_fact] something recalled from earlier\n</agent-memory>';


/** Brace-matched body of a host-side method, so ordering is compared within it. */
function methodBody(src: string, signature: string): string | null {
  const at = src.indexOf(signature);
  if (at < 0) {
    return null;
  }
  const open = src.indexOf('{', src.indexOf(')', at));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') {
      depth++;
    } else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        return src.slice(at, i + 1);
      }
    }
  }
  return null;
}

suite('kiro compaction boundary (recovered from the transcript)', () => {
  test('finds the boundary, its summary, and what it drops', () => {
    const jsonl = [
      prompt('first thing'),
      assistant('working on it'),
      prompt('second thing'),
      compaction('## OBJECTIVE\nverify the modules'),
      prompt(SURVIVOR, MEMORY_BLOB),
      assistant('on it'),
    ].join('\n');
    const b = parseKiroCompactionBoundary(jsonl);
    assert.ok(b, 'boundary not found');
    assert.strictEqual(b!.kind, 'Compaction');
    assert.strictEqual(b!.recordIndex, 3);
    assert.strictEqual(b!.droppedPrompts, 2, 'two prompts predate the compaction');
    assert.strictEqual(b!.droppedRecords, 3);
    assert.strictEqual(b!.summary, '## OBJECTIVE\nverify the modules', 'the summary kiro never replays');
  });

  test('the anchor is the first prompt AFTER the boundary, longest block first', () => {
    const b = parseKiroCompactionBoundary([prompt('old'), compaction('s'), prompt(SURVIVOR, MEMORY_BLOB)].join('\n'));
    assert.deepStrictEqual(
      b!.resumeAfterTexts,
      [MEMORY_BLOB, SURVIVOR].sort((x, y) => y.length - x.length),
    );
    assert.strictEqual(b!.resumeAfterTexts[0], MEMORY_BLOB, 'longest block is the most distinctive anchor');
  });

  test('the LAST boundary wins — a /clear after a compaction supersedes it', () => {
    const b = parseKiroCompactionBoundary(
      [prompt('a'), compaction('summary'), prompt('b'), CLEAR, prompt(SURVIVOR)].join('\n'),
    );
    assert.strictEqual(b!.kind, 'Clear');
    assert.strictEqual(b!.summary, '', 'a Clear folds nothing into a summary');
    assert.strictEqual(b!.droppedPrompts, 2);
  });

  test('no boundary, or nothing after it, means leave the replay alone', () => {
    assert.strictEqual(parseKiroCompactionBoundary([prompt('a'), assistant('b')].join('\n')), null);
    // Compaction as the tail of the file: there is no anchor to resume at, and
    // guessing would risk dropping the whole conversation.
    assert.strictEqual(parseKiroCompactionBoundary([prompt('a'), compaction('s')].join('\n')), null);
    // A post-boundary prompt with no text block gives nothing to match on.
    const noText = JSON.stringify({ kind: 'Prompt', data: { content: [{ kind: 'image', data: 'x' }] } });
    assert.strictEqual(parseKiroCompactionBoundary([compaction('s'), noText].join('\n')), null);
    assert.strictEqual(parseKiroCompactionBoundary(''), null);
  });

  test('a half-written final line does not shift the record indices', () => {
    // Normal while the session is live in another process.
    const jsonl = [prompt('a'), compaction('s'), prompt(SURVIVOR), '{"kind":"Assistant'].join('\n');
    const b = parseKiroCompactionBoundary(jsonl);
    assert.strictEqual(b!.recordIndex, 1, 'the unparsed line keeps its position');
  });
});

suite('matching the replay against the boundary anchor', () => {
  const boundary = parseKiroCompactionBoundary(
    [prompt('old'), compaction('s'), prompt(SURVIVOR, MEMORY_BLOB)].join('\n'),
  );

  test('the anchor chunk is recognised', () => {
    assert.strictEqual(isKiroResumeAnchor(boundary, SURVIVOR), true);
    assert.strictEqual(isKiroResumeAnchor(boundary, MEMORY_BLOB), true);
  });

  test('a chunk the agent extended still matches on its prefix', () => {
    // The extension prepends its recall and agents append their own context, so
    // equality is too strict.
    assert.strictEqual(isKiroResumeAnchor(boundary, SURVIVOR + '\n\nAdditional ACP context: …'), true);
  });

  test('an unrelated pre-compaction chunk does not match', () => {
    assert.strictEqual(isKiroResumeAnchor(boundary, 'first thing'), false);
    assert.strictEqual(isKiroResumeAnchor(boundary, ''), false);
    assert.strictEqual(isKiroResumeAnchor(null, SURVIVOR), false);
  });

  test('a short anchor is refused — it would cut at the wrong turn', () => {
    const shortB = parseKiroCompactionBoundary([prompt('x'), compaction('s'), prompt('ok')].join('\n'));
    assert.strictEqual(isKiroResumeAnchor(shortB, 'ok'), false);
    assert.strictEqual(isKiroResumeAnchor(shortB, 'ok fine, do it'), false);
  });
});

suite('reading a boundary off disk', () => {
  test('reads the cli transcript layout, and returns null for an unknown session', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-boundary-'));
    try {
      const dir = path.join(home, 'sessions', 'cli');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'abc-123.jsonl'),
        [prompt('old one'), compaction('the summary'), prompt(SURVIVOR)].join('\n'),
        'utf8',
      );
      const b = readKiroCompactionBoundary('abc-123', home);
      assert.ok(b, 'boundary not read');
      assert.strictEqual(b!.summary, 'the summary');
      assert.strictEqual(readKiroCompactionBoundary('no-such-session', home), null);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('a session id carrying the sess_ prefix resolves too', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-boundary-'));
    try {
      const dir = path.join(home, 'sessions', 'cli');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'xyz.jsonl'),
        [prompt('old'), compaction('s'), prompt(SURVIVOR)].join('\n'),
        'utf8',
      );
      assert.ok(readKiroCompactionBoundary('sess_xyz', home), 'sess_ prefix must be stripped');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

suite('the replay gate is wired into the host', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts'), 'utf8');

  test('armed at load start, and only for kiro', () => {
    assert.ok(src.includes('this.armPrecompactionSkip();'), 'must arm when the replay starts');
    const at = src.indexOf('private armPrecompactionSkip()');
    assert.ok(at > 0, 'armPrecompactionSkip missing');
    const body = src.slice(at, at + 1400);
    assert.ok(body.includes('isKiroAgentName'), 'other agents replay their own compacted view');
    assert.ok(body.includes('readKiroCompactionBoundary(sessionId)'), 'boundary comes from disk');
    assert.ok(body.includes('if (!boundary) {'), 'no compaction means no filtering');
  });

  test('updates are withheld BEFORE the webview post, not after', () => {
    // The point is to skip the post and the DOM render, not just the display.
    const at = src.indexOf('if (this.shouldWithholdPrecompactionUpdate(update)) {');
    assert.ok(at > 0, 'gate not called');
    const post = src.indexOf("type: 'sessionUpdate',", at);
    assert.ok(post > at, 'the gate must run before the sessionUpdate post');
  });

  test('the gate also precedes the COALESCER, which posts on its own path', () => {
    // This assertion was missing, and its absence hid a live bug for eight days.
    // The gate used to sit below the stream coalescer, which returns early for
    // agent_message_chunk / agent_thought_chunk — so those two kinds never reached
    // it. Measured on one resume: 6723 updates correctly withheld, and 1002 message
    // + 826 thought chunks rendered anyway, i.e. pre-compaction prose and thinking
    // shown above the divider that says the conversation was compacted.
    //
    // The old test passed throughout, because it only compared the gate against the
    // sessionUpdate post and the coalescer is a SECOND way text reaches the webview.
    const at = src.indexOf('if (this.shouldWithholdPrecompactionUpdate(update)) {');
    assert.ok(at > 0, 'gate not called');
    // The invariant that matters: the gate precedes EVERY path that reaches the
    // webview. Not "no early returns in between" — several legitimate ones exist
    // (the commandOutput passthrough, the duplicate-Killed drop), and they are fine
    // BECAUSE they sit after the gate.
    const method = methodBody(src, 'private handleSessionUpdate(') || src;
    const gateInMethod = method.indexOf('if (this.shouldWithholdPrecompactionUpdate(update)) {');
    assert.ok(gateInMethod > 0, 'gate not inside the session-update method');
    for (const sink of ['this.streamCoalescer.append(', "this.postMessage({\n      type: 'sessionUpdate'"]) {
      let from = 0;
      for (;;) {
        const at2 = method.indexOf(sink, from);
        if (at2 < 0) {
          break;
        }
        assert.ok(at2 > gateInMethod, `a webview sink precedes the gate: ${sink.slice(0, 32)}`);
        from = at2 + sink.length;
      }
    }
  });

  test('the gate is the FIRST thing after the active-session check', () => {
    // Stated as an ordering invariant rather than a list of known paths, so a new
    // early return added above it fails here instead of silently leaking a kind.
    const active = src.indexOf('if (update.sessionId !== activeId) {');
    const gate = src.indexOf('if (this.shouldWithholdPrecompactionUpdate(update)) {');
    assert.ok(active > 0 && gate > active, 'gate must follow the active-session drop');
    const between = src.slice(active, gate);
    // Only the active-session block's own return may appear in between.
    assert.strictEqual(
      (between.match(/\breturn;/g) ?? []).length,
      1,
      'another early return was added between the active-session check and the gate',
    );
  });

  test('held, not dropped — a missed anchor cannot empty the panel', () => {
    const at = src.indexOf('private shouldWithholdPrecompactionUpdate(');
    const body = src.slice(at, at + 2600);
    assert.ok(body.includes('skip.held.push(update)'), 'withheld updates must be kept');
    assert.ok(body.includes('PRECOMPACTION_HOLD_MAX'), 'the buffer must be bounded');
    assert.ok(body.includes('isKiroResumeAnchor('), 'the anchor decides where the replay resumes');
    assert.ok(body.includes('this.precompactionSkip = null;'), 'live traffic must never be gated');
    const flush = src.indexOf('private flushPrecompactionHold()');
    assert.ok(flush > 0, 'no fail-safe flush');
    assert.ok(src.slice(flush, flush + 1200).includes("type: 'sessionUpdate',"), 'flush must re-post in order');
  });

  test('the fail-safe flush lands before loadSessionEnd', () => {
    const flushCall = src.indexOf('this.flushPrecompactionHold();');
    const endPost = src.indexOf("this.postMessage({ type: 'loadSessionEnd', ok });");
    assert.ok(flushCall > 0 && endPost > flushCall, 'flushed updates must arrive while still in replay mode');
  });

  test('the boundary is announced so the divider and summary can be shown', () => {
    const at = src.indexOf('private shouldWithholdPrecompactionUpdate(');
    const body = src.slice(at, at + 2600);
    assert.ok(body.includes("type: 'compactionBoundary'"), 'the webview needs to know');
    assert.ok(body.includes('summary: skip.boundary.summary'), 'the lost summary must be surfaced');
    assert.ok(body.includes('droppedPrompts: skip.boundary.droppedPrompts'), 'the divider says how much is hidden');
  });
});

suite('the webview shows the divider and drops its own stale history', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts'), 'utf8');

  test('the divider and the summary are added at the boundary', () => {
    const at = src.indexOf("case 'compactionBoundary': {");
    assert.ok(at > 0, 'webview handler missing');
    const body = src.slice(at, at + 1600);
    assert.ok(body.includes('— conversation compacted —'), 'divider label');
    assert.ok(body.includes('— conversation cleared —'), 'a /clear is not a compaction');
    assert.ok(body.includes('earlier turns hidden'), 'say how much was hidden');
    assert.ok(body.includes('compactionSummary: true'), 'the summary rides along as an assistant row');
    assert.ok(body.includes('compactNotice: true'), 'the divider needs its marker for styling and trimming');
  });

  test('the snapshot is trimmed to the divider at load end', () => {
    // The host filters the REPLAY; a panel that was already on this session still
    // holds the pre-compaction turns in its own snapshot, and the merge keeps them.
    const at = src.indexOf('if (compactionBoundaryIndex >= 0) {');
    assert.ok(at > 0, 'no trim at load end');
    const body = src.slice(at, at + 1200);
    assert.ok(body.includes('chatHistory = chatHistory.slice(_cbAt)'), 'must trim to the divider');
    assert.ok(body.includes('saveState()'), 'the trim must persist');
    const render = src.indexOf('var assistantItems = renderChatHistory();', at);
    assert.ok(render > at, 'the trim must run before the rebuild');
  });

  test('the divider is styled as a compact notice', () => {
    assert.ok(
      src.includes("(item.compactNotice || String(item.text || '').trim() === 'Conversation compacted.')"),
      'restore must style the divider too',
    );
  });
});

suite('the real transcript, when this machine has one', () => {
  test('the measured session yields the boundary that explains the 13 s replay', () => {
    const p = path.join(os.homedir(), '.kiro', 'sessions', 'cli', '2d37974b-70b8-4420-8e1e-e8901706d2b6.jsonl');
    if (!fs.existsSync(p)) {
      // Environment-dependent fixture: the synthetic suites above cover the logic.
      return;
    }
    const b = parseKiroCompactionBoundary(fs.readFileSync(p, 'utf8'));
    assert.ok(b, 'the measured session has a Compaction record');
    assert.strictEqual(b!.kind, 'Compaction');
    assert.strictEqual(b!.recordIndex, 1550);
    assert.strictEqual(b!.droppedPrompts, 35);
    assert.ok(b!.summary.length > 1000, `the summary kiro never replays: ${b!.summary.length} chars`);
    assert.ok(b!.resumeAfterTexts.length > 0, 'an anchor to resume at');
  });
});

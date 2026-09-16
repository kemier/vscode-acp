import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { decodeTemplate } from './templateDecode';

/**
 * Subagent lifecycle across reload / session switch / resume.
 *
 * Established from the code, not assumed:
 *
 *  - reload window  → the extension host restarts and ericli dies with it, so subagents go
 *                     too. Nothing live survives.
 *  - switch session → subagents keep running in the background. Their frames are DROPPED at
 *                     the host (`update.sessionId !== activeId`), so they cannot pollute the
 *                     new session's panel. Content is not lost: results become role:'tool'
 *                     messages in state.messages, and persistSession writes per turn, so a
 *                     switch-back replays them from the session file. Buffering the frames
 *                     too would duplicate that recovery and grow unbounded.
 *  - closeSession   → aborts, which cancels subagents via config.signal.
 *  - deleteSession  → used to only forget the session, leaving subagents running with
 *                     nothing to receive them. Fixed to mirror closeSession.
 *
 * The remaining UI gap was a stale spinner: failInterruptedSubagentStagesInHistory only
 * scanned from the LAST user message forward — deliberately, so an interrupted later turn
 * could not retroactively red-cross earlier turns that really finished — which left older
 * turns' running stages spinning forever after a resume.
 */
const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');
const SRC = fs.readFileSync(SOURCE, 'utf8');

/** Run the real sweep against a synthetic history. */
function loadSweep(): (history: unknown[]) => void {
  const needle = 'function failInterruptedSubagentStagesInHistory(';
  const at = SRC.indexOf(needle);
  assert.ok(at > 0, 'sweep function not found');
  let i = SRC.indexOf('{', at);
  let depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') {
      depth++;
    } else if (SRC[i] === '}') {
      depth--;
      if (depth === 0) {
        break;
      }
    }
  }
  const body = decodeTemplate(SRC.slice(at, i + 1));
  // Stub the collaborators the sweep touches; only the stage rewriting is under test.
  const harness = `
    var chatHistory = arguments[0];
    function isSessionInterruptNotice() { return false; }
    function sessionMarkedInterrupted() { return false; }
    function applyStageStatusToDom() {}
    function syncCrewParentRawInput() {}
    function getStatusIcon(s) { return s; }
    ${body}
    failInterruptedSubagentStagesInHistory();
  `;
  return new Function(harness) as (history: unknown[]) => void;
}

const stage = (status: string) => ({ label: 'ch', status });
const spawn = (status: string, stages: Array<{ label: string; status: string }>) => ({
  kind: 'toolCall',
  status,
  rawInput: { stages },
});
const userMsg = (text: string) => ({ kind: 'message', role: 'user', text });

suite('resumed session clears stale subagent spinners', () => {
  test('an OLDER turn with a completed parent settles to completed, not failed', () => {
    // The false-red risk is exactly why the original scan skipped these. A completed parent
    // plus a user who moved on means the work finished and the stage missed its update.
    const history = [
      spawn('completed', [stage('running'), stage('completed')]),
      userMsg('next question'),
      spawn('completed', [stage('completed')]),
    ];
    loadSweep()(history);
    const stages = (history[0] as { rawInput: { stages: Array<{ status: string }> } }).rawInput.stages;
    assert.strictEqual(stages[0].status, 'completed', 'must not be a false failure');
    assert.strictEqual(stages[1].status, 'completed');
  });

  test('an OLDER turn whose parent never completed settles to failed', () => {
    const history = [
      spawn('in_progress', [stage('running')]),
      userMsg('next question'),
      spawn('completed', [stage('completed')]),
    ];
    loadSweep()(history);
    const stages = (history[0] as { rawInput: { stages: Array<{ status: string }> } }).rawInput.stages;
    assert.strictEqual(stages[0].status, 'failed', 'an unfinished parent is an honest failure');
  });

  test('no stage anywhere is left in a spinning state', () => {
    // The whole point: a spinner after a resume is always wrong, because the process that
    // owned the subagent is gone.
    const history = [
      spawn('completed', [stage('running'), stage('pending')]),
      spawn('in_progress', [stage('working'), stage('in_progress')]),
      userMsg('later'),
      spawn('completed', [stage('running')]),
    ];
    loadSweep()(history);
    for (const item of history) {
      const ri = (item as { rawInput?: { stages?: Array<{ status: string }> } }).rawInput;
      for (const s of ri?.stages ?? []) {
        assert.ok(
          !['running', 'in_progress', 'pending', 'working'].includes(s.status),
          `left spinning: ${s.status}`,
        );
      }
    }
  });

  test('already-terminal stages in older turns are untouched', () => {
    const history = [
      spawn('completed', [stage('completed'), stage('failed')]),
      userMsg('later'),
    ];
    loadSweep()(history);
    const stages = (history[0] as { rawInput: { stages: Array<{ status: string }> } }).rawInput.stages;
    assert.deepStrictEqual(stages.map((s) => s.status), ['completed', 'failed']);
  });

  test('history with no user message at all is still swept safely', () => {
    const history = [spawn('completed', [stage('running')])];
    assert.doesNotThrow(() => loadSweep()(history));
  });
});

suite('background-session frames are dropped, not buffered', () => {
  test('the drop is documented and logged, not silent', () => {
    const at = SRC.indexOf('if (update.sessionId !== activeId) {');
    assert.ok(at > 0, 'the session filter must exist');
    // Brace-matched. My first version of this test used SRC.slice(at, at + 900) and the
    // window stopped short of the `return;` — the seventh fixed-slice scan to mislead today,
    // and the only one I wrote myself.
    let i = SRC.indexOf('{', at);
    let depth = 0;
    let end = SRC.length;
    for (; i < SRC.length; i++) {
      if (SRC[i] === '{') {
        depth++;
      } else if (SRC[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    const body = SRC.slice(at, end);
    assert.ok(body.includes('Deliberately dropped, not buffered'), 'the decision must be stated');
    assert.ok(body.includes('persistSession'), 'the recovery path must be named');
    assert.ok(body.includes('log('), 'the drop must be observable');
    assert.ok(body.includes('return;'), 'and it must still drop');
  });
});

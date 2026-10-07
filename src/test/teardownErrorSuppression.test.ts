import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Tearing a session down on purpose must not put an error in the panel.
 *
 * Clicking + while a turn was streaming produced "ACP connection closed" in the
 * NEW chat. Killing the agent rejects every dangling request on its connection,
 * which is expected during a deliberate teardown — but two things went wrong:
 *
 *   1. the slash-command catch had no suppression at all, and it was a
 *      side-channel slash command that was in flight;
 *   2. the prompt path's suppression compared the ACTIVE session id, which is
 *      racy — the replacement session is only registered when session/new
 *      RESPONDS.
 *
 * Measured from the ACP Client log of the reported click:
 *
 *   04:29:24.610  disconnectAgent: cancelling in-flight prompt for 41e95918
 *   04:29:24.633  SessionManager: connecting to agent "EricCLI"
 *   04:29:24.639  ERROR: Slash command failed ACP connection closed   <- surfaced
 *   04:29:26.628  Connected to agent EricCLI, session e9491bdc…       <- id changes here
 *
 * For those ~2 seconds the active id still equalled the dying session, so the
 * id comparison could not suppress anything.
 */

const MANAGER = path.resolve(__dirname, '../../src/core/SessionManager.ts');
const PROVIDER = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

/**
 * Build a working copy of SessionManager's teardown bookkeeping by extracting
 * the real members, so the window logic and pruning are the shipped ones.
 */
function makeTeardownTracker(nowRef: { now: number }) {
  const src = fs.readFileSync(MANAGER, 'utf8');
  function member(sig: string): string {
    const at = src.indexOf(sig);
    assert.ok(at > 0, `not found in SessionManager: ${sig}`);
    const open = src.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') {depth++;}
      else if (src[i] === '}' && --depth === 0) {return src.slice(at, i + 1);}
    }
    assert.fail(`could not brace-match ${sig}`);
  }
  const windowMatch = src.match(/DELIBERATE_TEARDOWN_WINDOW_MS\s*=\s*([0-9_]+)/);
  assert.ok(windowMatch, 'DELIBERATE_TEARDOWN_WINDOW_MS not found');
  const windowMs = Number(windowMatch[1].replace(/_/g, ''));

  const body = [
    member('private markDeliberateTeardown(sessionId: string): void'),
    member('wasDeliberatelyTornDown(sessionId: string): boolean'),
  ]
    .join('\n')
    // Method definitions are not valid at statement position — turn each into a
    // function declaration, keeping the body byte-identical.
    .replace(
      /private markDeliberateTeardown\(sessionId: string\): void/,
      'function markDeliberateTeardown(sessionId)',
    )
    .replace(
      /wasDeliberatelyTornDown\(sessionId: string\): boolean/,
      'function wasDeliberatelyTornDown(sessionId)',
    )
    .replace(/SessionManager\.DELIBERATE_TEARDOWN_WINDOW_MS/g, String(windowMs))
    .replace(/this\.deliberateTeardowns/g, 'deliberateTeardowns');
  assert.ok(
    body.startsWith('function markDeliberateTeardown(sessionId)'),
    `signature rewrite failed: ${body.slice(0, 80)}`,
  );
  assert.ok(!/:\s*(string|boolean|void|number)/.test(body), `type annotations remain: ${body.slice(0, 200)}`);

  const fn = new Function(
    'Date',
    `
      const deliberateTeardowns = new Map();
      ${body}
      return {
        mark: (id) => markDeliberateTeardown(id),
        was: (id) => wasDeliberatelyTornDown(id),
        size: () => deliberateTeardowns.size,
      };
    `,
  );
  return { tracker: fn({ now: () => nowRef.now }), windowMs };
}

/** The real isExpectedTeardownError, with a stubbed session manager. */
function makePredicate(activeId: string | null, tornDown: Set<string>) {
  const src = fs.readFileSync(PROVIDER, 'utf8');
  const sig = 'private isExpectedTeardownError(errMsg: string, sessionId: string): boolean {';
  const at = src.indexOf(sig);
  assert.ok(at > 0, 'isExpectedTeardownError not found');
  const open = src.indexOf('{', at);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') {depth++;}
    else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  const body = src
    .slice(open + 1, end - 1)
    .replace(/this\.sessionManager/g, 'sessionManager');
  const fn = new Function('errMsg', 'sessionId', 'sessionManager', body);
  const sessionManager = {
    getActiveSessionId: () => activeId,
    wasDeliberatelyTornDown: (id: string) => tornDown.has(id),
  };
  return (errMsg: string, sessionId: string) => fn(errMsg, sessionId, sessionManager) as boolean;
}

suite('deliberate teardown bookkeeping', () => {
  test('a marked session is recognised, an unmarked one is not', () => {
    const nowRef = { now: 1_000_000 };
    const { tracker } = makeTeardownTracker(nowRef);
    tracker.mark('41e95918');
    assert.strictEqual(tracker.was('41e95918'), true);
    assert.strictEqual(tracker.was('somethingelse'), false);
  });

  test('the record expires, so a genuine later failure is still reported', () => {
    const nowRef = { now: 1_000_000 };
    const { tracker, windowMs } = makeTeardownTracker(nowRef);
    tracker.mark('41e95918');
    nowRef.now += windowMs + 1;
    assert.strictEqual(tracker.was('41e95918'), false);
  });

  test('the record still holds across the observed 2s race window', () => {
    // teardown 04:29:24.610 -> new session active 04:29:26.628
    const nowRef = { now: 1_000_000 };
    const { tracker } = makeTeardownTracker(nowRef);
    tracker.mark('41e95918');
    nowRef.now += 2_018;
    assert.strictEqual(tracker.was('41e95918'), true);
  });

  test('old entries are pruned so the map cannot grow unbounded', () => {
    const nowRef = { now: 1_000_000 };
    const { tracker, windowMs } = makeTeardownTracker(nowRef);
    for (let i = 0; i < 50; i++) {tracker.mark('old-' + i);}
    assert.strictEqual(tracker.size(), 50);
    nowRef.now += windowMs + 1;
    tracker.mark('fresh');
    // The insert prunes everything stale, leaving just the new one.
    assert.strictEqual(tracker.size(), 1);
    assert.strictEqual(tracker.was('fresh'), true);
  });
});

suite('isExpectedTeardownError', () => {
  test('suppresses a connection-closed error while the id has not changed yet', () => {
    // THE reported case: + clicked during streaming. The active id still equals
    // the dying session because session/new has not responded.
    const isExpected = makePredicate('41e95918', new Set(['41e95918']));
    assert.strictEqual(isExpected('ACP connection closed', '41e95918'), true);
  });

  test('suppresses it after the active session has moved on', () => {
    const isExpected = makePredicate('e9491bdc', new Set());
    assert.strictEqual(isExpected('ACP connection closed', '41e95918'), true);
  });

  test('does NOT suppress a real failure of the live session', () => {
    const isExpected = makePredicate('41e95918', new Set());
    assert.strictEqual(isExpected('ACP connection closed', '41e95918'), false);
  });

  test('never suppresses an unrelated error, even during a teardown', () => {
    // Only connection-closed is expected fallout; a context-length or auth
    // failure must still reach the user.
    const isExpected = makePredicate('41e95918', new Set(['41e95918']));
    for (const other of [
      'Requested token count exceeds the model maximum context length',
      'Authentication required',
      'Prompt already in progress',
      '',
    ]) {
      assert.strictEqual(isExpected(other, '41e95918'), false, `should not suppress: ${other}`);
    }
  });
});

suite('both error paths consult the predicate', () => {
  const src = fs.readFileSync(PROVIDER, 'utf8');

  test('the slash-command catch suppresses expected teardown errors', () => {
    // It previously posted unconditionally, which is how the error reached the
    // new chat — a side-channel slash command was the in-flight request.
    const at = src.indexOf("logError('Slash command failed', e);");
    assert.ok(at > 0, 'slash-command catch not found');
    const body = src.slice(at, at + 1400);
    assert.ok(body.includes('isExpectedTeardownError'), 'slash catch does not consult the predicate');
    const guardAt = body.indexOf('isExpectedTeardownError');
    const postAt = body.indexOf("this.postMessage({ type: 'error'");
    assert.ok(postAt > guardAt, 'the guard must precede the error post');
  });

  test('the prompt catch no longer compares the active id inline', () => {
    // The inline comparison was the racy version; it must go through the
    // predicate so the teardown record is consulted too.
    assert.ok(
      !src.includes("/connection closed/i.test(errMsg) && this.sessionManager.getActiveSessionId() !== activeId"),
      'the racy inline id comparison is still present',
    );
    const at = src.indexOf("logError('Prompt failed', e);");
    assert.ok(at > 0, 'prompt catch not found');
    assert.ok(src.slice(at, at + 1600).includes('isExpectedTeardownError'));
  });

  test('SessionManager marks teardowns at both call sites', () => {
    const mgr = fs.readFileSync(MANAGER, 'utf8');
    // disconnectAgent (new conversation / disconnect) and the loadSession
    // switch path both kill in-flight work on purpose.
    const disconnectAt = mgr.indexOf('disconnectAgent: cancelling in-flight prompt for');
    assert.ok(disconnectAt > 0);
    assert.ok(
      mgr.slice(Math.max(0, disconnectAt - 900), disconnectAt).includes('markDeliberateTeardown'),
      'disconnectAgent does not mark the teardown',
    );
    const loadAt = mgr.indexOf('loadSession: cancelling in-flight prompt for previous session');
    assert.ok(loadAt > 0);
    assert.ok(
      mgr.slice(Math.max(0, loadAt - 500), loadAt).includes('markDeliberateTeardown'),
      'the session-switch path does not mark the teardown',
    );
  });
});

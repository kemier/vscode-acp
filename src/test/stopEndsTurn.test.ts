import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * /stop killed the processes but left the turn hanging.
 *
 * Measured (exthost13, ericli session c5015617):
 *
 *   06:36:23  handleSendPrompt: stale response (gen 6 → 7), suppressing promptEnd
 *   06:38:22  Cancelling turn for session c5015617…      <- fallback stranded, never fired
 *   06:46:21  Stop processes for session c5015617…       <- LAST line of the log
 *
 * Nothing followed the /stop: no promptEnd, no new sendPrompt. Killing the
 * background processes does not end the ACP turn — the agent's prompt promise
 * stays pending — so the queued "Send Now" message never drained and the status
 * stayed on "Interrupting…".
 *
 * An explicit /stop now routes through the cancel + 5s fallback path, but only
 * when a prompt is actually in flight.
 *
 * handleStopProcesses is plain TypeScript, so it runs against a stub `this`.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function loadHandleStopProcesses(): (self: any) => Promise<void> {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const start = src.indexOf('  private async handleStopProcesses(): Promise<void> {');
  assert.ok(start >= 0, 'handleStopProcesses not found');
  const end = src.indexOf('\n  }\n', start);
  assert.ok(end > start, 'end of handleStopProcesses not found');
  const body = src.slice(src.indexOf('{', start) + 1, end);
  // `log` / `logError` are module-scope imports in the real file; inject no-ops
  // so the extracted body runs standalone.
  const run = new AsyncFunction(
    'self',
    'log',
    'logError',
    `await (async function(){${body}}).call(self);`,
  );
  return (self: any) =>
    run(
      self,
      () => {},
      () => {},
    );
}

interface Stub {
  posted: any[];
  calls: string[];
  self: any;
}

function stub(opts: { activeId: string | null; inFlight: boolean }): Stub {
  const posted: any[] = [];
  const calls: string[] = [];
  const self: any = {
    postMessage: (m: any) => posted.push(m),
    handleCancelTurn: async () => {
      calls.push('handleCancelTurn');
    },
    sessionManager: {
      getActiveSessionId: () => opts.activeId,
      stopProcesses: async (id: string) => {
        calls.push('stopProcesses:' + id);
      },
      isPromptInFlight: () => opts.inFlight,
    },
  };
  return { posted, calls, self };
}

suite('/stop ends the turn (Interrupting… stuck after a stop)', () => {
  const handleStopProcesses = loadHandleStopProcesses();

  test('kills the processes and then cancels the in-flight turn', async () => {
    const s = stub({ activeId: 'sess-1', inFlight: true });
    await handleStopProcesses(s.self);

    assert.deepStrictEqual(
      s.calls,
      ['stopProcesses:sess-1', 'handleCancelTurn'],
      'the processes must die first, then the turn must be ended so promptEnd drains the queue',
    );
    assert.deepStrictEqual(s.posted.map((m) => m.type), ['processesStopped']);
  });

  test('does not cancel when no prompt is in flight', async () => {
    const s = stub({ activeId: 'sess-1', inFlight: false });
    await handleStopProcesses(s.self);

    assert.deepStrictEqual(
      s.calls,
      ['stopProcesses:sess-1'],
      'a /stop with an idle session must not post a spurious cancel',
    );
    assert.deepStrictEqual(s.posted.map((m) => m.type), ['processesStopped']);
  });

  test('is a no-op without an active session', async () => {
    const s = stub({ activeId: null, inFlight: true });
    await handleStopProcesses(s.self);
    assert.deepStrictEqual(s.calls, []);
    assert.deepStrictEqual(s.posted, []);
  });

  test('still notifies the webview when stopProcesses throws', async () => {
    const s = stub({ activeId: 'sess-1', inFlight: false });
    s.self.sessionManager.stopProcesses = async () => {
      throw new Error('boom');
    };
    await handleStopProcesses(s.self);
    assert.deepStrictEqual(
      s.posted.map((m) => m.type),
      ['processesStopped'],
      'the /ps panel must still be refreshed even if the kill failed',
    );
  });
});

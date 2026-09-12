import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * /stop kills the background processes WITHOUT ending the turn.
 *
 * /stop is a process kill only: it stops all running processes spawned by this
 * session. If the current turn has an ongoing task, it continues — a steered
 * prompt mid-turn stays in flight and is dealt with at the agent's next step.
 * It must NOT route through handleCancelTurn() (which aborts the prompt and
 * emits end_turn, dropping any steered prompt).
 *
 * handleStopProcesses is plain TypeScript, so it runs against a stub `this`.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function loadHandleStopProcesses(): (self: any, suppressNotice?: boolean) => Promise<void> {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const start = src.indexOf('  private async handleStopProcesses(suppressNotice?: boolean): Promise<void> {');
  assert.ok(start >= 0, 'handleStopProcesses not found');
  const end = src.indexOf('\n  }\n', start);
  assert.ok(end > start, 'end of handleStopProcesses not found');
  const body = src.slice(src.indexOf('{', start) + 1, end);
  // `log` / `logError` are module-scope imports in the real file; inject no-ops
  // so the extracted body runs standalone.
  const run = new AsyncFunction(
    'self',
    'suppressNotice',
    'log',
    'logError',
    `await (async function(){${body}}).call(self);`,
  );
  return (self: any, suppressNotice?: boolean) =>
    run(
      self,
      suppressNotice,
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

suite('/stop kills processes without ending the turn', () => {
  const handleStopProcesses = loadHandleStopProcesses();

  test('kills the processes but does NOT cancel the in-flight turn', async () => {
    const s = stub({ activeId: 'sess-1', inFlight: true });
    await handleStopProcesses(s.self);

    assert.deepStrictEqual(
      s.calls,
      ['stopProcesses:sess-1'],
      '/stop only kills the processes — it must not cancel the turn, so a steered prompt / ongoing task continues',
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

  test('forwards suppressNotice to the webview so Send Now suppresses the Killed notice', async () => {
    const s = stub({ activeId: 'sess-1', inFlight: true });
    await handleStopProcesses(s.self, true);
    assert.deepStrictEqual(s.posted[0], { type: 'processesStopped', suppressNotice: true });
  });
});

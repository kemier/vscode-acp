/**
 * The ACP terminal surface must be spec-complete and status-honest.
 *
 * Audit 2026-10-10 found three gaps in TerminalHandler: a failed spawn resolved
 * exitPromise but left exited=false with an all-null status (waitForTerminalExit
 * returned {null,null}, invalid per WaitForTerminalExitResponse); output sync
 * lagged a 100ms setInterval; and the pty never showed how a command ended.
 * The fix synthesizes a failed exit on spawn 'error', mutates a shared OutputBuffer
 * in place, and writes an exit line to the pty. These tests pin the semantics
 * end-to-end: real children for the close path, a fake spawn for the error path.
 */
import * as assert from 'assert';
import { TerminalHandler } from '../handlers/TerminalHandler';
import { EventEmitter } from 'node:events';

// The handler calls child_process.spawn through the raw module object, so the
// test must patch that same object (an `import * as` namespace is getter-only).
declare function require(name: string): any;

suite('terminal handler', () => {
  const sessionId = 's1';

  test('normal exit reports exitCode 0 and captured output', async () => {
    const handler = new TerminalHandler();
    const { terminalId } = await handler.createTerminal({
      sessionId,
      command: 'echo',
      args: ['hi'],
    });
    const exit = await handler.waitForTerminalExit({ sessionId, terminalId });
    assert.strictEqual(exit.exitCode, 0, 'clean exit should report exitCode 0');
    assert.strictEqual(exit.signal, null, 'clean exit should report null signal');
    const out = await handler.terminalOutput({ sessionId, terminalId });
    assert.ok(out.output.includes('hi'), 'output should contain the echoed text');
    assert.ok(out.exitStatus?.exitCode === 0, 'output should carry the exit status once exited');
  });

  test('outputByteLimit truncates from the beginning, tail kept', async () => {
    const handler = new TerminalHandler();
    const { terminalId } = await handler.createTerminal({
      sessionId,
      command: 'printf',
      args: ['x'.repeat(100)],
      outputByteLimit: 10,
    });
    const exit = await handler.waitForTerminalExit({ sessionId, terminalId });
    assert.strictEqual(exit.exitCode, 0, 'printf should exit cleanly');
    const out = await handler.terminalOutput({ sessionId, terminalId });
    assert.ok(out.truncated, '100 bytes through a 10-byte limit should truncate');
    assert.ok(out.output.length <= 10, 'kept output should respect the byte limit');
    assert.ok(out.output.endsWith('x'), 'truncation keeps the tail');
  });

  test('kill surfaces the terminating signal via waitForTerminalExit', async () => {
    const handler = new TerminalHandler();
    const { terminalId } = await handler.createTerminal({
      sessionId,
      command: 'sleep',
      args: ['30'],
    });
    await handler.killTerminal({ sessionId, terminalId });
    const exit = await handler.waitForTerminalExit({ sessionId, terminalId });
    assert.strictEqual(exit.signal, 'SIGTERM', 'killed sleep should report SIGTERM');
    assert.strictEqual(exit.exitCode, null, 'signal-killed process has no exit code');
  });

  test('unknown terminalId throws Terminal not found', async () => {
    const handler = new TerminalHandler();
    try {
      await handler.terminalOutput({ sessionId, terminalId: 'nope' });
      assert.fail('unknown terminalId should throw');
    } catch (e) {
      assert.ok(/Terminal not found/.test(String(e)), 'error should name the missing terminal');
    }
  });

  test('release removes the terminal from the registry', async () => {
    const handler = new TerminalHandler();
    const { terminalId } = await handler.createTerminal({ sessionId, command: 'true' });
    await handler.releaseTerminal({ sessionId, terminalId });
    try {
      await handler.terminalOutput({ sessionId, terminalId });
      assert.fail('released terminal should be gone');
    } catch (e) {
      assert.ok(/Terminal not found/.test(String(e)), 'released terminal should 404');
    }
  });

  test('spawn failure yields a valid failed status, not all-null', async () => {
    // The handler resolves spawn 'error' through child_process.spawn; swap in a
    // fake child so the error event is deterministic (the real shell would just
    // exit 127 instead of failing the spawn itself).
    const cpModule = require('child_process');
    const origSpawn = cpModule.spawn;
    const fake = new EventEmitter();
    (fake as unknown as { stdout: null }).stdout = null;
    (fake as unknown as { stderr: null }).stderr = null;
    (fake as unknown as { kill: () => void }).kill = () => {};
    cpModule.spawn = () => fake;
    try {
      const handler = new TerminalHandler();
      const { terminalId } = await handler.createTerminal({ sessionId, command: 'does-not-exist' });
      fake.emit('error', new Error('fake ENOENT'));
      const exit = await handler.waitForTerminalExit({ sessionId, terminalId });
      assert.strictEqual(exit.exitCode, 1, 'spawn failure should synthesize exitCode 1');
      assert.strictEqual(exit.signal, null, 'spawn failure has no signal');
      const out = await handler.terminalOutput({ sessionId, terminalId });
      assert.ok(out.exitStatus !== undefined, 'failed spawn should report an exit status in output');
    } finally {
      cpModule.spawn = origSpawn;
    }
  });
});

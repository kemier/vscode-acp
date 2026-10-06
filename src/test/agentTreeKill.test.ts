/**
 * Windows agent kill must reap the WHOLE tree, not just the cmd.exe wrapper.
 *
 * Observed 2026-10-06 on win-pc: five claude-code-acp node processes from
 * long-closed VS Code windows were still alive. killAgent() signalled only
 * the direct child (cmd.exe from spawn(shell:true)); the node grandchild
 * survived, kept its inference HTTP connection open, and wedged the
 * single-slot llama server (is_processing=true with zero clients, every new
 * prompt ECONNRESET, slot save/restore 404).
 *
 * The fix routes all kills through killProcessTree(): taskkill /T /F on
 * win32, process-group signals on POSIX. These tests pin that wiring and
 * verify the POSIX path end-to-end with a real child.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { AgentManager } from '../core/AgentManager';

const SRC = fs.readFileSync(
  path.join(__dirname, '../../src/core/AgentManager.ts'),
  'utf8',
);

suite('agent process tree kill', () => {
  test('win32 branch uses taskkill /T /F (tree + force)', () => {
    const helper = SRC.indexOf('private killProcessTree');
    assert.ok(helper > 0, 'killProcessTree helper should exist');
    const body = SRC.slice(helper, helper + 1200);
    assert.ok(body.includes("process.platform === 'win32'"), 'helper should branch on win32');
    assert.ok(body.includes("'taskkill'"), 'win32 kill should use taskkill');
    assert.ok(body.includes("'/T'"), 'taskkill must include /T (tree)');
    assert.ok(body.includes("'/F'"), 'taskkill must include /F (force)');
  });

  test('killAgent and forceKillAll both route through killProcessTree', () => {
    const killAgent = SRC.slice(SRC.indexOf('killAgent(agentId'));
    assert.ok(
      killAgent.includes('this.killProcessTree(instance, false)'),
      'killAgent should SIGTERM/taskkill the tree first',
    );
    assert.ok(
      killAgent.includes('this.killProcessTree(instance, true)'),
      'killAgent should keep the SIGKILL escalation (POSIX)',
    );
    const forceKillAll = SRC.slice(SRC.indexOf('forceKillAll()'));
    assert.ok(
      forceKillAll.includes('this.killProcessTree(instance, true)'),
      'forceKillAll should tree-kill too',
    );
  });

  test('no kill path targets only the direct child outside the helper', () => {
    // The old bug: instance.process.kill() as the primary mechanism kills
    // just the cmd.exe wrapper on Windows. It may only appear inside
    // killProcessTree as the POSIX fallback.
    const kills = SRC.split('instance.process.kill(').length - 1;
    assert.strictEqual(kills, 1, 'direct-child kill should exist only as the POSIX fallback');
  });

  test('killAgent reaps a real spawned agent (POSIX group kill)', async () => {
    if (process.platform === 'win32') {
      return; // taskkill path is source-guarded above; no cmd.exe here
    }
    const mgr = new AgentManager();
    const inst = mgr.spawnAgent('TestSleeper', {
      command: 'node',
      args: ['-e', 'setInterval(() => {}, 1000)'],
    });
    const pid = inst.process.pid!;
    assert.ok(pid > 0);

    const closed = new Promise<void>((resolve) => {
      mgr.on('agent-closed', () => resolve());
    });
    assert.strictEqual(mgr.killAgent(inst.id), true);
    await closed;

    // The group leader is gone; signalling the group must fail.
    assert.throws(() => process.kill(-pid, 0), /ESRCH/);
  });
});

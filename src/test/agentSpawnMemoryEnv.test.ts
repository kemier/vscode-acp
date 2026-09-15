/**
 * Spawn-time env handed to agents so they can read memory-only skills through a
 * structured tool call (ericli's manage_skills) instead of the raw curl described in
 * the injected <memory_skill_tools> footer.
 *
 * The curl is fragile on models whose tool calls are recovered from prose rather than
 * sent as structured tool_calls: a malformed call is dropped and the turn ends with no
 * answer. Executing the real AgentManager env resolution keeps that guarantee honest.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { AgentManager } from '../core/AgentManager';

type EnvProvider = (agentName: string) => Record<string, string>;

/**
 * Resolve the spawn env the way spawnAgent does, without spawning a process.
 * Mirrors the private resolveSpawnEnv contract: process.env < provider < config.env.
 *
 * The bridge vars are scrubbed from process.env for the duration of the call. Without
 * that this suite passes or fails depending on how the test process was started: an
 * agent spawned by this very feature inherits ERICLI_MEMORY_BRIDGE_URL, so `npm test`
 * run from inside such an agent saw the var already set and the "injects nothing" cases
 * failed. The assertions are about what the PROVIDER contributes, not about the ambient
 * environment.
 */
function resolveEnv(
  provider: EnvProvider | null,
  configEnv?: Record<string, string>,
  agentName = 'EricCLI',
): NodeJS.ProcessEnv {
  const scrubbed = ['ERICLI_MEMORY_BRIDGE_URL', 'ERICLI_MEMORY_AGENT_ID'];
  const saved = new Map<string, string | undefined>();
  for (const key of scrubbed) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    const mgr = new AgentManager();
    mgr.setAgentEnvProvider(provider);
    return (mgr as unknown as {
      resolveSpawnEnv: (n: string, c: { env?: Record<string, string> }) => NodeJS.ProcessEnv;
    }).resolveSpawnEnv(agentName, { env: configEnv });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

suite('agent spawn env — memory skill bridge', () => {
  test('injects the bridge URL and the resolved agent id', () => {
    const env = resolveEnv(() => ({
      ERICLI_MEMORY_BRIDGE_URL: 'http://127.0.0.1:8127',
      ERICLI_MEMORY_AGENT_ID: 'ericli',
    }));
    assert.strictEqual(env.ERICLI_MEMORY_BRIDGE_URL, 'http://127.0.0.1:8127');
    assert.strictEqual(env.ERICLI_MEMORY_AGENT_ID, 'ericli');
  });

  test('passes the agent name through so per-agent ids differ', () => {
    const seen: string[] = [];
    const provider: EnvProvider = (name) => {
      seen.push(name);
      return { ERICLI_MEMORY_AGENT_ID: name.toLowerCase() };
    };
    assert.strictEqual(resolveEnv(provider, undefined, 'EricCLI').ERICLI_MEMORY_AGENT_ID, 'ericcli');
    assert.strictEqual(resolveEnv(provider, undefined, 'Kiro CLI').ERICLI_MEMORY_AGENT_ID, 'kiro cli');
    assert.deepStrictEqual(seen, ['EricCLI', 'Kiro CLI']);
  });

  test('still inherits process.env', () => {
    const env = resolveEnv(() => ({ ERICLI_MEMORY_AGENT_ID: 'ericli' }));
    assert.strictEqual(env.PATH, process.env.PATH);
  });

  test('user config.env wins over the injected values', () => {
    const env = resolveEnv(
      () => ({ ERICLI_MEMORY_BRIDGE_URL: 'http://127.0.0.1:8127' }),
      { ERICLI_MEMORY_BRIDGE_URL: 'http://127.0.0.1:9999' },
    );
    assert.strictEqual(env.ERICLI_MEMORY_BRIDGE_URL, 'http://127.0.0.1:9999');
  });

  test('no provider leaves the env untouched', () => {
    const env = resolveEnv(null);
    assert.strictEqual(env.ERICLI_MEMORY_BRIDGE_URL, undefined);
    assert.strictEqual(env.ERICLI_MEMORY_AGENT_ID, undefined);
  });

  test('a provider that returns {} injects nothing (memory not configured)', () => {
    const env = resolveEnv(() => ({}));
    assert.strictEqual(env.ERICLI_MEMORY_BRIDGE_URL, undefined);
  });

  test('a throwing provider must not break spawning', () => {
    const env = resolveEnv(() => {
      throw new Error('bridge not started');
    });
    assert.strictEqual(env.ERICLI_MEMORY_BRIDGE_URL, undefined);
    // The rest of the environment must survive so the agent still starts.
    assert.strictEqual(env.PATH, process.env.PATH);
  });

  test('spawnAgent actually consumes the resolved env (no unused code path)', () => {
    // Guards against the env being computed but not passed to spawn — the bug that
    // would make this whole feature a no-op at runtime.
    const src = fs.readFileSync(path.join(__dirname, '../../src/core/AgentManager.ts'), 'utf8');
    assert.ok(
      src.includes('const spawnEnv = this.resolveSpawnEnv('),
      'spawnAgent should resolve the spawn env',
    );
    const uses = src.split('env: spawnEnv,').length - 1;
    assert.strictEqual(uses, 2, 'both win32 and unix spawn sites should use spawnEnv');
    assert.ok(
      !src.includes('env: { ...process.env, ...(config.env || {}) }'),
      'no spawn site should bypass resolveSpawnEnv',
    );
  });
});

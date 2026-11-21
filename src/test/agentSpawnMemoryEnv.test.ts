/**
 * Spawn-time env handed to agents so they can read memory-only skills through a
 * structured tool call (a native manage_skills tool) instead of the raw curl described in
 * the injected <memory_skill_tools> footer.
 *
 * The curl is fragile on models whose tool calls are recovered from prose rather than
 * sent as structured tool_calls: a malformed call is dropped and the turn ends with no
 * answer. Executing the real AgentManager env resolution keeps that guarantee honest.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { AgentManager, expandEnvReferences } from '../core/AgentManager';

type EnvProvider = (agentName: string) => Record<string, string>;

/**
 * Resolve the spawn env the way spawnAgent does, without spawning a process.
 * Mirrors the private resolveSpawnEnv contract: process.env < provider < config.env.
 *
 * The bridge vars are scrubbed from process.env for the duration of the call. Without
 * that this suite passes or fails depending on how the test process was started: an
 * agent spawned by this very feature inherits ACP_MEMORY_BRIDGE_URL, so `npm test`
 * run from inside such an agent saw the var already set and the "injects nothing" cases
 * failed. The assertions are about what the PROVIDER contributes, not about the ambient
 * environment.
 */
function resolveEnv(
  provider: EnvProvider | null,
  configEnv?: Record<string, string>,
  agentName = 'Example CLI',
): NodeJS.ProcessEnv {
  const scrubbed = ['ACP_MEMORY_BRIDGE_URL', 'ACP_MEMORY_AGENT_ID', 'MYAGENT_MEMORY_BRIDGE_URL'];
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
      ACP_MEMORY_BRIDGE_URL: 'http://127.0.0.1:8127',
      ACP_MEMORY_AGENT_ID: 'example-cli',
    }));
    assert.strictEqual(env.ACP_MEMORY_BRIDGE_URL, 'http://127.0.0.1:8127');
    assert.strictEqual(env.ACP_MEMORY_AGENT_ID, 'example-cli');
  });

  test('passes the agent name through so per-agent ids differ', () => {
    const seen: string[] = [];
    const provider: EnvProvider = (name) => {
      seen.push(name);
      return { ACP_MEMORY_AGENT_ID: name.toLowerCase() };
    };
    assert.strictEqual(resolveEnv(provider, undefined, 'Example CLI').ACP_MEMORY_AGENT_ID, 'example cli');
    assert.strictEqual(resolveEnv(provider, undefined, 'Kiro CLI').ACP_MEMORY_AGENT_ID, 'kiro cli');
    assert.deepStrictEqual(seen, ['Example CLI', 'Kiro CLI']);
  });

  test('still inherits process.env', () => {
    const env = resolveEnv(() => ({ ACP_MEMORY_AGENT_ID: 'example-cli' }));
    assert.strictEqual(env.PATH, process.env.PATH);
  });

  test('user config.env wins over the injected values', () => {
    const env = resolveEnv(
      () => ({ ACP_MEMORY_BRIDGE_URL: 'http://127.0.0.1:8127' }),
      { ACP_MEMORY_BRIDGE_URL: 'http://127.0.0.1:9999' },
    );
    assert.strictEqual(env.ACP_MEMORY_BRIDGE_URL, 'http://127.0.0.1:9999');
  });

  test('no provider leaves the env untouched', () => {
    const env = resolveEnv(null);
    assert.strictEqual(env.ACP_MEMORY_BRIDGE_URL, undefined);
    assert.strictEqual(env.ACP_MEMORY_AGENT_ID, undefined);
  });

  test('a provider that returns {} injects nothing (memory not configured)', () => {
    const env = resolveEnv(() => ({}));
    assert.strictEqual(env.ACP_MEMORY_BRIDGE_URL, undefined);
  });

  test('a throwing provider must not break spawning', () => {
    const env = resolveEnv(() => {
      throw new Error('bridge not started');
    });
    assert.strictEqual(env.ACP_MEMORY_BRIDGE_URL, undefined);
    // The rest of the environment must survive so the agent still starts.
    assert.strictEqual(env.PATH, process.env.PATH);
  });

  test('config.env can re-export an injected value under the name an agent reads', () => {
    // An agent that looks for its own variable name maps it in acp.agents — the
    // extension itself names no agent.
    const env = resolveEnv(
      () => ({ ACP_MEMORY_BRIDGE_URL: 'http://127.0.0.1:8127', ACP_MEMORY_AGENT_ID: 'example-cli' }),
      { MYAGENT_MEMORY_BRIDGE_URL: '${env:ACP_MEMORY_BRIDGE_URL}' },
    );
    assert.strictEqual(env.MYAGENT_MEMORY_BRIDGE_URL, 'http://127.0.0.1:8127');
    assert.strictEqual(env.ACP_MEMORY_BRIDGE_URL, 'http://127.0.0.1:8127');
  });

  test('a reference that does not resolve leaves the entry out', () => {
    // Memory off -> nothing injected -> the alias must not reach the agent as a
    // literal "${env:...}" or an empty string.
    const env = resolveEnv(() => ({}), { MYAGENT_MEMORY_BRIDGE_URL: '${env:ACP_MEMORY_BRIDGE_URL}' });
    assert.strictEqual(env.MYAGENT_MEMORY_BRIDGE_URL, undefined);
  });

  test('expandEnvReferences: text around references, plain values, empty and unset', () => {
    const base = { HOME: '/home/dev', EMPTY: '' };
    assert.deepStrictEqual(
      expandEnvReferences(
        {
          BIN: '${env:HOME}/bin',
          PLAIN: 'value with $HOME and {braces}',
          GONE: '${env:NOT_SET_ANYWHERE}',
          BLANK: '${env:EMPTY}',
        },
        base,
      ),
      { BIN: '/home/dev/bin', PLAIN: 'value with $HOME and {braces}' },
    );
  });

  test('the extension injects the neutral variable names', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/extension.ts'), 'utf8');
    assert.ok(src.includes('ACP_MEMORY_BRIDGE_URL: baseUrl,'));
    assert.ok(src.includes('ACP_MEMORY_AGENT_ID: resolveMemoryAgentId(agentName, settings.agentIdMap),'));
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

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { SharedMemoryProvider } from '../core/memory/SharedMemoryProvider';

/**
 * A subagent's findings must be persistable, and off until asked for.
 *
 * Nothing carried subagent work into memory. Its conversation never leaves
 * ericli's process, its progress is deliberately not streamed as
 * agent_thought_chunk, and per-turn capture records only the main assistant text
 * plus tool-call TITLES — verified in the live log, which shows a turn with 84
 * tool calls producing exactly 2 L0 messages:
 *
 *   Memory capture: 2 msg(s) -> total=2
 *   Skill conversation-add: 86 msg(s) sent (84 tool call(s))
 *
 * So findings never became L0 and could never be promoted to L1/L2/L3 or become
 * a skill. Five parallel subagents produced nothing recallable.
 *
 * Three constraints come from the memory core itself
 * (TencentDB-Agent-Memory-feat, feat/local-memory-deploy):
 *   - role is strictly "user" | "assistant"; ingest skips anything else, so
 *     provenance must live in the CONTENT;
 *   - recall is scoped by isolation(agentId), so a finding filed under a
 *     synthetic agent id would be stored and never surfaced;
 *   - L1 extraction reads `[id] [role] [timestamp]: content`, so a content-level
 *     marker is what lets it attribute the memory.
 */

const SRC = path.resolve(__dirname, '../..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

suite('subagent findings capture', () => {
  const provider = read('src/core/memory/SharedMemoryProvider.ts');

  test('the capture is gated by its own setting, separate from captureEnabled', () => {
    const at = provider.indexOf('async captureSubagentFindings(');
    assert.ok(at > 0, 'captureSubagentFindings not found');
    const body = provider.slice(at, provider.indexOf('\n  }', at));
    assert.ok(body.includes('!settings.captureEnabled'), 'must respect the master capture switch');
    assert.ok(body.includes('!settings.captureSubagentFindings'), 'must have its own gate');
  });

  test('the setting defaults OFF', () => {
    // `=== true`, not `!== false`: an absent setting must write nothing into
    // shared memory. A wrong memory is hard to undo once L1/L2/L3 absorb it.
    const cfg = read('src/core/memory/MemoryConfig.ts');
    assert.ok(
      /captureSubagentFindings:\s*cfg\.get<boolean>\('memory\.captureSubagentFindings'\)\s*===\s*true/.test(cfg),
      'must default to off',
    );
    const pkg = JSON.parse(read('package.json'));
    const prop = pkg.contributes.configuration.properties['acp.memory.captureSubagentFindings'];
    assert.ok(prop, 'setting missing from package.json');
    assert.strictEqual(prop.default, false, 'package.json default must be false');
    assert.strictEqual(prop.type, 'boolean');
  });

  test('it is filed under the PARENT agent id, so it can be recalled', () => {
    // Recall is scoped by isolation(agentId). A synthetic id would store the
    // finding and then hide it from the session that asked for it.
    const at = provider.indexOf('async captureSubagentFindings(');
    const body = provider.slice(at, provider.indexOf('\n  }', at));
    assert.ok(body.includes('resolveMemoryAgentId(agentName, settings.agentIdMap)'), 'not the parent identity');
    assert.ok(body.includes('this.isolation(settings, memoryAgentId, sessionId)'), 'isolation not applied');
    const wiring = read('src/core/SessionManager.ts');
    const wat = wiring.indexOf('connInfo.onEricliSubagentFindings');
    assert.ok(wat > 0, 'notification not wired');
    const wbody = wiring.slice(wat, wiring.indexOf('};', wat));
    assert.ok(
      wbody.includes('captureSubagentFindings(targetSession, agentName,'),
      'must pass the parent agentName through',
    );
  });

  test('the role is assistant, because the core accepts nothing else', () => {
    const at = provider.indexOf('async captureSubagentFindings(');
    const body = provider.slice(at, provider.indexOf('\n  }', at));
    assert.ok(body.includes("role: 'assistant'"), 'must use an accepted role');
    // Provenance therefore has to be in the content.
    assert.ok(body.includes('[subagent ${who}'), 'content carries no provenance marker');
    assert.ok(body.includes('delegated task:'), 'the task must travel with the finding');
  });

  test('content goes through the same hygiene as every other capture', () => {
    const at = provider.indexOf('async captureSubagentFindings(');
    const body = provider.slice(at, provider.indexOf('\n  }', at));
    for (const fn of ['sanitizeMemoryText', 'stripCodeBlocks', 'truncateForCapture', 'shouldCaptureL0']) {
      assert.ok(body.includes(fn), `${fn} not applied`);
    }
  });

  test('a failure is captured too, with its reason', () => {
    const at = provider.indexOf('async captureSubagentFindings(');
    const body = provider.slice(at, provider.indexOf('\n  }', at));
    assert.ok(body.includes('finding.error'), 'a failed subagent is dropped');
    assert.ok(body.includes('Failed:'), 'the reason is not recorded');
  });

  test('caveats that weaken an answer are recorded', () => {
    const at = provider.indexOf('async captureSubagentFindings(');
    const body = provider.slice(at, provider.indexOf('\n  }', at));
    assert.ok(body.includes('compacted its own context'), 'compaction caveat missing');
    assert.ok(body.includes('could not load skill(s)'), 'unresolved-skill caveat missing');
  });

  test('it also feeds skill extraction, which today gets titles only', () => {
    const at = provider.indexOf('async captureSubagentFindings(');
    const body = provider.slice(at, provider.indexOf('\n  }', at));
    assert.ok(body.includes('skillConversationAdd'), 'skill feed not enriched');
    // Non-fatal, exactly like the compaction-summary path.
    assert.ok(/catch \(skillErr\)/.test(body), 'skill failure must not break memory capture');
  });

  test('capture never throws into the caller', () => {
    const at = provider.indexOf('async captureSubagentFindings(');
    const body = provider.slice(at, provider.indexOf('\n  }', at));
    assert.ok(body.includes("logError('Memory capture (subagent findings) failed'"), 'no outer catch');
    const wiring = read('src/core/SessionManager.ts');
    const wat = wiring.indexOf('connInfo.onEricliSubagentFindings');
    const wbody = wiring.slice(wat, wiring.indexOf('};', wat));
    assert.ok(wbody.includes('.catch('), 'the wiring must swallow rejections');
  });

  test('a finding with no session is dropped rather than misfiled', () => {
    // Guessing the active session would attach it to whatever the user happens
    // to be looking at.
    const wiring = read('src/core/SessionManager.ts');
    const wat = wiring.indexOf('connInfo.onEricliSubagentFindings');
    const wbody = wiring.slice(wat, wiring.indexOf('};', wat));
    assert.ok(wbody.includes('if (!targetSession)'), 'missing session not guarded');
  });

  test('the notification is routed and consumed', () => {
    const conn = read('src/core/ConnectionManager.ts');
    assert.ok(conn.includes("method === '_ericli/subagent/findings'"), 'not routed');
    const at = conn.indexOf("method === '_ericli/subagent/findings'");
    const body = conn.slice(at, at + 700);
    assert.ok(body.includes('return; // consume'), 'must be consumed like the other _ericli methods');
    assert.ok(conn.includes('onEricliSubagentFindings?:'), 'callback not declared');
  });
});

/**
 * The same behaviour, executed rather than read: the checks above pin structure,
 * these drive the real method with the settings and client stubbed at their
 * private seams.
 */
suite('subagent findings capture (executed)', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */

  function harness(overrides: Record<string, unknown>) {
    const sent: any[] = [];
    // The constructor subscribes to session updates; a stub listener sink is all
    // it needs, and keeps this a unit test of the capture itself.
    const p: any = new SharedMemoryProvider({ addListener: () => {}, removeListener: () => {} } as any);
    p.getSettings = () => ({
      enabled: true,
      endpoint: 'http://127.0.0.1:1/x',
      apiKey: 'k',
      serviceId: 's',
      // isMemoryConfigured requires the tenancy triple too.
      teamId: 'default',
      userId: 'tester',
      captureEnabled: true,
      captureSubagentFindings: false,
      agentIdMap: {},
      timeoutMs: 1000,
      ...overrides,
    });
    p.getClient = () => ({
      addConversation: async (_iso: any, payload: any) => {
        sent.push(payload);
        return { total_count: sent.length };
      },
      skillConversationAdd: async () => ({}),
    });
    return { p, sent };
  }

  const finding = {
    id: 'e97c64a7',
    type: 'explore',
    task: 'find every caller of foo()',
    status: 'completed',
    summary: 'foo() is called from bar.ts:12 and baz.ts:88',
  };

  test('writes nothing while the setting is off', async () => {
    const { p, sent } = harness({});
    await p.captureSubagentFindings('sess-1', 'EricCLI', finding);
    assert.deepStrictEqual(sent, [], 'a default install must not write to shared memory');
  });

  test('writes one attributed assistant message when enabled', async () => {
    const { p, sent } = harness({ captureSubagentFindings: true });
    await p.captureSubagentFindings('sess-1', 'EricCLI', finding);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].sessionId, 'sess-1');
    assert.strictEqual(sent[0].messages.length, 1);
    const msg = sent[0].messages[0];
    assert.strictEqual(msg.role, 'assistant', 'the core accepts no other role');
    // Provenance and the question must both be recoverable from the content,
    // because that is all L1 extraction gets to read.
    assert.ok(msg.content.includes('[subagent explore-e97c64a7, completed]'), msg.content);
    assert.ok(msg.content.includes('find every caller of foo()'), 'task missing');
    assert.ok(msg.content.includes('bar.ts:12'), 'finding missing');
  });

  test('the master capture switch still overrides it', async () => {
    const { p, sent } = harness({ captureSubagentFindings: true, captureEnabled: false });
    await p.captureSubagentFindings('sess-1', 'EricCLI', finding);
    assert.deepStrictEqual(sent, []);
  });

  test('a failed subagent is recorded with its reason and partial work', async () => {
    const { p, sent } = harness({ captureSubagentFindings: true });
    await p.captureSubagentFindings('sess-1', 'EricCLI', {
      ...finding,
      status: 'failed',
      summary: 'got through 3 of 40 files',
      error: 'Timeout after 3600000ms',
    });
    assert.strictEqual(sent.length, 1);
    const content = sent[0].messages[0].content;
    assert.ok(content.includes('3 of 40'), 'partial work dropped');
    assert.ok(content.includes('Failed: Timeout after 3600000ms'), 'reason dropped');
  });

  test('caveats ride along', async () => {
    const { p, sent } = harness({ captureSubagentFindings: true });
    await p.captureSubagentFindings('sess-1', 'EricCLI', {
      ...finding,
      compactions: 2,
      unresolvedSkills: ['gerrit-skill', 'jira-skill'],
    });
    const content = sent[0].messages[0].content;
    assert.ok(content.includes('compacted its own context 2x'), content);
    assert.ok(content.includes('gerrit-skill, jira-skill'), content);
  });

  test('an empty finding is not written', async () => {
    const { p, sent } = harness({ captureSubagentFindings: true });
    await p.captureSubagentFindings('sess-1', 'EricCLI', { id: 'x', type: 'explore' });
    assert.deepStrictEqual(sent, [], 'nothing to remember must write nothing');
  });

  test('a client failure does not throw into the caller', async () => {
    const { p } = harness({ captureSubagentFindings: true });
    p.getClient = () => ({
      addConversation: async () => {
        throw new Error('gateway down');
      },
      skillConversationAdd: async () => ({}),
    });
    await p.captureSubagentFindings('sess-1', 'EricCLI', finding);
  });
});

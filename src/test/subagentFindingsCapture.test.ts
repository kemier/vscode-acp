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
    const wat = wiring.indexOf('connInfo.onSubagentFindings');
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
    const wat = wiring.indexOf('connInfo.onSubagentFindings');
    const wbody = wiring.slice(wat, wiring.indexOf('};', wat));
    assert.ok(wbody.includes('.catch('), 'the wiring must swallow rejections');
  });

  test('a finding with no session is dropped rather than misfiled', () => {
    // Guessing the active session would attach it to whatever the user happens
    // to be looking at.
    const wiring = read('src/core/SessionManager.ts');
    const wat = wiring.indexOf('connInfo.onSubagentFindings');
    const wbody = wiring.slice(wat, wiring.indexOf('};', wat));
    assert.ok(wbody.includes('if (!targetSession)'), 'missing session not guarded');
  });

  test('the notification is routed and consumed', () => {
    const conn = read('src/core/ConnectionManager.ts');
    // Adapter-neutral name, plus the original so an agent binary older than this
    // extension keeps working instead of silently dropping its findings.
    assert.ok(conn.includes("method === '_acp/subagent/findings'"), 'neutral name not routed');
    assert.ok(conn.includes("method === '_ericli/subagent/findings'"), 'legacy name not accepted');
    const at = conn.indexOf("method === '_acp/subagent/findings'");
    // Bounded by the next branch rather than a character count: the condition
    // became multi-line when the second name was accepted, and a 700-char window
    // stopped short of the statement being asserted on.
    const body = conn.slice(at, conn.indexOf('} else if', at + 10));
    assert.ok(body.includes('return; // consume'), 'must be consumed like the other extension methods');
    assert.ok(conn.includes('onSubagentFindings?:'), 'callback not declared');
  });
});

/**
 * The same behaviour, executed rather than read: the checks above pin structure,
 * these drive the real method with the settings and client stubbed at their
 * private seams.
 */
suite('subagent findings capture (executed)', () => {
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

/**
 * Adapters that report the QUESTION but not the ANSWER.
 *
 * cursor's `cursor/task` carries prompt/description/subagentType, but its outcome
 * is only completed / rejected / cancelled — no summary. codex-acp's collab tool
 * call carries `prompt` in rawInput, and its subAgentActivity updates are markers
 * with no content. Both are worth recording as "asked", never as "found".
 *
 * kiro-cli cannot participate: `_kiro.dev/subagent/list_update` is live status
 * only (sessionName, status.type, sessionId) and kiro ships as a binary, so the
 * payload cannot be enriched here. pi-acp has no subagents at all.
 */
suite('delegated-task capture (adapters with no result)', () => {
  function harness(overrides: Record<string, unknown>) {
    const sent: any[] = [];
    const p: any = new SharedMemoryProvider({ addListener: () => {}, removeListener: () => {} } as any);
    p.getSettings = () => ({
      enabled: true, endpoint: 'http://127.0.0.1:1/x', apiKey: 'k', serviceId: 's',
      teamId: 'default', userId: 'tester', captureEnabled: true,
      captureSubagentFindings: false, agentIdMap: {}, timeoutMs: 1000, ...overrides,
    });
    p.getClient = () => ({
      addConversation: async (_iso: any, payload: any) => { sent.push(payload); return { total_count: sent.length }; },
      skillConversationAdd: async () => ({}),
    });
    return { p, sent };
  }

  const delegation = { id: 'call_126', type: 'explore', label: 'Explore codebase',
    task: 'Find where authentication is handled and report the file paths.' };

  test('is gated by the same setting', async () => {
    const { p, sent } = harness({});
    await p.captureDelegatedTask('s1', 'Cursor', delegation);
    assert.deepStrictEqual(sent, []);
  });

  test('records the task and says the result is missing', async () => {
    const { p, sent } = harness({ captureSubagentFindings: true });
    await p.captureDelegatedTask('s1', 'Cursor', delegation);
    assert.strictEqual(sent.length, 1);
    const content = sent[0].messages[0].content;
    assert.ok(content.includes('Explore codebase'), content);
    assert.ok(content.includes('Find where authentication is handled'), content);
    // Must NOT imply an answer it never received — L1 would extract it as fact.
    assert.ok(content.includes('result not reported'), content);
  });

  test('the same delegation is not stored twice', async () => {
    // codex re-sends its collab tool call as tool_call_update with identical
    // rawInput, so the naive path would double-write.
    const { p, sent } = harness({ captureSubagentFindings: true });
    await p.captureDelegatedTask('s1', 'Codex CLI', delegation);
    await p.captureDelegatedTask('s1', 'Codex CLI', delegation);
    assert.strictEqual(sent.length, 1, 'duplicate delegation was stored');
  });

  test('a delegation with no task is not written', async () => {
    const { p, sent } = harness({ captureSubagentFindings: true });
    await p.captureDelegatedTask('s1', 'Cursor', { id: 'x', type: 'explore' });
    assert.deepStrictEqual(sent, []);
  });

  test('codex collab tool calls are detected by their _meta, not by title', async () => {
    const src = fs.readFileSync(path.join(SRC, 'src/core/memory/SharedMemoryProvider.ts'), 'utf8');
    // Terminated, so a renamed property (collaborationX) cannot substring-match.
    assert.ok(src.includes('?.codex?.collaboration;'), 'codex collab discriminator missing');
    assert.ok(src.includes('if (collab && prompt.trim())'), 'collab hook not reached');
    assert.ok(src.includes("typeof data.rawInput?.prompt === 'string'"), 'prompt not read from rawInput');
  });

  test('cursor delegations are filed against a session belonging to that agent', async () => {
    // cursor/task carries no sessionId, so the active session is used — but only
    // when it is this agent's, or the finding lands under the wrong identity.
    const wiring = fs.readFileSync(path.join(SRC, 'src/core/SessionManager.ts'), 'utf8');
    const at = wiring.indexOf("if (method === 'cursor/task')");
    assert.ok(at > 0, 'cursor/task not handled');
    const body = wiring.slice(at, wiring.indexOf('return true;', at));
    assert.ok(body.includes('captureDelegatedTask('), 'not captured');
    assert.ok(body.includes('?.agentName === agentName'), 'session ownership not checked');
  });
});

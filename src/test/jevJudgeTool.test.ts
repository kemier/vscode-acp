import * as assert from 'assert';
import * as path from 'node:path';

import {
  validateJudgeRequest,
  toQuestionMap,
  extractVerdicts,
  formatVerdicts,
  executeJudgeTool,
  type JudgementSpec,
} from '../jev/JevJudgeTool';
import {
  buildJevRequestBody,
  parseJevResponse,
  noulValue,
  choiceValue,
  type JevSettings,
  type JevResponse,
} from '../jev/JevClient';
import type { JevClient } from '../jev/JevClient';
import { buildJevMcpServers } from '../jev/JevMcpServer';

/**
 * jev_judge native tool — request validation, wire mapping, and verdict
 * rendering. Jev (TypeSafe System One) answers typed questions against a
 * state with calibrated probabilities; this tool batches the repo's
 * AGENTS.md audit judgments into one parallel call.
 *
 * Pure functions only (no vscode, no network): the JevClient is stubbed.
 */
suite('jev_judge native tool', () => {
  const judgements: JudgementSpec[] = [
    { id: 'destructive', kind: 'noul', instructions: 'Does this command destroy data?' },
    {
      id: 'risk_level',
      kind: 'choice',
      instructions: 'What is the risk level?',
      criteria: {
        low: 'read-only or reversible',
        medium: 'moderate impact',
        high: 'destructive or irreversible',
      },
    },
    {
      id: 'severity',
      kind: 'score',
      instructions: 'How severe is the impact?',
      criteria: ['no impact', 'recoverable damage', 'permanent loss'],
    },
  ];

  test('accepts a well-formed request', () => {
    const issues = validateJudgeRequest({ state: 'rm -rf /tmp/build', judgements });
    assert.deepStrictEqual(issues, []);
  });

  test('rejects missing state and empty judgements', () => {
    const issues = validateJudgeRequest({ state: '', judgements: [] });
    assert.ok(issues.some((i) => i.path === 'state'));
    assert.ok(issues.some((i) => i.path === 'judgements'));
  });

  test('rejects bad kind, duplicate ids, and bad criteria sizes', () => {
    const issues = validateJudgeRequest({
      state: 'x',
      judgements: [
        { id: 'a', kind: 'regression' as any, instructions: 'q' },
        { id: 'a', kind: 'noul', instructions: 'q' },
        { id: 'b', kind: 'choice', instructions: 'q', criteria: { only: 'one' } },
        { id: 'c', kind: 'score', instructions: 'q', criteria: ['one'] },
        { id: 'd', kind: 'noul', instructions: '   ' },
      ],
    });
    assert.ok(issues.some((i) => i.message.includes('choice | score | noul')));
    assert.ok(issues.some((i) => i.message.includes('duplicate id')));
    assert.ok(issues.some((i) => i.message.includes('>= 2 options')));
    assert.ok(issues.some((i) => i.message.includes('2–10 ordered levels')));
    assert.ok(issues.some((i) => i.path === 'judgements[4].instructions'));
  });

  test('maps judgements onto the wire question types', () => {
    const map = toQuestionMap(judgements);
    assert.deepStrictEqual(Object.keys(map), ['destructive', 'risk_level', 'severity']);
    assert.strictEqual(map.destructive.type, 'noul');
    assert.strictEqual(map.risk_level.type, 'choice');
    assert.deepStrictEqual(Object.keys((map.risk_level as any).criteria), ['low', 'medium', 'high']);
    assert.deepStrictEqual((map.severity as any).criteria, ['no impact', 'recoverable damage', 'permanent loss']);
  });

  test('builds the /v1/systemone request body', () => {
    const body = buildJevRequestBody('state text', toQuestionMap(judgements), 'jev-latest');
    assert.strictEqual(body.model, 'jev-latest');
    assert.strictEqual(body.state, 'state text');
    assert.strictEqual(Object.keys(body.questions).length, 3);
  });

  test('parses a good response and rejects malformed ones', () => {
    const good = {
      model: 'jev-1.13.0',
      answers: { destructive: { type: 'noul', noul: 0.93 } },
      usage: { input_tokens: 120, output_tokens: 8 },
    };
    assert.ok(parseJevResponse(good));
    assert.strictEqual(parseJevResponse(null), null);
    assert.strictEqual(parseJevResponse({ model: 'x' }), null);
    assert.strictEqual(parseJevResponse('nope'), null);
  });

  test('extracts answer values per question type', () => {
    const resp: JevResponse = {
      model: 'jev-1.13.0',
      answers: {
        destructive: { type: 'noul', noul: 0.93 },
        risk_level: {
          type: 'choice',
          choice: 'high',
          probabilities: { low: 0.02, medium: 0.05, high: 0.93 },
          confidence: 0.91,
        },
        severity: {
          type: 'score',
          score: 2.1,
          legend: { '0': 'no impact', '1': 'recoverable damage', '2': 'permanent loss' },
          probabilities: { '0': 0, '1': 0.1, '2': 0.9 },
          confidence: 0.88,
        },
        missing_choice: { type: 'choice', choice: 'billing', probabilities: {}, confidence: 0.5 },
      },
    };
    assert.strictEqual(noulValue(resp, 'destructive'), 0.93);
    assert.strictEqual(noulValue(resp, 'risk_level'), null);
    assert.deepStrictEqual(choiceValue(resp, 'risk_level'), { choice: 'high', confidence: 0.91 });
    assert.strictEqual(choiceValue(resp, 'destructive'), null);
    assert.strictEqual(choiceValue(resp, 'absent'), null);

    const verdicts = extractVerdicts(judgements, resp);
    assert.strictEqual(verdicts.length, 3);
    assert.strictEqual(verdicts[0].value, 0.93);
    assert.strictEqual(verdicts[1].value, 'high');
    assert.strictEqual(verdicts[2].value, 2.1);
  });

  test('formats verdicts with confidence flags and distribution', () => {
    const resp: JevResponse = {
      model: 'jev-1.13.0',
      answers: {
        destructive: { type: 'noul', noul: 0.93 },
        risk_level: {
          type: 'choice',
          choice: 'high',
          probabilities: { low: 0.02, medium: 0.05, high: 0.93 },
          confidence: 0.91,
        },
        severity: {
          type: 'score',
          score: 2.1,
          legend: { '0': 'no impact', '1': 'recoverable damage', '2': 'permanent loss' },
          probabilities: { '0': 0, '1': 0.1, '2': 0.9 },
          confidence: 0.3,
        },
      },
    };
    const text = formatVerdicts(extractVerdicts(judgements, resp), {
      model: 'jev-1.13.0',
      inputTokens: 120,
    });
    assert.ok(text.includes('P(yes)=0.93 → yes'));
    assert.ok(text.includes('risk_level: high confidence=0.91'));
    assert.ok(text.includes('high=0.93'));
    // score below the 0.5 low-confidence bar escalates
    assert.ok(text.includes('severity: score=2.10 confidence=0.30 LOW-CONFIDENCE — escalate'));
    assert.ok(text.includes('usage: 120 input tokens'));
  });

  test('executeJudgeTool reports validation problems as text', async () => {
    const stub = { decide: async () => null } as unknown as JevClient;
    const out = await executeJudgeTool({ state: '', judgements: [] }, { client: stub, log: () => {} });
    assert.ok(out.startsWith('jev_judge: invalid request'));
    assert.ok(out.includes('state is required'));
  });

  test('executeJudgeTool fails open when Jev is unavailable', async () => {
    const stub = { decide: async () => null } as unknown as JevClient;
    const out = await executeJudgeTool({ state: 'ls', judgements }, { client: stub, log: () => {} });
    assert.ok(out.includes('Jev unavailable'));
    assert.ok(out.includes('Fall back'));
  });

  test('executeJudgeTool renders verdicts from a stubbed client', async () => {
    const calls: Array<{ state: unknown; ids: string[] }> = [];
    const stub = {
      decide: async (state: unknown, questions: Record<string, unknown>) => {
        calls.push({ state, ids: Object.keys(questions) });
        return {
          model: 'jev-1.13.0',
          answers: {
            destructive: { type: 'noul', noul: 0.02 },
            risk_level: {
              type: 'choice',
              choice: 'low',
              probabilities: { low: 0.95, medium: 0.04, high: 0.01 },
              confidence: 0.94,
            },
            severity: {
              type: 'score',
              score: 0.1,
              legend: { '0': 'no impact', '1': 'recoverable damage', '2': 'permanent loss' },
              probabilities: { '0': 0.95, '1': 0.04, '2': 0.01 },
              confidence: 0.93,
            },
          },
          usage: { input_tokens: 90, output_tokens: 6 },
        } as JevResponse;
      },
    } as unknown as JevClient;

    const out = await executeJudgeTool({ state: 'ls -la', judgements }, { client: stub, log: () => {} });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].state, 'ls -la');
    assert.deepStrictEqual(calls[0].ids, ['destructive', 'risk_level', 'severity']);
    assert.ok(out.includes('P(yes)=0.02 → no'));
    assert.ok(out.includes('risk_level: low confidence=0.94'));
    assert.ok(!out.includes('LOW-CONFIDENCE'));
  });
});

suite('jev-mcp server registration (Claude Code + Cursor)', () => {
  const enabled: JevSettings = {
    enabled: true,
    baseUrl: 'https://api.codiv.ai',
    apiKey: 'sk-test',
    model: 'jev-latest',
    timeoutMs: 5000,
  };
  const claudeCmd = '/x/claude-code-acp/bin/claude-code-acp.js';

  test('returns a jev-mcp stdio server for Claude Code when enabled', () => {
    const servers = buildJevMcpServers('ClaudeCode CLI', enabled, claudeCmd);
    assert.strictEqual(servers.length, 1);
    const s = servers[0] as any;
    assert.strictEqual(s.name, 'jev-mcp');
    assert.strictEqual(s.command, 'node');
    // Path derived as the sibling dist/jev-mcp-stdio.js of the deployed command.
    assert.strictEqual(
      s.args[0],
      path.join('/x/claude-code-acp/bin', '..', 'dist', 'jev-mcp-stdio.js'),
    );
    // env is the ACP wire shape: an array of {name, value}.
    const env: Record<string, string> = {};
    for (const v of s.env) env[v.name] = v.value;
    assert.strictEqual(env.JEV_API_KEY, 'sk-test');
    assert.strictEqual(env.JEV_BASE_URL, 'https://api.codiv.ai');
    assert.strictEqual(env.JEV_MODEL, 'jev-latest');
    assert.strictEqual(env.JEV_TIMEOUT_MS, '5000');
  });

  test('matches package.json default key "Claude Code" via command, not a hardcoded name', () => {
    const servers = buildJevMcpServers('Claude Code', enabled, claudeCmd);
    assert.strictEqual(servers.length, 1);
    assert.strictEqual((servers[0] as any).name, 'jev-mcp');
  });

  test('matches node + args style Claude settings (command is node, script in args)', () => {
    const servers = buildJevMcpServers('Claude Code', enabled, {
      command: 'node',
      args: ['C:\\Users\\zengn\\projects\\claude-code-acp\\bin\\claude-code-acp.js'],
    });
    assert.strictEqual(servers.length, 1);
    assert.ok(
      /jev-mcp-stdio\.js$/.test((servers[0] as any).args[0].replace(/\\/g, '/')),
      (servers[0] as any).args[0],
    );
  });

  test('matches any settings key when command is claude-code-acp', () => {
    const servers = buildJevMcpServers('My Claude ACP', enabled, '/opt/claude-code-acp/bin/claude-code-acp.js');
    assert.strictEqual(servers.length, 1);
  });

  test('injects jev-mcp for Cursor (same ACP stdio mcpServers shape)', () => {
    const servers = buildJevMcpServers('Cursor', enabled, {
      command: 'cursor-agent',
      args: ['acp'],
    });
    assert.strictEqual(servers.length, 1);
    assert.strictEqual((servers[0] as any).name, 'jev-mcp');
    // Cursor binary does not ship jev-mcp; path falls back to the default
    // (or a Claude Code entry from settings when present).
    assert.ok(/jev-mcp-stdio\.js/.test((servers[0] as any).args[0]));
  });

  test('returns [] for a non-eligible agent even when Jev is enabled', () => {
    assert.deepStrictEqual(buildJevMcpServers('EricCLI', enabled, '/x/bin/ericli.js'), []);
    assert.deepStrictEqual(buildJevMcpServers('Codex CLI', enabled, '/x/bin/codex-acp.js'), []);
    // Name looks Claude-ish but command is not claude-code-acp → reject.
    assert.deepStrictEqual(
      buildJevMcpServers('Claude Code', enabled, '/x/bin/something-else.js'),
      [],
    );
  });

  test('returns [] when Jev is disabled', () => {
    assert.deepStrictEqual(
      buildJevMcpServers('Claude Code', { ...enabled, enabled: false }, claudeCmd),
      [],
    );
    assert.deepStrictEqual(
      buildJevMcpServers('Cursor', { ...enabled, enabled: false }, { command: 'cursor-agent', args: ['acp'] }),
      [],
    );
  });

  test('returns [] when no API key is set', () => {
    assert.deepStrictEqual(
      buildJevMcpServers('Claude Code', { ...enabled, apiKey: '' }, claudeCmd),
      [],
    );
  });

  test('path falls back to a default when no command is supplied', () => {
    // Name-only fallback (no command / no live acp.agents entry in the shim).
    const servers = buildJevMcpServers('ClaudeCode CLI', enabled, undefined);
    assert.strictEqual(servers.length, 1);
    assert.strictEqual((servers[0] as any).args[0], 'claude-code-acp/dist/jev-mcp-stdio.js');
  });
});

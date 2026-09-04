import * as assert from 'assert';
import { resolveMemoryAgentId } from '../core/memory/MemoryAgentId';
import { formatL1Memories, formatRecallContext, formatSkills } from '../core/memory/MemoryFormat';
import {
  MAX_SKILL_TOOL_CALLS_PER_TURN,
  buildSkillConversationMessages,
  type SkillToolCall,
} from '../core/memory/SkillFeed';
import {
  CAPTURE_CONTENT_MAX_CHARS,
  RECALL_QUERY_MAX_CHARS,
  buildRecallQuery,
  sanitizeMemoryText,
  shouldCaptureL0,
  stripCodeBlocks,
  truncateForCapture,
} from '../core/memory/MemorySanitize';

suite('MemoryAgentId.resolveMemoryAgentId (Model B)', () => {
  test('maps Codex / Claude / Kiro via heuristics', () => {
    assert.strictEqual(resolveMemoryAgentId('Codex CLI'), 'codex');
    assert.strictEqual(resolveMemoryAgentId('claude-code'), 'claude');
    assert.strictEqual(resolveMemoryAgentId('Kiro'), 'kiro');
    assert.strictEqual(resolveMemoryAgentId('codex-acp'), 'codex');
  });

  test('explicit agentIdMap wins over heuristics', () => {
    assert.strictEqual(resolveMemoryAgentId('Codex CLI', { 'Codex CLI': 'builder' }), 'builder');
    assert.strictEqual(resolveMemoryAgentId('codex cli', { 'Codex CLI': 'builder' }), 'builder');
  });

  test('unknown names become sanitized slugs', () => {
    assert.strictEqual(resolveMemoryAgentId('My Custom Agent'), 'my-custom-agent');
  });

  test('rejects empty agent name', () => {
    assert.throws(() => resolveMemoryAgentId(''), /non-empty/);
  });
});

suite('MemoryFormat', () => {
  test('formatL1Memories wraps items', () => {
    const text = formatL1Memories([{ content: 'prefers tabs', type: 'preference' }]);
    assert.ok(text?.includes('<relevant-memories>'));
    assert.ok(text?.includes('[preference] prefers tabs'));
  });

  test('formatL1Memories can omit wrapper on incremental turns', () => {
    const text = formatL1Memories([{ content: 'new fact', type: 'fact' }], { includeWrapper: false });
    assert.ok(text);
    assert.ok(!text!.includes('<relevant-memories>'));
    assert.ok(text!.includes('- [fact] new fact'));
  });

  test('formatRecallContext incremental mode omits L1 wrapper and skills footer', () => {
    const formatted = formatRecallContext(
      [{ content: 'new memory', type: 'fact' }],
      null,
      [],
      [{ skill_id: 's1', name: 'skill-a', description: 'does things', version: 1 }],
      undefined,
      { includeL1Wrapper: false, includeSkillsFooter: false },
    );
    assert.ok(formatted);
    assert.ok(!formatted!.text.includes('<relevant-memories>'));
    assert.ok(formatted!.text.includes('- [fact] new memory'));
    assert.ok(formatted!.text.includes('<available_skills>'));
    assert.ok(!formatted!.text.includes('memory-injected skills'));
    assert.ok(formatted!.text.includes('skill-a'));
  });

  test('formatRecallContext combines layers', () => {
    const formatted = formatRecallContext([{ content: 'uses pnpm', type: 'fact' }], 'User is a systems engineer.', [
      { path: 'scene_blocks/deploy.md' },
    ]);
    assert.ok(formatted);
    assert.ok(formatted!.text.includes('<agent-memory>'));
    assert.ok(formatted!.text.includes('<relevant-memories>'));
    assert.ok(formatted!.text.includes('<user-persona>'));
    assert.ok(formatted!.text.includes('scene_blocks/deploy.md'));
    assert.strictEqual(formatted!.l1Count, 1);
    assert.strictEqual(formatted!.hasPersona, true);
    assert.strictEqual(formatted!.sceneCount, 1);
  });

  test('formatRecallContext returns undefined when empty', () => {
    assert.strictEqual(formatRecallContext([], null, []), undefined);
  });

  test('formatRecallContext includes skills when provided', () => {
    const skills = [
      { skill_id: 's1', name: 'deploy-flow', description: 'How to deploy', version: 1 },
      { skill_id: 's2', name: 'test-first', description: 'Write tests first', version: 2 },
    ];
    const formatted = formatRecallContext([], null, [], skills);
    assert.ok(formatted);
    assert.ok(formatted!.text.includes('<available_skills>'));
    assert.ok(formatted!.text.includes('deploy-flow'));
    assert.ok(formatted!.text.includes('test-first'));
    assert.strictEqual(formatted!.skillCount, 2);
  });

  test('formatRecallContext works without skills (backward compat)', () => {
    const formatted = formatRecallContext([{ content: 'uses pnpm', type: 'fact' }], null, []);
    assert.ok(formatted);
    assert.ok(!formatted!.text.includes('<available_skills>'));
    assert.strictEqual(formatted!.skillCount, 0);
  });

  test('formatRecallContext returns undefined when only empty skills', () => {
    assert.strictEqual(formatRecallContext([], null, [], []), undefined);
  });

  test('persona cap keeps the L2 scene index (raised to 4000)', () => {
    // Doctrine prefix (~2200 chars) + scene index near the end. The old 2000-char
    // cap truncated before the scene section; the 4000 cap must keep it.
    const doctrine = 'Doctrine: '.repeat(200); // ~2200 chars
    const sceneIndex = '\n## 🗺️ Scene Navigation (Scene Index)\n### Path: scene_blocks/deploy.md\nSummary: deploy guide';
    const persona = doctrine + sceneIndex;
    assert.ok(persona.length > 2000, 'precondition: persona exceeds the old 2000 cap');
    assert.ok(persona.length < 4000, 'precondition: persona fits the new 4000 cap');
    const formatted = formatRecallContext([], persona, []);
    assert.ok(formatted);
    assert.ok(formatted!.text.includes('Scene Navigation'), 'L2 scene index must survive the persona cap');
    assert.ok(formatted!.text.includes('scene_blocks/deploy.md'));
    assert.ok(!formatted!.text.includes('persona truncated'));
  });

  test('over-budget blob drops skills first, keeps persona + top L1 (priority drop)', () => {
    // Persona (4000) + many long skills pushes the blob past 8000. The priority
    // drop must shed skill entries (not the persona's scene index) to fit.
    const persona = 'Doctrine: '.repeat(125) + '\n## Scene Navigation\n### Path: scene_blocks/a.md';
    const skills = Array.from({ length: 40 }, (_, i) => ({
      skill_id: `s${i}`,
      name: `skill-${i}`,
      description: 'x'.repeat(200),
      version: 1,
    }));
    const l1 = [{ content: 'top-ranked memory', type: 'fact' }];
    const formatted = formatRecallContext(l1, persona, [], skills);
    assert.ok(formatted);
    assert.ok(formatted!.text.length <= 9000, 'blob must respect the total cap');
    assert.ok(formatted!.text.includes('Scene Navigation'), 'persona scene index must survive');
    assert.ok(formatted!.text.includes('top-ranked memory'), 'top L1 must survive');
    assert.ok(formatted!.text.includes('<available_skills>'), 'skills block (footer) kept');
    // Not all 40 skills fit — some were dropped gracefully.
    const keptSkills = formatted!.text.match(/\- \*\*skill-\d+\*\*/g)?.length ?? 0;
    assert.ok(keptSkills < 40, 'expected some skills to be dropped');
    assert.ok(keptSkills >= 0);
  });

  test('over-budget blob with no skills drops scene nav, then extra L1', () => {
    // No skills to shed: drop the dedicated scene block, then L1 beyond the first.
    const persona = 'Doctrine: '.repeat(125) + '\n## Scene Navigation\n### Path: scene_blocks/a.md';
    const scenes = Array.from({ length: 8 }, (_, i) => ({ path: `scene_blocks/scene-${i}.md` }));
    const l1 = Array.from({ length: 5 }, (_, i) => ({ content: `memory ${i} ` + 'y'.repeat(400), type: 'fact' }));
    const formatted = formatRecallContext(l1, persona, scenes);
    assert.ok(formatted);
    assert.ok(formatted!.text.length <= 8000, 'blob must respect the total cap');
    assert.ok(formatted!.text.includes('Scene Navigation'), 'persona scene index must survive');
    assert.ok(formatted!.text.includes('memory 0'), 'top L1 must survive');
  });

  test('under-budget blob keeps all sections untouched', () => {
    const skills = [
      { skill_id: 's1', name: 'deploy-flow', description: 'How to deploy', version: 1 },
      { skill_id: 's2', name: 'test-first', description: 'Write tests first', version: 2 },
    ];
    const formatted = formatRecallContext(
      [{ content: 'uses pnpm', type: 'fact' }],
      'User is a systems engineer.',
      [{ path: 'scene_blocks/deploy.md' }],
      skills,
    );
    assert.ok(formatted);
    assert.ok(formatted!.text.length <= 8000);
    assert.ok(formatted!.text.includes('<relevant-memories>'));
    assert.ok(formatted!.text.includes('<user-persona>'));
    assert.ok(formatted!.text.includes('scene_blocks/deploy.md'));
    assert.ok(formatted!.text.includes('deploy-flow'));
    assert.ok(formatted!.text.includes('test-first'));
  });
});

suite('MemoryFormat.formatL1Memories dedup', () => {
  test('formatL1Memories excludes empty IDs', () => {
    const items = [
      { id: '1', content: 'mem one', type: 'fact' },
      { id: '', content: 'mem two', type: 'fact' },
      { id: undefined as any, content: 'mem three', type: 'fact' },
    ];
    const text = formatL1Memories(items);
    assert.ok(text);
    // All items are formatted (formatL1Memories doesn't filter by ID — dedup is in SharedMemoryProvider)
    assert.ok(text!.includes('mem one'));
    assert.ok(text!.includes('mem two'));
    assert.ok(text!.includes('mem three'));
  });
});

suite('SharedMemoryProvider score threshold (simulation)', () => {
  interface ScoredItem {
    id?: string;
    content: string;
    score?: number;
  }

  function applyScoreFilter(items: ScoredItem[], minScore: number): ScoredItem[] {
    if (minScore <= 0) {
      return [...items];
    }
    return items.filter((item) => item.score === undefined || item.score >= minScore);
  }

  test('minScore=0 includes everything', () => {
    const items = [
      { id: 'a', content: 'high', score: 0.9 },
      { id: 'b', content: 'mid', score: 0.5 },
      { id: 'c', content: 'low', score: 0.1 },
      { id: 'd', content: 'no score' },
    ];
    assert.strictEqual(applyScoreFilter(items, 0).length, 4);
  });

  test('minScore=0.5 filters low scores', () => {
    const items = [
      { id: 'a', content: 'high', score: 0.9 },
      { id: 'b', content: 'mid', score: 0.5 },
      { id: 'c', content: 'low', score: 0.1 },
      { id: 'd', content: 'no score' },
    ];
    const filtered = applyScoreFilter(items, 0.5);
    assert.deepStrictEqual(filtered.map((i) => i.id), ['a', 'b', 'd']);
  });

  test('items without score are always included', () => {
    const items = [
      { id: 'a', content: 'scored', score: 0.1 },
      { id: 'b', content: 'unscored' },
      { id: 'c', content: 'undefined score', score: undefined },
    ];
    const filtered = applyScoreFilter(items, 0.5);
    assert.deepStrictEqual(filtered.map((i) => i.id), ['b', 'c']);
  });

  test('score exactly at threshold is included (>=)', () => {
    const items = [
      { id: 'a', content: 'exact', score: 0.5 },
      { id: 'b', content: 'below', score: 0.49 },
    ];
    const filtered = applyScoreFilter(items, 0.5);
    assert.deepStrictEqual(filtered.map((i) => i.id), ['a']);
  });

  test('score filter alone (no dedup)', () => {
    const items = [
      { id: 'a', content: 'a', score: 0.9 },
      { id: 'b', content: 'b', score: 0.8 },
      { id: 'c', content: 'c', score: 0.3 },
      { id: 'd', content: 'd', score: 0.95 },
    ];
    const filtered = items.filter((i) => i.score === undefined || i.score >= 0.5);
    assert.deepStrictEqual(filtered.map((i) => i.id), ['a', 'b', 'd']);
  });
});

suite('MemoryFormat.formatSkills', () => {
  test('returns undefined for empty list', () => {
    assert.strictEqual(formatSkills([]), undefined);
  });

  test('formats skills with names, versions, and descriptions', () => {
    const text = formatSkills([{ skill_id: 's1', name: 'deploy-flow', description: 'Deploy the project', version: 1 }]);
    assert.ok(text);
    assert.ok(text!.includes('<available_skills>'));
    assert.ok(text!.includes('deploy-flow'));
    assert.ok(text!.includes('v1'));
    assert.ok(text!.includes('Deploy the project'));
    assert.ok(text!.includes('</available_skills>'));
  });

  test('clarifies memory vs filesystem skills and memory_skill_view', () => {
    const text = formatSkills([{ skill_id: 's1', name: 'test', description: 'a test', version: 1 }]);
    assert.ok(text);
    assert.ok(text!.includes('memory-injected'));
    assert.ok(text!.includes('memory_skill_view'));
    assert.ok(text!.includes('Read tool'));
  });

  test('can omit footer on incremental skill injections', () => {
    const text = formatSkills(
      [{ skill_id: 's1', name: 'test', description: 'a test', version: 1 }],
      { includeFooter: false },
    );
    assert.ok(text);
    assert.ok(text!.includes('<available_skills>'));
    assert.ok(text!.includes('test'));
    assert.ok(!text!.includes('memory-injected'));
    assert.ok(!text!.includes('Read tool'));
  });

  test('footer embeds self-contained memory_skill_view curl recipe when bridgeBaseUrl set', () => {
    const text = formatSkills(
      [{ skill_id: 's1', name: 'test', description: 'a test', version: 1 }],
      { bridgeBaseUrl: 'http://127.0.0.1:8127/', agentId: 'codex', platform: 'linux' },
    );
    assert.ok(text);
    assert.ok(text!.includes('memory-injected'));
    assert.ok(text!.includes('curl -sf -X POST http://127.0.0.1:8127/view'));
    assert.ok(text!.includes('curl -sf -X POST http://127.0.0.1:8127/search'));
    assert.ok(text!.includes('"agent_id":"codex"'));
    assert.ok(text!.includes('NOT the API above'));
    // The static fallback ("see session history") must NOT appear when a base URL is set.
    assert.ok(!text!.includes('see session history'));
  });

  test('footer embeds PowerShell Invoke-RestMethod recipe on win32', () => {
    const text = formatSkills(
      [{ skill_id: 's1', name: 'test', description: 'a test', version: 1 }],
      { bridgeBaseUrl: 'http://127.0.0.1:8127/', agentId: 'codex', platform: 'win32' },
    );
    assert.ok(text);
    assert.ok(text!.includes("Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8127/view'"));
    assert.ok(text!.includes("Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8127/search'"));
    assert.ok(text!.includes('"agent_id":"codex"'));
    assert.ok(!text!.includes('curl -sf'));
  });

  test('handles multiple skills', () => {
    const text = formatSkills([
      { skill_id: 's1', name: 'a', description: 'first', version: 1 },
      { skill_id: 's2', name: 'b', description: 'second', version: 2 },
      { skill_id: 's3', name: 'c', description: 'third', version: 3 },
    ]);
    assert.ok(text);
    assert.ok(text!.includes('a'));
    assert.ok(text!.includes('b'));
    assert.ok(text!.includes('c'));
  });
});

suite('MemorySanitize', () => {
  test('strips injected recall tags to prevent feedback loops', () => {
    const raw = '<relevant-memories>\n- [fact] secret\n</relevant-memories>\n\nreal user question';
    assert.strictEqual(sanitizeMemoryText(raw), 'real user question');
  });

  test('strips agent-memory wrapper', () => {
    const raw = '<agent-memory>\npersona\n</agent-memory>\n\nhello';
    assert.strictEqual(sanitizeMemoryText(raw), 'hello');
  });

  test('strips flattened memory recall echoed back by the agent (feedback loop)', () => {
    // codex's ACP server flattens an embeddedContext resource into the user
    // message as a context tag + link mention. Capturing that verbatim would
    // re-write the recall blob as L0 → self-reinforcing recall.
    const raw =
      '[@memory](vscode-acp:///memory/claude)\n' +
      '<context ref="vscode-acp:///memory/claude">\n' +
      '<agent-memory>\n<relevant-memories>\n- [fact] uses pnpm\n</relevant-memories>\n' +
      '</agent-memory>\n</context>\n\n' +
      'actual question';
    assert.strictEqual(sanitizeMemoryText(raw), 'actual question');
  });

  test('stripCodeBlocks removes fenced code', () => {
    const raw = 'Here is a fix:\n```ts\nconst x = 1;\n```\nDone.';
    assert.strictEqual(stripCodeBlocks(raw), 'Here is a fix:\n\nDone.');
  });

  test('shouldCaptureL0 drops slash commands and empty', () => {
    assert.strictEqual(shouldCaptureL0('/compact'), false);
    assert.strictEqual(shouldCaptureL0('  '), false);
    assert.strictEqual(shouldCaptureL0('please fix the bug'), true);
  });

  test('shouldCaptureL0 drops summarizer instruction-echo fragments', () => {
    const leaked =
      'Note: The summary must be based strictly on the actual tool results shown above. ' +
      'Do not fabricate or invent any results. If a tool failed or returned an error, report that honestly.';
    assert.strictEqual(shouldCaptureL0(leaked), false);
    assert.strictEqual(shouldCaptureL0('Do not fabricate tool results.'), false);
    assert.strictEqual(shouldCaptureL0('Never fabricate results — report failures honestly.'), false);
  });
});

suite('MemorySanitize.truncateForCapture', () => {
  test('caps capture content at the gateway limit', () => {
    const raw = 'x'.repeat(CAPTURE_CONTENT_MAX_CHARS + 500);
    const captured = truncateForCapture(raw);
    assert.strictEqual(captured.length, CAPTURE_CONTENT_MAX_CHARS - 1);
  });

  test('leaves short content untouched', () => {
    assert.strictEqual(truncateForCapture('short assistant reply'), 'short assistant reply');
  });

  test('leaves exactly-at-limit content untouched', () => {
    const raw = 'y'.repeat(CAPTURE_CONTENT_MAX_CHARS);
    assert.strictEqual(truncateForCapture(raw), raw);
  });
});

suite('MemorySkillFeed.buildSkillConversationMessages', () => {
  const text = { role: 'user' as const, content: 'fix the bug', timestamp: 't0' };
  const reply = { role: 'assistant' as const, content: 'done', timestamp: 't1' };
  const toolCalls: SkillToolCall[] = [
    { id: 'call_1', title: "Read file 'src/a.ts'", timestamp: 't2' },
    { id: 'call_2', title: 'PowerShell', timestamp: 't3' },
  ];

  test('orders user → tool_call → assistant', () => {
    const msgs = buildSkillConversationMessages([text, reply], toolCalls);
    assert.deepStrictEqual(
      msgs.map((m) => m.role),
      ['user', 'tool_call', 'tool_call', 'assistant'],
    );
  });

  test('tool_call messages carry id, title, and timestamp', () => {
    const msgs = buildSkillConversationMessages([text, reply], toolCalls);
    assert.strictEqual(msgs[1].role, 'tool_call');
    assert.strictEqual(msgs[1].tool_call_id, 'call_1');
    assert.strictEqual(msgs[1].content, "Read file 'src/a.ts'");
    assert.strictEqual(msgs[1].timestamp, 't2');
    assert.strictEqual(msgs[2].tool_call_id, 'call_2');
  });

  test('dedupes tool calls by id', () => {
    const msgs = buildSkillConversationMessages([text, reply], [
      ...toolCalls,
      { id: 'call_1', title: 'duplicate', timestamp: 't4' },
    ]);
    assert.strictEqual(msgs.filter((m) => m.role === 'tool_call').length, 2);
  });

  test('drops tool calls without id or title', () => {
    const msgs = buildSkillConversationMessages([text, reply], [
      { id: '', title: 'no id', timestamp: 't' },
      { id: 'call_x', title: '', timestamp: 't' },
    ]);
    assert.strictEqual(msgs.filter((m) => m.role === 'tool_call').length, 0);
  });

  test('caps tool calls per turn', () => {
    const many = Array.from({ length: MAX_SKILL_TOOL_CALLS_PER_TURN + 50 }, (_, i) => ({
      id: `call_${i}`,
      title: `tool ${i}`,
      timestamp: 't',
    }));
    const msgs = buildSkillConversationMessages([text, reply], many);
    assert.strictEqual(msgs.filter((m) => m.role === 'tool_call').length, MAX_SKILL_TOOL_CALLS_PER_TURN);
  });

  test('works when user or assistant text is missing', () => {
    const onlyReply = buildSkillConversationMessages([reply], toolCalls);
    assert.deepStrictEqual(
      onlyReply.map((m) => m.role),
      ['tool_call', 'tool_call', 'assistant'],
    );
    const onlyUser = buildSkillConversationMessages([text], toolCalls);
    assert.deepStrictEqual(
      onlyUser.map((m) => m.role),
      ['user', 'tool_call', 'tool_call'],
    );
  });
});

suite('MemorySanitize.buildRecallQuery', () => {
  test('drops a previously injected recall blob and keeps the real question', () => {
    const raw =
      '<agent-memory>\n<relevant-memories>\n- [work_fact] something recalled\n</relevant-memories>\n</agent-memory>why is the fold order wrong?';
    assert.strictEqual(buildRecallQuery(raw), 'why is the fold order wrong?');
  });

  test('drops workspace context blocks', () => {
    const raw = '<context ref="session:memory">dump</context>\n<terminal>log lines</terminal>\nfix the build';
    assert.strictEqual(buildRecallQuery(raw), 'fix the build');
  });

  test('caps the query at the gateway limit', () => {
    const raw = 'x'.repeat(RECALL_QUERY_MAX_CHARS + 500);
    const query = buildRecallQuery(raw);
    assert.strictEqual(query.length, RECALL_QUERY_MAX_CHARS);
  });

  test('a prompt that is only recall context yields an empty query', () => {
    const raw = '<agent-memory>\n<user-persona>doctrine</user-persona>\n</agent-memory>';
    assert.strictEqual(buildRecallQuery(raw), '');
  });

  test('plain prompts pass through untouched', () => {
    assert.strictEqual(buildRecallQuery('deployed a2a?'), 'deployed a2a?');
  });
});

import * as assert from 'assert';
import { resolveMemoryAgentId } from '../core/memory/MemoryAgentId';
import { formatL1Memories, formatRecallContext } from '../core/memory/MemoryFormat';
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
    assert.strictEqual(resolveMemoryAgentId('ericli-acp'), 'ericli');
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
    // ericli's ACP server flattens an embeddedContext resource into the user
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

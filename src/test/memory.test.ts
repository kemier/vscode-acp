import * as assert from 'assert';
import { resolveMemoryAgentId } from '../core/memory/MemoryAgentId';
import { formatL1Memories, formatRecallContext } from '../core/memory/MemoryFormat';
import { sanitizeMemoryText, shouldCaptureL0, stripCodeBlocks } from '../core/memory/MemorySanitize';

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

  test('stripCodeBlocks removes fenced code', () => {
    const raw = 'Here is a fix:\n```ts\nconst x = 1;\n```\nDone.';
    assert.strictEqual(stripCodeBlocks(raw), 'Here is a fix:\n\nDone.');
  });

  test('shouldCaptureL0 drops slash commands and empty', () => {
    assert.strictEqual(shouldCaptureL0('/compact'), false);
    assert.strictEqual(shouldCaptureL0('  '), false);
    assert.strictEqual(shouldCaptureL0('please fix the bug'), true);
  });
});

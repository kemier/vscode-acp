import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * A fork must not hand the target agent the SOURCE agent's memory namespace.
 *
 * Found in a live session: one agent's session was forked from another, and the
 * carried "Context (memory & skills) from the source agent:" block held five
 * `"agent_id"` curl recipes all still naming the SOURCE agent. The target was
 * therefore instructed to read and write the source agent's memory, not its own.
 *
 * Two independent causes:
 *
 *  1. the pattern was /(<memory_skill_tools>[\s\S]*?)"agent_id":"[^"]*"/g, which
 *     needs the opening tag inside every match. With a single block the /g scan
 *     cannot re-match after the first hit, so exactly one id was rewritten;
 *  2. recallMemoryForAgent's fresh-recall branch never called the remap at all —
 *     and that is the branch the live fork took, which is why all five survived.
 *     That branch runs after any VS Code reload, because the per-session cache
 *     of injected memory is not persisted.
 *
 * The fixture below mirrors the real block from that session, reduced to the
 * parts that matter, so the regression is pinned to observed data rather than to
 * a shape I imagined.
 */
suite('fork: memory-tool agent_id is remapped to the target', () => {
  const SOURCE = path.resolve(__dirname, '../../src/core/SessionManager.ts');
  const src = fs.readFileSync(SOURCE, 'utf8');

  function extract(signature: string): string {
    const start = src.indexOf(signature);
    assert.ok(start >= 0, `${signature} not found`);
    let depth = 0;
    for (let i = start; i < src.length; i++) {
      if (src[i] === '{') {
        depth++;
      } else if (src[i] === '}' && --depth === 0) {
        return src.slice(start, i + 1);
      }
    }
    throw new Error(`unbalanced braces extracting ${signature}`);
  }

  /** The real function, with only the settings lookup stubbed to an identity. */
  const remap = new Function(
    'return ' +
      extract('function remapSkillToolsForAgent(text: string, agentName: string): string {')
        .replace(/: string/g, '')
        .replace(
          'const memoryAgentId = resolveMemoryAgentId(agentName, readMemorySettings().agentIdMap);',
          'const memoryAgentId = agentName;',
        ),
  )() as (text: string, agent: string) => string;

  /** Shape taken verbatim from the live cross-agent fork. */
  const liveBlock = [
    'Context (memory & skills) from the source agent:',
    '',
    '<agent-memory>',
    '<memory_skill_tools>',
    'The <available_skills> block above lists **name + description only**.',
    '',
    '  <tool name="memory_skill_view">',
    `    curl -sf -X POST http://127.0.0.1:8127/view -H 'Content-Type: application/json' -d '{"name":"<skill-name>","agent_id":"source-agent"}'`,
    '         use names from <available_skills>, skill_search results.',
    '  </tool>',
    '  <tool name="memory_skill_search">',
    `    curl -sf -X POST http://127.0.0.1:8127/search -H 'Content-Type: application/json' -d '{"query":"<keywords>","agent_id":"source-agent"}'`,
    '  </tool>',
    '  <tool name="memory_conversation_lookup">',
    `    curl -sf -X POST http://127.0.0.1:8127/conversation-lookup -H 'Content-Type: application/json' -d '{"conversation_ids":["<id1>"],"agent_id":"source-agent"}'`,
    '  </tool>',
    '  <tool name="memory_memory_search">',
    `    curl -sf -X POST http://127.0.0.1:8127/memory-search -H 'Content-Type: application/json' -d '{"query":"<keywords>","agent_id":"source-agent"}'`,
    '  </tool>',
    '  <tool name="memory_skill_update">',
    `    curl -sf -X POST http://127.0.0.1:8127/update -H 'Content-Type: application/json' -d '{"skill_id":"<skl-…>","content":"<full SKILL.md>","agent_id":"source-agent"}'`,
    '  </tool>',
    'Err on the side of loading — prerequisite skills are often NOT listed in <available_skills>.',
    '',
    '</memory_skill_tools>',
    '</agent-memory>',
  ].join('\n');

  const count = (s: string, needle: string) => s.split(needle).length - 1;

  test('EVERY agent_id in the block is remapped, not just the first', () => {
    assert.strictEqual(count(liveBlock, '"agent_id":"source-agent"'), 5, 'fixture should hold five recipes');
    const out = remap(liveBlock, 'target-agent');
    assert.strictEqual(count(out, '"agent_id":"source-agent"'), 0, 'a source-agent id survived the remap');
    assert.strictEqual(count(out, '"agent_id":"target-agent"'), 5, 'all five must point at the target');
  });

  test('nothing else in the block is rewritten', () => {
    const out = remap(liveBlock, 'target-agent');
    // Same length apart from the id substitutions.
    assert.strictEqual(out.length, liveBlock.length + 5 * 'target-agent'.length - 5 * 'source-agent'.length);
    assert.ok(out.includes('memory_skill_view'), 'tool names must survive');
    assert.ok(out.includes('http://127.0.0.1:8127/update'), 'endpoints must survive');
  });

  test('an unclosed block is still remapped rather than skipped', () => {
    // A truncated blob used to fall through the closing-tag anchor untouched.
    const truncated = liveBlock.replace('</memory_skill_tools>', '');
    const out = remap(truncated, 'target-agent');
    assert.strictEqual(count(out, '"agent_id":"source-agent"'), 0, 'truncation must not defeat the remap');
  });

  test('spacing after the colon does not defeat the remap', () => {
    const spaced = liveBlock.replace(/"agent_id":"source-agent"/g, '"agent_id": "source-agent"');
    const out = remap(spaced, 'target-agent');
    assert.strictEqual(count(out, 'source-agent'), 0, 'a spaced variant must still be rewritten');
  });

  test('an agent_id OUTSIDE the block is left alone', () => {
    // The fork body is a conversation; it may legitimately quote an agent_id and
    // must not be rewritten — that would corrupt the transcript being handed over.
    const withProse = liveBlock + '\n\nEarlier the user ran curl with {"agent_id":"source-agent"} by hand.';
    const out = remap(withProse, 'target-agent');
    assert.ok(
      out.endsWith('by hand.'),
      'the trailing prose must be intact',
    );
    assert.strictEqual(
      count(out, '"agent_id":"source-agent"'),
      1,
      'exactly the one outside the block should remain',
    );
  });

  test('text with no tools block is returned untouched', () => {
    const plain = 'Context from the source agent:\n\n<user-persona>\nsome persona\n</user-persona>';
    assert.strictEqual(remap(plain, 'target-agent'), plain);
  });

  suite('the fresh-recall branch applies the remap too', () => {
    const recall = extract('async recallMemoryForAgent(');

    test('both return paths remap', () => {
      // The cache branch always did; the fresh branch returned `joined` raw, and
      // that is the branch a fork takes after any VS Code reload.
      //
      // Identify the memory-carrying returns by the blob they return (cached /
      // joined) rather than by excluding known noise — my first version filtered
      // heuristically and tripped over `return t;` inside the inner .map().
      const returns = recall.match(/return\s+[^;]+;/g) || [];
      const memoryReturns = returns.filter((r) => /\b(cached|joined)\b/.test(r));
      assert.strictEqual(memoryReturns.length, 2, 'expected a cache path and a fresh-recall path');
      for (const r of memoryReturns) {
        assert.ok(
          r.includes('remapSkillToolsForAgent'),
          `a memory-returning path skips the remap: ${r.slice(0, 80)}`,
        );
      }
    });

    test('the source skills list is still stripped on both paths', () => {
      assert.strictEqual(
        (recall.match(/stripSkillsSection/g) || []).length,
        2,
        'both paths must strip the source skill list',
      );
    });
  });
});

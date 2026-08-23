import * as assert from 'assert';
import { formatMemorySkillTools } from '../core/memory/MemorySkillTools';
import { formatRecallContext } from '../core/memory/MemoryFormat';

suite('MemorySkillTools', () => {
  test('formatMemorySkillTools includes view and search curl recipes', () => {
    const text = formatMemorySkillTools({
      bridgeBaseUrl: 'http://127.0.0.1:8126',
      agentId: 'cursor',
    });
    assert.ok(text.includes('<memory_skill_tools>'));
    assert.ok(text.includes('memory_skill_view'));
    assert.ok(text.includes('memory_skill_search'));
    assert.ok(text.includes('http://127.0.0.1:8126/view'));
    assert.ok(text.includes('"agent_id":"cursor"'));
    assert.ok(text.includes('prerequisite'));
  });

  test('formatRecallContext attaches skill tools block', () => {
    const tools = formatMemorySkillTools({
      bridgeBaseUrl: 'http://127.0.0.1:8126',
      agentId: 'cursor',
    });
    const formatted = formatRecallContext(
      [],
      null,
      [],
      [{ skill_id: 's1', name: 'a', description: 'd', version: 1 }],
      tools,
    );
    assert.ok(formatted);
    assert.ok(formatted!.text.includes('<memory_skill_tools>'));
    assert.ok(formatted!.text.includes('<available_skills>'));
  });
});

import * as assert from 'assert';
import { formatMemorySkillTools } from '../core/memory/MemorySkillTools';
import { formatRecallContext } from '../core/memory/MemoryFormat';

suite('MemorySkillTools', () => {
  test('formatMemorySkillTools includes posix curl recipes', () => {
    const text = formatMemorySkillTools({
      bridgeBaseUrl: 'http://127.0.0.1:8126',
      agentId: 'cursor',
      platform: 'linux',
    });
    assert.ok(text.includes('<memory_skill_tools>'));
    assert.ok(text.includes('memory_skill_view'));
    assert.ok(text.includes('memory_skill_search'));
    assert.ok(text.includes('memory_skill_update'));
    assert.ok(text.includes('memory_conversation_lookup'));
    assert.ok(text.includes('Prefer IDs from injected L1 bullets'));
    assert.ok(text.includes('http://127.0.0.1:8126/view'));
    assert.ok(text.includes('http://127.0.0.1:8126/update'));
    assert.ok(text.includes('"agent_id":"cursor"'));
    assert.ok(text.includes('prerequisite'));
    assert.ok(text.includes('curl -sf -X POST'));
    assert.ok(!text.includes('Invoke-RestMethod'));
  });

  test('formatMemorySkillTools uses Invoke-RestMethod on win32', () => {
    const text = formatMemorySkillTools({
      bridgeBaseUrl: 'http://127.0.0.1:8126',
      agentId: 'cursor',
      platform: 'win32',
    });
    assert.ok(text.includes('Invoke-RestMethod -Method Post -Uri \'http://127.0.0.1:8126/view\''));
    assert.ok(text.includes('Invoke-RestMethod -Method Post -Uri \'http://127.0.0.1:8126/search\''));
    assert.ok(text.includes('Invoke-RestMethod -Method Post -Uri \'http://127.0.0.1:8126/update\''));
    assert.ok(text.includes('"agent_id":"cursor"'));
    assert.ok(text.includes('do not use the `curl` alias'));
    assert.ok(!text.includes('curl -sf'));
  });

  test('formatRecallContext attaches skill tools block', () => {
    const tools = formatMemorySkillTools({
      bridgeBaseUrl: 'http://127.0.0.1:8126',
      agentId: 'cursor',
      platform: 'linux',
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

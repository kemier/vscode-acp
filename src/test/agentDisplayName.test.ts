import * as assert from 'assert';
import { resolveAgentDisplayName } from '../config/agentDisplayName';

suite('resolveAgentDisplayName', () => {
  test('settings displayName wins over adapter title', () => {
    assert.strictEqual(
      resolveAgentDisplayName('pi', {
        displayName: 'Pi Agent',
        agentInfo: { title: 'pi ACP adapter', name: 'pi-acp' },
      }),
      'Pi Agent',
    );
  });

  test('user-facing settings keys win over generic adapter titles', () => {
    assert.strictEqual(
      resolveAgentDisplayName('Pi Agent', {
        agentInfo: { title: 'pi ACP adapter', name: 'pi-acp' },
      }),
      'Pi Agent',
    );
  });

  test('slug keys keep the advertised agent title', () => {
    assert.strictEqual(
      resolveAgentDisplayName('codex', {
        agentInfo: { title: 'Codex CLI', name: 'codex' },
      }),
      'Codex CLI',
    );
  });

  test('falls back to the settings key when no advertised title exists', () => {
    assert.strictEqual(resolveAgentDisplayName('codex'), 'codex');
  });
});

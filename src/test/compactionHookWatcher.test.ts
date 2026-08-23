import * as assert from 'assert';

import type { SessionInfo } from '../core/SessionManager';
import {
  compactionEventDedupKey,
  normalizePathForMatch,
  resolveCompactionHookSession,
} from '../core/CompactionHookWatcher';

function session(partial: Partial<SessionInfo> & Pick<SessionInfo, 'sessionId' | 'agentName' | 'cwd'>): SessionInfo {
  return {
    agentId: 'agent-1',
    agentDisplayName: partial.agentName,
    createdAt: '2026-01-01T00:00:00.000Z',
    initResponse: {} as SessionInfo['initResponse'],
    modes: null,
    models: null,
    configOptions: null,
    availableCommands: [],
    ...partial,
  };
}

suite('CompactionHookWatcher', () => {
  test('resolveCompactionHookSession matches conversation_id to session id', () => {
    const sid = '2c6822a1-0c65-43ff-a99a-3c8d196980fc';
    const sessions = [session({ sessionId: sid, agentName: 'Cursor', cwd: 'e:/projects/vscode-acp' })];
    const resolved = resolveCompactionHookSession(
      { conversation_id: sid, trigger: 'auto' },
      sessions,
      sid,
    );
    assert.strictEqual(resolved, sid);
  });

  test('resolveCompactionHookSession matches workspace_roots to cwd', () => {
    const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const sessions = [session({ sessionId: sid, agentName: 'Cursor', cwd: 'E:\\projects\\vscode-acp' })];
    const resolved = resolveCompactionHookSession(
      { workspace_roots: ['e:/projects/vscode-acp'], trigger: 'auto' },
      sessions,
      null,
    );
    assert.strictEqual(resolved, sid);
  });

  test('resolveCompactionHookSession ignores non-Cursor agents', () => {
    const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const sessions = [session({ sessionId: sid, agentName: 'codex-acp', cwd: '/tmp' })];
    const resolved = resolveCompactionHookSession({ conversation_id: sid }, sessions, sid);
    assert.strictEqual(resolved, null);
  });

  test('normalizePathForMatch lowercases and normalizes slashes', () => {
    assert.strictEqual(normalizePathForMatch('E:\\Foo\\Bar'), 'e:/foo/bar');
  });

  test('compactionEventDedupKey is stable for same event', () => {
    const event = {
      conversation_id: 'abc',
      generation_id: 'gen-1',
      ts: '2026-08-23T00:00:00.000Z',
      messages_to_compact: 12,
    };
    assert.strictEqual(compactionEventDedupKey(event), compactionEventDedupKey(event));
  });
});

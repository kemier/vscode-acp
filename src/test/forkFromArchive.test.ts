import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Forking a session held by another process reported "No conversation to fork —
 * the session is empty", which pointed at the wrong problem.
 *
 * The fork exports the webview's RENDERED chat. When kiro refuses session/load
 * ("Session is already open in another process (PID …)") nothing is rendered, so
 * the export came back empty. The session was not empty at all.
 *
 * There is also no local fallback for kiro: its CLI session JSON holds only
 * metadata (session_id, cwd, title, session_state → conversation_metadata,
 * permissions, goal), its IDE session.json is a few hundred bytes of settings, and
 * session-index is a path list — the conversation itself lives in the kiro process
 * and its backend. So a locked session genuinely cannot be read; what CAN be used
 * is this window's own archive from when the session was last loaded here.
 */

const WEBVIEW = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');
const EXTENSION = path.resolve(__dirname, '../../src/extension.ts');

suite('fork uses the archived history of a non-rendered session', () => {
  test('the export request carries the session id', () => {
    const src = fs.readFileSync(WEBVIEW, 'utf8');
    assert.ok(src.includes("this.postMessage({ type: 'requestConversationExport', sessionId });"));
    assert.ok(src.includes('sessionId?: string,'), 'the provider must accept it');
    const ext = fs.readFileSync(EXTENSION, 'utf8');
    assert.ok(ext.includes('requestConversationExport(10000, sessionId)'));
  });

  test('a different session exports from the archive, not the visible chat', () => {
    const src = fs.readFileSync(WEBVIEW, 'utf8');
    assert.ok(src.includes('var _exportItems = chatHistory;'));
    assert.ok(src.includes('if (_wantSessionId && _wantSessionId !== chatHistoryOriginSessionId)'));
    assert.ok(src.includes('var _archived = sessionHistoryArchive[_wantSessionId];'));
    // An unknown session must export nothing rather than the wrong conversation.
    assert.ok(src.includes('_exportItems = _archived && _archived.length ? _archived : [];'));
  });

  test('both export loops read the resolved list', () => {
    const src = fs.readFileSync(WEBVIEW, 'utf8');
    // lastIndexOf: the first occurrence is the HOST's message switch; the webview
    // script (inside the template literal) comes later in the file.
    const at = src.lastIndexOf("case 'requestConversationExport'");
    const body = src.slice(at, at + 12000);
    // The compaction-boundary scan and the emit loop must agree on the source,
    // or a fork would trim the archive against the visible chat's boundary.
    assert.ok(body.includes('for (var _cei = 0; _cei < _exportItems.length; _cei++)'), body.slice(0, 400));
    assert.ok(body.includes('var _ceItem = _exportItems[_cei];'));
    assert.ok(body.includes('for (var _ei = _exportStart; _ei < _exportItems.length; _ei++)'), body.slice(0, 800));
    assert.ok(body.includes('var _item = _exportItems[_ei];'));
  });

  test('the failure message distinguishes empty from unavailable', () => {
    const ext = fs.readFileSync(EXTENSION, 'utf8');
    assert.ok(ext.includes('this session has no messages yet'), 'active-but-empty case');
    assert.ok(ext.includes('this window has no history for that session'), 'not-loaded-here case');
    assert.ok(
      ext.includes('a session held by another process cannot be read'),
      'must say why, since kiro keeps no transcript on disk',
    );
    // The old wording claimed the session was empty, which it was not.
    assert.ok(!ext.includes('No conversation to fork — the session is empty.'));
  });
});

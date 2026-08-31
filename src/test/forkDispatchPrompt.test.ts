import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Fork-to-agent: the summarized conversation stayed in the composer.
 *
 * acp.forkToAgent ends with chatWebviewProvider.dispatchPrompt(forkPrompt, true).
 * The webview's handler sets promptInput.value and calls handleSend() — but
 * handleSend() bails on !hasActiveSession WITHOUT consuming the input (every
 * other early exit queues, which DOES clear it). So a stale hasActiveSession
 * left the forked summary sitting in the input box awaiting a manual Send.
 *
 * The flag is set from a `state` message, and forkToAgent connects the target
 * agent inside a suppressWebviewUpdates window, so that delivery races the
 * dispatch. Fix: the host carries the session fact on the dispatched message,
 * since it is authoritative about whether a session exists.
 *
 * dispatchPrompt is plain TypeScript (not inside the webview template literal),
 * so it is exercised through the prototype with a minimal stub — importing the
 * whole provider would drag in the vscode module surface.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

/** Extract dispatchPrompt's body and run it against a stub `this`. */
function loadDispatchPrompt(): (self: any, text: string, hideBubble?: boolean) => void {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const start = src.indexOf('  dispatchPrompt(text: string, hideBubble?: boolean): void {');
  assert.ok(start >= 0, 'dispatchPrompt not found in ChatWebviewProvider.ts');
  const end = src.indexOf('\n  }\n', start);
  assert.ok(end > start, 'end of dispatchPrompt not found');
  const body = src.slice(src.indexOf('{', start) + 1, end);
  const run = new Function('self', 'text', 'hideBubble', `(function(){${body}}).call(self);`);
  return (self: any, text: string, hideBubble?: boolean) => {
    run(self, text, hideBubble);
  };
}

suite('fork-to-agent dispatchPrompt (summary stuck in the composer)', () => {
  const dispatch = loadDispatchPrompt();

  function stub(activeSessionId: string | null) {
    const posted: any[] = [];
    return {
      posted,
      self: {
        postMessage: (m: any) => posted.push(m),
        sessionManager: { getActiveSessionId: () => activeSessionId },
      },
    };
  }

  test('carries hasActiveSession=true so handleSend cannot bail', () => {
    const { posted, self } = stub('sess-1');
    dispatch(self, 'forked summary', true);
    assert.strictEqual(posted.length, 1);
    assert.strictEqual(posted[0].type, 'sendPrompt');
    assert.strictEqual(posted[0].text, 'forked summary');
    assert.strictEqual(posted[0].hideBubble, true);
    assert.strictEqual(
      posted[0].hasActiveSession,
      true,
      'without this the webview may still be on a stale flag and leave the text in the input',
    );
  });

  test('reports hasActiveSession=false when there genuinely is no session', () => {
    const { posted, self } = stub(null);
    dispatch(self, 'x');
    assert.strictEqual(posted[0].hasActiveSession, false);
  });

  test('hideBubble defaults to false and is strictly boolean', () => {
    const { posted, self } = stub('sess-1');
    dispatch(self, 'x');
    assert.strictEqual(posted[0].hideBubble, false);
    dispatch(self, 'y', false);
    assert.strictEqual(posted[1].hideBubble, false);
  });
});

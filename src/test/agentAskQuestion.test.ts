import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Agent questions belong in the chat, and every agent should ask the same way.
 *
 * Before this, each dialect had its own dead end:
 *   - cursor/ask_question   -> showQuickPick (extension.ts)
 *   - ACP elicitation enum  -> showQuickPick (ElicitationHandler)
 *   - session/request_permission -> showQuickPick (PermissionHandler)
 *   - ericli                -> NO WAY TO ASK AT ALL. Its elicitation code is
 *                              MCP/terminal only and no tool existed, so an agent
 *                              at a genuine fork wrote the question into prose and
 *                              guessed — the turn had already ended by the time the
 *                              user could reply.
 *
 * A QuickPick also covers the editor, is detached from the message that raised it,
 * and leaves NO trace once answered: nothing in the transcript, nothing on resume,
 * nothing for memory. The decision is usually the most valuable thing in the turn.
 *
 * `_acp/ask_question` is the neutral method; its shape is cursor/ask_question's
 * verbatim, so cursor maps on without translation and multi-select survives.
 */

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * The body of a function/method.
 *
 * Two traps, both hit while writing this test:
 *   - `slice(at, at + N)` or "the next `\n  }`" stops at the first NESTED close
 *     brace, so the assertion silently checks a fragment;
 *   - brace-matching from the first `{` matches the PARAMETER type literal
 *     (`askQuestion(params: { ... })`), not the body.
 *
 * So: match parentheses to find the end of the parameter list, then brace-match
 * from the first `{` after it.
 */
function bodyOf(src: string, signature: string): string {
  const at = src.indexOf(signature);
  assert.ok(at > 0, `not found: ${signature}`);
  const parenOpen = src.indexOf('(', at);
  let pd = 0;
  let parenEnd = -1;
  for (let i = parenOpen; i < src.length; i++) {
    if (src[i] === '(') {
      pd++;
    } else if (src[i] === ')') {
      pd--;
      if (pd === 0) {
        parenEnd = i;
        break;
      }
    }
  }
  assert.ok(parenEnd > 0, `unbalanced parens after ${signature}`);
  // Not simply the next `{`: a return-type annotation contains braces too
  // (`): Promise<{ outcome: 'answered' … }>`). The body's brace is the one that
  // ENDS its line, so skip any that has code after it.
  let open = -1;
  for (let i = parenEnd; i < src.length; i++) {
    if (src[i] !== '{') {
      continue;
    }
    const eol = src.indexOf('\n', i);
    if (src.slice(i + 1, eol < 0 ? src.length : eol).trim() === '') {
      open = i;
      break;
    }
  }
  assert.ok(open > 0, `no body brace after ${signature}`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') {
      depth++;
    } else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        return src.slice(at, i + 1);
      }
    }
  }
  throw new Error(`unbalanced braces after ${signature}`);
}

suite('agent questions render in the chat', () => {
  const provider = read('src/ui/ChatWebviewProvider.ts');

  test('the neutral method is routed as a BLOCKING request', () => {
    const conn = read('src/core/ConnectionManager.ts');
    assert.ok(conn.includes("method === '_acp/ask_question'"), 'not routed');
    const at = conn.indexOf("method === '_acp/ask_question'");
    const body = conn.slice(at, conn.indexOf('} else if', at + 10));
    // A question with no id would be a notification the agent could never hear
    // back from, so the route requires one and answers it.
    assert.ok(body.includes('id !== undefined'), 'must require a request id');
    assert.ok(body.includes('writeAgentResponse'), 'must answer the request');
  });

  test('cursor and the neutral method share ONE handler', () => {
    const ext = read('src/extension.ts');
    assert.ok(ext.includes("sessionManager.on('agent-ask-question', askUserQuestion)"), 'neutral not wired');
    assert.ok(ext.includes("sessionManager.on('cursor-ask-question', askUserQuestion)"), 'cursor not wired');
    // The old cursor-only QuickPick handler must be gone, or cursor questions
    // would be answered twice.
    assert.strictEqual(
      (ext.match(/sessionManager\.on\('cursor-ask-question'/g) ?? []).length,
      1,
      'more than one cursor-ask-question listener',
    );
  });

  test('the chat is tried first and the QuickPick is the fallback', () => {
    const ext = read('src/extension.ts');
    const body = bodyOf(ext, 'const askUserQuestion =');
    assert.ok(body.indexOf('chatWebviewProvider.askQuestion') < body.indexOf('showQuickPick'), 'chat must be tried first');
    // The fallback is deliberate: an unanswerable question is worse than an ugly
    // one, and the agent blocks until it gets a reply.
    assert.ok(body.includes('showQuickPick'), 'fallback removed');
  });

  test('a question the panel cannot ask returns null, not a fake answer', () => {
    const body = bodyOf(provider, 'async askQuestion(');
    assert.ok(body.includes('if (!this.view) {'), 'no-panel case not handled');
    // Options are what makes it answerable; a question without any is not one.
    assert.ok(body.includes('q.options'), 'options not validated');
    assert.ok(body.includes('return null'), 'must signal the fallback');
  });

  test('each question is settled exactly once', () => {
    // An agent that gives up and a user who clicks late must not both settle it.
    const body = bodyOf(provider, 'private resolveQuestion(');
    assert.ok(body.includes('this.pendingQuestions.delete(askId)'), 'resolver not removed');
    assert.ok(body.includes('if (!pending)'), 'a second settle is not ignored');
  });

  test('the webview answers back and disables the options', () => {
    const body = bodyOf(provider, 'function renderAgentQuestion(msg) {');
    assert.ok(body.includes("type: 'answerQuestion'"), 'no answer posted');
    assert.ok(body.includes('btns[i].disabled = true'), 'options stay clickable after answering');
    // Opting out must be possible, or the only exits are lying or hanging.
    assert.ok(body.includes("outcome: 'cancelled'"), 'no way to decline');
    // Multi-select needs an explicit submit; single-select answers on click.
    assert.ok(body.includes('q.allowMultiple'), 'allowMultiple ignored');
    assert.ok(body.includes('Send selected'), 'no submit for multi-select');
  });

  test('shift-click edits instead of answering', () => {
    // Borrowed from Roo Code's FollowUpSuggest: a suggestion is often nearly
    // right, and retyping it is worse than editing it.
    const body = bodyOf(provider, 'function renderAgentQuestion(msg) {');
    assert.ok(body.includes('ev.shiftKey'), 'no shift-click path');
    const shiftAt = body.indexOf('ev.shiftKey');
    const after = body.slice(shiftAt, shiftAt + 400);
    assert.ok(after.includes('promptInput.value'), 'shift-click does not reach the composer');
    assert.ok(after.includes('return;'), 'shift-click must NOT answer');
  });

  test('the host receives the answer', () => {
    assert.ok(provider.includes("case 'answerQuestion':"), 'answer not handled');
    const at = provider.indexOf("case 'answerQuestion':");
    assert.ok(provider.slice(at, at + 400).includes('this.resolveQuestion('), 'not settled');
  });

  test('the webview regex/escapes survive the template literal', () => {
    // \\b style escapes and raw backticks inside the literal have broken the whole
    // webview before; this renderer uses neither, and must keep not using them.
    const body = bodyOf(provider, 'function renderAgentQuestion(msg) {');
    assert.ok(!body.includes('`'), 'a raw backtick would terminate the template literal');
  });
});

suite('elicitation enums reach the same UI', () => {
  const eh = read('src/handlers/ElicitationHandler.ts');

  test('an enum is asked in the chat when possible', () => {
    assert.ok(eh.includes('this.askInChat'), 'no chat path');
    const at = eh.indexOf('Array.isArray(p?.enum)');
    const body = eh.slice(at, at + 1400);
    assert.ok(body.indexOf('askInChat') < body.indexOf('showQuickPick'), 'chat must be tried first');
    assert.ok(body.includes('showQuickPick'), 'QuickPick fallback removed');
  });

  test('a declined chat answer cancels rather than inventing a value', () => {
    const at = eh.indexOf('Array.isArray(p?.enum)');
    const body = eh.slice(at, at + 1400);
    assert.ok(body.includes("inChat.outcome !== 'answered'"), 'non-answers not handled');
    assert.ok(body.includes("action: 'cancel' as const"), 'must cancel');
  });

  test('the seam is injected, so the handler keeps working without a panel', () => {
    // It must still work before the webview exists, and in tests.
    // The setter must actually store what it is given: asserting only that the
    // method exists let a mutation that assigned null slip through.
    assert.ok(/setAskInChat\([^)]*\): void \{\s*this\.askInChat = fn;/.test(eh), 'setter does not store the provider');
    const conn = read('src/core/ConnectionManager.ts');
    assert.ok(conn.includes('static askInChat'), 'no shared provider');
    assert.ok(conn.includes('if (ConnectionManager.askInChat)'), 'provider not optional');
    const ext = read('src/extension.ts');
    assert.ok(ext.includes('ConnectionManager.askInChat = '), 'never registered');
  });
});

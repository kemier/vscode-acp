import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Regression test for the empty-replay branch in handleLoadSessionEnd.
 *
 * When session/load returns nothing, the agent created a fresh session, so the
 * webview correctly discards the pre-load snapshot. But a prompt the user had
 * just sent is NOT part of that discarded transcript:
 * handleLoadSessionStart wipes chatHistory right after taking the snapshot, so
 * throwing the snapshot away too dropped the prompt entirely. In the
 * send-just-before-load timing the host's userBubble fallback does not cover it
 * either (that post is gated on isLoadingSession as of send time), so the
 * message was lost outright rather than merely delayed.
 *
 * Like foldOrdering.test.ts, this does NOT reimplement the logic — it extracts
 * the real collectUnansweredTrailingPrompts() (and the
 * isSessionInterruptNotice() it depends on) from the webview template literal
 * and runs them.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

function extractFn(name: string, endMarker: string): string {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const startIdx = src.indexOf('function ' + name + '(');
  assert.ok(startIdx >= 0, name + ' not found in ChatWebviewProvider.ts');
  const endIdx = src.indexOf(endMarker, startIdx);
  assert.ok(endIdx > startIdx, 'end marker after ' + name + ' not found');
  return src.slice(startIdx, endIdx).trim();
}

interface Item {
  kind: string;
  role?: string;
  text?: string;
}

type Collect = (snapshot: Item[] | null) => Item[];

function loadCollect(): Collect {
  // The webview lives in a template literal, so escapes are doubled in the
  // raw .ts (\\s). Collapse them the way the literal would before eval.
  const notice = extractFn('isSessionInterruptNotice', '/** Scan chatHistory')
    .replace(/\\\\/g, '\\');
  const collect = extractFn(
    'collectUnansweredTrailingPrompts',
    '/** Scan chatHistory',
  ).replace(/\\\\/g, '\\');
   
  return new Function(
    notice + '\n' + collect + '\nreturn collectUnansweredTrailingPrompts;',
  )() as Collect;
}

const user = (text: string): Item => ({ kind: 'message', role: 'user', text });
const assistant = (text: string): Item => ({ kind: 'message', role: 'assistant', text });
const tool = (): Item => ({ kind: 'toolCall' });
const thought = (): Item => ({ kind: 'thought', text: 'thinking' });

suite('collectUnansweredTrailingPrompts', () => {
  const collect = loadCollect();

  test('keeps a lone unanswered prompt', () => {
    assert.deepStrictEqual(collect([user('hello')]).map((i) => i.text), ['hello']);
  });

  test('keeps the trailing run of prompts after the last assistant', () => {
    const snap = [user('old'), assistant('answered'), user('new1'), user('new2')];
    assert.deepStrictEqual(collect(snap).map((i) => i.text), ['new1', 'new2']);
  });

  test('stops at a tool call — earlier prompts are answered history', () => {
    const snap = [user('old'), tool(), user('pending')];
    assert.deepStrictEqual(collect(snap).map((i) => i.text), ['pending']);
  });

  test('stops at a thought block', () => {
    const snap = [user('old'), thought(), user('pending')];
    assert.deepStrictEqual(collect(snap).map((i) => i.text), ['pending']);
  });

  test('returns nothing when the snapshot ends in agent activity', () => {
    assert.deepStrictEqual(collect([user('q'), assistant('a')]), []);
    assert.deepStrictEqual(collect([user('q'), tool()]), []);
  });

  test('skips interrupt notices and blank rows', () => {
    const snap = [
      user('real'),
      user('   '),
      user('— Conversation interrupted —'),
      user('[Request interrupted by user]'),
    ];
    assert.deepStrictEqual(collect(snap).map((i) => i.text), ['real']);
  });

  test('handles null, empty and holey snapshots', () => {
    assert.deepStrictEqual(collect(null), []);
    assert.deepStrictEqual(collect([]), []);
    const holey = [null as unknown as Item, user('kept')];
    assert.deepStrictEqual(collect(holey).map((i) => i.text), ['kept']);
  });

  test('preserves original order of a multi-prompt run', () => {
    const snap = [assistant('a'), user('1'), user('2'), user('3')];
    assert.deepStrictEqual(collect(snap).map((i) => i.text), ['1', '2', '3']);
  });
});

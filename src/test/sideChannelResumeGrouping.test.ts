import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * A side-channel slash command must not be resurrected at the bottom on resume.
 *
 * Reported: resuming a session showed
 *
 *     /a2a register local agent1
 *     /a2a register local agent2
 *     /a2a register local agent3
 *
 * grouped at the BOTTOM of the transcript. The agent is not the source — its two
 * replay paths emit user messages in array order and filter only
 * SUBAGENT_RESULT_MARKER, and no session file written today persists these commands
 * at all (18 do, every one from July).
 *
 * The client produced them. collectUnansweredTrailingPrompts walks the pre-load
 * snapshot backwards collecting EVERY trailing role:'user' entry, filtering only
 * blanks and interrupt notices, and handleLoadSessionEnd re-renders the survivors
 * after clearing messagesEl — i.e. at the bottom.
 *
 * Turn-safe commands land in exactly that trap: they are answered from a snapshot
 * with no promptStart/promptEnd, and their output is a transient row that
 * deliberately never enters chatHistory. So nothing non-user follows them, and all
 * three looked "provably unanswered".
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

/** Run the real helper out of the webview source, as a2aDelegationState does. */
function extractCollector(): (snapshot: unknown[]) => Array<{ text?: string }> {
  const src = fs.readFileSync(SOURCE, 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf('function collectUnansweredTrailingPrompts(snapshot) {');
  assert.ok(start > 0, 'collectUnansweredTrailingPrompts not found');
  const end = src.indexOf('\n    }', src.indexOf('return out;', start));
  assert.ok(end > start, 'end of helper not found');
  const body = src.slice(start, end + '\n    }'.length);
  // isSessionInterruptNotice is the helper's only external dependency.
  const fn = new Function(
    'snapshot',
    `
      function isSessionInterruptNotice(t) { return String(t || '').indexOf('[interrupted]') === 0; }
      ${body}
      return collectUnansweredTrailingPrompts(snapshot);
    `,
  );
  return fn as (snapshot: unknown[]) => Array<{ text?: string }>;
}

const user = (text: string, extra: Record<string, unknown> = {}) => ({
  kind: 'message',
  role: 'user',
  text,
  ...extra,
});
const assistant = (text: string) => ({ kind: 'message', role: 'assistant', text });

suite('resumed transcript does not resurrect side-channel commands', () => {
  const collect = extractCollector();

  test('the three /a2a register commands are not collected', () => {
    const snapshot = [
      user('do the research'),
      assistant('working on it'),
      user('/a2a register local agent1', { sideChannel: true }),
      user('/a2a register local agent2', { sideChannel: true }),
      user('/a2a register local agent3', { sideChannel: true }),
    ];
    assert.deepStrictEqual(collect(snapshot), [], 'nothing should be re-rendered at the bottom');
  });

  test('without the flag they WOULD be collected — the bug being fixed', () => {
    const snapshot = [
      user('do the research'),
      assistant('working on it'),
      user('/a2a register local agent1'),
      user('/a2a register local agent2'),
      user('/a2a register local agent3'),
    ];
    assert.strictEqual(collect(snapshot).length, 3, 'unflagged entries reproduce the reported grouping');
  });

  test('a real in-flight prompt is still preserved', () => {
    // The whole point of the helper: a prompt sent just before the resume must
    // survive, or it is lost outright.
    const snapshot = [assistant('previous answer'), user('now do the next thing')];
    assert.deepStrictEqual(
      collect(snapshot).map((m) => m.text),
      ['now do the next thing'],
    );
  });

  test('a real prompt sitting BEFORE a side-channel command still survives', () => {
    // Requires skip-and-continue rather than stopping at the flagged entry.
    const snapshot = [
      assistant('previous answer'),
      user('now do the next thing'),
      user('/tools', { sideChannel: true }),
    ];
    assert.deepStrictEqual(
      collect(snapshot).map((m) => m.text),
      ['now do the next thing'],
    );
  });

  test('interrupt notices and blanks remain excluded', () => {
    const snapshot = [assistant('a'), user('[interrupted] something'), user('   ')];
    assert.deepStrictEqual(collect(snapshot), []);
  });
});

suite('the push site flags only turn-safe slash commands', () => {
  const src = fs.readFileSync(SOURCE, 'utf8');

  test('the flag is set from slashCommandRunsDuringTurn, not a bare slash test', () => {
    const at = src.indexOf('_lastHist.sideChannel = true;');
    assert.ok(at > 0, 'flag assignment not found');
    const block = src.slice(Math.max(0, at - 600), at);
    assert.ok(
      block.includes('slashCommandRunsDuringTurn(text, availableCommands)'),
      'turn-safety must decide the flag, so /goal <objective> keeps its protection',
    );
  });

  test('the collector consults the flag', () => {
    assert.ok(src.includes('if (item.sideChannel) continue;'), 'collector must skip flagged entries');
  });
});

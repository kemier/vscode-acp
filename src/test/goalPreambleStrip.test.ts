import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The machine-written goal preamble must not show in the user bubble.
 *
 * ericli turns a /goal command into the prompt
 *
 *   Please start working toward this goal now:
 *
 *   <objective>
 *
 * (acp-server pendingGoalPrompt) and persists THAT as the user message, so a
 * resumed session renders the preamble above the objective. The goal is already
 * shown in the goal chip, so the preamble is noise.
 *
 * Stripping is LEADING-ONLY, exactly like the [User interjection]: stripper. The
 * request that prompted this fix — "strip the goal prefix 'Please start working
 * toward this goal now'" — contains the marker mid-sentence and must survive.
 *
 * Unlike cleanUserMessage.test.ts, which reimplements the production logic and
 * carries a "when the production code changes, update this too" warning, this
 * EXTRACTS AND EXECUTES the real function, so it cannot drift.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

function loadStripLeadingGoalPrompt(): (text: string) => string {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const sig = 'function stripLeadingGoalPrompt(text) {';
  const at = src.indexOf(sig);
  assert.ok(at > 0, 'stripLeadingGoalPrompt not found in the webview literal');
  const open = src.indexOf('{', at);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') {depth++;}
    else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  assert.ok(end > 0, 'could not brace-match stripLeadingGoalPrompt');
  // Collapse escapes the way the template literal does before evaluating.
  const body = src.slice(at, end).replace(/\\\\/g, '\\');
  assert.ok(!body.includes('${'), `unresolved interpolation: ${body}`);
  return new Function('text', `${body}\nreturn stripLeadingGoalPrompt(text);`) as (t: string) => string;
}

const OBJECTIVE = 'check if missing topic from zhihu collection and add missing chaptres';
const PREAMBLE = 'Please start working toward this goal now:';

suite('goal preamble is stripped from the bubble', () => {
  const strip = loadStripLeadingGoalPrompt();

  test('the reported bubble shows only the objective', () => {
    assert.strictEqual(strip(PREAMBLE + '\n\n' + OBJECTIVE), OBJECTIVE);
  });

  test('handles CRLF and extra blank lines between preamble and objective', () => {
    assert.strictEqual(strip(PREAMBLE + '\r\n\r\n' + OBJECTIVE), OBJECTIVE);
    assert.strictEqual(strip(PREAMBLE + '\n\n\n\n' + OBJECTIVE), OBJECTIVE);
    assert.strictEqual(strip(PREAMBLE + ' ' + OBJECTIVE), OBJECTIVE);
  });

  test('leading whitespace before the preamble does not defeat it', () => {
    // Replay can leave a newline in front once context blocks are stripped.
    // The function preserves surrounding whitespace (like the interjection
    // stripper it mirrors); cleanUserMessage trims afterwards. Assert the
    // contract that matters: the objective is the only content left.
    assert.strictEqual(strip('\n\n' + PREAMBLE + '\n\n' + OBJECTIVE).trim(), OBJECTIVE);
    assert.strictEqual(strip('  ' + PREAMBLE + '\n' + OBJECTIVE).trim(), OBJECTIVE);
  });

  test('a mid-sentence occurrence is left alone', () => {
    // The request that asked for this fix.
    const asking = "strip the goal prefix '" + PREAMBLE + "' after resume";
    assert.strictEqual(strip(asking), asking);
    const quoted = 'the agent said ' + PREAMBLE + ' which I did not write';
    assert.strictEqual(strip(quoted), quoted);
  });

  test('an ordinary message is untouched', () => {
    for (const t of ['hello', '', 'Please start working', 'Please start working toward this goal']) {
      assert.strictEqual(strip(t), t, `should be unchanged: ${JSON.stringify(t)}`);
    }
  });

  test('null and undefined do not throw', () => {
    assert.strictEqual(strip(null as unknown as string), '');
    assert.strictEqual(strip(undefined as unknown as string), '');
  });

  test('only ONE preamble is consumed', () => {
    // Two preambles would mean the agent double-wrapped; keep the second visible
    // rather than silently swallowing text.
    const doubled = PREAMBLE + '\n\n' + PREAMBLE + '\n\n' + OBJECTIVE;
    assert.strictEqual(strip(doubled), PREAMBLE + '\n\n' + OBJECTIVE);
  });

  test('an objective that itself starts with the words is preserved', () => {
    // Objective text must never be eaten beyond the preamble itself.
    const tricky = PREAMBLE + '\n\n' + 'Please start working toward this goal now: really';
    assert.strictEqual(strip(tricky), 'Please start working toward this goal now: really');
  });
});

suite('cleanUserMessage applies the goal stripper', () => {
  const src = fs.readFileSync(SOURCE, 'utf8');

  test('it runs after the interjection stripper', () => {
    // A steered goal prompt arrives as "[User interjection]: Please start working…",
    // so the interjection marker must come off first or the preamble is not leading.
    const sig = 'function cleanUserMessage(rawText) {';
    const cleanAt = src.indexOf(sig);
    assert.ok(cleanAt > 0, 'cleanUserMessage not found');
    // Brace-match the function. A fixed-length window silently stops covering
    // the body as soon as it grows — it did exactly that while writing this test.
    const open = src.indexOf('{', cleanAt);
    let depth = 0;
    let end = -1;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') {depth++;}
      else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
    }
    assert.ok(end > 0, 'could not brace-match cleanUserMessage');
    const body = src.slice(cleanAt, end);
    const interjAt = body.indexOf("var interjMarker = '[User interjection]:';");
    const goalAt = body.indexOf('displayText = stripLeadingGoalPrompt(displayText);');
    assert.ok(interjAt > 0, 'interjection stripper not found in cleanUserMessage');
    assert.ok(goalAt > 0, 'cleanUserMessage does not call stripLeadingGoalPrompt');
    assert.ok(goalAt > interjAt, 'the goal stripper must run after the interjection stripper');
  });

  test('the marker matches what ericli actually emits', () => {
    // Guard against drift between the two repos: if ericli reworded the preamble
    // this test should be the thing that notices.
    const ericli = '/workspace/git/ezennin/ericli/src/acp/acp-server.ts';
    if (!fs.existsSync(ericli)) {
      return; // sibling checkout not present — nothing to compare against
    }
    const agent = fs.readFileSync(ericli, 'utf8');
    assert.ok(
      agent.includes('Please start working toward this goal now:'),
      'ericli no longer emits this preamble — update stripLeadingGoalPrompt',
    );
  });
});

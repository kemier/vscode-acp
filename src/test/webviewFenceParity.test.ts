import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { hasOpenFence as moduleHasOpenFence } from '../utils/markdownBalance';

/**
 * The webview's inlined hasOpenFence must agree with the module.
 *
 * There are TWO copies: src/utils/markdownBalance.ts and an inlined one in the webview
 * script (it runs in its own JS context, so it cannot import). Anchoring only the module
 * fixed the empty-code-fence artifact but left the real symptom untouched.
 *
 * The inlined copy gates the INTERIM commit at every tool boundary. That commit is what
 * interleaves text with tool rows and starts a fresh tools group — ensureTurnTools says
 * so directly: "Without this the next tool reuses the OLD wrapper, which sits BEFORE the
 * text we just committed." Matching any run regardless of position meant a message that
 * merely MENTIONED a fence (prose about moving a citation between two fences) deferred
 * every commit, so all text segments merged into one block with every tool row stacked
 * above them.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

/** Execute the webview's own inlined implementation. */
function extractWebviewHasOpenFence(): (t: string) => boolean {
  const src = fs.readFileSync(SOURCE, 'utf8').replace(/\r\n/g, '\n');
  const at = src.indexOf('function hasOpenFence(text) {');
  assert.ok(at > 0, 'inlined hasOpenFence not found');
  const end = src.indexOf('\n}', src.indexOf('return openLen > 0;', at)) + 2;
  const body = src.slice(at, end);
  return new Function('text', `${body}\n return hasOpenFence(text);`) as (t: string) => boolean;
}

const BT = '`'.repeat(3);

suite('webview and module fence detection agree', () => {
  const webview = extractWebviewHasOpenFence();

  const cases: Array<[string, string]> = [
    ['prose mentioning a fence mid-sentence', `move it between two ${BT} fences please`],
    ['prose with one mid-sentence run', `the closing ${BT} of the section`],
    ['a real open fence', `here:\n${BT}\ncode`],
    ['a closed fence', `${BT}js\nx\n${BT}`],
    ['indented 3 spaces (still a fence)', `here:\n   ${BT}\ncode`],
    ['indented 4 spaces (code, not a fence)', `here:\n    ${BT}\ncode`],
    ['no fence at all', 'plain prose'],
  ];

  for (const [name, text] of cases) {
    test(`${name}: both agree`, () => {
      assert.strictEqual(
        webview(text),
        moduleHasOpenFence(text),
        `divergence on: ${JSON.stringify(text)}`,
      );
    });
  }

  test('the reported prose does NOT defer the interim commit', () => {
    const reported = `there is a correct example at line 2100 where > Source: is OUTSIDE the code block (between two ${BT} fences).`;
    assert.strictEqual(webview(reported), false, 'must not be treated as an open fence');
  });

  test('the inlined copy is line-anchored', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    const at = src.indexOf('function hasOpenFence(text) {');
    const body = src.slice(at, at + 1800);
    assert.ok(body.includes("'^ {0,3}('"), 'must anchor to line start');
    assert.ok(body.includes("'gm'"), 'must use the multiline flag');
  });
});

/**
 * Option B contract: commitCurrentTextSegment must SIGNAL whether it committed
 * or deferred. The deferral path (text ends inside an open fence) must return
 * false so callers (addToolCall / ensureTurnTools) do NOT clear their reattach
 * anchors; a successful commit (or empty/whitespace cleanup) must return true.
 *
 * This is the fix for the "stray assistant block after the end-turn summary"
 * bug: the deferral used to be a bare `return`, and the callers unconditionally
 * cleared lastCommittedAssistantEl / messageSegmentCounter anyway. When the
 * commit was deferred the buffer was orphaned and the next chunk created a
 * fresh bubble while the open-fence text committed at promptEnd into a detached
 * element. The boolean return lets the callers conditionally clear.
 *
 * We cannot unit-test the webview function directly (it lives in a template
 * literal and closes over webview globals), so we assert the SOURCE contract:
 * the deferral path returns false, the commit path returns true, and both
 * callers consume the return value.
 */
suite('commitCurrentTextSegment deferral return-value contract', () => {
  const src = () => fs.readFileSync(SOURCE, 'utf8');

  function extractCommitFn(text: string): string {
    const at = text.indexOf('function commitCurrentTextSegment(opts) {');
    assert.ok(at >= 0, 'commitCurrentTextSegment not found');
    // The function ends at the next `function addToolCall(` opener (its sibling).
    const next = text.indexOf('function addToolCall(', at);
    assert.ok(next > at, 'addToolCall sibling not found after commitCurrentTextSegment');
    return text.slice(at, next);
  }

  test('deferral path returns false (open fence)', () => {
    const fn = extractCommitFn(src());
    const g = fn.indexOf('if (asInterim && !asInterrupted && hasOpenFence(currentAssistantText))');
    assert.ok(g >= 0, 'deferral guard not found');
    // Extract the full if-block by brace-matching from its opening { so the
    // window is exactly the deferral body (a fixed char count would miss the
    // return that follows the explanatory comment block).
    let depth = 0;
    let i = fn.indexOf('{', g);
    let end = -1;
    for (; i < fn.length; i++) {
      if (fn[i] === '{') {
        depth++;
      } else if (fn[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    assert.ok(end > i - 1, 'could not brace-match the deferral block');
    const block = fn.slice(g, end + 1);
    assert.ok(/return\s+false\s*;/.test(block), 'deferral must `return false` to signal the hold');
    assert.ok(!/return\s*;/m.test(block.replace(/return\s+false\s*;/g, '')), 'deferral must not be a bare `return;`');
  });

  test('commit path returns true', () => {
    const fn = extractCommitFn(src());
    // The success path (after the buffer is nulled) must return true.
    assert.ok(/currentAssistantText\s*=\s*'';/.test(fn), 'success path nulls the buffer');
    const afterNull = fn.slice(fn.indexOf("currentAssistantText = '';"));
    assert.ok(/return\s+true\s*;/.test(afterNull), 'commit path must `return true` after nulling the buffer');
  });

  test('addToolCall only clears reattach anchors on a committed segment', () => {
    const text = src();
    const at = text.indexOf('function addToolCall(toolCallId, title, status, content, rawInput, toolKind, locations, parentToolUseId) {');
    assert.ok(at >= 0, 'addToolCall not found');
    const fn = text.slice(at, at + 4000);
    // It must capture the return value and gate the anchor-clearing on it.
    assert.ok(/var\s+_committed\s*=\s*commitCurrentTextSegment\(\{\s*interim:\s*true\s*\}\)/.test(fn), 'addToolCall must capture commitCurrentTextSegment\'s return value');
    assert.ok(/if\s*\(\s*_committed\s*\)\s*{/.test(fn), 'addToolCall must gate the anchor reset on the committed flag');
  });

  test('ensureTurnTools only starts a new tools group on a committed segment', () => {
    const text = src();
    const at = text.indexOf('function ensureTurnTools() {');
    assert.ok(at >= 0, 'ensureTurnTools not found');
    const fn = text.slice(at, at + 3000);
    assert.ok(/var\s+_committedSeg\s*=\s*commitCurrentTextSegment\(\{\s*interim:\s*true\s*\}\)/.test(fn), 'ensureTurnTools must capture commitCurrentTextSegment\'s return value');
    assert.ok(/if\s*\(\s*_committedSeg\s*\)\s*{\s*currentToolsListEl\s*=\s*null;/.test(fn), 'ensureTurnTools must gate the fresh tools group on the committed flag');
  });
});

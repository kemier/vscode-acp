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

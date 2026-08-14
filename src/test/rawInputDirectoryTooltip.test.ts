import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Regression guard for the tooltip directory handling in `formatRawInput`
 * (inside the ChatWebviewProvider template literal, so it cannot be imported).
 *
 * The fix added a `rawInput.directory` branch ahead of the lone `rawInput.pattern`
 * / `rawInput.query` branches so that grep/search tools carrying a directory show
 * `dir\npattern: <pattern>` instead of just `<pattern>` (matching the existing
 * path-based branch). This test asserts the directory branch exists and mirrors
 * the path branch's shape (directory / directory+pattern / directory+query).
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

function formatRawInputSource(): string {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const startIdx = src.indexOf('function formatRawInput(rawInput) {');
  assert.ok(startIdx >= 0, 'formatRawInput not found in ChatWebviewProvider.ts');
  const endMarker = 'function formatStagesTooltipText(stages, crewTask) {';
  const endIdx = src.indexOf(endMarker, startIdx);
  assert.ok(endIdx > startIdx, 'formatStagesTooltipText boundary not found after formatRawInput');
  return src.slice(startIdx, endIdx);
}

suite('formatRawInput directory tooltip', () => {
  test('has a rawInput.directory branch', () => {
    const body = formatRawInputSource();
    assert.ok(
      body.indexOf("typeof rawInput.directory === 'string'") >= 0,
      'formatRawInput has no rawInput.directory branch',
    );
  });

  test('directory branch mirrors the path branch (dir + pattern / dir + query)', () => {
    const body = formatRawInputSource();
    const dirStart = body.indexOf("else if (typeof rawInput.directory === 'string'");
    assert.ok(dirStart >= 0, 'directory if-branch not found');
    // The webview template literal writes newlines as "\\n" (double backslash),
    // so the source contains two backslash chars before the "n".
    const patternMarker = '\\\\npattern: ';
    const queryMarker = '\\\\nquery: ';
    // After the directory branch begins, both the pattern and query sub-branches
    // must be present (mirroring the path branch's two sub-cases).
    assert.ok(body.indexOf(patternMarker, dirStart) >= 0, 'directory+pattern branch missing');
    assert.ok(body.indexOf(queryMarker, dirStart) >= 0, 'directory+query branch missing');
  });

  test('directory branch comes before the bare pattern fallback branch', () => {
    const body = formatRawInputSource();
    const dirIdx = body.indexOf("else if (typeof rawInput.directory === 'string'");
    // The last `typeof rawInput.pattern` is the top-level bare fallback (the
    // earlier matches are nested inside the path/directory branches).
    const barePatternIdx = body.lastIndexOf("else if (typeof rawInput.pattern === 'string'");
    assert.ok(dirIdx >= 0 && barePatternIdx >= 0, 'expected branches missing');
    assert.ok(dirIdx < barePatternIdx, 'directory branch must come before the bare pattern fallback');
  });
});

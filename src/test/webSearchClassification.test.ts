import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * A shell command that mentions "web_search" is not a web search.
 *
 * Reported: a collapsed block was labelled "2 web searches" when the turn actually ran
 * grep. isWebSearchToolCall ended with a substring fallback over the TITLE, and for
 * execute_command the title IS the command, so any command mentioning the phrase was
 * counted. The fold label described the haystack instead of the tool.
 *
 * The exact tool-name checks were always sound; only the human-readable fallback was
 * not. It now refuses anything carrying a shell command (rawInput.command) and anything
 * that looks like a command line rather than a label.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

/** Run the real classifier out of the webview source. */
function extractClassifier(): (title: string, rawInput?: unknown) => boolean {
  const src = fs.readFileSync(SOURCE, 'utf8').replace(/\r\n/g, '\n');
  const namesAt = src.indexOf('var webSearchToolNames = new Set([');
  assert.ok(namesAt > 0, 'webSearchToolNames not found');
  const namesEnd = src.indexOf(']);', namesAt) + 3;
  const fnAt = src.indexOf('function isWebSearchToolCall(title, rawInput) {');
  assert.ok(fnAt > 0, 'isWebSearchToolCall not found');
  const fnEnd = src.indexOf('\n  }', src.indexOf('return false;', fnAt)) + '\n  }'.length;
  const body = src.slice(namesAt, namesEnd) + '\n' + src.slice(fnAt, fnEnd);
  const fn = new Function('title', 'rawInput', `${body}\n return isWebSearchToolCall(title, rawInput);`);
  return fn as (title: string, rawInput?: unknown) => boolean;
}

const GREP_COMMAND =
  'cd /workspace/git/ezennin/ericli && grep -rn "web_search|webSearch" --include=*.ts ' +
  'src/core/native-tools.ts | head -6; echo "=== implementation file ==="; ' +
  'grep -rln "web_search" --include=*.ts src | head -5';

suite('web-search classification', () => {
  const isWebSearch = extractClassifier();

  test('the reported grep command is NOT a web search', () => {
    assert.strictEqual(isWebSearch(GREP_COMMAND, { command: GREP_COMMAND }), false);
  });

  test('rawInput.command rejects a command-shaped title that mentions the phrase', () => {
    // This is the real shape: execute_command sends the command as the title.
    assert.strictEqual(
      isWebSearch('grep -rn "web_search" src', { command: 'grep -rn "web_search" src' }),
      false,
    );
  });

  test('an EXACT tool name still wins over the command guard', () => {
    // Deliberate: the exact-name match is the strongest signal available, and a tool
    // literally named web_search is the web-search tool. Reordering the guard ahead of
    // it would risk mislabelling the genuine tool, which is the worse failure.
    assert.strictEqual(isWebSearch('web_search', { command: 'echo web_search' }), true);
  });

  test('the real ericli web_search tool is still detected', () => {
    assert.strictEqual(isWebSearch('web_search', { query: 'cuda graphs' }), true);
  });

  test('MCP provider variants are still detected', () => {
    for (const n of ['brave_web_search', 'tavily_search', 'duckduckgo_search', 'bing_search']) {
      assert.strictEqual(isWebSearch(n, {}), true, `${n} should classify as web search`);
    }
  });

  test('a descriptive label is still detected', () => {
    assert.strictEqual(isWebSearch('Web search: cuda graphs', {}), true);
  });

  test('a command-like title is not, even with no rawInput', () => {
    // Covers agents that send the command as the title and no rawInput at all.
    assert.strictEqual(isWebSearch(GREP_COMMAND, undefined), false);
    assert.strictEqual(isWebSearch('rg -n "web_search" src | head -5', undefined), false);
  });

  test('rawInput.toolName is still honoured', () => {
    assert.strictEqual(isWebSearch('Searching...', { _toolName: 'tavily_search' }), true);
  });
});

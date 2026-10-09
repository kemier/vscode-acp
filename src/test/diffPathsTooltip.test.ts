import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Regression guard for the Codex apply_patch hover-tooltip fix.
 *
 * Root cause: storeDiffContent() ran BEFORE addToolCallInline() created the
 * tool-call element, so `toolCalls[toolCallId]` (→ `tcEl`) was undefined and
 * the whole `if (tcEl) { tcEl._diffPaths = ...; markClickable(...) }` block
 * was skipped on the LIVE path. Result: hovering "Edit 3 files" on a fresh
 * Codex session showed NO tooltip (no file list), while the restored
 * (session/load) path happened to work because renderChatHistory re-applies
 * diffPaths after creating the element.
 *
 * Fix: storeDiffContent() now always stashes into toolCallDiffs[...] and
 * persists diffPaths to chatHistory, and a new applyStoredDiffContent()
 * re-applies them at every `toolCalls[toolCallId] = el` creation site.
 * The restore path (`item.diffPaths`) remains the reload-only safety net.
 *
 * These assertions run against the ChatWebviewProvider template-literal
 * source (the JS is not importable), mirroring rawInputDirectoryTooltip.test.ts.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

function sourceText(): string {
  // Normalize EOLs: with git core.autocrlf the working copy is CRLF on
  // Windows, which would break the '\n'-based markers below.
  return fs.readFileSync(SOURCE, 'utf8').replace(/\r\n/g, '\n');
}

suite('tool call diff-paths tooltip', () => {
  test('storeDiffContent stashes to toolCallDiffs even when tcEl is absent', () => {
    const body = sourceText();
    const fnStart = body.indexOf('function storeDiffContent(toolCallId, content, title, rawInput) {');
    assert.ok(fnStart >= 0, 'storeDiffContent not found');
    const fnEnd = body.indexOf('\n    function markClickable', fnStart);
    assert.ok(fnEnd > fnStart, 'storeDiffContent body boundary not found');
    const fnBody = body.slice(fnStart, fnEnd);
    // The stash must happen unconditionally (before any tcEl check), so a
    // live addToolCall() where the element does not exist yet still records
    // the paths for later application.
    assert.ok(
      fnBody.indexOf('toolCallDiffs[toolCallId] = diffs;') < fnBody.indexOf('if (tcEl) {'),
      'toolCallDiffs stash must precede the tcEl existence check',
    );
    // persist to chatHistory too (reload path)
    assert.ok(
      fnBody.indexOf('chatHistory[i].diffPaths = paths;') >= 0,
      'storeDiffContent must persist diffPaths into chatHistory',
    );
  });

  test('applyStoredDiffContent exists and is wired at every live creation site', () => {
    const body = sourceText();
    assert.ok(
      body.indexOf('function applyStoredDiffContent(el, toolCallId) {') >= 0,
      'applyStoredDiffContent helper not found',
    );
    // Every post-creation `toolCalls[toolCallId] = el;` in the addToolCallInline
    // family must be followed by the apply call.
    const sites = body.split('\n').filter((l) => l.indexOf('toolCalls[toolCallId] = el;') >= 0);
    assert.ok(sites.length >= 3, 'expected multiple toolCalls[toolCallId] = el sites, got ' + sites.length);
    for (const line of sites) {
      const lineNo = body.split('\n').indexOf(line);
      const window = body
        .split('\n')
        .slice(lineNo, lineNo + 4)
        .join('\n');
      assert.ok(
        window.indexOf('applyStoredDiffContent(el, toolCallId);') >= 0,
        'missing applyStoredDiffContent call after creation site at line ' + (lineNo + 1),
      );
    }
  });

  test('addToolCall live path calls storeDiffContent with the diff content', () => {
    const body = sourceText();
    const addTcStart = body.indexOf('function addToolCall(toolCallId, title, status, content, rawInput');
    assert.ok(addTcStart >= 0, 'addToolCall not found');
    const seg = body.slice(addTcStart, addTcStart + 9000);
    assert.ok(
      seg.indexOf('storeDiffContent(toolCallId, content, title, rawInput);') >= 0,
      'addToolCall must pass the raw diff content (and rawInput) to storeDiffContent',
    );
    assert.ok(
      seg.indexOf('toolCallDiffs[toolCallId]') >= 0 || seg.indexOf('applyStoredDiffContent') >= 0,
      'addToolCall must participate in the toolCallDiffs stash/apply flow',
    );
  });

  test('formatToolCallTooltipText renders the file list from diffPaths', () => {
    const body = sourceText();
    const fnStart = body.indexOf('function formatToolCallTooltipText(title, rawInput, locations, diffPaths) {');
    assert.ok(fnStart >= 0, 'formatToolCallTooltipText not found');
    const fnEnd = body.indexOf('function attachToolCallTooltip', fnStart);
    assert.ok(fnEnd > fnStart, 'formatToolCallTooltipText boundary not found');
    const fnBody = body.slice(fnStart, fnEnd);
    assert.ok(
      fnBody.indexOf('diffPaths && diffPaths.length > 0') >= 0,
      'tooltip must use diffPaths when rawInput is empty (apply_patch)',
    );
    // The "Files (N)": list format used for multi-file edits.
    assert.ok(
      fnBody.indexOf("'Files (' + fileList.length + '):\\\\n'") >= 0,
      'multi-file "Files (N)" list format missing',
    );
  });

  /**
   * diffFromRawInput is a webview-internal function (not importable), so we
   * extract its source from the template literal and evaluate it in a sandbox
   * to behaviorally test the ericli in-place edit_file shapes:
   *   {path, edits:[{oldText,newText}]}   (array form, the standard)
   *   {path, oldText, newText}             (flat single-edit form)
   * plus the "no usable data → []" cases. This is the fix for "clicking an
   * ericli Edit tool title does nothing" — the client now synthesizes a diff
   * from rawInput when the agent sent no type:"diff" content block.
   */
  function loadDiffFromRawInput() {
    const body = sourceText();
    const start = body.indexOf('function diffFromRawInput(rawInput, titlePath) {');
    assert.ok(start >= 0, 'diffFromRawInput not found in source');
    // Walk braces to find the matching close.
    let i = body.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (; i < body.length; i++) {
      if (body[i] === '{') depth++;
      else if (body[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    assert.ok(end > start, 'diffFromRawInput body boundary not found');
    const fnSrc = body.slice(start, end);
    return new Function('return ' + fnSrc)();
  }

  test('diffFromRawInput builds a diff from ericli edits[] array form', () => {
    const fn = loadDiffFromRawInput();
    const out = fn(
      { path: '/x/SKILL.md', edits: [{ oldText: 'A', newText: 'B' }] },
      'SKILL.md',
    );
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].path, '/x/SKILL.md');
    assert.strictEqual(out[0].oldText, 'A');
    assert.strictEqual(out[0].newText, 'B');
  });

  test('diffFromRawInput joins a multi-edit into a combined old/new', () => {
    const fn = loadDiffFromRawInput();
    const out = fn(
      { path: '/x/f.ts', edits: [{ oldText: 'A', newText: 'B' }, { oldText: 'C', newText: 'D' }] },
      '',
    );
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].oldText, 'A\\n\\nC');
    assert.strictEqual(out[0].newText, 'B\\n\\nD');
  });

  test('diffFromRawInput handles the flat {path, oldText, newText} form', () => {
    const fn = loadDiffFromRawInput();
    const out = fn({ path: '/x/f.ts', oldText: 'A', newText: 'B' }, '');
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].oldText, 'A');
    assert.strictEqual(out[0].newText, 'B');
  });

  test('diffFromRawInput falls back to titlePath when rawInput has no path', () => {
    const fn = loadDiffFromRawInput();
    const out = fn({ edits: [{ oldText: 'A', newText: 'B' }] }, 'fallback.ts');
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].path, 'fallback.ts');
  });

  test('diffFromRawInput returns [] with no path and no titlePath', () => {
    const fn = loadDiffFromRawInput();
    assert.deepStrictEqual(fn({ edits: [{ oldText: 'A', newText: 'B' }] }, ''), []);
  });

  test('diffFromRawInput returns [] for non-object / empty rawInput', () => {
    const fn = loadDiffFromRawInput();
    assert.deepStrictEqual(fn(null, 'x.ts'), []);
    assert.deepStrictEqual(fn(undefined, 'x.ts'), []);
    assert.deepStrictEqual(fn({}, 'x.ts'), []);
    assert.deepStrictEqual(fn({ path: '/x/f.ts', edits: [] }, ''), []);
  });
});

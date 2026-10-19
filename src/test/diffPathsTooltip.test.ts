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

  /**
   * capDiffData (host-side saveState helper) caps a persisted diff's
   * oldText+newText so a large write_file doesn't bloat vscode.getState().
   * It's host-side (not the webview template) so it's extractable directly:
   * we pull the function source and evaluate it with DIFF_DATA_MAX_CHARS
   * injected. Returns the item unchanged when the diff is already under the
   * cap, and truncates newText (larger share) + oldText (rest) otherwise.
   */
  function loadCapDiffData() {
    const body = sourceText();
    const start = body.indexOf('function capDiffData(item) {');
    assert.ok(start >= 0, 'capDiffData not found in source');
    let i = body.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (; i < body.length; i++) {
      if (body[i] === '{') depth++;
      else if (body[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    assert.ok(end > start, 'capDiffData body boundary not found');
    const fnSrc = body.slice(start, end);
    return new Function('DIFF_DATA_MAX_CHARS', 'return ' + fnSrc)(16384);
  }

  test('capDiffData leaves a small diff untouched', () => {
    const fn = loadCapDiffData();
    const item = { kind: 'toolCall', diffData: [{ path: '/x/f.ts', oldText: 'A', newText: 'B' }] };
    const out = fn(item);
    assert.strictEqual(out.diffData[0].oldText, 'A');
    assert.strictEqual(out.diffData[0].newText, 'B');
  });

  test('capDiffData truncates an oversized diff and keeps path intact', () => {
    const fn = loadCapDiffData();
    const bigOld = 'x'.repeat(20000);
    const bigNew = 'y'.repeat(20000);
    const item = { kind: 'toolCall', diffData: [{ path: '/x/big.ts', oldText: bigOld, newText: bigNew }] };
    const out = fn(item);
    assert.strictEqual(out.diffData[0].path, '/x/big.ts');
    assert.ok(out.diffData[0].oldText.length < bigOld.length, 'oldText truncated');
    assert.ok(out.diffData[0].newText.length < bigNew.length, 'newText truncated');
    assert.ok(
      out.diffData[0].oldText.length + out.diffData[0].newText.length <= 16384,
      'combined text under the cap',
    );
  });

  test('capDiffData returns the item unchanged when there is no diffData', () => {
    const fn = loadCapDiffData();
    const item = { kind: 'toolCall', rawInput: {} };
    assert.strictEqual(fn(item), item);
  });

  test('storeDiffContent persists diffData alongside diffPaths on chatHistory', () => {
    const body = sourceText();
    const fnStart = body.indexOf('function storeDiffContent(toolCallId, content, title, rawInput) {');
    assert.ok(fnStart >= 0, 'storeDiffContent not found');
    const fnEnd = body.indexOf('\n    function diffFromRawInput', fnStart);
    assert.ok(fnEnd > fnStart, 'storeDiffContent body boundary not found');
    const fnBody = body.slice(fnStart, fnEnd);
    assert.ok(
      fnBody.indexOf('chatHistory[i].diffPaths = paths;') >= 0,
      'must still persist diffPaths (tooltip)',
    );
    assert.ok(
      fnBody.indexOf('chatHistory[i].diffData = diffs;') >= 0,
      'must persist full diffData so icon+click survive a bare restart',
    );
  });

  test('saveState caps diffData via capDiffData', () => {
    const body = sourceText();
    assert.ok(
      body.indexOf('function capDiffData(item) {') >= 0,
      'capDiffData helper not found',
    );
    const ssStart = body.indexOf('function saveState() {');
    assert.ok(ssStart >= 0, 'saveState not found');
    const ssBody = body.slice(ssStart, ssStart + 3000);
    assert.ok(
      ssBody.indexOf('capDiffData(') >= 0,
      'saveState must cap diffData before persisting',
    );
  });

  test('restore path re-populates toolCallDiffs from diffData before addToolCallInline', () => {
    const body = sourceText();
    // The restore case 'toolCall' must set toolCallDiffs[item.toolCallId] from
    // item.diffData BEFORE addToolCallInline runs, so applyStoredDiffContent
    // (called inside addToolCallInline) re-attaches the icon + click.
    const caseStart = body.indexOf("case 'toolCall': {");
    assert.ok(caseStart >= 0, "restore case 'toolCall' not found");
    const seg = body.slice(caseStart, caseStart + 1200);
    const repopIdx = seg.indexOf('toolCallDiffs[item.toolCallId] = item.diffData;');
    const addIdx = seg.indexOf('addToolCallInline(item.toolCallId');
    assert.ok(repopIdx >= 0, 'restore path must repopulate toolCallDiffs from diffData');
    assert.ok(addIdx >= 0, 'restore path must call addToolCallInline');
    assert.ok(repopIdx < addIdx, 'toolCallDiffs repopulation must precede addToolCallInline');
  });
});

suite('collapsed fold title tooltip', () => {
  test('summary title hover does not list every tool', () => {
    const body = sourceText();
    const fnStart = body.indexOf('function showTurnSummaryTooltipAt(');
    assert.ok(fnStart >= 0, 'showTurnSummaryTooltipAt not found');
    const fnEnd = body.indexOf('function attachTurnSummaryTooltip(', fnStart);
    assert.ok(fnEnd > fnStart, 'showTurnSummaryTooltipAt body boundary not found');
    const fnBody = body.slice(fnStart, fnEnd);
    assert.ok(
      fnBody.indexOf('formatTurnSummaryPathList') < 0,
      'collapsed title hover must not build the per-tool path list',
    );
    assert.ok(
      fnBody.indexOf("style.display = 'block'") < 0,
      'collapsed title hover must not open the tooltip',
    );
    assert.ok(fnBody.indexOf('hideTcTooltip()') >= 0, 'hover should dismiss a tool tooltip');
    // Collapsed rows used to forward the hover onto that same list.
    const rowStart = body.indexOf('function attachToolCallTooltip(el) {');
    const rowEnd = body.indexOf('var title = (el._toolTitle', rowStart);
    const rowHead = body.slice(rowStart, rowEnd);
    assert.ok(rowHead.indexOf('formatTurnSummaryPathList') < 0);
    assert.ok(rowHead.indexOf('getTurnSummaryEl') < 0);
  });
});

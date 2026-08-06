import * as assert from 'assert';

/**
 * Standalone reimplementation of the multi-line tool-call title cleaning
 * logic from ChatWebviewProvider.addToolCallInline(), for testing without
 * webview/vscode deps. This mirrors the exact logic used in production code
 * (the block guarded by `if (_dt.indexOf('\n') >= 0)`). When the production
 * code changes, update this too.
 *
 * Behaviour:
 *  - Single-line titles pass through unchanged (no '\n').
 *  - Multi-line titles collect non-comment, non-empty lines and JOIN them
 *    with ' && ' so a "cd <dir>\n<real cmd>" shell script shows the whole
 *    chain instead of just the bare `cd` preamble.
 *  - The joined form is capped at 120 chars with '...'. We deliberately do
 *    NOT fall back to the first line when the join is long — that would
 *    re-hide the real command behind a bare "cd", which is the exact bug
 *    this fixes.
 *
 * NOTE: in the webview, this JS is embedded in a TS template literal, so
 * regex/string escapes there use doubled backslashes (e.g. '\\n'). Here in
 * a real TS module the literal newline escape is '\n'. The logic is
 * otherwise identical.
 */
function cleanToolCallTitle(title: string | null | undefined): string {
  let displayTitle = title || 'Tool Call';
  const _dt = String(displayTitle);
  if (_dt.indexOf('\n') >= 0) {
    const _dtLines = _dt.split('\n');
    const _meaningful: string[] = [];
    for (let _li = 0; _li < _dtLines.length; _li++) {
      const _line = _dtLines[_li].trim();
      if (_line && !_line.startsWith('#') && !_line.startsWith('//')) {
        _meaningful.push(_line);
      }
    }
    const _joined = _meaningful.join(' && ');
    const _cleanedTitle = _joined;
    if (_cleanedTitle) {
      displayTitle = _cleanedTitle.length > 120 ? _cleanedTitle.substring(0, 117) + '...' : _cleanedTitle;
    }
  }
  return displayTitle;
}

suite('cleanToolCallTitle (multi-line shell command titles)', () => {
  // --- Single-line titles: pass through unchanged ---

  test('plain single-line title is unchanged', () => {
    assert.strictEqual(cleanToolCallTitle('Reading /path/file.ts'), 'Reading /path/file.ts');
  });

  test('single-line cd && git chain is unchanged', () => {
    const t = 'cd /workspace/repo && git log --oneline -20';
    assert.strictEqual(cleanToolCallTitle(t), t);
  });

  test('single-line title with 120 chars is unchanged', () => {
    const t = 'x'.repeat(120);
    assert.strictEqual(cleanToolCallTitle(t), t);
  });

  test('single-line title over 120 chars is NOT truncated (cap only applies post-clean)', () => {
    // No newline -> the cleaning block is skipped entirely -> no 120 cap.
    const t = 'y'.repeat(200);
    assert.strictEqual(cleanToolCallTitle(t), t);
  });

  test('null/undefined/empty falls back to "Tool Call"', () => {
    assert.strictEqual(cleanToolCallTitle(null), 'Tool Call');
    assert.strictEqual(cleanToolCallTitle(undefined), 'Tool Call');
    assert.strictEqual(cleanToolCallTitle(''), 'Tool Call');
  });

  // --- The reported bug: bare "cd <dir>" line 1 hides the real command ---

  test('REPORTED CASE: "cd xxx\\n<cmd>" shows both, not just cd', () => {
    // Before the fix this rendered as "cd /a" — the user saw only half the
    // command. Now the chain is visible.
    const input = 'Running: cd /workspace/git/ezennin/vepg/epg\ngit log --oneline -5';
    assert.strictEqual(
      cleanToolCallTitle(input),
      'Running: cd /workspace/git/ezennin/vepg/epg && git log --oneline -5'
    );
  });

  test('REPORTED CASE (exact log): kiro "Running: cd build/...\\nLD_LIBRARY_PATH=... ./elf"', () => {
    const input =
      'Running: cd build/Linux_x86_64.clang/bin/context-listener_SUITE\n' +
      'LD_LIBRARY_PATH=$PWD/../../lib ./context-listener_SUITE_Linux_x86_64.clang.elf 2>&1 | tail -n 5';
    // Joined form exceeds 120 chars -> truncated, but the real command
    // (LD_LIBRARY_PATH=... ./elf) is now visible instead of being hidden
    // behind a bare "cd build/.../context-listener_SUITE".
    const joined =
      'Running: cd build/Linux_x86_64.clang/bin/context-listener_SUITE && LD_LIBRARY_PATH=$PWD/../../lib ./context-listener_SUITE_Linux_x86_64.clang.elf 2>&1 | tail -n 5';
    const expected = joined.substring(0, 117) + '...';
    assert.strictEqual(cleanToolCallTitle(input), expected);
  });

  test('bare "cd xxx yyyy" (the user phrasing) with newline keeps the second line', () => {
    // The user described the symptom as: "only showed cd xxx in 'cd xxx yyyy'".
    // A two-token second line must survive.
    const input = 'cd xxx\nyyyy';
    assert.strictEqual(cleanToolCallTitle(input), 'cd xxx && yyyy');
  });

  // --- Comment-led titles (original intent of the cleaner) ---

  test('comment-led title: first line is "# ..." -> skip to next line, join rest', () => {
    // Original behaviour took only the first non-comment line. Now we join all
    // meaningful lines, so a comment header is dropped and the commands chain.
    const input = '# Find latest logs\nfind . -name "*.log" | tail -5';
    assert.strictEqual(
      cleanToolCallTitle(input),
      'find . -name "*.log" | tail -5'
    );
  });

  test('comment plus two command lines: both commands joined', () => {
    const input = '# header\ncd /a\ngit status';
    assert.strictEqual(cleanToolCallTitle(input), 'cd /a && git status');
  });

  test('// style comment is also skipped', () => {
    const input = '// preamble\necho hi';
    assert.strictEqual(cleanToolCallTitle(input), 'echo hi');
  });

  // --- Multi-line with more than 2 meaningful lines ---

  test('three-line script: cd + echo + real cmd all joined', () => {
    const input = 'cd /workspace/repo\necho "=== section ==="\ngit log --oneline -5';
    assert.strictEqual(
      cleanToolCallTitle(input),
      'cd /workspace/repo && echo "=== section ===" && git log --oneline -5'
    );
  });

  test('blank lines between commands are dropped', () => {
    const input = 'cd /a\n\necho hi\n\nls';
    assert.strictEqual(cleanToolCallTitle(input), 'cd /a && echo hi && ls');
  });

  test('leading/trailing whitespace on lines is trimmed before join', () => {
    const input = '  cd /a  \n   echo hi   ';
    assert.strictEqual(cleanToolCallTitle(input), 'cd /a && echo hi');
  });

  // --- Length cap & fallback ---

  test('joined form under 120 chars is used verbatim', () => {
    const line1 = 'cd /a';
    const line2 = 'b'.repeat(100); // 5 + 4 + 100 = 109 incl. ' && '
    const input = line1 + '\n' + line2;
    assert.strictEqual(cleanToolCallTitle(input), line1 + ' && ' + line2);
  });

  test('joined form exactly 120 chars is used (boundary)', () => {
    // 5 + 4 + 111 = 120 (' && ' is 4 chars)
    const line1 = 'cd /a';
    const line2 = 'b'.repeat(111);
    const input = line1 + '\n' + line2;
    assert.strictEqual(cleanToolCallTitle(input), line1 + ' && ' + line2);
  });

  test('joined form over 120 chars is truncated with ... (NOT fallen back to first line)', () => {
    // Falling back to the first line ("cd /a") would re-hide the real command
    // — the exact bug we fixed. Instead the join is truncated so the start of
    // the meaningful command stays visible.
    const line1 = 'cd /a';
    const line2 = 'b'.repeat(112); // 5 + 4 + 112 = 121
    const input = line1 + '\n' + line2;
    const joined = line1 + ' && ' + line2;
    const expected = joined.substring(0, 117) + '...';
    assert.strictEqual(cleanToolCallTitle(input), expected);
  });

  test('first meaningful line itself over 120 chars is truncated with ...', () => {
    const line1 = 'z'.repeat(200);
    const input = line1 + '\n' + 'short'; // joined way over 120 -> truncated
    const expected = (line1 + ' && short').substring(0, 117) + '...';
    assert.strictEqual(cleanToolCallTitle(input), expected);
  });

  test('long control-flow script is truncated, not fallen back to first line', () => {
    // A for-loop script: joining with ' && ' is semantically lossy, but
    // truncating the join is still better than showing only the bare first
    // line (which hid the real work). The join is capped at 120 chars.
    const input =
      'for s in context-listener_SUITE context-listener_UPSFTSUITE; do\n' +
      '  setup_workspace run_test build/$s 2>&1 | tail -n 5\n' +
      'done';
    const joined =
      'for s in context-listener_SUITE context-listener_UPSFTSUITE; do && setup_workspace run_test build/$s 2>&1 | tail -n 5 && done';
    const expected = joined.substring(0, 117) + '...';
    assert.strictEqual(cleanToolCallTitle(input), expected);
  });

  // --- Edge cases ---

  test('all-comment multi-line title falls back to original (no meaningful lines)', () => {
    // _meaningful is empty -> _joined = '' -> _first = '' -> _cleanedTitle = ''
    // -> the `if (_cleanedTitle)` guard fails -> displayTitle stays as input.
    const input = '# only a comment\n# another comment';
    assert.strictEqual(cleanToolCallTitle(input), input);
  });

  test('only blank lines falls back to original', () => {
    const input = '\n\n  \n';
    assert.strictEqual(cleanToolCallTitle(input), input);
  });

  test('trailing newline only does not mangle a single-line title', () => {
    // "cd /a\n" -> one meaningful line "cd /a", joined = "cd /a" (<=120) -> used.
    const input = 'cd /a\n';
    assert.strictEqual(cleanToolCallTitle(input), 'cd /a');
  });

  test('Running: prefix is preserved (not stripped by this function)', () => {
    // Stripping "Running:" is a separate concern; the cleaner must not drop it.
    const input = 'Running: cd /a\necho hi';
    assert.strictEqual(cleanToolCallTitle(input), 'Running: cd /a && echo hi');
  });

  test('real kiro jira-skill backup title joins, then truncates over 120', () => {
    const input =
      'Running: cd /home/ezennin/.kiro/skills\n' +
      'tar czf /home/ezennin/.kiro/skills/jira-skill.backup-$(date +%Y%m%d-%H%M%S).tar.gz jira-skill\n' +
      'ls -la jira-skill.backup-*.tar.gz | tail -2';
    const joined =
      'Running: cd /home/ezennin/.kiro/skills && tar czf /home/ezennin/.kiro/skills/jira-skill.backup-$(date +%Y%m%d-%H%M%S).tar.gz jira-skill && ls -la jira-skill.backup-*.tar.gz | tail -2';
    const expected = joined.substring(0, 117) + '...';
    assert.strictEqual(cleanToolCallTitle(input), expected);
  });
});

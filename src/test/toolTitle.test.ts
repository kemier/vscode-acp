import * as assert from 'assert';

import { cleanAgentToolTitle, stripShellPrefix } from '../utils/toolTitle';

/**
 * Tool-call title normalization.
 *
 * Kiro CLI labels shell tool calls `Running: <cmd>`, and agents often wrap the
 * command in a login shell and/or a `cd <dir> &&` preamble, so the fold row read
 * `Running: cd /workspace/git/... && grep -n foo` with the real command pushed
 * off the end.
 *
 * The `cd` semantics deliberately match codex-acp's `stripShellPrefix`: the `cd`
 * is KEPT when it targets the session cwd (it documents where the command ran)
 * and STRIPPED when it points elsewhere.
 */
suite('tool-call title normalization', () => {
  const CWD = '/workspace/git/ezennin/vscode-acp';

  test("drops Kiro's Running: label", () => {
    assert.strictEqual(cleanAgentToolTitle('Running: npm test'), 'npm test');
    assert.strictEqual(cleanAgentToolTitle('Running:\tnpm test'), 'npm test');
    // Multiple spaces after the colon collapse with the label.
    assert.strictEqual(cleanAgentToolTitle('Running:   ls -la'), 'ls -la');
  });

  test('leaves titles without the label untouched', () => {
    assert.strictEqual(cleanAgentToolTitle('npm test'), 'npm test');
    assert.strictEqual(cleanAgentToolTitle("Read file 'a.ts'"), "Read file 'a.ts'");
    // "Running" without the colon is a real command word, not the label.
    assert.strictEqual(cleanAgentToolTitle('Running tests now'), 'Running tests now');
  });

  test('never returns an empty title', () => {
    assert.strictEqual(cleanAgentToolTitle('Running: '), 'Running: ');
    assert.strictEqual(cleanAgentToolTitle(''), '');
    assert.strictEqual(cleanAgentToolTitle(null), '');
    assert.strictEqual(cleanAgentToolTitle(undefined), '');
  });

  test('strips a cd preamble that points outside the session cwd', () => {
    assert.strictEqual(cleanAgentToolTitle('Running: cd /tmp && ls -la', CWD), 'ls -la');
    assert.strictEqual(cleanAgentToolTitle('cd /tmp && ls -la', CWD), 'ls -la');
    assert.strictEqual(cleanAgentToolTitle('cd /tmp\nls -la', CWD), 'ls -la');
  });

  test('keeps a cd preamble that targets the session cwd', () => {
    assert.strictEqual(
      cleanAgentToolTitle(`Running: cd ${CWD} && npm test`, CWD),
      `cd ${CWD} && npm test`,
    );
    assert.strictEqual(cleanAgentToolTitle(`cd ${CWD}/ && npm test`, CWD), `cd ${CWD}/ && npm test`);
  });

  test('strips the cd preamble when no cwd is known', () => {
    assert.strictEqual(cleanAgentToolTitle('Running: cd /anywhere && npm test'), 'npm test');
  });

  test('a bare cd with no command is left alone', () => {
    assert.strictEqual(cleanAgentToolTitle('Running: cd /tmp', CWD), 'cd /tmp');
    assert.strictEqual(stripShellPrefix('cd /tmp'), 'cd /tmp');
  });

  test('unwraps a login-shell wrapper', () => {
    assert.strictEqual(stripShellPrefix("bash -lc 'cd /tmp && ls -la'", CWD), 'ls -la');
    assert.strictEqual(stripShellPrefix("/bin/bash -c 'npm test'"), 'npm test');
    assert.strictEqual(stripShellPrefix("bash -c 'cd /workspace && ls'", '/workspace'), 'cd /workspace && ls');
  });

  test('is idempotent, so an already-normalized Codex title is unchanged', () => {
    const once = cleanAgentToolTitle('Running: cd /tmp && grep -n foo src/a.ts', CWD);
    assert.strictEqual(cleanAgentToolTitle(once, CWD), once);
    const kept = cleanAgentToolTitle(`cd ${CWD} && npm test`, CWD);
    assert.strictEqual(cleanAgentToolTitle(kept, CWD), kept);
  });

  test('multi-line commands keep their body (Kiro heredocs)', () => {
    const heredoc = "Running: python3 - <<'PY'\nimport os\nprint(os.getcwd())";
    assert.strictEqual(cleanAgentToolTitle(heredoc, CWD), "python3 - <<'PY'\nimport os\nprint(os.getcwd())");
  });

  test('a stripped cd keeps the trailing lines of a multi-line command', () => {
    assert.strictEqual(cleanAgentToolTitle('cd /tmp && echo one\necho two', CWD), 'echo one\necho two');
  });

  // Kiro CLI replays shell tool calls with the tool NAME as the title, so the
  // command lives only in rawInput. Without substituting here, the webview's own
  // bare-title fallback re-inserts the RAW command and the `cd` survives — which
  // is what still showed `cd <other-worktree> && grep …` on resume.
  suite('bare tool name + rawInput command', () => {
    test('substitutes the command and strips a foreign cd', () => {
      assert.strictEqual(
        cleanAgentToolTitle('shell', CWD, {
          command: 'cd /workspace/git/ezennin/vscode-acp-a2a-memory && grep -n "^import" src/x.ts',
        }),
        'grep -n "^import" src/x.ts',
      );
    });

    test('keeps a cd that targets the session cwd', () => {
      assert.strictEqual(
        cleanAgentToolTitle('shell', CWD, { command: `cd ${CWD} && npm test` }),
        `cd ${CWD} && npm test`,
      );
    });

    test('handles the legacy arguments.cmd / arguments.command shapes', () => {
      assert.strictEqual(
        cleanAgentToolTitle('exec_command', CWD, { arguments: { cmd: 'cd /tmp && ls' } }),
        'ls',
      );
      assert.strictEqual(
        cleanAgentToolTitle('shell_command', CWD, { arguments: { command: 'cd /tmp && ls' } }),
        'ls',
      );
    });

    test('array command form is joined', () => {
      assert.strictEqual(cleanAgentToolTitle('shell', CWD, { command: ['ls', '-la'] }), 'ls -la');
    });

    test('a real command title is never replaced by rawInput', () => {
      // Has whitespace, so it is a description — not a bare tool name.
      assert.strictEqual(
        cleanAgentToolTitle('npm test', CWD, { command: 'cd /tmp && something-else' }),
        'npm test',
      );
    });

    test('bare name with no usable rawInput is left alone', () => {
      assert.strictEqual(cleanAgentToolTitle('shell', CWD), 'shell');
      assert.strictEqual(cleanAgentToolTitle('shell', CWD, {}), 'shell');
      assert.strictEqual(cleanAgentToolTitle('read', CWD, { path: '/a/b.ts' }), 'read');
    });
  });
});

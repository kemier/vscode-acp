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

  test('strips the cd even when it targets the session cwd', () => {
    // The session already runs there — announcing it in a one-line title is noise.
    assert.strictEqual(cleanAgentToolTitle(`Running: cd ${CWD} && npm test`, CWD), 'npm test');
    assert.strictEqual(cleanAgentToolTitle(`cd ${CWD}/ && npm test`, CWD), 'npm test');
    assert.strictEqual(cleanAgentToolTitle(`cd ${CWD}; npm test`, CWD), 'npm test');
  });

  test('keeps a cd into a subdirectory, rewritten relative to the cwd', () => {
    assert.strictEqual(cleanAgentToolTitle(`cd ${CWD}/src/ui && npm test`, CWD), 'cd src/ui && npm test');
    assert.strictEqual(
      cleanAgentToolTitle(`Running: cd ${CWD}/scripts; node deploy-all.js`, CWD),
      'cd scripts; node deploy-all.js',
    );
    // Newline form keeps the relative cd on its own line.
    assert.strictEqual(
      cleanAgentToolTitle(`cd ${CWD}/scripts\nnode deploy-all.js`, CWD),
      'cd scripts\nnode deploy-all.js',
    );
  });

  test('a sibling repo is still stripped — it is not inside the cwd', () => {
    assert.strictEqual(
      cleanAgentToolTitle('cd /workspace/git/ezennin/vscode-acp-a2a-memory; grep -n foo src/x.ts', CWD),
      'grep -n foo src/x.ts',
    );
  });

  test('a semicolon-separated cd preamble is treated like &&', () => {
    // Kiro CLI emits the `;` form; only `&&` was handled, so a whole
    // "cd /other/repo; grep …" preamble stayed in the fold title.
    assert.strictEqual(
      cleanAgentToolTitle(
        'cd /workspace/git/ezennin/vscode-acp-a2a-memory; grep -n "suppressFoldOrdering" src/ui/ChatWebviewProvider.ts | cut -c1-150',
        CWD,
      ),
      'grep -n "suppressFoldOrdering" src/ui/ChatWebviewProvider.ts | cut -c1-150',
    );
    assert.strictEqual(cleanAgentToolTitle('Running: cd /tmp;ls -la', CWD), 'ls -la');
    // …and the cwd form is stripped for `;` exactly as for `&&`.
    assert.strictEqual(cleanAgentToolTitle(`cd ${CWD}; npm test`, CWD), 'npm test');
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
    // The cd targets the cwd itself → stripped along with the shell wrapper.
    assert.strictEqual(stripShellPrefix("bash -c 'cd /workspace && ls'", '/workspace'), 'ls');
    // A subdirectory of the cwd survives, relative.
    assert.strictEqual(stripShellPrefix("bash -c 'cd /workspace/src && ls'", '/workspace'), 'cd src && ls');
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

    test('drops a cd that targets the session cwd, keeps a subdirectory', () => {
      assert.strictEqual(cleanAgentToolTitle('shell', CWD, { command: `cd ${CWD} && npm test` }), 'npm test');
      assert.strictEqual(
        cleanAgentToolTitle('shell', CWD, { command: `cd ${CWD}/src/test && npm test` }),
        'cd src/test && npm test',
      );
    });

    test('handles the legacy arguments.cmd / arguments.command shapes', () => {
      assert.strictEqual(cleanAgentToolTitle('exec_command', CWD, { arguments: { cmd: 'cd /tmp && ls' } }), 'ls');
      assert.strictEqual(cleanAgentToolTitle('shell_command', CWD, { arguments: { command: 'cd /tmp && ls' } }), 'ls');
    });

    test('array command form is joined', () => {
      assert.strictEqual(cleanAgentToolTitle('shell', CWD, { command: ['ls', '-la'] }), 'ls -la');
    });

    test('a real command title is never replaced by rawInput', () => {
      // Has whitespace, so it is a description — not a bare tool name.
      assert.strictEqual(cleanAgentToolTitle('npm test', CWD, { command: 'cd /tmp && something-else' }), 'npm test');
    });

    test('bare name with no usable rawInput is left alone', () => {
      assert.strictEqual(cleanAgentToolTitle('shell', CWD), 'shell');
      assert.strictEqual(cleanAgentToolTitle('shell', CWD, {}), 'shell');
      // A write sub-verb is not a shell command and must not become the title.
      assert.strictEqual(cleanAgentToolTitle('write', CWD, { command: 'strReplace' }), 'write');
    });
  });

  /**
   * Kiro streams rich titles ("Reading foo.ts:10-40", "Editing foo.ts") but
   * replays the bare tool name on session/load, so a resumed row showed "read"
   * or — worse — the write sub-verb "create". Rebuild the live wording from
   * rawInput.
   */
  suite('bare tool name + rawInput paths (resume)', () => {
    test('read operations become the live Reading wording', () => {
      assert.strictEqual(
        cleanAgentToolTitle('read', CWD, {
          operations: [{ mode: 'Line', path: '/w/src/ui/ChatWebviewProvider.ts', offset: 1960, limit: 60 }],
        }),
        'Reading ChatWebviewProvider.ts:1961-2020',
      );
    });

    test('multiple read operations are comma-joined', () => {
      assert.strictEqual(
        cleanAgentToolTitle('read', CWD, {
          operations: [
            { mode: 'Line', path: '/w/a.ts', offset: 0, limit: 10 },
            { mode: 'Directory', path: '/w/src' },
          ],
        }),
        'Reading a.ts:1-10, src',
      );
    });

    test('image reads fall back to basenames', () => {
      assert.strictEqual(
        cleanAgentToolTitle('read', CWD, { operations: [{ mode: 'Image', image_paths: ['/w/shot.png'] }] }),
        'Reading shot.png',
      );
    });

    test('write strReplace/insert become Editing <file>', () => {
      assert.strictEqual(
        cleanAgentToolTitle('write', CWD, { command: 'strReplace', path: '/w/src/Logger.ts' }),
        'Editing Logger.ts',
      );
      assert.strictEqual(
        cleanAgentToolTitle('write', CWD, { command: 'insert', path: '/w/src/Logger.ts' }),
        'Editing Logger.ts',
      );
    });

    test('write create becomes Creating <file>', () => {
      assert.strictEqual(
        cleanAgentToolTitle('write', CWD, { command: 'create', path: '/w/src/New.ts' }),
        'Creating New.ts',
      );
    });

    test('a path with no verb still beats the bare tool name', () => {
      assert.strictEqual(cleanAgentToolTitle('read', CWD, { path: '/a/b.ts' }), 'b.ts');
    });

    test('a real shell command still wins over path derivation', () => {
      assert.strictEqual(
        cleanAgentToolTitle('shell', CWD, { command: 'grep -n foo bar.ts', path: '/a/b.ts' }),
        'grep -n foo bar.ts',
      );
    });
  });
});

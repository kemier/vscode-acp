import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Tests for the webview message-queue decision helpers.
 *
 * The queue logic lives inside ChatWebviewProvider's single HTML template
 * literal and cannot be imported. Following the established pattern from
 * foldOrdering.test.ts / cleanUserMessage.test.ts, we extract the REAL
 * functions verbatim from the source so they can never drift from production.
 *
 * Requirements under test (see docs/QUEUE-BEHAVIOR.md):
 *   1. Every message typed while a turn is processing is queued — it is never
 *      steered mid-turn and never dropped.
 *   2. Queued messages drain strictly FIFO, ONE per agent turn.
 *   3. In the transition tick (sendPrompt posted, promptStart not yet
 *      received) a new message is queued, never sent concurrently.
 *   4. Local slash commands that do not start a turn (/rename, /ps, /stop,
 *      /session) chain the NEXT queued message immediately; commands that do
 *      start a turn (/compact, /clear) make the next message wait.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

/**
 * The queue helpers live inside ChatWebviewProvider's single HTML template
 * literal, so the SHIPPED script is not the raw .ts text: the template literal
 * processes escape sequences at runtime (`\\/` becomes `/`, `\\n` newline,
 * etc.). Evaluating the raw source would silently diverge from production —
 * a single-backslash regex like `/^\/(compact...)/` reads fine in raw .ts but
 * collapses to `/^/(compact...)/` in the emitted webview and crashes it with
 * 'Invalid or unexpected token'.
 *
 * To test what ACTUALLY runs, unescape a double backslash to a single one,
 * mimicking the template literal's escape processing. Plain text and regex
 * character classes without escapes are unaffected, so this is exact for the
 * two helpers under test. This unescaping is a deliberate mirror of the
 * runtime behaviour, NOT a general regex-altering transform — the regex in
 * this source block stays the same shape as the source file's array of
 * slash-commands.
 */
function asRenderedWebview(srcText: string): string {
  return srcText.replace(/\\\\/g, '\\');
}

function extractFunction(name: string, deps: string[] = []): (...args: any[]) => any {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const slice = (fnName: string): string => {
    const startIdx = src.indexOf('function ' + fnName + '(');
    assert.ok(startIdx >= 0, fnName + ' not found in ChatWebviewProvider.ts');
    const bodyStart = src.indexOf('{', startIdx);
    let depth = 1;
    let i = bodyStart + 1;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '{') {
        depth++;
      } else if (src[i] === '}') {
        depth--;
      }
    }
    return src.slice(startIdx, i);
  };
  // Helper functions the extracted one calls are declared first, so the
  // returned function resolves them.
  const preamble = deps.map((d) => asRenderedWebview(slice(d))).join('\n');
  return new Function(
    preamble + '\nreturn (' + asRenderedWebview(slice(name)) + ')',
  )() as (...args: any[]) => any;
}

suite('webview template-literal escape parity', () => {
  test('queue helpers render to valid JavaScript under template-literal unescaping', () => {
    // The helpers live in a template literal: the webview executes the
    // ESCAPE-PROCESSED text, not the raw .ts. A single-backslash regex in the
    // source (e.g. /^\/clear\b/) collapses to /^/clear b/ in the emitted
    // script and crashes the whole webview with 'Invalid or unexpected token'.
    // This test proves the fix: after doubling every backslash, the rendered
    // form is parseable and behaves identically.
    const src = fs.readFileSync(SOURCE, 'utf8');
    for (const name of ['queueIsMutatingCommand', 'queueDrainStartedTurn', 'agentSupportsSteering', 'slashCommandRunsDuringTurn', 'commandListHasCommand', 'turnSafeDeclaration', 'parseSubcommandHints', 'subcommandHintsForCommand']) {
      const startIdx = src.indexOf('function ' + name + '(');
      assert.ok(startIdx >= 0, name + ' not found in ChatWebviewProvider.ts');
      const bodyStart = src.indexOf('{', startIdx);
      let depth = 1;
      let i = bodyStart + 1;
      for (; i < src.length && depth > 0; i++) {
        if (src[i] === '{') {
          depth++;
        } else if (src[i] === '}') {
          depth--;
        }
      }
      const fnSrc = src.slice(startIdx, i);
      const rendered = asRenderedWebview(fnSrc);
      assert.doesNotThrow(
        () => new Function('return (' + rendered + ')'),
        `${name} must render to valid JS inside the webview template literal`,
      );
    }
  });
});

suite('messageQueue.queueIsMutatingCommand', () => {
  const queueIsMutatingCommand = extractFunction('queueIsMutatingCommand');

  test('compaction commands are mutating', () => {
    assert.strictEqual(queueIsMutatingCommand('/compact'), true);
    assert.strictEqual(queueIsMutatingCommand('/summarize'), true);
    assert.strictEqual(queueIsMutatingCommand('/compress now'), true);
    assert.strictEqual(queueIsMutatingCommand('/COMPACT'), true);
  });

  test('/clear is mutating', () => {
    assert.strictEqual(queueIsMutatingCommand('/clear'), true);
  });

  test('/index build variants are mutating', () => {
    assert.strictEqual(queueIsMutatingCommand('/index build'), true);
    assert.strictEqual(queueIsMutatingCommand('/index rebuild foo'), true);
    assert.strictEqual(queueIsMutatingCommand('/index refresh'), true);
    assert.strictEqual(queueIsMutatingCommand('/index update'), true);
    assert.strictEqual(queueIsMutatingCommand('/index embed'), true);
    assert.strictEqual(queueIsMutatingCommand('/index clear'), true);
    assert.strictEqual(queueIsMutatingCommand('/index delete'), true);
  });

  test('read-only and ordinary messages are NOT mutating', () => {
    assert.strictEqual(queueIsMutatingCommand('/ps'), false);
    assert.strictEqual(queueIsMutatingCommand('/status'), false);
    assert.strictEqual(queueIsMutatingCommand('/rename foo'), false);
    assert.strictEqual(queueIsMutatingCommand('/session old'), false);
    assert.strictEqual(queueIsMutatingCommand('/stop'), false);
    assert.strictEqual(queueIsMutatingCommand('fix the bug'), false);
    // A mutation word mid-sentence is not a command.
    assert.strictEqual(queueIsMutatingCommand('please clear the cache'), false);
  });
});

suite('messageQueue.queueDrainStartedTurn', () => {
  const queueDrainStartedTurn = extractFunction('queueDrainStartedTurn');

  test('a drained message sent as a prompt starts a turn', () => {
    assert.strictEqual(queueDrainStartedTurn(false, false, false), true);
  });

  test('a local slash command that set isProcessing starts a turn', () => {
    assert.strictEqual(queueDrainStartedTurn(true, true, true), true);
  });

  test('a local slash command that stayed idle does NOT start a turn', () => {
    assert.strictEqual(queueDrainStartedTurn(true, false, false), false);
  });

  test('defensive: anything still processing counts as a started turn', () => {
    assert.strictEqual(queueDrainStartedTurn(true, false, true), true);
  });
});

suite('messageQueue.agentSupportsSteering', () => {
  const agentSupportsSteering = extractFunction('agentSupportsSteering');

  test('Option B: every agent is deferred-queue (steering disabled)', () => {
    // Option B disables mid-turn steering for ALL agents via agentSupportsSteering.
    // Mid-turn messages are queued FIFO and drained after the current turn's
    // promptEnd (auto-steer uses a separate gate).
    assert.strictEqual(agentSupportsSteering('Codex CLI'), false);
    assert.strictEqual(agentSupportsSteering('codex-acp'), false);
    assert.strictEqual(agentSupportsSteering('claude-code'), false);
    assert.strictEqual(agentSupportsSteering('Kiro'), false);
    assert.strictEqual(agentSupportsSteering(''), false);
    assert.strictEqual(agentSupportsSteering(undefined), false);
  });
});

/**
 * Which slash commands may be sent while a turn is streaming.
 *
 * handleSend used to exempt EVERY slash command from the send queue:
 *
 *   if (isProcessing && !text.startsWith('/')) { handleQueue(); return; }
 *
 * That exemption was added for read-only commands, but it also let mutating ones
 * straight into a live turn — including /compact and /clear, which return false
 * from handleLocalSlashCommand while isProcessing precisely so the caller WOULD
 * queue them.
 *
 * The decision comes ONLY from the agent's own _meta.turnSafe declaration. A
 * hardcoded name-keyed table used to back this up and was removed as unsound:
 * command names are not portable between agents. /tools exists only on ericli;
 * /skills is a read-only listing on ericli and codex-acp, but codex-acp's
 * isReadOnlyCommand covers only ps/status so anything else interrupts the turn;
 * and /goal resume flips a flag on ericli while codex-acp's resumeGoal() STARTS a
 * turn. Guessing from the name destroys the user's streaming answer.
 */
suite('messageQueue.slashCommandRunsDuringTurn', () => {
  const slashCommandRunsDuringTurn = extractFunction('slashCommandRunsDuringTurn', [
    'turnSafeDeclaration',
  ]);

  // ericli's advertised shapes, from turnSafeMetaFor() in acp-server.ts.
  const ERICLI = [
    { name: 'tools', _meta: { turnSafe: true } },
    { name: 'stats', _meta: { turnSafe: true } },
    { name: 'usage', _meta: { turnSafe: true } },
    { name: 'diagnose', _meta: { turnSafe: true } },
    { name: 'ps', _meta: { turnSafe: true } },
    { name: 'a2a', _meta: { turnSafe: ['', 'list', 'help', 'inspect', 'status', 'register', 'cancel'] } },
    { name: 'skills', _meta: { turnSafe: ['', 'list', 'info', 'search', 'paths', 'help'] } },
    { name: 'index', _meta: { turnSafe: ['', 'status', 'search', 'query'] } },
    { name: 'goal', _meta: { turnSafe: { exactArgs: ['', 'clear', 'stop', 'off', 'reset', 'none', 'cancel', 'pause', 'resume'] } } },
    { name: 'clear' },
    { name: 'compact' },
  ];

  test('declared read-only whole commands run during a turn', () => {
    for (const cmd of ['/tools', '/stats', '/usage', '/diagnose', '/ps']) {
      assert.strictEqual(slashCommandRunsDuringTurn(cmd, ERICLI), true, cmd);
    }
  });

  test('declared read-only subcommands run during a turn', () => {
    for (const cmd of [
      '/a2a',
      '/a2a list',
      '/a2a help',
      '/a2a inspect http://host:41241',
      '/a2a status task-7',
      '/a2a register http://host:41241',
      '/a2a register local test1',
      '/a2a cancel task-7',
      '/skills',
      '/skills list',
      '/skills info commit-message',
      '/index status',
      '/index search authenticate',
    ]) {
      assert.strictEqual(slashCommandRunsDuringTurn(cmd, ERICLI), true, cmd);
    }
  });

  test('history-mutating commands are queued', () => {
    for (const cmd of ['/compact', '/summarize', '/compress now', '/clear']) {
      assert.strictEqual(slashCommandRunsDuringTurn(cmd, ERICLI), false, cmd);
    }
  });

  test('state-rebuilding subcommands are queued', () => {
    for (const cmd of [
      '/index build',
      '/index rebuild',
      '/index refresh',
      '/index update',
      '/index embed',
      '/index clear',
      '/skills reload',
    ]) {
      assert.strictEqual(slashCommandRunsDuringTurn(cmd, ERICLI), false, cmd);
    }
  });

  test('only a2a call and unregister are queued', () => {
    for (const cmd of ['/a2a call reviewer "audit this diff"', '/a2a unregister helper']) {
      assert.strictEqual(slashCommandRunsDuringTurn(cmd, ERICLI), false, cmd);
    }
  });

  test('/goal control forms run during a turn, objectives are queued', () => {
    for (const cmd of [
      '/goal', '/goal clear', '/goal stop', '/goal off', '/goal reset',
      '/goal none', '/goal cancel', '/goal pause', '/goal resume', '/goal PAUSE',
    ]) {
      assert.strictEqual(slashCommandRunsDuringTurn(cmd, ERICLI), true, cmd);
    }
    for (const cmd of [
      '/goal ship the release',
      '/goal pause the deployment',
      '/goal clear the backlog',
      '/goal resume after lunch',
    ]) {
      assert.strictEqual(slashCommandRunsDuringTurn(cmd, ERICLI), false, cmd);
    }
  });

  test('unknown and undeclared commands are queued', () => {
    assert.strictEqual(slashCommandRunsDuringTurn('/notacommand', ERICLI), false);
    assert.strictEqual(slashCommandRunsDuringTurn('/a2a frobnicate', ERICLI), false);
    assert.strictEqual(slashCommandRunsDuringTurn('/index vacuum', ERICLI), false);
    assert.strictEqual(slashCommandRunsDuringTurn('/$imagegen a cat', ERICLI), false);
  });

  test('an agent that declares NOTHING gets everything queued', () => {
    // codex-acp / claude-code-acp / pi-acp today. Safe failure: the command
    // still runs, just after the turn, with a visible queue chip. Guessing from
    // the name would interrupt their turns — codex-acp's /goal resume starts a
    // turn, and /tools is not even a command there.
    const undeclared = [{ name: 'ps' }, { name: 'status' }, { name: 'goal' }, { name: 'skills' }];
    for (const cmd of ['/ps', '/status', '/goal resume', '/skills', '/tools']) {
      assert.strictEqual(slashCommandRunsDuringTurn(cmd, undeclared), false, cmd);
    }
  });

  test('non-slash input is not a slash command', () => {
    assert.strictEqual(slashCommandRunsDuringTurn('fix the bug', ERICLI), false);
    assert.strictEqual(slashCommandRunsDuringTurn('', ERICLI), false);
    assert.strictEqual(slashCommandRunsDuringTurn(undefined, ERICLI), false);
  });

  test('is case-insensitive on command and subcommand', () => {
    assert.strictEqual(slashCommandRunsDuringTurn('/TOOLS', ERICLI), true);
    assert.strictEqual(slashCommandRunsDuringTurn('/A2A List', ERICLI), true);
    assert.strictEqual(slashCommandRunsDuringTurn('/INDEX BUILD', ERICLI), false);
  });

  test('classifies on the first line, ignoring the appended memory block', () => {
    const memory = '\nvscode-acp:///memory/ericli\n<context ref="vscode-acp:///memory/ericli">';
    assert.strictEqual(slashCommandRunsDuringTurn('/a2a list' + memory, ERICLI), true);
    assert.strictEqual(slashCommandRunsDuringTurn('/tools' + memory, ERICLI), true);
    assert.strictEqual(slashCommandRunsDuringTurn('/index build' + memory, ERICLI), false);
    assert.strictEqual(slashCommandRunsDuringTurn('/clear' + memory, ERICLI), false);
  });
});

/**
 * Agent-declared turn safety (AvailableCommand._meta.turnSafe).
 *
 * The built-in table above cannot scale: it names ericli's commands, so every
 * new ACP agent would need it extended by hand. ACP reserves `_meta` on
 * AvailableCommand for agent-supplied metadata, so an agent declares its own
 * read-only commands and the client just reads them — the table drops to a
 * compatibility fallback for agents that do not declare (codex-acp,
 * claude-code-acp today).
 *
 * ericli derives the declared value from the same tables its dispatch uses (see
 * turnSafeMetaFor in src/acp/acp-server.ts), so the wire value and the agent's
 * behaviour cannot drift.
 */
suite('messageQueue.turnSafeDeclaration', () => {
  const turnSafeDeclaration = extractFunction('turnSafeDeclaration');

  test('reads a whole-command declaration', () => {
    const cmds = [{ name: 'frobnicate', _meta: { turnSafe: true } }];
    assert.strictEqual(turnSafeDeclaration('frobnicate', cmds), true);
  });

  test('reads a subcommand-list declaration', () => {
    const cmds = [{ name: 'widget', _meta: { turnSafe: ['', 'list', 'show'] } }];
    assert.deepStrictEqual(turnSafeDeclaration('widget', cmds), { subs: ['', 'list', 'show'] });
  });

  test('reads an exactArgs declaration', () => {
    // For commands whose WHOLE argument decides — /goal in ericli.
    const cmds = [{ name: 'goal', _meta: { turnSafe: { exactArgs: ['', 'pause', 'resume'] } } }];
    assert.deepStrictEqual(turnSafeDeclaration('goal', cmds), { exact: ['', 'pause', 'resume'] });
  });

  test('returns null when the agent declares nothing, so the caller falls back', () => {
    assert.strictEqual(turnSafeDeclaration('ps', [{ name: 'ps' }]), null);
    assert.strictEqual(turnSafeDeclaration('ps', [{ name: 'ps', _meta: {} }]), null);
    assert.strictEqual(turnSafeDeclaration('ps', [{ name: 'ps', _meta: null }]), null);
  });

  test('returns null for an unknown command or empty list', () => {
    assert.strictEqual(turnSafeDeclaration('nope', [{ name: 'ps', _meta: { turnSafe: true } }]), null);
    assert.strictEqual(turnSafeDeclaration('ps', []), null);
    assert.strictEqual(turnSafeDeclaration('ps', null), null);
    assert.strictEqual(turnSafeDeclaration('', [{ name: 'ps', _meta: { turnSafe: true } }]), null);
  });

  test('tolerates a leading slash, mixed case and malformed entries', () => {
    const cmds = [null, {}, { name: null }, { name: '/PS', _meta: { turnSafe: true } }];
    assert.strictEqual(turnSafeDeclaration('/ps', cmds as any), true);
  });

  test('a non-boolean, non-array declaration is ignored rather than trusted', () => {
    // Implementations MUST NOT make assumptions about _meta values (ACP).
    assert.strictEqual(turnSafeDeclaration('x', [{ name: 'x', _meta: { turnSafe: 'yes' } }]), null);
    assert.strictEqual(turnSafeDeclaration('x', [{ name: 'x', _meta: { turnSafe: 1 } }]), null);
    assert.strictEqual(turnSafeDeclaration('x', [{ name: 'x', _meta: { turnSafe: false } }]), null);
  });
});

suite('slashCommandRunsDuringTurn honours the agent declaration', () => {
  const slashCommandRunsDuringTurn = extractFunction('slashCommandRunsDuringTurn', [
    'turnSafeDeclaration',
  ]);

  test('an agent-only command works with NO entry in the built-in table', () => {
    // The whole point: a future agent's command needs no client change.
    const cmds = [{ name: 'inspect-cluster', _meta: { turnSafe: true } }];
    assert.strictEqual(slashCommandRunsDuringTurn('/inspect-cluster', cmds), true);
    // Same command, undeclared → queued, because the table has never heard of it.
    assert.strictEqual(slashCommandRunsDuringTurn('/inspect-cluster', [{ name: 'inspect-cluster' }]), false);
  });

  test('a declared subcommand list is applied per subcommand', () => {
    const cmds = [{ name: 'db', _meta: { turnSafe: ['', 'status', 'show'] } }];
    assert.strictEqual(slashCommandRunsDuringTurn('/db', cmds), true);
    assert.strictEqual(slashCommandRunsDuringTurn('/db status', cmds), true);
    assert.strictEqual(slashCommandRunsDuringTurn('/db SHOW', cmds), true);
    assert.strictEqual(slashCommandRunsDuringTurn('/db migrate', cmds), false);
  });

  test('the declaration overrides the built-in table in BOTH directions', () => {
    // An agent whose /tools is expensive can say so, and we must believe it.
    assert.strictEqual(
      slashCommandRunsDuringTurn('/tools', [{ name: 'tools', _meta: { turnSafe: [] } }]),
      false,
    );
    // An agent whose /clear is genuinely read-only likewise.
    assert.strictEqual(
      slashCommandRunsDuringTurn('/clear', [{ name: 'clear', _meta: { turnSafe: true } }]),
      true,
    );
  });

  test('ericli-shaped declarations reproduce the table exactly', () => {
    // Verbatim shapes from ericli's turnSafeMetaFor().
    const ericli = [
      { name: 'tools', _meta: { turnSafe: true } },
      { name: 'ps', _meta: { turnSafe: true } },
      { name: 'a2a', _meta: { turnSafe: ['', 'list', 'help', 'inspect', 'status', 'register', 'cancel'] } },
      { name: 'index', _meta: { turnSafe: ['', 'status', 'search', 'query'] } },
      { name: 'clear' },
      { name: 'compact' },
    ];
    assert.strictEqual(slashCommandRunsDuringTurn('/tools', ericli), true);
    assert.strictEqual(slashCommandRunsDuringTurn('/a2a list', ericli), true);
    assert.strictEqual(slashCommandRunsDuringTurn('/a2a register local x', ericli), true);
    assert.strictEqual(slashCommandRunsDuringTurn('/a2a call bot "go"', ericli), false);
    assert.strictEqual(slashCommandRunsDuringTurn('/index search foo', ericli), true);
    assert.strictEqual(slashCommandRunsDuringTurn('/index build', ericli), false);
    assert.strictEqual(slashCommandRunsDuringTurn('/clear', ericli), false);
    assert.strictEqual(slashCommandRunsDuringTurn('/compact', ericli), false);
  });

  test('a DECLARED exactArgs list closes the same trap', () => {
    // The agent path must match the whole argument too, not just the first token.
    const cmds = [
      { name: 'goal', _meta: { turnSafe: { exactArgs: ['', 'pause', 'resume', 'clear'] } } },
    ];
    assert.strictEqual(slashCommandRunsDuringTurn('/goal pause', cmds), true);
    assert.strictEqual(slashCommandRunsDuringTurn('/goal', cmds), true);
    assert.strictEqual(slashCommandRunsDuringTurn('/goal pause the deployment', cmds), false);
    assert.strictEqual(slashCommandRunsDuringTurn('/goal ship it', cmds), false);
  });

  test('the memory block appended by the host does not defeat the declaration', () => {
    const cmds = [{ name: 'a2a', _meta: { turnSafe: ['', 'list'] } }];
    assert.strictEqual(
      slashCommandRunsDuringTurn('/a2a list\nvscode-acp:///memory/ericli', cmds),
      true,
    );
    assert.strictEqual(
      slashCommandRunsDuringTurn('/a2a call bot "go"\nvscode-acp:///memory/ericli', cmds),
      false,
    );
  });
});

suite('handleSend queues everything except turn-safe slash commands', () => {
  test('the send gate consults slashCommandRunsDuringTurn', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    assert.ok(
      src.includes(
        "if (isProcessing && (!text.startsWith('/') || !slashCommandRunsDuringTurn(text, availableCommands))) {",
      ),
      'handleSend must queue a mid-turn slash command unless it is turn-safe, and must ' +
        "pass the agent's advertised commands so _meta.turnSafe is honoured. The old " +
        "blanket `!text.startsWith('/')` exemption sent /compact, /clear and /index build " +
        'straight into the streaming turn.',
    );
  });

  test('the blanket slash exemption is gone', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    assert.ok(
      !src.includes("if (isProcessing && !text.startsWith('/')) {"),
      'the unconditional slash-command bypass must not come back',
    );
  });

  test('the Enter key path does not duplicate the decision', () => {
    // There were TWO send paths. The Enter handler had its own isProcessing
    // branch that called handleQueue() for every agent slash command and never
    // reached handleSend(), so the _meta.turnSafe gate was dead code for it:
    // "/a2a register local agent1" sat in the queue even though ericli
    // advertised a2a -> turnSafe: [… "register" …]. Exactly one place decides.
    const src = fs.readFileSync(SOURCE, 'utf8');
    const enterAt = src.indexOf("if (e.key === 'Enter' && !e.shiftKey) {");
    assert.ok(enterAt >= 0, 'Enter handler not found');
    // The isProcessing branch inside the Enter handler.
    const branchAt = src.indexOf('if (isProcessing) {', enterAt);
    assert.ok(branchAt > enterAt, 'Enter handler isProcessing branch not found');
    const branch = src.slice(branchAt, src.indexOf('\n    }', branchAt));
    assert.ok(
      branch.includes('handleSend();'),
      'the Enter path must delegate to handleSend(), which owns the turn-safe gate',
    );
    assert.ok(
      !branch.includes('handleQueue();'),
      'the Enter path must NOT queue directly — that bypasses the _meta.turnSafe gate',
    );
  });
});

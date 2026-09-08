import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Subcommand autocomplete for any command that advertises subcommands.
 *
 * Typing `/a2a register` showed no popup at all. The autocomplete had exactly
 * three shapes:
 *   - no space yet          → filter command names
 *   - `/session <partial>`  → session names
 *   - `/goal <partial>`     → a HARDCODED [clear, pause, resume] table
 * and everything else fell into `// Other slash commands with args — close
 * popup`. So /a2a, /index and /skills had no argument help, even though ericli
 * publishes the full subcommand list AND its argument shapes in the command
 * description.
 *
 * ACP's AvailableCommand is only { name, description, input } with a single
 * free-text `input.hint`, so agents use a "Sub: a, b <arg>, c" convention inside
 * the description. These tests pin the parser against ericli's real strings,
 * copied verbatim from getAvailableCommands() in src/acp/acp-server.ts.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

/** See messageQueue.test.ts — the webview executes the escape-processed text. */
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
  // Dependencies are declared first so the returned function can call them.
  const preamble = deps.map((d) => asRenderedWebview(slice(d))).join('\n');
  return new Function(
    preamble + '\nreturn (' + asRenderedWebview(slice(name)) + ')',
  )() as (...args: any[]) => any;
}

// Verbatim from ericli src/acp/acp-server.ts getAvailableCommands().
const ERICLI_A2A_DESC =
  'Manage A2A (Agent2Agent) delegation. Sub: list, register <url> [as <name>], ' +
  'register local <name>, unregister <name>, call <name> "<task>", inspect <url>, ' +
  'status [taskId], cancel <taskId>.';
const ERICLI_INDEX_DESC =
  'Build, embed, search, or check status of the codebase index. Sub: build, embed, ' +
  'search <query>, status, clear.';
const ERICLI_SKILLS_DESC =
  'Manage skills. Sub: list, info <name>, search <query>, reload, paths, help.';

suite('parseSubcommandHints', () => {
  const parseSubcommandHints = extractFunction('parseSubcommandHints');

  test('parses /a2a — the case that showed nothing', () => {
    const subs = parseSubcommandHints(ERICLI_A2A_DESC);
    assert.deepStrictEqual(
      subs.map((s: any) => s.name),
      [
        'list',
        'register',
        'register local',
        'unregister',
        'call',
        'inspect',
        'status',
        'cancel',
      ],
    );
  });

  test('keeps the argument shape as the row description', () => {
    const subs = parseSubcommandHints(ERICLI_A2A_DESC);
    const register = subs.find((s: any) => s.name === 'register');
    assert.strictEqual(register.description, 'register <url> [as <name>]');
    const call = subs.find((s: any) => s.name === 'call');
    assert.strictEqual(call.description, 'call <name> "<task>"');
  });

  test('distinguishes "register" from the two-word "register local"', () => {
    const subs = parseSubcommandHints(ERICLI_A2A_DESC);
    const local = subs.find((s: any) => s.name === 'register local');
    assert.ok(local, '"register local" must be its own row, not deduped away');
    assert.strictEqual(local.description, 'register local <name>');
  });

  test('flags which subcommands still need an argument', () => {
    const subs = parseSubcommandHints(ERICLI_A2A_DESC);
    const byName: Record<string, any> = {};
    for (const s of subs) {
      byName[s.name] = s;
    }
    // Complete as typed — Enter may send.
    assert.strictEqual(byName['list'].takesArgs, false);
    // Still needs input — Enter must only fill the text.
    assert.strictEqual(byName['register'].takesArgs, true);
    assert.strictEqual(byName['call'].takesArgs, true);
    assert.strictEqual(byName['status'].takesArgs, true);
  });

  test('parses /index and /skills', () => {
    assert.deepStrictEqual(
      parseSubcommandHints(ERICLI_INDEX_DESC).map((s: any) => s.name),
      ['build', 'embed', 'search', 'status', 'clear'],
    );
    assert.deepStrictEqual(
      parseSubcommandHints(ERICLI_SKILLS_DESC).map((s: any) => s.name),
      ['list', 'info', 'search', 'reload', 'paths', 'help'],
    );
  });

  test('strips only the trailing sentence period', () => {
    const subs = parseSubcommandHints(ERICLI_INDEX_DESC);
    assert.strictEqual(subs[subs.length - 1].name, 'clear');
    assert.strictEqual(subs[subs.length - 1].description, 'clear');
  });

  test('returns nothing when the description has no Sub: list', () => {
    assert.deepStrictEqual(parseSubcommandHints('Clear the conversation history.'), []);
    assert.deepStrictEqual(parseSubcommandHints(''), []);
    assert.deepStrictEqual(parseSubcommandHints(undefined), []);
    assert.deepStrictEqual(parseSubcommandHints(null), []);
  });

  test('does not fire on the word "sub" inside prose', () => {
    // \b...Sub: requires the colon form, so "subscribe" / "subagent" are safe.
    assert.deepStrictEqual(parseSubcommandHints('Manage subagents and subscriptions.'), []);
  });

  test('ignores entries that are pure placeholders', () => {
    assert.deepStrictEqual(
      parseSubcommandHints('X. Sub: <objective>, clear').map((s: any) => s.name),
      ['clear'],
    );
  });
});

suite('subcommandHintsForCommand', () => {
  const subcommandHintsForCommand = extractFunction('subcommandHintsForCommand', [
    'parseSubcommandHints',
  ]);

  const ERICLI_COMMANDS = [
    { name: 'compact', description: 'Summarize conversation to avoid hitting the context limit.', input: null },
    { name: 'index', description: ERICLI_INDEX_DESC, input: { hint: 'e.g. /index build' } },
    { name: 'a2a', description: ERICLI_A2A_DESC, input: { hint: 'e.g. /a2a list, /a2a register http://host:port' } },
    { name: 'goal', description: 'Set a goal to keep pursuing.', input: { hint: '[<objective>|clear|pause|resume]' } },
    { name: 'skills', description: ERICLI_SKILLS_DESC, input: { hint: 'e.g. /skills list' } },
  ];

  test('resolves the Sub: list for a matching command', () => {
    const subs = subcommandHintsForCommand('a2a', ERICLI_COMMANDS);
    assert.ok(subs.length > 1);
    assert.strictEqual(subs[0].name, 'list');
  });

  test('tolerates a leading slash and mixed case on the typed name', () => {
    assert.ok(subcommandHintsForCommand('/a2a', ERICLI_COMMANDS).length > 1);
    assert.ok(subcommandHintsForCommand('A2A', ERICLI_COMMANDS).length > 1);
  });

  test('falls back to the free-text hint as a single non-insertable row', () => {
    // /goal has an input hint but no "Sub:" list.
    const subs = subcommandHintsForCommand('goal', ERICLI_COMMANDS);
    assert.strictEqual(subs.length, 1);
    assert.strictEqual(subs[0].name, '', 'a hint-only row must not be insertable');
    assert.strictEqual(subs[0].description, '[<objective>|clear|pause|resume]');
  });

  test('returns nothing for a command with neither Sub: nor a hint', () => {
    assert.deepStrictEqual(subcommandHintsForCommand('compact', ERICLI_COMMANDS), []);
  });

  test('returns nothing for an unknown command or empty list', () => {
    assert.deepStrictEqual(subcommandHintsForCommand('nope', ERICLI_COMMANDS), []);
    assert.deepStrictEqual(subcommandHintsForCommand('a2a', []), []);
    assert.deepStrictEqual(subcommandHintsForCommand('a2a', null), []);
    assert.deepStrictEqual(subcommandHintsForCommand('', ERICLI_COMMANDS), []);
  });

  test('survives malformed command entries', () => {
    assert.deepStrictEqual(
      subcommandHintsForCommand('a2a', [null, {}, { name: null }] as any),
      [],
    );
  });
});

suite('the autocomplete wires the generic subcommand path', () => {
  const src = fs.readFileSync(SOURCE, 'utf8');

  test('the args fallthrough offers subcommands instead of closing the popup', () => {
    assert.ok(
      src.includes('subcommandHintsForCommand(argCmd, getMergedCommands())'),
      'the "other slash commands with args" branch must resolve subcommands',
    );
    assert.ok(
      !src.includes('// Other slash commands with args — close popup'),
      'the close-popup fallthrough must be gone',
    );
  });

  test('inserts against the typed command, not a hardcoded /goal', () => {
    assert.ok(
      src.includes("promptInput.value = '/' + subcommandParentCmd + ' ' + sc.name"),
      'the keyboard insert path must use the tracked parent command',
    );
    assert.ok(
      !src.includes("promptInput.value = '/goal ' + sc.name;"),
      'the hardcoded /goal insert must be gone',
    );
  });

  test('Enter only sends when the subcommand needs no further argument', () => {
    assert.ok(
      src.includes("if (e.key === 'Enter' && !sc.takesArgs) {"),
      'Enter must not send "/a2a register", which still needs a URL',
    );
  });

  test('/goal still sets itself as the parent so its table keeps working', () => {
    assert.ok(src.includes("subcommandParentCmd = 'goal';"));
  });
});

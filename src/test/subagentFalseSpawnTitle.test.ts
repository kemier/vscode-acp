import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { decodeTemplate } from './templateDecode';

/**
 * A shell command that merely MENTIONS spawning an agent is not a subagent spawn.
 *
 * The subagent predicates match on substrings of the tool-call title, which is right
 * for a tool name and wrong for a command line. Grepping a log for the phrase
 * "Spawning agent" produced a false "spawned 1 subagent" crew card with a generic
 * "Subagent 1" stage, in a session where no spawn tool was called at all — and the
 * agent-side state agreed: zero spawn/subagent tool calls and subagentsInFlight=0.
 *
 * isSubagentSpawnTitle was the unguarded one. isSubagentToolCall already rejected
 * concrete kinds and path-like titles, so the class only surfaced through the spawn
 * predicate and through titles with no path separator.
 *
 * These execute the shipped predicates. The distinction being protected is narrow —
 * "Spawning agent crew" must still match while 'echo "spawning the agent now"' must
 * not — so a source-text assertion would not be worth much.
 */
const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

function extractFn(name: string): string {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const needle = 'function ' + name + '(';
  for (let at = src.indexOf(needle); at >= 0; at = src.indexOf(needle, at + 1)) {
    if (src.slice(at, src.indexOf('{', at)).includes(':')) {
      continue; // a typed signature is host TypeScript, not the webview copy
    }
    let i = src.indexOf('{', at);
    let depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '{') {
        depth++;
      } else if (src[i] === '}') {
        depth--;
        if (depth === 0) {
          break;
        }
      }
    }
    return decodeTemplate(src.slice(at, i + 1));
  }
  throw new Error('no untyped declaration of ' + name);
}

interface Predicates {
  isSubagentToolCall: (t: string, k: string | undefined, ri: unknown) => boolean;
  isSubagentSpawnTitle: (t: string, ri: unknown) => boolean;
  subagentSpawnReason: (t: string, ri: unknown) => string;
  adapterAgentSignal: (ri: unknown, tn: string | null) => string;
  stashAdapterToolSignals: (ri: unknown, meta: unknown) => unknown;
}

function load(): Predicates {
  const harness =
    extractFn('adapterAgentSignal') +
    '\n' +
    extractFn('stashAdapterToolSignals') +
    '\n' +
    extractFn('titleLooksLikeCommandOrProse') +
    '\n' +
    extractFn('looksLikeClaudeAgentSpawn') +
    '\n' +
    extractFn('isSubagentToolCall') +
    '\n' +
    extractFn('isSubagentSpawnTitle') +
    '\n' +
    extractFn('subagentSpawnReason') +
    '\nreturn { isSubagentToolCall, isSubagentSpawnTitle, subagentSpawnReason,' +
    ' adapterAgentSignal, stashAdapterToolSignals };';
  return new Function('subagentToolNames', harness)(
    new Set(['spawn_agent', 'subagent', 'close_agent', 'wait', 'sendinput', 'resumeagent']),
  ) as Predicates;
}

suite('a command that mentions an agent is not a subagent spawn', () => {
  /**
   * Titles the real adapters actually emit, read from their source.
   *
   * codex-acp `createCollabAgentToolCallUpdate` sends `title: item.tool`, a bare name
   * from the CollabAgentTool union (spawnAgent | sendInput | resumeAgent | wait |
   * closeAgent) with `kind: "other"`, plus an authoritative
   * `_meta.codex.collaboration.tool`. Its `formatSubAgentActivityTitle` sends
   * "Start subagent <name>" / "Interact with subagent <name>" /
   * "Interrupt subagent <name>".
   *
   * claude-code-acp `buildToolCallUpdate` maps toolName Task|Agent to
   * "Start subagent: <desc up to 60>" with `kind: "other"` and the raw tool input
   * (subagent_type / description / prompt) in rawInput.
   *
   * So both signal a spawn through structured fields and a bare or fixed-prefix
   * title. Neither ever puts free-form command text in a spawn title — which is the
   * property the guard relies on.
   */
  const adapterShapes: [string, string, string, Record<string, unknown> | null, boolean, boolean][] = [
    ['codex spawn tool', 'spawnAgent', 'other', null, true, true],
    ['codex activity start', 'Start subagent code-reviewer', 'other', null, true, false],
    ['codex activity interact', 'Interact with subagent code-reviewer', 'other', null, true, false],
    ['codex activity interrupt', 'Interrupt subagent code-reviewer', 'other', null, true, false],
    [
      'claude Task long desc',
      'Start subagent: fix the parser and add regression tests for it',
      'other',
      { description: 'fix the parser and add regression tests for it' },
      true,
      false,
    ],
    [
      'claude subagent_type',
      'Start subagent: general-purpose',
      'other',
      { subagent_type: 'general-purpose' },
      true,
      true,
    ],
    ['kiro crew', 'Spawning agent crew', 'other', { stages: [{}] }, true, true],
    ['kiro subagent', 'subagent', 'other', null, true, true],
  ];

  test('every title the real adapters emit is still recognised', () => {
    const p = load();
    for (const [label, title, kind, ri, wantTool, wantSpawn] of adapterShapes) {
      assert.strictEqual(
        p.isSubagentToolCall(title, kind, ri),
        wantTool,
        label + ': isSubagentToolCall(' + title + ')',
      );
      assert.strictEqual(p.isSubagentSpawnTitle(title, ri), wantSpawn, label + ': isSubagentSpawnTitle(' + title + ')');
    }
  });

  test('the long fixed-prefix titles survive the command-shape guard', () => {
    const p = load();
    // These are the regression risk: claude-code-acp appends up to 60 characters of
    // description after "Start subagent:", so the title is legitimately long and can
    // contain punctuation. The guard must be applied only AFTER the known prefixes.
    const long = 'Start subagent: refactor the queue and make sure nothing regresses';
    assert.ok(long.length > 40, 'the fixture must actually be long enough to matter');
    assert.strictEqual(p.isSubagentToolCall(long, 'other', null), true);
  });

  test('real spawn titles still route to the crew UI', () => {
    const p = load();
    for (const title of ['Spawning agent crew', 'subagent', 'spawn_agent', 'spawnAgent', 'spawn_agents_on_csv']) {
      assert.strictEqual(p.isSubagentSpawnTitle(title, null), true, 'must still match: ' + title);
    }
  });

  test('shell commands mentioning a spawn do not', () => {
    const p = load();
    const commands = [
      'echo "spawning the agent now"',
      'grep -o \'Spawning agent "[^"]*"\' f.log',
      "for f in $(find ~/logs -name '1-ACP Client.log'); do grep -o 'Spawning agent' \"$f\"; done",
      'I am now spawning an agent crew to handle the remaining work',
    ];
    for (const title of commands) {
      assert.strictEqual(p.isSubagentSpawnTitle(title, null), false, 'must not be treated as a spawn: ' + title);
      assert.strictEqual(
        p.isSubagentToolCall(title, 'other', null),
        false,
        'must not be treated as a subagent op: ' + title,
      );
    }
  });

  test('a protocol-level identification still wins over the title shape', () => {
    const p = load();
    // Claude's Agent tool sends subagent_type in rawInput. That is authoritative even
    // when the title reads like prose, so the guard must not shadow it.
    assert.strictEqual(
      p.isSubagentSpawnTitle('do some long descriptive thing that mentions nothing', {
        subagent_type: 'general-purpose',
      }),
      true,
      'rawInput.subagent_type must still identify a spawn',
    );
    assert.strictEqual(
      p.isSubagentSpawnTitle('a very long title with = and | in it', { _toolName: 'agent' }),
      true,
      'rawInput._toolName=agent must still identify a spawn',
    );
  });

  test('the diagnostic reason names the near-miss instead of saying none', () => {
    const p = load();
    // "none" would read as "nothing about this looked like a spawn", which is exactly
    // the wrong conclusion when a title matched the words and was rejected on shape.
    assert.strictEqual(p.subagentSpawnReason('echo "spawning the agent now"', null), 'none(command-or-prose title)');
    assert.strictEqual(p.subagentSpawnReason('Spawning agent crew', null), 'title:spawn*agent');
    assert.strictEqual(p.subagentSpawnReason('read file', null), 'none');
  });

  test('the guard lives in the outer webview scope, reachable by both callers', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    // subagentSpawnReason sits in the outermost webview scope and isSubagentSpawnTitle
    // is nested. An inner scope can see an outer declaration, never the reverse, so
    // declaring the helper alongside the nested one would throw ReferenceError at
    // runtime for the outer caller — the same failure mode as the
    // hasLeadingClipboardMention bug.
    const decl = src.indexOf('\nfunction titleLooksLikeCommandOrProse(');
    assert.ok(
      decl > 0,
      'titleLooksLikeCommandOrProse must be declared at the outer webview scope ' +
        '(column 0), so both the nested and the outer caller can see it',
    );
    for (const helper of ['adapterAgentSignal', 'stashAdapterToolSignals']) {
      assert.ok(
        src.indexOf('\nfunction ' + helper + '(') > 0,
        helper + ' must also be declared at the outer webview scope',
      );
    }
    // Both callers must actually use it.
    const spawn = extractFn('isSubagentSpawnTitle');
    assert.ok(spawn.includes('titleLooksLikeCommandOrProse('), 'the spawn predicate must guard');
    const tool = extractFn('isSubagentToolCall');
    assert.ok(tool.includes('titleLooksLikeCommandOrProse('), 'the tool predicate must guard too');
  });
});

/**
 * Prefer the adapter's own signal over the human title.
 *
 * codex-acp sends `_meta.codex.collaboration.tool` and kiro-cli sends
 * `_meta.kiro.toolName`; both were on the wire and neither was consumed, because every
 * subagent predicate takes rawInput and none takes _meta. Routing therefore had to
 * read the title, which is what made a false crew card possible in the first place.
 *
 * stashAdapterToolSignals copies them onto rawInput at the tool_call boundary — the
 * same approach already used for claude-code-acp's _toolName — so detection becomes
 * structural, matching what cursor already gets for free from its dedicated
 * cursor/task notification.
 */
suite('structured adapter spawn signals are honoured', () => {
  test('codex CollabAgentTool names are recognised, and only spawnAgent is a spawn', () => {
    const p = load();
    // A deliberately hostile title: a shell command saying nothing about agents. The
    // structured signal must carry the decision on its own.
    const hostile = 'grep -rn "foo" src/ | head -20';
    for (const tool of ['spawnAgent', 'sendInput', 'resumeAgent', 'wait', 'closeAgent']) {
      const ri = p.stashAdapterToolSignals(null, { codex: { collaboration: { tool } } });
      assert.deepStrictEqual(ri, { _collabAgentTool: tool }, 'must be stashed onto rawInput');
      assert.strictEqual(
        p.isSubagentToolCall(hostile, 'other', ri),
        true,
        tool + ' is an agent op regardless of the title',
      );
      assert.strictEqual(
        p.isSubagentSpawnTitle(hostile, ri),
        tool === 'spawnAgent',
        tool + ': only spawnAgent may render a spawn card',
      );
      assert.strictEqual(
        p.subagentSpawnReason(hostile, ri),
        'meta.codex.collaboration.tool=' + tool,
        'the reason must name the structured signal, not a title pattern',
      );
    }
  });

  test('kiro toolName subagent is a spawn; its other tools are not', () => {
    const p = load();
    const cases: [string, boolean][] = [
      ['subagent', true],
      ['summary', false],
      ['fsWrite', false],
      ['executeBash', false],
    ];
    for (const [toolName, wantSpawn] of cases) {
      const ri = p.stashAdapterToolSignals(null, { kiro: { toolName } });
      assert.strictEqual(p.isSubagentSpawnTitle('operation', ri), wantSpawn, 'kiro toolName=' + toolName);
    }
  });

  test('rawInput is returned untouched when there is no signal to add', () => {
    const p = load();
    // The common path is every ordinary tool call, so it must not allocate a copy.
    const orig = { command: 'ls -la' };
    assert.strictEqual(p.stashAdapterToolSignals(orig, undefined), orig, 'no _meta');
    assert.strictEqual(p.stashAdapterToolSignals(orig, {}), orig, 'empty _meta');
    assert.strictEqual(p.stashAdapterToolSignals(orig, { kiro: {} }), orig, 'no toolName');
  });

  test('an existing value is never overwritten', () => {
    const p = load();
    // A restored entry may already carry _toolName from a previous pass; claude's
    // 'Agent' must not be clobbered by a later kiro frame.
    assert.deepStrictEqual(p.stashAdapterToolSignals({ _toolName: 'Agent' }, { kiro: { toolName: 'subagent' } }), {
      _toolName: 'Agent',
    });
  });

  test('both wire paths stash the signal', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    // tool_call and tool_call_update both build their own rawInput, and an update can
    // be the first frame that carries rawInput at all (the live stub enrich path).
    const calls = src.split('stashAdapterToolSignals(').length - 1;
    assert.ok(
      calls >= 3,
      'expected the declaration plus a call on both the tool_call and ' +
        'tool_call_update paths, found ' +
        calls +
        ' occurrence(s)',
    );
    assert.ok(src.includes('_tcRawInput = stashAdapterToolSignals('), 'tool_call path');
    assert.ok(src.includes('_tcuRawInput = stashAdapterToolSignals('), 'tool_call_update path');
  });

  test('no signal means no opinion, so the title rules still apply', () => {
    const p = load();
    assert.strictEqual(p.adapterAgentSignal(null, null), '');
    assert.strictEqual(p.adapterAgentSignal({ command: 'ls' }, null), '');
    assert.strictEqual(p.adapterAgentSignal('not an object', null), '');
    assert.strictEqual(p.adapterAgentSignal([], null), '', 'an array is not a rawInput object');
    // And a genuine kiro crew title still routes on the title alone, as before.
    assert.strictEqual(p.isSubagentSpawnTitle('Spawning agent crew', null), true);
  });
});

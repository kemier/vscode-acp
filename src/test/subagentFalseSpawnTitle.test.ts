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
}

function load(): Predicates {
  const harness =
    extractFn('titleLooksLikeCommandOrProse') +
    '\n' +
    extractFn('looksLikeClaudeAgentSpawn') +
    '\n' +
    extractFn('isSubagentToolCall') +
    '\n' +
    extractFn('isSubagentSpawnTitle') +
    '\n' +
    extractFn('subagentSpawnReason') +
    '\nreturn { isSubagentToolCall, isSubagentSpawnTitle, subagentSpawnReason };';
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
    // Both callers must actually use it.
    const spawn = extractFn('isSubagentSpawnTitle');
    assert.ok(spawn.includes('titleLooksLikeCommandOrProse('), 'the spawn predicate must guard');
    const tool = extractFn('isSubagentToolCall');
    assert.ok(tool.includes('titleLooksLikeCommandOrProse('), 'the tool predicate must guard too');
  });
});

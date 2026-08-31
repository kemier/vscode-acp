import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Diagnostic for the false "spawned 1 subagent" card.
 *
 * A resumed Kiro session rendered a crew card although the agent reported
 * {"subagents": [], "pendingStages": []} and no tool call in the whole session
 * had a qualifying title or rawInput — the title census was only shell, write,
 * read, grep, glob, Running:, Editing, Creating, and "subagent_type" / "stages"
 * / "_toolName" appeared nowhere in the traffic log.
 *
 * subagentSpawnReason names the predicate that routes a tool call into the crew
 * UI so the trigger can be identified where the card is built. These tests pin
 * that it reports the RIGHT reason and — more importantly — that it stays silent
 * for the ordinary Kiro/Codex tool shapes, so the log stays readable.
 *
 * Extracted verbatim from the webview template literal, as with
 * idleThoughtDrop.test.ts.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

function loadReason(): (title: unknown, rawInput?: unknown) => string {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const start = src.indexOf('function subagentSpawnReason(title, rawInput) {');
  assert.ok(start >= 0, 'subagentSpawnReason not found in ChatWebviewProvider.ts');
  const end = src.indexOf('\n/**', start);
  assert.ok(end > start, 'end marker after subagentSpawnReason not found');
  const body = src.slice(start, end).trim();
  return new Function(`${body}\nreturn subagentSpawnReason;`)() as any;
}

suite('subagent crew routing reason (false "spawned N subagent" diagnostic)', () => {
  const reason = loadReason();

  test('stays silent for ordinary Kiro tool calls', () => {
    // The exact shapes measured in the session that showed the phantom card.
    for (const [title, ri] of [
      ['shell', { command: 'ls -la' }],
      ['write', { path: '/a/b.ts', content: 'x' }],
      ['read', { path: '/a/b.ts' }],
      ['grep', { pattern: 'foo' }],
      ['glob', { pattern: '**/*.ts' }],
      ['Running: cd /tmp && ls', { command: 'cd /tmp && ls' }],
      ['Editing ChatWebviewProvider.ts', { path: 'x.ts', oldStr: 'a', newStr: 'b' }],
      ['Creating idleThoughtDrop.test.ts', { path: 'x.ts', content: 'y' }],
    ] as Array<[string, any]>) {
      assert.strictEqual(reason(title, ri), 'none', `expected none for ${title}`);
    }
  });

  test('stays silent when a command merely mentions agents', () => {
    // Self-referential false positives: my own grep commands contained the words
    // spawn_parallel / subAgentActivity and showed up as tool titles.
    assert.strictEqual(
      reason('grep -oiE "subagent|spawn_parallel|crew" log.txt', { command: 'grep …' }),
      'none',
    );
    assert.strictEqual(reason('echo "=== my agent processes ==="', { command: 'echo' }), 'none');
  });

  test('names the rawInput triggers', () => {
    assert.strictEqual(
      reason('anything', { subagent_type: 'general-purpose' }),
      'rawInput.subagent_type=general-purpose',
    );
    assert.strictEqual(reason('anything', { _toolName: 'Agent' }), 'rawInput._toolName=agent');
  });

  test('names the bare-title triggers', () => {
    assert.strictEqual(reason('Task'), 'title==task');
    assert.strictEqual(reason('agent'), 'title==agent');
    assert.strictEqual(reason('subagent'), 'title==subagent');
    assert.strictEqual(reason('spawn_agent'), 'title==spawn_agent');
    assert.strictEqual(reason('spawnAgent'), 'title==spawnAgent');
  });

  test('names the pattern triggers', () => {
    assert.strictEqual(reason('Spawning agent crew'), 'title:spawn*agent');
    assert.strictEqual(reason('Now spawning the agent'), 'title:spawning+agent');
    assert.strictEqual(reason('Kiro agent crew ready'), 'title:agent-crew');
  });

  test('rawInput triggers take precedence over the title', () => {
    assert.strictEqual(
      reason('Task', { subagent_type: 'explorer' }),
      'rawInput.subagent_type=explorer',
    );
  });

  test('tolerates junk input', () => {
    assert.strictEqual(reason(null), 'none');
    assert.strictEqual(reason(undefined, undefined), 'none');
    assert.strictEqual(reason('', null), 'none');
    assert.strictEqual(reason('shell', 'not-an-object'), 'none');
    assert.strictEqual(reason('shell', ['array']), 'none');
  });
});

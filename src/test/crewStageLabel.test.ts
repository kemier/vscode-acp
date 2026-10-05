import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Regression test for `crewStageLabel` (Codex spawnAgent / Claude Agent stage
 * titles). The function lives inside the ChatWebviewProvider template literal,
 * so it cannot be imported — we extract the real `crewStageLabel` plus its
 * dependency closures (`looksLikeClaudeAgentSpawn`, `isSubagentSpawnTitle`)
 * from source and evaluate them in a fresh scope (the same technique used by
 * foldOrdering.test.ts).
 *
 * The bug it guards: for Codex spawnAgent / Claude Agent Task, `rawInput.prompt`
 * holds the PARENT's task sent to the subagent, NOT the subagent's own name.
 * Using prompt made the first stage show the parent's task and then flip to
 * "parent" once the spawnAgent completion update landed. The fix prefers the
 * subagent identity fields (agentPath/agent_path/subagent_type/name/agent_name/
 * role) and only falls back to task/description/prompt text for NON-spawn tools.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

interface RawInput {
  [key: string]: unknown;
}

type LabelFn = (rawInput: RawInput | undefined, title?: string | null, index?: number) => string;
type ClaudeLabelFn = (rawInput: RawInput | undefined, index?: number) => string;

// Extract a single top-level function declaration by name. `sigStart` is the
// exact `function <name>(` opener. The declaration ends at the next line that
// opens a `function` at the SAME indentation as `sigStart` (webview functions
// are uniformly indented; a sibling at the same indent is the boundary).
//
// The previous implementation used `/^(\n\s*)function\s+[A-Za-z_]/m`, which is
// fragile: `\s*` is greedy and spans newlines, and the `^`+`\n` interaction
// made it skip over same-line siblings (e.g. it extracted `isSubagentSpawnTitle`
// all the way through `addToolCall`). Any top-level `return` added inside the
// over-swallowed span then short-circuited the `new Function` eval and broke
// this suite. Anchoring the boundary on the function's own indent fixes that.
function extractFunction(src: string, sigStart: string): string {
  const startIdx = src.indexOf(sigStart);
  assert.ok(startIdx >= 0, `'${sigStart.replace(/\s+/g, ' ')}' not found in ChatWebviewProvider.ts`);
  // Indent of the line that declares `sigStart` — the boundary is the next
  // `function` opener at exactly this indent.
  const lineStart = src.lastIndexOf('\n', startIdx - 1) + 1;
  const indentMatch = /^\s*/.exec(src.slice(lineStart, startIdx));
  const indent = indentMatch ? indentMatch[0].length : 0;
  const indentRe = new RegExp('^' + ' '.repeat(indent) + 'function\\s+[A-Za-z_]', 'm');
  const rest = src.slice(startIdx + sigStart.length);
  const nextFn = indentRe.exec(rest);
  let endIdx = nextFn ? startIdx + sigStart.length + nextFn.index + indent : -1;
  if (endIdx < 0) {
    // Fallback: no sibling at the same indent — pull to end of file.
    endIdx = src.length;
  }
  return src.slice(startIdx, endIdx).trim();
}

function extractLabelScope(): { crewStageLabel: LabelFn; claudeStageLabel: ClaudeLabelFn } {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const looksLikeClaudeAgentSpawn = extractFunction(
    src,
    'function looksLikeClaudeAgentSpawn(title, rawInput, toolName) {',
  );
  const isSubagentSpawnTitle = extractFunction(src, 'function isSubagentSpawnTitle(title, rawInput, toolName) {');
  // isSubagentSpawnTitle delegates its command-shape check to this sibling.
  const titleLooksLikeCommandOrProse = extractFunction(src, 'function titleLooksLikeCommandOrProse(title) {');
  const adapterAgentSignal = extractFunction(src, 'function adapterAgentSignal(rawInput, toolName) {');
  const crewStageLabel = extractFunction(src, 'function crewStageLabel(rawInput, title, index) {');
  const claudeStageLabel = extractFunction(src, 'function claudeStageLabel(rawInput, index) {');
  const body =
    adapterAgentSignal +
    '\n' +
    titleLooksLikeCommandOrProse +
    '\n' +
    looksLikeClaudeAgentSpawn +
    '\n' +
    isSubagentSpawnTitle +
    '\n' +
    crewStageLabel +
    '\n' +
    claudeStageLabel +
    '\nreturn { crewStageLabel, claudeStageLabel };';
  const factory = new Function(body) as () => { crewStageLabel: LabelFn; claudeStageLabel: ClaudeLabelFn };
  return factory();
}

suite('crewStageLabel (subagent stage title)', () => {
  const { crewStageLabel: label } = extractLabelScope();

  test('Codex spawnAgent with only prompt uses "Subagent N", not the parent task', () => {
    // Regression: rawInput.prompt on spawnAgent is the PARENT's task, so it must
    // NOT be used as the stage label. Falls through to the generic Subagent N.
    assert.strictEqual(label({ prompt: 'Find the weather in Paris.' }, 'spawnAgent', 1), 'Subagent 1');
  });

  test('Codex spawnAgent with agentPath shows the subagent path', () => {
    // agentPath is an identity field → basename it, preferred over prompt.
    const name = label({ prompt: 'Analyze traffic.', agentPath: '/root/weather_research' }, 'spawnAgent', 2);
    assert.strictEqual(name, 'weather_research');
    // agent_path also basenames.
    assert.strictEqual(label({ agent_path: 'a/b/c/explore' }, 'spawnAgent', 1), 'explore');
  });

  test('agent_path and subagent_type identity fields are preferred over prompt', () => {
    assert.strictEqual(label({ prompt: 'do x', agent_path: 'explore' }, 'spawnAgent', 1), 'explore');
    // Cursor task spawn: subagent_type + description/prompt — the description/
    // prompt IS the subagent's actual task, so it wins over the bare type.
    assert.strictEqual(label({ prompt: 'do x', subagent_type: 'file-analyzer' }, 'Task', 1), 'do x');
  });

  test('cursor/task spawn shows the subagent task title, not the type or Subagent N', () => {
    // Cursor ACP: description/prompt is the actual subagent task; subagent_type
    // is just the role (explore/browser_use/...). Prefer description, then prompt.
    assert.strictEqual(
      label({ description: 'Explore codebase', prompt: 'Find auth handling', subagent_type: 'explore' }, 'Task', 1),
      'Explore codebase',
    );
    assert.strictEqual(
      label({ prompt: 'Find where authentication is handled', subagent_type: 'explore' }, 'Task', 1),
      'Find where authentication is handled',
    );
    // No description/prompt → fall back to the type, then Subagent N.
    assert.strictEqual(label({ subagent_type: 'explore' }, 'Task', 1), 'explore');
    assert.strictEqual(label({}, 'Task', 1), 'Subagent 1');
  });

  test('codex spawn_agent with {name, role} shows the subagent name', () => {
    assert.strictEqual(label({ name: 'explore', role: 'agent', prompt: 'do x' }, 'spawn_agent', 3), 'explore');
    // role is a lower-precedence fallback for spawn titles.
    assert.strictEqual(label({ role: 'web-researcher', prompt: 'find docs' }, 'spawn_agent', 1), 'web-researcher');
  });

  test('non-spawn tool with description/task/prompt keeps that descriptive text', () => {
    // Fallback to task text is preserved for NON-spawn tools.
    assert.strictEqual(
      label({ description: 'Read config to find server port' }, 'Read', 1),
      'Read config to find server port',
    );
    assert.strictEqual(label({ task: 'Update roadmap' }, 'Edit', 1), 'Update roadmap');
    // Non-spawn title + prompt → prompt text is the label.
    assert.strictEqual(
      label({ prompt: 'grep for sessionUsage', directory: '/x' }, 'grep_files', 1),
      'grep for sessionUsage',
    );
  });

  test('long identity values are truncated to 60 chars with ellipsis', () => {
    const long = 'x'.repeat(80);
    const name = label({ name: long }, 'spawn_agent', 4);
    assert.strictEqual(name, 'x'.repeat(57) + '...');
    assert.strictEqual(name.length, 60);
  });

  test('falls back to Subagent N when no identity and title is a spawn title', () => {
    assert.strictEqual(label({}, 'spawnAgent', 7), 'Subagent 7');
    // Default index is 1 when not supplied.
    assert.strictEqual(label(undefined, 'spawn_agent'), 'Subagent 1');
  });

  test('claudeStageLabel delegates to crewStageLabel (null title)', () => {
    const { claudeStageLabel: claude } = extractLabelScope();
    assert.strictEqual(claude({ name: 'deep-dive' }, 2), 'deep-dive');
    assert.strictEqual(claude({}, 5), 'Subagent 5');
  });
});

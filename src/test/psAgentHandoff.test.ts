import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * `/ps` was implemented twice, and the weaker one always won.
 *
 * The webview handled `/ps` itself and returned true on every path, so it was
 * consumed client-side and never reached the agent — confirmed empirically:
 * across every ACP traffic log on this machine, `grep '"text": "/ps"'` returned
 * 0 hits while `/tools` returned 4.
 *
 * Meanwhile three of the four sibling adapters implement it, and all three know
 * about processes the client cannot see:
 *
 *   ericli           src/acp/acp-server.ts  — A2A tasks + tracked tool calls
 *   codex-acp        src/CodexCommands.ts   — background terminal processes
 *   claude-code-acp  src/agent.ts           — its own dispatchSlashCommand
 *   pi-acp                                  — no /ps at all
 *
 * The client version only scans rendered `toolCall` rows of the CURRENT chat for
 * status in_progress|running|pending, so it cannot report a background terminal
 * that outlived its turn, nor any A2A task.
 *
 * `/ps` is now deferred to the agent whenever the agent advertises it, with the
 * local panel kept as the fallback for agents like pi-acp that do not.
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
  const preamble = deps.map((d) => asRenderedWebview(slice(d))).join('\n');
  return new Function(
    preamble + '\nreturn (' + asRenderedWebview(slice(name)) + ')',
  )() as (...args: any[]) => any;
}

suite('commandListHasCommand (agent command advertisement)', () => {
  const commandListHasCommand = extractFunction('commandListHasCommand');

  test('matches the bare name agents actually advertise', () => {
    const list = [{ name: 'compact' }, { name: 'ps' }, { name: 'a2a' }];
    assert.strictEqual(commandListHasCommand(list, 'ps'), true);
    assert.strictEqual(commandListHasCommand(list, 'a2a'), true);
  });

  test('tolerates a leading slash on either side', () => {
    assert.strictEqual(commandListHasCommand([{ name: 'ps' }], '/ps'), true);
    assert.strictEqual(commandListHasCommand([{ name: '/ps' }], 'ps'), true);
    assert.strictEqual(commandListHasCommand([{ name: '/ps' }], '/ps'), true);
  });

  test('is case-insensitive', () => {
    assert.strictEqual(commandListHasCommand([{ name: 'PS' }], 'ps'), true);
    assert.strictEqual(commandListHasCommand([{ name: 'ps' }], 'PS'), true);
  });

  test('reports false for an agent without the command', () => {
    // pi-acp's builtins, verbatim.
    const piAcp = [
      { name: 'compact' },
      { name: 'autocompact' },
      { name: 'export' },
      { name: 'session' },
      { name: 'name' },
      { name: 'steering' },
      { name: 'follow-up' },
    ];
    assert.strictEqual(commandListHasCommand(piAcp, 'ps'), false);
  });

  test('survives an empty, missing or malformed list', () => {
    assert.strictEqual(commandListHasCommand([], 'ps'), false);
    assert.strictEqual(commandListHasCommand(null, 'ps'), false);
    assert.strictEqual(commandListHasCommand(undefined, 'ps'), false);
    assert.strictEqual(commandListHasCommand([null, {}, { name: null }], 'ps'), false);
  });

  test('an empty target never matches', () => {
    assert.strictEqual(commandListHasCommand([{ name: 'ps' }], ''), false);
    assert.strictEqual(commandListHasCommand([{ name: 'ps' }], '/'), false);
    assert.strictEqual(commandListHasCommand([{ name: 'ps' }], undefined), false);
  });

  test('does not substring-match a different command', () => {
    assert.strictEqual(commandListHasCommand([{ name: 'psx' }], 'ps'), false);
    assert.strictEqual(commandListHasCommand([{ name: 'stops' }], 'ps'), false);
  });
});

suite('/ps defers to the agent when the agent implements it', () => {
  const src = fs.readFileSync(SOURCE, 'utf8');

  test('the handler checks the advertised command list first', () => {
    const at = src.indexOf("if (text === '/ps') {");
    assert.ok(at >= 0, '/ps handler not found');
    const body = src.slice(at, at + 400);
    assert.ok(
      body.includes("commandListHasCommand(availableCommands, 'ps')"),
      '/ps must consult the agent command list before rendering the local panel',
    );
    assert.ok(
      body.indexOf('commandListHasCommand') < body.indexOf("promptInput.value = ''"),
      'the check must come before the local panel takes over the input',
    );
  });

  test('the agent path returns false so the command falls through as a prompt', () => {
    const at = src.indexOf("if (text === '/ps') {");
    const body = src.slice(at, at + 400);
    assert.ok(
      /commandListHasCommand\(availableCommands, 'ps'\)\) \{ return false; \}/.test(body),
      'returning false is what lets handleSend forward /ps to the agent',
    );
  });

  test('/ps is still turn-safe, so the handoff works mid-turn too', () => {
    const slashCommandRunsDuringTurn = extractFunction('slashCommandRunsDuringTurn', [
      'turnSafeDeclaration',
    ]);
    assert.strictEqual(
      slashCommandRunsDuringTurn('/ps', []),
      true,
      '/ps must stay turn-safe: deferring it to the agent is only an improvement ' +
        'if it is still answered immediately while a turn streams',
    );
    // And when the agent declares it explicitly.
    assert.strictEqual(
      slashCommandRunsDuringTurn('/ps', [{ name: 'ps', _meta: { turnSafe: true } }]),
      true,
    );
  });

  test('the local panel is retained as a fallback', () => {
    const at = src.indexOf("if (text === '/ps') {");
    const body = src.slice(at, at + 2600);
    assert.ok(
      body.includes('Background terminals'),
      'the local psPanel must remain for agents that do not advertise /ps (pi-acp)',
    );
  });
});

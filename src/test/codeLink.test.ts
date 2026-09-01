import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { orderedLinkRoots, symbolFallbackFromLinkText } from '../utils/codeLink';

/**
 * Guards the two halves of the "clicking src/foo.cpp:898 ran a symbol search"
 * bug: relative agent paths must be resolved against the agent's cwd, and a
 * link text that is a path must never be treated as a symbol name.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

suite('code link resolution roots', () => {
  test('the active session cwd comes before workspace folders', () => {
    assert.deepStrictEqual(orderedLinkRoots('/w/git/llama.cpp', ['/w/git/other'], ['/w/git/vscode-acp']), [
      '/w/git/llama.cpp',
      '/w/git/other',
      '/w/git/vscode-acp',
    ]);
  });

  test('duplicates and empty entries are dropped', () => {
    assert.deepStrictEqual(orderedLinkRoots('/w/a', ['/w/a', undefined, '/w/b'], ['/w/b', '/w/c', undefined]), [
      '/w/a',
      '/w/b',
      '/w/c',
    ]);
  });

  test('no session yet still yields the workspace folders', () => {
    assert.deepStrictEqual(orderedLinkRoots(undefined, [], ['/w/a']), ['/w/a']);
    assert.deepStrictEqual(orderedLinkRoots(undefined, [], []), []);
  });
});

suite('code link symbol fallback', () => {
  test('a path link text gets no symbol fallback', () => {
    // The reported case: this used to return "src".
    assert.strictEqual(symbolFallbackFromLinkText('src/llama-memory-recurrent.cpp:898'), undefined);
    assert.strictEqual(symbolFallbackFromLinkText('src/llama-memory-recurrent.cpp'), undefined);
    assert.strictEqual(symbolFallbackFromLinkText('./a/b'), undefined);
    assert.strictEqual(symbolFallbackFromLinkText('C:\\repo\\a.cpp:12'), undefined);
  });

  test('a bare filename is a path, not a symbol', () => {
    assert.strictEqual(symbolFallbackFromLinkText('llama-memory-recurrent.cpp'), undefined);
    assert.strictEqual(symbolFallbackFromLinkText('main.rs:42'), undefined);
  });

  test('real symbol names still fall back', () => {
    assert.strictEqual(symbolFallbackFromLinkText('nats_msgbus_create'), 'nats_msgbus_create');
    assert.strictEqual(
      symbolFallbackFromLinkText('llama_memory_recurrent::state_write'),
      'llama_memory_recurrent::state_write',
    );
    assert.strictEqual(symbolFallbackFromLinkText('state_write:898'), 'state_write');
    assert.strictEqual(symbolFallbackFromLinkText('  spaced_symbol  '), 'spaced_symbol');
  });

  test('empty or non-identifier text yields nothing', () => {
    assert.strictEqual(symbolFallbackFromLinkText(''), undefined);
    assert.strictEqual(symbolFallbackFromLinkText(undefined), undefined);
    assert.strictEqual(symbolFallbackFromLinkText('42'), undefined);
  });
});

suite('code link wiring', () => {
  test('handleOpenFile tries the session cwd and uses the guarded fallback', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    assert.ok(
      src.indexOf("import { orderedLinkRoots, symbolFallbackFromLinkText } from '../utils/codeLink';") > 0,
      'codeLink helpers are not imported',
    );
    assert.ok(
      src.indexOf('for (const root of this.linkResolutionRoots()) {') > 0,
      'handleOpenFile does not try the session/workspace roots',
    );
    // The raw regex must be gone from both fallback sites.
    assert.strictEqual(
      src.split('linkText?.match(/^([a-zA-Z_]').length - 1,
      0,
      'a raw link-text identifier regex is still used as a symbol fallback',
    );
    assert.strictEqual(
      src.split('this.symbolFallbackFromLinkText(linkText)').length - 1,
      3,
      'both fallback sites AND the line-correction search must use the guarded helper',
    );
  });
});

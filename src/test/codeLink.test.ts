import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { fileSearchRoots, orderedLinkRoots, pickBestFileMatch, symbolFallbackFromLinkText } from '../utils/codeLink';

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

suite('disk file search roots', () => {
  test('roots come before their parents, most specific first', () => {
    // The reported case: window open on vepg/epg, the agent session running in vepg,
    // link target in vepg/ssr/… — the session cwd must be searched first and the
    // common parent only as a last resort.
    assert.deepStrictEqual(fileSearchRoots(['/workspace/git/ezennin/vepg', '/workspace/git/ezennin/vepg/epg']), [
      '/workspace/git/ezennin/vepg',
      '/workspace/git/ezennin/vepg/epg',
      '/workspace/git/ezennin',
    ]);
  });

  test('the widening never reaches a shallow directory or /', () => {
    assert.deepStrictEqual(fileSearchRoots(['/workspace/git/ezennin']), ['/workspace/git/ezennin']);
    assert.deepStrictEqual(fileSearchRoots(['/workspace/git']), []);
    assert.deepStrictEqual(fileSearchRoots(['/']), []);
    assert.deepStrictEqual(fileSearchRoots([]), []);
  });

  test('duplicates and trailing slashes collapse', () => {
    assert.deepStrictEqual(fileSearchRoots(['/a/b/c/d/', '/a/b/c/d', '/a/b/c/d/e']), [
      '/a/b/c/d',
      '/a/b/c/d/e',
      '/a/b/c',
    ]);
  });
});

suite('disk file match ranking', () => {
  const src = '/workspace/git/ezennin/vepg/ssr/pkt/sw/se/xc/bsd/system/icr/src/icr_worker.c';
  const test1 = '/workspace/git/ezennin/vepg/ssr/pkt/sw/se/xc/bsd/system/icr/test_cpp/test_src/icr_worker.c';

  test('a real source tree beats a test copy', () => {
    assert.strictEqual(pickBestFileMatch([test1, src], 'icr_worker.c'), src);
    assert.strictEqual(pickBestFileMatch([src, test1], 'icr_worker.c'), src);
  });

  test('an exact tail match beats a same-named file elsewhere', () => {
    assert.strictEqual(pickBestFileMatch(['/a/b/other/icr_worker.c', src], 'icr/src/icr_worker.c'), src);
  });

  test('the shallowest path breaks ties', () => {
    assert.strictEqual(pickBestFileMatch(['/a/b/c/d/e/main.c', '/a/b/c/main.c'], 'main.c'), '/a/b/c/main.c');
  });

  test('nothing to rank yields nothing', () => {
    assert.strictEqual(pickBestFileMatch([], 'main.c'), undefined);
    assert.strictEqual(pickBestFileMatch([''], 'main.c'), undefined);
  });
});

suite('code link wiring', () => {
  test('handleOpenFile tries the session cwd and uses the guarded fallback', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    assert.ok(
      /import \{[^}]*orderedLinkRoots[^}]*symbolFallbackFromLinkText[^}]*\} from '\.\.\/utils\/codeLink';/s.test(src),
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

  test('a relative path that the workspace index cannot see falls back to disk', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    assert.ok(
      src.indexOf('private async findFileOnDisk(') > 0,
      'the disk fallback for unresolvable relative paths is missing',
    );
    assert.ok(
      src.indexOf('const onDisk = await this.findFileOnDisk(cleanPath);') > 0,
      'handleOpenFile does not consult the disk fallback',
    );
    // The throw must come after the fallback, not instead of it.
    const fallbackIdx = src.indexOf('const onDisk = await this.findFileOnDisk(cleanPath);');
    const throwIdx = src.indexOf('throw new Error(`File not found: ${cleanPath}`);', fallbackIdx);
    assert.ok(throwIdx > fallbackIdx, 'the "File not found" throw must be guarded by the disk fallback');
  });
});

import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  buildSelectionBlock,
  buildFileBlock,
  buildDirectoryBlock,
  buildTerminalBlock,
  buildDiagnosticsBlock,
  fileUri,
  directoryUri,
  type SelectionContext,
} from '../core/ContextBlockBuilder';

suite('ContextBlockBuilder', () => {
  const POSIX_PATH = '/workspace/project/src/foo.ts';

  test('fileUri produces file:///<abs-path> URI', () => {
    const uri = fileUri(POSIX_PATH);
    assert.ok(uri.startsWith('file:///'), `Expected file:/// prefix, got ${uri}`);
    assert.ok(uri.endsWith('/foo.ts'), `Expected /foo.ts suffix, got ${uri}`);
  });

  test('fileUri percent-encodes spaces and special chars', () => {
    const uri = fileUri('/tmp/a b/foo bar.rs');
    assert.ok(uri.includes('%20'), `Expected %20 escape, got ${uri}`);
  });

  test('directoryUri ends with /', () => {
    const uri = directoryUri('/tmp/dir');
    assert.ok(uri.endsWith('/'), `Expected trailing /, got ${uri}`);
  });

  test('directoryUri is idempotent when input already ends with /', () => {
    const expected = vscode.Uri.file('/tmp/dir').toString() + '/';
    const a = directoryUri('/tmp/dir');
    const b = directoryUri('/tmp/dir');
    assert.strictEqual(a, expected);
    assert.strictEqual(b, expected);
  });

  suite('buildSelectionBlock', () => {
    const baseSel: SelectionContext = {
      absPath: POSIX_PATH,
      startLine: 5,
      endLine: 9,
      text: 'function foo() {\n  return 42;\n}',
    };

    test('emits `resource` block with text + URI fragment when embeddedContext supported', () => {
      const block = buildSelectionBlock(baseSel, true) as any;
      assert.strictEqual(block.type, 'resource');
      assert.strictEqual(block.resource.text, baseSel.text);
      assert.ok(block.resource.uri.endsWith('#L5:9'), `expected #L5:9, got ${block.resource.uri}`);
      assert.ok(block.resource.uri.startsWith('file:///'), `expected file://, got ${block.resource.uri}`);
    });

    test('emits `resource_link` block (no inline text) when embeddedContext NOT supported', () => {
      const block = buildSelectionBlock(baseSel, false) as any;
      assert.strictEqual(block.type, 'resource_link');
      assert.strictEqual(block.name, 'foo.ts (5:9)');
      assert.ok(block.uri.endsWith('#L5:9'));
      assert.strictEqual(block.text, undefined, 'resource_link must NOT carry the selection text');
    });

    test('URI uses 1-based inclusive line range exactly as Zed does', () => {
      // Zed produces `file:///abs/path#L<start1>:<end1>` from line_range.start()+1 / end()+1.
      const block = buildSelectionBlock({ ...baseSel, startLine: 1, endLine: 1 }, true) as any;
      assert.ok(block.resource.uri.endsWith('#L1:1'));
    });

    test('supports untitled buffers via explicit `uri` field', () => {
      const block = buildSelectionBlock(
        { absPath: null, uri: 'untitled:Untitled-1', startLine: 3, endLine: 7, text: 'x' },
        true,
      ) as any;
      assert.strictEqual(block.resource.uri, 'untitled:Untitled-1#L3:7');
    });

    test('falls back to untitled:Untitled when neither absPath nor uri is given', () => {
      const block = buildSelectionBlock({ absPath: null, startLine: 1, endLine: 1, text: 'x' }, false) as any;
      assert.ok(block.uri.startsWith('untitled:'));
      assert.strictEqual(block.name, 'Untitled (1:1)');
    });

    test('mimeType is forwarded when present, omitted when absent', () => {
      const withMime = buildSelectionBlock({ ...baseSel, mimeType: 'text/x-ts' }, true) as any;
      assert.strictEqual(withMime.resource.mimeType, 'text/x-ts');

      const without = buildSelectionBlock(baseSel, true) as any;
      assert.ok(!('mimeType' in without.resource), 'mimeType should be omitted when undefined');
    });
  });

  suite('buildFileBlock', () => {
    test('with content + embedded => resource block with inline text', () => {
      const block = buildFileBlock(POSIX_PATH, true, 'hello\n') as any;
      assert.strictEqual(block.type, 'resource');
      assert.strictEqual(block.resource.text, 'hello\n');
      assert.ok(block.resource.uri.startsWith('file:///'));
      assert.ok(!block.resource.uri.includes('#L'), 'whole-file mention must NOT have a line fragment');
    });

    test('without content => resource_link (regardless of embedded)', () => {
      const a = buildFileBlock(POSIX_PATH, true) as any;
      const b = buildFileBlock(POSIX_PATH, false) as any;
      assert.strictEqual(a.type, 'resource_link');
      assert.strictEqual(b.type, 'resource_link');
      assert.strictEqual(a.name, 'foo.ts');
      assert.strictEqual(b.name, 'foo.ts');
    });

    test('with content but embedded=false => still resource_link (agent reads from disk)', () => {
      const block = buildFileBlock(POSIX_PATH, false, 'hello\n') as any;
      assert.strictEqual(block.type, 'resource_link');
    });

    test('mimeType is forwarded', () => {
      const block = buildFileBlock(POSIX_PATH, false, undefined, 'text/x-typescript') as any;
      assert.strictEqual(block.mimeType, 'text/x-typescript');
    });
  });

  suite('buildDirectoryBlock', () => {
    test('emits resource_link with trailing-slash URI', () => {
      const block = buildDirectoryBlock('/tmp/src') as any;
      assert.strictEqual(block.type, 'resource_link');
      assert.ok(block.uri.endsWith('/'), `expected trailing /, got ${block.uri}`);
      assert.ok(block.name.endsWith('/'), `expected display name with trailing /, got ${block.name}`);
    });
  });

  suite('buildTerminalBlock', () => {
    test('returns null when embedded NOT supported (caller falls back to inline)', () => {
      const block = buildTerminalBlock('hi\n', false);
      assert.strictEqual(block, null);
    });

    test('returns resource block with zed:///agent/terminal-selection URI when embedded supported', () => {
      const block = buildTerminalBlock('line1\nline2\n', true) as any;
      assert.ok(block);
      assert.strictEqual(block.type, 'resource');
      assert.ok(block.resource.uri.startsWith('zed:///agent/terminal-selection'));
      assert.ok(block.resource.uri.includes('lines='));
      assert.strictEqual(block.resource.text, 'line1\nline2\n');
    });

    test('uses explicit lineCount when provided', () => {
      const block = buildTerminalBlock('whatever', true, 42) as any;
      assert.ok(block.resource.uri.includes('lines=42'));
    });
  });

  suite('buildDiagnosticsBlock', () => {
    test('returns null when embedded NOT supported', () => {
      assert.strictEqual(buildDiagnosticsBlock('boom', false), null);
    });

    test('returns resource block with zed:///agent/diagnostics URI when embedded supported', () => {
      const block = buildDiagnosticsBlock('foo.ts:5: error\n', true) as any;
      assert.ok(block);
      assert.strictEqual(block.type, 'resource');
      assert.strictEqual(block.resource.uri, 'zed:///agent/diagnostics');
      assert.strictEqual(block.resource.text, 'foo.ts:5: error\n');
    });
  });
});

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * A file:// link with a non-ASCII filename must open.
 *
 * Clicking a rendered link to a CJK-named file failed with:
 *
 *   Could not open /workspace/git/ezennin/cuda/chapter106-longcat/%E8%AE%B2%E4%B9%89_longcat.md:
 *   File not found
 *
 * %E8%AE%B2%E4%B9%89 is UTF-8 for 讲义. The webview extracted `url.pathname` under a comment
 * asserting it was "already decoded" — it is not; URL.pathname preserves percent-escapes.
 * The path then reached the host WITHOUT the file:// scheme, so the host's decode branch
 * (which only fires for file:// URIs, via Uri.parse().fsPath) was skipped too, and the
 * literal escapes went to openTextDocument.
 *
 * Affects every path with non-ASCII characters or spaces, which is most of this user's
 * course files.
 */
const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');
const SRC = fs.readFileSync(SOURCE, 'utf8');

const REPORTED = 'file:///workspace/git/ezennin/cuda/chapter106-longcat/%E8%AE%B2%E4%B9%89_longcat.md';

/** The webview's extraction, as shipped. */
function webviewPath(href: string): string {
  const url = new URL(href);
  let filePath = url.pathname;
  try {
    filePath = decodeURIComponent(filePath);
  } catch {
    /* keep raw */
  }
  return filePath;
}

/** The host's backstop for an already-scheme-stripped path. */
function hostBackstop(cleanPath: string): string {
  if (/%[0-9A-Fa-f]{2}/.test(cleanPath)) {
    try {
      const decoded = decodeURIComponent(cleanPath);
      if (decoded !== cleanPath) {
        return decoded;
      }
    } catch {
      /* keep original */
    }
  }
  return cleanPath;
}

suite('percent-encoded file links decode', () => {
  test('URL.pathname is NOT decoded — the premise of the bug', () => {
    const raw = new URL(REPORTED).pathname;
    assert.notStrictEqual(raw, decodeURIComponent(raw), 'pathname keeps its escapes');
    assert.ok(raw.includes('%E8%AE%B2%E4%B9%89'));
  });

  test('the reported link resolves to the real filename', () => {
    assert.strictEqual(
      webviewPath(REPORTED),
      '/workspace/git/ezennin/cuda/chapter106-longcat/讲义_longcat.md',
    );
  });

  test('the host backstop covers a scheme-less encoded path', () => {
    // Belt and braces: any caller that strips the scheme before reaching the host still
    // gets a usable path.
    assert.strictEqual(
      hostBackstop('/workspace/git/ezennin/cuda/chapter106-longcat/%E8%AE%B2%E4%B9%89_longcat.md'),
      '/workspace/git/ezennin/cuda/chapter106-longcat/讲义_longcat.md',
    );
  });

  test('spaces and other escapes decode too', () => {
    assert.strictEqual(webviewPath('file:///tmp/My%20Notes/a%20b.md'), '/tmp/My Notes/a b.md');
  });

  test('a literal percent in a filename survives', () => {
    // "100%_done.md" has a '%' that is not a valid escape prefix, so it must be untouched.
    assert.strictEqual(hostBackstop('/tmp/100%_done.md'), '/tmp/100%_done.md');
  });

  test('a malformed escape does not throw or lose the path', () => {
    assert.strictEqual(hostBackstop('/tmp/broken%ZZ.md'), '/tmp/broken%ZZ.md');
    assert.doesNotThrow(() => webviewPath('file:///tmp/broken%ZZ.md'));
  });

  test('an already-decoded path is left alone', () => {
    const plain = '/workspace/git/ezennin/cuda/chapter106-longcat/讲义_longcat.md';
    assert.strictEqual(hostBackstop(plain), plain);
  });

  test('the shipped code decodes in BOTH layers', () => {
    // The misleading comment must be gone, and each layer must decode.
    assert.ok(!SRC.includes('url.pathname; // already decoded'), 'the false comment must go');
    assert.ok(SRC.includes('URL.pathname is NOT decoded'), 'and be replaced by the truth');
    const webviewAt = SRC.indexOf('let filePath = url.pathname;');
    assert.ok(webviewAt > 0, 'webview extraction not found');
    assert.ok(
      SRC.slice(webviewAt, webviewAt + 300).includes('decodeURIComponent'),
      'the webview layer must decode',
    );
    const hostAt = SRC.indexOf("if (cleanPath.startsWith('file://'))");
    assert.ok(hostAt > 0, 'host branch not found');
    assert.ok(
      SRC.slice(hostAt, hostAt + 900).includes('decodeURIComponent'),
      'the host backstop must decode',
    );
  });
});

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Clicking a symbol in an answer about a SIBLING repo must not answer from the
 * open one.
 *
 * Reported: an ericli session with the `cuda` repo open analysed llama.cpp's CUDA
 * kernels. Clicking `mul_mat_id` / `ggml_cuda_op_silu` searched the cuda repo.
 *
 * The session file (~/.cli-4-ericai/sessions/66f8c319.json) settles what the model
 * did: 19 links, ALL compliant absolute file:/// paths into
 * /workspace/git/ezennin/llama.cpp. The symbols that misbehaved were never links —
 * they were inline code, and the webview's Pass-2 linkifier turns snake_case inside
 * a code span into an @symbol: lookup. So this is entirely a resolution problem on
 * our side, not model non-compliance.
 *
 * Three separate defects, each verified against the real repos:
 *
 *   1. findSymbolWithRipgrep's glob list had no .cu/.cuh, and ggml_cuda_op_silu
 *      exists ONLY in ggml-cuda/unary.cu and unary.cuh — so rg matched zero files
 *      for exactly the language the user works in.
 *   2. handleOpenFile fell back to a workspace symbol search for ANY missing file,
 *      including an absolute path outside the workspace — which is what a correct
 *      sibling-repo reference looks like.
 *   3. On a total miss it opened Quick Open silently. Quick Open's # search is
 *      workspace-scoped, so the user saw current-repo results and reasonably
 *      concluded the search had gone to the wrong repository.
 */

const ROOT = path.resolve(__dirname, '../..');
const provider = fs.readFileSync(path.join(ROOT, 'src/ui/ChatWebviewProvider.ts'), 'utf8');

/** Function/method body, brace-matched past parameter and return types. */
function bodyOf(src: string, signature: string): string {
  const at = src.indexOf(signature);
  assert.ok(at > 0, `not found: ${signature}`);
  const parenOpen = src.indexOf('(', at);
  let pd = 0;
  let parenEnd = -1;
  for (let i = parenOpen; i < src.length; i++) {
    if (src[i] === '(') {
      pd++;
    } else if (src[i] === ')') {
      pd--;
      if (pd === 0) {
        parenEnd = i;
        break;
      }
    }
  }
  let open = -1;
  for (let i = parenEnd; i < src.length; i++) {
    if (src[i] !== '{') {
      continue;
    }
    const eol = src.indexOf('\n', i);
    if (src.slice(i + 1, eol < 0 ? src.length : eol).trim() === '') {
      open = i;
      break;
    }
  }
  assert.ok(open > 0, `no body brace after ${signature}`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') {
      depth++;
    } else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        return src.slice(at, i + 1);
      }
    }
  }
  throw new Error(`unbalanced braces after ${signature}`);
}

suite('sibling-repo symbol resolution', () => {
  test('the ripgrep fallback searches CUDA sources', () => {
    // Without these the fallback is blind to .cu/.cuh, which is where the reported
    // symbols live — and blindness here degrades into a workspace-scoped picker.
    const body = bodyOf(provider, 'private async findSymbolWithRipgrep');
    for (const glob of ["'*.cu'", "'*.cuh'"]) {
      assert.ok(body.includes(glob), `glob list missing ${glob}`);
    }
    // The pre-existing languages must survive.
    for (const glob of ["'*.c'", "'*.cpp'", "'*.h'", "'*.hpp'", "'*.rs'", "'*.go'"]) {
      assert.ok(body.includes(glob), `glob list lost ${glob}`);
    }
  });

  test('it still searches the parent directory, which is what reaches siblings', () => {
    const body = bodyOf(provider, 'private async findSymbolWithRipgrep');
    assert.ok(body.includes('lastIndexOf'), 'parent-directory root no longer derived');
    assert.ok(/searchRoots\.push\(parent\)/.test(body), 'parent not added as a search root');
  });

  test('a missing file OUTSIDE the workspace does not fall back to a symbol search', () => {
    // A correct ../llama.cpp path is indistinguishable from a hallucinated one, so
    // the fallback would answer with a same-named symbol from the open repo.
    const body = bodyOf(provider, 'private async handleOpenFile');
    assert.ok(body.includes('const outsideWorkspace ='), 'no outside-workspace discriminator');
    assert.ok(
      body.includes('const symFallback = outsideWorkspace ? null : this.symbolFallbackFromLinkText(linkText)'),
      'fallback not gated on it',
    );
    // Only absolute paths can be judged this way; a relative one is workspace-ish
    // by definition and keeps the old behaviour.
    assert.ok(body.includes("cleanPath.startsWith('/')"), 'not restricted to absolute paths');
    assert.ok(body.includes('workspaceFolders'), 'workspace folders not consulted');
  });

  test('a missing file INSIDE the workspace keeps the symbol fallback', () => {
    // That case is why the fallback exists: the model guessed a wrong path for a
    // file that is genuinely in this repo, and LSP can still find it.
    const body = bodyOf(provider, 'private async handleOpenFile');
    assert.ok(body.includes('await this.handleOpenSymbol(symFallback)'), 'fallback removed entirely');
  });

  test('a total miss is reported instead of silently offering the wrong repo', () => {
    const body = bodyOf(provider, 'private async handleOpenSymbol');
    // NOT the first Quick Open in the method — that one is the AMBIGUOUS-match
    // path ("Multiple candidates — let user pick"), which is a legitimate silent
    // hand-off. The miss path is the one after the ripgrep attempt.
    const at = body.indexOf('Ripgrep found nothing either');
    assert.ok(at > 0, 'the ripgrep-miss branch is gone');
    // Bounded by the Quick Open call itself rather than a character count: the
    // explanatory comment pushed it to 922 chars and a 900-char window missed it,
    // which is the fixed-slice trap this repo keeps re-learning.
    const qAt = body.indexOf("'workbench.action.quickOpen'", at);
    assert.ok(qAt > at, 'Quick Open fallback missing');
    const before = body.slice(at, qAt);
    assert.ok(before.includes('showWarningMessage'), 'the miss is still silent');
    assert.ok(/sibling repositories/.test(before), 'message does not explain the scope');
    assert.ok(/Quick Open searches the current workspace only/.test(before), 'scope caveat missing');
  });

  test('the warning names the symbol, so it is actionable', () => {
    const body = bodyOf(provider, 'private async handleOpenSymbol');
    const at = body.indexOf('Ripgrep found nothing either');
    const before = body.slice(at, body.indexOf("'workbench.action.quickOpen'", at));
    assert.ok(before.includes('${symbolName}'), 'symbol name not in the message');
  });
});

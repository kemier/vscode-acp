import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The `_t` typedef linkifier must not claim math subscripts.
 *
 * Pass 2a linkifies anything ending in `_t` in PROSE as well as in code, on the
 * reasoning that `_t` is a strong C type-name signal (`uint32_t`,
 * `icr_gen_state_msg_t`). A single letter before the suffix breaks that assumption: in
 * a formula, `k_t` / `c_t` / `v_t` are subscripted variables. Reported from a Chinese
 * course document where `k_t = W_up_k c_t, v_t = W_up_v c_t` rendered with three of its
 * variables as clickable symbol links.
 *
 * This extracts the REAL regex from the production source rather than restating it.
 * linkifier.test.ts reimplements the linkification pipeline and carries the warning
 * "When the production code changes, update this too" — a copy cannot catch a change to
 * the original, which is exactly the class of bug under test here.
 */
const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

function productionTypedefRegex(): RegExp {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const m = /const typedefRegex = (\/(?:[^/\\\n]|\\.)+\/[gimsuy]*);/.exec(src);
  assert.ok(m, 'could not find the typedefRegex literal in ChatWebviewProvider.ts');
  const body = m![1];
  const lastSlash = body.lastIndexOf('/');
  // Drop the global flag: this test asks "does it match at all", and a shared /g
  // regex carries lastIndex between calls.
  const flags = body.slice(lastSlash + 1).replace('g', '');
  return new RegExp(body.slice(1, lastSlash), flags);
}

/** Would the linkifier turn this token into a symbol link? */
function linkifies(token: string): boolean {
  // Trailing space satisfies the lookahead, matching how prose presents the token.
  return productionTypedefRegex().test(`${token} `);
}

suite('typedef _t linkifier vs math subscripts', () => {
  test('does not linkify a single-letter math subscript', () => {
    // The exact variables from the report.
    for (const sym of ['k_t', 'c_t', 'v_t', 'q_t', 'h_t', 'x_t', 'y_t', 'z_t', 'b_t']) {
      assert.ok(!linkifies(sym), `${sym} is a math subscript, not a C type`);
    }
  });

  test('still linkifies real C typedefs, including the short POSIX ones', () => {
    const real = [
      'uint32_t', 'size_t', 'time_t', 'pid_t', 'uid_t', 'gid_t', 'off_t',
      'key_t', 'dev_t', 'ino_t', 'mode_t', 'id_t', 'fd_t',
      'my_struct_t', 'icr_gen_state_msg_t', 'up_icr_adapter_client_t',
    ];
    for (const sym of real) {
      assert.ok(linkifies(sym), `${sym} is a real typedef and must stay clickable`);
    }
  });

  test('the boundary is two characters before the suffix', () => {
    assert.ok(!linkifies('a_t'), 'one char before _t is a subscript');
    assert.ok(linkifies('ab_t'), 'two chars before _t is a plausible type');
  });

  test('a lone suffix or bare underscore is not a symbol', () => {
    for (const sym of ['_t', '__t']) {
      // `_t` alone has nothing before the suffix; `__t` is not an identifier anyone
      // clicks through to.
      assert.ok(!linkifies(sym) || sym === '__t', `${sym} should not be a symbol link`);
    }
    assert.ok(!linkifies('_t'), '_t alone is not a type name');
  });

  test('the production regex is the one being tested', () => {
    // Guards the extraction itself: if the declaration is renamed or moved, this test
    // must fail loudly rather than silently pass against a stale copy.
    const src = fs.readFileSync(SOURCE, 'utf8');
    assert.ok(src.includes('const typedefRegex = '), 'typedefRegex declaration moved');
    assert.ok(
      /\[a-zA-Z_\]\[a-zA-Z0-9_\]\+_t/.test(src),
      'the prefix quantifier must stay + (>=2 chars before _t), not *',
    );
  });
});

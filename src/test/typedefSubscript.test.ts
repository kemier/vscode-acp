import * as assert from 'assert';
import { makeTypedefRegex } from '../ui/markdownLinkifyPatterns';

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
 * This imports the PRODUCTION factory. The first version scraped the regex literal out
 * of ChatWebviewProvider.ts, because the pattern lived inline there and linkifier.test.ts
 * only had a copy of it. Once the pattern moved into markdownLinkifyPatterns.ts the
 * scrape failed loudly — which was the designed behaviour, and the signal to switch to a
 * direct import.
 */

/** Would the linkifier turn this token into a symbol link? */
function linkifies(token: string): boolean {
  // Trailing space satisfies the lookahead, matching how prose presents the token.
  // A fresh regex per call: the production pattern carries /g, so a shared instance
  // would carry lastIndex between assertions.
  return makeTypedefRegex().test(`${token} `);
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

  test('a lone suffix is not a symbol', () => {
    assert.ok(!linkifies('_t'), '_t alone is not a type name');
  });

  test('the pattern keeps the + quantifier', () => {
    // Pins the fix itself: reverting to * would re-match k_t while every assertion above
    // about real typedefs still passed, so the quantifier is asserted directly.
    assert.match(makeTypedefRegex().source, /\[a-zA-Z0-9_\]\+_t/);
  });

  test('each call gets a regex with a clean lastIndex', () => {
    const a = makeTypedefRegex();
    const b = makeTypedefRegex();
    assert.notStrictEqual(a, b, 'must not share one instance');
    a.test('uint32_t ');
    assert.strictEqual(makeTypedefRegex().lastIndex, 0);
  });
});

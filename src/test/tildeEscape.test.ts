import * as assert from 'assert';
import { escapeUnbalancedTildes } from '../utils/tildeEscape';

/**
 * Guards the "horizontal line through an assistant message" bug: marked in GFM
 * mode parses a single `~` flanked by non-whitespace on the right as the start
 * of a strikethrough, pairing it with the next such `~`. Model prose like
 * `baseline~26 and throttled~260` or `fs@vsfo-N:~$ / root@vsfo-N:~#` therefore
 * rendered a line through the middle of the text. escapeUnbalancedTildes must
 * escape the strike-risk shape, leave code spans and space-adjacent tildes
 * alone, and preserve genuine `~~text~~` strikethrough.
 */

suite('escapeUnbalancedTildes', () => {
  test('escapes a ~ glued to a following word/digit (the strike shape)', () => {
    assert.strictEqual(escapeUnbalancedTildes('baseline~26 and throttled~260'), 'baseline\\~26 and throttled\\~260');
  });

  test('escapes a ~ at the start of a line glued to a number', () => {
    assert.strictEqual(escapeUnbalancedTildes('~173 packages installed'), '\\~173 packages installed');
  });

  test('escapes the ~ in a shell prompt in plain prose', () => {
    assert.strictEqual(
      escapeUnbalancedTildes('fs@vsfo-N:~$ / root@vsfo-N:~#'),
      'fs@vsfo-N:\\~$ / root@vsfo-N:\\~#'
    );
  });

  test('leaves a ~ inside a backtick code span untouched', () => {
    assert.strictEqual(escapeUnbalancedTildes('see `~/.netrc` and `~/.cargo/bin/rtk`'), 'see `~/.netrc` and `~/.cargo/bin/rtk`');
  });

  test('leaves a ~ followed by a space untouched (not a strike shape)', () => {
    assert.strictEqual(escapeUnbalancedTildes('about ~ 173 packages'), 'about ~ 173 packages');
  });

  test('preserves a genuine ~~text~~ strikethrough', () => {
    assert.strictEqual(escapeUnbalancedTildes('a ~~intentional strike~~ here'), 'a ~~intentional strike~~ here');
  });

  test('handles a mix of code-span and plain-prose tildes', () => {
    assert.strictEqual(
      escapeUnbalancedTildes('verify `~/.cargo/bin/rtk` and the ~173 packages'),
      'verify `~/.cargo/bin/rtk` and the \\~173 packages'
    );
  });

  test('returns text unchanged when it has no tildes', () => {
    assert.strictEqual(escapeUnbalancedTildes('no tildes here at all'), 'no tildes here at all');
  });

  test('is idempotent (running twice gives the same result)', () => {
    const once = escapeUnbalancedTildes('baseline~26 and throttled~260');
    // The escaped form has \~ which the function must not re-escape.
    assert.strictEqual(escapeUnbalancedTildes(once), once);
  });
});

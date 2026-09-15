import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  ENGLISH_SNAKE_CASE_PHRASES,
  LANGUAGE_KEYWORDS,
  NON_SYMBOL_CALL_NAMES,
  NON_SYMBOL_PASCAL_CASE,
} from '../ui/markdownLinkifyKeywords';

/**
 * The linkifier's keyword allowlists live in their own module.
 *
 * They were ~800 lines of literal data inline in ChatWebviewProvider.ts — over 3% of
 * the file — sitting between the regex that consumes them and the code that acts on
 * the result. Moving them out is behaviour-neutral by construction (pure data, no
 * imports, nothing to execute) but only if nothing is dropped in the move, which is
 * what these tests pin.
 *
 * The counts are asserted exactly. A term removed by accident does not fail anything
 * else: the linkifier would simply start turning that word into a broken symbol link,
 * which nobody would notice until it appeared in prose.
 */
const PROVIDER = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');
const MODULE = path.resolve(__dirname, '../../src/ui/markdownLinkifyKeywords.ts');

suite('markdown linkify keyword lists', () => {
  test('every list survived the extraction intact', () => {
    // Sizes measured against the inline originals at the moment of the move, then
    // updated when a list legitimately grows. LANGUAGE_KEYWORDS went 240 -> 512 to add
    // the plain single-word keywords: the markdown-link pass gates only on this set with
    // no structural filter, so `[consteval](file.h)` was becoming an @symbol link.
    assert.strictEqual(LANGUAGE_KEYWORDS.size, 512, 'language keywords');
    assert.strictEqual(NON_SYMBOL_PASCAL_CASE.size, 271, 'PascalCase product names');
    assert.strictEqual(ENGLISH_SNAKE_CASE_PHRASES.size, 117, 'English snake_case phrases');
    assert.strictEqual(NON_SYMBOL_CALL_NAMES.length, 79, 'call-position names');
  });

  test('the plain keywords the link pass needs are present and lowercase', () => {
    // Both consumers compare lowercased — `has(symLower)` in the markdown-link pass and
    // `includes(symName.toLowerCase())` in Pass 2b — so a capitalized entry is dead
    // weight that silently fails to match.
    for (const kw of ['consteval', 'const', 'int', 'auto', 'class', 'string', 'option', 'result']) {
      assert.ok(LANGUAGE_KEYWORDS.has(kw), `${kw} must be listed`);
    }
    for (const kw of LANGUAGE_KEYWORDS) {
      assert.strictEqual(kw, kw.toLowerCase(), `${kw} must be stored lowercase`);
    }
  });

  test('representative members of each list are present', () => {
    // Chosen from different regions of each list, so a truncated extraction shows up.
    for (const kw of ['thread_local', 'static_assert', '_atomic', 'typeof_unqual']) {
      assert.ok(LANGUAGE_KEYWORDS.has(kw), 'language keyword: ' + kw);
    }
    for (const kw of ['WebSocket', 'GitHub', 'TypeScript', 'ChatGPT', 'EricAI']) {
      assert.ok(NON_SYMBOL_PASCAL_CASE.has(kw), 'product name: ' + kw);
    }
    for (const kw of ['if', 'for', 'sizeof', 'apply_patch', 'update_goal']) {
      assert.ok(NON_SYMBOL_CALL_NAMES.includes(kw), 'call-position name: ' + kw);
    }
  });

  test('the call-position list stays an array, since the caller uses includes()', () => {
    // A Set here would silently make `keywords.includes(...)` a TypeError at runtime.
    assert.ok(Array.isArray(NON_SYMBOL_CALL_NAMES));
    const provider = fs.readFileSync(PROVIDER, 'utf8');
    assert.ok(
      provider.includes('keywords.includes(symName.toLowerCase())'),
      'the call site must still be an includes() lookup',
    );
  });

  test('the provider references the module instead of inlining the data', () => {
    const provider = fs.readFileSync(PROVIDER, 'utf8');
    assert.ok(provider.includes("from './markdownLinkifyKeywords'"), 'must import the module');
    assert.ok(provider.includes('private static readonly langKeywords = LANGUAGE_KEYWORDS;'));
    assert.ok(provider.includes('const keywords = NON_SYMBOL_PASCAL_CASE;'));
    assert.ok(provider.includes('const keywords = NON_SYMBOL_CALL_NAMES;'));
    // The existing consumers are untouched, which is what makes this behaviour-neutral.
    assert.ok(provider.includes('ChatWebviewProvider.langKeywords.has(symLower)'));
    assert.ok(provider.includes('const codeSymKw = [...ChatWebviewProvider.langKeywords];'));
    // And the dead local is gone rather than moved.
    assert.ok(!provider.includes('_snakeKeywords'), 'the unused local must not come back');
  });

  test('the module is data only, so it cannot change behaviour', () => {
    const mod = fs.readFileSync(MODULE, 'utf8');
    // No imports and no requires: the whole point of the split is that a reviewer can
    // add a term without reasoning about the linkifier.
    assert.ok(!/^\s*import\s/m.test(mod), 'the data module must not import anything');
    assert.ok(!/\brequire\s*\(/.test(mod), 'and must not require anything');

    // Structural check rather than a keyword scan: 'function' and '=>' appear IN the
    // data (they are language keywords), so searching for them finds the payload, not
    // logic. Instead assert every code line is a declaration, an entry, or a closer.
    const code = mod
      .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, '').trim())
      .filter((l) => l.length > 0);
    const allowed =
      /^(?:export const [A-Z_]+(?:: (?:ReadonlySet<string>|readonly string\[\]))? = (?:new Set\(\[|\[)|'(?:[^'\\]|\\.)*',?|\]\);?|\];?)$/;
    const offenders = code.filter((l) => !allowed.test(l));
    assert.deepStrictEqual(offenders, [], 'only declarations, entries and closers are allowed');

    // Exactly the four expected exports, nothing else.
    const exports = mod.match(/^export const (\w+)/gm) ?? [];
    assert.strictEqual(exports.length, 4, 'four lists: ' + exports.join(', '));
  });
});

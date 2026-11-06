import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Empty-query memory recall must still fetch the query-INDEPENDENT arms
 * (persona, scene navigation, skills) so a prompt with no composer text —
 * e.g. an image-only prompt — still gets the agent's profile injected.
 *
 * Previously `buildRecallBlocks` short-circuited on both an empty raw query
 * AND an empty sanitized query, returning `[]` before any arm fired. That
 * dropped persona (`readCore`), scenes (`listScenarios`), and the default
 * top-N skill listing (`listSkills` with no `query`) alongside the L1
 * semantic search — even though only L1 actually needs a query. Reported
 * by the user 2026-11-06 on vscode-acp local/dev + a2a: a pictures-only
 * prompt failed to trigger memory/skill recall on both agent adapters
 * (ericli, claude-code-acp) because the recall path lives entirely on the
 * extension side and never saw a query.
 *
 * Fix (Option B): split the early-return. Keep going when the user
 * disabled all four arms (truly nothing to fetch), otherwise run the
 * query-independent arms unconditionally and only skip the L1 semantic
 * search when there is no query. See the "hasQuery" block in
 * `SharedMemoryProvider.buildRecallBlocks`.
 */

const ROOT = path.resolve(__dirname, '../..');
const PROVIDER = fs.readFileSync(path.resolve(ROOT, 'src/core/memory/SharedMemoryProvider.ts'), 'utf8');

function sliceAround(haystack: string, marker: string, before = 0, after = 400): string {
  const at = haystack.indexOf(marker);
  if (at < 0) {
    return '';
  }
  return haystack.slice(Math.max(0, at - before), at + marker.length + after);
}

suite('SharedMemoryProvider.buildRecallBlocks — empty-query recall still fetches query-independent arms', () => {
  test('the function no longer short-circuits on empty raw query alone', () => {
    // The pre-fix guard was `if (!opts.query.trim()) return [];`. If that
    // guard reappears anywhere inside buildRecallBlocks, image-only prompts
    // will again drop persona/scenes/skills — regression.
    assert.ok(
      !/\bif\s*\(\s*!opts\.query\.trim\(\)\s*\)\s*\{\s*return\s*\[\s*\]/.test(PROVIDER),
      "the `if (!opts.query.trim()) return []` short-circuit must be gone — see Option B in the file comment",
    );
  });

  test('the function no longer short-circuits on empty sanitized query alone', () => {
    // The post-sanitization guard `const query = buildRecallQuery(...); if (!query) return [];`
    // must likewise be gone. The sanitized value is now kept as `sanitizedQuery`
    // and feeds a `hasQuery` boolean.
    assert.ok(
      PROVIDER.includes('const sanitizedQuery = buildRecallQuery('),
      'sanitized query must be captured as `sanitizedQuery` for the hasQuery decision',
    );
    assert.ok(
      PROVIDER.includes('const hasQuery = sanitizedQuery.length > 0'),
      '`hasQuery` boolean must drive the L1 arm',
    );
  });

  test('the short-circuit only fires when every arm is disabled', () => {
    // The replacement guard must OR all four conditions together — otherwise
    // disabling one arm (e.g. includeSceneNav=false) silently kills recall
    // for empty-text prompts that still wanted persona + skills.
    const body = sliceAround(PROVIDER, 'if (!hasQuery && !includePersona && !includeSceneNav && !includeSkills)', 0, 60);
    assert.ok(body.length > 0, 'the four-way guard must be present verbatim');
    assert.ok(body.includes('return [];'), 'and it must still return [] when nothing is to be fetched');
  });

  test('the L1 search arm runs only when hasQuery is true', () => {
    // A dummy `Promise.resolve({items: []})` keeps the Promise.allSettled
    // shape identical when there is no query, so no downstream branch needs
    // to know whether we ran the search.
    const armsAt = PROVIDER.indexOf('await Promise.allSettled([');
    assert.ok(armsAt > 0, 'the arms block must exist');
    const arms = PROVIDER.slice(armsAt, armsAt + 1200);
    assert.ok(
      arms.includes('hasQuery'),
      'the L1 arm must be gated on hasQuery, not fire unconditionally',
    );
    assert.ok(
      arms.includes('Promise.resolve({ items: [] })') ||
        arms.includes("Promise.resolve({items:[]})"),
      'an empty-items promise must stand in for the skipped L1 arm so the shape is unchanged',
    );
    assert.ok(
      arms.includes('client.searchAtomic(iso, { query'),
      'the real L1 arm (searchAtomic) must still be the hasQuery=true branch',
    );
  });

  test('listSkills receives `query` only when hasQuery; otherwise falls back to the default top-N listing', () => {
    // The gateway treats an explicit empty-string query differently from
    // a missing query — the latter returns the default top-N top-of-catalog
    // listing, which is what we want when the user has no query.
    const armsAt = PROVIDER.indexOf('listSkills(iso');
    assert.ok(armsAt > 0, 'listSkills must still be called from the arms block');
    const arm = PROVIDER.slice(armsAt, armsAt + 300);
    assert.ok(
      arm.includes('...(hasQuery ? { query } : {})'),
      'listSkills must spread `{query}` only when hasQuery, so no-query callers get the default listing',
    );
  });

  test('debug log flags the no-query branch so the diagnostic is explicit', () => {
    assert.ok(
      PROVIDER.includes("(no query — skills/persona/scenes only)"),
      'the recall START log must surface the no-query-but-still-fetching case to make live triage obvious',
    );
  });
});

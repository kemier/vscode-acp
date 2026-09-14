import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { cleanSessionTitle } from '../utils/TitleCleaner';

suite('cleanSessionTitle', () => {
  test('strips single [@name](file:///...) link', () => {
    const input = '[@json_v3_10_5.hpp](file:///workspace/git/repo/json_v3_10_5.hpp)go on';
    assert.strictEqual(cleanSessionTitle(input), 'go on');
  });

  test('strips multiple concatenated [@name](file:///...) links', () => {
    const input =
      '[@json_v3_10_5.hpp](file:///workspace/git/repo/json_v3_10_5.hpp)' +
      '[@PduSessionRequestHandler.h](file:///workspace/git/repo/PduSessionRequestHandler.h)' +
      '[@new](file:///proj/epg-tools/gcc/16.1.0_1.rhel8/include/c%2B%2B/16.1.0/new)' +
      'run sft in up/epg';
    assert.strictEqual(cleanSessionTitle(input), 'run sft in up/epg');
  });

  test('strips links with query params (?symbol=...#L123)', () => {
    const input = '[@process_line](file:///workspace/git/repo/src/main.rs?symbol=process_line#L195)do something';
    assert.strictEqual(cleanSessionTitle(input), 'do something');
  });

  test('strips links with zed:// scheme', () => {
    const input = '[@terminal](zed:///agent/terminal-selection?lines=42)go on';
    assert.strictEqual(cleanSessionTitle(input), 'go on');
  });

  test('strips JSON resource_link blocks (Kiro format)', () => {
    const input = '{"name":"file.ts","uri":"file:///workspace/repo/file.ts","type":"resource_link"}' + 'do the thing';
    assert.strictEqual(cleanSessionTitle(input), 'do the thing');
  });

  test('strips <context ref="...">...</context> blocks', () => {
    const input = '<context ref="file:///workspace/repo/file.ts">some context</context>go on';
    assert.strictEqual(cleanSessionTitle(input), 'go on');
  });

  test('strips bare zed:/// URIs', () => {
    const input = 'zed:///agent/terminal-selection?lines=243 go on';
    assert.strictEqual(cleanSessionTitle(input), 'go on');
  });

  test('returns empty when only context links present', () => {
    const input = '[@json_v3_10_5.hpp](file:///workspace/git/repo/json_v3_10_5.hpp)';
    assert.strictEqual(cleanSessionTitle(input), '');
  });

  test('returns empty for null/undefined', () => {
    assert.strictEqual(cleanSessionTitle(null), '');
    assert.strictEqual(cleanSessionTitle(undefined), '');
    assert.strictEqual(cleanSessionTitle(''), '');
  });

  test('preserves plain text without context links', () => {
    assert.strictEqual(cleanSessionTitle('hello world'), 'hello world');
    assert.strictEqual(cleanSessionTitle('run sft in up/epg'), 'run sft in up/epg');
  });

  test('strips trailing Additional ACP context dump', () => {
    const input = 'hello world\n\nAdditional ACP context:\n[ACP resource_link] Foo.ts (file:///tmp/Foo.ts)\ncode';
    assert.strictEqual(cleanSessionTitle(input), 'hello world');
  });

  test('preserves non-context markdown links (no scheme://)', () => {
    const input = '[not a link](relative/path)hello';
    assert.strictEqual(cleanSessionTitle(input), '[not a link](relative/path)hello');
  });

  test('handles mixed context types', () => {
    const input =
      '[@file.ts](file:///workspace/repo/file.ts)' +
      '{"name":"other.ts","uri":"file:///workspace/repo/other.ts","type":"resource_link"}' +
      '<context ref="file:///workspace/repo/ctx.ts">ctx</context>' +
      'go on';
    assert.strictEqual(cleanSessionTitle(input), 'go on');
  });

  test('trims whitespace around stripped content', () => {
    const input = '  [@file.ts](file:///workspace/repo/file.ts)  go on  ';
    assert.strictEqual(cleanSessionTitle(input), 'go on');
  });

  test('handles the exact raw title from the user report', () => {
    const input =
      '[@json_v3_10_5.hpp](file:///workspace/git/ezennin/vepg/epg/up/tw/up-common/3pp/sources/nlohmann-json/tests/abi/include/nlohmann/json_v3_10_5.hpp)' +
      '[@PduSessionRequestHandler.h](file:///workspace/git/ezennin/vepg/epg/application/PgwControlPlane/pdu/include/PgwPdu/PduSessionRequestHandler.h)' +
      '[@NxInfo.h](file:///workspace/git/ezennin/vepg/epg/application/PgwControlPlane/signalflowtest/psci/framework/test-include/PsciSftFramework/Ebm/NxInfo.h)' +
      '[@N2ResModifyUpdateHandler.h](file:///workspace/git/ezennin/vepg/epg/application/PgwControlPlane/pdu/include/PgwPdu/N2ResModifyUpdateHandler.h)' +
      '[@UserPlaneSummaryData.h](file:///workspace/git/ezennin/vepg/epg/application/PgwControlPlane/pdp/src/UserPlaneSummaryData.h)' +
      '[@new](file:///proj/epg-tools/gcc/16.1.0_1.rhel8/include/c%2B%2B/16.1.0/new)' +
      'go on';
    assert.strictEqual(cleanSessionTitle(input), 'go on');
  });
});

/**
 * A bare @mention is a REQUEST for context, not the subject of the session.
 *
 * The host resolves it into a `<context ref="…">` block (or an ACP resource) and
 * leaves the literal `@clipboard` in the prose. Every other step in cleanSessionTitle
 * removes the BLOCK, so a prompt that was nothing but `@clipboard` plus its payload
 * reduced to the mention itself and the session banner read "@clipboard".
 */
suite('cleanSessionTitle strips leading context mentions', () => {
  test('the reported case: mention whose block has been stripped', () => {
    assert.strictEqual(cleanSessionTitle('@clipboard '), '');
    assert.strictEqual(cleanSessionTitle('@clipboard'), '');
  });

  test('the prose after the mention becomes the title', () => {
    assert.strictEqual(cleanSessionTitle('@clipboard explain this diff'), 'explain this diff');
    assert.strictEqual(cleanSessionTitle('  @clipboard   review it'), 'review it');
  });

  test('several mentions can open a prompt', () => {
    assert.strictEqual(cleanSessionTitle('@terminal @problems fix this'), 'fix this');
  });

  test('every mention form the host resolves is handled', () => {
    for (const m of ['clipboard', 'terminal', 'problems', 'selection', 'file', 'folder']) {
      assert.strictEqual(cleanSessionTitle('@' + m + ' do the thing'), 'do the thing', m);
    }
  });

  test('a MID-SENTENCE mention is prose and must survive', () => {
    // Asking a question about the feature is the obvious case, and that sentence is
    // the better title of the two. Mirrors hasLeadingClipboardMention, which is what
    // decides whether the host attaches anything at all.
    assert.strictEqual(cleanSessionTitle('how does @clipboard work?'), 'how does @clipboard work?');
    assert.strictEqual(cleanSessionTitle('compare @terminal output'), 'compare @terminal output');
  });

  test('a word that merely starts with a mention is untouched', () => {
    assert.strictEqual(cleanSessionTitle('@clipboardfoo bar'), '@clipboardfoo bar');
  });

  test('ordinary titles are unaffected', () => {
    assert.strictEqual(cleanSessionTitle('enrich the references'), 'enrich the references');
  });
});

/**
 * The cleaner is only half the fix: a caller that falls back to the RAW title on an
 * empty result puts the mention straight back. Three call sites fall back to a short
 * session id; the session banner used to fall back to session.title, which is exactly
 * where "@clipboard" was being displayed.
 */
suite('no caller reinstates the raw title', () => {
  const providerSrc = fs.readFileSync(path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts'), 'utf8');

  test('the session banner does not fall back to session.title', () => {
    assert.ok(
      providerSrc.includes('title: cleanSessionTitle(session.title),'),
      'the banner must use the cleaned title as-is',
    );
    assert.ok(
      !providerSrc.includes('cleanSessionTitle(session.title) || session.title'),
      'falling back to the raw title reinstates the bare mention',
    );
  });

  test('the tree views fall back to a session id, never the raw title', () => {
    const treeSrc = fs.readFileSync(path.resolve(__dirname, '../../src/ui/SessionTreeProvider.ts'), 'utf8');
    const fallbacks = treeSrc.split('cleanSessionTitle(').length - 1;
    assert.ok(fallbacks >= 3, `expected the tree call sites, found ${fallbacks}`);
    assert.ok(
      !/cleanSessionTitle\([^)]*\) \|\| (?:title|entry\.title|info\.title)/.test(treeSrc),
      'no tree call site may fall back to the raw title',
    );
  });
});

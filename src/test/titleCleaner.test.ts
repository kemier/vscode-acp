import * as assert from 'assert';
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
    const input =
      'hello world\n\nAdditional ACP context:\n[ACP resource_link] Foo.ts (file:///tmp/Foo.ts)\ncode';
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

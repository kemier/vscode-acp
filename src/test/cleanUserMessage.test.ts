import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Standalone reimplementation of cleanUserMessage + stripTag from
 * ChatWebviewProvider's webview JS, for testing without vscode deps.
 * This mirrors the exact logic used in production code.
 * When the production code changes, update this too.
 */

function stripTag(text: string, tagName: string, replacement: ((block: string) => string) | null): string {
  const openTag = '<' + tagName;
  const closeTag = '</' + tagName + '>';
  let result = '';
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf(openTag, i);
    if (start === -1) {
      result += text.slice(i);
      break;
    }
    result += text.slice(i, start);
    const end = text.indexOf(closeTag, start);
    if (end === -1) {
      break;
    }
    const block = text.slice(start, end + closeTag.length);
    if (replacement) {
      result += replacement(block);
    }
    i = end + closeTag.length;
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 10 || c === 13 || c === 9) {
        i++;
      } else {
        break;
      }
    }
  }
  return result;
}

function selectionReplacement(block: string): string {
  const pathMatch = block.match(/path="([^"]+)"/);
  const linesMatch = block.match(/lines="([^"]+)"/);
  if (pathMatch && linesMatch) {
    const lineStart = linesMatch[1].split('-')[0];
    return '[Selected code: ' + pathMatch[1] + ':' + lineStart + ']' + '\n\n';
  }
  return '';
}

function cleanUserMessage(rawText: string): string {
  let displayText = rawText;
  displayText = stripTag(displayText, 'open_files', null);
  displayText = stripTag(displayText, 'terminal', null);
  displayText = stripTag(displayText, 'problems', null);
  displayText = stripTag(displayText, 'file', null);
  displayText = stripTag(displayText, 'folder', null);
  displayText = stripTag(displayText, 'selection', selectionReplacement);

  // Strip leading markdown-style context reference links
  while (true) {
    let start = 0;
    while (start < displayText.length) {
      const c = displayText.charCodeAt(start);
      if (c === 32 || c === 10 || c === 13 || c === 9) {
        start++;
      } else {
        break;
      }
    }
    const trimmed = displayText.substring(start);
    if (trimmed.charCodeAt(0) !== 91 /* '[' */) {
      break;
    }
    const closeBracket = trimmed.indexOf('](');
    if (closeBracket < 0) {
      break;
    }
    const closeParen = trimmed.indexOf(')', closeBracket + 2);
    if (closeParen < 0) {
      break;
    }
    const uriPart = trimmed.substring(closeBracket + 2, closeParen);
    const colonSlash = uriPart.indexOf('://');
    if (colonSlash < 1) {
      break;
    }
    let validScheme = true;
    for (let si = 0; si < colonSlash; si++) {
      const sc = uriPart.charCodeAt(si);
      if (!((sc >= 97 && sc <= 122) || (sc >= 48 && sc <= 57) || sc === 43 || sc === 46 || sc === 45)) {
        validScheme = false;
        break;
      }
    }
    if (!validScheme) {
      break;
    }
    displayText = trimmed.substring(closeParen + 1);
  }

  displayText = stripTag(displayText, 'context', null);
  // Shared-memory recall blob (SharedMemoryProvider) — machine context that
  // session/load replays back inside the user message.
  displayText = stripTag(displayText, 'agent-memory', null);
  displayText = stripTag(displayText, 'relevant-memories', null);
  displayText = stripTag(displayText, 'user-persona', null);
  displayText = stripTag(displayText, 'relevant-scenes', null);
  displayText = stripTag(displayText, 'scene-navigation', null);
  displayText = stripTag(displayText, 'memory-tools-guide', null);

  const acpCtxMarker = 'Additional ACP context:';
  const acpCtxIdx = displayText.indexOf(acpCtxMarker);
  if (acpCtxIdx >= 0) {
    let acpCut = acpCtxIdx;
    while (acpCut > 0) {
      const ac = displayText.charCodeAt(acpCut - 1);
      if (ac === 32 || ac === 10 || ac === 13 || ac === 9) {
        acpCut--;
      } else {
        break;
      }
    }
    displayText = displayText.substring(0, acpCut);
  }

  const zedProto = 'zed:///';
  let zedIdx = displayText.indexOf(zedProto);
  while (zedIdx !== -1) {
    let zedEnd = zedIdx + zedProto.length;
    while (zedEnd < displayText.length) {
      const zc = displayText.charCodeAt(zedEnd);
      if (zc === 32 || zc === 10 || zc === 13 || zc === 9) {
        break;
      }
      zedEnd++;
    }
    displayText = displayText.slice(0, zedIdx) + displayText.slice(zedEnd);
    zedIdx = displayText.indexOf(zedProto);
  }

  let leadEnd = 0;
  while (leadEnd < displayText.length) {
    const lc = displayText.charCodeAt(leadEnd);
    if (lc === 32 || lc === 10 || lc === 13 || lc === 9) {
      leadEnd++;
    } else {
      break;
    }
  }
  if (leadEnd > 0) {
    displayText = displayText.slice(leadEnd);
  }

  let end = displayText.length;
  while (end > 0) {
    const ch = displayText.charCodeAt(end - 1);
    if (ch === 32 || ch === 10 || ch === 13 || ch === 9) {
      end--;
    } else {
      break;
    }
  }
  displayText = displayText.slice(0, end);

  if (displayText.trim() === '' && rawText.trim() !== '') {
    const hadContext =
      rawText.indexOf('[@') >= 0 ||
      rawText.indexOf('<open_files') >= 0 ||
      rawText.indexOf('<selection') >= 0 ||
      rawText.indexOf('<terminal') >= 0 ||
      rawText.indexOf('<problems') >= 0 ||
      rawText.indexOf('<file') >= 0 ||
      rawText.indexOf('<folder') >= 0 ||
      rawText.indexOf('<context') >= 0 ||
      rawText.indexOf('<agent-memory') >= 0 ||
      rawText.indexOf('<relevant-memories') >= 0 ||
      rawText.indexOf('<user-persona') >= 0 ||
      rawText.indexOf('zed:///') >= 0 ||
      rawText.indexOf('Additional ACP context:') >= 0 ||
      rawText.indexOf('[ACP resource_link]') >= 0;
    if (hadContext) {
      return '';
    }
    displayText = rawText;
  }
  return displayText;
}

suite('cleanUserMessage', () => {
  suite('context link stripping', () => {
    test('strips single [@name](file:///path) link, keeps real text', () => {
      const input = '[@foo.h](file:///workspace/src/foo.h)run sft in up/epg';
      assert.strictEqual(cleanUserMessage(input), 'run sft in up/epg');
    });

    test('strips multiple concatenated [@name](file:///path) links', () => {
      const input =
        '[@json_v3_10_5.hpp](file:///workspace/path/json_v3_10_5.hpp)' +
        '[@PduSessionRequestHandler.h](file:///workspace/path/PduSessionRequestHandler.h)' +
        '[@NxInfo.h](file:///workspace/path/NxInfo.h)' +
        'run sft in up/epg';
      assert.strictEqual(cleanUserMessage(input), 'run sft in up/epg');
    });

    test('strips Cursor Agent trailing Additional ACP context dump', () => {
      const input =
        "what's the relationship between vscode-acp and codex\n\n" +
        'Additional ACP context:\n' +
        '[ACP resource_link] CodexApprovalHandler.ts (file:///Users/zaedinzeng/projects/codex-acp/src/CodexApprovalHandler.ts)\n' +
        'import * as acp from "@agentclientprotocol/sdk";\n';
      assert.strictEqual(cleanUserMessage(input), "what's the relationship between vscode-acp and codex");
    });

    test('returns empty string when chunk is ONLY context links (no real text)', () => {
      const input = '[@foo.h](file:///workspace/src/foo.h)' + '[@bar.h](file:///workspace/src/bar.h)';
      assert.strictEqual(cleanUserMessage(input), '');
    });

    test('returns empty for single [@name](file:///path) with no trailing text', () => {
      const input = '[@settings.json](file:///path/to/settings.json)';
      assert.strictEqual(cleanUserMessage(input), '');
    });

    test('strips [@name](zed:///agent/terminal-selection?lines=42) links', () => {
      const input = '[@terminal](zed:///agent/terminal-selection?lines=42)do the thing';
      assert.strictEqual(cleanUserMessage(input), 'do the thing');
    });

    test('does NOT strip markdown links without a URI scheme', () => {
      const input = '[not a link](relative/path)hello';
      assert.strictEqual(cleanUserMessage(input), '[not a link](relative/path)hello');
    });

    test('preserves normal text with no context links', () => {
      assert.strictEqual(cleanUserMessage('hello world'), 'hello world');
      assert.strictEqual(cleanUserMessage('run sft in up/epg'), 'run sft in up/epg');
    });

    test('returns empty string for empty input', () => {
      assert.strictEqual(cleanUserMessage(''), '');
    });

    test('returns original text if result is empty but had no context markers', () => {
      assert.strictEqual(cleanUserMessage('   '), '');
    });
  });

  suite('chunked arrival simulation', () => {
    test('chunk 1 = only links, chunk 2 = real text, coalesced = real text only', () => {
      const chunk1 = '[@foo.h](file:///workspace/src/foo.h)[@bar.h](file:///workspace/src/bar.h)';
      const chunk2 = 'run sft in up/epg';

      let coalesced = '';
      const r1 = cleanUserMessage(chunk1);
      if (r1 !== '') {
        coalesced += r1;
      }
      const r2 = cleanUserMessage(chunk2);
      if (r2 !== '') {
        coalesced += r2;
      }

      assert.strictEqual(coalesced, 'run sft in up/epg');
    });

    test('chunk 1 = links + text, chunk 2 = more text, both preserved', () => {
      const chunk1 = '[@foo.h](file:///workspace/src/foo.h)run sft';
      const chunk2 = ' in up/epg';

      // Simulate the production coalescing logic: accumulate raw text,
      // then clean the full concatenation. This mirrors the fix in
      // user_message_chunk that avoids stripping leading whitespace
      // from individual chunks.
      let raw = '';
      raw += chunk1;
      let cleaned = cleanUserMessage(raw);
      // First chunk has real text, so cleaned is non-empty
      assert.strictEqual(cleaned, 'run sft');

      raw += chunk2;
      cleaned = cleanUserMessage(raw);
      assert.strictEqual(cleaned, 'run sft in up/epg');
    });

    test('all chunks are only links, coalesced = empty', () => {
      const chunk1 = '[@foo.h](file:///workspace/src/foo.h)';
      const chunk2 = '[@bar.h](file:///workspace/src/bar.h)';

      let coalesced = '';
      const r1 = cleanUserMessage(chunk1);
      if (r1 !== '') {
        coalesced += r1;
      }
      const r2 = cleanUserMessage(chunk2);
      if (r2 !== '') {
        coalesced += r2;
      }

      assert.strictEqual(coalesced, '');
    });
  });

  suite('XML tag stripping', () => {
    test('strips <open_files> blocks', () => {
      const input = '<open_files>\nfile1.ts\nfile2.ts\n</open_files>do something';
      assert.strictEqual(cleanUserMessage(input), 'do something');
    });

    test('strips <terminal> blocks', () => {
      const input = '<terminal>\n$ ls\n</terminal>run tests';
      assert.strictEqual(cleanUserMessage(input), 'run tests');
    });

    test('strips <problems> blocks', () => {
      const input = '<problems>\nerror: foo\n</problems>fix the bug';
      assert.strictEqual(cleanUserMessage(input), 'fix the bug');
    });

    test('strips <file> blocks', () => {
      const input = '<file path="/tmp/foo.ts">\ncontent\n</file>edit this';
      assert.strictEqual(cleanUserMessage(input), 'edit this');
    });

    test('strips <folder> blocks', () => {
      const input = '<folder path="/tmp/src">\n</folder>look here';
      assert.strictEqual(cleanUserMessage(input), 'look here');
    });

    test('converts <selection> blocks to pill text', () => {
      const input = '<selection path="/tmp/foo.ts" lines="5-9">\nselected code\n</selection>review this';
      const result = cleanUserMessage(input);
      assert.ok(result.includes('[Selected code: /tmp/foo.ts:5]'), `expected pill, got: ${result}`);
      assert.ok(result.includes('review this'), `expected trailing text, got: ${result}`);
    });

    test('strips <context> blocks', () => {
      const input = '<context ref="file:///tmp/foo.ts">some context</context>do work';
      assert.strictEqual(cleanUserMessage(input), 'do work');
    });
  });

  suite('bare zed:/// URI stripping', () => {
    test('strips bare zed:///agent/terminal-selection URIs', () => {
      const input = 'zed:///agent/terminal-selection?lines=243 run tests';
      assert.strictEqual(cleanUserMessage(input), 'run tests');
    });

    test('strips multiple bare zed:/// URIs', () => {
      const input = 'zed:///agent/terminal-selection?lines=10 zed:///agent/diagnostics fix it';
      assert.strictEqual(cleanUserMessage(input), 'fix it');
    });
  });

  suite('whitespace handling', () => {
    test('trims leading whitespace after stripping', () => {
      const input = '  [@foo.h](file:///path/foo.h)  hello';
      assert.strictEqual(cleanUserMessage(input), 'hello');
    });

    test('trims trailing whitespace', () => {
      const input = 'hello  ';
      assert.strictEqual(cleanUserMessage(input), 'hello');
    });

    test('handles newlines between context links and text', () => {
      const input = '[@foo.h](file:///path/foo.h)\n\ndo something';
      assert.strictEqual(cleanUserMessage(input), 'do something');
    });
  });

  suite('regression: real-world Codex CLI output', () => {
    test('large batch of concatenated context links + user text', () => {
      const links = [
        '[@json_v3_10_5.hpp](file:///workspace/vepg/epg/up/tw/up-common/3pp/sources/nlohmann-json/tests/abi/include/nlohmann/json_v3_10_5.hpp)',
        '[@PduSessionRequestHandler.h](file:///workspace/vepg/epg/application/PgwControlPlane/pdu/include/PgwPdu/PduSessionRequestHandler.h)',
        '[@NxInfo.h](file:///workspace/vepg/epg/application/PgwControlPlane/signalflowtest/psci/framework/test-include/PsciSftFramework/Ebm/NxInfo.h)',
        '[@new](file:///proj/epg-tools/gcc/16.1.0_1.rhel8/include/c%2B%2B/16.1.0/new)',
        '[@DereferenceCompared.h](file:///workspace/vepg/epg/framework/Support/Generic/include/Generic/DereferenceCompared.h)',
        '[@MemCheck.h](file:///workspace/vepg/epg/framework/Support/Support/include/Support/Util/MemCheck.h)',
        '[@PgwUserInfoHandlerBase.cpp](file:///workspace/vepg/epg/application/MpgController/MpgController/CommandHandlers/src/PgwUserInfoHandlerBase.cpp)',
        '[@Formattable.h](file:///workspace/vepg/epg/framework/Support/Generic/include/Generic/Formattable.h)',
        '[@function_base.hpp](file:///proj/epg-tools/sysroot/rhel8.10/usr/include/boost/function/function_base.hpp)',
        '[@NrfConfigurationTest.cpp](file:///workspace/vepg/epg/application/NetworkRepositoryFunction/NrfTest/test-src/NrfTest/NrfConfigurationTest.cpp)',
        '[@Writer.h](file:///workspace/vepg/epg/framework/Support/Support/include/Support/Xml/Writer.h)',
        '[@Serializer.h](file:///workspace/vepg/epg/application/DeltaLog/logger/include/DeltaLog/decoder/Serializer.h)',
        '[@ptr_traits.h](file:///proj/epg-tools/gcc/16.1.0_1.rhel8/include/c%2B%2B/16.1.0/bits/ptr_traits.h)',
        '[@compare](file:///proj/epg-tools/gcc/16.1.0_1.rhel8/include/c%2B%2B/16.1.0/compare)',
        '[@TargetDbConsumer.cpp](file:///workspace/vepg/epg/application/LawfulInterception/LiSrc/LiTargetDbAdapter/src/TargetDbConsumer.cpp)',
        '[@ByteOrder.h](file:///workspace/vepg/epg/framework/Support/Support/include/Support/Utilities/Network/ByteOrder.h)',
        '[@node_id_test.c](file:///workspace/vepg/epg/up/common/src/nodeid/test/node_id_test.c)',
        '[@funcwrap.h](file:///proj/epg-tools/gcc/16.1.0_1.rhel8/include/c%2B%2B/16.1.0/bits/funcwrap.h)',
        '[@functional](file:///proj/epg-tools/gcc/16.1.0_1.rhel8/include/c%2B%2B/16.1.0/functional)',
        '[@bit](file:///afs/sero.gic.ericsson.se/app/vbuild/RHEL8-x86_64/gcc/13.2.0/include/c%2B%2B/13.2.0/bit)',
        '[@ValkeyUtils.h](file:///workspace/vepg/epg/application/LawfulInterception/LiSrc/LiValkeyUtils/include/LiValkeyUtils/ValkeyUtils.h)',
        '[@ControlPlaneCommonCompileFlags.cmake](file:///workspace/vepg/epg/tools/build/cmake/ControlPlaneCommonCompileFlags.cmake)',
        '[@base.cmake](file:///workspace/vepg/epg/up/common/cmake/base.cmake)',
        '[@DPIsimWatchdogManager.cc](file:///workspace/vepg/epg/up/dp/cdpi-main/NSNdpisim/lib/core/DPIsimWatchdogManager.cc)',
        '[@ranges_algo.h](file:///proj/epg-tools/gcc/16.1.0_1.rhel8/include/c%2B%2B/16.1.0/bits/ranges_algo.h)',
      ].join('');
      const input = links + 'run sft in up/epg // hides this';
      assert.strictEqual(cleanUserMessage(input), 'run sft in up/epg // hides this');
    });

    test('same links split across chunks, all stripped, only user text remains', () => {
      const linksChunk = [
        '[@json_v3_10_5.hpp](file:///workspace/path/json_v3_10_5.hpp)',
        '[@PduSessionRequestHandler.h](file:///workspace/path/PduSessionRequestHandler.h)',
        '[@NxInfo.h](file:///workspace/path/NxInfo.h)',
      ].join('');
      const textChunk = 'run sft in up/epg';

      let coalesced = '';
      const r1 = cleanUserMessage(linksChunk);
      if (r1 !== '') {
        coalesced += r1;
      }
      const r2 = cleanUserMessage(textChunk);
      if (r2 !== '') {
        coalesced += r2;
      }

      assert.strictEqual(coalesced, 'run sft in up/epg');
    });
  });

  suite('shared-memory recall stripping', () => {
    test('hides the <agent-memory> recall blob, keeps the typed question', () => {
      const input =
        '<agent-memory>\n<relevant-memories>\n- [work_fact] recalled thing\n</relevant-memories>\n</agent-memory>deployed a2a?';
      assert.strictEqual(cleanUserMessage(input), 'deployed a2a?');
    });

    test('hides a recall blob that also carries the persona section', () => {
      const input =
        '<agent-memory>\n<user-persona>\n# Team Operating Doctrine\n</user-persona>\n</agent-memory>and also thinking block';
      assert.strictEqual(cleanUserMessage(input), 'and also thinking block');
    });

    test('renders empty when the replayed message is only a recall blob', () => {
      const input =
        '<agent-memory>\n<relevant-memories>\n- nothing typed by the user\n</relevant-memories>\n</agent-memory>';
      assert.strictEqual(cleanUserMessage(input), '');
    });

    test('hides unwrapped recall sections too', () => {
      const input =
        '<relevant-memories>\n- a fact\n</relevant-memories>\n<user-persona>doctrine</user-persona>\nfix on both branch';
      assert.strictEqual(cleanUserMessage(input), 'fix on both branch');
    });

    test('leaves a message that merely mentions memory alone', () => {
      const input = 'check memory acp log if has function normally';
      assert.strictEqual(cleanUserMessage(input), 'check memory acp log if has function normally');
    });
  });

  suite('recall-only fallback guard (isMachineContextOnly)', () => {
    // Extracted from the real webview source so it cannot drift from production.
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts'), 'utf8');
    const startIdx = src.indexOf('function isMachineContextOnly(rawText) {');
    const endIdx = src.indexOf('\n    }', startIdx);
    const fnSrc = src.slice(startIdx, endIdx + '\n    }'.length);
    const isMachineContextOnly = new Function('return (' + fnSrc + ')')() as (raw: string) => boolean;

    test('a complete recall blob is machine context', () => {
      assert.strictEqual(
        isMachineContextOnly('<agent-memory>\n<relevant-memories>x</relevant-memories>\n</agent-memory>'),
        true,
      );
    });

    test('an unwrapped but complete recall section is machine context', () => {
      assert.strictEqual(isMachineContextOnly('<user-persona>doctrine</user-persona>'), true);
    });

    test('an UNTERMINATED block is not treated as machine context', () => {
      // stripTag drops everything after an unclosed tag, which may have eaten
      // real user text — keep the raw fallback in that case.
      assert.strictEqual(isMachineContextOnly('<agent-memory>\n<relevant-memories>truncated mid-stream'), false);
    });

    test('ordinary user text is never machine context', () => {
      assert.strictEqual(isMachineContextOnly('deployed a2a?'), false);
      assert.strictEqual(isMachineContextOnly('talk about <agent-memory> as a concept'), false);
    });

    test('empty text counts as machine context (nothing to show)', () => {
      assert.strictEqual(isMachineContextOnly('   '), true);
    });

    test('render decision: recall-only message is dropped, not resurrected', () => {
      const raw = '<agent-memory>\n<relevant-memories>- a fact</relevant-memories>\n</agent-memory>';
      const cleaned = cleanUserMessage(raw);
      assert.strictEqual(cleaned, '');
      // Mirrors both render paths: fall back to raw ONLY when it is not
      // machine-only context.
      const shown = cleaned.trim() || (isMachineContextOnly(raw) ? '' : raw);
      assert.strictEqual(shown, '');
    });

    test('render decision: blob + question still shows the question', () => {
      const raw = '<agent-memory>\n<relevant-memories>- a fact</relevant-memories>\n</agent-memory>deployed?';
      const cleaned = cleanUserMessage(raw);
      const shown = cleaned.trim() || (isMachineContextOnly(raw) ? '' : raw);
      assert.strictEqual(shown, 'deployed?');
    });
  });
});

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

/**
 * Like stripTag, but for a truncated (unclosed) tag — the recall blob was cut
 * by its size cap and the closing tag is missing — drops from the opening tag
 * to the END of the text. The tail is machine context (the rest of the
 * truncated blob; the user text, if any, arrived in its own chunk). Dropping
 * only the opening tag leaks every inner section whose close was cut off.
 *
 * Only for machine-context recall tags. Mirror of the production
 * stripTagTolerantUnclosed.
 */
function stripTagTolerantUnclosed(
  text: string,
  tagName: string,
  replacement: ((block: string) => string) | null,
): string {
  const openTag = '<' + tagName;
  const closeTag = '</' + tagName + '>';
  const i = text.indexOf(openTag);
  if (i < 0) {
    return text;
  }
  const close = text.indexOf(closeTag, i + openTag.length);
  if (close < i + openTag.length) {
    return text.slice(0, i);
  }
  return stripTag(text, tagName, replacement);
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

/**
 * Marker lines left by agents that FLATTEN an ACP resource block into the user
 * text they store (pi-acp, Cursor). Mirrors the production
 * stripFlattenedContextMarkers; see clipboardResumeStrip.test.ts, which tests the
 * real one.
 */
function stripFlattenedContextMarkers(text: string): string {
  const prefixes = ['[Embedded Context] ', '[Context] '];
  const schemes = ['zed:///', 'vscode-acp:///', 'file:///'];
  return String(text || '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.replace(/^[ \t\r]+/, '');
      const prefix = prefixes.find((p) => trimmed.indexOf(p) === 0);
      if (!prefix) {
        return true;
      }
      const rest = trimmed.slice(prefix.length);
      return !schemes.some((s) => rest.indexOf(s) === 0);
    })
    .join('\n');
}

/** Collapse a <clipboard> block to its pill, mirroring the production replacement. */
function clipboardReplacement(block: string): string {
  let inner = block;
  const gt = inner.indexOf('>');
  if (gt >= 0) {
    inner = inner.slice(gt + 1);
  }
  const close = inner.lastIndexOf('</clipboard>');
  if (close >= 0) {
    inner = inner.slice(0, close);
  }
  inner = inner.trim();
  const lines = inner ? inner.split('\n').length : 0;
  const label = inner ? `[Clipboard: ${lines}${lines === 1 ? ' line]' : ' lines]'}` : '[Clipboard: empty]';
  return label + '\n\n';
}

function cleanUserMessage(rawText: string): string {
  let displayText = rawText;
  displayText = stripFlattenedContextMarkers(displayText);
  displayText = stripTag(displayText, 'open_files', null);
  displayText = stripTag(displayText, 'terminal', null);
  displayText = stripTag(displayText, 'problems', null);
  displayText = stripTag(displayText, 'clipboard', clipboardReplacement);
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
  // session/load replays back inside the user message. Tolerant of a
  // truncated (unclosed) blob — see stripTagTolerantUnclosed.
  displayText = stripTagTolerantUnclosed(displayText, 'agent-memory', null);
  displayText = stripTagTolerantUnclosed(displayText, 'relevant-memories', null);
  displayText = stripTagTolerantUnclosed(displayText, 'user-persona', null);
  displayText = stripTagTolerantUnclosed(displayText, 'relevant-scenes', null);
  displayText = stripTagTolerantUnclosed(displayText, 'scene-navigation', null);
  displayText = stripTagTolerantUnclosed(displayText, 'memory-tools-guide', null);
  displayText = stripTagTolerantUnclosed(displayText, 'available_skills', null);
  displayText = stripTagTolerantUnclosed(displayText, 'memory_skill_tools', null);

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

  // Strip bare vscode-acp:///memory/<agentId> URIs flattened back into the
  // user message during session/load replay (mirror of the production code
  // in ChatWebviewProvider's cleanUserMessage).
  const memUriProto = 'vscode-acp:///memory/';
  let memUriIdx = displayText.indexOf(memUriProto);
  while (memUriIdx !== -1) {
    let memUriStart = memUriIdx;
    while (memUriStart > 0) {
      const mbc = displayText.charCodeAt(memUriStart - 1);
      if (mbc === 32 || mbc === 10 || mbc === 13 || mbc === 9) {
        memUriStart--;
      } else {
        break;
      }
    }
    let memUriEnd = memUriIdx + memUriProto.length;
    while (memUriEnd < displayText.length) {
      const mec = displayText.charCodeAt(memUriEnd);
      if (
        mec === 32 ||
        mec === 10 ||
        mec === 13 ||
        mec === 9 ||
        mec === 60 /* '<' */ ||
        mec === 41 /* ')' */ ||
        mec === 44 /* ',' */
      ) {
        break;
      }
      memUriEnd++;
    }
    displayText = displayText.slice(0, memUriStart) + displayText.slice(memUriEnd);
    memUriIdx = displayText.indexOf(memUriProto);
  }

  // Strip bare git: source-control URIs (VS Code scheme, single slash — NOT
  // git:// remote URLs). Mirror of the production code in ChatWebviewProvider's
  // cleanUserMessage.
  const gitProto = 'git:';
  let gitIdx = displayText.indexOf(gitProto);
  while (gitIdx !== -1) {
    const gitAfter = gitIdx + gitProto.length;
    if (displayText.charAt(gitAfter) === '/' && displayText.charAt(gitAfter + 1) !== '/') {
      let gitStart = gitIdx;
      while (gitStart > 0) {
        const gbc = displayText.charCodeAt(gitStart - 1);
        if (gbc === 32 || gbc === 10 || gbc === 13 || gbc === 9) {
          gitStart--;
        } else {
          break;
        }
      }
      let gitEnd = gitAfter;
      while (gitEnd < displayText.length) {
        const gec = displayText.charCodeAt(gitEnd);
        if (
          gec === 32 ||
          gec === 10 ||
          gec === 13 ||
          gec === 9 ||
          gec === 60 /* '<' */ ||
          gec === 41 /* ')' */ ||
          gec === 44 /* ',' */
        ) {
          break;
        }
        gitEnd++;
      }
      displayText = displayText.slice(0, gitStart) + displayText.slice(gitEnd);
    }
    gitIdx = displayText.indexOf(gitProto, gitIdx + gitProto.length);
  }

  // Strip leading "[User interjection]: " markers that ericli prepends to a
  // mid-turn user message. Mirror of the production code in
  // ChatWebviewProvider's cleanUserMessage.
  const interjMarker = '[User interjection]:';
  const interjLen = interjMarker.length;
  for (;;) {
    let ijStart = 0;
    while (ijStart < displayText.length) {
      const ijc = displayText.charCodeAt(ijStart);
      if (ijc === 32 || ijc === 10 || ijc === 13 || ijc === 9) {
        ijStart++;
      } else {
        break;
      }
    }
    if (displayText.slice(ijStart, ijStart + interjLen) !== interjMarker) {
      break;
    }
    let ijEnd = ijStart + interjLen;
    if (displayText.charAt(ijEnd) === ' ') {
      ijEnd++;
    }
    displayText = displayText.slice(0, ijStart) + displayText.slice(ijEnd);
  }

  // Local slash-command echoes and the compaction continuation prompt —
  // machine context the Claude CLI records as user entries. Mirror of the
  // production code in ChatWebviewProvider's cleanUserMessage.
  const _lcHasCommand =
    rawText.indexOf('<command-name') >= 0 || rawText.indexOf('<command-args') >= 0;
  displayText = stripTagTolerantUnclosed(displayText, 'local-command-caveat', null);
  displayText = stripTagTolerantUnclosed(displayText, 'command-name', null);
  displayText = stripTagTolerantUnclosed(displayText, 'command-message', null);
  displayText = stripTagTolerantUnclosed(displayText, 'command-args', null);
  if (_lcHasCommand) {
    displayText = stripTagTolerantUnclosed(
      displayText,
      'local-command-stdout',
      () => '[Command output]\n\n',
    );
    displayText = stripTagTolerantUnclosed(
      displayText,
      'local-command-stderr',
      () => '[Command error]\n\n',
    );
  }
const compactionMarker = 'This session is being continued from a previous conversation';
  if (displayText.indexOf(compactionMarker) === 0) {
    displayText = '';
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
      rawText.indexOf('<local-command-caveat') >= 0 ||
      rawText.indexOf('<command-name>') >= 0 ||
      rawText.indexOf('This session is being continued from a previous conversation') === 0 ||
      rawText.indexOf('zed:///') >= 0 ||
      rawText.indexOf('git:/') >= 0 ||
      rawText.indexOf('[User interjection]') >= 0 ||
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

    test('strips the bare vscode-acp:///memory/<id> URI flattened on resume', () => {
      const input =
        'vscode-acp:///memory/codex\n' +
        '<context ref="vscode-acp:///memory/codex">\n<agent-memory>\n<relevant-memories>\n- [fact] x\n' +
        '</relevant-memories>\n</agent-memory>\n</context>add hint in spinner';
      assert.strictEqual(cleanUserMessage(input), 'add hint in spinner');
    });

    test('strips the bare memory URI even without a trailing context block', () => {
      const input =
        'vscode-acp:///memory/codex\n<agent-memory>\n<relevant-memories>- x\n</relevant-memories>\n</agent-memory>my question';
      assert.strictEqual(cleanUserMessage(input), 'my question');
    });

    test('strips multiple bare memory URIs and keeps the prompt text', () => {
      const input = 'vscode-acp:///memory/codex\nvscode-acp:///memory/claude\ncheck the log';
      assert.strictEqual(cleanUserMessage(input), 'check the log');
    });

    test('strips the bare URI with trailing punctuation-only before text', () => {
      const input = 'vscode-acp:///memory/codex) then do the thing';
      assert.strictEqual(cleanUserMessage(input), ') then do the thing');
    });

    test('strips the bare git: source-control URI flattened on resume', () => {
      const input =
        'git:/workspace/src/ui/ChatWebviewProvider.ts?%7B%22path%22%3A%22%2Fworkspace%2Fsrc%2Fui%2FChatWebviewProvider.ts%22%2C%22ref%22%3A%22abc123%22%7D#L7098:7103\n' +
        '<context ref="git:/workspace/src/ui/ChatWebviewProvider.ts?%7B%22path%22%3A%22%2Fworkspace%2Fsrc%2Fui%2FChatWebviewProvider.ts%22%2C%22ref%22%3A%22abc123%22%7D#L7098:7103">\nvar whole = { \'/tools\': 1 };\n</context>\njusr check ../ericli code';
      assert.strictEqual(cleanUserMessage(input), 'jusr check ../ericli code');
    });

    test('strips a bare git: URI with a simple line fragment', () => {
      const input =
        'git:/workspace/src/foo.ts#L123:456\n<context ref="git:/workspace/src/foo.ts#L123:456">x</context>do the thing';
      assert.strictEqual(cleanUserMessage(input), 'do the thing');
    });

    test('renders empty when the replayed message is only a git: source-control URI', () => {
      const input =
        'git:/workspace/src/ui/ChatWebviewProvider.ts?%7B%22path%22%3A%22%2Fworkspace%2Fsrc%2Fui%2FChatWebviewProvider.ts%22%2C%22ref%22%3A%22abc123%22%7D#L7098:7103\n' +
        '<context ref="git:/workspace/src/ui/ChatWebviewProvider.ts?%7B%22path%22%3A%22%2Fworkspace%2Fsrc%2Fui%2FChatWebviewProvider.ts%22%2C%22ref%22%3A%22abc123%22%7D#L7098:7103">\nvar whole = { \'/tools\': 1 };\n</context>';
      assert.strictEqual(cleanUserMessage(input), '');
    });

    test('leaves a git:// remote URL alone (not source-control)', () => {
      const input = 'clone it from git://github.com/foo/bar.git please';
      assert.strictEqual(
        cleanUserMessage(input),
        'clone it from git://github.com/foo/bar.git please',
      );
    });

    test('strips the leading [User interjection]: marker flattened on resume', () => {
      const input =
        '[User interjection]: commit local/dev // and also strip\n' +
        'vscode-acp:///memory/ericli\n' +
        '<context ref="vscode-acp:///memory/ericli">\n<agent-memory>\n- [episodic] x\n' +
        '</agent-memory>\n</context>';
      assert.strictEqual(cleanUserMessage(input), 'commit local/dev // and also strip');
    });

    test('strips doubled leading [User interjection]: markers', () => {
      const input =
        '[User interjection]: [User interjection]: commit local/dev\n' +
        'vscode-acp:///memory/ericli\n' +
        '<context ref="vscode-acp:///memory/ericli">\n<agent-memory>\n- [episodic] x\n' +
        '</agent-memory>\n</context>';
      assert.strictEqual(cleanUserMessage(input), 'commit local/dev');
    });

    test('keeps a mid-sentence [User interjection] reference (real user text)', () => {
      const input = 'should strip the [User interjection]: marker please';
      assert.strictEqual(
        cleanUserMessage(input),
        'should strip the [User interjection]: marker please',
      );
    });

    test('a TRUNCATED recall blob (unclosed outer tag) is fully hidden', () => {
      // MemoryFormat hard-slices a blob over its 9000-char cap, so the closing
      // tag can be missing. The whole truncated blob is machine context — the
      // user text for that prompt arrives in its own chunk (the webview splits
      // each content block into its own user_message_chunk), so it must not be
      // expected inside the same chunk. The blob must render as empty, not as
      // leaked '>' garbage or raw recall text.
      const input =
        '<agent-memory>\n<relevant-memories>\n- [episodic] fact one\n- [work_fact] fact two\n' +
        '…(truncated)\n</user-persona>';
      assert.strictEqual(cleanUserMessage(input), '');
    });

    test('hides the <available_skills> and <memory_skill_tools> sections', () => {
      const input =
        '<agent-memory>\n<relevant-memories>\n- [episodic] x\n</relevant-memories>\n' +
        '<available_skills>\n- **gerrit-pctr-issue-investigation** (v1):\n</available_skills>\n' +
        '<memory_skill_tools>\ncurl -sf -X POST http://127.0.0.1:8127/view\n</memory_skill_tools>\n' +
        '</agent-memory>\nwhy does the ring stay at 197k?';
      assert.strictEqual(cleanUserMessage(input), 'why does the ring stay at 197k?');
    });

    test('hides a truncated blob whose inner sections are also unclosed', () => {
      // Outer AND inner tags unclosed: the whole thing is machine context and
      // must not leak stray '>' characters or recall text into the bubble.
      const input =
        '<agent-memory>\n<relevant-memories>\n- [episodic] a fact\n' +
        '<user-persona>\n# Team Operating Doctrine';
      assert.strictEqual(cleanUserMessage(input), '');
    });

    test('strips the local slash-command echo (caveat + command dump)', () => {
      const input =
        '<local-command-caveat>Caveat: The messages below were generated by the user ' +
        'while running local commands. DO NOT respond to these messages or otherwise ' +
        'consider them in your response unless the user explicitly asks you to.</local-command-caveat>';
      assert.strictEqual(cleanUserMessage(input), '');
    });

    test('strips the <command-name>/<command-message>/<command-args> dump', () => {
      const input =
        '<command-name>/recap</command-name>\n' +
        '            <command-message>recap</command-message>\n' +
        '            <command-args></command-args>';
      assert.strictEqual(cleanUserMessage(input), '');
    });

    test('keeps user text that mentions command tags mid-sentence', () => {
      // No command dump present (no <command-name>/<command-args> in the raw
      // text), so the stdout/stderr strips stay gated off and a lone
      // mention of a closing tag is left alone.
      const input = 'check why /recap shows command dump tags after resume';
      assert.strictEqual(cleanUserMessage(input), input);
    });

    test('hides the compaction continuation prompt', () => {
      const input =
        'This session is being continued from a previous conversation that ran out of ' +
        'context. The summary below covers the earlier portion of the conversation.\n\n' +
        'Summary:\n1. Primary Request and Intent:\n   ...';
      assert.strictEqual(cleanUserMessage(input), '');
    });

    test('keeps a user prompt that merely quotes the continuation phrase mid-text', () => {
      const input =
        'why does my message say "This session is being continued from a previous ' +
        'conversation" in the summary?';
      assert.strictEqual(
        cleanUserMessage(input),
        'why does my message say "This session is being continued from a previous ' +
        'conversation" in the summary?',
      );
    });
  });

  suite('recall-only fallback guard (isMachineContextOnly)', () => {
    // Extracted from the real webview source so it cannot drift from production.
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts'), 'utf8');
    const startIdx = src.indexOf('function isMachineContextOnly(rawText) {');
    if (startIdx < 0) {
      throw new Error('isMachineContextOnly() not found in ChatWebviewProvider.ts');
    }
    // Match braces from the opening one instead of guessing the closing
    // brace's indentation, so extraction survives prettier reformatting.
    let depth = 0;
    let endIdx = -1;
    for (let i = startIdx; i < src.length; i++) {
      if (src[i] === '{') {
        depth++;
      } else if (src[i] === '}' && --depth === 0) {
        endIdx = i;
        break;
      }
    }
    if (endIdx < 0) {
      throw new Error('unbalanced braces while extracting isMachineContextOnly()');
    }
    const fnSrc = src.slice(startIdx, endIdx + 1);
    // isMachineContextOnly now also calls stripLeadingResourceLinkJson (a
    // resource_link-only chunk is machine context too), so that helper has to
    // be in the eval scope. Bounded by the next function declaration rather
    // than brace counting: the helper compares against char code 123, and any
    // comment naming that character would break a brace counter.
    const depStart = src.indexOf('function stripLeadingResourceLinkJson(text) {');
    if (depStart < 0) {
      throw new Error('stripLeadingResourceLinkJson() not found in ChatWebviewProvider.ts');
    }
    const depEnd = src.indexOf('function cleanUserMessage(rawText) {', depStart);
    if (depEnd < 0) {
      throw new Error('end marker after stripLeadingResourceLinkJson() not found');
    }
    const depSrc = src.slice(depStart, depEnd);
    const isMachineContextOnly = new Function(
      depSrc + '\nreturn (' + fnSrc + ')',
    )() as (raw: string) => boolean;

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

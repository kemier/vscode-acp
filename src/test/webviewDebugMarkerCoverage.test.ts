import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  isAlwaysLoggedWebviewMessage,
  isQueueDebugWebviewMessage,
  isRenderDebugWebviewMessage,
  hasWebviewDiagnosticMarker,
} from '../ui/ChatWebviewProvider';

/**
 * Every webview diagnostic must be reachable from a setting.
 *
 * The webview posts debugLog lines that the host routes through four gates:
 * always-logged, acp.debugWebviewQueue, acp.debugRender, and a catch-all under
 * acp.debugResume. Anything matching no gate falls through to the module-level
 * `const DEBUG = false` / `DEBUG_LIVE = false` — compile-time constants, so no
 * setting can turn them on and the trace can never be captured from a running
 * install.
 *
 * An audit found 18 of the 31 emitted markers in that state, including the ones
 * needed for the investigations that hit the wall:
 *
 *   [WV-STATE]      restoreState / saveState — which persisted items came back
 *   [WV-USER]       user message handling and cleanUserMessage
 *   [WV-PROMPTEND]  turn-end latch state
 *   [WV-DEDUP]      duplicate suppression
 *   [STEER]         steer echo decisions
 *
 * The header on WEBVIEW_RENDER_DEBUG_MARKERS records the first two
 * investigations this cost (raw markdown, empty bubble). The third was a phantom
 * `fix` user bubble that survived a resume: the ericli session file proved the
 * agent never received it (34 user messages, last was "commit") and the traffic
 * log carried zero session/prompt, so the bubble was client-side — but the
 * traces that would name the code path were all unreachable.
 *
 * The catch-all therefore no longer depends on a curated list: any bracketed
 * marker qualifies. This test enforces the invariant by scanning the real
 * source, so adding a marker cannot silently make it uncapturable.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

/** Every bracketed marker the webview actually emits through debugLog. */
function emittedMarkers(): string[] {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const found = new Set<string>();
  const re = /message: '(\[[A-Z][A-Z0-9-]+\])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    found.add(m[1]);
  }
  return Array.from(found).sort();
}

suite('webviewDebugMarkerCoverage', () => {
  test('the source really does emit marked diagnostics', () => {
    const markers = emittedMarkers();
    // Guard the guard: if the extraction regex ever stops matching, the coverage
    // assertions below would pass vacuously.
    assert.ok(markers.length > 20, `expected many markers, found ${markers.length}: ${markers}`);
    for (const expected of ['[WV-DIAG]', '[WV-ERROR]', '[WV-MDRENDER]', '[WV-STATE]', '[WV-USER]']) {
      assert.ok(markers.includes(expected), `${expected} not emitted any more — update this list`);
    }
  });

  test('every emitted marker is reachable through some gate', () => {
    const unreachable = emittedMarkers().filter(
      (marker) =>
        !isAlwaysLoggedWebviewMessage(marker) &&
        !isQueueDebugWebviewMessage(marker) &&
        !isRenderDebugWebviewMessage(marker) &&
        !hasWebviewDiagnosticMarker(marker),
    );
    assert.deepStrictEqual(
      unreachable,
      [],
      'these markers match no gate, so no setting can capture them — they would ' +
        'only reach the log through the compile-time-false DEBUG constants: ' +
        unreachable.join(', '),
    );
  });

  test('no debugLog line is emitted without a marker', () => {
    // An unmarked line cannot be routed at all. Two of them (restoreState and
    // saveState user[...]) were exactly the traces missing when a phantom user
    // bubble had to be diagnosed.
    const src = fs.readFileSync(SOURCE, 'utf8');
    const unmarked: string[] = [];
    const re = /message: '([^['][^']{0,40})/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      // Only debugLog posts matter; other postMessage kinds carry free text.
      const before = src.slice(Math.max(0, m.index - 60), m.index);
      if (before.includes("type: 'debugLog'")) {
        unmarked.push(m[1]);
      }
    }
    assert.deepStrictEqual(unmarked, [], `unmarked debugLog messages: ${unmarked.join(' | ')}`);
  });
});

suite('hasWebviewDiagnosticMarker', () => {
  test('accepts a leading bracketed marker', () => {
    for (const line of [
      '[WV-STATE] restoreState START: saved.chatHistory.length=230',
      '[WV-DIAG] resume merge count delta: assistant snap=1 loaded=0',
      '[DRAIN-DBG] SKIPPED drain because isCompacting=true',
      '  [WV-USER] cleanUserMessage IN len=12',
    ]) {
      assert.strictEqual(hasWebviewDiagnosticMarker(line), true, `should match: ${line}`);
    }
  });

  test('rejects prose and empty input', () => {
    for (const line of ['', 'restoreState START', 'no marker here', '[lowercase] not a marker']) {
      assert.strictEqual(hasWebviewDiagnosticMarker(line), false, `should not match: ${JSON.stringify(line)}`);
    }
  });

  test('only a LEADING marker counts', () => {
    // Otherwise any line quoting a marker in prose would be forwarded.
    assert.strictEqual(hasWebviewDiagnosticMarker('see the [WV-DIAG] trace'), false);
  });
});

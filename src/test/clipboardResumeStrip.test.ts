import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { decodeTemplate } from './templateDecode';
import { webviewSlice } from './webviewQueueHelpers';

/**
 * A clipboard snapshot must never reappear as raw text after `session/load`.
 *
 * Reported per agent, and that was the clue: resuming an **ericli** session showed
 * the tidy `@clipboard` mention, while **pi-acp** and **Cursor** put the entire
 * pasted blob back in the user bubble.
 *
 * The difference is how each agent stores what it was sent. codex/ericli wrap a
 * replayed resource in `<context ref="…">`, which cleanUserMessage already strips.
 * pi-acp instead FLATTENS it into the prompt text
 * (`pi-acp/src/acp/translate/prompt.ts`):
 *
 *   [Embedded Context] zed:///agent/clipboard (text/plain)
 *   …the whole payload…
 *
 * Cursor inlines attachments the same way. Nothing in that text marked where the
 * payload began or ended, so there was nothing to strip — and a message whose only
 * content was the snapshot cleaned to empty, which made both render paths fall back
 * to the RAW text and print the blob in full.
 *
 * Two changes, verified here against the REAL webview functions (extracted from the
 * template literal, like resourceLinkStrip.test.ts / foldOrdering.test.ts):
 *   - the payload always carries `<clipboard>` delimiters, in the inline fallback
 *     AND inside the embedded resource body (wrapClipboardPayload);
 *   - the block collapses to a `[Clipboard: N lines]` pill instead of being deleted,
 *     so a snapshot-only message is never empty and never falls back to raw.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

interface Webview {
  cleanUserMessage(text: string): string;
  clipboardPillLabel(clip: string): string;
  queueEntryPromptText(entry: unknown): string;
  queueEntryDisplayText(entry: unknown): string;
  queueEntryTooltip(entry: unknown): string;
  formatResourcePill(uri: string, fallbackName: string | null): string;
}

function loadWebviewFns(): Webview {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const cut = (from: string, to: string): string => {
    const s = src.indexOf(from);
    assert.ok(s >= 0, `not found in webview source: ${from}`);
    const e = src.indexOf(to, s);
    assert.ok(e > s, `end marker not found after ${from}: ${to}`);
    return src.slice(s, e);
  };
  const body = decodeTemplate(
    [
      cut('function clipboardPillLabel(clip) {', '/**\n     * The text a queued entry SENDS'),
      cut('function queueEntryPromptText(entry) {', 'function renderQueue() {'),
      cut(
        'function stripTag(text, tagName, replacement) {',
        '/**\n     * True when a user message is nothing but injected machine context',
      ),
      cut('function isMachineContextOnly(rawText) {', '/**\n    * Truncate a session title for display in the banner.'),
      cut('function stripLeadingResourceLinkJson(text) {', ' function cleanUserMessage(rawText) {'),
      cut(' function cleanUserMessage(rawText) {', '    /**\n     * Persist current panel state'),
    ].join('\n'),
  );
  return new Function(
    'var vscode = { postMessage: function(){} };\n' +
      body +
      '\nreturn { cleanUserMessage: cleanUserMessage, clipboardPillLabel: clipboardPillLabel,' +
      ' queueEntryPromptText: queueEntryPromptText, queueEntryDisplayText: queueEntryDisplayText,' +
      ' queueEntryTooltip: queueEntryTooltip, formatResourcePill: formatResourcePill };',
  )() as Webview;
}

const PAYLOAD = 'Loop1 CPU→GPU\nLoop2 KV cache\nLoop5 disaggregation';
const WRAPPED = `<clipboard>\n${PAYLOAD}\n</clipboard>`;

suite('a resumed clipboard snapshot renders as a pill, never as raw text', () => {
  const wv = loadWebviewFns();

  test('pi-acp: flattened [Embedded Context] marker + payload + typed text', () => {
    const replayed =
      '[Embedded Context] vscode-acp:///memory/pi (text/plain)\n' +
      '<agent-memory>\n- [work_fact] blob\n</agent-memory>\n' +
      '[Embedded Context] zed:///agent/clipboard (text/plain)\n' +
      WRAPPED +
      '\nwhat does this mean?';
    const out = wv.cleanUserMessage(replayed);
    assert.ok(out.indexOf('Loop2 KV cache') < 0, 'the payload must not reach the bubble');
    assert.ok(out.indexOf('[Embedded Context]') < 0, 'the flattening marker must not reach the bubble');
    assert.ok(out.indexOf('[Clipboard: 3 lines]') >= 0, 'the attachment must still be visible as a pill');
    assert.ok(out.indexOf('what does this mean?') >= 0, 'the typed text must survive');
  });

  test('pi-acp: a snapshot-only message keeps the pill instead of falling back to raw', () => {
    // This is the case that leaked worst: cleanUserMessage returned '' and both
    // render paths then displayed rawText, i.e. the entire payload.
    const out = wv.cleanUserMessage('[Embedded Context] zed:///agent/clipboard (text/plain)\n' + WRAPPED);
    assert.strictEqual(out, '[Clipboard: 3 lines]');
  });

  test('inline fallback (no embeddedContext, e.g. kiro-cli)', () => {
    const out = wv.cleanUserMessage(WRAPPED + '\n\nsummarise this');
    assert.strictEqual(out, '[Clipboard: 3 lines]\n\nsummarise this');
  });

  test('codex / ericli: the <context ref> wrapper is still removed whole', () => {
    const out = wv.cleanUserMessage(
      'zed:///agent/clipboard\n<context ref="zed:///agent/clipboard">\n' + WRAPPED + '\n</context>\nstill have',
    );
    assert.strictEqual(out, 'still have');
  });

  test('cursor: the trailing "Additional ACP context:" dump is still cut', () => {
    const out = wv.cleanUserMessage(
      'check this\n\nAdditional ACP context:\n[ACP resource_link] zed:///agent/clipboard\n' + WRAPPED,
    );
    assert.strictEqual(out, 'check this');
  });

  test('a flattened resource_link marker goes too', () => {
    assert.strictEqual(wv.cleanUserMessage('[Context] file:///workspace/foo.ts\nexplain foo'), 'explain foo');
  });

  test('a line that only looks like a marker is left alone', () => {
    // Real prose must survive: only "[Embedded Context] <scheme>://…" is machine text.
    const typed = '[Embedded Context] is what pi-acp calls it';
    assert.strictEqual(wv.cleanUserMessage(typed), typed);
  });

  test('the pill counts lines and says so in singular/plural', () => {
    assert.strictEqual(wv.clipboardPillLabel(PAYLOAD), '[Clipboard: 3 lines]');
    assert.strictEqual(wv.clipboardPillLabel('one line'), '[Clipboard: 1 line]');
    assert.strictEqual(wv.clipboardPillLabel(''), '[Clipboard: empty]');
  });

  test('a replayed resource BLOCK renders as [Clipboard], not as a bare zed:// URI', () => {
    assert.strictEqual(wv.formatResourcePill('zed:///agent/clipboard', null).trim(), '[Clipboard]');
  });
});

suite('a queued clipboard snapshot is shown as a pill and expanded only on send', () => {
  const wv = loadWebviewFns();
  const entry = { text: 'and this', clipboard: { text: PAYLOAD } };

  test('the chip / bubble text carries the pill, not the payload', () => {
    assert.strictEqual(wv.queueEntryDisplayText(entry), '[Clipboard: 3 lines] and this');
  });

  test('the wire text carries the payload, delimited', () => {
    assert.strictEqual(wv.queueEntryPromptText(entry), `${WRAPPED}\n\nand this`);
  });

  test('the tooltip lets the snapshot be inspected without expanding the chip', () => {
    const tip = wv.queueEntryTooltip(entry);
    assert.ok(tip.indexOf('[Clipboard: 3 lines] and this') === 0, 'starts with what the chip shows');
    assert.ok(tip.indexOf('Loop2 KV cache') > 0, 'includes the snapshot preview');
  });

  test('the preview is bounded — a huge paste must not become a huge tooltip', () => {
    const tip = wv.queueEntryTooltip({ text: 'x', clipboard: { text: 'y'.repeat(5000) } });
    assert.ok(tip.length < 1200, `tooltip should stay bounded, got ${tip.length}`);
    assert.ok(tip.indexOf('…') > 0, 'truncation must be visible');
  });

  test('an entry with no snapshot is untouched on both paths', () => {
    assert.strictEqual(wv.queueEntryDisplayText({ text: 'plain' }), 'plain');
    assert.strictEqual(wv.queueEntryPromptText({ text: 'plain' }), 'plain');
  });

  test('what is displayed cleans back to itself — no double stripping', () => {
    // The bubble text is persisted in chatHistory and re-cleaned on restoreState.
    const display = wv.queueEntryDisplayText(entry);
    assert.strictEqual(wv.cleanUserMessage(display), display);
  });
});

/**
 * The LIVE path, end to end, with the real handler and the real bubble function.
 *
 * Observed before the fix, in a streaming ericli turn: "@clipboard make it bullets"
 * typed mid-turn was queued, the snapshot was substituted INTO entry.text, and
 * addUserBubbleForQueuedEntry renders entry.text verbatim — so the panel showed
 *
 *   <clipboard>
 *   Operational model: (1) fusion cuts HBM traffic, …
 *   </clipboard>
 *
 *   make it bullets
 *
 * as the user's own message. This has nothing to do with session/load: the bubble
 * is built locally at drain time and never passes through cleanUserMessage, so the
 * payload has to be kept out of entry.text in the first place.
 */
suite('a clipboard message queued during a streaming turn shows a pill, not the payload', () => {
  const src = fs.readFileSync(SOURCE, 'utf8');

  /** Slice a brace-balanced fragment starting at `from`. */
  function balanced(from: string): string {
    const start = src.indexOf(from);
    assert.ok(start >= 0, `not found: ${from}`);
    let i = src.indexOf('{', start);
    let depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '{') {
        depth++;
      } else if (src[i] === '}') {
        depth--;
        if (depth === 0) {
          break;
        }
      }
    }
    return src.slice(start, i + 1);
  }

  interface Live {
    queue: Array<Record<string, unknown>>;
    bubbles: string[];
    chips: string[];
    posted: Array<Record<string, unknown>>;
    resolve(token: string, clipText: string): void;
    drain(): void;
  }

  function harness(entry: Record<string, unknown>): Live {
    // Each fragment is decoded EXACTLY once: decoding twice collapses the doubled
    // backslashes again, which silently turns /@clipboard\b/gi into /@clipboardb/gi.
    const caseBody = decodeTemplate(balanced("case 'clipboardForQueue': {"));
    const body = [
      webviewSlice('function clipboardPillLabel(clip) {', '/**\n     * The text a queued entry SENDS'),
      webviewSlice('function queueEntryPromptText(entry) {', 'function renderQueue() {'),
      `function applyClipboardReply(msg) { switch ('clipboardForQueue') { ${caseBody} } }`,
      decodeTemplate(balanced('function addUserBubbleForQueuedEntry(entry) {')),
    ].join('\n');
    const state = {
      queue: [entry],
      bubbles: [] as string[],
      chips: [] as string[],
      posted: [] as Array<Record<string, unknown>>,
    };
    const factory = new Function(
      'state',
      `
      let messageQueue = state.queue;
      let currentTurnEl = null, currentToolsListEl = null, currentToolsCountEl = null, currentToolCount = 0;
      const chatHistory = [];
      const vscode = { postMessage: (m) => { state.posted.push(m); } };
      function saveState() {}
      function addMessageDOM(role, text) { state.bubbles.push(role + ':' + text); }
      function renderQueue() { state.chips = messageQueue.map(queueEntryDisplayText); }
      function retireToolCallRegistry() {}
      ${body}
      return {
        resolve: (token, text) => applyClipboardReply({ token, text }),
        drain: () => {
          const e = messageQueue.shift();
          renderQueue();
          addUserBubbleForQueuedEntry(e);
          vscode.postMessage({ type: 'sendPrompt', text: queueEntryPromptText(e) || ' ', images: e.images });
        },
      };
    `,
    );
    const api = factory(state) as { resolve(t: string, x: string): void; drain(): void };
    return {
      get queue() {
        return state.queue;
      },
      get bubbles() {
        return state.bubbles;
      },
      get chips() {
        return state.chips;
      },
      get posted() {
        return state.posted;
      },
      resolve: api.resolve,
      drain: api.drain,
    };
  }

  const CLIP =
    'Operational model: (1) fusion cuts HBM traffic, (2) CUDA Graph cuts launch.\n' +
    'Only helps when those bottlenecks exist — otherwise "compiled but not faster".';

  test('the chip shows the pill while the turn is still streaming', () => {
    const h = harness({ text: '@clipboard make it bullets', images: [], clipboardToken: 'clip-1' });
    h.resolve('clip-1', CLIP);
    assert.deepStrictEqual(h.chips, ['[Clipboard: 2 lines] make it bullets']);
    assert.ok(JSON.stringify(h.queue).indexOf('Operational model') > 0, 'the snapshot is still held');
    assert.strictEqual(h.queue[0].text, 'make it bullets', 'the payload must not be in the text');
  });

  test('the bubble at drain time shows the pill, and the wire carries the payload', () => {
    const h = harness({ text: '@clipboard make it bullets', images: [], clipboardToken: 'clip-1' });
    h.resolve('clip-1', CLIP);
    h.drain();
    assert.deepStrictEqual(h.bubbles, ['user:[Clipboard: 2 lines] make it bullets']);
    const sent = h.posted.find((m) => m.type === 'sendPrompt');
    assert.ok(sent, 'the prompt must be sent');
    assert.ok(String(sent!.text).indexOf('<clipboard>\n' + CLIP + '\n</clipboard>') === 0, sent!.text as string);
    assert.ok(String(sent!.text).endsWith('make it bullets'), 'the typed text goes last');
  });

  test('an empty clipboard leaves the typed text alone and warns', () => {
    const h = harness({ text: '@clipboard make it bullets', images: [], clipboardToken: 'clip-1' });
    h.resolve('clip-1', '   ');
    assert.deepStrictEqual(h.chips, ['make it bullets']);
    assert.ok(
      h.posted.some((m) => m.type === 'showWarning'),
      'an empty clipboard must be reported at queue time',
    );
    h.drain();
    assert.deepStrictEqual(h.bubbles, ['user:make it bullets']);
  });

  test('a reply with an unknown token touches nothing', () => {
    const h = harness({ text: '@clipboard make it bullets', images: [], clipboardToken: 'clip-1' });
    h.resolve('clip-OTHER', CLIP);
    assert.strictEqual(h.queue[0].text, '@clipboard make it bullets', 'must not consume another entry snapshot');
  });
});

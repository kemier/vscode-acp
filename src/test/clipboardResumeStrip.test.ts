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
  splitLeadingContextPills(text: string): { pills: string[]; rest: string };
  imagePillLabel(count: number): string;
  contextAttachedDisplayText(pills: string[], hostText: string): string;
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
        'function stripTagTolerantUnclosed(text, tagName, replacement) {',
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
      ' queueEntryTooltip: queueEntryTooltip, splitLeadingContextPills: splitLeadingContextPills,' +
      ' imagePillLabel: imagePillLabel, contextAttachedDisplayText: contextAttachedDisplayText,' +
      ' formatResourcePill: formatResourcePill };',
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

  test('codex / ericli: the <context ref> wrapper becomes the same pill', () => {
    // These agents wrap a replayed resource in <context ref="…">, so this is where an
    // attachment surfaces after resume on them. It must map to the SAME pill the
    // inline path produces, or live and resumed panels disagree.
    const out = wv.cleanUserMessage(
      'zed:///agent/clipboard\n<context ref="zed:///agent/clipboard">\n' + WRAPPED + '\n</context>\nstill have',
    );
    assert.strictEqual(out, '[Clipboard: 3 lines]\n\nstill have');
  });

  test('a terminal / diagnostics resource surfaces as its pill too', () => {
    assert.strictEqual(
      wv.cleanUserMessage(
        '<context ref="zed:///agent/terminal-selection?lines=40">\nbuild output\n</context>\nwhat failed?',
      ),
      '[Terminal: 40 lines]\n\nwhat failed?',
    );
    assert.strictEqual(
      wv.cleanUserMessage('<context ref="zed:///agent/diagnostics">\nerrors\n</context>\nfix them'),
      '[Problems]\n\nfix them',
    );
  });

  test('machine-injected recall stays hidden — it rides on every prompt', () => {
    // A pill here would appear on every single bubble, and the live panel never
    // shows the recall blob either.
    assert.strictEqual(
      wv.cleanUserMessage('<context ref="vscode-acp:///memory/kiro">\n<agent-memory>x</agent-memory>\n</context>\nhi'),
      'hi',
    );
  });

  test('an answered /session lookup shows the session, not a phantom file', () => {
    // The /session summary is injected as <context ref="session:<title>">. The URI
    // has no path structure, so it fell through to the file logic and the resumed
    // bubble read "[File: ue]".
    assert.strictEqual(
      wv.cleanUserMessage(
        '<context ref="session:ue">\nSummary of session "ue" (generated by X):\n\nblah\n</context>\n\nwhat about it?',
      ),
      '[Session: ue]\n\nwhat about it?',
    );
    assert.strictEqual(wv.formatResourcePill('session:ue', null).trim(), '[Session: ue]');
    // Titles are escaped into the attribute and can carry spaces or entities.
    assert.strictEqual(
      wv.formatResourcePill('session:vepg &amp; ntp notes', null).trim(),
      '[Session: vepg & ntp notes]',
    );
  });

  test('inlined terminal / problems / file / folder blocks become pills, not nothing', () => {
    // Deleting them left a resumed prompt looking as if it arrived with no context.
    assert.strictEqual(
      wv.cleanUserMessage('<terminal name="bash">\n$ make\nerror: 1\n</terminal>\n\nwhy?'),
      '[Terminal: 2 lines]\n\nwhy?',
    );
    assert.strictEqual(
      wv.cleanUserMessage('<problems count="12">\na.ts:1: [ERROR] x\n</problems>\n\nfix'),
      '[Problems: 12]\n\nfix',
    );
    assert.strictEqual(
      wv.cleanUserMessage('<file path="/abs/src/main.ts">\ncode\n</file>\n\nreview'),
      '[File: main.ts]\n\nreview',
    );
    assert.strictEqual(
      wv.cleanUserMessage('<folder path="/abs/src/core">\nlisting\n</folder>\n\nls'),
      '[Directory: core/]\n\nls',
    );
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

  test('an attached image shows a chip, singular and plural', () => {
    // An image left no trace: with text alongside it there was nothing to see, and
    // with none the bubble said "(image)" — a different shape from every other
    // attachment.
    assert.strictEqual(wv.imagePillLabel(1), '[Image]');
    assert.strictEqual(wv.imagePillLabel(3), '[Images: 3]');
    assert.strictEqual(wv.imagePillLabel(0), '');
    assert.strictEqual(
      wv.queueEntryDisplayText({ text: 'what is this', images: [{ data: 'x', mimeType: 'image/png' }] }),
      '[Image] what is this',
    );
    // Clipboard and image together, in a stable order.
    assert.strictEqual(
      wv.queueEntryDisplayText({ text: 'both', clipboard: { text: 'a\nb' }, images: [{}, {}] }),
      '[Clipboard: 2 lines] [Images: 2] both',
    );
  });

  test('the image chip never reaches the wire — images are their own blocks', () => {
    const entry = { text: 'look', images: [{ data: 'x', mimeType: 'image/png' }] };
    assert.strictEqual(wv.queueEntryPromptText(entry), 'look');
  });

  test('an image chip cleans back to itself, so a resume keeps it', () => {
    assert.strictEqual(wv.cleanUserMessage('[Image]\n\nwhat is this'), '[Image]\n\nwhat is this');
    assert.strictEqual(wv.splitLeadingContextPills('[Images: 3]\n\nlook').pills[0], 'Images: 3');
  });

  test('what is displayed cleans back to itself — no double stripping', () => {
    // The bubble text is persisted in chatHistory and re-cleaned on restoreState.
    const display = wv.queueEntryDisplayText(entry);
    assert.strictEqual(wv.cleanUserMessage(display), display);
  });
});

/**
 * The pill is TEXT in chatHistory (persisted, re-cleaned on restore, compared for
 * dedup) but must not LOOK like text. Left as-is it rendered as a bracketed line of
 * its own, because the "\n\n" separator broke the line even for a three-word prompt:
 *
 *   [Clipboard: 1 line]
 *   make it bullets
 *
 * splitLeadingContextPills peels the pills off for the renderer, which draws them as
 * chips and keeps the prompt on the same line.
 */
suite('attached-context pills render as chips, not as bracketed text', () => {
  const wv = loadWebviewFns();

  test('the pill and a short prompt end up on one line', () => {
    const split = wv.splitLeadingContextPills('[Clipboard: 1 line]\n\nmake it bullets');
    assert.deepStrictEqual(split.pills, ['Clipboard: 1 line']);
    assert.strictEqual(split.rest, 'make it bullets', 'the separator newlines must be dropped');
  });

  test('every pill formatResourcePill and cleanUserMessage can emit is recognised', () => {
    for (const pill of [
      'Clipboard: 12 lines',
      'Terminal: 40 lines',
      'Problems',
      'File: main.ts',
      'Directory: src/',
      'Selected code: main.ts:5-9',
      'Memory context',
      'Session: ue',
    ]) {
      const split = wv.splitLeadingContextPills(`[${pill}]\n\nwhy?`);
      assert.deepStrictEqual(split.pills, [pill], pill);
      assert.strictEqual(split.rest, 'why?');
    }
  });

  test('several attachments become several chips', () => {
    const split = wv.splitLeadingContextPills('[File: a.ts]\n\n[Terminal: 3 lines]\n\nfix it');
    assert.deepStrictEqual(split.pills, ['File: a.ts', 'Terminal: 3 lines']);
    assert.strictEqual(split.rest, 'fix it');
  });

  test('a pill-only message leaves nothing to render as text', () => {
    const split = wv.splitLeadingContextPills('[Clipboard: 3 lines]');
    assert.deepStrictEqual(split.pills, ['Clipboard: 3 lines']);
    assert.strictEqual(split.rest, '');
  });

  test('a markdown link is not a pill — the link renderer must keep it', () => {
    const link = '[File: main.ts](file:///abs/main.ts)';
    const split = wv.splitLeadingContextPills(link + ' look');
    assert.deepStrictEqual(split.pills, []);
    assert.strictEqual(split.rest, link + ' look', 'text must be handed on untouched');
  });

  test('a session mention and ordinary brackets are left alone', () => {
    for (const text of ['[@my session](session:abc) why?', '[TODO] fix this', 'plain text']) {
      const split = wv.splitLeadingContextPills(text);
      assert.deepStrictEqual(split.pills, [], text);
      assert.strictEqual(split.rest, text);
    }
  });

  test('a bracket that never closes cannot hang the scan', () => {
    const split = wv.splitLeadingContextPills('[Clipboard: 3 lines and then nothing');
    assert.deepStrictEqual(split.pills, []);
  });

  test('the chip inherits the surrounding font metrics, so centre == baseline', () => {
    // Four earlier attempts failed at this one spot, each differently:
    //   line-height: 1.7 + no vertical padding — leading is split around the text
    //     BOX and ascent/descent are not symmetric, so the label sat high;
    //   padding: 0 in the queue override — same bug, reintroduced;
    //   align-items: center with a SMALLER font — centres the boxes but puts the
    //     chip's label baseline off the neighbouring text, because a flex container
    //     with no baseline-aligned item SYNTHESISES its baseline from the box;
    //   font-size/line-height: inherit — aligned, but the chip then matches body
    //     text and reads as an oversized badge on a high-DPI monitor.
    // align-items: baseline is what makes a smaller font legal: the container takes
    // its baseline from the LABEL, so vertical-align: baseline lines that label up
    // with the surrounding text at any chip size.
    const src = fs.readFileSync(SOURCE, 'utf8');
    // Comments are stripped first: the rule documents the failed attempts, and those
    // strings ("line-height: 1.7") otherwise match the guards below.
    const declarations = (block: string): string => block.replace(/\/\*[\s\S]*?\*\//g, '');
    const at = src.indexOf('.context-pill {');
    assert.ok(at > 0, 'context-pill style missing');
    const css = declarations(src.slice(at, src.indexOf('}', at)));
    assert.ok(/display:\s*inline-flex/.test(css), 'chip is its own inline box');
    assert.ok(/align-items:\s*baseline/.test(css), `the label must supply the container baseline: ${css}`);
    assert.ok(
      !/align-items:\s*center/.test(css),
      'centring synthesises the baseline from the box — that was attempt 3',
    );
    assert.ok(/vertical-align:\s*baseline/.test(css), 'the chip sits on the text baseline');
    // Smaller than prose, and relative so it still scales with the editor font.
    assert.ok(/font-size:\s*0\.\d+em/.test(css), `the chip must be smaller than the text around it: ${css}`);
    assert.ok(!/font-size:\s*inherit/.test(css), 'inheriting the body size is what made it look oversized');
    assert.ok(!/font-size:\s*\d+px/.test(css), 'a px size would not scale with the editor font');
    // A non-visible overflow makes an inline-level box use its bottom margin edge as
    // its baseline, which would defeat align-items: baseline above.
    assert.ok(!/overflow:/.test(css), `overflow would override the baseline: ${css}`);
    // Vertical padding must exist and be symmetric, or the background sits off-centre
    // around the label.
    const pad = /padding:\s*([^;]+);/.exec(css);
    assert.ok(pad, 'chip needs padding');
    assert.ok(!/^0\s/.test(pad![1].trim()), `vertical padding must not be 0: ${pad![1]}`);

    // The queue variant is a separate rule and has re-broken this twice.
    const qAt = src.indexOf('.msg-queue-item .context-pill {');
    assert.ok(qAt > 0, 'queue-chip pill style missing');
    const qCss = declarations(src.slice(qAt, src.indexOf('}', qAt)));
    assert.ok(!/font-size:/.test(qCss), `the queue chip must not override the font size: ${qCss}`);
    assert.ok(!/line-height:/.test(qCss), 'nor the line height');

    // The row aligns by baseline, and the message text needs its own element to be a
    // flex child at all.
    const rAt = src.indexOf('.msg-queue-item .queue-text {');
    assert.ok(rAt > 0, 'queue-text style missing');
    const rCss = declarations(src.slice(rAt, src.indexOf('}', rAt)));
    assert.ok(/display:\s*flex/.test(rCss), `the queue row must be flex: ${rCss}`);
    assert.ok(/align-items:\s*baseline/.test(rCss), 'chip label and message text share a baseline');
    assert.ok(/min-width:\s*0/.test(rCss), 'a flex child needs min-width:0 to ellipsise');
    assert.ok(src.includes("queueBody.className = 'queue-text-body'"), 'queued text must be its own element');
    assert.ok(src.includes('.msg-queue-item .queue-text-body {'), 'and needs the ellipsis rule');
  });

  test('the renderer and the queue chip both use it, and the chip has a style', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    const at = src.indexOf('function renderUserMessageContent(el, text) {');
    assert.ok(at > 0, 'renderUserMessageContent not found');
    assert.ok(src.slice(at, at + 900).includes('appendContextPills(el, text)'), 'user bubble must draw chips');
    const q = src.indexOf("textSpan.className = 'queue-text';");
    assert.ok(src.slice(q, q + 400).includes('appendContextPills(textSpan'), 'queue chip must draw chips');
    assert.ok(src.includes('.context-pill {'), 'the chip needs a style');
  });
});

/**
 * Live and resumed panels must show the SAME chips.
 *
 * The webview renders the bubble from what the user typed ("@terminal fix this"),
 * then the host resolves the mention — so the live bubble could not know what was
 * attached, or how much of it, while the resumed bubble showed
 * "[Terminal: 40 lines] fix this". The host now echoes the labels it attached and
 * the webview rewrites its last bubble to the resumed form.
 */
suite('one chip per attachment, however the host reports it', () => {
  const wv = loadWebviewFns();
  const CLIP = '@clipboard: the clipboard was empty when this message queued';
  const PROSE = ': the clipboard was empty when this message queued , before deploy of fix has this issue also';

  test('the reported double chip: label AND inlined payload for the same attachment', () => {
    // For an agent without embeddedContext the payload is inlined into the text the
    // host reports, and cleanUserMessage turns that into a pill — so taking the
    // host's label list at face value too rendered the chip twice.
    const wire = `<clipboard>\n${CLIP}\n</clipboard>\n\n${PROSE}`;
    const out = wv.contextAttachedDisplayText(['Clipboard: 1 line'], wire);
    assert.strictEqual(out, `[Clipboard: 1 line]\n\n${PROSE}`);
    assert.strictEqual((out.match(/\[Clipboard/g) ?? []).length, 1, out);
  });

  test('an embedded agent reports a label the text cannot carry', () => {
    // Nothing is inlined, so the label is the only source.
    const out = wv.contextAttachedDisplayText(['Clipboard: 4 lines'], 'summarise this');
    assert.strictEqual(out, '[Clipboard: 4 lines]\n\nsummarise this');
  });

  test('different attachments each keep their own chip', () => {
    const wire = '<terminal name="bash">\n$ make\nerr\n</terminal>\n\nwhy?';
    const out = wv.contextAttachedDisplayText(['Clipboard: 2 lines'], wire);
    assert.strictEqual(out, '[Clipboard: 2 lines]\n\n[Terminal: 2 lines]\n\nwhy?');
  });

  test('no labels and no payload leaves the prose alone', () => {
    assert.strictEqual(wv.contextAttachedDisplayText([], 'just text'), 'just text');
    assert.strictEqual(wv.contextAttachedDisplayText(undefined as unknown as string[], 'just text'), 'just text');
  });

  test('the host reports the PROSE, not the wire text', () => {
    // Root cause of the duplicate: the post used the text after the payload had been
    // prepended for agents without embeddedContext.
    const src = fs.readFileSync(SOURCE, 'utf8');
    const at = src.indexOf("type: 'contextAttached'");
    assert.ok(at > 0, 'contextAttached post missing');
    const body = src.slice(at, at + 200);
    assert.ok(body.includes('text: proseText'), `must report the prose: ${body}`);
    assert.ok(src.includes('let proseText = text;'), 'prose must be tracked separately from the wire text');
  });

  test('a stripped mention that attached NOTHING is still reported', () => {
    // @clipboard is removed from the outgoing text before the clipboard is even read,
    // so an empty clipboard sends prose with no attachment. Gating the post on
    // attachedPills left the panel showing "@clipboard no links" — a mention the agent
    // never received — with only a toast to say why, and disagreeing with the same
    // turn after a resume.
    const src = fs.readFileSync(SOURCE, 'utf8');
    const at = src.indexOf("type: 'contextAttached'");
    const guard = src.slice(src.lastIndexOf('if (', at), at);
    assert.ok(
      /attachedPills\.length > 0 \|\| proseDiffers/.test(guard),
      `the post must also fire when the text changed without an attachment: ${guard}`,
    );
    assert.ok(
      src.includes('const proseDiffers = proseText.trim() !== rawTextForBubble.trim();'),
      'proseDiffers must compare the prose against what the webview drew',
    );
  });

  test('the webview rewrites a zero-pill resolution when the text changed', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    const at = src.indexOf("case 'contextAttached': {");
    assert.ok(at > 0, 'contextAttached handler missing');
    const handler = src.slice(at, src.indexOf("case 'compactionBoundary'", at));
    assert.ok(
      /_capChanged\s*=\s*String\(msg\.text \|\| ''\)\.trim\(\) !== String\(msg\.rawText \|\| ''\)\.trim\(\)/.test(
        handler,
      ),
      `the handler must notice a text-only change: ${handler.slice(0, 400)}`,
    );
    assert.ok(
      /if \(_capPills\.length === 0 && !_capChanged\) break;/.test(handler),
      'zero pills alone must no longer skip the rewrite',
    );
  });

  test('zero pills renders the prose alone, with no empty chip', () => {
    // The rewrite must not invent a pill for an attachment that did not happen.
    assert.strictEqual(wv.contextAttachedDisplayText([], 'no links'), 'no links');
  });
});

suite('the live bubble is rewritten to the resumed form', () => {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const at = src.indexOf('const contextBlocks: ContentBlock[] = [];');
  const resolver = src.slice(at, src.indexOf('this._cancelGeneration++', at));

  test('the host reports a label for every kind of attachment', () => {
    assert.ok(at > 0, 'context resolver not found');
    for (const label of [
      'Terminal: ${termLines}',
      'Clipboard: ${clipLines}',
      'Problems: ${lines.length}',
      'File: ${pillPathBase(uri.fsPath)}',
      'Directory: ${pillPathBase(uri.fsPath)}/',
      'Selected code: ${base}:${sel.startLine}',
    ]) {
      assert.ok(resolver.includes(label), `no pill reported for: ${label}`);
    }
  });

  test('nothing is posted for a prompt the host did not touch', () => {
    // Sharper than "nothing was attached": a resolution that stripped a mention
    // without attaching anything (@clipboard, empty clipboard) DOES change the wire
    // text and must be reported, or the panel keeps a mention the agent never got.
    // Only a prompt the host left completely alone is a no-op.
    assert.ok(
      resolver.includes('if (attachedPills.length > 0 || proseDiffers) {'),
      'a plain prompt must not trigger a rewrite, but a stripped mention must',
    );
    assert.ok(
      resolver.includes('const proseDiffers = proseText.trim() !== rawTextForBubble.trim();'),
      'the no-op case is "prose identical to what the webview drew"',
    );
    assert.ok(resolver.includes("type: 'contextAttached'"), 'the labels must reach the webview');
    assert.ok(resolver.includes('rawText: rawTextForBubble'), 'the echo must identify the bubble it belongs to');
  });

  test('the webview rewrites only the bubble the resolution belongs to', () => {
    const wv = src.indexOf("case 'contextAttached': {");
    assert.ok(wv > 0, 'webview handler missing — the live bubble would never update');
    const body = src.slice(wv, wv + 2000);
    assert.ok(body.includes("!== String(msg.rawText || '').trim()"), 'must match the text it rendered');
    assert.ok(body.includes('renderUserMessageContent(_capEl, _capText)'), 'must re-render as chips');
    assert.ok(body.includes('saveState()'), 'the rewrite must survive a reload');
  });

  test('the rewritten text is exactly what a resume would produce', () => {
    // Built by the same helper that cleans the host text, so this rewrite and
    // cleanUserMessage on the replayed message converge on one string — and one chip
    // per attachment even when both sources describe the same one.
    const wv = src.indexOf("case 'contextAttached': {");
    const body = src.slice(wv, wv + 2000);
    assert.ok(
      body.includes('contextAttachedDisplayText(_capPills, msg.text)'),
      `the rewrite must go through the merging helper: ${body.slice(0, 400)}`,
    );
  });
});

/**
 * A /session lookup must look the same live and after resume.
 *
 * The panel shows the command the user typed ("/session ue what's this"), but what
 * the agent receives — and therefore what session/load replays — is the generated
 * summary wrapped in <context ref="session:ue">. The bubble would change shape
 * between the two, so the live one is rewritten to the resumed form.
 */
suite('an answered /session turn is rewritten to its pill', () => {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const caseAt = src.indexOf("case 'sessionSummary':");
  const at = src.indexOf('} else if (msg.summary) {', caseAt);

  test('the live bubble is rewritten to the same [Session: …] form', () => {
    assert.ok(caseAt > 0 && at > caseAt, 'sessionSummary handler not found');
    const body = src.slice(at, at + 2200);
    assert.ok(body.includes("'[Session: ' + sessionTitle + ']'"), 'must show the session pill');
    assert.ok(body.includes('renderUserMessageContent(_ssEl, _ssDisplay)'), 'must re-render as a chip');
    assert.ok(body.includes('saveState()'), 'the rewrite must survive a reload');
  });

  test('only the /session bubble is rewritten', () => {
    const body = src.slice(at, at + 2200);
    assert.ok(body.includes("indexOf('/session') !== 0"), 'an unrelated last bubble must be left alone');
  });

  test('the summary itself still goes to the agent', () => {
    const body = src.slice(at, at + 2200);
    const rewrite = body.indexOf('_ssItem.text = _ssDisplay');
    const send = body.indexOf("type: 'sendPrompt', text: userMsg");
    assert.ok(rewrite > 0 && send > rewrite, 'display is the pill, the wire keeps the summary');
  });

  test('the live bubble carries the image chip, read before the images are consumed', () => {
    // pendingImages is spliced right after the bubble is added, so the count has to
    // be read first — otherwise the chip would always say zero.
    const src2 = fs.readFileSync(SOURCE, 'utf8');
    const at2 = src2.indexOf('function handleSend()');
    const body2 = src2.slice(at2, src2.indexOf('const images = pendingImages.splice(0)', at2));
    assert.ok(body2.includes('imagePillLabel(pendingImages.length)'), 'the chip must be built before the splice');
  });

  test('a replayed image block renders the chip too', () => {
    const src2 = fs.readFileSync(SOURCE, 'utf8');
    const at2 = src2.indexOf("} else if (content && content.type === 'image') {");
    assert.ok(at2 > 0, 'replayed image blocks are not handled — a resumed prompt loses its attachment');
    const body2 = src2.slice(at2, at2 + 1200);
    assert.ok(body2.includes('imagePillLabel(1)'), 'must use the same label');
    assert.ok(body2.includes('renderUserMessageContent('), 'must re-render the row as chips');
  });

  test('the OTHER /session route — summary dropped into the composer — is covered too', () => {
    // contextPicked puts the <context ref="session:…"> block in the input, so the
    // bubble is built from text that already carries the block. handleSend cleans
    // the DISPLAY copy only.
    const send = src.indexOf('function handleSend()');
    const body = src.slice(send, src.indexOf('function ', send + 100));
    assert.ok(body.includes("cleanUserMessage(String(text || ''))"), 'the live bubble must be cleaned');
    assert.ok(body.includes('_sendDisplay = text;'), 'never show an empty bubble if cleaning empties it');
  });
});

suite('the webview template literal stays a template literal', () => {
  test('no backtick inside the webview script', () => {
    // A single backtick in a comment ends the HTML template literal, and the rest of
    // the script is then parsed as TypeScript — which is how it fails: not as a
    // webview error but as a build error hundreds of lines later. tsc catches it,
    // but only after the fact; this names the cause.
    const src = fs.readFileSync(SOURCE, 'utf8');
    const htmlStart = src.indexOf('<!DOCTYPE html>');
    const scriptStart = src.indexOf('<script nonce=', htmlStart);
    const scriptEnd = src.lastIndexOf('</script>');
    assert.ok(htmlStart > 0 && scriptStart > htmlStart && scriptEnd > scriptStart, 'webview script not found');
    const script = src.slice(scriptStart, scriptEnd);
    const idx = script.indexOf('`');
    if (idx >= 0) {
      const line = script.slice(0, idx).split('\n').length;
      const ctx = script.slice(Math.max(0, idx - 80), idx + 80);
      assert.fail(`backtick inside the webview script (line ~${line} of the script):\n…${ctx}…`);
    }
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
      steerReleases: 0,
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
      // The clipboardForQueue handler now releases the auto-steer once the token
      // clears — a queued entry must not be steered while its snapshot is still in
      // flight, or the interjection goes out as the bare mention. Counted so the
      // harness proves the release happens rather than just tolerating the call.
      function maybeAutoSteerNext() { state.steerReleases++; }
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

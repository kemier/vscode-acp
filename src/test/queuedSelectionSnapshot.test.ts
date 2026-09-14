import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { decodeTemplate } from './templateDecode';

/**
 * A selection made in the editor must survive being queued.
 *
 * No @ mention is involved: the host picks the selection up implicitly, by reading
 * `vscode.window.activeTextEditor.selections` (with a `visibleTextEditors` fallback)
 * at the moment `sendPrompt` arrives. On a direct send that is the same instant the
 * user pressed Enter, so the selected code is attached and shows as a
 * "Selected code: file:line" pill.
 *
 * A queued message posts `sendPrompt` only when it DRAINS. Re-reading the editor then
 * returns whatever is selected minutes later — normally nothing, because the user has
 * clicked into the composer, scrolled, or the agent has opened its own files. So the
 * selected text reached the agent on a direct send and silently vanished on a queued
 * one.
 *
 * The fix mirrors the @clipboard snapshot: capture at queue time, store it on the
 * entry, and carry it on every send path. It is inlined into the prompt text rather
 * than sent as an ACP resource block because `session/steer` has no block support at
 * all, and for an auto-steering agent the steer IS how a queued message reaches the
 * model.
 */
const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

function extractFn(name: string): string {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const needle = 'function ' + name + '(';
  for (let at = src.indexOf(needle); at >= 0; at = src.indexOf(needle, at + 1)) {
    if (src.slice(at, src.indexOf('{', at)).includes(':')) {
      continue; // typed signature = host TypeScript, not the webview copy
    }
    let i = src.indexOf('{', at);
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
    return decodeTemplate(src.slice(at, i + 1));
  }
  throw new Error('no untyped declaration of ' + name);
}

interface Helpers {
  queueEntryPromptText: (e: unknown) => string;
  queueEntryDisplayText: (e: unknown) => string;
  selectionPillLabel: (s: unknown) => string;
  selectionPromptBlock: (s: unknown) => string;
}

function load(): Helpers {
  const harness =
    extractFn('clipboardPillLabel') +
    '\n' +
    extractFn('imagePillLabel') +
    '\n' +
    extractFn('selectionPillLabel') +
    '\n' +
    extractFn('selectionPromptBlock') +
    '\n' +
    extractFn('queueEntryPromptText') +
    '\n' +
    extractFn('queueEntryDisplayText') +
    '\nreturn { queueEntryPromptText, queueEntryDisplayText, selectionPillLabel, selectionPromptBlock };';
  return new Function(harness)() as Helpers;
}

const SEL = [
  { absPath: '/repo/src/parser.ts', startLine: 12, endLine: 14, text: 'const x = 1;', languageId: 'typescript' },
];

suite('a queued message keeps the selection it was composed with', () => {
  test('the selection reaches the wire text', () => {
    const h = load();
    const out = h.queueEntryPromptText({ text: 'explain this', selections: SEL });
    assert.ok(out.includes('const x = 1;'), 'the selected code must be in the prompt: ' + out);
    assert.ok(out.includes('/repo/src/parser.ts:12-14'), 'with its file and line range: ' + out);
    assert.ok(out.endsWith('explain this'), 'the typed words stay last: ' + out);
  });

  test('an entry with no selection is unchanged', () => {
    const h = load();
    assert.strictEqual(h.queueEntryPromptText({ text: 'just words' }), 'just words');
    assert.strictEqual(h.queueEntryPromptText({ text: 'just words', selections: [] }), 'just words');
  });

  test('selection and clipboard can both ride along', () => {
    const h = load();
    const out = h.queueEntryPromptText({
      text: 'compare these',
      selections: SEL,
      clipboard: { text: 'pasted payload' },
    });
    assert.ok(out.includes('const x = 1;'), 'selection present');
    assert.ok(out.includes('pasted payload'), 'clipboard present');
    assert.ok(out.endsWith('compare these'), 'typed words last');
  });

  test('the chip and bubble show a pill, never the payload', () => {
    const h = load();
    const shown = h.queueEntryDisplayText({ text: 'explain this', selections: SEL });
    assert.ok(shown.includes('[Selected code: parser.ts:12]'), 'expected a pill: ' + shown);
    assert.ok(!shown.includes('const x = 1;'), 'the payload must NOT be displayed: ' + shown);
    assert.ok(shown.includes('explain this'));
  });

  test('a selection with no text is ignored', () => {
    const h = load();
    const empty = [{ absPath: '/a/b.ts', startLine: 1, endLine: 1, text: '' }];
    assert.strictEqual(h.selectionPromptBlock(empty), '');
    assert.strictEqual(h.selectionPillLabel(empty), '');
    assert.strictEqual(h.selectionPillLabel(null), '');
    assert.strictEqual(h.selectionPromptBlock(undefined), '');
  });

  test('an untitled buffer still gets a usable label', () => {
    const h = load();
    const untitled = [{ absPath: null, uri: 'untitled:Untitled-1', startLine: 3, endLine: 3, text: 'draft' }];
    assert.ok(h.selectionPillLabel(untitled).includes('Untitled:3'));
    assert.ok(h.selectionPromptBlock(untitled).includes('draft'));
  });
});

suite('the queue snapshot is wired end to end', () => {
  const src = fs.readFileSync(SOURCE, 'utf8');

  test('queueMessage asks for a snapshot unconditionally', () => {
    const fn = extractFn('queueMessage');
    // Unlike @clipboard there is no mention to detect — a selection is implicit —
    // so the request must not be behind any condition.
    assert.ok(fn.includes("type: 'resolveSelectionsForQueue'"), fn);
    assert.ok(fn.includes('entry.selectionToken ='), 'the token must be recorded on the entry');
  });

  test('the host captures with the same rule used for a direct send', () => {
    // One capture function, so a queued selection and a direct one cannot diverge.
    assert.ok(src.includes('private captureEditorSelections()'), 'the capture must be extracted');
    assert.ok(src.includes('const selections = selectionsOverride ?? this.captureEditorSelections();'));
    const at = src.indexOf('private captureEditorSelections()');
    const fn = src.slice(at, src.indexOf('\n  }', at));
    assert.ok(fn.includes('activeTextEditor'), 'active editor first');
    assert.ok(fn.includes('visibleTextEditors'), 'and the visible-editor fallback is preserved');
  });

  test('the host answers the snapshot request', () => {
    assert.ok(src.includes("case 'resolveSelectionsForQueue'"), 'handler must exist');
    assert.ok(src.includes("type: 'selectionsForQueue'"), 'and reply with the selections');
  });

  test('every drained send suppresses the host re-read', () => {
    // Passing the array — even empty — is what stops the host capturing a live
    // selection and attaching it on top of the one already inlined in the text.
    const sends = src.split("type: 'sendPrompt', text: queueEntryPromptText(entry)").length - 1;
    assert.strictEqual(sends, 3, 'expected the drain, Send Now and after-cancel paths');
    const withOverride = src.split('selections: [] });').length - 1;
    assert.strictEqual(withOverride, 3, 'all three must pass the override');
  });

  test('the steer path carries the selection in its text', () => {
    // session/steer is text-only, so queueEntryPromptText is the only carrier.
    const steers = src.split("type: 'steerPrompt', text: queueEntryPromptText(entry)").length - 1;
    assert.ok(steers >= 1, 'the steer path must use the expanded prompt text');
  });
});

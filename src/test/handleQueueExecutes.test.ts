import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { decodeTemplate } from './templateDecode';

/**
 * handleQueue must actually run.
 *
 * A refactor deleted `const images = pendingImages.splice(0);` from handleQueue
 * while rewrapping the empty-input guard. Everything still compiled and every
 * source-text assertion still passed, because nothing in the suite executed the
 * function: the reference to `images` only fails at runtime, and it fails AFTER
 * `promptInput.value = ''` has already run. The result was a message typed
 * mid-turn that vanished completely — no queue chip, no chat bubble, no entry in
 * messageQueue, no frame on the wire — and, until the webview gained an error
 * listener, no trace of the exception either.
 *
 * The lesson is that this path needs an EXECUTION test, not another assertion
 * about its text. A ReferenceError anywhere in handleQueue now fails here.
 */
const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

function extractFn(name: string): string {
  const src = fs.readFileSync(SOURCE, 'utf8');
  // Pick the WEBVIEW declaration, not a host one of the same name.
  // hasLeadingClipboardMention exists twice on purpose — the webview cannot call
  // into the host's TypeScript scope — and the host copy appears first in the file,
  // so a plain indexOf silently harnesses TypeScript that the browser never runs.
  // The webview is plain JS, so its signature carries no type annotations.
  const needle = 'function ' + name + '(';
  let start = -1;
  for (let at = src.indexOf(needle); at >= 0; at = src.indexOf(needle, at + 1)) {
    const sig = src.slice(at, src.indexOf('{', at));
    if (!sig.includes(':')) {
      start = at;
      break;
    }
  }
  assert.ok(start >= 0, 'no untyped (webview) declaration of ' + name);
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
  return decodeTemplate(src.slice(start, i + 1));
}

interface QueueRun {
  queued: { text: string; images: unknown[]; videoAttached?: boolean }[];
  cleared: boolean;
  rendered: number;
}

/**
 * Execute the REAL handleQueue against stubs.
 *
 * Only the collaborators handleQueue itself touches are faked; the function body
 * is the shipped source, so an undefined reference inside it throws here exactly
 * as it does in the webview.
 */
function runHandleQueue(text: string, images: unknown[] = [], videoAttached = false): QueueRun {
  const run: QueueRun = { queued: [], cleared: false, rendered: 0 };
  const promptInput = {
    _v: text,
    get value(): string {
      return this._v;
    },
    set value(v: string) {
      this._v = v;
      if (v === '') {
        run.cleared = true;
      }
    },
  };
  const harness = `
${extractFn('handleQueue')}
return handleQueue;
`;
  const fn = new Function(
    'promptInput',
    'pendingImages',
    'imagePreviewStrip',
    'updateSendButton',
    'wvProbe',
    'wvQueueLog',
    'queueIsMutatingCommand',
    'queueMessage',
    'vscode',
    'isProcessing',
    'isSendingPrompt',
    'isCompacting',
    'isClearing',
    'messageQueue',
    'pendingVideoAttached',
    'videoPreviewStrip',
    harness,
  );
  fn(
    promptInput,
    images,
    { innerHTML: '' },
    () => {},
    () => {},
    () => {},
    (t: string) => t.startsWith('/'),
    (t: string, imgs: unknown[], vid?: boolean) => {
      run.queued.push({ text: t, images: imgs, videoAttached: vid });
      run.rendered++;
    },
    { postMessage: () => {} },
    true,
    false,
    false,
    false,
    [],
    videoAttached,
    { innerHTML: '' },
  )();
  return run;
}

suite('handleQueue executes without throwing', () => {
  test('a plain mid-turn message reaches queueMessage', () => {
    const run = runHandleQueue('a message typed while the turn streams');
    assert.strictEqual(run.queued.length, 1, 'the message must be handed to queueMessage');
    assert.strictEqual(run.queued[0].text, 'a message typed while the turn streams');
    assert.ok(run.cleared, 'the composer must be cleared once the text is taken');
  });

  test('pending attachments are passed through, not dropped', () => {
    // This is the exact reference that went missing: the images local is read at
    // the queueMessage call, so losing it throws rather than queueing without them.
    const img = { data: 'iVBORw0KGgo=', mimeType: 'image/png' };
    const run = runHandleQueue('look at this', [img]);
    assert.strictEqual(run.queued.length, 1);
    assert.deepStrictEqual(run.queued[0].images, [img], 'attachments must reach the entry');
  });

  test('an image with no text still queues', () => {
    const run = runHandleQueue('', [{ data: 'x', mimeType: 'image/png' }]);
    assert.strictEqual(run.queued.length, 1, 'an attachment alone is a valid queued message');
  });

  test('a screen recording queues WITH its text, not instead of it', () => {
    // The reported bug: sending a captured video + text mid-turn queued only the
    // text — the take was a floating host global bound to no entry, so it was
    // dropped (or attached to an unrelated later send). The video must ride the
    // entry alongside the text.
    const run = runHandleQueue('look at this recording', [], true);
    assert.strictEqual(run.queued.length, 1, 'the message must be queued');
    assert.strictEqual(run.queued[0].text, 'look at this recording', 'the text must survive');
    assert.strictEqual(run.queued[0].videoAttached, true, 'the video must ride the same entry as the text');
  });

  test('a screen recording with no text still queues', () => {
    const run = runHandleQueue('', [], true);
    assert.strictEqual(run.queued.length, 1, 'a recording alone is a valid queued message');
    assert.strictEqual(run.queued[0].videoAttached, true);
  });

  test('empty input queues nothing and leaves the composer alone', () => {
    const run = runHandleQueue('', []);
    assert.strictEqual(run.queued.length, 0, 'nothing to queue');
    assert.ok(!run.cleared, 'an empty submit must not clear anything');
  });

  test('a mutating slash command is queued too', () => {
    const run = runHandleQueue('/compact');
    assert.strictEqual(run.queued.length, 1, 'mutating commands queue like any other message');
    assert.strictEqual(run.queued[0].text, '/compact');
  });

  test('the attachments local is drained before the preview strip is cleared', () => {
    // Ordering matters: clearing the strip first would leave the entry with an
    // empty array on some paths. Asserted on the source because the stub cannot
    // observe the interleaving.
    const fn = extractFn('handleQueue');
    const splice = fn.indexOf('pendingImages.splice(0)');
    const clear = fn.indexOf('imagePreviewStrip.innerHTML');
    assert.ok(splice > 0, 'handleQueue must take the pending attachments');
    assert.ok(clear > 0, 'handleQueue must clear the preview strip');
    assert.ok(splice < clear, 'take the attachments before clearing the strip');
  });
});

/**
 * queueMessage must reach renderQueue.
 *
 * The original defect: queueMessage called hasLeadingClipboardMention, which exists
 * only in the host's TypeScript scope, not in the webview. The call threw AFTER
 * messageQueue.push had already succeeded, so the entry really was queued while
 * renderQueue(), maybeAutoSteerNext() and the QUEUED trace after it never ran.
 *
 * That produces exactly the reported symptoms, and explains why they looked
 * contradictory: no chip (renderQueue skipped), no session/steer frame
 * (maybeAutoSteerNext skipped), no QUEUED line in the fault log, yet the message
 * appears and starts a turn as soon as the turn ends or Stop is pressed, because
 * drainQueue finds the entry that was pushed before the throw.
 *
 * A push that is not followed by a render is the invariant worth testing, so these
 * execute the shipped body rather than asserting on its text.
 */
function runQueueMessage(text: string, images: unknown[] = []) {
  const state = {
    queue: [] as Record<string, unknown>[],
    renders: 0,
    steerAttempts: 0,
    posted: [] as Record<string, unknown>[],
  };
  const harness = `
${extractFn('hasLeadingClipboardMention')}
${extractFn('queueMessage')}
return queueMessage;
`;
  const fn = new Function('messageQueue', 'renderQueue', 'maybeAutoSteerNext', 'wvQueueLog', 'vscode', harness);
  fn(
    state.queue,
    () => {
      state.renders++;
    },
    () => {
      state.steerAttempts++;
    },
    () => {},
    { postMessage: (m: Record<string, unknown>) => state.posted.push(m) },
  )(text, images);
  return state;
}

suite('queueMessage renders what it queued', () => {
  test('a plain message is pushed AND rendered', () => {
    const s = runQueueMessage('a message typed while the turn streams');
    assert.strictEqual(s.queue.length, 1, 'the entry must be queued');
    assert.strictEqual(s.renders, 1, 'a queued entry that is never rendered is an invisible chip');
    assert.strictEqual(s.steerAttempts, 1, 'the steer path must still be offered the entry');
  });

  test('a @clipboard message queues, requests the snapshot, and still renders', () => {
    const s = runQueueMessage('@clipboard explain this');
    assert.strictEqual(s.queue.length, 1);
    assert.strictEqual(s.renders, 1, 'the clipboard branch must not skip the render');
    const req = s.posted.find((m) => m.type === 'resolveClipboardForQueue');
    assert.ok(req, 'a leading @clipboard must request the host snapshot');
    assert.ok(s.queue[0].clipboardToken, 'the entry must carry the token it is waiting on');
  });

  test('a mid-sentence @clipboard is literal text, not an attach request', () => {
    // Matches the host's rule: a search query that merely contains the word must not
    // hijack the clipboard, which previously attached content twice.
    const s = runQueueMessage('search for AI assistant @clipboard mention handling');
    assert.strictEqual(s.renders, 1);
    assert.ok(
      !s.posted.some((m) => m.type === 'resolveClipboardForQueue'),
      'no snapshot request for a mid-sentence mention',
    );
    assert.ok(!s.queue[0].clipboardToken, 'no token for a mid-sentence mention');
  });

  test('a mention after a newline still counts', () => {
    const s = runQueueMessage('here is the thing\n@clipboard');
    assert.ok(
      s.posted.some((m) => m.type === 'resolveClipboardForQueue'),
      'a line-start mention after a newline is an attach request',
    );
  });

  test('the webview copy agrees with the host helper', () => {
    // Two copies of the rule exist because the webview cannot call into the host's
    // scope. They must not drift, or the chip and the wire disagree about what was
    // attached.
    const src = fs.readFileSync(SOURCE, 'utf8');
    const hostAt = src.indexOf('function hasLeadingClipboardMention(t: string): boolean {');
    const wvAt = src.indexOf('function hasLeadingClipboardMention(t) {');
    assert.ok(hostAt > 0, 'the host helper must still exist');
    assert.ok(wvAt > 0, 'the webview helper must exist — queueMessage runs in the webview');
    const wv = extractFn('hasLeadingClipboardMention');
    // decodeTemplate has already collapsed the doubled escapes, so what is asserted
    // here is what the browser actually compiles.
    assert.ok(wv.includes('/@clipboard\\b/gi'), 'word-boundary must survive the template literal: ' + wv);
    assert.ok(wv.includes('\\r?\\n'), 'the newline check must survive the template literal: ' + wv);
  });
});

/**
 * No webview code may call a function that only exists in the host.
 *
 * The webview script is a template literal evaluated in a separate JS realm. A call
 * to a host-side TypeScript function compiles cleanly, passes every source-text
 * assertion, and then throws ReferenceError at runtime — and before the webview had
 * an error listener, silently. hasLeadingClipboardMention was exactly this: it aborted
 * queueMessage between messageQueue.push and renderQueue, so a message queued mid-turn
 * was held with no chip and no steer, and surfaced only when the turn ended.
 *
 * This is a general scan rather than a check for that one name, because nothing about
 * the mistake was specific to it.
 */
suite('webview script has no host-only references', () => {
  test('every function the webview calls is declared in the webview', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    const lines = src.split('\n');
    const start = lines.findIndex((l) => l.includes('/*html*/'));
    assert.ok(start > 0, 'the webview template literal must be findable');
    let end = -1;
    for (let i = start + 1; i < lines.length; i++) {
      // The literal closes on the same line as the document it emits: `</html>`;
      if (lines[i].includes('</html>`;')) {
        end = i;
        break;
      }
    }
    assert.ok(end > start, 'the webview template literal must be terminated');
    const wv = lines.slice(start, end).join('\n');
    const host = lines.slice(0, start).join('\n') + lines.slice(end).join('\n');

    const declared = new Set<string>();
    for (const m of wv.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
      declared.add(m[1]);
    }
    for (const m of wv.matchAll(/(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:function|\()/g)) {
      declared.add(m[1]);
    }
    const hostDeclared = new Set<string>();
    for (const m of host.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
      hostDeclared.add(m[1]);
    }

    // Comments mention host helpers legitimately and constantly, so strip them
    // before looking for call sites; otherwise the scan is all false positives.
    const code = wv
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n')
      .map((l) => l.replace(/^\s*(?:\/\/|\*).*$/, ' ').replace(/\/\/.*$/, ' '))
      .join('\n');

    const keywords = new Set([
      'if',
      'for',
      'while',
      'switch',
      'catch',
      'function',
      'return',
      'typeof',
      'new',
      'do',
      'else',
      'void',
      'delete',
      'await',
      'case',
      'in',
      'of',
    ]);
    const leaked: string[] = [];
    for (const m of code.matchAll(/(?<![.\w$])([a-z_$][\w$]*)\s*\(/g)) {
      const name = m[1];
      if (keywords.has(name) || declared.has(name) || leaked.includes(name)) {
        continue;
      }
      if (hostDeclared.has(name)) {
        leaked.push(name);
      }
    }
    assert.deepStrictEqual(
      leaked,
      [],
      'these are called in the webview but only declared host-side, so they throw ' +
        'ReferenceError at runtime: ' +
        leaked.join(', '),
    );
  });
});

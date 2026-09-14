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
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' not found');
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
  queued: { text: string; images: unknown[] }[];
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
function runHandleQueue(text: string, images: unknown[] = []): QueueRun {
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
    (t: string, imgs: unknown[]) => {
      run.queued.push({ text: t, images: imgs });
      run.rendered++;
    },
    { postMessage: () => {} },
    true,
    false,
    false,
    false,
    [],
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

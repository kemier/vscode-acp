import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { decodeTemplate } from './templateDecode';

/**
 * A queued entry must not be steered while its snapshot is still in flight.
 *
 * queueMessage posts resolveClipboardForQueue / resolveSelectionsForQueue and then calls
 * maybeAutoSteerNext in the SAME tick, so the host's reply always loses the race. On a
 * live ericli session this repeated every time:
 *
 *   02:00:57  Steered  "@clipboard"            02:01:24  sendPrompt  "<clipboard>…"
 *   02:13:39  Steered  "@clipboard"            02:13:45  sendPrompt  "<clipboard>…"
 *   02:48:58  Steered  "@clipboard"            02:49:09  sendPrompt  "<clipboard>…"
 *
 * Two failures from one race:
 *
 *  1. The interjection reached the model as the bare mention with nothing attached, so
 *     the agent went hunting for a clipboard file over the shell — reported as "i copy
 *     and paste, but agent can't find it".
 *  2. ackSteeredQueueEntry matches the echo against the EXPANDED text. The echo carried
 *     the raw text, so it never matched, the entry was never acked, and the same message
 *     was delivered a SECOND time as a prompt — which is the pattern above.
 *
 * Skipping a pending entry is safe: the snapshot handlers call maybeAutoSteerNext once
 * the token clears, and an entry whose reply never arrives still drains at promptEnd.
 * Late is recoverable; wrong is not.
 */
const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

function extractFn(name: string): string {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const needle = 'function ' + name + '(';
  for (let at = src.indexOf(needle); at >= 0; at = src.indexOf(needle, at + 1)) {
    if (src.slice(at, src.indexOf('{', at)).includes(':')) {
      continue;
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

function loadPicker(): (q: unknown[]) => number {
  return new Function(extractFn('nextAutoSteerIndex') + '\nreturn nextAutoSteerIndex;')() as (q: unknown[]) => number;
}

suite('a snapshot in flight blocks the steer', () => {
  test('an entry awaiting its clipboard snapshot is not steered', () => {
    const pick = loadPicker();
    // Exactly the state queueMessage leaves behind for "@clipboard <words>".
    assert.strictEqual(pick([{ text: '@clipboard check this', clipboardToken: 'clip-1' }]), -1);
  });

  test('an entry awaiting its selection snapshot is not steered', () => {
    const pick = loadPicker();
    assert.strictEqual(pick([{ text: 'explain this', selectionToken: 'sel-1' }]), -1);
  });

  test('it becomes steerable once the token clears', () => {
    const pick = loadPicker();
    const entry: Record<string, unknown> = { text: '@clipboard check this', clipboardToken: 'clip-1' };
    assert.strictEqual(pick([entry]), -1, 'blocked while pending');
    delete entry.clipboardToken;
    entry.clipboard = { text: 'payload' };
    assert.strictEqual(pick([entry]), 0, 'released once resolved');
  });

  test('both tokens must clear, not just one', () => {
    const pick = loadPicker();
    const entry: Record<string, unknown> = {
      text: '@clipboard check this',
      clipboardToken: 'clip-1',
      selectionToken: 'sel-1',
    };
    delete entry.clipboardToken;
    assert.strictEqual(pick([entry]), -1, 'still waiting on the selection');
    delete entry.selectionToken;
    assert.strictEqual(pick([entry]), 0);
  });

  test('a pending entry does not block a later ready one from being skipped over', () => {
    const pick = loadPicker();
    // Order is preserved: the pending head is skipped, not promoted past.
    const idx = pick([{ text: '@clipboard first', clipboardToken: 'clip-1' }, { text: 'second, no snapshot' }]);
    assert.strictEqual(idx, 1, 'the ready entry is eligible');
  });

  test('an entry with no snapshot at all is unaffected', () => {
    const pick = loadPicker();
    assert.strictEqual(pick([{ text: 'plain words' }]), 0);
  });

  test('the existing exclusions still hold', () => {
    const pick = loadPicker();
    // Regression guard: the new check must not have displaced these.
    assert.strictEqual(pick([{ text: 'x', steerPending: true }]), -1, 'pending steer blocks all');
    assert.strictEqual(pick([{ text: 'x', images: [{}] }]), -1, 'images never steer');
    assert.strictEqual(pick([{ text: '/compact' }]), -1, 'slash commands never steer');
  });
});

suite('the snapshot handlers release the steer', () => {
  const src = fs.readFileSync(SOURCE, 'utf8');

  test('clipboardForQueue steers after clearing its token', () => {
    const at = src.indexOf("case 'clipboardForQueue'");
    assert.ok(at > 0, 'handler not found');
    const body = src.slice(at, at + 1800);
    const del = body.indexOf('delete _qe.clipboardToken;');
    const steer = body.indexOf('maybeAutoSteerNext();');
    assert.ok(del > 0 && steer > 0, 'both must be present');
    assert.ok(del < steer, 'the token must clear BEFORE the steer is attempted');
  });

  test('selectionsForQueue steers after clearing its token', () => {
    const at = src.indexOf("case 'selectionsForQueue'");
    assert.ok(at > 0, 'handler not found');
    const body = src.slice(at, at + 1400);
    const del = body.indexOf('delete _se.selectionToken;');
    const steer = body.indexOf('maybeAutoSteerNext();');
    assert.ok(del > 0 && steer > 0, 'both must be present');
    assert.ok(del < steer, 'the token must clear BEFORE the steer is attempted');
  });

  test('the echo is still matched against the expanded text', () => {
    // This is why the race caused a DOUBLE delivery, so the invariant matters: the
    // steer and the ack must agree on which form of the text was sent.
    const fn = extractFn('ackSteeredQueueEntry');
    assert.ok(fn.includes('steerEchoMatchesEntry(queueEntryPromptText(e), echoText)'));
  });
});

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { decodeTemplate } from './templateDecode';

/**
 * Auto-steer must be head-of-line blocking, i.e. strictly FIFO.
 *
 * nextAutoSteerIndex used to `continue` past an entry it could not steer and return a
 * LATER index. Reported live against an ericli session: with "@clipboard …" queued first
 * and "no links bare text" queued second, the second was steered immediately while the
 * first was still waiting for its snapshot — so the NEWER message reached the chat panel
 * and the agent first, and the two were answered out of order.
 *
 * drainQueue is strict FIFO (messageQueue.shift()), so the steer path was the only place
 * ordering could invert. An ineligible head must therefore block rather than be skipped:
 *
 *  - snapshot in flight  -> the clipboardForQueue / selectionsForQueue handlers re-run
 *                           maybeAutoSteerNext when the token clears, so it self-heals.
 *  - images / slash cmd  -> never steerable; they must start their own turn, so they and
 *                           everything behind them wait for drain at promptEnd.
 */
const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

function extractFn(name: string): string {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const needle = 'function ' + name + '(';
  for (let at = src.indexOf(needle); at >= 0; at = src.indexOf(needle, at + 1)) {
    // Skip the host-side typed declaration; the webview copy is the untyped one.
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
  return new Function(extractFn('nextAutoSteerIndex') + '\nreturn nextAutoSteerIndex;')() as (
    q: unknown[],
  ) => number;
}

suite('auto-steer is FIFO (head-of-line blocking)', () => {
  test('the reported case: a pending clipboard head must not let the next entry pass', () => {
    const pick = loadPicker();
    const queue = [
      { text: '@clipboard', clipboardToken: 'tok-1' },
      { text: 'no links bare text' },
    ];
    // Before the fix this returned 1 and the newer message went out first.
    assert.strictEqual(pick(queue), -1);
  });

  test('the head becomes steerable the moment its token clears', () => {
    const pick = loadPicker();
    const queue: Array<Record<string, unknown>> = [
      { text: '@clipboard', clipboardToken: 'tok-1' },
      { text: 'no links bare text' },
    ];
    assert.strictEqual(pick(queue), -1);
    delete queue[0].clipboardToken;
    queue[0].text = '<clipboard>\n/some/path';
    assert.strictEqual(pick(queue), 0, 'the OLDEST entry goes first, not the newest');
  });

  test('a pending selection head blocks too', () => {
    const pick = loadPicker();
    assert.strictEqual(
      pick([{ text: '@selection', selectionToken: 'sel-1' }, { text: 'later text' }]),
      -1,
    );
  });

  test('an image head blocks instead of being skipped', () => {
    const pick = loadPicker();
    // An image entry can never be steered — it must start its own turn. Reaching past it
    // would deliver the later text first.
    assert.strictEqual(pick([{ text: 'look at this', images: ['data:...'] }, { text: 'then this' }]), -1);
  });

  test('a slash-command head blocks instead of being skipped', () => {
    const pick = loadPicker();
    assert.strictEqual(pick([{ text: '/compact' }, { text: 'then this' }]), -1);
  });

  test('already-steered entries are passed over, since they were delivered in order', () => {
    const pick = loadPicker();
    // steered+acked entries sit at the front until drain; they are not a FIFO violation.
    assert.strictEqual(pick([{ text: 'first', steered: true }, { text: 'second' }]), 1);
    assert.strictEqual(
      pick([{ text: 'a', steered: true }, { text: 'b', steered: true }, { text: 'c' }]),
      2,
    );
  });

  test('a steerPending entry is skipped but does not block the next', () => {
    const pick = loadPicker();
    // Concurrent steers are allowed (249e22a): the pending entry is skipped
    // (never re-steered), but a later entry may still be auto-steered.
    assert.strictEqual(pick([{ text: 'a', steered: true, steerPending: true }, { text: 'b' }]), 1);
  });

  test('a plain queue steers its oldest entry', () => {
    const pick = loadPicker();
    assert.strictEqual(pick([{ text: 'oldest' }, { text: 'newer' }]), 0);
  });

  test('no entry is ever reached past — the result is 0 or the first unsteered index', () => {
    const pick = loadPicker();
    // Property check over the shapes that can block, in both orders. The answer must
    // never be an index greater than the first unsteered entry's.
    const blockers = [
      { text: '@clipboard', clipboardToken: 't' },
      { text: '@selection', selectionToken: 's' },
      { text: 'img', images: ['x'] },
      { text: '/slash' },
    ];
    for (const blocker of blockers) {
      const q = [blocker, { text: 'behind it' }];
      const got = pick(q);
      assert.strictEqual(got, -1, `blocker ${JSON.stringify(blocker)} must not be skipped`);
    }
  });

  test('empty and malformed queues are still safe', () => {
    const pick = loadPicker();
    assert.strictEqual(pick([]), -1);
    assert.strictEqual(pick([null as unknown as Record<string, unknown>, { text: 'a' }]), 1);
  });
});

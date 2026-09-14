import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * A message queued mid-turn showed no chip until the turn ended.
 *
 * The reported symptom was "the queued message is invisible during streaming,
 * then appears after end_turn" — and pressing Stop made it appear in the panel
 * and start a new turn, which is drainQueue's normal behaviour. That last part is
 * the important clue: drainQueue can only dequeue an entry that IS in
 * messageQueue, so handleQueue -> queueMessage -> renderQueue had all run and the
 * chip HAD been appended. Executing the real renderQueue against a stub DOM
 * confirmed it: one chip appended, container displayed, no exception thrown.
 *
 * The chip was in the DOM with a used height of zero.
 *
 * .msg-queue declares overflow-y:auto, and a flex item whose overflow is not
 * visible has an automatic minimum size of 0 rather than its content height. Its
 * siblings in .input-area could not give way instead: .input-resize-handle and
 * .input-toolbar are flex-shrink:0, and .input-editor-wrap is flex-basis:0% so it
 * contributes nothing to shrink. Once .input-area has an explicit pixel height —
 * which applyInputHeight gives it as soon as the resize handle is dragged — the
 * queue strip was the only item the flex algorithm could take space from, so it
 * absorbed the entire deficit and flattened to nothing.
 */
const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

function cssBlock(selector: string): string {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const start = src.indexOf(selector + ' {');
  assert.ok(start >= 0, 'CSS block not found: ' + selector);
  const end = src.indexOf('}', start);
  assert.ok(end > start, 'unterminated CSS block: ' + selector);
  return src.slice(start, end);
}

function fnBody(name: string): string {
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
  return src.slice(start, i + 1);
}

suite('a message queued mid-turn renders a visible chip', () => {
  test('the queue strip cannot be shrunk away by the composer', () => {
    const block = cssBlock('.msg-queue');
    // The scroll container is what makes the automatic minimum size 0, so the
    // explicit shrink guard is the only thing keeping the strip measurable.
    assert.ok(block.includes('overflow-y: auto'), 'expected the strip to stay scrollable: ' + block);
    assert.ok(
      /flex-shrink:\s*0/.test(block),
      '.msg-queue must be flex-shrink:0 — it is a scroll container inside a ' +
        'fixed-height column flex parent, so without this the flex algorithm ' +
        'crushes it to zero height and the chip renders invisibly: ' +
        block,
    );
  });

  test('the queue label is likewise not a shrink target', () => {
    assert.ok(
      /flex-shrink:\s*0/.test(cssBlock('.msg-queue-label')),
      '.msg-queue-label must not absorb the deficit either',
    );
  });

  test('renderQueue restores the stylesheet display value instead of block', () => {
    const fn = fnBody('renderQueue');
    assert.ok(
      fn.includes("msgQueueEl.style.display = 'flex'"),
      "renderQueue must set display 'flex': the stylesheet lays .msg-queue out " +
        'as a wrapping flex row with a gap, and an inline block overrode it: ' +
        fn.slice(0, 400),
    );
    assert.ok(
      !fn.includes("msgQueueEl.style.display = 'block'"),
      'renderQueue must not force display:block on the flex container',
    );
  });

  test('renderQueue reports the measured box, not just the intended style', () => {
    const fn = fnBody('renderQueue');
    assert.ok(
      fn.includes('reportQueueVisibility()'),
      'renderQueue must hand off to the visibility probe after appending chips',
    );
    const probe = fnBody('reportQueueVisibility');
    // offsetHeight is the whole point: every other signal (queue length, child
    // count, display) said the chip was fine while it was zero-height.
    assert.ok(probe.includes('offsetHeight'), 'the probe must measure used height: ' + probe);
    assert.ok(
      probe.includes('requestAnimationFrame'),
      'measure after layout has settled, not synchronously after appendChild',
    );
    assert.ok(probe.includes('VERDICT=CRUSHED'), 'the probe must name the zero-height failure so a repro is greppable');
  });

  test('the chip-visibility markers actually reach the log', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    const start = src.indexOf('const RESUME_DIAG_MARKERS');
    const end = src.indexOf('];', start);
    const markers = src.slice(start, end);
    // These were emitted all along and filtered out here, which is why every
    // earlier repro produced an empty log.
    for (const marker of ['[WV-PROBE]', '[DRAIN-DBG]', '[WV-QUEUEVIS]', '[WV-ERROR]']) {
      assert.ok(markers.includes(marker), 'RESUME_DIAG_MARKERS must forward ' + marker);
    }
  });

  test('uncaught webview errors are forwarded instead of swallowed', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    assert.ok(
      src.includes("window.addEventListener('error'"),
      'the webview must report uncaught errors — a throw inside a render ' +
        'function otherwise leaves a half-built DOM and no trace',
    );
    assert.ok(src.includes("window.addEventListener('unhandledrejection'"), 'rejected promises must be reported too');
    assert.ok(src.includes('[WV-ERROR]'), 'errors must carry the [WV-ERROR] marker');
  });
});

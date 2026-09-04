import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Switching model mid-turn looked ignored.
 *
 * It is not: codex re-reads the live model at the top of each tool-loop
 * iteration, and the proxy log proves the switch lands on the next call — request
 * 12419e83 ran Qwen at 03:51:59, the switch arrived 03:52:23, and 03:52:29 went to
 * DeepSeek. What cannot change is the call already streaming, because its model is
 * fixed in the POST body. The picker label flipping instantly is what makes that
 * gap read as "the agent ignored me", and with a long reasoning call in flight the
 * gap can be minutes.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

function extractFn(name: string): string {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' not found');
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(start, i + 1);
}

interface FakeEl {
  textContent: string;
  classList: { add: (c: string) => void; remove: (c: string) => void; has: (c: string) => boolean };
}

function runHint(): { el: FakeEl; call: (text: string, ms?: number) => void; fire: () => void } {
  const classes = new Set<string>();
  const el: FakeEl = {
    textContent: '',
    classList: {
      add: (c: string) => void classes.add(c),
      remove: (c: string) => void classes.delete(c),
      has: (c: string) => classes.has(c),
    },
  };
  let timer: (() => void) | null = null;
  const factory = new Function(
    'el',
    'setTimer',
    `
    var transientHintTimer = null;
    var document = { getElementById: function (id) { return id === 'transientHint' ? el : null; } };
    function clearTimeout() { }
    function setTimeout(fn, ms) { setTimer(fn, ms); return 1; }
    ${extractFn('showTransientHint')}
    return showTransientHint;
  `,
  );
  const call = factory(el, (fn: () => void) => {
    timer = fn;
  }) as (text: string, ms?: number) => void;
  return { el, call, fire: () => timer && timer() };
}

suite('mid-turn model switch hint', () => {
  test('shows the notice, then clears itself', () => {
    const h = runHint();
    h.call('Model switch applies from the next step');
    assert.strictEqual(h.el.textContent, 'Model switch applies from the next step');
    assert.ok(h.el.classList.has('visible'));
    h.fire();
    assert.strictEqual(h.el.textContent, '', 'must not linger');
    assert.ok(!h.el.classList.has('visible'));
  });

  test('is only shown while a turn is in flight, and only for the model picker', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    assert.ok(
      src.includes("if (isProcessing && (configId === 'model' || (opt && opt.category === 'model')))"),
      'the hint must be gated on an in-flight turn and a model change',
    );
    // Idle switches take effect on the next prompt anyway — no notice needed.
    const hint = src.indexOf("showTransientHint('Model switch applies");
    const post = src.indexOf("vscode.postMessage({ type: 'setConfigOption', configId, value });");
    assert.ok(hint > 0 && post > 0);
    assert.ok(post < hint, 'the request must be sent before the notice is shown');
    assert.ok(hint - post < 1200, 'and the two must live in the same handler');
  });

  test('does not hijack the status area or the chat history', () => {
    const fn = extractFn('showTransientHint');
    assert.ok(!fn.includes('statusEl'), 'statusEl carries the spinner and elapsed figure');
    assert.ok(!fn.includes('chatHistory'), 'a UI notice must never become conversation content');
    const src = fs.readFileSync(SOURCE, 'utf8');
    assert.ok(src.includes('id="transientHint"'), 'the anchor element must exist');
    assert.ok(src.includes('.transient-hint.visible'), 'and needs its style');
  });
});

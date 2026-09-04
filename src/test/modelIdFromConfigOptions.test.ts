import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Image-attach button missing after a resume.
 *
 * For Kiro CLI / Codex the attach button is decided from the MODEL NAME
 * (`kiroBase && /claude/i.test(kiroBase)`) because those agents publish no
 * per-model modalities. So `currentModelId` must be known — and after a resume
 * it was not:
 *
 *   [WV-DIAG] attachBtn: agent="Kiro CLI" model="null" image=true mis=true
 *
 * on a session whose session/load response said `"currentModelId":
 * "claude-opus-5"`. Two independent holes:
 *
 *   1. SessionManager emits 'active-session-changed' BEFORE the loadSession
 *      request, so the webview's `state` carried models:null, and
 *      notifyModelsUpdate is wired only to 'model-changed' — nothing told it
 *      afterwards. Fixed by emitting 'model-changed' once the response lands.
 *   2. The webview learned the model only through the legacy picker, which
 *      returns early when configOptions are in use — and for agents that publish
 *      configOptions INSTEAD of `models`, the model id lives there.
 *
 * This pins the pure helper for (2), extracted from the webview template
 * literal as in idleThoughtDrop.test.ts.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

function loadHelper(): (configOptions: unknown) => string {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const start = src.indexOf('function modelIdFromConfigOptions(configOptions) {');
  assert.ok(start >= 0, 'modelIdFromConfigOptions not found in ChatWebviewProvider.ts');
  const end = src.indexOf('\n/**', start);
  assert.ok(end > start, 'end marker after modelIdFromConfigOptions not found');
  return new Function(`${src.slice(start, end).trim()}\nreturn modelIdFromConfigOptions;`)() as any;
}

suite('model id from configOptions (image attach button after resume)', () => {
  const modelOf = loadHelper();

  test('reads the option whose category is model', () => {
    assert.strictEqual(
      modelOf([
        { id: 'mode', category: 'mode', currentValue: 'kiro_default' },
        { id: 'model', category: 'model', currentValue: 'claude-opus-5' },
        { id: 'reasoning_effort', category: 'effort', currentValue: 'high' },
      ]),
      'claude-opus-5',
    );
  });

  test('falls back to an option whose id is model', () => {
    assert.strictEqual(modelOf([{ id: 'model', currentValue: 'claude-opus-5' }]), 'claude-opus-5');
  });

  test('category matching is case-insensitive', () => {
    assert.strictEqual(modelOf([{ id: 'x', category: 'Model', currentValue: 'claude-4' }]), 'claude-4');
  });

  test('returns empty when there is no model option', () => {
    assert.strictEqual(modelOf([{ id: 'mode', category: 'mode', currentValue: 'kiro_default' }]), '');
    assert.strictEqual(modelOf([]), '');
  });

  test('returns empty for a model option with no usable value', () => {
    assert.strictEqual(modelOf([{ id: 'model', category: 'model' }]), '');
    assert.strictEqual(modelOf([{ id: 'model', category: 'model', currentValue: '' }]), '');
    assert.strictEqual(modelOf([{ id: 'model', category: 'model', currentValue: 42 }]), '');
  });

  test('trims the value', () => {
    assert.strictEqual(
      modelOf([{ id: 'model', category: 'model', currentValue: '  claude-opus-5  ' }]),
      'claude-opus-5',
    );
  });

  test('tolerates junk input', () => {
    assert.strictEqual(modelOf(null), '');
    assert.strictEqual(modelOf(undefined), '');
    assert.strictEqual(modelOf('nope'), '');
    assert.strictEqual(modelOf([null, undefined, 'x', 7]), '');
  });

  test('a text-only Kiro model is returned unchanged (caller decides support)', () => {
    // The helper reports identity only; /claude/i matching stays in
    // updateAttachButtonVisibility so the hide decision is unaffected.
    assert.strictEqual(
      modelOf([{ id: 'model', category: 'model', currentValue: 'minimax-m2' }]),
      'minimax-m2',
    );
  });
});

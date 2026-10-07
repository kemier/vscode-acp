import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * acp.modelImageSupport overrides for the image attach button.
 *
 * claude-code-acp advertises promptCapabilities.image: true for EVERY model,
 * so a text-only local model (qwen3.8-flash-next served by Strata) showed the
 * 📎 attach button and pasted images went nowhere. The fix is a settings
 * override map ({ slug: boolean }) that beats the catalog and the agent-level
 * default on both the host (modelSupportsImage) and the webview (updateAttach
 * ButtonVisibility + the model-switch handler). This pins the pure webview
 * helper, extracted from the template literal as in modelIdFromConfigOptions.
 * test.ts — including the family-prefix rule: the picker shows the full
 * variant slug (qwen3.8-flash-next-coder-iq1_m), the setting key is the
 * family (qwen3.8-flash-next).
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

function loadHelper(): (slug: unknown, overrides: unknown) => any {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const start = src.indexOf('function imageOverrideFor(slug, overrides) {');
  assert.ok(start >= 0, 'imageOverrideFor not found in ChatWebviewProvider.ts');
  const end = src.indexOf('\n/**', start);
  assert.ok(end > start, 'end marker after imageOverrideFor not found');
  return new Function(`${src.slice(start, end).trim()}\nreturn imageOverrideFor;`)() as any;
}

suite('image override lookup (acp.modelImageSupport)', () => {
  const ov = loadHelper();

  test('exact slug match wins', () => {
    assert.strictEqual(ov('qwen3.8-flash-next', { 'qwen3.8-flash-next': false }), false);
    assert.strictEqual(ov('glm-5.2', { 'glm-5.2': true }), true);
  });

  test('family prefix covers variant slugs', () => {
    // The picker shows the full variant id; the setting key is the family.
    assert.strictEqual(
      ov('qwen3.8-flash-next-coder-iq1_m', { 'qwen3.8-flash-next': false }),
      false,
    );
  });

  test('prefix requires a separator — a key is not a bare substring', () => {
    // 'gpt' must not match 'gpt4o'-style slugs without the '-' boundary.
    assert.strictEqual(ov('gpt4o', { gpt: false }), null);
    assert.strictEqual(ov('gpt-4o', { gpt: false }), false);
  });

  test('trailing [...] suffixes are stripped before matching', () => {
    assert.strictEqual(ov('qwen3.8-flash-next[high]', { 'qwen3.8-flash-next': false }), false);
  });

  test('matching is case-insensitive', () => {
    assert.strictEqual(ov('Qwen3.8-Flash-Next', { 'qwen3.8-flash-next': false }), false);
  });

  test('no override → null (caller falls through to catalog rules)', () => {
    assert.strictEqual(ov('claude-opus-5', { 'qwen3.8-flash-next': false }), null);
    assert.strictEqual(ov('claude-opus-5', {}), null);
    assert.strictEqual(ov('claude-opus-5', null), null);
    assert.strictEqual(ov('claude-opus-5', undefined), null);
  });

  test('empty slug → null', () => {
    assert.strictEqual(ov('', { 'qwen3.8-flash-next': false }), null);
    assert.strictEqual(ov('[]', { 'qwen3.8-flash-next': false }), null);
  });

  test('junk overrides are tolerated', () => {
    assert.strictEqual(ov('x', 'nope'), null);
    assert.strictEqual(ov('x', 7), null);
  });
});

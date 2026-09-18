import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Agents may encode capability parameters inside a config option's VALUE rather
 * than its name. Cursor does exactly that: session/new advertises 38 models as
 *
 *   claude-opus-4-7[thinking=true,context=300k,effort=xhigh,fast=false]
 *
 * while the display name is the bare "claude-opus-4-7". The picker therefore
 * showed 38 entries that looked interchangeable, hiding the reasoning-effort
 * distinction entirely.
 *
 * These values were captured from the real cursor-agent binary (2026.09.15),
 * not written from the docs — the published ACP doc does not mention models at
 * all. set_model was also verified to reject any string other than an advertised
 * one, so the summary must never be treated as editable.
 *
 * The functions under test are extracted from the webview template literal so
 * they cannot drift from what ships.
 */
suite('config picker: parameters encoded in the option value', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts'), 'utf8');

  /** Brace-matched from the signature, so extraction survives reformatting. */
  function extract(signature: string): string {
    const start = src.indexOf(signature);
    assert.ok(start >= 0, `${signature} not found in ChatWebviewProvider.ts`);
    let depth = 0;
    for (let i = start; i < src.length; i++) {
      if (src[i] === '{') {
        depth++;
      } else if (src[i] === '}' && --depth === 0) {
        return src.slice(start, i + 1);
      }
    }
    throw new Error(`unbalanced braces while extracting ${signature}`);
  }

  const fnSrc = extract('function optionValueParams(value) {') + '\n' + extract('function optionParamSummary(value) {');
  const summary = new Function(`${fnSrc}; return optionParamSummary;`)() as (v: unknown) => string;
  const params = new Function(`${fnSrc}; return optionValueParams;`)() as (
    v: unknown,
  ) => { key: string; val: string }[] | null;

  test('the reasoning-effort family is surfaced', () => {
    assert.strictEqual(
      summary('claude-opus-4-7[thinking=true,context=300k,effort=xhigh,fast=false]'),
      'thinking · 300k · xhigh',
    );
    assert.strictEqual(summary('claude-sonnet-4-6[thinking=true,context=200k,effort=medium]'), 'thinking · 200k · medium');
    assert.strictEqual(summary('gpt-5.6-sol[context=272k,reasoning=medium,fast=false]'), '272k · medium');
    assert.strictEqual(summary('gemini-3.8-flash[reasoning_effort=high]'), 'high');
    assert.strictEqual(summary('kimi-k3[reasoning=max]'), 'max');
    assert.strictEqual(summary('glm-5.2[reasoning=high]'), 'high');
  });

  test('thinking=false reads as "no thinking", not as a missing value', () => {
    // claude-sonnet-4 is the real case. Dropping the parameter would make it
    // indistinguishable from a model that simply does not report thinking.
    assert.strictEqual(summary('claude-sonnet-4[thinking=false,context=200k]'), 'no thinking · 200k');
  });

  test('fast is omitted as noise', () => {
    assert.strictEqual(summary('grok-4.6[effort=high,fast=true]'), 'high');
    assert.strictEqual(summary('composer-2.5[fast=true]'), '');
  });

  test('values with no parameters produce no hint', () => {
    for (const v of ['default[]', 'gemini-3.1-pro[]', 'gemini-3-flash[]', 'kimi-k2.7-code[]', 'gpt-5-mini[]']) {
      assert.strictEqual(summary(v), '', `${v} should yield no hint`);
    }
  });

  test('plain values from other agents are untouched', () => {
    // kiro modes, codex efforts, cursor modes — none use the bracket shape.
    for (const v of ['agent', 'plan', 'ask', 'kiro_default', 'kiro_planner', 'high', 'gpt-5-codex']) {
      assert.strictEqual(summary(v), '', `${v} must not be reinterpreted`);
    }
  });

  test('malformed brackets do not throw or half-parse', () => {
    assert.strictEqual(params('[effort=high]'), null, 'a leading bracket is not the name[...] shape');
    assert.strictEqual(params('model[effort=high'), null, 'unterminated bracket');
    assert.strictEqual(params('model[   ]'), null, 'whitespace-only body');
    assert.strictEqual(params('model[effort]'), null, 'no = means no pair');
    assert.strictEqual(params(undefined), null);
    assert.strictEqual(params(42), null);
    assert.strictEqual(summary('model[effort]'), '');
  });

  test('every model the live binary advertised is handled without throwing', () => {
    const live = [
      'default[]',
      'grok-4.6[effort=high,fast=true]',
      'composer-2.5[fast=true]',
      'claude-opus-5[thinking=true,context=300k,effort=high,fast=false]',
      'claude-opus-4-8[thinking=true,context=300k,effort=high,fast=false]',
      'gpt-5.6-sol[context=272k,reasoning=medium,fast=false]',
      'gpt-5.5[context=272k,reasoning=medium,fast=false]',
      'claude-fable-5-1[thinking=true,context=300k,effort=high]',
      'claude-fable-5[thinking=true,context=300k,effort=high]',
      'grok-4.5[effort=high,fast=true]',
      'gemini-3.8-flash[reasoning_effort=high]',
      'gemini-3.7-flash[effort=high]',
      'muse-spark-1.3[context=300k,effort=high]',
      'gpt-5.6-terra[context=272k,reasoning=medium,fast=false]',
      'claude-sonnet-5[thinking=true,context=300k,effort=high]',
      'claude-sonnet-4-6[thinking=true,context=200k,effort=medium]',
      'gpt-5.3-codex[reasoning=medium,fast=false]',
      'claude-opus-4-7[thinking=true,context=300k,effort=xhigh,fast=false]',
      'gpt-5.4[context=272k,reasoning=medium,fast=false]',
      'claude-opus-4-6[thinking=true,context=200k,effort=high]',
      'claude-opus-4-5[thinking=true]',
      'gpt-5.2[reasoning=medium,fast=false]',
      'gpt-5.6-luna[context=272k,reasoning=medium,fast=false]',
      'gemini-3.6-flash[effort=high]',
      'gemini-3.1-pro[]',
      'gpt-5.4-mini[reasoning=medium]',
      'gpt-5.4-nano[reasoning=medium]',
      'claude-haiku-4-5[thinking=true]',
      'claude-sonnet-4-5[thinking=true,context=200k]',
      'gpt-5.1[reasoning=medium]',
      'gemini-3-flash[]',
      'gemini-3.5-flash[]',
      'claude-sonnet-4[thinking=false,context=200k]',
      'gpt-5-mini[]',
      'gemini-2.5-flash[]',
      'kimi-k3[reasoning=max]',
      'kimi-k2.7-code[]',
      'glm-5.2[reasoning=high]',
    ];
    assert.strictEqual(live.length, 38, 'the captured list should be the 38 the binary reported');
    let described = 0;
    for (const v of live) {
      const out = summary(v);
      assert.strictEqual(typeof out, 'string', `${v} must yield a string`);
      if (out) {
        described++;
      }
    }
    // Exactly eight carry no usable parameters, enumerated rather than counted
    // because my first guess at the number was wrong (I said seven, having
    // missed that four gemini entries are bare, not three):
    //   default[], composer-2.5[fast=true], gemini-3.1-pro[], gemini-3-flash[],
    //   gemini-3.5-flash[], gemini-2.5-flash[], gpt-5-mini[], kimi-k2.7-code[]
    // The other 30 must gain a hint, otherwise the feature is not doing its job
    // on the data that motivated it.
    assert.strictEqual(described, 30, 'expected 30 of 38 models to gain a hint');
    const bare = live.filter((v) => !summary(v));
    assert.deepStrictEqual(bare, [
      'default[]',
      'composer-2.5[fast=true]',
      'gemini-3.1-pro[]',
      'gemini-3-flash[]',
      'gemini-3.5-flash[]',
      'gpt-5-mini[]',
      'gemini-2.5-flash[]',
      'kimi-k2.7-code[]',
    ]);
  });

  test('the summary is display-only — it never rewrites the value it is sent', () => {
    // set_model rejects anything but the advertised string, so a well-meaning
    // normalisation here would break model switching outright.
    const item = extract('function buildConfigItem(opt, v) {');
    assert.ok(item.includes('item.dataset.value = v.value;'), 'the raw value must be what is sent back');
    assert.ok(
      !/dataset\.value\s*=\s*[^;]*optionParamSummary/.test(item),
      'the summary must never feed the value sent to the agent',
    );
  });
});

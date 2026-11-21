import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Cursor ACP only exposes fast / thought_level / Max as separate configOptions
 * when the client advertises `_meta.parameterizedModelPicker` during initialize.
 * Without it Cursor falls back to one default variant per model.
 *
 * ACP SDK types ClientCapabilities with optional `_meta: { [key: string]: unknown }`,
 * so this is a supported extensibility hook — not a fork of the schema.
 */

const SOURCE = path.resolve(__dirname, '../../src/core/ConnectionManager.ts');

suite('parameterizedModelPicker initialize capability', () => {
  test('advertises parameterizedModelPicker in clientCapabilities._meta', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    assert.ok(src.includes('connection.initialize({'), 'initialize call missing');
    assert.ok(
      src.includes('parameterizedModelPicker: true'),
      'must advertise parameterizedModelPicker so Cursor returns variant pickers',
    );
    assert.ok(src.includes('_meta:'), 'ClientCapabilities._meta missing');
    // Must not reintroduce full terminal snapshot mode under the same _meta. Checked
    // against the code with comments removed: the source explains, in a comment,
    // why `_meta.terminal_output: true` must never be set — and that sentence is
    // exactly what the pattern matches.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(
      !/terminal_output\s*:\s*true/.test(code),
      'must not set _meta.terminal_output: true (O(N²) terminal snapshots)',
    );
  });
});

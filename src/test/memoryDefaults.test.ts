import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { readMemorySettings } from '../core/memory/MemoryConfig';

/**
 * Unset memory settings resolve to neutral values, and the manifest says the same
 * thing as the code.
 *
 * They used to disagree: package.json declared a LAN address as the endpoint default
 * (what VS Code hands back when the key is unset) while MemoryConfig fell back to
 * loopback, and the user id defaulted to one person's handle. A shipped default must
 * work for anyone: loopback for the gateway, "default" for the profile.
 */
suite('memory settings defaults', () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
  const props = manifest.contributes.configuration.properties;

  test('unset settings resolve to loopback and the "default" profile', () => {
    // The unit-test vscode shim returns undefined for these keys, i.e. "not set".
    const settings = readMemorySettings();
    assert.strictEqual(settings.endpoint, 'http://127.0.0.1:8420');
    assert.strictEqual(settings.userId, 'default');
  });

  test('the manifest defaults match the code defaults', () => {
    assert.strictEqual(props['acp.memory.endpoint'].default, readMemorySettings().endpoint);
    assert.strictEqual(props['acp.memory.userId'].default, readMemorySettings().userId);
  });

  test('no shipped default points at a private network address', () => {
    const privateNet = /\b(10|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}/;
    for (const [key, prop] of Object.entries<{ default?: unknown }>(props)) {
      assert.ok(!privateNet.test(JSON.stringify(prop.default ?? '')), `${key} default`);
    }
  });
});

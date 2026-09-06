import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseRecordCommand,
  resolveRecorderCommand,
  resolveBinaryPath,
} from '../voice/AudioRecorder';

suite('AudioRecorder command resolution', () => {
  test('parseRecordCommand splits template and keeps {file} placeholder', () => {
    const cmd = parseRecordCommand('rec -q -c 1 {file} rate 16000');
    assert.strictEqual(cmd.command, 'rec');
    assert.deepStrictEqual(cmd.args, ['-q', '-c', '1', '{file}', 'rate', '16000']);
  });

  test('parseRecordCommand throws without {file} placeholder', () => {
    assert.throws(() => parseRecordCommand('rec -q -c 1'), /\{file\}/);
  });

  test('parseRecordCommand throws on empty template', () => {
    assert.throws(() => parseRecordCommand('   '), /empty/);
  });

  test('resolveRecorderCommand prefers the configured template', () => {
    const cmd = resolveRecorderCommand('ffmpeg -y -i default {file}');
    assert.strictEqual(cmd.command, 'ffmpeg');
  });

  test('resolveRecorderCommand falls back to the platform default', () => {
    const cmd = resolveRecorderCommand('');
    assert.ok(['rec', 'arecord'].includes(cmd.command), `unexpected default ${cmd.command}`);
    assert.ok(cmd.args.includes('{file}'));
  });

  test('resolveBinaryPath resolves a PATH binary to an absolute path', async () => {
    const resolved = await resolveBinaryPath('ls');
    assert.ok(path.isAbsolute(resolved), `expected absolute path, got ${resolved}`);
    assert.ok(fs.existsSync(resolved));
  });

  test('resolveBinaryPath accepts an existing absolute path', async () => {
    const resolved = await resolveBinaryPath('/bin/ls');
    assert.strictEqual(resolved, '/bin/ls');
  });

  test('resolveBinaryPath throws for a missing absolute path', async () => {
    await assert.rejects(
      () => resolveBinaryPath(path.join(os.tmpdir(), 'definitely-not-a-recorder-binary')),
      /not found at/,
    );
  });

  test('resolveBinaryPath throws with install hint for an unknown binary', async () => {
    await assert.rejects(
      () => resolveBinaryPath('definitely-not-a-real-binary-xyz'),
      /not found on PATH/,
    );
  });
});

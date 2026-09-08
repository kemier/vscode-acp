import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseRecordCommand,
  resolveRecorderCommand,
  resolveBinaryPath,
  buildRecorderArgs,
  repairWavHeader,
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

  test('buildRecorderArgs replaces {file} with the output path', () => {
    const args = buildRecorderArgs(
      { command: 'rec', args: ['-q', '-c', '1', '{file}', 'rate', '16000'] },
      '/tmp/take.wav',
      0,
    );
    assert.deepStrictEqual(args, ['-q', '-c', '1', '/tmp/take.wav', 'rate', '16000']);
  });

  test('buildRecorderArgs appends SoX silence effect when auto-stop is on', () => {
    const args = buildRecorderArgs(
      { command: 'rec', args: ['-q', '{file}'] },
      '/tmp/take.wav',
      2.5,
    );
    // Leading gate is 0.1s: a longer gate ate soft speech onsets (BT headset).
    assert.deepStrictEqual(args, ['-q', '/tmp/take.wav', 'silence', '1', '0.1', '3%', '1', '2.5', '3%']);
  });

  test('buildRecorderArgs honors a custom silence threshold', () => {
    const args = buildRecorderArgs(
      { command: 'rec', args: ['{file}'] },
      '/tmp/take.wav',
      3.5,
      2,
    );
    assert.deepStrictEqual(args, ['/tmp/take.wav', 'silence', '1', '0.1', '2%', '1', '3.5', '2%']);
  });

  test('buildRecorderArgs omits silence effect for non-SoX recorders', () => {
    const args = buildRecorderArgs(
      { command: 'ffmpeg', args: ['-y', '{file}'] },
      '/tmp/take.wav',
      2.5,
    );
    assert.deepStrictEqual(args, ['-y', '/tmp/take.wav']);
  });

  test('buildRecorderArgs resolves rec via an absolute path and still detects SoX', () => {
    const args = buildRecorderArgs(
      { command: '/opt/homebrew/bin/rec', args: ['{file}'] },
      '/tmp/take.wav',
      2,
    );
    assert.ok(args.includes('silence'), 'expected silence effect for absolute-path rec');
  });
});

/** Build a WAV buffer with controllable RIFF/data size fields. */
function makeWav(riffSize: number, dataSize: number, pcmBytes: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(riffSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(16000, 24); // sample rate
  header.writeUInt32LE(32000, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, Buffer.alloc(pcmBytes)]);
}

suite('repairWavHeader (Windows hard-kill recovery)', () => {
  test('patches placeholder sizes left by a killed recorder', () => {
    const f = path.join(os.tmpdir(), `wav-repair-${Date.now()}.wav`);
    // SoX killed mid-write: sizes left at 0, 1000 bytes of PCM present.
    fs.writeFileSync(f, makeWav(0, 0, 1000));
    assert.strictEqual(repairWavHeader(f), true);
    const buf = fs.readFileSync(f);
    assert.strictEqual(buf.readUInt32LE(4), buf.length - 8);
    assert.strictEqual(buf.readUInt32LE(40), 1000);
    fs.unlinkSync(f);
  });

  test('truncates an odd trailing byte (mid-sample kill) for 16-bit PCM', () => {
    const f = path.join(os.tmpdir(), `wav-repair-${Date.now()}.wav`);
    fs.writeFileSync(f, makeWav(0, 0, 1001));
    assert.strictEqual(repairWavHeader(f), true);
    const buf = fs.readFileSync(f);
    assert.strictEqual(buf.readUInt32LE(40), 1000);
    assert.strictEqual(buf.length, 1044);
    fs.unlinkSync(f);
  });

  test('no-op for an already-finalized WAV', () => {
    const f = path.join(os.tmpdir(), `wav-repair-${Date.now()}.wav`);
    fs.writeFileSync(f, makeWav(1036, 1000, 1000));
    assert.strictEqual(repairWavHeader(f), true);
    const buf = fs.readFileSync(f);
    assert.strictEqual(buf.readUInt32LE(4), 1036);
    assert.strictEqual(buf.readUInt32LE(40), 1000);
    fs.unlinkSync(f);
  });

  test('rejects non-WAVE garbage', () => {
    const f = path.join(os.tmpdir(), `wav-repair-${Date.now()}.wav`);
    fs.writeFileSync(f, Buffer.from('not a wav file at all, just text'));
    assert.strictEqual(repairWavHeader(f), false);
    fs.unlinkSync(f);
  });
});

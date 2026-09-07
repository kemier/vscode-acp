import * as assert from 'assert';
import { MIN_TAKE_SEC, SILENCE_PEAK_THRESHOLD, describeWav, judgeTake, parseWav } from '../voice/WavInfo';

/**
 * These checks exist because a silent Bluetooth take and a failing STT model
 * produced the same user-visible message ("empty transcript"), which sent
 * debugging in the wrong direction. The level analysis is what separates them,
 * so its numbers must be right.
 */

function makeWav(
  samples: number[],
  opts: { sampleRate?: number; channels?: number; bits?: number; extraChunk?: boolean } = {},
): Buffer {
  const sampleRate = opts.sampleRate ?? 16000;
  const channels = opts.channels ?? 1;
  const bits = opts.bits ?? 16;
  const bytesPerSample = bits / 8;
  const data = Buffer.alloc(samples.length * bytesPerSample);
  samples.forEach((v, i) => {
    if (bits === 16) {
      data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2);
    } else {
      data.writeUInt8(Math.max(0, Math.min(255, Math.round(v * 127 + 128))), i);
    }
  });

  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'ascii');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8); // PCM
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * channels * bytesPerSample, 16);
  fmt.writeUInt16LE(channels * bytesPerSample, 20);
  fmt.writeUInt16LE(bits, 22);

  // Some recorders insert extra chunks (LIST/fact) before `data`; the parser
  // must walk the table instead of assuming a 44-byte header.
  const extra = Buffer.alloc(opts.extraChunk ? 12 : 0);
  if (opts.extraChunk) {
    extra.write('LIST', 0, 'ascii');
    extra.writeUInt32LE(4, 4);
    extra.write('INFO', 8, 'ascii');
  }

  const dataHeader = Buffer.alloc(8);
  dataHeader.write('data', 0, 'ascii');
  dataHeader.writeUInt32LE(data.length, 4);

  const body = Buffer.concat([fmt, extra, dataHeader, data]);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(4 + body.length, 4);
  riff.write('WAVE', 8, 'ascii');
  return Buffer.concat([riff, body]);
}

const tone = (n: number, amp: number) =>
  Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * 440 * i) / 16000));

suite('WavInfo (take diagnostics)', () => {
  test('reads format and duration', () => {
    const info = parseWav(makeWav(tone(16000, 0.5)));
    assert.strictEqual(info.sampleRate, 16000);
    assert.strictEqual(info.channels, 1);
    assert.strictEqual(info.bitsPerSample, 16);
    assert.strictEqual(Math.round(info.durationSec), 1);
  });

  test('walks past extra chunks before data', () => {
    const info = parseWav(makeWav(tone(8000, 0.5), { extraChunk: true }));
    assert.strictEqual(Math.round(info.durationSec * 10) / 10, 0.5);
    assert.ok(info.peak > 0.4, `peak was ${info.peak}`);
  });

  test('measures peak and rms of a tone', () => {
    const info = parseWav(makeWav(tone(16000, 0.5)));
    assert.ok(Math.abs(info.peak - 0.5) < 0.02, `peak ${info.peak}`);
    // RMS of a sine is amplitude / sqrt(2).
    assert.ok(Math.abs(info.rms - 0.5 / Math.SQRT2) < 0.02, `rms ${info.rms}`);
  });

  test('digital silence reads as zero level', () => {
    const info = parseWav(makeWav(new Array(16000).fill(0)));
    assert.strictEqual(info.peak, 0);
    assert.strictEqual(info.rms, 0);
  });

  test('handles 8-bit unsigned PCM (MCI may fall back to it)', () => {
    const info = parseWav(makeWav(tone(8000, 0.5), { bits: 8 }));
    assert.strictEqual(info.bitsPerSample, 8);
    assert.ok(info.peak > 0.4, `peak ${info.peak}`);
  });

  test('rejects non-WAV input', () => {
    assert.throws(() => parseWav(Buffer.alloc(64, 3)), /not a RIFF/);
  });

  test('judgeTake: a short click is reported as too short, not as silence', () => {
    const info = parseWav(makeWav(tone(Math.floor(16000 * (MIN_TAKE_SEC / 2)), 0.5)));
    const verdict = judgeTake(info, true);
    assert.strictEqual(verdict.ok, false);
    assert.ok(!verdict.ok && verdict.reason === 'tooShort');
    assert.ok(!verdict.ok && /too short/i.test(verdict.message));
  });

  test('judgeTake: a silent Bluetooth take names the profile switch', () => {
    const info = parseWav(makeWav(tone(32000, SILENCE_PEAK_THRESHOLD / 4)));
    const verdict = judgeTake(info, true);
    assert.ok(!verdict.ok && verdict.reason === 'silent');
    assert.ok(!verdict.ok && /AirPods/.test(verdict.message), verdict.ok ? '' : verdict.message);
    // Same take without the companion: no Bluetooth advice, still a device error.
    const local = judgeTake(info, false);
    assert.ok(!local.ok && !/AirPods/.test(local.message));
  });

  test('judgeTake: a normal take passes', () => {
    const info = parseWav(makeWav(tone(32000, 0.4)));
    assert.strictEqual(judgeTake(info, true).ok, true);
  });

  test('describeWav summarises the take for logs and errors', () => {
    const info = parseWav(makeWav(tone(32000, 0.5)));
    const s = describeWav(info);
    assert.ok(/^2\.00s, 16000Hz mono 16-bit, peak \d+%, rms \d+%$/.test(s), s);
  });
});

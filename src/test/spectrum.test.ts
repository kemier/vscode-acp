import * as assert from 'assert';
import { analyzeSpectrum, describeSpectrum, pcmToFloat } from '../voice/Spectrum';
import { parseWav } from '../voice/WavInfo';

/**
 * The spectrum is the evidence that separates "microphone was quiet" from "the
 * device delivered a different sample rate than the WAV header claims" — the
 * latter shifts every formant up an octave and makes Whisper return an empty
 * transcript on audio that otherwise looks perfectly healthy.
 */

function tone(hz: number, secs: number, rate = 16000, amp = 0.5): Float64Array {
  const out = new Float64Array(Math.floor(rate * secs));
  for (let i = 0; i < out.length; i++) {
    out[i] = amp * Math.sin((2 * Math.PI * hz * i) / rate);
  }
  return out;
}

suite('Spectrum (take diagnostics)', () => {
  test('centroid tracks a pure tone', () => {
    const low = analyzeSpectrum(tone(440, 2), 16000);
    assert.ok(Math.abs(low.centroidHz - 440) < 80, `centroid ${low.centroidHz}`);
    const high = analyzeSpectrum(tone(5000, 2), 16000);
    assert.ok(Math.abs(high.centroidHz - 5000) < 150, `centroid ${high.centroidHz}`);
  });

  test('band ratios place energy in the right band', () => {
    const speechLike = analyzeSpectrum(tone(500, 2), 16000);
    assert.ok(speechLike.lowRatio > 0.8, `low ${speechLike.lowRatio}`);
    assert.ok(speechLike.highRatio < 0.1, `high ${speechLike.highRatio}`);

    // A take whose real rate was half the declared one shifts an octave up:
    // 500 Hz speech content read as 16 kHz lands at 1 kHz+ with 4 kHz+ energy.
    const shifted = analyzeSpectrum(tone(6000, 2), 16000);
    assert.ok(shifted.highRatio > 0.8, `high ${shifted.highRatio}`);
  });

  test('silence yields no analysed frames rather than a bogus centroid', () => {
    const s = analyzeSpectrum(new Float64Array(16000), 16000);
    assert.strictEqual(s.framesAnalysed, 0);
    assert.strictEqual(s.centroidHz, 0);
  });

  test('quiet frames between words are skipped, loud ones counted', () => {
    const buf = new Float64Array(16000 * 2);
    // Second half only: speech after a pause.
    const t = tone(600, 1);
    buf.set(t, 16000);
    const s = analyzeSpectrum(buf, 16000);
    assert.ok(s.framesAnalysed > 0 && s.framesAnalysed <= 16, `frames ${s.framesAnalysed}`);
    assert.ok(Math.abs(s.centroidHz - 600) < 100, `centroid ${s.centroidHz}`);
  });

  test('pcmToFloat decodes 16-bit mono from a real WAV layout', () => {
    // Build a WAV with a known first sample, then read it back.
    const data = Buffer.alloc(4);
    data.writeInt16LE(16384, 0); // 0.5
    data.writeInt16LE(-16384, 2); // -0.5
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16000, 24);
    header.writeUInt32LE(32000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(data.length, 40);
    const wav = Buffer.concat([header, data]);

    const info = parseWav(wav);
    const f = pcmToFloat(wav, info.dataOffset, info.dataBytes, info.bitsPerSample, info.channels);
    assert.strictEqual(f.length, 2);
    assert.ok(Math.abs(f[0] - 0.5) < 0.001, `${f[0]}`);
    assert.ok(Math.abs(f[1] + 0.5) < 0.001, `${f[1]}`);
  });

  test('describeSpectrum is compact enough for a log line', () => {
    const s = describeSpectrum(analyzeSpectrum(tone(700, 1), 16000));
    assert.ok(/^centroid \d+Hz, bands \d+\/\d+\/\d+% \(low\/mid\/high\)$/.test(s), s);
  });
});

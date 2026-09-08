import * as assert from 'assert';
import { buildSilentWav } from '../voice/SttClient';
import { parseWav } from '../voice/WavInfo';

/**
 * The warm-up clip exists because the STT backend loads its model on demand
 * (measured ~45-60 s cold, 0.1-0.3 s warm), which was timing out the first take
 * after a pause. It must be a *valid* WAV — a malformed one would be rejected
 * before the model is touched, and the warm-up would silently do nothing.
 */
suite('STT warm-up clip', () => {
  test('is a valid 16 kHz mono 16-bit WAV of the requested length', () => {
    const info = parseWav(buildSilentWav(120));
    assert.strictEqual(info.sampleRate, 16000);
    assert.strictEqual(info.channels, 1);
    assert.strictEqual(info.bitsPerSample, 16);
    assert.ok(Math.abs(info.durationSec - 0.12) < 0.005, `duration ${info.durationSec}`);
  });

  test('carries digital silence, so nothing is ever transcribed from it', () => {
    const info = parseWav(buildSilentWav(50));
    assert.strictEqual(info.peak, 0);
    assert.strictEqual(info.rms, 0);
  });

  test('stays tiny — it is sent on every take start', () => {
    assert.ok(buildSilentWav(120).length < 5000, 'warm-up clip must stay a few KB');
  });
});

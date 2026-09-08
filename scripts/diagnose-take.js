#!/usr/bin/env node
/**
 * Diagnose a dictation take end to end.
 *
 * When a transcript comes back as unrelated words, the cause is one of:
 *   1. level/clipping        → peak/rms
 *   2. band-limited mic      → band ratios (Bluetooth HFP narrowband has ~0%
 *                              energy above 4 kHz; wideband mSBC has some)
 *   3. sample-rate mismatch  → the header claims 16 kHz but the device
 *                              delivered 8 kHz, so speech plays at 2x and the
 *                              model hallucinates. Detected by re-transcribing
 *                              the same samples declared at 8 kHz / 32 kHz.
 *   4. language decode       → `en` on Chinese speech TRANSLATES instead of
 *                              transcribing; `auto` can misdetect on short
 *                              clips (measured: zh speech detected as en,
 *                              p=0.69).
 *
 * Usage: node scripts/diagnose-take.js <take.wav> [sttUrl]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const { parseWav, describeWav } = require(path.join(repoRoot, 'out/voice/WavInfo.js'));
const { analyzeSpectrum, describeSpectrum, pcmToFloat } = require(
  path.join(repoRoot, 'out/voice/Spectrum.js'),
);

const file = process.argv[2];
const sttUrl = process.argv[3] || 'http://127.0.0.1:8318/v1/audio/transcriptions';
if (!file) {
  console.error('usage: node scripts/diagnose-take.js <take.wav> [sttUrl]');
  process.exit(2);
}

/** Rewrite only the sample-rate fields, so the same samples play at another speed. */
function withSampleRate(buf, rate) {
  const out = Buffer.from(buf);
  const info = parseWav(out);
  // fmt chunk: sampleRate at +4, byteRate at +8 from the chunk body.
  let off = 12;
  while (off + 8 <= out.length) {
    const id = out.toString('ascii', off, off + 4);
    const size = out.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      out.writeUInt32LE(rate, off + 8 + 4);
      out.writeUInt32LE(rate * info.channels * (info.bitsPerSample / 8), off + 8 + 8);
      break;
    }
    off += 8 + size + (size % 2);
  }
  return out;
}

async function transcribe(buf, name, fields) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buf)], { type: 'audio/wav' }), name);
  form.append('response_format', 'json');
  for (const [k, v] of Object.entries(fields)) {
    form.append(k, v);
  }
  const t0 = Date.now();
  try {
    const res = await fetch(sttUrl, { method: 'POST', body: form });
    const json = await res.json().catch(() => ({}));
    return { ms: Date.now() - t0, text: (json.text || JSON.stringify(json)).trim() };
  } catch (err) {
    return { ms: Date.now() - t0, text: `ERROR: ${err.message}` };
  }
}

(async () => {
  const buf = fs.readFileSync(file);
  const info = parseWav(buf);
  const spectrum = analyzeSpectrum(
    pcmToFloat(buf, info.dataOffset, info.dataBytes, info.bitsPerSample, info.channels),
    info.sampleRate,
  );

  console.log(`file:     ${file}`);
  console.log(`audio:    ${describeWav(info)}`);
  console.log(`spectrum: ${describeSpectrum(spectrum)}`);
  const sidecar = `${file}.txt`;
  if (fs.existsSync(sidecar)) {
    console.log(`shipped transcript: ${JSON.stringify(fs.readFileSync(sidecar, 'utf8').trim())}`);
  }
  console.log('');

  const cases = [
    ['as-is, language=auto', buf, { language: 'auto' }],
    ['as-is, language=zh', buf, { language: 'zh' }],
    ['as-is, language=en', buf, { language: 'en' }],
    // Rate-mismatch probes: if one of these is suddenly intelligible, the
    // recorder declared the wrong sample rate.
    ['declared 8 kHz (2x slower), auto', withSampleRate(buf, 8000), { language: 'auto' }],
    ['declared 32 kHz (2x faster), auto', withSampleRate(buf, 32000), { language: 'auto' }],
  ];

  for (const [label, data, fields] of cases) {
    const r = await transcribe(data, path.basename(file), fields);
    console.log(`${label.padEnd(34)} ${r.ms.toString().padStart(6)}ms  ${JSON.stringify(r.text)}`);
  }
})();

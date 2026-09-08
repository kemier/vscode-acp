/**
 * Lightweight spectral summary of a take.
 *
 * Purpose: separate two failure modes that both end in "STT returned an empty
 * transcript" on audio that *looks* fine:
 *
 *  - **too quiet** — level is low but the spectrum is normal speech
 *    (energy concentrated below ~1 kHz, little above 4 kHz);
 *  - **sample-rate mismatch** — the header says 16 kHz but the device actually
 *    delivered 8 kHz (Bluetooth HFP/CVSD). Playback is then 2× too fast, every
 *    formant is shifted an octave up, and Whisper hears gibberish. The
 *    signature is an abnormally high spectral centroid with real energy in the
 *    4–8 kHz band, which narrowband telephony audio cannot contain.
 *
 * Implemented with a small radix-2 FFT over Hann-windowed frames — no
 * dependencies, a few ms for a 10 s take.
 */

export interface SpectrumInfo {
  /** Energy-weighted mean frequency in Hz. Conversational speech: 300–1500 Hz. */
  centroidHz: number;
  /** Share of energy below 1 kHz (0…1). */
  lowRatio: number;
  /** Share of energy in 1–4 kHz (0…1). */
  midRatio: number;
  /** Share of energy above 4 kHz (0…1). Near zero for HFP narrowband audio. */
  highRatio: number;
  framesAnalysed: number;
}

const FFT_SIZE = 1024;

/** In-place iterative radix-2 FFT (re/im arrays of length n = 2^k). */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/**
 * Average magnitude spectrum over up to `maxFrames` frames spread across the
 * whole take, then reduce it to a centroid plus band ratios. Frames whose
 * energy is negligible are skipped so silence between words does not dominate.
 */
export function analyzeSpectrum(samples: Float64Array, sampleRate: number, maxFrames = 48): SpectrumInfo {
  const bins = FFT_SIZE / 2;
  const mag = new Float64Array(bins);
  const hann = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
  }

  const total = Math.floor(samples.length / FFT_SIZE);
  if (total === 0) {
    return { centroidHz: 0, lowRatio: 0, midRatio: 0, highRatio: 0, framesAnalysed: 0 };
  }
  const step = Math.max(1, Math.floor(total / maxFrames));
  let used = 0;
  for (let f = 0; f < total; f += step) {
    const off = f * FFT_SIZE;
    let energy = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      energy += samples[off + i] * samples[off + i];
    }
    if (energy / FFT_SIZE < 1e-6) {
      continue; // silence between words
    }
    const re = new Float64Array(FFT_SIZE);
    const im = new Float64Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = samples[off + i] * hann[i];
    }
    fft(re, im);
    for (let b = 0; b < bins; b++) {
      mag[b] += Math.sqrt(re[b] * re[b] + im[b] * im[b]);
    }
    used += 1;
  }
  if (used === 0) {
    return { centroidHz: 0, lowRatio: 0, midRatio: 0, highRatio: 0, framesAnalysed: 0 };
  }

  let sum = 0;
  let weighted = 0;
  let low = 0;
  let mid = 0;
  let high = 0;
  const hzPerBin = sampleRate / FFT_SIZE;
  for (let b = 1; b < bins; b++) {
    const hz = b * hzPerBin;
    const m = mag[b] / used;
    sum += m;
    weighted += m * hz;
    if (hz < 1000) {
      low += m;
    } else if (hz < 4000) {
      mid += m;
    } else {
      high += m;
    }
  }
  if (sum === 0) {
    return { centroidHz: 0, lowRatio: 0, midRatio: 0, highRatio: 0, framesAnalysed: used };
  }
  return {
    centroidHz: weighted / sum,
    lowRatio: low / sum,
    midRatio: mid / sum,
    highRatio: high / sum,
    framesAnalysed: used,
  };
}

/** Decode 8/16-bit PCM to a float array in −1…1 for analysis. */
export function pcmToFloat(
  buf: Buffer,
  dataOff: number,
  dataBytes: number,
  bitsPerSample: number,
  channels: number,
): Float64Array {
  const end = Math.min(dataOff + dataBytes, buf.length);
  const bytes = bitsPerSample / 8;
  const frames = Math.floor((end - dataOff) / (bytes * channels));
  const out = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    const i = dataOff + f * bytes * channels; // first channel only
    out[f] = bitsPerSample === 16 ? buf.readInt16LE(i) / 32768 : (buf[i] - 128) / 128;
  }
  return out;
}

/** `centroid 620Hz, bands 71/27/2% (low/mid/high)` */
export function describeSpectrum(s: SpectrumInfo): string {
  const pct = (v: number) => Math.round(v * 100);
  return (
    `centroid ${Math.round(s.centroidHz)}Hz, bands ${pct(s.lowRatio)}/${pct(s.midRatio)}/` +
    `${pct(s.highRatio)}% (low/mid/high)`
  );
}

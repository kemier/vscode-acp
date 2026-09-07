import * as fs from 'fs';

/**
 * Minimal WAV inspection used to tell three failure modes apart before/after a
 * transcription attempt:
 *
 *  - take too short (mic clicked twice in quick succession),
 *  - take is silence (wrong input device, muted mic, or a Bluetooth headset
 *    that had not finished its A2DP→HFP switch — AirPods lose ~1–2 s),
 *  - audio is fine but the STT model returned nothing (model/language issue).
 *
 * Without this, all three surface as "STT returned an empty transcript", which
 * points the user at the wrong component.
 */

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Byte offset of the PCM payload (for spectral analysis). */
  dataOffset: number;
  dataBytes: number;
  durationSec: number;
  /** Highest absolute sample, 0…1. */
  peak: number;
  /** Root-mean-square level, 0…1 (loudness rather than a single click). */
  rms: number;
}

/** Parse `fmt `/`data` from a RIFF WAV, walking the chunk table. */
export function parseWav(buf: Buffer): WavInfo {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let off = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataOff = -1;
  let dataBytes = 0;

  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bitsPerSample = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      dataOff = body;
      // A recorder killed mid-take can leave a placeholder size; trust the
      // file length in that case.
      dataBytes = Math.min(size || buf.length - body, buf.length - body);
      break;
    }
    if (size <= 0) {
      break; // malformed table — stop rather than loop forever
    }
    off = body + size + (size % 2);
  }
  if (dataOff < 0 || !sampleRate || !channels || !bitsPerSample) {
    throw new Error('WAV header is missing fmt/data');
  }

  const bytesPerSample = bitsPerSample / 8;
  const frames = Math.floor(dataBytes / (bytesPerSample * channels));
  const { peak, rms } = levels(buf, dataOff, dataBytes, bitsPerSample);
  return {
    sampleRate,
    channels,
    bitsPerSample,
    dataOffset: dataOff,
    dataBytes,
    durationSec: frames / sampleRate,
    peak,
    rms,
  };
}

/** Peak + RMS over 8-bit unsigned or 16-bit signed PCM (what recorders emit). */
function levels(buf: Buffer, dataOff: number, dataBytes: number, bitsPerSample: number): { peak: number; rms: number } {
  let peak = 0;
  let sumSquares = 0;
  let count = 0;
  const end = Math.min(dataOff + dataBytes, buf.length);
  if (bitsPerSample === 16) {
    for (let i = dataOff; i + 1 < end; i += 2) {
      const v = buf.readInt16LE(i) / 32768;
      const a = Math.abs(v);
      if (a > peak) {
        peak = a;
      }
      sumSquares += v * v;
      count += 1;
    }
  } else if (bitsPerSample === 8) {
    for (let i = dataOff; i < end; i += 1) {
      const v = (buf[i] - 128) / 128;
      const a = Math.abs(v);
      if (a > peak) {
        peak = a;
      }
      sumSquares += v * v;
      count += 1;
    }
  } else {
    // 24/32-bit float or packed formats: level analysis would need format tag
    // handling; report unknown rather than a wrong number.
    return { peak: NaN, rms: NaN };
  }
  return { peak, rms: count ? Math.sqrt(sumSquares / count) : 0 };
}

export function analyzeWavFile(filePath: string): WavInfo {
  return parseWav(fs.readFileSync(filePath));
}

/** One-line log/error summary, e.g. `5.6s, 16000Hz mono 16-bit, peak 41%, rms 6%`. */
export function describeWav(info: WavInfo): string {
  const pct = (v: number) => (Number.isNaN(v) ? 'n/a' : `${Math.round(v * 100)}%`);
  const layout = info.channels === 1 ? 'mono' : `${info.channels}ch`;
  return (
    `${info.durationSec.toFixed(2)}s, ${info.sampleRate}Hz ${layout} ${info.bitsPerSample}-bit, ` +
    `peak ${pct(info.peak)}, rms ${pct(info.rms)}`
  );
}

/**
 * Below this peak a take carries no speech. Room tone on a laptop mic sits
 * around 1–2 %; an AirPods take made during the HFP profile switch is exactly
 * 0 %, which is the case this threshold is meant to catch.
 */
export const SILENCE_PEAK_THRESHOLD = 0.02;
/** Shorter than this and there is nothing for the model to work with. */
export const MIN_TAKE_SEC = 0.6;

export type TakeVerdict =
  { ok: true; info: WavInfo } | { ok: false; info: WavInfo; reason: 'tooShort' | 'silent'; message: string };

/** Decide whether a take is worth sending to the STT server. */
export function judgeTake(info: WavInfo, bluetoothHint: boolean): TakeVerdict {
  if (info.durationSec < MIN_TAKE_SEC) {
    return {
      ok: false,
      info,
      reason: 'tooShort',
      message:
        `Voice input: take too short (${info.durationSec.toFixed(2)}s) — nothing to transcribe. ` +
        'Click the mic, wait for it to turn red, speak, then click again.',
    };
  }
  if (!Number.isNaN(info.peak) && info.peak < SILENCE_PEAK_THRESHOLD) {
    return {
      ok: false,
      info,
      reason: 'silent',
      message:
        `Voice input: the take is silence (${describeWav(info)}). The recorder ran, so this is a ` +
        'device problem, not an STT problem: check that the input device you expect is the Windows ' +
        'default and is not muted' +
        (bluetoothHint
          ? '. On Bluetooth headsets (AirPods) the first 1–2 s are lost while the headset switches ' +
            'to its headset profile — wait for the mic button to turn red before speaking.'
          : '.'),
    };
  }
  return { ok: true, info };
}

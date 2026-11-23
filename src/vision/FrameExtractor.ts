import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveFfmpeg } from './WindowRecorder';
import { logError } from '../utils/Logger';

/**
 * Extract JPEG frames from an MP4 for agents that only accept ACP image
 * ContentBlocks (Claude / OpenAI-style). Used when acp.vision.endpoint is
 * empty but the agent advertises promptCapabilities.image.
 */

export interface ExtractedFrame {
  data: string; // base64
  mimeType: 'image/jpeg';
}

export interface FrameExtractOptions {
  /** Max frames to keep (evenly sampled). */
  maxFrames?: number;
  /** ffmpeg fps filter, e.g. 0.5 = one frame every 2 seconds. */
  fps?: number;
  ffmpegPath?: string;
  /** Drop near-duplicate frames before the even sampling. Default true. */
  dedup?: boolean;
}

/**
 * ffmpeg args for one extraction pass. Exported as a pure function so the
 * filter chain is unit-testable without spawning ffmpeg.
 *
 * `mpdecimate` ("Remove near-duplicate frames", option set verified against
 * the installed ffmpeg 7.0.2 via `-h filter=mpdecimate`) must come AFTER
 * `fps=`, not before: run first it decimates the native-rate stream and the
 * following `fps=` conversion then duplicates the surviving frame to refill
 * the gaps, so the duplicates come straight back. Measured on a 20 s clip that
 * is static apart from one change: `fps=0.5` alone -> 10 frames,
 * `mpdecimate,fps=0.5` -> 10 frames, `fps=0.5,mpdecimate` -> 2 frames.
 *
 * `-fps_mode vfr` is part of the same mechanism: without it ffmpeg's constant
 * frame-rate conversion re-inserts the dropped frames on the way to the image2
 * muxer (same clip: 6 frames instead of 2).
 *
 * Thresholds are left at the ffmpeg defaults (hi=64*12, lo=64*5, frac=0.33 --
 * a frame is droppable only if no 8x8 block differs by more than `hi` and no
 * more than `frac` of blocks differ by more than `lo`). That is sensitive
 * enough for screen content: a 300x16 px change in a 1280x720 frame (0.1% of
 * the picture, about one line of text) is still kept.
 */
export function buildFrameArgs(
  videoPath: string,
  pattern: string,
  fps: number,
  dedup: boolean,
): string[] {
  const args = ['-y', '-i', videoPath, '-vf', dedup ? `fps=${fps},mpdecimate` : `fps=${fps}`];
  if (dedup) {
    args.push('-fps_mode', 'vfr');
  }
  args.push('-q:v', '5', pattern);
  return args;
}

function listFrames(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jpg'))
    .sort();
}

function clearFrames(dir: string): void {
  for (const f of fs.readdirSync(dir)) {
    try {
      fs.unlinkSync(path.join(dir, f));
    } catch {
      /* ignore */
    }
  }
}

export async function extractVideoFrames(
  videoPath: string,
  opts: FrameExtractOptions = {},
): Promise<ExtractedFrame[]> {
  if (!fs.existsSync(videoPath)) {
    throw new Error(`Frame extract: video not found: ${videoPath}`);
  }
  const maxFrames = Math.max(1, opts.maxFrames ?? 8);
  const fps = opts.fps ?? 0.5;
  const dedup = opts.dedup ?? true;
  const ffmpeg = resolveFfmpeg(opts.ffmpegPath);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-frames-'));
  const pattern = path.join(dir, 'frame-%03d.jpg');

  // promisify at call time, not module load: the extractor is unit-tested by
  // swapping child_process.execFile (as terminalHandler.test.ts does for spawn).
  const execFileAsync = promisify(execFile);

  try {
    let files: string[] = [];
    if (dedup) {
      // The dedup pass is best-effort: an ffmpeg without `mpdecimate` or
      // without `-fps_mode` must cost us the saving, not the whole take.
      try {
        await execFileAsync(ffmpeg, buildFrameArgs(videoPath, pattern, fps, true), {
          timeout: 60000,
        });
        files = listFrames(dir);
      } catch (err) {
        logError('[vision] frame dedup pass failed, retrying without mpdecimate', err);
        files = [];
      }
      if (files.length === 0) {
        clearFrames(dir);
      }
    }
    if (files.length === 0) {
      await execFileAsync(ffmpeg, buildFrameArgs(videoPath, pattern, fps, false), {
        timeout: 60000,
      });
      files = listFrames(dir);
    }
    if (files.length === 0) {
      throw new Error('Frame extract: ffmpeg produced no JPEG frames.');
    }
    // Evenly sample down to maxFrames. Dedup runs before this on purpose: the
    // cap is then spent on distinct screens instead of on N copies of the same
    // one, and a change that only lasts a moment can no longer fall between
    // two evenly spaced samples.
    const picked: string[] = [];
    if (files.length <= maxFrames) {
      picked.push(...files);
    } else {
      for (let i = 0; i < maxFrames; i++) {
        const idx = Math.round((i * (files.length - 1)) / (maxFrames - 1));
        picked.push(files[idx]);
      }
    }
    return picked.map((f) => ({
      data: fs.readFileSync(path.join(dir, f)).toString('base64'),
      mimeType: 'image/jpeg' as const,
    }));
  } finally {
    try {
      clearFrames(dir);
      fs.rmdirSync(dir);
    } catch {
      /* ignore */
    }
  }
}

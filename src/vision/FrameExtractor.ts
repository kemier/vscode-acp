import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveFfmpeg } from './WindowRecorder';

const execFileAsync = promisify(execFile);

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
  const ffmpeg = resolveFfmpeg(opts.ffmpegPath);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-frames-'));
  const pattern = path.join(dir, 'frame-%03d.jpg');

  try {
    await execFileAsync(
      ffmpeg,
      ['-y', '-i', videoPath, '-vf', `fps=${fps}`, '-q:v', '5', pattern],
      { timeout: 60000 },
    );
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jpg'))
      .sort();
    if (files.length === 0) {
      throw new Error('Frame extract: ffmpeg produced no JPEG frames.');
    }
    // Evenly sample down to maxFrames
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
      for (const f of fs.readdirSync(dir)) {
        fs.unlinkSync(path.join(dir, f));
      }
      fs.rmdirSync(dir);
    } catch {
      /* ignore */
    }
  }
}

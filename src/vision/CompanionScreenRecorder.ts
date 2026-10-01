import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { log, logError } from '../utils/Logger';
import type { CaptureTarget } from './WindowRecorder';

/**
 * Bridge to the companion extension for screen recording.
 *
 * Same transport as voice ([`CompanionRecorder`](../voice/CompanionRecorder.ts)):
 * the companion declares `extensionKind: ["ui"]`, so it runs on the client
 * machine that owns the displays. Commands from either host share one
 * main-thread registry:
 *
 *   remote →  acpLocalCapture.listCaptureTargets / .startScreenRecord / .stopScreenRecord / .cancelScreenRecord
 *   client →  (MP4 returned as base64 on stop)
 *
 * Capture is local; analysis (VideoVisionClient) stays on the remote host.
 */

export const COMPANION_SCREEN_LIST = 'acpLocalCapture.listCaptureTargets';
export const COMPANION_SCREEN_START = 'acpLocalCapture.startScreenRecord';
export const COMPANION_SCREEN_STOP = 'acpLocalCapture.stopScreenRecord';
export const COMPANION_SCREEN_CANCEL = 'acpLocalCapture.cancelScreenRecord';
/** Bumped when the command payloads change incompatibly. */
export const COMPANION_SCREEN_PROTOCOL = 1;

export const COMPANION_SCREEN_INSTALL_HINT =
  'This is a remote window (Remote SSH/WSL/Container): the extension host — and ' +
  'therefore the screen recorder — runs on the remote machine, which has no access to your ' +
  'laptop\'s displays. Install the "ACP Local Capture (Mic + Screen)" companion extension ' +
  '(acp-local-capture-*.vsix, Extensions view → … → Install from VSIX…). It declares ' +
  'extensionKind "ui", so VS Code installs it on your local machine and screen recording ' +
  'captures there while analysis stays remote. See docs/vision-remote-ssh.md.';

export interface CompanionScreenProbe {
  protocol?: number;
  targets?: CaptureTarget[];
  error?: string;
}

/** Is the companion installed and exposing screen capture commands? */
export async function screenCompanionAvailable(): Promise<boolean> {
  try {
    const all = await vscode.commands.getCommands(true);
    return all.includes(COMPANION_SCREEN_START);
  } catch (err) {
    logError(`[vision] companion probe failed: ${String(err)}`);
    return false;
  }
}

/** List displays/windows on the client machine. */
export async function listCompanionCaptureTargets(): Promise<CaptureTarget[]> {
  const res = await vscode.commands.executeCommand<CompanionScreenProbe>(COMPANION_SCREEN_LIST);
  if (res?.error) {
    throw new Error(`Screen recording: ${res.error}`);
  }
  if (typeof res?.protocol === 'number' && res.protocol !== COMPANION_SCREEN_PROTOCOL) {
    log(`[vision] companion screen protocol ${res.protocol} != expected ${COMPANION_SCREEN_PROTOCOL} — proceeding`);
  }
  return res?.targets ?? [];
}

/** Decode a companion MP4 payload to `filePath`. Returns the byte count. */
export function writeMp4FromBase64(base64: string, filePath: string): number {
  const buf = Buffer.from(base64 ?? '', 'base64');
  if (buf.length < 256) {
    throw new Error(
      'Screen recording: the local companion captured no video. Check screen-recording ' +
        'permission on your local machine and that ffmpeg is installed there.',
    );
  }
  // MP4 files contain an ftyp box near the start
  const head = buf.toString('ascii', 0, 16);
  if (!head.includes('ftyp')) {
    throw new Error('Screen recording: the local companion returned a payload that is not an MP4 file.');
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buf);
  return buf.length;
}

export class CompanionScreenRecorder {
  private takeId: string | null = null;
  private targetPath: string | null = null;

  get isRecording(): boolean {
    return this.takeId !== null;
  }

  async start(
    target: CaptureTarget,
    opts: { outputPath: string; maxDurationSec: number; ffmpegPath?: string },
  ): Promise<void> {
    if (this.takeId) {
      throw new Error('Screen recording: a recording is already in progress.');
    }
    let res: { takeId?: string; protocol?: number } | undefined;
    try {
      res = await vscode.commands.executeCommand<{ takeId?: string; protocol?: number }>(
        COMPANION_SCREEN_START,
        {
          target,
          maxDurationSec: opts.maxDurationSec,
          ffmpegPath: opts.ffmpegPath,
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Screen recording: local companion failed to start — ${msg}`);
    }
    if (!res?.takeId) {
      throw new Error(
        'Screen recording: local companion did not return a take id. ' +
          'Update the companion extension on your local machine.',
      );
    }
    this.takeId = res.takeId;
    this.targetPath = opts.outputPath;
    log(`[vision] recording on the client via companion (take ${res.takeId})`);
  }

  async stop(): Promise<{ path: string; bytes: number }> {
    const takeId = this.takeId;
    const filePath = this.targetPath;
    this.takeId = null;
    this.targetPath = null;
    if (!takeId || !filePath) {
      throw new Error('Screen recording: no recording in progress.');
    }
    let res: { base64?: string; bytes?: number; error?: string } | undefined;
    try {
      res = await vscode.commands.executeCommand<{ base64?: string; bytes?: number; error?: string }>(
        COMPANION_SCREEN_STOP,
        { takeId },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Screen recording: local companion failed to finish the take — ${msg}`);
    }
    if (res?.error) {
      throw new Error(`Screen recording: ${res.error}`);
    }
    const bytes = writeMp4FromBase64(res?.base64 ?? '', filePath);
    log(`[vision] companion screen take ${takeId}: ${bytes} bytes → ${filePath}`);
    return { path: filePath, bytes };
  }

  async cancel(): Promise<void> {
    const takeId = this.takeId;
    this.takeId = null;
    this.targetPath = null;
    if (!takeId) {
      return;
    }
    void Promise.resolve(
      vscode.commands.executeCommand(COMPANION_SCREEN_CANCEL, { takeId }),
    ).then(undefined, () => undefined);
  }
}

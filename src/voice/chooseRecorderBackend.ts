import { resolveBinaryPath, resolveRecorderCommand } from './AudioRecorder';

/** Which client-side capture backend to use. */
export type RecorderBackendPref = 'auto' | 'mci' | 'binary';

export interface ChooseRecorderBackendArgs {
  recordCommand?: string;
  recorderBackend?: RecorderBackendPref;
}

/**
 * Pick MCI (built-in Windows) vs SoX/ffmpeg binary.
 *
 * Shared by the main extension (local Windows) and the local-mic companion.
 * SoX is preferred when present because only it supports silence auto-stop;
 * a forced `recordCommand` or `windowsRecorder=binary` always uses the binary.
 */
export async function chooseRecorderBackend(
  args: ChooseRecorderBackendArgs = {},
): Promise<{ backend: 'mci' | 'binary'; reason: string }> {
  const requested = args.recorderBackend ?? 'auto';
  if (requested === 'mci') {
    return { backend: 'mci', reason: 'acp.voice.windowsRecorder=mci' };
  }
  if (requested === 'binary' || (args.recordCommand ?? '').trim()) {
    return {
      backend: 'binary',
      reason: requested === 'binary' ? 'acp.voice.windowsRecorder=binary' : 'acp.voice.recordCommand is set',
    };
  }
  if (process.platform !== 'win32') {
    return { backend: 'binary', reason: `${process.platform}: recorder binary` };
  }
  try {
    const cmd = resolveRecorderCommand(undefined);
    const bin = await resolveBinaryPath(cmd.command);
    return { backend: 'binary', reason: `found ${bin}` };
  } catch {
    return { backend: 'mci', reason: 'no recorder binary on PATH; using built-in Windows MCI' };
  }
}

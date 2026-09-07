/**
 * Common shape of a dictation recorder.
 *
 * Two implementations exist because the microphone is not always on the same
 * machine as the extension host:
 *  - `AudioRecorder` — spawns a recorder binary in THIS process (local window,
 *    or a remote host that really does have a sound card).
 *  - `CompanionRecorder` — drives the "ACP Voice (Local Mic)" companion
 *    extension, which runs in the UI extension host on the client machine
 *    (Remote SSH / WSL / Dev Container), and ships the WAV back over the
 *    extension-host RPC. Capture is local, transcription stays remote.
 */
export interface RecorderStartOptions {
  silenceAutoStopSec?: number;
  silenceThresholdPct?: number;
  /**
   * Hard cap the recorder itself must honour when it cannot be stopped by a
   * signal. Only the Windows MCI backend uses it (it stops cooperatively and
   * has no level metering, so it needs its own ceiling); binary recorders are
   * killed by `stop()` and rely on the caller's timer instead.
   */
  maxDurationSec?: number;
  /** Recorder exited on its own (SoX silence endpointing) — transcribe now. */
  onNaturalExit?: () => void;
  /** Samples are actually arriving (BT profile switch finished) — safe to speak. */
  onAudioFlowing?: (elapsedMs: number) => void;
}

export interface VoiceRecorder {
  readonly isRecording: boolean;
  /** Start capturing; `filePath` is where the finished WAV must end up. */
  start(filePath: string, configuredCommand?: string, opts?: RecorderStartOptions): Promise<void>;
  /** Stop, finalize, and resolve with the WAV path (throws if nothing captured). */
  stop(): Promise<string>;
  /** Abort and discard. */
  cancel(): void;
}

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { log, logError } from '../utils/Logger';
import { RecorderStartOptions, VoiceRecorder } from './VoiceRecorder';

/**
 * Bridge to the "ACP Voice (Local Mic)" companion extension.
 *
 * Why this exists: in a Remote SSH / WSL / Dev Container window this extension
 * runs in the REMOTE extension host, so `arecord`/`rec` spawned here records
 * the server's (usually non-existent) sound card, not the laptop microphone.
 * Webviews can't help either — VS Code creates the webview iframe with
 * `allow="cross-origin-isolated; autoplay; local-network-access; clipboard-*"`,
 * i.e. no `microphone`, so `getUserMedia({audio})` is blocked by Permissions
 * Policy.
 *
 * The companion extension declares `"extensionKind": ["ui"]`, so VS Code
 * installs and runs it on the CLIENT machine. Commands registered in either
 * extension host land in the same main-thread `CommandsRegistry`, so the two
 * hosts can call each other by command id — that is the transport used here:
 *
 *   remote →  acpVoiceLocal.start / .stop / .cancel / .probe   (client)
 *   client →  acp.voice.localRecorderEvent                     (remote)
 *
 * `stop` returns the WAV as base64 (16 kHz mono 16-bit ≈ 32 KB/s, so a normal
 * take is a few hundred KB); it is written to the remote temp path the caller
 * asked for, and the existing STT path runs unchanged — capture is local,
 * transcription stays on the remote host.
 */

export const COMPANION_PROBE = 'acpVoiceLocal.probe';
export const COMPANION_START = 'acpVoiceLocal.start';
export const COMPANION_STOP = 'acpVoiceLocal.stop';
export const COMPANION_CANCEL = 'acpVoiceLocal.cancel';
/** Registered in THIS host; the companion calls it to push recorder events. */
export const COMPANION_EVENT_SINK = 'acp.voice.localRecorderEvent';
/** Bumped when the command payloads change incompatibly. */
export const COMPANION_PROTOCOL = 1;

export const COMPANION_EXTENSION_ID = 'formulahendry.acp-voice-local';

export const COMPANION_INSTALL_HINT =
  'This is a remote window (Remote SSH/WSL/Container): the extension host — and ' +
  'therefore the recorder — runs on the remote machine, which has no access to your ' +
  'laptop\'s microphone. Install the "ACP Voice (Local Mic)" companion extension ' +
  '(acp-voice-local-*.vsix, Extensions view → … → Install from VSIX…). It declares ' +
  'extensionKind "ui", so VS Code installs it on your local machine and dictation ' +
  'records there while transcription stays remote. See docs/voice-remote-ssh.md.';

export interface CompanionProbe {
  protocol: number;
  version: string;
  platform: string;
  /** 'mci' (built into Windows) or 'binary' (SoX/ffmpeg). */
  backend?: string;
  backendReason?: string;
  recorder?: string;
  recorderError?: string;
}

export interface CompanionStartArgs {
  /** acp.voice.recordCommand, forwarded verbatim (resolved on the client). */
  recordCommand?: string;
  silenceAutoStopSec: number;
  silenceThresholdPct: number;
  /**
   * Ceiling the client-side recorder must enforce itself. The Windows MCI
   * backend stops cooperatively (a killed PowerShell writes no WAV at all), so
   * it needs a cap of its own; this is the remote max-duration setting plus a
   * margin, so the remote timer normally wins.
   */
  maxDurationSec: number;
  /** acp.voice.windowsRecorder: 'auto' | 'mci' | 'binary'. */
  recorderBackend: string;
  /** Command id in this host the companion must call with recorder events. */
  eventCommand: string;
}

export type CompanionEvent =
  | { takeId: string; type: 'audioFlowing'; elapsedMs: number }
  | { takeId: string; type: 'naturalExit' }
  | { takeId: string; type: 'error'; message: string };

/** Is the companion installed and activated on the client side? */
export async function companionAvailable(): Promise<boolean> {
  try {
    const all = await vscode.commands.getCommands(true);
    return all.includes(COMPANION_START);
  } catch (err) {
    logError(`[voice] companion probe failed: ${String(err)}`);
    return false;
  }
}

/** Ask the companion who it is (diagnostics command / error messages). */
export async function probeCompanion(): Promise<CompanionProbe | null> {
  try {
    const res = await vscode.commands.executeCommand<CompanionProbe>(COMPANION_PROBE);
    return res ?? null;
  } catch {
    return null;
  }
}

/**
 * Decode a companion WAV payload to `filePath`. Returns the byte count.
 * Throws when the payload is not a usable WAV (empty take, truncated RPC).
 */
export function writeWavFromBase64(base64: string, filePath: string): number {
  const buf = Buffer.from(base64 ?? '', 'base64');
  if (buf.length <= 44) {
    throw new Error(
      'Voice input: the local companion captured no audio. Check the microphone ' +
        'permission of your local VS Code (macOS: System Settings → Privacy & ' +
        'Security → Microphone) and that SoX/arecord is installed on that machine.',
    );
  }
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Voice input: the local companion returned a payload that is not a WAV file.');
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buf);
  return buf.length;
}

// ─── event sink (client → this host) ────────────────────────────────────────
// One command serves every take; live recorders subscribe by takeId. Registered
// lazily and kept for the lifetime of the extension host: the companion may
// fire an event at any moment while a take is open.

const liveTakes = new Map<string, (evt: CompanionEvent) => void>();
let sinkRegistered = false;

function ensureEventSink(): void {
  if (sinkRegistered) {
    return;
  }
  try {
    vscode.commands.registerCommand(COMPANION_EVENT_SINK, (evt: CompanionEvent) => {
      const handler = evt && typeof evt.takeId === 'string' ? liveTakes.get(evt.takeId) : undefined;
      if (!handler) {
        return; // take already stopped/cancelled — nothing to do
      }
      handler(evt);
    });
    sinkRegistered = true;
  } catch (err) {
    // Already registered (e.g. a second webview provider) — harmless.
    sinkRegistered = true;
    log(`[voice] event sink already registered: ${String(err)}`);
  }
}

export class CompanionRecorder implements VoiceRecorder {
  /**
   * Backend the client picked ('mci' | 'binary'), reported by `start`. The UI
   * needs it because only the SoX path supports silence auto-stop — promising
   * it on the MCI path would leave the user waiting for a stop that never comes.
   */
  backend: string | null = null;
  private takeId: string | null = null;
  private targetPath: string | null = null;
  /** Set when the client-side recorder exited on its own (silence auto-stop). */
  private exited = false;

  get isRecording(): boolean {
    return this.takeId !== null && !this.exited;
  }

  async start(filePath: string, configuredCommand?: string, opts?: RecorderStartOptions): Promise<void> {
    if (this.takeId) {
      throw new Error('Voice input: a recording is already in progress.');
    }
    ensureEventSink();

    const args: CompanionStartArgs = {
      recordCommand: configuredCommand,
      silenceAutoStopSec: opts?.silenceAutoStopSec ?? 0,
      silenceThresholdPct: opts?.silenceThresholdPct ?? 3,
      // +30s margin so the remote max-duration timer, which owns the UI state,
      // fires first in the normal case.
      maxDurationSec: (opts?.maxDurationSec ?? 120) + 30,
      recorderBackend: vscode.workspace.getConfiguration('acp.voice').get<string>('windowsRecorder', 'auto'),
      eventCommand: COMPANION_EVENT_SINK,
    };

    let res: { takeId?: string; protocol?: number; backend?: string } | undefined;
    try {
      res = await vscode.commands.executeCommand<{
        takeId?: string;
        protocol?: number;
        backend?: string;
      }>(COMPANION_START, args);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Voice input: local companion failed to start recording — ${msg}`);
    }
    if (!res?.takeId) {
      throw new Error(
        'Voice input: local companion did not return a take id. ' +
          'Update the "ACP Voice (Local Mic)" extension on your local machine.',
      );
    }
    if (typeof res.protocol === 'number' && res.protocol !== COMPANION_PROTOCOL) {
      log(`[voice] companion protocol ${res.protocol} != expected ${COMPANION_PROTOCOL} — proceeding`);
    }

    this.backend = res.backend ?? null;
    this.takeId = res.takeId;
    this.targetPath = filePath;
    this.exited = false;
    liveTakes.set(res.takeId, (evt) => {
      switch (evt.type) {
        case 'audioFlowing':
          opts?.onAudioFlowing?.(evt.elapsedMs);
          break;
        case 'naturalExit':
          this.exited = true;
          opts?.onNaturalExit?.();
          break;
        case 'error':
          logError(`[voice] companion recorder error: ${evt.message}`);
          this.exited = true;
          opts?.onNaturalExit?.();
          break;
      }
    });
    log(`[voice] recording on the client via companion (take ${res.takeId}, backend=${this.backend ?? '?'})`);
  }

  async stop(): Promise<string> {
    const takeId = this.takeId;
    const filePath = this.targetPath;
    this.takeId = null;
    this.targetPath = null;
    if (!takeId || !filePath) {
      throw new Error('Voice input: no recording in progress.');
    }
    liveTakes.delete(takeId);

    let res: { base64?: string; bytes?: number; error?: string } | undefined;
    try {
      res = await vscode.commands.executeCommand<{ base64?: string; bytes?: number; error?: string }>(COMPANION_STOP, {
        takeId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Voice input: local companion failed to finish the take — ${msg}`);
    }
    if (res?.error) {
      throw new Error(`Voice input: ${res.error}`);
    }
    const bytes = writeWavFromBase64(res?.base64 ?? '', filePath);
    log(`[voice] companion take ${takeId}: ${bytes} bytes → ${filePath}`);
    return filePath;
  }

  cancel(): void {
    const takeId = this.takeId;
    this.takeId = null;
    this.targetPath = null;
    if (!takeId) {
      return;
    }
    liveTakes.delete(takeId);
    void Promise.resolve(vscode.commands.executeCommand(COMPANION_CANCEL, { takeId })).then(undefined, () => undefined);
  }
}

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AudioRecorder, resolveRecorderCommand, resolveBinaryPath } from '../../../src/voice/AudioRecorder';
import { VoiceRecorder } from '../../../src/voice/VoiceRecorder';
import { MciRecorder } from '../../../src/voice/MciRecorder';
import {
  chooseRecorderBackend,
  type RecorderBackendPref,
} from '../../../src/voice/chooseRecorderBackend';
import {
  WindowRecorder,
  listCaptureTargets,
  type CaptureTarget,
} from '../../../src/vision/WindowRecorder';

/**
 * ACP Local Capture (Mic + Screen) — companion extension.
 *
 * Declares `"extensionKind": ["ui"]`, so VS Code runs it in the LOCAL
 * extension host even when the window is attached to Remote SSH / WSL / a Dev
 * Container. That is the only place a process can reach the laptop microphone
 * and displays: the ACP Client extension itself is `"workspace"` kind (it must
 * spawn agents next to the code) and webviews are denied `microphone` and
 * `display-capture` by Permissions Policy.
 *
 * Commands from every extension host share one main-thread registry, so the
 * remote ACP Client drives these recorders purely by command id. Audio is
 * returned as base64 WAV and video as base64 MP4, then transcribed/analyzed
 * remotely — nothing but the take crosses the wire, no STT or vision
 * credentials are needed on the client.
 *
 * The recorder implementations are shared verbatim with the main extension
 * (`src/voice/AudioRecorder.ts`, `src/vision/WindowRecorder.ts`), so SoX
 * silence endpointing, the "audio flowing" Bluetooth probe, the Windows
 * WAV-header repair, and display/window enumeration all behave identically
 * here.
 *
 * History: this extension was previously published as `acp-voice-local` with
 * `acpVoiceLocal.*` commands (mic only). The id and command prefix were
 * renamed when screen recording was added; the old companion must be
 * uninstalled — both register the same functionality and the remote host only
 * probes the new `acpLocalCapture.*` ids.
 */

const PROTOCOL = 1;

/** Which client-side capture backend to use. */
export type RecorderBackend = RecorderBackendPref;

interface StartArgs {
  recordCommand?: string;
  silenceAutoStopSec?: number;
  silenceThresholdPct?: number;
  maxDurationSec?: number;
  recorderBackend?: RecorderBackend;
  eventCommand?: string;
}

interface Take {
  id: string;
  recorder: VoiceRecorder;
  backend: 'mci' | 'binary';
  filePath: string;
  eventCommand?: string;
}

const takes = new Map<string, Take>();
let seq = 0;

// ─── Screen recording (shared WindowRecorder) ───────────────────────────────
interface ScreenTake {
  id: string;
  recorder: WindowRecorder;
  filePath: string;
}
const screenTakes = new Map<string, ScreenTake>();

function screenTmpDir(): string {
  return path.join(os.tmpdir(), 'acp-local-capture-screen');
}

function tmpDir(): string {
  return path.join(os.tmpdir(), 'acp-local-capture');
}

/** Fire an event at the remote host; never throw into the recorder callback. */
function emit(take: Take, payload: Record<string, unknown>): void {
  if (!take.eventCommand) {
    return;
  }
  void Promise.resolve(vscode.commands.executeCommand(take.eventCommand, { takeId: take.id, ...payload })).then(
    undefined,
    () => undefined,
  );
}

function discard(take: Take): void {
  takes.delete(take.id);
  fs.promises.unlink(take.filePath).catch(() => undefined);
}

/** Thin re-export — shared implementation lives in src/voice/chooseRecorderBackend. */
export async function chooseBackend(args: StartArgs): Promise<{ backend: 'mci' | 'binary'; reason: string }> {
  return chooseRecorderBackend({
    recordCommand: args.recordCommand,
    recorderBackend: args.recorderBackend,
  });
}

export function activate(context: vscode.ExtensionContext): void {
  const version = (context.extension?.packageJSON?.version as string | undefined) ?? 'unknown';
  const out = vscode.window.createOutputChannel('ACP Local Capture');
  context.subscriptions.push(out);
  const log = (msg: string) => out.appendLine(`[${new Date().toISOString()}] ${msg}`);
  log(`activated on ${process.platform} (${version}), protocol ${PROTOCOL}`);

  context.subscriptions.push(
    vscode.commands.registerCommand('acpLocalCapture.probe', async () => {
      const result: Record<string, unknown> = {
        protocol: PROTOCOL,
        version,
        platform: process.platform,
      };
      try {
        const cmd = resolveRecorderCommand(undefined);
        result.recorder = await resolveBinaryPath(cmd.command);
      } catch (err) {
        result.recorderError = err instanceof Error ? err.message : String(err);
      }
      const chosen = await chooseBackend({});
      result.backend = chosen.backend;
      result.backendReason = chosen.reason;
      return result;
    }),

    vscode.commands.registerCommand('acpLocalCapture.start', async (args: StartArgs = {}) => {
      const id = `${Date.now()}-${++seq}`;
      const filePath = path.join(tmpDir(), `take-${id}.wav`);
      const chosen = await chooseBackend(args);
      const recorder: VoiceRecorder = chosen.backend === 'mci' ? new MciRecorder() : new AudioRecorder();
      const take: Take = {
        id,
        recorder,
        backend: chosen.backend,
        filePath,
        eventCommand: args.eventCommand,
      };
      takes.set(id, take);
      log(`take ${id}: backend=${chosen.backend} (${chosen.reason})`);
      try {
        await recorder.start(filePath, args.recordCommand || undefined, {
          silenceAutoStopSec: args.silenceAutoStopSec ?? 0,
          silenceThresholdPct: args.silenceThresholdPct ?? 3,
          // MCI cannot be stopped by a signal, so it enforces its own ceiling.
          maxDurationSec: args.maxDurationSec ?? 300,
          onNaturalExit: () => {
            log(`take ${id}: recorder exited on its own (auto-stop)`);
            emit(take, { type: 'naturalExit' });
          },
          onAudioFlowing: (elapsedMs) => {
            log(`take ${id}: audio flowing after ${elapsedMs}ms`);
            emit(take, { type: 'audioFlowing', elapsedMs });
          },
        });
      } catch (err) {
        discard(take);
        const msg = err instanceof Error ? err.message : String(err);
        log(`take ${id}: start failed — ${msg}`);
        // Surfaced as a rejected command → the remote host shows it in chat.
        throw new Error(msg);
      }
      log(`take ${id}: recording → ${filePath}`);
      return { takeId: id, protocol: PROTOCOL, backend: chosen.backend };
    }),

    vscode.commands.registerCommand('acpLocalCapture.stop', async (args: { takeId?: string } = {}) => {
      const take = args.takeId ? takes.get(args.takeId) : undefined;
      if (!take) {
        return { error: `local companion has no take "${args.takeId ?? ''}" (already stopped?).` };
      }
      try {
        const wav = await take.recorder.stop();
        const buf = await fs.promises.readFile(wav);
        log(`take ${take.id}: stopped, ${buf.length} bytes`);
        return { base64: buf.toString('base64'), bytes: buf.length, protocol: PROTOCOL };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`take ${take.id}: stop failed — ${msg}`);
        return { error: msg };
      } finally {
        discard(take);
      }
    }),

    vscode.commands.registerCommand('acpLocalCapture.cancel', (args: { takeId?: string } = {}) => {
      const take = args.takeId ? takes.get(args.takeId) : undefined;
      if (!take) {
        return;
      }
      log(`take ${take.id}: cancelled`);
      take.recorder.cancel();
      discard(take);
    }),

    // ─── Screen capture commands (video vision) ──────────────────────────────
    vscode.commands.registerCommand('acpLocalCapture.listCaptureTargets', async () => {
      try {
        const targets = await listCaptureTargets();
        return { targets, protocol: PROTOCOL };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`listCaptureTargets failed — ${msg}`);
        return { error: msg, targets: [] as CaptureTarget[] };
      }
    }),

    vscode.commands.registerCommand(
      'acpLocalCapture.startScreenRecord',
      async (args: { target?: CaptureTarget; maxDurationSec?: number; ffmpegPath?: string } = {}) => {
        if (!args.target || typeof args.target !== 'object') {
          throw new Error('startScreenRecord requires a target from listCaptureTargets.');
        }
        const id = `${Date.now()}-${++seq}`;
        const filePath = path.join(screenTmpDir(), `take-${id}.mp4`);
        const recorder = new WindowRecorder();
        const take: ScreenTake = { id, recorder, filePath };
        screenTakes.set(id, take);
        try {
          await recorder.start(args.target, {
            outputPath: filePath,
            maxDurationSec: args.maxDurationSec ?? 90,
            ffmpegPath: args.ffmpegPath || undefined,
          });
        } catch (err) {
          screenTakes.delete(id);
          const msg = err instanceof Error ? err.message : String(err);
          log(`screen take ${id}: start failed — ${msg}`);
          throw new Error(msg);
        }
        log(`screen take ${id}: recording ${args.target.id} → ${filePath}`);
        return { takeId: id, protocol: PROTOCOL };
      },
    ),

    vscode.commands.registerCommand('acpLocalCapture.stopScreenRecord', async (args: { takeId?: string } = {}) => {
      const take = args.takeId ? screenTakes.get(args.takeId) : undefined;
      if (!take) {
        return { error: `local companion has no screen take "${args.takeId ?? ''}" (already stopped?).` };
      }
      try {
        const { path: mp4, bytes } = await take.recorder.stop();
        const buf = await fs.promises.readFile(mp4);
        log(`screen take ${take.id}: stopped, ${bytes} bytes`);
        return { base64: buf.toString('base64'), bytes, protocol: PROTOCOL };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`screen take ${take.id}: stop failed — ${msg}`);
        return { error: msg };
      } finally {
        screenTakes.delete(take.id);
        fs.promises.unlink(take.filePath).catch(() => undefined);
      }
    }),

    vscode.commands.registerCommand('acpLocalCapture.cancelScreenRecord', (args: { takeId?: string } = {}) => {
      const take = args.takeId ? screenTakes.get(args.takeId) : undefined;
      if (!take) {
        return;
      }
      log(`screen take ${take.id}: cancelled`);
      void take.recorder.cancel();
      screenTakes.delete(take.id);
      fs.promises.unlink(take.filePath).catch(() => undefined);
    }),

    // Standalone diagnostics: records 3s locally and reports the result, so the
    // mic chain can be validated without an agent session. It MUST pick the
    // backend the same way a real take does — testing with SoX on a machine
    // that uses the built-in Windows recorder reports a failure that does not
    // exist.
    vscode.commands.registerCommand('acpLocalCapture.testMicrophone', async () => {
      const filePath = path.join(tmpDir(), `probe-${Date.now()}.wav`);
      const chosen = await chooseBackend({});
      const recorder: VoiceRecorder = chosen.backend === 'mci' ? new MciRecorder() : new AudioRecorder();
      log(`microphone test: backend=${chosen.backend} (${chosen.reason})`);
      try {
        await recorder.start(filePath, undefined, { maxDurationSec: 30 });
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `ACP Local Capture: recording 3s via ${chosen.backend}… speak now`,
          },
          () => new Promise<void>((r) => setTimeout(r, 3000)),
        );
        const wav = await recorder.stop();
        const bytes = (await fs.promises.stat(wav)).size;
        const seconds = ((bytes - 44) / (16000 * 2)).toFixed(1);
        log(`microphone test: ${bytes} bytes (~${seconds}s of 16 kHz mono) via ${chosen.backend}`);
        void vscode.window.showInformationMessage(
          `ACP Local Capture: local microphone works via ${chosen.backend} — captured ${bytes} bytes (~${seconds}s).`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`microphone test failed (backend=${chosen.backend}) — ${msg}`);
        void vscode.window.showErrorMessage(`ACP Local Capture: local microphone test failed via ${chosen.backend} — ${msg}`);
      } finally {
        recorder.cancel();
        fs.promises.unlink(filePath).catch(() => undefined);
      }
    }),
  );
}

export function deactivate(): void {
  for (const take of takes.values()) {
    take.recorder.cancel();
  }
  takes.clear();
  for (const take of screenTakes.values()) {
    void take.recorder.cancel();
    fs.promises.unlink(take.filePath).catch(() => undefined);
  }
  screenTakes.clear();
}

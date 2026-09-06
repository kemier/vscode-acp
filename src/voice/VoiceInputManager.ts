import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { AudioRecorder } from './AudioRecorder';
import { transcribeAudio, SttConfig, SttError } from './SttClient';
import { log, logError } from '../utils/Logger';

/**
 * Voice input orchestrator for the per-agent chat composer.
 *
 * One recording at a time, bound to the agent session that was active when
 * recording started — if the user switches sessions mid-recording the take
 * is cancelled rather than leaking a transcript into the wrong agent's chat
 * (per-agent isolation is the whole point of the feature).
 *
 * State machine: idle → recording → transcribing → idle.
 * The webview mic button mirrors the state via VoiceEvent messages.
 */

export type VoiceState = 'idle' | 'recording' | 'transcribing';

export type VoiceEvent =
  | { type: 'state'; state: VoiceState }
  | { type: 'transcript'; text: string; sessionId: string | null; autoSend: boolean }
  | { type: 'error'; message: string };

interface VoiceSettings {
  enabled: boolean;
  recordCommand: string;
  maxDurationSec: number;
  silenceAutoStopSec: number;
  autoSend: boolean;
  stt: SttConfig;
}

function readSettings(): VoiceSettings {
  const cfg = vscode.workspace.getConfiguration('acp.voice');
  return {
    enabled: cfg.get<boolean>('enabled', true),
    recordCommand: cfg.get<string>('recordCommand', ''),
    maxDurationSec: cfg.get<number>('maxDurationSec', 120),
    silenceAutoStopSec: cfg.get<number>('silenceAutoStopSec', 2.5),
    autoSend: cfg.get<boolean>('autoSend', false),
    stt: {
      endpoint: cfg.get<string>('stt.endpoint', 'http://127.0.0.1:8080/inference'),
      model: cfg.get<string>('stt.model', 'whisper-1'),
      apiKey: cfg.get<string>('stt.apiKey', ''),
      language: cfg.get<string>('stt.language', ''),
      prompt: cfg.get<string>('stt.prompt', ''),
      timeoutMs: cfg.get<number>('stt.timeoutMs', 60000),
    },
  };
}

export class VoiceInputManager {
  private state: VoiceState = 'idle';
  private recorder: AudioRecorder | null = null;
  /** Session that was active when recording started. */
  private boundSessionId: string | null = null;
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  private takeSeq = 0;

  constructor(
    private readonly onEvent: (evt: VoiceEvent) => void,
    private readonly getActiveSessionId: () => string | undefined,
  ) {}

  get currentState(): VoiceState {
    return this.state;
  }

  /** Mic button handler: idle → start, recording → stop+transcribe, transcribing → ignore. */
  async toggle(): Promise<void> {
    if (this.state === 'transcribing') {
      return; // A take is being transcribed; the next click starts a new one after it lands.
    }
    if (this.state === 'recording') {
      await this.stopAndTranscribe();
      return;
    }
    await this.start();
  }

  private setState(state: VoiceState): void {
    this.state = state;
    this.onEvent({ type: 'state', state });
  }

  private fail(err: unknown): void {
    const message =
      err instanceof SttError || err instanceof Error ? err.message : String(err);
    logError(`[voice] ${message}`);
    this.cleanup();
    this.setState('idle');
    this.onEvent({ type: 'error', message });
  }

  private cleanup(): void {
    if (this.maxDurationTimer) {
      clearTimeout(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }
    this.recorder?.cancel();
    this.recorder = null;
    this.boundSessionId = null;
  }

  private async start(): Promise<void> {
    const settings = readSettings();
    if (!settings.enabled) {
      this.onEvent({ type: 'error', message: 'Voice input is disabled (acp.voice.enabled).' });
      return;
    }

    this.boundSessionId = this.getActiveSessionId() ?? null;
    const takeId = ++this.takeSeq;
    const dir = path.join(os.tmpdir(), 'vscode-acp-audio');
    const filePath = path.join(dir, `take-${Date.now()}-${takeId}.wav`);

    const recorder = new AudioRecorder();
    this.recorder = recorder;
    try {
      await recorder.start(filePath, settings.recordCommand || undefined, {
        silenceAutoStopSec: settings.silenceAutoStopSec,
        onNaturalExit: () => {
          // SoX silence endpointing: user stopped talking → transcribe
          // without waiting for a second mic click.
          if (this.state === 'recording') {
            log('[voice] recorder exited on silence auto-stop — transcribing');
            void this.stopAndTranscribe();
          }
        },
      });
    } catch (err) {
      this.fail(err);
      return;
    }

    log(`[voice] recording started → ${filePath} (session=${this.boundSessionId ?? 'none'})`);
    this.setState('recording');

    // Hard cap so a forgotten mic never records forever.
    const maxMs = Math.max(5, settings.maxDurationSec) * 1000;
    this.maxDurationTimer = setTimeout(() => {
      if (this.state === 'recording') {
        log('[voice] max duration reached — auto-stopping');
        void this.stopAndTranscribe();
      }
    }, maxMs);
  }

  private async stopAndTranscribe(): Promise<void> {
    const recorder = this.recorder;
    if (!recorder) {
      return;
    }
    if (this.maxDurationTimer) {
      clearTimeout(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }

    let filePath: string;
    try {
      filePath = await recorder.stop();
    } catch (err) {
      this.fail(err);
      return;
    }
    this.recorder = null;

    // Per-agent isolation: refuse to transcribe into a different session.
    const activeNow = this.getActiveSessionId() ?? null;
    if (activeNow !== this.boundSessionId) {
      fs.promises.unlink(filePath).catch(() => undefined);
      this.fail(new Error('Voice input: session changed while recording — take discarded.'));
      return;
    }

    const settings = readSettings();
    this.setState('transcribing');
    log(`[voice] transcribing ${filePath} via ${settings.stt.endpoint}`);
    try {
      const text = await transcribeAudio(filePath, settings.stt);
      log(`[voice] transcript (${text.length} chars): ${text.slice(0, 120)}`);
      this.setState('idle');
      this.onEvent({
        type: 'transcript',
        text,
        sessionId: this.boundSessionId,
        autoSend: settings.autoSend,
      });
    } catch (err) {
      this.fail(err);
    } finally {
      this.boundSessionId = null;
      fs.promises.unlink(filePath).catch(() => undefined);
    }
  }

  /** Cancel any in-flight recording/transcription (webview dispose, session switch). */
  cancel(): void {
    if (this.state === 'idle') {
      return;
    }
    log('[voice] cancelled');
    this.cleanup();
    this.setState('idle');
  }

  dispose(): void {
    this.cancel();
  }
}

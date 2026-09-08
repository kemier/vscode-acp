import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { AudioRecorder } from './AudioRecorder';
import { MciRecorder } from './MciRecorder';
import { chooseRecorderBackend } from './chooseRecorderBackend';
import { VoiceRecorder } from './VoiceRecorder';
import { COMPANION_INSTALL_HINT, CompanionRecorder, companionAvailable } from './CompanionRecorder';
import { transcribeAudio, warmupStt, SttConfig, SttError, normalizeTranscriptWhitespace } from './SttClient';
import { applyCorrections, textSimilarity, VoiceMemoryStore } from './VoiceMemory';
import { correctTranscript, CorrectorConfig } from './CorrectorClient';
import { analyzeWavFile, describeWav, judgeTake } from './WavInfo';
import { analyzeSpectrum, describeSpectrum, pcmToFloat } from './Spectrum';
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

/**
 * Where the microphone is captured.
 *  - 'auto': companion (client-side) recorder in remote windows when the
 *    companion extension is installed, extension-host recorder otherwise.
 *  - 'localCompanion': always require the companion (hard error if missing).
 *  - 'extensionHost': always record in this process (the old behaviour — right
 *    for local windows, or a remote host that genuinely has a mic).
 */
export type CaptureMode = 'auto' | 'localCompanion' | 'extensionHost';

export type VoiceEvent =
  | { type: 'state'; state: VoiceState }
  | { type: 'recordingReady'; elapsedMs: number; autoStop: boolean }
  | { type: 'transcript'; text: string; sessionId: string | null; autoSend: boolean }
  | { type: 'error'; message: string };

interface VoiceSettings {
  enabled: boolean;
  recordCommand: string;
  captureMode: CaptureMode;
  windowsRecorder: 'auto' | 'mci' | 'binary';
  maxDurationSec: number;
  silenceAutoStopSec: number;
  silenceThresholdPct: number;
  autoSend: boolean;
  keepFailedTakes: boolean;
  /** 'none' | 'failed' | 'all' — which takes are copied to the debug folder. */
  keepTakes: string;
  warmupStt: boolean;
  stt: SttConfig;
  corrections: Record<string, string>;
  corrector: CorrectorConfig;
  memoryFile: string;
}

function readSettings(): VoiceSettings {
  const cfg = vscode.workspace.getConfiguration('acp.voice');
  return {
    enabled: cfg.get<boolean>('enabled', true),
    recordCommand: cfg.get<string>('recordCommand', ''),
    captureMode: cfg.get<CaptureMode>('captureMode', 'auto'),
    windowsRecorder: cfg.get<'auto' | 'mci' | 'binary'>('windowsRecorder', 'auto'),
    maxDurationSec: cfg.get<number>('maxDurationSec', 120),
    silenceAutoStopSec: cfg.get<number>('silenceAutoStopSec', 2.5),
    silenceThresholdPct: cfg.get<number>('silenceThresholdPct', 3),
    autoSend: cfg.get<boolean>('autoSend', false),
    keepFailedTakes: cfg.get<boolean>('keepFailedTakes', false),
    keepTakes: cfg.get<string>('keepTakes', 'failed'),
    warmupStt: cfg.get<boolean>('stt.warmup', true),
    stt: {
      endpoint: cfg.get<string>('stt.endpoint', 'http://127.0.0.1:8080/inference'),
      model: cfg.get<string>('stt.model', 'whisper-1'),
      apiKey: cfg.get<string>('stt.apiKey', ''),
      language: cfg.get<string>('stt.language', ''),
      prompt: cfg.get<string>('stt.prompt', ''),
      timeoutMs: cfg.get<number>('stt.timeoutMs', 180000),
    },
    corrections: cfg.get<Record<string, string>>('corrections', {}),
    corrector: {
      enabled: cfg.get<boolean>('corrector.enabled', false),
      endpoint: cfg.get<string>('corrector.endpoint', 'http://127.0.0.1:11434/v1/chat/completions'),
      model: cfg.get<string>('corrector.model', 'qwen2.5:7b'),
      apiKey: cfg.get<string>('corrector.apiKey', ''),
      timeoutMs: cfg.get<number>('corrector.timeoutMs', 15000),
    },
    memoryFile: cfg.get<string>('memoryFile', ''),
  };
}

export class VoiceInputManager {
  private state: VoiceState = 'idle';
  private recorder: VoiceRecorder | null = null;
  /** True while the backend is opening the device (no take exists yet). */
  private starting = false;
  /** Capture backend for the active take ('mci' disables silence auto-stop UI). */
  private hostBackend: 'mci' | 'binary' | null = null;
  /** True when the current/last take was captured by the client-side companion. */
  private usingCompanion = false;
  /** Session that was active when recording started. */
  private boundSessionId: string | null = null;
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  private takeSeq = 0;
  private store: VoiceMemoryStore | null = null;
  /** Last inserted transcript awaiting the user's send/edit verdict. */
  private lastInsert: { stt: string; inserted: string; sessionId: string | null; ts: number } | null = null;

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
    if (this.starting) {
      // The backend has not confirmed the device yet. Ignoring the click is the
      // only safe answer: the Windows MCI path needs 1–2 s (PowerShell launch +
      // Add-Type compile), and without this guard every extra click spawned an
      // additional concurrent take that then leaked until its duration cap.
      log('[voice] ignoring mic click — recorder is still starting');
      return;
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

  private fail(err: unknown, recorderStage = false): void {
    const base = err instanceof SttError || err instanceof Error ? err.message : String(err);
    // A capture failure in a remote window is almost always "no mic over there";
    // name the fix instead of leaving the user with an ALSA error.
    const message = recorderStage ? `${base}${this.hintSuffix()}` : base;
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
    this.starting = false;
    this.recorder?.cancel();
    this.recorder = null;
    this.boundSessionId = null;
  }

  /**
   * Pick where the microphone is captured.
   *
   * In a remote window (Remote SSH / WSL / container) this extension host runs
   * on the remote machine, so a recorder spawned here listens to the server's
   * sound card — not the user's. When the client-side companion extension is
   * installed we drive it instead (capture local, transcription remote).
   */
  private async createRecorder(settings: VoiceSettings): Promise<VoiceRecorder> {
    const remote = Boolean(vscode.env.remoteName);
    const mode = settings.captureMode;

    if (mode === 'extensionHost') {
      this.usingCompanion = false;
      return this.createHostRecorder(settings);
    }

    const wantCompanion = mode === 'localCompanion' || (mode === 'auto' && remote);
    if (wantCompanion && (await companionAvailable())) {
      this.usingCompanion = true;
      this.hostBackend = null;
      return new CompanionRecorder();
    }
    if (mode === 'localCompanion') {
      throw new Error(`Voice input: ${COMPANION_INSTALL_HINT}`);
    }

    // auto + remote, companion missing: still try the extension host — a remote
    // workstation may genuinely have a mic — but remember to append the install
    // hint if it fails, which is the usual outcome on a headless server.
    this.usingCompanion = false;
    if (remote) {
      log(
        `[voice] remote window (${vscode.env.remoteName}) without the local-mic companion — ` +
          'recording on the remote host',
      );
    }
    return this.createHostRecorder(settings);
  }

  /** Local / remote extension-host capture (SoX or Windows MCI). */
  private async createHostRecorder(settings: VoiceSettings): Promise<VoiceRecorder> {
    const chosen = await chooseRecorderBackend({
      recordCommand: settings.recordCommand,
      recorderBackend: settings.windowsRecorder,
    });
    this.hostBackend = chosen.backend;
    log(`[voice] host recorder backend=${chosen.backend} (${chosen.reason})`);
    return chosen.backend === 'mci' ? new MciRecorder() : new AudioRecorder();
  }

  /** Remote windows without the companion get an actionable suffix on failures. */
  private hintSuffix(): string {
    if (this.usingCompanion || !vscode.env.remoteName) {
      return '';
    }
    return ` ${COMPANION_INSTALL_HINT}`;
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

    const recorder = await this.createRecorder(settings).catch((err) => {
      this.fail(err, true);
      return null;
    });
    if (!recorder) {
      return;
    }
    this.recorder = recorder;
    // Enter 'recording' BEFORE awaiting the backend: opening the device takes
    // 1–2 s on the Windows MCI path, and the mic button must show that the
    // click was accepted (it stays non-pulsing until 'recordingReady' says the
    // device is actually capturing).
    this.starting = true;
    this.setState('recording');
    try {
      await recorder.start(filePath, settings.recordCommand || undefined, {
        silenceAutoStopSec: settings.silenceAutoStopSec,
        silenceThresholdPct: settings.silenceThresholdPct,
        maxDurationSec: settings.maxDurationSec,
        onNaturalExit: () => {
          // SoX silence endpointing: user stopped talking → transcribe
          // without waiting for a second mic click.
          if (this.state === 'recording') {
            log('[voice] recorder exited on silence auto-stop — transcribing');
            void this.stopAndTranscribe();
          }
        },
        onAudioFlowing: (elapsedMs) => {
          // Bluetooth headsets take up to ~2s to switch A2DP→HFP and start
          // capturing — anything said before this moment is lost. The webview
          // shows "starting…" until this fires.
          log(`[voice] audio flowing after ${elapsedMs}ms`);
          // Silence endpointing is a SoX effect; the built-in Windows MCI
          // backend has no level metering, so don't advertise auto-stop there.
          const backend =
            recorder instanceof CompanionRecorder
              ? recorder.backend
              : this.hostBackend ?? 'binary';
          this.onEvent({
            type: 'recordingReady',
            elapsedMs,
            autoStop: settings.silenceAutoStopSec > 0 && backend !== 'mci',
          });
        },
      });
    } catch (err) {
      this.starting = false;
      this.fail(err, true);
      return;
    }
    this.starting = false;

    log(`[voice] recording started → ${filePath} (session=${this.boundSessionId ?? 'none'})`);

    // The STT backend unloads its model when idle and needs ~45–60 s to load it
    // again, which used to blow the request timeout on the first take after a
    // pause. Poke it with 120 ms of silence NOW so that load overlaps with the
    // user speaking instead of with the transcription request.
    if (settings.warmupStt) {
      void warmupStt(settings.stt);
    }

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
      this.fail(err, true);
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

    // Inspect the WAV before spending a round-trip on it. "Empty transcript"
    // used to be the single symptom of three different causes (too short /
    // silence / model returned nothing); the measured level separates them.
    let takeSummary = '';
    try {
      const bytes = fs.readFileSync(filePath);
      const info = analyzeWavFile(filePath);
      takeSummary = describeWav(info);
      // The spectrum is what distinguishes "quiet but fine" from "the device
      // delivered a different sample rate than the header claims" (Bluetooth
      // HFP), which makes Whisper return nothing at all.
      const spectrum = analyzeSpectrum(
        pcmToFloat(bytes, info.dataOffset, info.dataBytes, info.bitsPerSample, info.channels),
        info.sampleRate,
      );
      takeSummary = `${takeSummary}, ${describeSpectrum(spectrum)}`;
      log(`[voice] take: ${takeSummary}`);
      const verdict = judgeTake(info, this.usingCompanion);
      if (!verdict.ok) {
        this.keepFailedTake(filePath, settings.keepTakes !== 'none' && settings.keepFailedTakes);
        this.fail(new Error(verdict.message), true);
        return;
      }
    } catch (err) {
      // Analysis is diagnostic only — never block a take because of it.
      log(`[voice] could not analyse take: ${String(err)}`);
    }

    this.setState('transcribing');
    log(`[voice] transcribing ${filePath} via ${settings.stt.endpoint}`);
    const sttStart = Date.now();
    try {
      const rawText = await transcribeAudio(filePath, settings.stt);
      log(`[voice] STT round-trip ${Date.now() - sttStart}ms`);
      // A transcript that is wrong but non-empty can only be diagnosed from the
      // audio, so 'all' keeps successful takes next to their transcript.
      if (settings.keepTakes === 'all') {
        this.keepFailedTake(filePath, true, rawText);
      }
      await this.deliverTranscript(rawText, settings);
    } catch (err) {
      // The audio passed the level check, so an empty transcript here points at
      // the model/language rather than the microphone — say so, with numbers.
      if (err instanceof SttError && /timed out/i.test(err.message)) {
        logError(
          `[voice] STT timed out after ${Date.now() - sttStart}ms — the backend was probably ` +
            'loading its model (cold start measured at ~45-60s); raise acp.voice.stt.timeoutMs.',
        );
      }
      const enriched =
        err instanceof SttError && /empty transcript/i.test(err.message) && takeSummary
          ? new SttError(
              `${err.message} The recording itself looks usable (${takeSummary}), so check ` +
                `acp.voice.stt.model / acp.voice.stt.language, or speak closer to the mic.`,
            )
          : err;
      // Always keep a take the STT server refused: the audio is the only
      // evidence for why, and the normal path deletes it a line later.
      this.keepFailedTake(filePath, settings.keepTakes !== 'none');
      this.fail(enriched);
    } finally {
      this.boundSessionId = null;
      fs.promises.unlink(filePath).catch(() => undefined);
    }
  }

  /**
   * Voice Memory pipeline (arXiv:2607.26410) + delivery: deterministic
   * dictionary first, then the restraint-biased LLM corrector reading
   * memory.md, then insert into the composer. Shared by the normal path and
   * the retry command so both apply identical corrections.
   */
  private async deliverTranscript(rawText: string, settings: VoiceSettings): Promise<void> {
    // Whisper often inserts `\n` / blank lines at pause boundaries; collapse
    // those before dictionary/corrector so the composer stays one flow.
    const normalized = normalizeTranscriptWhitespace(rawText);
    let text = applyCorrections(normalized, settings.corrections);
    if (normalized !== rawText) {
      log(`[voice] whitespace normalized: ${rawText.slice(0, 80).replace(/\n/g, '\\n')} → ${normalized.slice(0, 80)}`);
    }
    if (text !== normalized) {
      log(`[voice] dictionary corrections applied: ${normalized.slice(0, 80)} → ${text.slice(0, 80)}`);
    }
    if (settings.corrector.enabled && text.trim()) {
      const memory = await this.getStore(settings.memoryFile).loadMemory();
      const res = await correctTranscript(text, memory, settings.corrector);
      if (res.acted) {
        log(`[voice] corrector acted: ${text.slice(0, 80)} → ${res.text.slice(0, 80)}`);
      }
      text = res.text;
    }
    log(`[voice] transcript (${text.length} chars): ${text.slice(0, 120)}`);
    this.lastInsert = {
      stt: rawText,
      inserted: text,
      sessionId: this.boundSessionId,
      ts: Date.now(),
    };
    this.setState('idle');
    this.onEvent({
      type: 'transcript',
      text,
      sessionId: this.boundSessionId,
      autoSend: settings.autoSend,
    });
  }

  /** Directory holding takes that failed transcription (see keepFailedTake). */
  static failedTakeDir(): string {
    return path.join(os.tmpdir(), 'vscode-acp-audio', 'failed');
  }

  /**
   * Re-transcribe the most recent take that failed.
   *
   * The STT backend goes away intermittently (Ray Serve scales the Whisper
   * deployment to zero and answers 200 with `DeploymentUnavailableError`), and
   * losing what you just dictated to that is needlessly punishing — the audio
   * is on disk, so offer it back.
   */
  async retryLastTake(): Promise<void> {
    if (this.state !== 'idle') {
      this.onEvent({ type: 'error', message: 'Voice input: busy — finish the current take first.' });
      return;
    }
    const dir = VoiceInputManager.failedTakeDir();
    let newest: string | null = null;
    try {
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.wav'))
        .map((f) => path.join(dir, f))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      newest = files[0] ?? null;
    } catch {
      newest = null;
    }
    if (!newest) {
      this.onEvent({
        type: 'error',
        message: `Voice input: no failed take to retry (looked in ${dir}).`,
      });
      return;
    }

    const settings = readSettings();
    this.boundSessionId = this.getActiveSessionId() ?? null;
    this.setState('transcribing');
    log(`[voice] retrying kept take ${newest}`);
    const t0 = Date.now();
    try {
      const rawText = await transcribeAudio(newest, settings.stt);
      log(`[voice] retry STT round-trip ${Date.now() - t0}ms`);
      await this.deliverTranscript(rawText, settings);
    } catch (err) {
      this.fail(err);
    } finally {
      this.boundSessionId = null;
    }
  }

  /**
   * Copy a rejected take somewhere stable so it can be played back. Debugging a
   * silent Bluetooth take is guesswork without the actual file, and the normal
   * path deletes it immediately.
   */
  private keepFailedTake(filePath: string, enabled: boolean, transcript?: string): void {
    if (!enabled) {
      return;
    }
    try {
      const dir = VoiceInputManager.failedTakeDir();
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, path.basename(filePath));
      fs.copyFileSync(filePath, dest);
      if (transcript !== undefined) {
        // Sidecar: what the model heard, next to what was recorded.
        fs.writeFileSync(`${dest}.txt`, transcript, 'utf8');
      }
      log(`[voice] kept take → ${dest}`);
      // Keep only the newest few: these are diagnostics, not an archive.
      const kept = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.wav'))
        .map((f) => path.join(dir, f))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      for (const stale of kept.slice(5)) {
        fs.promises.unlink(stale).catch(() => undefined);
        fs.promises.unlink(`${stale}.txt`).catch(() => undefined);
      }
    } catch (err) {
      log(`[voice] could not keep failed take: ${String(err)}`);
    }
  }

  private storeMemoryFile = '';
  private getStore(memoryFile: string): VoiceMemoryStore {
    if (!this.store || this.storeMemoryFile !== memoryFile) {
      this.store = new VoiceMemoryStore(memoryFile);
      this.storeMemoryFile = memoryFile;
    }
    return this.store;
  }

  /**
   * Called by the webview provider when a prompt is sent. If the send matches
   * a recent voice insert for the same session, record the outcome: verbatim
   * send = 'accept' (corrector must not touch such text), edited send =
   * 'edited' (learning signal for the review command).
   */
  captureFeedback(sentText: string, sessionId: string | undefined): void {
    const li = this.lastInsert;
    if (!li) {
      return;
    }
    if ((sessionId ?? null) !== li.sessionId) {
      return; // prompt belongs to a different session — keep waiting
    }
    if (Date.now() - li.ts > 10 * 60_000) {
      this.lastInsert = null; // stale — the user clearly moved on
      return;
    }
    this.lastInsert = null;
    // 'accept' = verbatim; 'edited' = corrected a few tokens (learning
    // signal); 'replaced' = wholesale rewrite — the user re-dictated or typed
    // a different message, which is NOT a correction signal. Mining rules
    // from replacements produced poison rules (为什么→why) in the first
    // real optimizer run.
    const kind = sentText.includes(li.inserted)
      ? 'accept'
      : textSimilarity(sentText, li.inserted) >= 0.35
        ? 'edited'
        : 'replaced';
    log(`[voice] feedback: ${kind} (stt=${li.stt.length}ch, inserted=${li.inserted.length}ch)`);
    // The store was already resolved with the active memoryFile setting when
    // the transcript was inserted — reuse it as-is.
    const store = this.store ?? this.getStore('');
    void store.appendFeedback({
      ts: Date.now(),
      sessionId: li.sessionId,
      stt: li.stt,
      inserted: li.inserted,
      final: kind === 'edited' ? sentText : undefined,
      kind,
    });
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

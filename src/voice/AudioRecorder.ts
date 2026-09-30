import { spawn, execFile, ChildProcess } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execFileAsync = promisify(execFile);

/**
 * Host-side audio recorder.
 *
 * VS Code webviews are sandboxed iframes — getUserMedia / SpeechRecognition
 * are blocked by Permissions-Policy (microsoft/vscode#250568). Recording must
 * happen in the extension host, which inherits the editor's OS-level mic
 * permission (macOS TCC, etc.). We spawn a platform recorder binary that
 * writes a 16 kHz mono 16-bit WAV — the format every local STT server
 * (whisper.cpp, FunASR, Qwen3-ASR wrappers) accepts.
 *
 * No fallback chains (per repo convention): if the recorder binary is
 * missing we throw an error that names the exact install command.
 */

export interface RecorderCommand {
  /** Executable name or absolute path, e.g. "rec" or "ffmpeg". */
  command: string;
  /** Argument template. The literal token `{file}` is replaced with the output path. */
  args: string[];
}

const INSTALL_HINTS: Record<string, string> = {
  rec: 'Install SoX: `brew install sox` (macOS), `sudo apt install sox` (Linux), or set acp.voice.recordCommand.',
  arecord: 'Install ALSA utils: `sudo apt install alsa-utils`, or set acp.voice.recordCommand.',
  ffmpeg: 'Install ffmpeg: `brew install ffmpeg` / `sudo apt install ffmpeg`, or set acp.voice.recordCommand.',
};

/**
 * Default recorder per platform. Every command must:
 *  - write a WAV file to the `{file}` path,
 *  - record 16 kHz mono 16-bit PCM,
 *  - finalize the WAV header on SIGINT (rec/arecord/ffmpeg all do).
 */
function platformDefault(): RecorderCommand {
  switch (process.platform) {
    case 'darwin':
      // SoX `rec`. NB: `-r 16000` asks the *device* for 16 kHz, which Core
      // Audio refuses (SoX falls back to 44.1 kHz) — the `rate` effect
      // resamples the output file instead, which always works.
      return { command: 'rec', args: ['-q', '-c', '1', '-b', '16', '{file}', 'rate', '16000'] };
    case 'linux':
      // ALSA arecord — present on most desktop Linux distros. The default
      // device is the plug layer, so `-r 16000` resamples transparently.
      return { command: 'arecord', args: ['-q', '-r', '16000', '-c', '1', '-f', 'S16_LE', '-t', 'wav', '{file}'] };
    case 'win32':
      // SoX is the least painful Windows option (ffmpeg dshow needs a device name).
      // NB: Windows SoX ships `sox.exe` (no `rec` alias); `-d` fails with
      // "no default audio device configured", so use the waveaudio driver
      // explicitly: `-t waveaudio default`.
      //
      // The `rate 16000` effect is a SOFTWARE resampler (runs after capture),
      // not a device-rate request — the waveaudio driver captures at the
      // device's native rate (typically 48 kHz), then SoX resamples the PCM
      // stream to 16 kHz before writing the file. This is required for two
      // reasons:
      //   1. The `silence` effect's percentage threshold (3%) is calibrated
      //      for 16 kHz; at 48 kHz the same noise floor reads higher and the
      //      endpointer fires prematurely (take ends ~0.1 s after speech
      //      onset instead of after 2.5 s of trailing silence).
      //   2. whisper.cpp expects 16 kHz input; resampling here avoids a
      //      second resample in the STT server.
      // Do NOT use `-r 16000` (device-rate request) — the Windows waveaudio
      // driver does not honour it and SoX falls back to the native rate.
      return { command: 'sox', args: ['-q', '-t', 'waveaudio', 'default', '-c', '1', '-b', '16', '{file}', 'rate', '16000'] };
    default:
      throw new Error(`Voice input: unsupported platform "${process.platform}". Set acp.voice.recordCommand.`);
  }
}

/** Parse a configured command template like `rec -q -r 16000 {file}` into command + args.
 * Supports double-quoted paths with spaces, e.g.
 * `"C:\Program Files\sox\rec.exe" -q -c 1 -b 16 {file} rate 16000`.
 * A bare command (no quotes) is split on whitespace as before. */
export function parseRecordCommand(template: string): RecorderCommand {
  const tokens: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template.trim())) !== null) {
    tokens.push(m[1] !== undefined ? m[1] : m[2]);
  }
  if (tokens.length === 0) {
    throw new Error('Voice input: acp.voice.recordCommand is empty.');
  }
  if (!tokens.includes('{file}')) {
    throw new Error('Voice input: acp.voice.recordCommand must contain the {file} placeholder.');
  }
  return { command: tokens[0], args: tokens.slice(1) };
}

export function resolveRecorderCommand(configured: string | undefined): RecorderCommand {
  const cmd = configured && configured.trim() ? parseRecordCommand(configured) : platformDefault();
  return cmd;
}

/**
 * Standard install dirs probed when PATH lookup fails. GUI-launched editors
 * (Cursor/VS Code from Finder/Spotlight) inherit a minimal PATH WITHOUT
 * /opt/homebrew/bin, so `which rec` fails inside the extension host even
 * though SoX is installed. This is deterministic resolution of well-known
 * locations — not a fallback chain: if the binary is nowhere, we throw.
 */
const STANDARD_BIN_DIRS =
  process.platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin', '/opt/homebrew/sbin', '/usr/local/sbin'];

/**
 * Resolve a recorder command to an absolute executable path.
 * Throws (with install hint) if the binary cannot be found anywhere.
 */
export async function resolveBinaryPath(command: string): Promise<string> {
  // Absolute/relative path with a separator → check the file directly.
  if (command.includes('/') || command.includes('\\')) {
    if (!fs.existsSync(command)) {
      throw new Error(`Voice input: recorder binary not found at "${command}".`);
    }
    return command;
  }
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileAsync(probe, [command]);
    const found = stdout.trim().split('\n')[0].trim();
    if (found) {
      return found;
    }
  } catch {
    // PATH lookup failed — probe standard install dirs (see STANDARD_BIN_DIRS).
  }
  for (const dir of STANDARD_BIN_DIRS) {
    const candidate = path.join(dir, command);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  const hint = INSTALL_HINTS[command] ?? `Install "${command}" or set acp.voice.recordCommand.`;
  throw new Error(
    `Voice input: recorder binary "${command}" not found on PATH` +
      (STANDARD_BIN_DIRS.length ? ` or in ${STANDARD_BIN_DIRS.join(', ')}` : '') +
      `. ${hint} (Editors launched from Finder/Spotlight have a minimal PATH — ` +
      `an absolute path in acp.voice.recordCommand always works.)`,
  );
}

/**
 * Build the final argv: replace {file} with the output path and, when
 * silence auto-stop is enabled and the recorder is SoX `rec`, append the
 * silence effect: after speech is detected (≥0.1s above threshold), stop on
 * `silenceAutoStopSec` seconds below threshold. Requiring speech FIRST means
 * the recorder never stops before the user starts talking. The leading gate
 * is deliberately short (0.1s) — a longer gate eats soft speech onsets
 * ("GitHub 上面" → "Cup 上面" was traced to this). Other recorders
 * (arecord/ffmpeg) have no equivalent one-liner — their users get manual
 * stop only (or add the effect themselves via acp.voice.recordCommand).
 */
export function buildRecorderArgs(
  cmd: RecorderCommand,
  filePath: string,
  silenceAutoStopSec: number,
  silenceThresholdPct = 3,
): string[] {
  const args = cmd.args.map((a) => (a === '{file}' ? filePath : a));
  // SoX ships as `rec` on Unix and as `sox` (with `-d` for the default input
  // device) on Windows — both accept the same `silence` effect.
  const base = path.basename(cmd.command).toLowerCase();
  if (silenceAutoStopSec > 0 && (base === 'rec' || base === 'sox' || base === 'sox.exe')) {
    const thr = `${silenceThresholdPct}%`;
    args.push('silence', '1', '0.1', thr, '1', String(silenceAutoStopSec), thr);
  }
  return args;
}

/**
 * Repair the RIFF size fields of a WAV whose recorder was hard-killed before
 * it could finalize the header (on Windows, Node's proc.kill('SIGINT') IS
 * TerminateProcess — SoX never patches its placeholder sizes, and strict
 * parsers like SoX/whisper.cpp then reject the file with "RIFF header not
 * found"-class errors). Walks the chunk table rather than assuming a
 * canonical 44-byte layout (SoX may insert extra chunks). No-op when the
 * sizes are already correct. Returns true when the file is usable.
 */
export function repairWavHeader(filePath: string): boolean {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(filePath);
  } catch {
    return false;
  }
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return false;
  }
  let off = 12;
  let dataSizeOff = -1;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      dataSizeOff = off + 4;
      break;
    }
    // Chunks are word-aligned; a bogus size means the header is beyond repair.
    if (off + 8 + size > buf.length + 1) {
      return false;
    }
    off += 8 + size + (size % 2);
  }
  if (dataSizeOff < 0) {
    return false;
  }
  // A hard kill can truncate mid-sample; 16-bit PCM needs an even byte count.
  let dataSize = buf.length - (dataSizeOff + 4);
  if (dataSize % 2 === 1) {
    dataSize -= 1;
    buf = buf.subarray(0, dataSizeOff + 4 + dataSize);
  }
  buf.writeUInt32LE(buf.length - 8, 4); // RIFF chunk size
  buf.writeUInt32LE(dataSize, dataSizeOff); // data chunk size
  try {
    fs.writeFileSync(filePath, buf);
  } catch {
    return false;
  }
  return true;
}

export class AudioRecorder {
  private proc: ChildProcess | null = null;
  private filePath: string | null = null;
  /** True once the recorder process has exited (SIGINT or natural, e.g. silence auto-stop). */
  private exited = false;
  private onNaturalExit: (() => void) | null = null;

  get isRecording(): boolean {
    return this.proc !== null && !this.exited;
  }

  get outputPath(): string | null {
    return this.filePath;
  }

  /**
   * Spawn the recorder. Throws if the binary is missing or the process fails to start.
   * opts.silenceAutoStopSec: SoX-only endpointing (see buildRecorderArgs).
   * opts.silenceThresholdPct: SoX silence gate threshold (percent of full scale).
   * opts.onNaturalExit: fired when the recorder exits on its own (auto-stop) —
   * NOT when stop()/cancel() killed it.
   * opts.onAudioFlowing: fired once (with ms since spawn) when the output
   * file starts growing past the WAV header — i.e. the device is ACTUALLY
   * capturing. On Windows with a Bluetooth headset this lags the click by up
   * to ~2s (A2DP→HFP profile switch + device open), which is exactly when
   * prefix words get lost; the UI uses this to tell the user when to speak.
   */
  async start(
    filePath: string,
    configuredCommand?: string,
    opts?: {
      silenceAutoStopSec?: number;
      silenceThresholdPct?: number;
      onNaturalExit?: () => void;
      onAudioFlowing?: (elapsedMs: number) => void;
    },
  ): Promise<void> {
    if (this.proc) {
      throw new Error('Voice input: a recording is already in progress.');
    }
    const cmd = resolveRecorderCommand(configuredCommand);
    const binary = await resolveBinaryPath(cmd.command);

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const args = buildRecorderArgs(cmd, filePath, opts?.silenceAutoStopSec ?? 0, opts?.silenceThresholdPct ?? 3);
    this.exited = false;
    this.onNaturalExit = opts?.onNaturalExit ?? null;

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      proc.stderr?.on('data', (d) => {
        stderr += String(d);
      });
      // If the process is still alive shortly after spawn, recording started.
      const startTimer = setTimeout(() => {
        proc.off('error', onError);
        proc.off('exit', onEarlyExit);
        // Persistent exit handler: a natural exit (silence auto-stop) must
        // surface so the manager can transcribe without a second click.
        proc.on('exit', () => {
          this.exited = true;
          if (this.proc === proc && this.onNaturalExit) {
            this.onNaturalExit();
          }
        });
        resolve();
      }, 400);
      const onError = (err: Error) => {
        clearTimeout(startTimer);
        reject(new Error(`Voice input: failed to start recorder "${cmd.command}": ${err.message}`));
      };
      const onEarlyExit = (code: number | null) => {
        clearTimeout(startTimer);
        reject(
          new Error(
            `Voice input: recorder "${cmd.command}" exited immediately (code ${code}). ${stderr.trim().slice(0, 300)}`,
          ),
        );
      };
      proc.once('error', onError);
      proc.once('exit', onEarlyExit);
      this.proc = proc;
      this.filePath = filePath;
    });

    // Poll for actual audio flow. Spawn returning (and even the WAV header
    // appearing) does NOT mean samples are arriving — BT profile switches and
    // slow USB device opens happen after the file is created.
    const proc = this.proc;
    if (opts?.onAudioFlowing && proc) {
      const t0 = Date.now();
      const cb = opts.onAudioFlowing;
      const poll = setInterval(() => {
        if (this.proc !== proc || this.exited) {
          clearInterval(poll);
          return;
        }
        let size = 0;
        try {
          size = fs.statSync(filePath).size;
        } catch {
          return; // file not created yet
        }
        if (size > 44) {
          clearInterval(poll);
          cb(Date.now() - t0);
        }
      }, 100);
      // Never leak the poller past 30s.
      setTimeout(() => clearInterval(poll), 30_000).unref();
    }
  }

  /**
   * Stop recording and wait for the WAV to be finalized.
   * Resolves with the output path; throws if nothing was captured.
   * Safe to call after a natural exit (silence auto-stop) — skips the kill.
   */
  async stop(): Promise<string> {
    const proc = this.proc;
    const filePath = this.filePath;
    this.proc = null;
    this.filePath = null;
    this.onNaturalExit = null;
    if (!proc || !filePath) {
      throw new Error('Voice input: no recording in progress.');
    }

    if (!this.exited) {
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        const killTimer = setTimeout(() => {
          // Recorder ignored SIGINT — force kill so we never hang the UI.
          try {
            proc.kill('SIGKILL');
          } catch {
            /* already gone */
          }
          resolve();
        }, 3000);
        proc.once('exit', () => {
          clearTimeout(killTimer);
          done();
        });
        // SIGINT: rec/arecord/ffmpeg finalize the WAV header on interrupt.
        try {
          proc.kill('SIGINT');
        } catch {
          clearTimeout(killTimer);
          resolve();
        }
      });
    }

    const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
    if (!stat || stat.size <= 44) {
      const micHint =
        process.platform === 'win32'
          ? 'Check Settings → Privacy & security → Microphone, that the default input device works, and that acp.voice.recordCommand uses `-t waveaudio default` (not `-d`). Or set acp.voice.windowsRecorder to "mci".'
          : process.platform === 'darwin'
            ? 'On macOS check System Settings → Privacy & Security → Microphone.'
            : 'Check microphone permissions and that the default capture device works.';
      throw new Error(`Voice input: recorder produced no audio. ${micHint}`);
    }
    if (process.platform === 'win32' && !repairWavHeader(filePath)) {
      throw new Error('Voice input: recorder was killed before finalizing the WAV and the header is unrepairable.');
    }
    return filePath;
  }

  /** Abort the current recording and delete the partial file. */
  cancel(): void {
    const proc = this.proc;
    const filePath = this.filePath;
    this.proc = null;
    this.filePath = null;
    this.onNaturalExit = null;
    if (proc) {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
    if (filePath) {
      fs.promises.unlink(filePath).catch(() => undefined);
    }
  }
}

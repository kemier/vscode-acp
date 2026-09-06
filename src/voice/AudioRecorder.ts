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
      return { command: 'rec', args: ['-q', '-c', '1', '-b', '16', '{file}', 'rate', '16000'] };
    default:
      throw new Error(`Voice input: unsupported platform "${process.platform}". Set acp.voice.recordCommand.`);
  }
}

/** Parse a configured command template like `rec -q -r 16000 {file}` into command + args. */
export function parseRecordCommand(template: string): RecorderCommand {
  const tokens = template.trim().split(/\s+/).filter(Boolean);
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

async function assertBinaryExists(command: string): Promise<void> {
  // Absolute/relative path with a separator → check the file directly.
  if (command.includes('/') || command.includes('\\')) {
    if (!fs.existsSync(command)) {
      throw new Error(`Voice input: recorder binary not found at "${command}".`);
    }
    return;
  }
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    await execFileAsync(probe, [command]);
  } catch {
    const hint = INSTALL_HINTS[command] ?? `Install "${command}" or set acp.voice.recordCommand.`;
    throw new Error(`Voice input: recorder binary "${command}" not found on PATH. ${hint}`);
  }
}

export class AudioRecorder {
  private proc: ChildProcess | null = null;
  private filePath: string | null = null;

  get isRecording(): boolean {
    return this.proc !== null;
  }

  get outputPath(): string | null {
    return this.filePath;
  }

  /** Spawn the recorder. Throws if the binary is missing or the process fails to start. */
  async start(filePath: string, configuredCommand?: string): Promise<void> {
    if (this.proc) {
      throw new Error('Voice input: a recording is already in progress.');
    }
    const cmd = resolveRecorderCommand(configuredCommand);
    await assertBinaryExists(cmd.command);

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const args = cmd.args.map((a) => (a === '{file}' ? filePath : a));

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(cmd.command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      proc.stderr?.on('data', (d) => {
        stderr += String(d);
      });
      // If the process is still alive shortly after spawn, recording started.
      const startTimer = setTimeout(() => {
        proc.off('error', onError);
        proc.off('exit', onEarlyExit);
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
  }

  /**
   * Stop recording and wait for the WAV to be finalized.
   * Resolves with the output path; throws if nothing was captured.
   */
  async stop(): Promise<string> {
    const proc = this.proc;
    const filePath = this.filePath;
    this.proc = null;
    this.filePath = null;
    if (!proc || !filePath) {
      throw new Error('Voice input: no recording in progress.');
    }

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

    const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
    if (!stat || stat.size <= 44) {
      throw new Error(
        'Voice input: recorder produced no audio. On macOS check System Settings → Privacy & Security → Microphone.',
      );
    }
    return filePath;
  }

  /** Abort the current recording and delete the partial file. */
  cancel(): void {
    const proc = this.proc;
    const filePath = this.filePath;
    this.proc = null;
    this.filePath = null;
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

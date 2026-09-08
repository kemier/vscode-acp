import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { RecorderStartOptions, VoiceRecorder } from './VoiceRecorder';

/**
 * Install-free Windows recorder built on MCI (`winmm.dll` / `mciSendString`) —
 * the API behind the old Windows Sound Recorder. It is part of Windows itself,
 * so dictation works on locked-down machines where SoX/ffmpeg cannot be
 * installed.
 *
 * Two deliberate design points, both forced by Windows:
 *
 * 1. **`-EncodedCommand`, not a `.ps1` file.** PowerShell's execution policy
 *    governs script *files*; commands passed inline are exempt. Encoding the
 *    script as base64 UTF-16LE therefore avoids the `AllSigned`/`Restricted`
 *    policy that corporate images usually set, without asking the user to
 *    change any policy.
 *
 * 2. **Cooperative stop via a sentinel file, not a signal.** MCI must be told
 *    `stop` and then `save "file.wav"`; a killed process writes nothing at all
 *    (on Windows `proc.kill('SIGINT')` is `TerminateProcess`). So the script
 *    polls for a sentinel path and finalizes the WAV itself. `stop()` creates
 *    that file and waits for the process to exit.
 *
 * Limitation: MCI exposes no level metering, so SoX-style silence auto-stop is
 * unavailable — takes end on the mic click or the max-duration cap. The
 * "audio flowing" signal is real, though: the script prints a marker once MCI
 * has actually opened the device and started recording.
 */

export const MCI_ALIAS = 'acpcap';
/** Printed by the script once MCI reports captured samples (not merely "record issued"). */
export const MCI_RECORDING_MARKER = '@@ACP_RECORDING@@';
export const MCI_SAVED_MARKER = '@@ACP_SAVED@@';

/**
 * Build the PowerShell program that records `outPath` until `stopPath` appears
 * (or `maxSec` elapses). Pure string building — unit tested on any platform.
 *
 * `alias` must be unique per concurrent take: MCI aliases are process-global,
 * so a second `open new type waveaudio alias acpcap` fails while the first take
 * is still open.
 *
 * Paths are embedded as single-quoted PowerShell literals with `'` doubled,
 * which is the only escape single-quoted strings recognise; that keeps user
 * temp paths containing spaces or quotes from breaking (or injecting into) the
 * script.
 */
export function buildMciScript(outPath: string, stopPath: string, maxSec: number, alias: string = MCI_ALIAS): string {
  const psLit = (s: string) => `'${s.replace(/'/g, "''")}'`;
  return [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -Namespace AcpVoice -Name Mci -MemberDefinition @"',
    '[System.Runtime.InteropServices.DllImport("winmm.dll", CharSet = System.Runtime.InteropServices.CharSet.Auto)]',
    'public static extern int mciSendString(string command, System.Text.StringBuilder buffer, int bufferSize, System.IntPtr hwnd);',
    '"@',
    'function Invoke-Mci([string]$cmd) {',
    '  $sb = New-Object System.Text.StringBuilder 512',
    '  $rc = [AcpVoice.Mci]::mciSendString($cmd, $sb, $sb.Capacity, [IntPtr]::Zero)',
    '  if ($rc -ne 0) { throw ("MCI command failed (rc=" + $rc + "): " + $cmd) }',
    '  $sb.ToString()',
    '}',
    // Format negotiation is advisory: some drivers reject individual keywords,
    // and a take at the device default is far better than no take at all.
    'function Try-Mci([string]$cmd) {',
    '  try { Invoke-Mci $cmd | Out-Null } catch { Write-Error -Message $_.Exception.Message -ErrorAction Continue }',
    '}',
    `$out = ${psLit(outPath)}`,
    `$stop = ${psLit(stopPath)}`,
    `$maxSec = ${Math.max(1, Math.floor(maxSec))}`,
    // waveaudio + 16 kHz mono 16-bit: exactly what the STT servers want, so no
    // resampling step is needed anywhere in the chain.
    //
    // CRITICAL: all recording-format parameters must be set in ONE `set`
    // command. Microsoft KB Q152180: "If some recording parameters are set at
    // one time and the balance ... at a later time, recording will proceed at a
    // default setting of 8-bits per sample, mono, and 11-kHz sampling."
    // Previously we issued 6 separate `set` commands, so MCI recorded at
    // 8-bit/11kHz while the WAV header claimed 16-bit/16kHz — the data played
    // 1.45x too fast and the 8-bit quantization floor made every take a
    // low-SNR, narrowband signal that Whisper hallucinated on. Setting all
    // params atomically fixes the capture format.
    `Invoke-Mci 'open new type waveaudio alias ${alias}' | Out-Null`,
    `Invoke-Mci 'set ${alias} time format ms' | Out-Null`,
    `Try-Mci 'set ${alias} format tag pcm channels 1 bitspersample 16 samplespersec 16000 alignment 2 bytespersec 32000'`,
    `Invoke-Mci 'record ${alias}' | Out-Null`,
    // `record` returning does NOT mean samples are arriving: a Bluetooth
    // headset (AirPods) needs 1–2 s to switch A2DP→HFP and captures nothing
    // until it does. `status position` only advances once real audio lands, so
    // poll it and report the true "safe to speak" moment. Give up after 5 s and
    // let the take proceed rather than failing on a quirky driver.
    '$t0 = Get-Date',
    '$flowDeadline = $t0.AddSeconds(5)',
    'while ((Get-Date) -lt $flowDeadline) {',
    `  $pos = 0`,
    `  try { $pos = [int](Invoke-Mci 'status ${alias} position') } catch { $pos = 0 }`,
    '  if ($pos -gt 0) { break }',
    '  Start-Sleep -Milliseconds 50',
    '}',
    `Write-Output ('${MCI_RECORDING_MARKER} ' + [int]((Get-Date) - $t0).TotalMilliseconds)`,
    '$deadline = (Get-Date).AddSeconds($maxSec)',
    'while (-not (Test-Path -LiteralPath $stop) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }',
    `Invoke-Mci 'stop ${alias}' | Out-Null`,
    `Invoke-Mci ('save ${alias} "' + $out + '"') | Out-Null`,
    `Invoke-Mci 'close ${alias}' | Out-Null`,
    `Write-Output '${MCI_SAVED_MARKER}'`,
  ].join('\n');
}

/** PowerShell `-EncodedCommand` payload: base64 of UTF-16LE source. */
export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

export class MciRecorder implements VoiceRecorder {
  /** Alias disambiguator; MCI aliases are process-global. */
  private static seq = 0;
  private proc: ChildProcess | null = null;
  private filePath: string | null = null;
  private stopPath: string | null = null;
  private exited = false;
  private stderr = '';
  /**
   * Milliseconds MCI needed to report the first captured samples, as measured
   * inside the script (-1 when unknown). On Bluetooth this is the profile
   * switch and typically 1000–2000 ms — the window where spoken words are lost.
   */
  deviceOpenMs = -1;

  get isRecording(): boolean {
    return this.proc !== null && !this.exited;
  }

  async start(filePath: string, _configuredCommand?: string, opts?: RecorderStartOptions): Promise<void> {
    if (this.proc) {
      throw new Error('Voice input: a recording is already in progress.');
    }
    if (process.platform !== 'win32') {
      throw new Error('Voice input: the MCI recorder is Windows-only.');
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const stopPath = `${filePath}.stop`;
    fs.promises.unlink(stopPath).catch(() => undefined);

    const script = buildMciScript(
      filePath,
      stopPath,
      opts?.maxDurationSec ?? 300,
      // Unique per take: MCI aliases are process-global, so overlapping takes
      // (a second mic click while the first is still opening) would collide.
      `acpcap${process.pid}x${++MciRecorder.seq}`,
    );
    const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellCommand(script)];

    await new Promise<void>((resolve, reject) => {
      const proc = spawn('powershell.exe', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      this.proc = proc;
      this.filePath = filePath;
      this.stopPath = stopPath;
      this.exited = false;
      this.stderr = '';
      const t0 = Date.now();
      let settled = false;

      proc.stderr?.on('data', (d) => {
        this.stderr += String(d);
      });
      proc.stdout?.on('data', (d) => {
        const text = String(d);
        if (text.includes(MCI_RECORDING_MARKER) && !settled) {
          settled = true;
          // The marker carries the time MCI needed to report captured samples
          // (on Bluetooth: the A2DP→HFP switch). Our own clock already covers
          // it — spawn → marker — so report that, and keep the device-side
          // number for the log.
          const reported = Number(
            text
              .slice(text.indexOf(MCI_RECORDING_MARKER) + MCI_RECORDING_MARKER.length)
              .trim()
              .split(/\s+/)[0],
          );
          this.deviceOpenMs = Number.isFinite(reported) ? reported : -1;
          opts?.onAudioFlowing?.(Date.now() - t0);
          resolve();
        }
      });
      proc.once('error', (err) => {
        this.exited = true;
        if (!settled) {
          settled = true;
          reject(
            new Error(
              `Voice input: could not launch powershell.exe for the built-in Windows recorder — ${err.message}`,
            ),
          );
        }
      });
      proc.once('exit', (code) => {
        this.exited = true;
        if (!settled) {
          settled = true;
          reject(new Error(this.startFailureMessage(code)));
          return;
        }
        // Exited after recording started but before stop() asked for it: the
        // max-duration cap fired inside the script.
        if (this.proc === proc) {
          opts?.onNaturalExit?.();
        }
      });
    });
  }

  /** Turn a PowerShell failure into something the user can act on. */
  private startFailureMessage(code: number | null): string {
    const err = this.stderr.trim().slice(0, 400);
    if (/ConstrainedLanguage|Add-Type|not allowed|System\.Management\.Automation\.PSNotSupportedException/i.test(err)) {
      return (
        'Voice input: the built-in Windows recorder needs PowerShell to compile a 6-line ' +
        'P/Invoke wrapper (Add-Type), which this machine blocks (Constrained Language Mode / ' +
        'AppLocker / WDAC). Ask for SoX to be whitelisted, or set acp.voice.captureMode to ' +
        `extensionHost if the remote host has a microphone. PowerShell said: ${err}`
      );
    }
    if (/MCI command failed/i.test(err)) {
      return (
        'Voice input: Windows refused to open a recording device. Check Settings → Privacy & ' +
        'security → Microphone → "Let desktop apps access your microphone", and that an input ' +
        `device is present and enabled. Details: ${err}`
      );
    }
    return `Voice input: the built-in Windows recorder exited (code ${code}) before recording started. ${err}`;
  }

  async stop(): Promise<string> {
    const proc = this.proc;
    const filePath = this.filePath;
    const stopPath = this.stopPath;
    this.proc = null;
    this.filePath = null;
    this.stopPath = null;
    if (!proc || !filePath || !stopPath) {
      throw new Error('Voice input: no recording in progress.');
    }

    if (!this.exited) {
      // Cooperative stop: the script sees the sentinel, saves the WAV, exits.
      try {
        fs.writeFileSync(stopPath, '');
      } catch {
        /* the max-duration cap will end the take */
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          // Never hang the UI; a kill here loses the take, which the size
          // check below reports honestly.
          try {
            proc.kill();
          } catch {
            /* already gone */
          }
          resolve();
        }, 5000);
        proc.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    fs.promises.unlink(stopPath).catch(() => undefined);

    const size = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
    if (size <= 44) {
      throw new Error(
        'Voice input: the built-in Windows recorder captured no audio. Check Settings → ' +
          'Privacy & security → Microphone and that the right input device is the default. ' +
          (this.stderr.trim() ? `PowerShell said: ${this.stderr.trim().slice(0, 300)}` : ''),
      );
    }
    return filePath;
  }

  cancel(): void {
    const proc = this.proc;
    const filePath = this.filePath;
    const stopPath = this.stopPath;
    this.proc = null;
    this.filePath = null;
    this.stopPath = null;
    if (proc) {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    }
    if (stopPath) {
      fs.promises.unlink(stopPath).catch(() => undefined);
    }
    if (filePath) {
      fs.promises.unlink(filePath).catch(() => undefined);
    }
  }
}

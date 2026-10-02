import { spawn, execFile, ChildProcess } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { log, logError } from '../utils/Logger';

const execFileAsync = promisify(execFile);

/**
 * Screen / window recorder for chat video context.
 *
 * VS Code webviews cannot capture the desktop. Recording runs in the
 * extension host via ffmpeg (required). Targets include every display
 * (extended screens) and, on macOS, individual windows listed by
 * `screencapture -l`.
 */

export type CaptureTargetKind = 'display' | 'window';

export interface CaptureTarget {
  id: string;
  kind: CaptureTargetKind;
  label: string;
  /** Platform-specific capture key (display index, window id, title…). */
  source: string;
  /** Window bounds when kind=window (macOS), used for crop. */
  bounds?: { x: number; y: number; width: number; height: number };
  /**
   * Zero-based monitor index (Windows gfxcapture). Present for display targets
   * enumerated per-monitor. `0` = primary. When absent on a Windows display
   * target, the recorder falls back to `gdigrab -i desktop` (primary only).
   */
  monitorIndex?: number;
}

export interface WindowRecorderOptions {
  /** Absolute path for the output MP4. */
  outputPath: string;
  /** Hard stop after this many seconds. */
  maxDurationSec: number;
  /** Override ffmpeg binary; empty = resolve from PATH. */
  ffmpegPath?: string;
}

function whichSync(bin: string): string | null {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* next */
      }
    }
  }
  // Homebrew / common locations when PATH is stripped in GUI apps
  const extras =
    process.platform === 'darwin'
      ? ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']
      : process.platform === 'linux'
        ? ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg']
        : [];
  for (const p of extras) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  return null;
}

export function resolveFfmpeg(configured?: string): string {
  if (configured && configured.trim()) {
    return configured.trim();
  }
  const found = whichSync('ffmpeg');
  if (!found) {
    throw new Error(
      'Screen recording requires ffmpeg. Install it (`brew install ffmpeg` / `sudo apt install ffmpeg`) or set acp.vision.ffmpegPath.',
    );
  }
  return found;
}

/**
 * Build the ffmpeg args for a Windows capture target. Exported as a pure
 * function so the arg shape (gfxcapture vs gdigrab, monitor index, window
 * title, hwdownload/fps chain) is unit-testable without spawning ffmpeg.
 */
export function buildWin32Args(
  target: CaptureTarget,
  out: string,
  gfxAvailable: boolean,
): string[] {
  const encode = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-y', out];
  // gfxcapture emits d3d11 hardware frames at a variable rate, so the filter
  // chain must hwdownload to system memory, normalize the pixel format, and pin
  // the frame rate before the software libx264 encoder.
  const gfxChain = 'hwdownload,format=bgra,format=yuv420p,fps=10';
  if (target.kind === 'window') {
    // Window by title. gfxcapture matches the title as a regex; fall back to
    // gdigrab title= when the filter is unavailable.
    if (gfxAvailable && target.source) {
      const title = target.source.replace(/'/g, "'\''");
      return ['-filter_complex', `gfxcapture=window_title='(?i)${title}':capture_cursor=1,${gfxChain}`, ...encode];
    }
    return ['-f', 'gdigrab', '-framerate', '10', '-i', `title=${target.source}`, ...encode];
  }
  // Display target.
  if (gfxAvailable && typeof target.monitorIndex === 'number') {
    // Per-monitor capture (primary = 0, extended = 1, …). This is what makes an
    // extended screen recordable — gdigrab -i desktop is primary-only.
    return ['-filter_complex', `gfxcapture=monitor_idx=${target.monitorIndex}:capture_cursor=1,${gfxChain}`, ...encode];
  }
  // No monitor index (legacy 'desktop' target or enumeration failed) → gdigrab
  // primary desktop.
  return ['-f', 'gdigrab', '-framerate', '10', '-i', 'desktop', ...encode];
}

/** Parse `screencapture -l` output into window entries (macOS). */
export function parseScreencaptureList(stdout: string): Array<{ id: string; label: string }> {
  const out: Array<{ id: string; label: string }> = [];
  // Typical line: "12345) My App - Document (com.example.app)"
  const re = /^\s*(\d+)\)\s+(.+?)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stdout)) !== null) {
    const id = m[1];
    const label = m[2].trim();
    if (!id || !label) continue;
    // Skip empty / utility windows that are not useful to record
    if (/^Window Server/i.test(label)) continue;
    out.push({ id, label });
  }
  return out;
}

/** Parse ffmpeg avfoundation device list (macOS). */
export function parseAvfoundationDisplays(stderr: string): Array<{ index: string; label: string }> {
  const out: Array<{ index: string; label: string }> = [];
  // AVFoundation lists video devices then audio. Capture video section only.
  const videoSection = stderr.split(/AVFoundation\s+audio devices/i)[0] || stderr;
  const re = /\[(\d+)\]\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(videoSection)) !== null) {
    const index = m[1];
    const label = m[2].trim();
    if (!label) continue;
    // Skip cameras; prefer Capture screen / Display
    if (/camera|facetime|webcam/i.test(label) && !/capture screen|display/i.test(label)) {
      continue;
    }
    out.push({ index, label });
  }
  return out;
}

async function listMacTargets(): Promise<CaptureTarget[]> {
  const targets: CaptureTarget[] = [];
  const ffmpeg = resolveFfmpeg();
  try {
    const { stderr } = await execFileAsync(ffmpeg, ['-f', 'avfoundation', '-list_devices', 'true', '-i', ''], {
      timeout: 8000,
      encoding: 'utf8',
    }).catch((err: any) => ({ stdout: '', stderr: String(err?.stderr || err?.message || '') }));
    const displays = parseAvfoundationDisplays(stderr);
    for (const d of displays) {
      targets.push({
        id: `display:${d.index}`,
        kind: 'display',
        label: `Display: ${d.label}`,
        source: d.index,
      });
    }
  } catch (err) {
    logError('[vision] failed to list avfoundation displays', err);
  }

  try {
    const { stdout } = await execFileAsync('screencapture', ['-l'], { timeout: 8000, encoding: 'utf8' });
    for (const w of parseScreencaptureList(stdout)) {
      targets.push({
        id: `window:${w.id}`,
        kind: 'window',
        label: `Window: ${w.label}`,
        source: w.id,
      });
    }
  } catch (err) {
    log(`[vision] screencapture -l failed (window list unavailable): ${String(err)}`);
  }

  if (targets.length === 0) {
    // Fallback: assume display 1 (screen) exists on Mac
    targets.push({
      id: 'display:1',
      kind: 'display',
      label: 'Display: Main screen',
      source: '1',
    });
  }
  return targets;
}

async function macWindowBounds(windowId: string): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const script = `
tell application "System Events"
  set matched to false
  repeat with p in (every process whose background only is false)
    repeat with w in (every window of p)
      try
        if (id of w as string) is "${windowId}" then
          set {x, y} to position of w
          set {ww, hh} to size of w
          return (x as string) & "," & (y as string) & "," & (ww as string) & "," & (hh as string)
        end if
      end try
    end repeat
  end repeat
end tell
return ""
`;
  try {
    const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 10000, encoding: 'utf8' });
    const parts = stdout.trim().split(',').map((s) => Number(s.trim()));
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n) && n >= 0)) {
      const [x, y, width, height] = parts;
      if (width < 8 || height < 8) return null;
      return { x, y, width, height };
    }
  } catch (err) {
    log(`[vision] osascript window bounds failed: ${String(err)}`);
  }
  return null;
}

/**
 * Enumerate Windows monitors via PowerShell (System.Windows.Forms.Screen).
 * Returns one entry per display, in Windows enumeration order (index 0 =
 * primary). Used to build per-monitor gfxcapture targets so an extended
 * screen shows up as its own pickable display instead of being hidden behind
 * `gdigrab -i desktop` (primary only).
 */
async function listWindowsMonitors(): Promise<Array<{ index: number; label: string; width: number; height: number }>> {
  // PowerShell enumerates System.Windows.Forms.Screen.AllScreens and emits JSON.
  // The label is built in JS (not PS) to avoid quote-escaping headaches across
  // the JS→PS boundary. PS only returns Index/Width/Height/Primary.
  const ps =
    "Add-Type -AssemblyName System.Windows.Forms; " +
    "[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { " +
    "$i = [System.Windows.Forms.Screen]::AllScreens.IndexOf($_); " +
    "$b = $_.Bounds; " +
    "[pscustomobject]@{ Index=$i; Width=$b.Width; Height=$b.Height; Primary=$_.Primary } " +
    "} | ConvertTo-Json -Compress";
  try {
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      timeout: 8000,
      encoding: 'utf8',
      windowsHide: true,
    });
    const parsed = JSON.parse(stdout.trim());
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr
      .filter((m: any) => m && typeof m.Index === 'number' && m.Width > 0)
      .map((m: any) => {
        const idx = m.Index as number;
        const w = m.Width as number;
        const h = m.Height as number;
        const kind = m.Primary ? 'Primary' : `Extended ${idx}`;
        return { index: idx, label: `${kind} (${w}\u00d7${h})`, width: w, height: h };
      });
  } catch (err) {
    log(`[vision] PowerShell monitor enumeration failed: ${String(err)}`);
    return [];
  }
}

let _gfxcaptureAvailable: boolean | null = null;
/**
 * Probe whether the ffmpeg build supports the `gfxcapture` filter (Windows
 * Graphics Capture, added in FFmpeg 8.1). Cached after the first check.
 * Returns null when it cannot be determined (treated as unavailable, so the
 * caller falls back to gdigrab).
 */
async function gfxcaptureAvailable(ffmpeg: string): Promise<boolean> {
  if (_gfxcaptureAvailable !== null) return _gfxcaptureAvailable;
  try {
    const { stdout } = await execFileAsync(ffmpeg, ['-hide_banner', '-filters'], {
      timeout: 8000,
      encoding: 'utf8',
      windowsHide: true,
    });
    _gfxcaptureAvailable = /\bgfxcapture\b/.test(stdout);
  } catch (err) {
    log(`[vision] gfxcapture probe failed: ${String(err)}`);
    _gfxcaptureAvailable = false;
  }
  return _gfxcaptureAvailable;
}

async function listWindowsTargets(configuredFfmpeg?: string): Promise<CaptureTarget[]> {
  // Probe for gfxcapture to offer per-monitor + window targets. resolveFfmpeg()
  // honors the configured acp.vision.ffmpegPath first (a custom install not on
  // PATH), then falls back to PATH probing. It throws when neither finds
  // ffmpeg — catch that and degrade to the basic gdigrab targets so the picker
  // still works; the real "ffmpeg required" error surfaces at start() time,
  // exactly as before this feature existed.
  let gfx = false;
  try {
    const ffmpeg = resolveFfmpeg(configuredFfmpeg);
    gfx = await gfxcaptureAvailable(ffmpeg);
  } catch (err) {
    log(`[vision] ffmpeg not resolvable for target listing (${String(err)}); showing basic targets`);
  }
  const targets: CaptureTarget[] = [];

  if (gfx) {
    // gfxcapture is available: enumerate each monitor as its own target so an
    // extended screen is pickable, plus a window-by-title option.
    const monitors = await listWindowsMonitors();
    if (monitors.length > 0) {
      for (const m of monitors) {
        targets.push({
          id: `display:monitor-${m.index}`,
          kind: 'display',
          label: `Display: ${m.label}`,
          source: String(m.index),
          monitorIndex: m.index,
        });
      }
    } else {
      // Enumeration failed (e.g. PowerShell blocked) — fall back to the single
      // primary target so recording still works.
      targets.push({
        id: 'display:monitor-0',
        kind: 'display',
        label: 'Display: Primary',
        source: '0',
        monitorIndex: 0,
      });
    }
    // Window-by-title: the user types the title in the QuickPick free-text box.
    targets.push({
      id: 'window:title',
      kind: 'window',
      label: 'Window: (type a window title below)',
      source: '',
    });
  } else {
    // No gfxcapture in this ffmpeg build — fall back to gdigrab, which can only
    // do the primary desktop or a window by title.
    targets.push({
      id: 'display:desktop',
      kind: 'display',
      label: 'Display: Entire desktop',
      source: 'desktop',
    });
    targets.push({
      id: 'window:title',
      kind: 'window',
      label: 'Window: (type a window title below)',
      source: '',
    });
  }
  return targets;
}

async function listLinuxTargets(): Promise<CaptureTarget[]> {
  const display = process.env.DISPLAY || ':0.0';
  return [
    {
      id: `display:${display}`,
      kind: 'display',
      label: `Display: ${display}`,
      source: display,
    },
  ];
}

/** Enumerate recordable displays (and windows on macOS). */
export async function listCaptureTargets(ffmpegPath?: string): Promise<CaptureTarget[]> {
  switch (process.platform) {
    case 'darwin':
      return listMacTargets();
    case 'win32':
      return listWindowsTargets(ffmpegPath);
    case 'linux':
      return listLinuxTargets();
    default:
      throw new Error(`Screen recording: unsupported platform "${process.platform}".`);
  }
}

export class WindowRecorder {
  private child: ChildProcess | null = null;
  private outputPath: string | null = null;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;

  get isRecording(): boolean {
    return this.child !== null && !this.stopping;
  }

  async start(target: CaptureTarget, opts: WindowRecorderOptions): Promise<void> {
    if (this.child) {
      throw new Error('Screen recording: a recording is already in progress.');
    }
    const ffmpeg = resolveFfmpeg(opts.ffmpegPath);
    const out = opts.outputPath;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    if (fs.existsSync(out)) {
      fs.unlinkSync(out);
    }

    let bounds = target.bounds;
    if (process.platform === 'darwin' && target.kind === 'window' && !bounds) {
      bounds = (await macWindowBounds(target.source)) ?? undefined;
      if (!bounds) {
        throw new Error(
          `Screen recording: could not resolve bounds for window "${target.label}". Grant Accessibility permission to the editor, or pick a Display instead.`,
        );
      }
    }

    const args = await this.buildArgs(ffmpeg, target, out, bounds);
    log(`[vision] starting ffmpeg: ${ffmpeg} ${args.join(' ')}`);
    this.outputPath = out;
    this.stopping = false;

    await new Promise<void>((resolve, reject) => {
      // stdin MUST be a pipe: we stop ffmpeg by writing `q` (its graceful-quit
      // key), which finalizes the MP4 moov atom. On Windows `child.kill()` is
      // TerminateProcess — a hard kill that skips finalize and leaves a
      // moov-less, unreadable MP4. See stop().
      const child = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] });
      this.child = child;
      let stderr = '';
      child.stderr?.on('data', (buf: Buffer) => {
        stderr += buf.toString('utf8');
        if (stderr.length > 8000) stderr = stderr.slice(-4000);
      });
      // ffmpeg writes header then starts; give it a moment to fail fast
      const failTimer = setTimeout(() => {
        if (this.child === child) resolve();
      }, 800);
      child.once('error', (err) => {
        clearTimeout(failTimer);
        this.child = null;
        reject(err);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(failTimer);
        if (this.stopping) return;
        if (code && code !== 0 && !fs.existsSync(out)) {
          this.child = null;
          reject(new Error(`Screen recording: ffmpeg exited (${code}/${signal}). ${stderr.slice(-500)}`));
        }
      });
    });

    const maxMs = Math.max(5, opts.maxDurationSec) * 1000;
    this.maxTimer = setTimeout(() => {
      log(`[vision] max duration ${opts.maxDurationSec}s reached — stopping`);
      void this.stop().catch((err) => logError('[vision] auto-stop failed', err));
    }, maxMs);
  }

  private async buildArgs(
    _ffmpeg: string,
    target: CaptureTarget,
    out: string,
    bounds?: { x: number; y: number; width: number; height: number },
  ): Promise<string[]> {
    // Common encode: H.264 MP4, modest bitrate for API size limits.
    //
    // NO -movflags +faststart: faststart rewrites the moov atom to the front
    // of the file on finalize, so a client ffmpeg killed mid-write (the 5s
    // stop timeout, or the client window closing) leaves a file with no moov
    // and the host's frame extractor rejects it ("moov atom not found") — the
    // take is lost. Writing the moov at the end keeps every prefix of the
    // file a playable MP4: a truncated take degrades to "shorter video"
    // instead of "unreadable file".
    const encode = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-y', out];

    if (process.platform === 'darwin') {
      // Capture the screen device. Window targets crop via vf.
      const screenIndex = target.kind === 'display' ? target.source : '1';
      const args = ['-f', 'avfoundation', '-framerate', '10', '-capture_cursor', '1', '-i', `${screenIndex}:none`];
      if (target.kind === 'window' && bounds) {
        // Even dimensions required by yuv420p
        const w = bounds.width - (bounds.width % 2);
        const h = bounds.height - (bounds.height % 2);
        args.push('-vf', `crop=${w}:${h}:${Math.max(0, bounds.x)}:${Math.max(0, bounds.y)}`);
      }
      return [...args, ...encode];
    }

    if (process.platform === 'win32') {
      const gfx = await gfxcaptureAvailable(_ffmpeg);
      return buildWin32Args(target, out, gfx);
    }

    // Linux x11grab
    const display = target.source || process.env.DISPLAY || ':0.0';
    return ['-f', 'x11grab', '-framerate', '10', '-i', display, ...encode];
  }

  /**
   * Stop recording and wait for the MP4 to finalize.
   * Returns the output path and byte size.
   */
  async stop(): Promise<{ path: string; bytes: number }> {
    if (!this.child || !this.outputPath) {
      throw new Error('Screen recording: nothing is recording.');
    }
    if (this.maxTimer) {
      clearTimeout(this.maxTimer);
      this.maxTimer = null;
    }
    this.stopping = true;
    const child = this.child;
    const out = this.outputPath;

    await new Promise<void>((resolve) => {
      const done = () => {
        this.child = null;
        resolve();
      };
      child.once('exit', () => done());
      // Stop ffmpeg GRACEFULLY by writing `q` to its stdin — ffmpeg reads `q`
      // as "quit" on every platform and finalizes the MP4 (writes the moov
      // atom) before exiting. Do NOT use child.kill() here: on Windows that is
      // TerminateProcess, an immediate hard kill that skips finalize and leaves
      // a moov-less file the host frame extractor rejects ("moov atom not
      // found"). SIGINT is the Unix equivalent but `q` works uniformly.
      try {
        if (child.stdin && !child.stdin.destroyed) {
          child.stdin.write('q');
          child.stdin.end();
        } else {
          // No stdin (should not happen) — fall back to a signal.
          child.kill(process.platform === 'win32' ? undefined : 'SIGINT');
        }
      } catch {
        done();
      }
      // If ffmpeg is stuck (slow disk flush after a long take), SIGKILL after
      // 5s so the UI never hangs — the take then surfaces a clear truncation
      // error instead of a silent hang.
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        done();
      }, 5000);
    });

    // Brief wait for filesystem flush
    await new Promise((r) => setTimeout(r, 200));
    if (!fs.existsSync(out)) {
      throw new Error('Screen recording: ffmpeg produced no output file.');
    }
    const bytes = fs.statSync(out).size;
    if (bytes < 256) {
      throw new Error('Screen recording: output file is empty or truncated.');
    }
    this.outputPath = null;
    this.stopping = false;
    return { path: out, bytes };
  }

  async cancel(): Promise<void> {
    if (!this.child) return;
    const out = this.outputPath;
    try {
      await this.stop();
    } catch {
      /* ignore */
    }
    if (out && fs.existsSync(out)) {
      try {
        fs.unlinkSync(out);
      } catch {
        /* ignore */
      }
    }
  }
}

/** Temp path for a new take. */
export function nextTakePath(): string {
  const dir = path.join(os.tmpdir(), 'acp-vision');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `take-${Date.now()}.mp4`);
}

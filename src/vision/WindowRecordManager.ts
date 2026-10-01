import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
  WindowRecorder,
  listCaptureTargets,
  nextTakePath,
  type CaptureTarget,
} from './WindowRecorder';
import {
  CompanionScreenRecorder,
  listCompanionCaptureTargets,
  screenCompanionAvailable,
  COMPANION_SCREEN_INSTALL_HINT,
} from './CompanionScreenRecorder';
import { analyzeVideo, readVisionConfigFromWorkspace, VisionError } from './VideoVisionClient';
import { extractVideoFrames } from './FrameExtractor';
import { log, logError } from '../utils/Logger';

/**
 * Orchestrates window/display recording for the chat composer.
 *
 * State: idle → picking → recording → processing → idle.
 * On stop, the take is held as a pending attachment until the next send,
 * where it is either analyzed via VideoVisionClient or converted to frames.
 */

export type ScreenRecordState = 'idle' | 'recording' | 'processing';

export type ScreenRecordEvent =
  | { type: 'state'; state: ScreenRecordState }
  | { type: 'pending'; label: string; path: string; bytes: number }
  | { type: 'cleared' }
  | { type: 'error'; message: string };

export interface PendingVideo {
  path: string;
  label: string;
  bytes: number;
  sessionId: string | null;
}

interface VisionSettings {
  enabled: boolean;
  endpoint: string;
  apiKey: string;
  model: string;
  provider: 'openai-compat' | 'gemini';
  timeoutMs: number;
  inlineMaxBytes: number;
  prompt: string;
  maxDurationSec: number;
  ffmpegPath: string;
  maxFrames: number;
}

function readSettings(): VisionSettings {
  const cfg = vscode.workspace.getConfiguration('acp.vision');
  const base = readVisionConfigFromWorkspace((key, def) => cfg.get(key, def));
  return {
    enabled: cfg.get<boolean>('enabled', true),
    ...base,
    maxDurationSec: cfg.get<number>('maxDurationSec', 90),
    ffmpegPath: cfg.get<string>('ffmpegPath', ''),
    maxFrames: cfg.get<number>('maxFrames', 8),
  };
}

export class WindowRecordManager {
  private state: ScreenRecordState = 'idle';
  private recorder: WindowRecorder | CompanionScreenRecorder | null = null;
  private boundSessionId: string | null = null;
  private currentTarget: CaptureTarget | null = null;
  private pending: PendingVideo | null = null;
  private starting = false;

  constructor(
    private readonly onEvent: (evt: ScreenRecordEvent) => void,
    private readonly getActiveSessionId: () => string | undefined,
  ) {}

  get currentState(): ScreenRecordState {
    return this.state;
  }

  get pendingVideo(): PendingVideo | null {
    return this.pending;
  }

  clearPending(): void {
    if (this.pending?.path && fs.existsSync(this.pending.path)) {
      try {
        fs.unlinkSync(this.pending.path);
      } catch {
        /* ignore */
      }
    }
    this.pending = null;
    this.onEvent({ type: 'cleared' });
  }

  /**
   * Mic-style toggle: idle → pick target + record; recording → stop + attach.
   */
  async toggle(): Promise<void> {
    const settings = readSettings();
    if (!settings.enabled) {
      this.onEvent({ type: 'error', message: 'Screen recording is disabled (acp.vision.enabled).' });
      return;
    }
    if (this.state === 'processing' || this.starting) {
      return;
    }
    if (this.state === 'recording') {
      await this.stopAndAttach();
      return;
    }
    await this.startWithPicker();
  }

  async cancel(): Promise<void> {
    if (this.recorder) {
      try {
        await this.recorder.cancel();
      } catch {
        /* ignore */
      }
      this.recorder = null;
    }
    this.setState('idle');
    this.currentTarget = null;
    this.boundSessionId = null;
  }

  /**
   * Consume the pending take for a sendPrompt.
   * Returns either a text analysis block and/or image frames.
   */
  async consumeForPrompt(opts: {
    agentSupportsImage: boolean;
  }): Promise<{ text?: string; images?: Array<{ data: string; mimeType: string }>; pill?: string }> {
    const take = this.pending;
    if (!take) return {};
    // Detach pending so a concurrent clear doesn't double-free
    this.pending = null;
    this.onEvent({ type: 'cleared' });

    const settings = readSettings();
    this.setState('processing');
    try {
      if (settings.endpoint.trim()) {
        const summary = await analyzeVideo(take.path, {
          endpoint: settings.endpoint,
          apiKey: settings.apiKey,
          model: settings.model,
          provider: settings.provider,
          timeoutMs: settings.timeoutMs,
          inlineMaxBytes: settings.inlineMaxBytes,
          prompt: settings.prompt,
        });
        return {
          text: `<screen_recording label="${escapeXml(take.label)}" bytes="${take.bytes}">\n${summary}\n</screen_recording>`,
          pill: `Video: ${take.label}`,
        };
      }
      if (opts.agentSupportsImage) {
        const frames = await extractVideoFrames(take.path, {
          maxFrames: settings.maxFrames,
          ffmpegPath: settings.ffmpegPath || undefined,
        });
        return {
          images: frames,
          pill: `Video frames: ${frames.length} from ${take.label}`,
          text: `[Screen recording frames from: ${take.label}]`,
        };
      }
      throw new VisionError(
        'Screen recording captured, but acp.vision.endpoint is empty and the agent does not support images. Configure a video API (e.g. StepFun) or use an image-capable agent.',
      );
    } finally {
      try {
        if (fs.existsSync(take.path)) fs.unlinkSync(take.path);
      } catch {
        /* ignore */
      }
      this.setState('idle');
    }
  }

  /** Attach a local video file for the same vision path as a screen recording. */
  async attachVideoFile(filePath: string): Promise<void> {
    const settings = readSettings();
    if (!settings.enabled) {
      this.onEvent({ type: 'error', message: 'Screen/video input is disabled (acp.vision.enabled).' });
      return;
    }
    if (!fs.existsSync(filePath)) {
      this.onEvent({ type: 'error', message: `Video file not found: ${filePath}` });
      return;
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 256) {
      this.onEvent({ type: 'error', message: 'Attached file is empty or not a file.' });
      return;
    }
    // Replace any previous pending take
    if (this.pending?.path && this.pending.path !== filePath && fs.existsSync(this.pending.path)) {
      try {
        fs.unlinkSync(this.pending.path);
      } catch {
        /* ignore */
      }
    }
    const label = `File: ${path.basename(filePath)}`;
    this.pending = {
      path: filePath,
      label,
      bytes: stat.size,
      sessionId: this.getActiveSessionId() ?? null,
    };
    this.onEvent({ type: 'pending', label, path: filePath, bytes: stat.size });
    log(`[vision] attached video file: ${filePath} (${stat.size} bytes)`);
  }

  private setState(state: ScreenRecordState): void {
    this.state = state;
    this.onEvent({ type: 'state', state });
  }

  private async startWithPicker(): Promise<void> {
    this.starting = true;
    try {
      const remote = !!vscode.env.remoteName;
      let targets: CaptureTarget[];
      let useCompanion = false;
      if (remote) {
        if (!(await screenCompanionAvailable())) {
          throw new Error(COMPANION_SCREEN_INSTALL_HINT);
        }
        targets = await listCompanionCaptureTargets();
        useCompanion = true;
      } else {
        targets = await listCaptureTargets();
      }
      const picked = await vscode.window.showQuickPick(
        targets.map((t) => ({
          label: t.label,
          description: t.kind,
          detail: t.id,
          target: t,
        })),
        {
          title: 'Record screen or window',
          placeHolder: 'Pick a display (incl. extended) or window',
        },
      );
      if (!picked) return;

      const settings = readSettings();
      const out = nextTakePath();
      this.recorder = useCompanion ? new CompanionScreenRecorder() : new WindowRecorder();
      this.currentTarget = picked.target;
      this.boundSessionId = this.getActiveSessionId() ?? null;
      await this.recorder.start(picked.target, {
        outputPath: out,
        maxDurationSec: settings.maxDurationSec,
        ffmpegPath: settings.ffmpegPath || undefined,
      });
      this.setState('recording');
      log(`[vision] recording ${picked.target.id} → ${out}${useCompanion ? ' (companion)' : ''}`);
    } catch (err: any) {
      this.recorder = null;
      const msg = String(err?.message || err);
      logError('[vision] start failed', err);
      this.onEvent({ type: 'error', message: msg });
      this.setState('idle');
    } finally {
      this.starting = false;
    }
  }

  private async stopAndAttach(): Promise<void> {
    if (!this.recorder) {
      this.setState('idle');
      return;
    }
    this.setState('processing');
    try {
      const { path: filePath, bytes } = await this.recorder.stop();
      this.recorder = null;
      const label = this.currentTarget?.label || 'Screen recording';
      this.currentTarget = null;
      // Replace any previous pending take
      if (this.pending?.path && this.pending.path !== filePath && fs.existsSync(this.pending.path)) {
        try {
          fs.unlinkSync(this.pending.path);
        } catch {
          /* ignore */
        }
      }
      this.pending = {
        path: filePath,
        label,
        bytes,
        sessionId: this.boundSessionId,
      };
      this.onEvent({ type: 'pending', label, path: filePath, bytes });
      this.setState('idle');
      log(`[vision] take ready: ${filePath} (${bytes} bytes)`);
    } catch (err: any) {
      this.recorder = null;
      const msg = String(err?.message || err);
      logError('[vision] stop failed', err);
      this.onEvent({ type: 'error', message: msg });
      this.setState('idle');
    }
  }
}

function escapeXml(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

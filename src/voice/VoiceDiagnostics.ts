import * as vscode from 'vscode';
import { resolveBinaryPath, resolveRecorderCommand } from './AudioRecorder';
import { chooseRecorderBackend } from './chooseRecorderBackend';
import {
  companionAvailable,
  probeCompanion,
  COMPANION_INSTALL_HINT,
} from './CompanionRecorder';
import { probeStt } from './SttClient';
import type { CaptureMode } from './VoiceInputManager';

/**
 * One-page report for `ACP: Voice Input Diagnostics`.
 *
 * Covers capture routing (companion vs extension host), STT liveness, and the
 * corrector toggle — the three things that usually explain "mic does nothing"
 * / "transcript empty" / "remote records the server".
 */
export async function buildVoiceDiagnosticsReport(): Promise<string> {
  const cfg = vscode.workspace.getConfiguration('acp.voice');
  const enabled = cfg.get<boolean>('enabled', true);
  const captureMode = cfg.get<CaptureMode>('captureMode', 'auto');
  const recordCommand = cfg.get<string>('recordCommand', '') || undefined;
  const windowsRecorder = cfg.get<'auto' | 'mci' | 'binary'>('windowsRecorder', 'auto');
  const sttEndpoint = cfg.get<string>('stt.endpoint', 'http://127.0.0.1:8080/inference');
  const sttModel = cfg.get<string>('stt.model', 'whisper-1');
  const correctorEnabled = cfg.get<boolean>('corrector.enabled', false);
  const correctorEndpoint = cfg.get<string>(
    'corrector.endpoint',
    'http://127.0.0.1:11434/v1/chat/completions',
  );
  const correctorModel = cfg.get<string>('corrector.model', 'qwen2.5:7b');

  const remote = vscode.env.remoteName ?? null;
  const companionOk = await companionAvailable();
  const companion = companionOk ? await probeCompanion() : null;

  const wantCompanion = captureMode === 'localCompanion' || (captureMode === 'auto' && Boolean(remote));
  let effective: string;
  if (captureMode === 'extensionHost') {
    effective = 'extension host (this process)';
  } else if (wantCompanion && companionOk) {
    effective = 'local companion (client machine)';
  } else if (wantCompanion && !companionOk) {
    effective = captureMode === 'localCompanion'
      ? 'local companion REQUIRED but missing'
      : 'extension host (companion missing — remote will try server mic)';
  } else {
    effective = 'extension host (this process)';
  }

  const lines: string[] = [
    `enabled:           ${enabled}`,
    `remote:            ${remote ?? '(local window)'}`,
    `captureMode:       ${captureMode}`,
    `effective capture: ${effective}`,
  ];

  if (companionOk && companion) {
    const backend = companion.backend ? `backend=${companion.backend}` : 'backend=?';
    const reason = companion.backendReason ? ` (${companion.backendReason})` : '';
    const rec = companion.recorder
      ? `recorder=${companion.recorder}`
      : companion.recorderError
        ? `recorder=ERROR ${companion.recorderError}`
        : 'recorder=?';
    lines.push(`companion:         installed & activated`);
    lines.push(
      `companion detail:  v${companion.version} on ${companion.platform}, protocol=${companion.protocol}, ${backend}${reason}; ${rec}`,
    );
  } else if (wantCompanion) {
    lines.push(`companion:         NOT installed / not activated`);
    lines.push(`companion hint:    ${COMPANION_INSTALL_HINT}`);
  } else {
    lines.push(`companion:         not needed in this window (captureMode=${captureMode})`);
  }

  // Host recorder (what this process would use if it records locally).
  try {
    const chosen = await chooseRecorderBackend({ recordCommand, recorderBackend: windowsRecorder });
    const cmd = resolveRecorderCommand(recordCommand);
    let binary = cmd.command;
    try {
      binary = await resolveBinaryPath(cmd.command);
    } catch (err) {
      binary = `${cmd.command} (unresolved: ${err instanceof Error ? err.message : String(err)})`;
    }
    lines.push(`host recorder:     backend=${chosen.backend} (${chosen.reason}); binary=${binary}`);
  } catch (err) {
    lines.push(`host recorder:     ERROR ${err instanceof Error ? err.message : String(err)}`);
  }

  lines.push(`stt.endpoint:      ${sttEndpoint || '(empty)'}`);
  lines.push(`stt.model:         ${sttModel}`);
  const stt = await probeStt({
    endpoint: sttEndpoint,
    model: sttModel,
    apiKey: cfg.get<string>('stt.apiKey', ''),
    language: cfg.get<string>('stt.language', ''),
    prompt: '',
    timeoutMs: Math.min(5_000, cfg.get<number>('stt.timeoutMs', 180000)),
  });
  lines.push(
    `stt.probe:         ${stt.ok ? 'OK' : 'FAIL'} ${stt.ms}ms — ${stt.detail}${stt.source ? ` [${stt.source}]` : ''}`,
  );

  lines.push(`corrector.enabled: ${correctorEnabled}`);
  lines.push(`corrector.endpoint: ${correctorEndpoint}`);
  lines.push(`corrector.model:   ${correctorModel}`);

  return lines.join('\n');
}

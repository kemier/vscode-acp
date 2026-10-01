import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  COMPANION_EVENT_SINK,
  COMPANION_PROTOCOL,
  CompanionRecorder,
  companionAvailable,
  writeWavFromBase64,
} from '../voice/CompanionRecorder';

/**
 * The companion bridge is the only path that makes dictation work in a Remote
 * SSH window (the extension host has no access to the client microphone, and
 * webviews are denied `microphone` by Permissions Policy). These tests pin the
 * command protocol and the WAV round-trip, using the fake command registry
 * from vscode-shim.cjs as a stand-in for the UI extension host.
 */

function wav(sampleBytes: number): Buffer {
  const data = Buffer.alloc(sampleBytes);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + sampleBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(sampleBytes, 40);
  return Buffer.concat([header, data]);
}

/**
 * Drop only the fake companion's commands. The event-sink command is registered
 * once per module load (as in the real extension host), so wiping the whole
 * registry between tests would desynchronise it.
 */
function clearCommands(): void {
  const reg: Map<string, unknown> = ((globalThis as any).__acpTestCommands ||= new Map());
  for (const id of [...reg.keys()]) {
    if (id.startsWith('acpLocalCapture.')) {
      reg.delete(id);
    }
  }
}

suite('CompanionRecorder (remote-SSH local mic bridge)', () => {
  let tmp: string;

  setup(() => {
    clearCommands();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-companion-test-'));
  });

  teardown(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('writeWavFromBase64 writes the payload and reports the byte count', () => {
    const target = path.join(tmp, 'nested', 'take.wav');
    const payload = wav(3200).toString('base64');
    const bytes = writeWavFromBase64(payload, target);
    assert.strictEqual(bytes, 44 + 3200);
    assert.strictEqual(fs.statSync(target).size, 44 + 3200);
  });

  test('writeWavFromBase64 rejects a header-only (silent) take with a mic hint', () => {
    assert.throws(
      () => writeWavFromBase64(wav(0).toString('base64'), path.join(tmp, 'empty.wav')),
      /captured no audio/i,
    );
  });

  test('writeWavFromBase64 rejects a non-WAV payload', () => {
    assert.throws(
      () => writeWavFromBase64(Buffer.alloc(200, 7).toString('base64'), path.join(tmp, 'x.wav')),
      /not a WAV/i,
    );
  });

  test('companionAvailable reflects registration of acpLocalCapture.start', async () => {
    assert.strictEqual(await companionAvailable(), false);
    vscode.commands.registerCommand('acpLocalCapture.start', async () => ({ takeId: '1' }));
    assert.strictEqual(await companionAvailable(), true);
  });

  test('start/stop round-trip: client records, remote gets the WAV at the requested path', async () => {
    const started: any[] = [];
    vscode.commands.registerCommand('acpLocalCapture.start', async (args: any) => {
      started.push(args);
      return { takeId: 'take-1', protocol: COMPANION_PROTOCOL };
    });
    vscode.commands.registerCommand('acpLocalCapture.stop', async (args: any) => {
      assert.strictEqual(args.takeId, 'take-1');
      return { base64: wav(1600).toString('base64'), bytes: 44 + 1600 };
    });

    const target = path.join(tmp, 'take.wav');
    const rec = new CompanionRecorder();
    await rec.start(target, 'rec -q {file}', { silenceAutoStopSec: 2.5, silenceThresholdPct: 4 });

    // Recorder settings must be forwarded verbatim — they are resolved against
    // the CLIENT's binaries, not the remote host's.
    assert.strictEqual(started[0].recordCommand, 'rec -q {file}');
    assert.strictEqual(started[0].silenceAutoStopSec, 2.5);
    assert.strictEqual(started[0].silenceThresholdPct, 4);
    assert.strictEqual(started[0].eventCommand, COMPANION_EVENT_SINK);
    assert.strictEqual(rec.isRecording, true);

    assert.strictEqual(await rec.stop(), target);
    assert.strictEqual(fs.statSync(target).size, 44 + 1600);
    assert.strictEqual(rec.isRecording, false);
  });

  test('client-side events reach the remote callbacks through the shared registry', async () => {
    vscode.commands.registerCommand('acpLocalCapture.start', async () => ({ takeId: 'take-2' }));
    const flowing: number[] = [];
    let natural = 0;

    const rec = new CompanionRecorder();
    await rec.start(path.join(tmp, 'a.wav'), undefined, {
      onAudioFlowing: (ms) => flowing.push(ms),
      onNaturalExit: () => {
        natural += 1;
      },
    });

    // The companion fires these by executing the sink command (cross-host).
    await vscode.commands.executeCommand(COMPANION_EVENT_SINK, {
      takeId: 'take-2',
      type: 'audioFlowing',
      elapsedMs: 1800,
    });
    await vscode.commands.executeCommand(COMPANION_EVENT_SINK, {
      takeId: 'take-2',
      type: 'naturalExit',
    });
    // Events for an unknown take must be ignored, not throw.
    await vscode.commands.executeCommand(COMPANION_EVENT_SINK, {
      takeId: 'ghost',
      type: 'naturalExit',
    });

    assert.deepStrictEqual(flowing, [1800]);
    assert.strictEqual(natural, 1);
    // Natural exit = the client recorder already stopped; stop() must not hang.
    assert.strictEqual(rec.isRecording, false);
  });

  test('a companion-side stop error surfaces as a voice error, not a silent empty take', async () => {
    vscode.commands.registerCommand('acpLocalCapture.start', async () => ({ takeId: 'take-3' }));
    vscode.commands.registerCommand('acpLocalCapture.stop', async () => ({
      error: 'recorder binary "rec" not found on PATH',
    }));
    const rec = new CompanionRecorder();
    await rec.start(path.join(tmp, 'b.wav'), undefined, {});
    await assert.rejects(() => rec.stop(), /not found on PATH/);
  });

  test('start rejects with an actionable message when the companion is absent', async () => {
    const rec = new CompanionRecorder();
    await assert.rejects(
      () => rec.start(path.join(tmp, 'c.wav'), undefined, {}),
      /local companion failed to start recording/,
    );
  });
});

import * as assert from 'assert';
import {
  MCI_ALIAS,
  MCI_RECORDING_MARKER,
  MCI_SAVED_MARKER,
  buildMciScript,
  encodePowerShellCommand,
} from '../voice/MciRecorder';

/**
 * The MCI backend is what makes dictation possible on a locked-down Windows
 * laptop (nothing to install — `winmm.dll` is part of Windows). Its PowerShell
 * program cannot be exercised on Linux/macOS CI, so these tests pin the
 * properties that silently break the take when they regress:
 *  - the WAV format the STT servers expect (16 kHz mono 16-bit),
 *  - `stop` + `save` before `close` (a killed process writes nothing),
 *  - single-quote escaping of paths (spaces/quotes in %TEMP%),
 *  - UTF-16LE base64 for `-EncodedCommand` (execution policy governs *files*,
 *    not inline commands, so this is what dodges corporate AllSigned policy).
 */
suite('MciRecorder (install-free Windows capture)', () => {
  const OUT = 'C:\\Users\\Some One\\AppData\\Local\\Temp\\acp\\take-1.wav';
  const STOP = `${OUT}.stop`;

  test('records 16 kHz mono 16-bit PCM — the format the STT chain expects', () => {
    const script = buildMciScript(OUT, STOP, 120);
    assert.ok(script.includes(`open new type waveaudio alias ${MCI_ALIAS}`));
    // CRITICAL: all format params must be set in ONE `set` command.
    // Microsoft KB Q152180: setting them separately falls back to 8-bit/11kHz,
    // which makes the WAV header lie about the real sample rate/bits.
    const fmt = `set ${MCI_ALIAS} format tag pcm channels 1 bitspersample 16 samplespersec 16000 alignment 2 bytespersec 32000`;
    assert.ok(
      script.includes(`Try-Mci '${fmt}'`),
      'format params must be set atomically in a single Try-Mci command',
    );
    // No separate per-parameter set commands are allowed — they would trigger
    // the 8-bit/11kHz fallback.
    for (const set of [
      `set ${MCI_ALIAS} format tag pcm'`,
      `set ${MCI_ALIAS} channels 1'`,
      `set ${MCI_ALIAS} bitspersample 16'`,
      `set ${MCI_ALIAS} samplespersec 16000'`,
    ]) {
      assert.ok(!script.includes(set), `forbidden separate set: ${set}`);
    }
    // Format keywords are best-effort (drivers vary); the device default is
    // still transcribable, so they must not abort the take.
    assert.ok(script.includes(`Try-Mci '${fmt}'`));
    // Opening the device and starting the recording, in contrast, are fatal.
    assert.ok(script.includes(`Invoke-Mci 'record ${MCI_ALIAS}'`));
  });

  test('finalizes the WAV: stop → save → close, in that order', () => {
    const script = buildMciScript(OUT, STOP, 120);
    const iStop = script.indexOf(`stop ${MCI_ALIAS}`);
    const iSave = script.indexOf(`save ${MCI_ALIAS}`);
    const iClose = script.indexOf(`close ${MCI_ALIAS}`);
    assert.ok(iStop > 0 && iSave > iStop && iClose > iSave, `order was ${iStop}/${iSave}/${iClose}`);
  });

  test('waits for the sentinel file and honours the duration cap', () => {
    const script = buildMciScript(OUT, STOP, 90);
    assert.ok(script.includes('Test-Path -LiteralPath $stop'));
    assert.ok(script.includes('$maxSec = 90'));
    // A fractional/zero cap would make the loop exit immediately.
    assert.ok(buildMciScript(OUT, STOP, 0.4).includes('$maxSec = 1'));
  });

  test('emits progress markers the recorder parses', () => {
    const script = buildMciScript(OUT, STOP, 120);
    assert.ok(script.includes(MCI_RECORDING_MARKER));
    assert.ok(script.includes(MCI_SAVED_MARKER));
    // The "recording" marker must be printed before the wait loop, otherwise
    // start() would only resolve once the take is over.
    assert.ok(script.indexOf(MCI_RECORDING_MARKER) < script.indexOf('while (-not'));
  });

  test('waits for captured samples before saying "safe to speak"', () => {
    const script = buildMciScript(OUT, STOP, 120);
    // A Bluetooth headset (AirPods) needs 1-2s to switch A2DP->HFP; `record`
    // returning proves nothing, `status position` advancing does.
    assert.ok(script.includes(`status ${MCI_ALIAS} position`));
    const iRecord = script.indexOf(`record ${MCI_ALIAS}`);
    const iPoll = script.indexOf(`status ${MCI_ALIAS} position`);
    const iMarker = script.indexOf(MCI_RECORDING_MARKER);
    assert.ok(iRecord < iPoll && iPoll < iMarker, `order ${iRecord}/${iPoll}/${iMarker}`);
    // The poll must not block the take forever on an odd driver.
    assert.ok(script.includes('$flowDeadline'));
    // The marker carries the measured latency.
    assert.ok(script.includes(`'${MCI_RECORDING_MARKER} ' +`));
  });

  test('alias is parameterised so overlapping takes cannot collide', () => {
    const a = buildMciScript(OUT, STOP, 60, 'acpcap4242x7');
    assert.ok(a.includes('open new type waveaudio alias acpcap4242x7'));
    assert.ok(a.includes('save acpcap4242x7'));
    assert.ok(!a.includes(`alias ${MCI_ALIAS}'`), 'default alias must not leak in');
  });

  test('escapes quotes in paths instead of breaking out of the string', () => {
    const nasty = "C:\\tmp\\o'brien's take.wav";
    const script = buildMciScript(nasty, `${nasty}.stop`, 60);
    assert.ok(script.includes("$out = 'C:\\tmp\\o''brien''s take.wav'"));
    // No unescaped terminator that would let the path run as code.
    assert.ok(!script.includes("$out = 'C:\\tmp\\o'brien"));
  });

  test('backslashes survive verbatim — single-quoted PowerShell has no escapes', () => {
    const script = buildMciScript(OUT, STOP, 60);
    assert.ok(script.includes(OUT), 'Windows path must not be mangled');
  });

  test('encodePowerShellCommand produces UTF-16LE base64', () => {
    const encoded = encodePowerShellCommand('Write-Output 1');
    const round = Buffer.from(encoded, 'base64').toString('utf16le');
    assert.strictEqual(round, 'Write-Output 1');
    // UTF-16LE means an ASCII-only script decodes to NUL-interleaved bytes.
    assert.strictEqual(Buffer.from(encoded, 'base64')[1], 0);
  });
});

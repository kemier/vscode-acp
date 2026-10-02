import * as assert from 'assert';
import {
  parseScreencaptureList,
  parseAvfoundationDisplays,
  buildWin32Args,
} from '../vision/WindowRecorder';
import { buildVideoUrlPart, buildVisionMessages } from '../vision/VideoVisionClient';

suite('WindowRecorder parsing', () => {
  test('parseScreencaptureList extracts window ids', () => {
    const raw = `
12345) Terminal — zsh (com.apple.Terminal)
67890) Code - vscode-acp (com.microsoft.VSCode)
   Window Server Menubar (com.apple.WindowServer)
`;
    const list = parseScreencaptureList(raw);
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list[0].id, '12345');
    assert.ok(list[0].label.includes('Terminal'));
    assert.strictEqual(list[1].id, '67890');
  });

  test('parseAvfoundationDisplays keeps screen devices, drops cameras', () => {
    const stderr = `
[AVFoundation indev @ 0x0] AVFoundation video devices:
[AVFoundation indev @ 0x0] [0] FaceTime HD Camera
[AVFoundation indev @ 0x0] [1] Capture screen 0
[AVFoundation indev @ 0x0] [2] Capture screen 1
[AVFoundation indev @ 0x0] AVFoundation audio devices:
[AVFoundation indev @ 0x0] [0] MacBook Pro Microphone
`;
    const list = parseAvfoundationDisplays(stderr);
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list[0].index, '1');
    assert.ok(/Capture screen 0/i.test(list[0].label));
    assert.strictEqual(list[1].index, '2');
  });
});

suite('buildWin32Args (Windows multi-monitor + window capture)', () => {
  const OUT = 'C:\\temp\\take.mp4';

  test('extended monitor uses gfxcapture monitor_idx when available', () => {
    const args = buildWin32Args(
      { id: 'display:monitor-1', kind: 'display', label: 'Display: Extended 1', source: '1', monitorIndex: 1 },
      OUT,
      true,
    );
    const fc = args[args.indexOf('-filter_complex') + 1];
    assert.ok(fc.includes('gfxcapture=monitor_idx=1'), 'must target monitor index 1: ' + fc);
    assert.ok(fc.includes('capture_cursor=1'), 'cursor must be captured');
    assert.ok(fc.includes('hwdownload,format=bgra,format=yuv420p,fps=10'), 'hw frames must download + stabilize fps');
    assert.ok(args.includes(OUT), 'output path present');
  });

  test('primary monitor uses monitor_idx=0', () => {
    const args = buildWin32Args(
      { id: 'display:monitor-0', kind: 'display', label: 'Display: Primary', source: '0', monitorIndex: 0 },
      OUT,
      true,
    );
    const fc = args[args.indexOf('-filter_complex') + 1];
    assert.ok(fc.includes('gfxcapture=monitor_idx=0'), 'primary = index 0: ' + fc);
  });

  test('window by title uses gfxcapture window_title when available', () => {
    const args = buildWin32Args(
      { id: 'window:Code', kind: 'window', label: 'Window: Code', source: 'Code - vscode-acp' },
      OUT,
      true,
    );
    const fc = args[args.indexOf('-filter_complex') + 1];
    assert.ok(fc.includes('gfxcapture=window_title='), 'must use window_title: ' + fc);
    assert.ok(fc.includes('(?i)Code - vscode-acp'), 'title embedded case-insensitively');
    assert.ok(fc.includes('hwdownload,format=bgra,format=yuv420p,fps=10'));
  });

  test('falls back to gdigrab desktop when gfxcapture is unavailable', () => {
    const args = buildWin32Args(
      { id: 'display:monitor-1', kind: 'display', label: 'Display: Extended 1', source: '1', monitorIndex: 1 },
      OUT,
      false,
    );
    assert.ok(args.includes('gdigrab'), 'must use gdigrab: ' + args.join(' '));
    assert.ok(args.includes('desktop'), 'gdigrab desktop (primary-only) when no gfx');
    assert.ok(!args.includes('-filter_complex'), 'no gfxcapture filter');
  });

  test('falls back to gdigrab title= for a window when gfxcapture is unavailable', () => {
    const args = buildWin32Args(
      { id: 'window:Calc', kind: 'window', label: 'Window: Calc', source: 'Calculator' },
      OUT,
      false,
    );
    assert.ok(args.includes('gdigrab'));
    assert.ok(args.includes('title=Calculator'), 'gdigrab title= fallback: ' + args.join(' '));
  });

  test('a display target without monitorIndex falls back to gdigrab desktop', () => {
    // Legacy 'desktop' target (no monitorIndex) must still work even when gfx
    // is available — it has no per-monitor index to pass.
    const args = buildWin32Args(
      { id: 'display:desktop', kind: 'display', label: 'Display: Entire desktop', source: 'desktop' },
      OUT,
      true,
    );
    assert.ok(args.includes('gdigrab'), 'no monitorIndex → gdigrab: ' + args.join(' '));
    assert.ok(args.includes('desktop'));
  });
});

suite('VideoVisionClient payload', () => {
  test('buildVideoUrlPart wraps a data URI', () => {
    const part = buildVideoUrlPart('data:video/mp4;base64,AAAA');
    assert.deepStrictEqual(part, {
      type: 'video_url',
      video_url: { url: 'data:video/mp4;base64,AAAA' },
    });
  });

  test('buildVisionMessages puts video before text', () => {
    const msgs = buildVisionMessages('stepfile://file-1', 'describe this');
    assert.strictEqual(msgs.length, 1);
    assert.strictEqual(msgs[0].role, 'user');
    assert.strictEqual(msgs[0].content[0].type, 'video_url');
    assert.strictEqual((msgs[0].content[0] as any).video_url.url, 'stepfile://file-1');
    assert.strictEqual(msgs[0].content[1].type, 'text');
    assert.strictEqual(msgs[0].content[1].text, 'describe this');
  });
});

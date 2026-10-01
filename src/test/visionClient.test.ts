import * as assert from 'assert';
import {
  parseScreencaptureList,
  parseAvfoundationDisplays,
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

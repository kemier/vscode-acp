import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { buildFrameArgs, extractVideoFrames } from '../vision/FrameExtractor';

// Same escape hatch terminalHandler.test.ts uses: the extractor resolves
// child_process.execFile at call time, so the module object is the seam.
declare function require(name: string): any;

/**
 * The no-endpoint fallback turns a screen recording into image ContentBlocks,
 * and every frame it keeps is image tokens the agent pays for. A screen
 * recording is mostly static, so what decides the bill is whether
 * near-duplicate frames are dropped BEFORE the even down-sampling:
 *  - order matters — `mpdecimate` after `fps=` decimates the sampled stream;
 *    before it, the following CFR conversion refills the gaps with duplicates
 *    (measured on ffmpeg 7.0.2: 2 frames vs 10 for the same clip),
 *  - `-fps_mode vfr` is part of the mechanism, not cosmetic (6 frames without),
 *  - an ffmpeg that cannot run the filter must cost the saving, not the take,
 *  - the frame cap still applies afterwards — dedup changes which frames the
 *    budget is spent on, not how many.
 *
 * ffmpeg is not run here: `child_process.execFile` is swapped out so the arg
 * shape and the fallback are pinned on any machine.
 */
suite('FrameExtractor (near-duplicate frames never reach the model)', () => {
  const VIDEO = __filename; // any existing file: the extractor only stats it

  suite('buildFrameArgs', () => {
    test('dedup pass puts mpdecimate after fps= and asks for variable frame rate', () => {
      const args = buildFrameArgs('/in.mp4', '/out/frame-%03d.jpg', 0.5, true);
      const vf = args[args.indexOf('-vf') + 1];
      assert.strictEqual(vf, 'fps=0.5,mpdecimate');
      // Order is the whole point: mpdecimate first would be undone by the
      // fps= conversion duplicating the surviving frame back into the gaps.
      assert.ok(
        vf.indexOf('fps=') < vf.indexOf('mpdecimate'),
        `mpdecimate must follow fps=, got ${vf}`,
      );
      // Without this, ffmpeg's CFR conversion re-inserts the dropped frames.
      const mode = args.indexOf('-fps_mode');
      assert.ok(mode > 0, '-fps_mode must be passed with the dedup chain');
      assert.strictEqual(args[mode + 1], 'vfr');
      // Output pattern stays last so it is the muxer target, not a filter arg.
      assert.strictEqual(args[args.length - 1], '/out/frame-%03d.jpg');
    });

    test('fallback pass is exactly the old chain: no filter, no fps_mode', () => {
      const args = buildFrameArgs('/in.mp4', '/out/frame-%03d.jpg', 0.5, false);
      assert.deepStrictEqual(args, [
        '-y',
        '-i',
        '/in.mp4',
        '-vf',
        'fps=0.5',
        '-q:v',
        '5',
        '/out/frame-%03d.jpg',
      ]);
    });
  });

  suite('extractVideoFrames', () => {
    const cp = require('child_process');
    const realExecFile = cp.execFile;
    let calls: string[][] = [];

    /**
     * Stand in for ffmpeg: each planned pass writes its frame names as JPEGs
     * into the directory the output pattern points at (payload = the name, so
     * the test can tell which frames survived sampling). `fail` makes the pass
     * throw instead, like an ffmpeg that does not know the filter.
     */
    function fakeFfmpeg(plan: Array<{ names: string[]; fail?: boolean }>): void {
      let pass = 0;
      cp.execFile = (
        _file: string,
        args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        calls.push(args);
        const step = plan[Math.min(pass, plan.length - 1)];
        pass += 1;
        if (step.fail) {
          cb(new Error("Unrecognized option 'fps_mode'"), '', '');
          return;
        }
        const dir = path.dirname(args[args.length - 1]);
        for (const n of step.names) {
          fs.writeFileSync(path.join(dir, n), Buffer.from(n, 'utf8'));
        }
        cb(null, '', '');
      };
    }

    const names = (n: number): string[] =>
      Array.from({ length: n }, (_, i) => `frame-${String(i + 1).padStart(3, '0')}.jpg`);

    const kept = (frames: Array<{ data: string }>): string[] =>
      frames.map((f) => Buffer.from(f.data, 'base64').toString('utf8'));

    setup(() => {
      calls = [];
    });

    teardown(() => {
      cp.execFile = realExecFile;
    });

    test('the dedup pass is the only ffmpeg run when it yields frames', async () => {
      fakeFfmpeg([{ names: names(2) }]);
      const frames = await extractVideoFrames(VIDEO, { ffmpegPath: 'ffmpeg' });
      assert.strictEqual(calls.length, 1, 'no second pass when dedup worked');
      assert.strictEqual(calls[0][calls[0].indexOf('-vf') + 1], 'fps=0.5,mpdecimate');
      assert.deepStrictEqual(kept(frames), names(2));
      assert.strictEqual(frames[0].mimeType, 'image/jpeg');
    });

    test('an ffmpeg that rejects the dedup chain still returns the take', async () => {
      fakeFfmpeg([{ names: [], fail: true }, { names: names(2) }]);
      const frames = await extractVideoFrames(VIDEO, { ffmpegPath: 'ffmpeg' });
      assert.deepStrictEqual(kept(frames), names(2), 'fallback must return frames, not an error');
      assert.strictEqual(calls.length, 2);
      assert.ok(calls[0].includes('-fps_mode'), 'first pass tries dedup');
      assert.ok(!calls[1].includes('-fps_mode'), 'second pass drops the filter');
      assert.strictEqual(calls[1][calls[1].indexOf('-vf') + 1], 'fps=0.5');
    });

    test('a dedup pass that yields zero frames falls back instead of failing', async () => {
      fakeFfmpeg([{ names: [] }, { names: names(1) }]);
      const frames = await extractVideoFrames(VIDEO, { ffmpegPath: 'ffmpeg' });
      assert.deepStrictEqual(kept(frames), names(1));
      assert.strictEqual(calls.length, 2);
      assert.ok(!calls[1].includes('mpdecimate'));
    });

    test('dedup: false keeps the old single plain pass', async () => {
      fakeFfmpeg([{ names: names(1) }]);
      await extractVideoFrames(VIDEO, { ffmpegPath: 'ffmpeg', dedup: false });
      assert.strictEqual(calls.length, 1);
      assert.ok(!calls[0].includes('mpdecimate'));
      assert.ok(!calls[0].includes('-fps_mode'));
    });

    test('the frame cap still applies after dedup, spanning first to last', async () => {
      fakeFfmpeg([{ names: names(10) }]);
      const frames = await extractVideoFrames(VIDEO, { ffmpegPath: 'ffmpeg', maxFrames: 4 });
      assert.strictEqual(calls.length, 1);
      // Even sampling over the deduped frames, endpoints included.
      assert.deepStrictEqual(kept(frames), [
        'frame-001.jpg',
        'frame-004.jpg',
        'frame-007.jpg',
        'frame-010.jpg',
      ]);
    });

    test('both passes failing to produce frames is still an error', async () => {
      fakeFfmpeg([{ names: [] }, { names: [] }]);
      await assert.rejects(
        () => extractVideoFrames(VIDEO, { ffmpegPath: 'ffmpeg' }),
        /produced no JPEG frames/,
      );
      assert.strictEqual(calls.length, 2);
    });

    test('a missing video is rejected before ffmpeg is spawned', async () => {
      fakeFfmpeg([{ names: names(1) }]);
      await assert.rejects(
        () => extractVideoFrames(path.join(__dirname, 'no-such-take.mp4'), { ffmpegPath: 'ffmpeg' }),
        /video not found/,
      );
      assert.strictEqual(calls.length, 0);
    });
  });
});

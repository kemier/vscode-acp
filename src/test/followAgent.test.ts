import * as assert from 'assert';
import {
  resolveAgentLocationPath,
  pickFollowTarget,
  FollowCoalescer,
  type ResolvedAgentLocation,
} from '../core/FollowAgent';


/**
 * These suites assert POSIX path semantics (normalise/join on '/'-formatted
 * inputs); node:path on win32 yields '\'-formatted results, so the
 * path-shaping assertions only run where POSIX paths are native. The
 * platform-neutral semantics (anchoring, undefined, line handling) stay
 * covered on Windows by the remaining tests.
 */
const posixTest = process.platform === 'win32' ? test.skip : test;

suite('FollowAgent.resolveAgentLocationPath', () => {
  test('returns undefined for empty input', () => {
    assert.strictEqual(resolveAgentLocationPath({ path: '' }), undefined);
    assert.strictEqual(resolveAgentLocationPath({ path: undefined as any }), undefined);
  });

  posixTest('returns absolute paths normalised', () => {
    const out = resolveAgentLocationPath({ path: '/a/b/../c/foo.ts' });
    assert.strictEqual(out, '/a/c/foo.ts');
  });

  posixTest('resolves relative paths against sessionCwd', () => {
    const out = resolveAgentLocationPath({ path: 'src/foo.ts' }, { sessionCwd: '/projects/p' });
    assert.strictEqual(out, '/projects/p/src/foo.ts');
  });

  posixTest('falls back to workspaceRoot when sessionCwd is absent', () => {
    const out = resolveAgentLocationPath({ path: 'src/foo.ts' }, { workspaceRoot: '/projects/p' });
    assert.strictEqual(out, '/projects/p/src/foo.ts');
  });

  test('returns undefined for relative paths without any anchor', () => {
    assert.strictEqual(resolveAgentLocationPath({ path: 'src/foo.ts' }), undefined);
  });

  posixTest('expands ~ when homeDir is provided', () => {
    const out = resolveAgentLocationPath({ path: '~/notes/x.md' }, { homeDir: '/home/u' });
    assert.strictEqual(out, '/home/u/notes/x.md');
  });

  posixTest('expands bare ~ when homeDir is provided', () => {
    const out = resolveAgentLocationPath({ path: '~' }, { homeDir: '/home/u' });
    assert.strictEqual(out, '/home/u');
  });

  posixTest('absolute path outside the workspace is returned as-is (no filter)', () => {
    // This is the "agent reads a file outside the repo" case — common when
    // codex inspects `/etc/...`, an installed dependency, or a sibling repo.
    // The follower MUST NOT filter the path by workspace membership; that
    // is exactly what users want to see.
    const out = resolveAgentLocationPath(
      { path: '/etc/hosts', line: 1 },
      { sessionCwd: '/workspace/repo', workspaceRoot: '/workspace/repo' },
    );
    assert.strictEqual(out, '/etc/hosts');
  });

  posixTest('relative path with .. escaping the workspace resolves correctly', () => {
    // e.g. agent in /workspace/git/foo reads ../bar/util.ts (sibling repo).
    const out = resolveAgentLocationPath({ path: '../bar/util.ts' }, { sessionCwd: '/workspace/git/foo' });
    assert.strictEqual(out, '/workspace/git/bar/util.ts');
  });
});

suite('FollowAgent.pickFollowTarget', () => {
  test('returns undefined for empty / null arrays', () => {
    assert.strictEqual(pickFollowTarget(undefined), undefined);
    assert.strictEqual(pickFollowTarget(null), undefined);
    assert.strictEqual(pickFollowTarget([]), undefined);
  });

  posixTest('picks the first resolvable entry', () => {
    const out = pickFollowTarget([
      { path: '/a/foo.ts', line: 5 },
      { path: '/a/bar.ts', line: 9 },
    ]);
    assert.deepStrictEqual(out, { absPath: '/a/foo.ts', line: 5 });
  });

  posixTest('skips entries whose path cannot be resolved', () => {
    // First entry is relative + no anchor -> unresolvable -> skip.
    const out = pickFollowTarget([{ path: 'src/foo.ts' }, { path: '/abs/bar.ts', line: 12 }]);
    assert.deepStrictEqual(out, { absPath: '/abs/bar.ts', line: 12 });
  });

  posixTest('line=0 / negative / NaN is dropped (1-based ACP convention)', () => {
    const cases = [0, -1, NaN, null as any, undefined as any];
    for (const line of cases) {
      const out = pickFollowTarget([{ path: '/a/foo.ts', line }]);
      assert.deepStrictEqual(out, { absPath: '/a/foo.ts', line: undefined }, `line=${line}`);
    }
  });

  posixTest('fractional line numbers are floored', () => {
    const out = pickFollowTarget([{ path: '/a/foo.ts', line: 7.9 }]);
    assert.deepStrictEqual(out, { absPath: '/a/foo.ts', line: 7 });
  });

  posixTest('absolute paths outside the workspace are picked unchanged', () => {
    // Mirrors what Zed does — the follower follows the agent everywhere it
    // looks, including read_file calls into installed dependencies, system
    // headers, sibling repos, etc.
    const out = pickFollowTarget([{ path: '/usr/include/stdio.h', line: 42 }], {
      sessionCwd: '/workspace/repo',
      workspaceRoot: '/workspace/repo',
    });
    assert.deepStrictEqual(out, { absPath: '/usr/include/stdio.h', line: 42 });
  });
});

/** Deterministic clock for the coalescer tests. */
class FakeClock {
  private queue: Array<{ id: number; fn: () => void; due: number }> = [];
  private next = 1;
  private now = 0;
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.queue.push({ id, fn, due: this.now + ms });
    this.queue.sort((a, b) => a.due - b.due);
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.queue = this.queue.filter((q) => q.id !== handle);
  }
  advance(ms: number): void {
    this.now += ms;
    while (this.queue.length > 0 && this.queue[0].due <= this.now) {
      const t = this.queue.shift()!;
      t.fn();
    }
  }
  pendingCount(): number {
    return this.queue.length;
  }
}

function makeCoalescer(flushMs = 200) {
  const clock = new FakeClock();
  const fired: ResolvedAgentLocation[] = [];
  const c = new FollowCoalescer({
    flushIntervalMs: flushMs,
    onFlush: (t) => fired.push(t),
    setTimeoutFn: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeoutFn: (h) => clock.clearTimeout(h),
  });
  return { c, clock, fired };
}

suite('FollowAgent.FollowCoalescer', () => {
  test('rapid burst → only the LAST target opens', () => {
    const { c, clock, fired } = makeCoalescer(200);
    c.submit({ absPath: '/a/1.ts', line: 1 });
    c.submit({ absPath: '/a/2.ts', line: 2 });
    c.submit({ absPath: '/a/3.ts', line: 3 });
    assert.strictEqual(fired.length, 0, 'nothing fires before the window');
    clock.advance(250);
    assert.deepStrictEqual(fired, [{ absPath: '/a/3.ts', line: 3 }]);
  });

  test('identical consecutive submissions are deduped (no re-open)', () => {
    const { c, clock, fired } = makeCoalescer(200);
    c.submit({ absPath: '/a/foo.ts', line: 5 });
    clock.advance(250);
    assert.strictEqual(fired.length, 1);
    c.submit({ absPath: '/a/foo.ts', line: 5 });
    clock.advance(250);
    assert.strictEqual(fired.length, 1, 'same target must not re-emit');
  });

  test('different line on same file re-opens', () => {
    const { c, clock, fired } = makeCoalescer(200);
    c.submit({ absPath: '/a/foo.ts', line: 5 });
    clock.advance(250);
    c.submit({ absPath: '/a/foo.ts', line: 42 });
    clock.advance(250);
    assert.strictEqual(fired.length, 2);
    assert.strictEqual(fired[1].line, 42);
  });

  test('flush() forces immediate emission', () => {
    const { c, clock, fired } = makeCoalescer(200);
    c.submit({ absPath: '/a/x.ts', line: 1 });
    c.flush();
    assert.strictEqual(fired.length, 1);
    assert.strictEqual(clock.pendingCount(), 0, 'timer was cancelled');
  });

  test('reset() drops the pending target without emitting', () => {
    const { c, clock, fired } = makeCoalescer(200);
    c.submit({ absPath: '/a/x.ts', line: 1 });
    c.reset();
    clock.advance(500);
    assert.strictEqual(fired.length, 0);
    assert.strictEqual(clock.pendingCount(), 0);
  });

  test('after reset() a previously-seen target re-opens', () => {
    const { c, clock, fired } = makeCoalescer(200);
    c.submit({ absPath: '/a/x.ts', line: 1 });
    clock.advance(250);
    assert.strictEqual(fired.length, 1);
    c.reset();
    c.submit({ absPath: '/a/x.ts', line: 1 });
    clock.advance(250);
    assert.strictEqual(fired.length, 2);
  });
});

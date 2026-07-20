import * as assert from 'assert';
import * as vscode from 'vscode';
import { logTraffic, getTrafficChannel, disposeChannels, logStderr, getStructuredTraffic } from '../utils/Logger';

/**
 * Tap a vscode.OutputChannel by intercepting its `appendLine` / `clear` /
 * `append` methods. Returns the captured calls and a restore() function.
 */
function tapChannel(channel: vscode.OutputChannel) {
  const lines: string[] = [];
  let clears = 0;
  const origAppendLine = channel.appendLine.bind(channel);
  const origAppend = (channel as any).append?.bind(channel);
  const origClear = channel.clear.bind(channel);
  (channel as any).appendLine = (s: string) => {
    lines.push(s);
  };
  if (origAppend) {
    (channel as any).append = (s: string) => {
      lines.push(s);
    };
  }
  (channel as any).clear = () => {
    clears++;
    lines.length = 0;
  };
  return {
    lines,
    getClears: () => clears,
    restore: () => {
      (channel as any).appendLine = origAppendLine;
      if (origAppend) {
        (channel as any).append = origAppend;
      }
      (channel as any).clear = origClear;
    },
  };
}

async function setLogTraffic(value: boolean): Promise<void> {
  await vscode.workspace.getConfiguration('acp').update('logTraffic', value, vscode.ConfigurationTarget.Global);
}

async function setLogTrafficMaxEntries(value: number): Promise<void> {
  await vscode.workspace
    .getConfiguration('acp')
    .update('logTrafficMaxEntries', value, vscode.ConfigurationTarget.Global);
}

suite('Logger.logTraffic', () => {
  let tap: ReturnType<typeof tapChannel>;

  setup(async () => {
    // Re-create the channel so each test starts with a fresh in-module
    // rotation counter.
    disposeChannels();
    await setLogTraffic(true);
    tap = tapChannel(getTrafficChannel());
  });

  teardown(async () => {
    tap.restore();
    await setLogTrafficMaxEntries(1000);
  });

  test('does nothing when logTraffic is disabled', async () => {
    await setLogTraffic(false);
    logTraffic('send', { method: 'session/prompt', id: 1, params: {} });
    assert.strictEqual(tap.lines.length, 0);
  });

  test('appends pretty-printed JSON for small messages', () => {
    logTraffic('send', { method: 'session/prompt', id: 1, params: { sessionId: 's' } });
    assert.strictEqual(tap.lines.length, 1);
    const out = tap.lines[0];
    assert.ok(out.includes('[REQUEST] session/prompt'), `header missing: ${out.slice(0, 200)}`);
    assert.ok(out.includes('\n  "method"'), 'expected 2-space-indented pretty JSON');
  });

  test('switches to compact JSON when payload exceeds the 16 KB threshold', () => {
    // 32 KB string ensures we cross the 16 KB pretty/compact boundary.
    const big = 'x'.repeat(32 * 1024);
    logTraffic('recv', { id: 1, result: { stopReason: 'end_turn', big } });
    const out = tap.lines[0];
    // Pretty form would contain indented "result" — compact does not.
    assert.ok(!out.includes('\n  "result"'), 'large payload should be compact JSON');
    // Compact form keeps "result":{ no space, no newline before `{`.
    assert.ok(/"result":\{/.test(out), 'expected compact "result":{ marker');
  });

  test('truncates a single entry larger than 64 KB with a marker', () => {
    const huge = 'y'.repeat(200 * 1024);
    logTraffic('send', { method: 'session/prompt', id: 1, params: { huge } });
    const out = tap.lines[0];
    assert.ok(out.length <= 64 * 1024 + 256, `entry must be hard-capped, got ${out.length}`);
    assert.ok(out.includes('…[truncated,'), 'must include truncation marker');
    assert.ok(/more chars\]/.test(out), 'marker must report dropped char count');
  });

  test('rotates (clears) channel after acp.logTrafficMaxEntries entries', async () => {
    await setLogTrafficMaxEntries(50);
    // The rotation cap floor is 50; counter is internal, so write 50 entries
    // and confirm exactly one clear() happened and a "log rotated" header
    // shows up immediately after.
    for (let i = 0; i < 50; i++) {
      logTraffic('send', { method: 'session/update', params: { i } });
    }
    assert.strictEqual(tap.getClears(), 1, 'channel must clear exactly once at the cap');
    assert.ok(tap.lines.length >= 1, 'expected the rotation marker after clear');
    assert.ok(/log rotated/.test(tap.lines[0]), `expected rotation marker, got ${tap.lines[0]?.slice(0, 200)}`);
  });

  test('classifies REQUEST / NOTIFICATION / RESPONSE correctly', () => {
    logTraffic('send', { method: 'session/prompt', id: 7, params: {} });
    logTraffic('recv', { method: 'session/update', params: {} });
    logTraffic('recv', { id: 7, result: {} });
    assert.strictEqual(tap.lines.length, 3);
    assert.ok(tap.lines[0].includes('[REQUEST] session/prompt'));
    assert.ok(tap.lines[1].includes('[NOTIFICATION] session/update'));
    assert.ok(tap.lines[2].includes('[RESPONSE] id=7'));
  });

  test('per-token agent_message_chunk is not logged', () => {
    logTraffic('recv', {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess-1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi' } },
      },
    });
    assert.strictEqual(tap.lines.length, 0, 'message chunks must be dropped');
  });

  test('per-token agent_thought_chunk is not logged', () => {
    logTraffic('recv', {
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking…' } } },
    });
    assert.strictEqual(tap.lines.length, 0, 'thought chunks must be dropped');
  });

  test('tool_call_update collapses to ONE line', () => {
    logTraffic('recv', {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-abcdefghij',
          _meta: { terminal_output_delta: { data: 'hello\\n' } },
        },
      },
    });
    assert.strictEqual(tap.lines.length, 1);
    assert.ok(tap.lines[0].includes('chunk[tool_update]'));
    assert.ok(!tap.lines[0].includes('\n  "params"'), 'must NOT pretty-print tool_update');
  });

  test('non-chunk notifications still pretty-print as before', () => {
    logTraffic('recv', {
      method: 'session/update',
      params: { update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', kind: 'read' } },
    });
    assert.strictEqual(tap.lines.length, 1);
    // The pretty form newlines the entry, so the OutputChannel's single
    // appendLine call contains '\n  "method"' inside the body.
    assert.ok(tap.lines[0].includes('\n  "method"'), 'non-chunk should remain pretty-printed');
    assert.ok(tap.lines[0].includes('[NOTIFICATION] session/update'));
  });

  test('dropped message chunks do not count toward rotation', async () => {
    await setLogTrafficMaxEntries(50);
    for (let i = 0; i < 50; i++) {
      logTraffic('recv', {
        method: 'session/update',
        params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 't' } } },
      });
    }
    assert.strictEqual(tap.lines.length, 0);
    assert.strictEqual(tap.getClears(), 0, 'silent chunks must not rotate the channel');
  });
});

suite('Logger.logTraffic — request↔response method tagging', () => {
  let tap: ReturnType<typeof tapChannel>;

  setup(async () => {
    disposeChannels();
    await setLogTraffic(true);
    tap = tapChannel(getTrafficChannel());
  });

  teardown(() => {
    tap.restore();
  });

  test('outgoing REQUEST → incoming RESPONSE: response is tagged with the method', () => {
    logTraffic('send', { method: 'session/prompt', id: 7, params: {} });
    logTraffic('recv', { id: 7, result: { stopReason: 'end_turn' } });
    assert.strictEqual(tap.lines.length, 2);
    assert.ok(
      tap.lines[1].includes('[RESPONSE] id=7 (session/prompt)'),
      `expected response to be tagged, got: ${tap.lines[1].slice(0, 200)}`,
    );
  });

  test('incoming REQUEST → outgoing RESPONSE: response is tagged with the method', () => {
    // Agent → client request (e.g. fs/read_text_file), then we respond.
    logTraffic('recv', { method: 'fs/read_text_file', id: 12, params: { path: '/x' } });
    logTraffic('send', { id: 12, result: { content: 'hi' } });
    assert.strictEqual(tap.lines.length, 2);
    assert.ok(tap.lines[1].includes('[RESPONSE] id=12 (fs/read_text_file)'));
  });

  test('unmatched response falls back to the plain id label', () => {
    // No prior REQUEST with id=99 → no method to tag.
    logTraffic('recv', { id: 99, result: {} });
    assert.strictEqual(tap.lines.length, 1);
    assert.ok(tap.lines[0].includes('[RESPONSE] id=99'));
    assert.ok(!tap.lines[0].includes('(session/'), 'must not invent a method');
  });

  test('response consumes the pending entry (same id reused later still works)', () => {
    logTraffic('send', { method: 'a/m', id: 1, params: {} });
    logTraffic('recv', { id: 1, result: {} });
    // Now re-use id=1 — this is unusual but legal.
    logTraffic('send', { method: 'b/m', id: 1, params: {} });
    logTraffic('recv', { id: 1, result: {} });
    assert.ok(tap.lines[1].includes('(a/m)'));
    assert.ok(tap.lines[3].includes('(b/m)'));
  });
});

suite('Logger.logStderr', () => {
  let tap: ReturnType<typeof tapChannel>;

  setup(async () => {
    disposeChannels();
    await setLogTraffic(true);
    tap = tapChannel(getTrafficChannel());
  });

  teardown(() => {
    tap.restore();
  });

  test('writes a single-line STDERR entry with agent name + raw line', () => {
    logStderr('Codex CLI', 'failed to connect: ECONNREFUSED');
    assert.strictEqual(tap.lines.length, 1);
    assert.ok(tap.lines[0].includes('[Codex CLI STDERR]'));
    assert.ok(tap.lines[0].includes('failed to connect: ECONNREFUSED'));
  });

  test('respects logTraffic = false', async () => {
    await setLogTraffic(false);
    logStderr('agent', 'noise');
    assert.strictEqual(tap.lines.length, 0);
  });

  test('truncates a stderr line larger than the hard cap', () => {
    const huge = 'z'.repeat(200 * 1024);
    logStderr('agent', huge);
    const out = tap.lines[0];
    assert.ok(out.length <= 64 * 1024 + 256);
    assert.ok(out.includes('…[truncated,'));
  });

  test('stderr counts toward log rotation', async () => {
    await setLogTrafficMaxEntries(50);
    for (let i = 0; i < 50; i++) {
      logStderr('agent', 'tick');
    }
    assert.strictEqual(tap.getClears(), 1);
  });
});

suite('Logger.getStructuredTraffic ring buffer', () => {
  setup(async () => {
    disposeChannels();
    await setLogTraffic(true);
  });

  test('captures REQUEST + RESPONSE with method link', () => {
    logTraffic('send', { method: 'session/prompt', id: 4, params: { x: 1 } });
    logTraffic('recv', { id: 4, result: { ok: true } });
    const ring = getStructuredTraffic();
    assert.strictEqual(ring.length, 2);
    assert.strictEqual(ring[0].kind, 'request');
    assert.strictEqual(ring[0].method, 'session/prompt');
    assert.deepStrictEqual(ring[0].params, { x: 1 });
    assert.strictEqual(ring[1].kind, 'response');
    assert.strictEqual(ring[1].id, 4);
    assert.strictEqual(ring[1].method, 'session/prompt', 'response inherits method from matched request');
    assert.deepStrictEqual(ring[1].result, { ok: true });
  });

  test('captures notifications and stderr entries', () => {
    logTraffic('recv', { method: 'session/update', params: { update: { sessionUpdate: 'tool_call' } } });
    logStderr('agent', 'oops');
    const ring = getStructuredTraffic();
    assert.strictEqual(ring.length, 2);
    assert.strictEqual(ring[0].kind, 'notification');
    assert.strictEqual(ring[0].method, 'session/update');
    assert.strictEqual(ring[1].kind, 'stderr');
    assert.strictEqual(ring[1].agent, 'agent');
    assert.strictEqual(ring[1].line, 'oops');
  });

  test('ring buffer is bounded (oldest entries drop)', () => {
    for (let i = 0; i < 2200; i++) {
      logTraffic('recv', { method: 'noop', params: { i } });
    }
    const ring = getStructuredTraffic();
    assert.ok(ring.length <= 2000, `ring grew to ${ring.length}`);
    // The newest entry must still be in there.
    assert.strictEqual((ring[ring.length - 1].params as any).i, 2199);
  });

  test('disposeChannels clears the ring', () => {
    logTraffic('recv', { method: 'x' });
    assert.ok(getStructuredTraffic().length > 0);
    disposeChannels();
    assert.strictEqual(getStructuredTraffic().length, 0);
  });
});

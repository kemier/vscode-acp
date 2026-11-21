import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { SessionUpdateHandler } from '../handlers/SessionUpdateHandler';
import {
  initOtelForTesting,
  otelSessionEnd,
  otelSessionStart,
  otelShutdown,
  otelTurnEnd,
  otelTurnStart,
} from '../utils/OtelTrace';

/**
 * ACP tool calls become execute_tool spans.
 *
 * The first version listened for a `tool_update` notification, which ACP does not
 * have: a tool call is `tool_call` followed by `tool_call_update`s, with status
 * `pending | in_progress | completed | failed`. So no tool span ever ended on its own
 * — each was closed, without status or output, when the next turn started. These tests
 * drive the real session/update choke point (SessionUpdateHandler) with ACP-shaped
 * frames and read what the exporter received.
 */

function frame(sessionId: string, update: Record<string, unknown>): never {
  return { sessionId, update } as never;
}

suite('OTel: ACP tool calls become execute_tool spans', () => {
  let exporter: InMemorySpanExporter;
  let handler: SessionUpdateHandler;

  setup(() => {
    exporter = new InMemorySpanExporter();
    initOtelForTesting(exporter);
    handler = new SessionUpdateHandler();
    otelSessionStart('s1', 'Codex CLI', '/workspace/app');
    otelTurnStart('s1', 'fix the build', 'gpt-5');
  });

  teardown(async () => {
    await otelShutdown();
  });

  const finished = (name: string) => exporter.getFinishedSpans().filter((s) => s.name === name);

  test('the span ends on the terminal tool_call_update, not on in_progress', () => {
    handler.handleUpdate(
      frame('s1', { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read', status: 'pending' }),
    );
    handler.handleUpdate(frame('s1', { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' }));
    assert.strictEqual(finished('execute_tool Read').length, 0, 'in_progress is not the end of the tool');

    handler.handleUpdate(
      frame('s1', { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', rawOutput: { ok: 1 } }),
    );
    const [span] = finished('execute_tool Read');
    assert.ok(span, 'completed ends the span');
    assert.strictEqual(span.status.code, SpanStatusCode.UNSET);
    assert.strictEqual(span.attributes['gen_ai.tool.call.id'], 't1');
    assert.strictEqual(span.attributes['gen_ai.tool.output_preview'], '{"ok":1}');
  });

  test('a failed tool marks its span ERROR', () => {
    handler.handleUpdate(frame('s1', { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Bash' }));
    handler.handleUpdate(frame('s1', { sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'failed' }));
    const [span] = finished('execute_tool Bash');
    assert.ok(span);
    assert.strictEqual(span.status.code, SpanStatusCode.ERROR);
  });

  test('a tool_call that arrives already completed opens and closes its span', () => {
    handler.handleUpdate(
      frame('s1', { sessionUpdate: 'tool_call', toolCallId: 't3', title: 'Grep', status: 'completed' }),
    );
    assert.strictEqual(finished('execute_tool Grep').length, 1);
  });

  test('the tool span is a child of the turn', () => {
    handler.handleUpdate(frame('s1', { sessionUpdate: 'tool_call', toolCallId: 't4', title: 'Edit' }));
    handler.handleUpdate(frame('s1', { sessionUpdate: 'tool_call_update', toolCallId: 't4', status: 'completed' }));
    otelTurnEnd('s1', false);
    const [tool] = finished('execute_tool Edit');
    const [turn] = finished('invoke_agent');
    assert.ok(tool && turn);
    assert.strictEqual(tool.spanContext().traceId, turn.spanContext().traceId);
    assert.strictEqual(tool.parentSpanContext?.spanId, turn.spanContext().spanId);
  });

  test('a repeated tool_call for an open id does not orphan the running span', () => {
    handler.handleUpdate(frame('s1', { sessionUpdate: 'tool_call', toolCallId: 't5', title: 'Write' }));
    // Same id again: replacing the map entry would leave the first span running
    // forever (never ended, never exported).
    handler.handleUpdate(frame('s1', { sessionUpdate: 'tool_call', toolCallId: 't5', title: 'Write again' }));
    handler.handleUpdate(frame('s1', { sessionUpdate: 'tool_call_update', toolCallId: 't5', status: 'completed' }));
    otelSessionEnd('s1');
    assert.strictEqual(finished('execute_tool Write').length, 1, 'the original span is the one that ends');
    assert.strictEqual(finished('execute_tool Write again').length, 0, 'one call, one span');
  });

  test('other session/update kinds are ignored', () => {
    handler.handleUpdate(frame('s1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }));
    handler.handleUpdate(frame('s1', { sessionUpdate: 'plan', entries: [] }));
    assert.deepStrictEqual(
      exporter.getFinishedSpans().map((s) => s.name),
      [],
    );
  });
});

suite('OTel: the provider stays private to this extension', () => {
  test('tracing never registers the global tracer provider', async () => {
    const exporter = new InMemorySpanExporter();
    initOtelForTesting(exporter);
    otelSessionStart('s9', 'Claude Code', '/workspace/app');
    otelSessionEnd('s9');
    assert.strictEqual(exporter.getFinishedSpans().length, 1, 'spans still reach our own exporter');
    // If we had registered globally, this second registration would be refused as a
    // duplicate — the extension host's global belongs to whoever else needs it.
    const other = new BasicTracerProvider();
    try {
      assert.strictEqual(trace.setGlobalTracerProvider(other), true);
    } finally {
      trace.disable();
      await otelShutdown();
    }
  });
});

suite('OTel: shutdown flushes what is still open', () => {
  test('otelShutdown ends and exports the open session span', async () => {
    // InMemorySpanExporter.shutdown() forgets what it holds, so record exports as
    // they happen — the shutdown is exactly what is being tested.
    const exported: string[] = [];
    class RecordingExporter extends InMemorySpanExporter {
      override export(
        spans: Parameters<InMemorySpanExporter['export']>[0],
        done: Parameters<InMemorySpanExporter['export']>[1],
      ): void {
        exported.push(...spans.map((s) => s.name));
        super.export(spans, done);
      }
    }
    initOtelForTesting(new RecordingExporter());
    otelSessionStart('s8', 'Kiro CLI', '/workspace/app');
    otelTurnStart('s8', 'still running');
    await otelShutdown();
    assert.deepStrictEqual(exported.sort(), ['acp.session', 'invoke_agent']);
  });
});

suite('OTel: the setting is declared where VS Code reads it', () => {
  test('acp.otel.endpoint lives in contributes.configuration, with no stray top-level block', () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
    assert.strictEqual(manifest.settings, undefined, 'a top-level "settings" key is not a contribution point');
    const prop = manifest.contributes.configuration.properties['acp.otel.endpoint'];
    assert.ok(prop, 'declared');
    assert.strictEqual(prop.type, 'string');
    assert.strictEqual(prop.default, '');
  });
});

/**
 * OTel span tracing for the ACP session flow — the trace/span/parent_id model
 * from interview/tracing.md applied to this client. No-op unless
 * `OTEL_TRACES_ENDPOINT` is set (e.g. http://localhost:4318/v1/traces for
 * otel-desktop-viewer / Jaeger).
 *
 * Span tree:
 *   acp.session           trace root, one per ACP session
 *     └─ turn             one per session/prompt round-trip (invoke_agent)
 *         └─ execute_tool one per tool_call/tool_update notification pair
 *
 * Tool calls from EVERY adapter (claude-code-acp, codex-acp, pi-acp) arrive as
 * ACP session/update notifications, so wiring at the SessionUpdateHandler
 * choke point captures them all without touching the adapters. Parent links
 * are threaded explicitly (Context.setSpan + startSpan's context arg) — no
 * CLS/auto-instrumentation, which the extension host can't rely on anyway.
 *
 * Failure attribution: the first span with ERROR status in the tree names the
 * layer that broke — a failed turn (upstream 503/transport) marks the turn
 * span; a failed tool marks its execute_tool span.
 */
import { trace, Span, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { BasicTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { log } from '../utils/Logger';
import * as vscode from 'vscode';

// Minimal structural Context (the api's Context is an interface; the impl only
// needs getValue/setValue/deleteValue) so we can thread explicit parents.
class EmptyContext {
  private readonly values = new Map<symbol, unknown>();
  getValue(key: symbol): unknown {
    return this.values.get(key);
  }
  setValue(key: symbol, value: unknown): EmptyContext {
    const next = new EmptyContext();
    for (const [k, v] of this.values) {
      next.values.set(k, v);
    }
    next.values.set(key, value);
    return next;
  }
  deleteValue(key: symbol): EmptyContext {
    const next = new EmptyContext();
    for (const [k, v] of this.values) {
      if (k !== key) {
        next.values.set(k, v);
      }
    }
    return next;
  }
}

let enabled = false;

/** Lazily install the OTLP pipeline; returns false when tracing is disabled. */
function ensureInit(): boolean {
  if (enabled) {
    return true;
  }
  // Settings win over env: the extension host's env is hard to set for a GUI
  // launch, while `acp-client.otelEndpoint` in settings.json is not.
  const setting = String(vscode.workspace.getConfiguration('acp-client').get('otelEndpoint') ?? '');
  const url = (setting && setting.trim()) || process.env.OTEL_TRACES_ENDPOINT;
  if (!url) {
    return false;
  }
  const provider = new BasicTracerProvider({
    // Without this the viewer groups our spans under the extension-host
    // executable path (defaultServiceName() = unknown_service:<argv0>).
    resource: resourceFromAttributes({ 'service.name': 'vscode-acp' }),
    spanProcessors: [new SimpleSpanProcessor(new OTLPTraceExporter({ url }))],
  });
  trace.setGlobalTracerProvider(provider);
  enabled = true;
  log(`[otel] session tracing enabled → ${url}`);
  console.log(`[otel] session tracing enabled → ${url}`);
  return true;
}

interface SessionTrace {
  session: Span;
  turn?: Span;
  tools: Map<string, Span>;
}
const registry = new Map<string, SessionTrace>();

function startChild(parent: Span, name: string, attrs: Record<string, string>): Span {
  const ctx = trace.setSpan(new EmptyContext(), parent);
  return trace.getTracer('vscode-acp').startSpan(name, { kind: SpanKind.INTERNAL, attributes: attrs }, ctx);
}

export function otelSessionStart(sessionId: string, agentName: string, cwd: string): void {
  if (!ensureInit()) {
    return;
  }
  const session = trace.getTracer('vscode-acp').startSpan('acp.session', {
    kind: SpanKind.INTERNAL,
    attributes: {
      'gen_ai.operation.name': 'session',
      'acp.agent': agentName,
      'acp.cwd': cwd,
      // Q52 "session id" gap: the registry key is otherwise invisible to the
      // viewer — it is the cross-reload correlation key.
      'acp.session_id': sessionId,
    },
  });
  registry.set(sessionId, { session, tools: new Map() });
}

export function otelTurnStart(sessionId: string, text: string, modelId?: string): void {
  const s = registry.get(sessionId);
  if (!s) {
    return;
  }
  const attrs: Record<string, string> = {
    'gen_ai.operation.name': 'invoke_agent',
    'acp.prompt_preview': text.slice(0, 120),
  };
  if (modelId) {
    // Q52 "model alias on turn": which model actually served this turn.
    attrs['acp.model'] = modelId;
  }
  s.turn = startChild(s.session, 'invoke_agent', attrs);
  // A new turn supersedes leftover tool entries from an abandoned turn.
  for (const orphan of s.tools.values()) {
    orphan.end();
  }
  s.tools.clear();
}

export function otelTurnEnd(sessionId: string, failed: boolean): void {
  const s = registry.get(sessionId);
  if (!s || !s.turn) {
    return;
  }
  if (failed) {
    s.turn.setStatus({ code: SpanStatusCode.ERROR, message: 'prompt turn failed' });
  }
  s.turn.end();
  s.turn = undefined;
}

export function otelToolStart(sessionId: string, toolCallId: string, title: string, rawInput?: unknown): void {
  const s = registry.get(sessionId);
  if (!s || !toolCallId) {
    return;
  }
  const attrs: Record<string, string> = {
    'gen_ai.operation.name': 'execute_tool',
    'gen_ai.tool.name': title,
    'gen_ai.tool.call.id': toolCallId,
  };
  if (rawInput !== undefined) {
    // Opt-in content discipline (gen_ai conventions): preview only, not the body.
    attrs['gen_ai.tool.input_preview'] = JSON.stringify(rawInput).slice(0, 200);
  }
  s.tools.set(toolCallId, startChild(s.turn ?? s.session, `execute_tool ${title}`, attrs));
}

export function otelToolEnd(sessionId: string, toolCallId: string, failed: boolean, rawOutput?: unknown): void {
  const s = registry.get(sessionId);
  if (!s) {
    return;
  }
  const span = s.tools.get(toolCallId);
  if (!span) {
    return;
  }
  s.tools.delete(toolCallId);
  if (failed) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'tool failed' });
  }
  if (rawOutput !== undefined) {
    // Q52 "tool result summary" gap: same opt-in content discipline as the
    // input preview — preview only, capped, never the whole body.
    span.setAttributes({
      'gen_ai.tool.output_preview': JSON.stringify(rawOutput).slice(0, 200),
    });
  }
  span.end();
}

export function otelSessionEnd(sessionId: string): void {
  const s = registry.get(sessionId);
  if (!s) {
    return;
  }
  registry.delete(sessionId);
  for (const open of s.tools.values()) {
    open.end();
  }
  if (s.turn) {
    s.turn.end();
  }
  s.session.end();
}

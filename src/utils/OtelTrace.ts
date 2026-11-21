/**
 * OpenTelemetry span tracing for the ACP session flow. No-op unless an OTLP/HTTP
 * traces endpoint is configured: the `acp.otel.endpoint` setting (the undeclared
 * `acp-client.otelEndpoint` key from the first version is still honoured), else
 * the `OTEL_TRACES_ENDPOINT` environment variable — e.g.
 * http://localhost:4318/v1/traces for otel-desktop-viewer / Jaeger.
 *
 * Span shapes:
 *   acp.session                 one per ACP session (ends when the session closes)
 *   invoke_agent                one per session/prompt round-trip — its own trace root
 *     └─ execute_tool <title>   one per ACP tool call, from `tool_call` until the
 *                               `tool_call_update` that reports a terminal status
 *
 * Tool calls from EVERY adapter (claude-code-acp, codex-acp, pi-acp, …) arrive as
 * ACP session/update notifications, so wiring at the SessionUpdateHandler choke
 * point captures them all without touching the adapters. Parents are threaded
 * explicitly (`trace.setSpan(ROOT_CONTEXT, parent)` + startSpan's context
 * argument) — no context manager or auto-instrumentation.
 *
 * The provider is private to this extension and is deliberately NOT registered
 * as the global tracer provider: the extension host is shared by every installed
 * extension, and @opentelemetry/api keeps its global under one process-wide symbol.
 * Registering there would either fail ("Attempted duplicate registration of API:
 * trace") when another extension got there first — and our spans would then go to
 * that extension's tracer — or capture the spans of every other extension that
 * uses the global API.
 *
 * Failure attribution: the first span with ERROR status names the layer that broke
 * — a failed turn (upstream 503/transport) marks the turn span; a failed tool
 * marks its execute_tool span.
 */
import { trace, ROOT_CONTEXT, Span, SpanKind, SpanStatusCode, Tracer } from '@opentelemetry/api';
import { BasicTracerProvider, SimpleSpanProcessor, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { log } from '../utils/Logger';
import * as vscode from 'vscode';

let provider: BasicTracerProvider | undefined;
let tracer: Tracer | undefined;

/** The configured OTLP traces endpoint, or '' when tracing is off. */
function configuredEndpoint(): string {
  // Settings win over env: the extension host's env is hard to set for a GUI
  // launch, while a settings.json value is not.
  const declared = vscode.workspace.getConfiguration('acp').get<string>('otel.endpoint');
  const legacy = vscode.workspace.getConfiguration('acp-client').get<string>('otelEndpoint');
  for (const value of [declared, legacy, process.env.OTEL_TRACES_ENDPOINT]) {
    const url = String(value ?? '').trim();
    if (url) {
      return url;
    }
  }
  return '';
}

function install(exporter: SpanExporter): void {
  provider = new BasicTracerProvider({
    // Without this the viewer groups our spans under the extension-host
    // executable path (defaultServiceName() = unknown_service:<argv0>).
    resource: resourceFromAttributes({ 'service.name': 'vscode-acp' }),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  tracer = provider.getTracer('vscode-acp');
}

/** Lazily install the OTLP pipeline; returns false when tracing is disabled. */
function ensureInit(): boolean {
  if (tracer) {
    return true;
  }
  const url = configuredEndpoint();
  if (!url) {
    return false;
  }
  install(new OTLPTraceExporter({ url }));
  log(`[otel] session tracing enabled → ${url}`);
  console.log(`[otel] session tracing enabled → ${url}`);
  return true;
}

/** Test seam: export spans to `exporter` without reading settings. */
export function initOtelForTesting(exporter: SpanExporter): void {
  registry.clear();
  install(exporter);
}

interface SessionTrace {
  session: Span;
  turn?: Span;
  tools: Map<string, Span>;
}
const registry = new Map<string, SessionTrace>();

function startChild(parent: Span, name: string, attrs: Record<string, string>): Span {
  const ctx = trace.setSpan(ROOT_CONTEXT, parent);
  return tracer!.startSpan(name, { kind: SpanKind.INTERNAL, attributes: attrs }, ctx);
}

export function otelSessionStart(sessionId: string, agentName: string, cwd: string): void {
  if (!ensureInit()) {
    return;
  }
  const session = tracer!.startSpan('acp.session', {
    kind: SpanKind.INTERNAL,
    attributes: {
      'gen_ai.operation.name': 'session',
      'acp.agent': agentName,
      'acp.cwd': cwd,
      // The registry key is otherwise invisible to the viewer — it is the
      // cross-reload correlation key.
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
    // Each turn is its own trace root: the session span stays open (and
    // therefore unflushed — SimpleSpanProcessor emits on end only), so
    // parenting turns to it renders them flat with no root card. The
    // session_id attribute keeps them groupable in the viewer instead.
    'acp.session_id': sessionId,
  };
  if (modelId) {
    attrs['acp.model'] = modelId;
  }
  s.turn = tracer!.startSpan('invoke_agent', {
    kind: SpanKind.INTERNAL,
    attributes: attrs,
  });
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
  if (!s || !toolCallId || s.tools.has(toolCallId)) {
    // A repeated tool_call for an open id must not orphan the span already running.
    return;
  }
  const attrs: Record<string, string> = {
    'gen_ai.operation.name': 'execute_tool',
    'gen_ai.tool.name': title,
    'gen_ai.tool.call.id': toolCallId,
    'acp.session_id': sessionId,
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
    // Same opt-in content discipline as the input preview — preview only,
    // capped, never the whole body.
    span.setAttributes({
      'gen_ai.tool.output_preview': JSON.stringify(rawOutput).slice(0, 200),
    });
  }
  span.end();
}

/** The fields of an ACP session/update this module reads. */
export interface OtelToolUpdate {
  sessionUpdate?: string;
  toolCallId?: string;
  title?: string | null;
  status?: string | null;
  rawInput?: unknown;
  rawOutput?: unknown;
}

/**
 * Route one ACP session/update to the tool spans.
 *
 * ACP reports a tool call as `tool_call` (created) followed by any number of
 * `tool_call_update`s; its status is `pending | in_progress | completed | failed`
 * (ToolCallStatus in @agentclientprotocol/sdk). Only the two terminal statuses end
 * the span — an `in_progress` update is not the end of the tool — and a
 * `tool_call` that already arrives terminal opens and closes its span at once.
 */
export function otelSessionUpdate(sessionId: string, update: OtelToolUpdate | undefined): void {
  if (!update || !tracer) {
    return;
  }
  const id = update.toolCallId ?? '';
  if (update.sessionUpdate === 'tool_call') {
    otelToolStart(sessionId, id, update.title || 'tool', update.rawInput);
  } else if (update.sessionUpdate !== 'tool_call_update') {
    return;
  }
  if (update.status === 'completed' || update.status === 'failed') {
    otelToolEnd(sessionId, id, update.status === 'failed', update.rawOutput);
  }
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

/**
 * End every open span and flush, waiting at most `timeoutMs` so an unreachable
 * collector cannot hold up extension-host shutdown.
 */
export async function otelShutdown(timeoutMs = 1000): Promise<void> {
  for (const sessionId of [...registry.keys()]) {
    otelSessionEnd(sessionId);
  }
  const current = provider;
  provider = undefined;
  tracer = undefined;
  if (!current) {
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    current.shutdown().catch((err: unknown) => log(`[otel] shutdown failed: ${err}`)),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timer) {
    clearTimeout(timer);
  }
}

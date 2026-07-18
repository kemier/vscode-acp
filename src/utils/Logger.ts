import * as vscode from 'vscode';

let _outputChannel: vscode.OutputChannel | undefined;
let _trafficChannel: vscode.OutputChannel | undefined;

/**
 * In-memory counter for entries written to the `ACP Traffic` output channel.
 * VS Code's OutputChannel keeps all appended text in memory until cleared, so
 * an unbounded log can hold hundreds of MB in long codex sessions. After
 * `acp.logTrafficMaxEntries` entries we clear the channel and start fresh.
 */
let _trafficEntries = 0;

/**
 * Maps for request → response method correlation. Outgoing requests we send
 * to the agent; incoming requests are agent → client (tool calls, file reads,
 * permission asks). When the matching response arrives we tag it with the
 * original method name. See Zed's
 * `crates/acp_tools/src/acp_tools.rs::WatchedConnection::incoming_request_methods`.
 */
const _outgoingRequestMethods = new Map<string | number, string>();
const _incomingRequestMethods = new Map<string | number, string>();
const PENDING_REQUEST_SOFT_CAP = 256;

/** Structured traffic ring buffer used by `acp.exportTraffic`. */
export interface StructuredTrafficEntry {
  ts: string;
  direction: 'send' | 'recv' | 'stderr';
  kind: 'request' | 'response' | 'notification' | 'stderr' | 'unknown';
  method?: string;
  id?: string | number;
  result?: unknown;
  error?: unknown;
  params?: unknown;
  /** For stderr entries: which agent the line came from. */
  agent?: string;
  /** For stderr entries: the raw line. */
  line?: string;
}
const _trafficRing: StructuredTrafficEntry[] = [];
const TRAFFIC_RING_CAP = 2000;

/** Compact JSON kicks in for frames larger than this many characters. */
const COMPACT_JSON_THRESHOLD = 16 * 1024;

/** Single-entry hard cap. Larger payloads are truncated with a marker. */
const ENTRY_HARD_CAP = 64 * 1024;

export function getOutputChannel(): vscode.OutputChannel {
  if (!_outputChannel) {
    _outputChannel = vscode.window.createOutputChannel('ACP Client');
  }
  return _outputChannel;
}

export function getTrafficChannel(): vscode.OutputChannel {
  if (!_trafficChannel) {
    _trafficChannel = vscode.window.createOutputChannel('ACP Traffic');
  }
  return _trafficChannel;
}

export function log(message: string, ...args: unknown[]): void {
  const timestamp = new Date().toISOString();
  const formatted =
    args.length > 0
      ? `[${timestamp}] ${message} ${args.map((a) => JSON.stringify(a)).join(' ')}`
      : `[${timestamp}] ${message}`;
  getOutputChannel().appendLine(formatted);
}

export function logError(message: string, error?: unknown): void {
  const timestamp = new Date().toISOString();
  const errMsg = error instanceof Error ? error.message : String(error ?? '');
  // Include JSON-RPC error data if present (RequestError has a .data property)
  const errData = (error as any)?.data;
  const fullMsg = errData ? `${errMsg}: ${typeof errData === 'string' ? errData : JSON.stringify(errData)}` : errMsg;
  getOutputChannel().appendLine(`[${timestamp}] ERROR: ${message} ${fullMsg}`);
  if (error instanceof Error && error.stack) {
    getOutputChannel().appendLine(error.stack);
  }
}

function pushRing(entry: StructuredTrafficEntry): void {
  if (_trafficRing.length >= TRAFFIC_RING_CAP) {
    _trafficRing.shift();
  }
  _trafficRing.push(entry);
}

function trimPendingRequestMap(map: Map<string | number, string>): void {
  if (map.size <= PENDING_REQUEST_SOFT_CAP) {
    return;
  }
  // FIFO trim: drop the oldest entry. Map iteration order is insertion order.
  const firstKey = map.keys().next().value;
  if (firstKey !== undefined) {
    map.delete(firstKey);
  }
}

/**
 * Append a stderr line to the `ACP Traffic` channel and ring buffer.
 * Routed via `agent-stderr` events from `AgentManager`. We keep the existing
 * `[<agent> stderr] …` line in the `ACP Client` channel as well — having
 * stderr interleaved with the JSON-RPC frames is essential when the agent
 * dies or misbehaves.
 */
export function logStderr(agentName: string, line: string): void {
  const config = vscode.workspace.getConfiguration('acp');
  if (!config.get<boolean>('logTraffic', true)) {
    return;
  }
  if (!line) {
    return;
  }

  const timestamp = new Date().toISOString();
  const trimmed =
    line.length > ENTRY_HARD_CAP
      ? line.slice(0, ENTRY_HARD_CAP) + `…[truncated, ${line.length - ENTRY_HARD_CAP} more chars]`
      : line;

  const channel = getTrafficChannel();
  channel.appendLine(`[${timestamp}] [${agentName} STDERR] ${trimmed}`);

  pushRing({ ts: timestamp, direction: 'stderr', kind: 'stderr', agent: agentName, line });

  _trafficEntries++;
  const cap = Math.max(50, config.get<number>('logTrafficMaxEntries', 1000));
  if (_trafficEntries >= cap) {
    channel.clear();
    channel.appendLine(
      `[${timestamp}] --- log rotated (kept last 0 of ${_trafficEntries} entries; cap=${cap}; bump acp.logTrafficMaxEntries to keep more) ---\n`,
    );
    _trafficEntries = 0;
  }
}

export function logTraffic(direction: 'send' | 'recv', data: unknown): void {
  const config = vscode.workspace.getConfiguration('acp');
  if (!config.get<boolean>('logTraffic', true)) {
    return;
  }

  const arrow = direction === 'send' ? '>>> CLIENT → AGENT' : '<<< AGENT → CLIENT';
  const timestamp = new Date().toISOString();

  // Classify message type for the human-readable header.
  const msg = data as Record<string, unknown> | null;
  let label = '';
  let chunkLine: string | null = null;
  let ringEntry: StructuredTrafficEntry | null = null;

  if (msg && typeof msg === 'object') {
    if ('method' in msg && 'id' in msg) {
      const method = String(msg.method);
      const id = msg.id as string | number;
      label = ` [REQUEST] ${method}`;
      // Track the in-flight request so we can tag the matching response.
      if (direction === 'send') {
        _outgoingRequestMethods.set(id, method);
        trimPendingRequestMap(_outgoingRequestMethods);
      } else {
        _incomingRequestMethods.set(id, method);
        trimPendingRequestMap(_incomingRequestMethods);
      }
      ringEntry = { ts: timestamp, direction, kind: 'request', method, id, params: (msg as any).params };
    } else if ('method' in msg && !('id' in msg)) {
      const method = String(msg.method);
      label = ` [NOTIFICATION] ${method}`;
      ringEntry = { ts: timestamp, direction, kind: 'notification', method, params: (msg as any).params };

      // Special-case the dominant high-frequency stream events: collapse the
      // entire entry to a single line carrying just the delta. Codex emits
      // these per-token, and the multi-line pretty form wastes ~350 bytes per
      // 1-5 char delta — historically 40+ % of the traffic log file.
      if (method === 'session/update') {
        const params = (msg as any).params as Record<string, unknown> | undefined;
        const update = params?.update as Record<string, unknown> | undefined;
        const kind = update?.sessionUpdate as string | undefined;
        if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
          const content = update?.content as { type?: string; text?: string } | undefined;
          let preview = '';
          if (content?.type === 'text' && typeof content.text === 'string') {
            const oneLine = content.text.replace(/\s+/g, ' ');
            preview = oneLine.length > 80 ? oneLine.slice(0, 80) + '…' : oneLine;
          }
          chunkLine = `[${timestamp}] ${arrow} chunk[${kind === 'agent_message_chunk' ? 'msg' : 'thought'}] ${JSON.stringify(preview)}`;
        } else if (kind === 'tool_call_update') {
          // Collapse tool_call_update notifications (terminal output deltas,
          // progress text) to a single line — these are high-frequency and
          // their full JSON is very verbose.
          const toolCallId = String(update?.toolCallId || '');
          const meta = update?._meta as Record<string, unknown> | undefined;
          const delta = meta?.terminal_output_delta as Record<string, unknown> | undefined;
          let preview = '';
          if (delta?.data && typeof delta.data === 'string') {
            const oneLine = (delta.data as string).replace(/\s+/g, ' ');
            preview = oneLine.length > 80 ? oneLine.slice(0, 80) + '…' : oneLine;
          }
          chunkLine = `[${timestamp}] ${arrow} chunk[tool_update] ${toolCallId.slice(0, 12)} ${JSON.stringify(preview)}`;
        }
      }
    } else if ('result' in msg || 'error' in msg) {
      const id = msg.id as string | number;
      // Match the response back to its originating request. Outgoing
      // requests are answered by INCOMING responses, and vice versa.
      const matchMap = direction === 'recv' ? _outgoingRequestMethods : _incomingRequestMethods;
      const method = matchMap.get(id);
      if (method !== undefined) {
        matchMap.delete(id);
        label = ` [RESPONSE] id=${id} (${method})`;
      } else {
        label = ` [RESPONSE] id=${id}`;
      }
      ringEntry = {
        ts: timestamp,
        direction,
        kind: 'response',
        id,
        method,
        result: 'result' in msg ? (msg as any).result : undefined,
        error: 'error' in msg ? (msg as any).error : undefined,
      };
    }
  }

  // Bound the rotation work for the high-frequency path: write the one-line
  // chunk entry directly and short-circuit the JSON serialisation.
  if (chunkLine !== null) {
    const channel = getTrafficChannel();
    channel.appendLine(chunkLine);
    if (ringEntry) {
      pushRing(ringEntry);
    }
    _trafficEntries++;
    const cap = Math.max(50, config.get<number>('logTrafficMaxEntries', 1000));
    if (_trafficEntries >= cap) {
      channel.clear();
      channel.appendLine(
        `[${timestamp}] --- log rotated (kept last 0 of ${_trafficEntries} entries; cap=${cap}; bump acp.logTrafficMaxEntries to keep more) ---\n`,
      );
      _trafficEntries = 0;
    }
    return;
  }

  // Pretty-print small frames for readability; switch to compact JSON for
  // anything larger so the channel doesn't balloon. Embedded resource blocks
  // (file contents, terminal output) are typically the worst offenders.
  let body: string;
  try {
    const compact = JSON.stringify(data);
    if (compact.length > COMPACT_JSON_THRESHOLD) {
      body = compact;
    } else {
      body = JSON.stringify(data, null, 2);
    }
  } catch {
    body = String(data);
  }

  if (body.length > ENTRY_HARD_CAP) {
    const dropped = body.length - ENTRY_HARD_CAP;
    body = body.slice(0, ENTRY_HARD_CAP) + `\n…[truncated, ${dropped} more chars]`;
  }

  const channel = getTrafficChannel();
  channel.appendLine(`[${timestamp}] ${arrow}${label}\n${body}\n`);

  if (ringEntry === null) {
    // Couldn't classify — still record the raw envelope for export.
    ringEntry = { ts: timestamp, direction, kind: 'unknown' };
  }
  pushRing(ringEntry);

  // Rotate the channel after N entries. Default 1000 entries roughly bounds
  // the in-memory channel buffer to a few tens of MB even for chatty agents.
  _trafficEntries++;
  const cap = Math.max(50, config.get<number>('logTrafficMaxEntries', 1000));
  if (_trafficEntries >= cap) {
    channel.clear();
    channel.appendLine(
      `[${timestamp}] --- log rotated (kept last 0 of ${_trafficEntries} entries; cap=${cap}; bump acp.logTrafficMaxEntries to keep more) ---\n`,
    );
    _trafficEntries = 0;
  }
}

/**
 * Return a snapshot of the in-memory structured traffic buffer. The buffer
 * is capped at the last 2000 entries (see {@link TRAFFIC_RING_CAP}). Used by
 * `acp.exportTraffic` to write a JSON dump for bug reports.
 */
export function getStructuredTraffic(): StructuredTrafficEntry[] {
  return _trafficRing.slice();
}

/** Test/diagnostic-only: clear all in-memory state. */
export function disposeChannels(): void {
  _outputChannel?.dispose();
  _trafficChannel?.dispose();
  _outputChannel = undefined;
  _trafficChannel = undefined;
  _trafficEntries = 0;
  _outgoingRequestMethods.clear();
  _incomingRequestMethods.clear();
  _trafficRing.length = 0;
}

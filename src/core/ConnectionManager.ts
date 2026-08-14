import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { Agent, InitializeResponse } from '@agentclientprotocol/sdk';
import type { Stream } from '@agentclientprotocol/sdk/dist/stream.js';
import { ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';

import { AcpClientImpl } from './AcpClientImpl';
import { FileSystemHandler } from '../handlers/FileSystemHandler';
import { TerminalHandler } from '../handlers/TerminalHandler';
import { PermissionHandler } from '../handlers/PermissionHandler';
import { ElicitationHandler } from '../handlers/ElicitationHandler';
import { SessionUpdateHandler } from '../handlers/SessionUpdateHandler';
import { log, logError, logTraffic } from '../utils/Logger';
import { version as extensionVersion } from '../../package.json';

export interface ConnectionInfo {
  connection: ClientSideConnection;
  client: AcpClientImpl;
  initResponse: InitializeResponse;
  onKiroMetadata?: (params: any) => void;
  onKiroSubagentListUpdate?: (params: any) => void;
  /** `_kiro.dev/commands/available` — Kiro slash-command catalog. */
  onKiroCommandsAvailable?: (params: any) => void;
  /** `_kiro.dev/compaction/status` — context compaction progress. */
  onKiroCompactionStatus?: (params: any) => void;
  /** `_kiro.dev/clear/status` — session history clear progress. */
  onKiroClearStatus?: (params: any) => void;
  /** `_kiro.dev/goal/status` — Kiro CLI goal lifecycle notification. */
  onKiroGoalStatus?: (params: any) => void;
  /** `_session/terminate` — subagent session terminated. */
  onSessionTerminate?: (params: any) => void;
  /**
   * Cursor ACP extension methods (`cursor/*`). Notifications have no `id`;
   * blocking requests include `id` and must be answered via `respond`.
   * Return true if the frame was fully handled (do not forward to the SDK).
   */
  onCursorMethod?: (msg: {
    method: string;
    params: any;
    id?: number | string;
    respond: (result: unknown) => void;
  }) => boolean;
}

/**
 * Manages ACP connections to agent processes.
 * Creates ClientSideConnection instances from spawned child processes.
 */
export class ConnectionManager {
  private connections: Map<string, ConnectionInfo> = new Map();

  constructor(private readonly sessionUpdateHandler: SessionUpdateHandler) {}

  /**
   * Create an ACP connection from a child process.
   * Sets up streams, creates connection, and performs initialization handshake.
   */
  async connect(agentId: string, process: ChildProcess): Promise<ConnectionInfo> {
    if (!process.stdout || !process.stdin) {
      throw new Error('Agent process missing stdio streams');
    }

    log(`ConnectionManager: connecting to agent ${agentId}`);

    // Create Web Streams from Node.js streams
    const readable = Readable.toWeb(process.stdout) as ReadableStream<Uint8Array>;
    const writable = Writable.toWeb(process.stdin) as WritableStream<Uint8Array>;

    const stream = ndJsonStream(writable, readable);

    // Wrap the stream to intercept and log all ACP traffic
    const tappedStream = this.tapStream(stream, agentId, process.stdin);

    // Create handlers
    const fsHandler = new FileSystemHandler();
    const terminalHandler = new TerminalHandler();
    const permissionHandler = new PermissionHandler();
    const elicitationHandler = new ElicitationHandler();

    // Create client implementation
    const client = new AcpClientImpl(
      fsHandler,
      terminalHandler,
      permissionHandler,
      this.sessionUpdateHandler,
      elicitationHandler,
    );

    // Create connection — toClient factory receives the Agent proxy
    const connection = new ClientSideConnection((agent: Agent) => {
      client.setAgent(agent);
      return client;
    }, tappedStream);

    // Initialize the connection
    log(`ConnectionManager: initializing connection to agent ${agentId}`);
    const initResponse = await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: {
        name: 'vscode-acp-client',
        version: extensionVersion,
      },
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
        terminal: true,
        // Advertise plan support so agents send plan_update / plan_removed
        // instead of only full plan replacements.
        plan: {},
        // Advertise auth.terminal so agents can offer terminal-based auth.
        auth: {
          terminal: true,
        },
        // Advertise elicitation support (form + url). Agents that need
        // structured user input can then use createElicitation.
        elicitation: {
          form: {},
          url: {},
        },
        // Advertise NES support (experimental). codex-acp does NOT support
        // NES yet, so it will simply not send nes/suggest requests.
        // Other agents (e.g. Zed's) can then use it.
        nes: {},
        // NOTE: do NOT set `_meta.terminal_output: true`. That would tell
        // codex-acp's `resolveTerminalOutputMode` to send a FULL snapshot of
        // the terminal buffer in every update meta — O(N²) bandwidth for
        // long shell commands. We don't consume the meta payload anywhere,
        // so the default `terminal_output_delta` (only the new bytes) is
        // strictly better.
      },
    });

    log(
      `ConnectionManager: initialized. Agent: ${initResponse.agentInfo?.name || 'unknown'} v${initResponse.agentInfo?.version || '?'}`,
    );

    const info: ConnectionInfo = { connection, client, initResponse };
    this.connections.set(agentId, info);

    return info;
  }

  getConnection(agentId: string): ConnectionInfo | undefined {
    return this.connections.get(agentId);
  }

  removeConnection(agentId: string): void {
    this.connections.delete(agentId);
  }

  dispose(): void {
    // Connections close when the agent process is killed (stdin/stdout
    // pipes close → stream ends → connection aborts). No explicit close
    // needed here — just clear the map.
    this.connections.clear();
  }

  /**
   * Wrap a Stream to intercept and log all messages in both directions.
   */
  private tapStream(stream: Stream, agentId: string, stdin: NodeJS.WritableStream): Stream {
    // Tap outgoing messages (client → agent)
    const sendTap = new TransformStream({
      transform(chunk: unknown, controller: TransformStreamDefaultController) {
        logTraffic('send', chunk);
        controller.enqueue(chunk);
      },
    });

    const writeAgentResponse = (id: number | string, result: unknown): void => {
      try {
        const frame = { jsonrpc: '2.0', id, result };
        logTraffic('send', frame);
        stdin.write(JSON.stringify(frame) + '\n');
      } catch (e) {
        logError('Failed to write agent extension response', e);
      }
    };

    // Tap incoming messages (agent → client)
    const recvTap = new TransformStream({
      transform: (chunk: unknown, controller: TransformStreamDefaultController) => {
        logTraffic('recv', chunk);
        // Intercept vendor extension methods the ACP SDK does not dispatch
        // to Client handlers (Kiro `_kiro.dev/*`, `_session/terminate`,
        // Cursor `cursor/*`).
        if (chunk && typeof chunk === 'object' && typeof (chunk as any).method === 'string') {
          const method = (chunk as any).method as string;
          const params = (chunk as any).params;
          const id = (chunk as any).id as number | string | undefined;
          const info = this.connections.get(agentId);

          if (params && (method.startsWith('_kiro.dev/') || method === '_session/terminate')) {
            if (method === '_kiro.dev/metadata' && info?.onKiroMetadata) {
              info.onKiroMetadata(params);
            } else if (method === '_kiro.dev/subagent/list_update' && info?.onKiroSubagentListUpdate) {
              info.onKiroSubagentListUpdate(params);
            } else if (method === '_kiro.dev/commands/available' && info?.onKiroCommandsAvailable) {
              info.onKiroCommandsAvailable(params);
            } else if (method === '_kiro.dev/compaction/status' && info?.onKiroCompactionStatus) {
              info.onKiroCompactionStatus(params);
            } else if (method === '_kiro.dev/clear/status' && info?.onKiroClearStatus) {
              info.onKiroClearStatus(params);
            } else if (method === '_kiro.dev/goal/status' && info?.onKiroGoalStatus) {
              info.onKiroGoalStatus(params);
            } else if (method === '_session/terminate' && info?.onSessionTerminate) {
              info.onSessionTerminate(params);
            }
          } else if (params && method.startsWith('cursor/') && info?.onCursorMethod) {
            const handled = info.onCursorMethod({
              method,
              params,
              id,
              respond: (result: unknown) => {
                if (id === undefined || id === null) {
                  return;
                }
                writeAgentResponse(id, result);
              },
            });
            if (handled) {
              // Consume — do not forward unknown cursor/* frames to the SDK
              // (blocking requests would otherwise hang / method-not-found).
              return;
            }
          }
        }
        controller.enqueue(chunk);
      },
    });

    // Pipe: sendTap.readable → original writable, original readable → recvTap.writable
    // These run in the background — no need to await
    void sendTap.readable.pipeTo(stream.writable).catch((e) => logError('Traffic tap send pipe error', e));
    void stream.readable.pipeTo(recvTap.writable).catch((e) => logError('Traffic tap recv pipe error', e));

    return {
      writable: sendTap.writable,
      readable: recvTap.readable,
    };
  }
}

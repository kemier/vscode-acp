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
    const tappedStream = this.tapStream(stream, agentId);

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
  private tapStream(stream: Stream, agentId: string): Stream {
    // Tap outgoing messages (client → agent)
    const sendTap = new TransformStream({
      transform(chunk: unknown, controller: TransformStreamDefaultController) {
        logTraffic('send', chunk);
        controller.enqueue(chunk);
      },
    });

    // Tap incoming messages (agent → client)
    const recvTap = new TransformStream({
      transform: (chunk: unknown, controller: TransformStreamDefaultController) => {
        logTraffic('recv', chunk);
        // Intercept _kiro.dev/metadata notifications (Kiro CLI specific)
        if (chunk && typeof chunk === 'object' && (chunk as any).method === '_kiro.dev/metadata') {
          const params = (chunk as any).params;
          if (params) {
            const info = this.connections.get(agentId);
            if (info?.onKiroMetadata) {
              info.onKiroMetadata(params);
            }
          }
        }
        // Intercept _kiro.dev/subagent/list_update notifications (Kiro CLI specific)
        if (chunk && typeof chunk === 'object' && (chunk as any).method === '_kiro.dev/subagent/list_update') {
          const params = (chunk as any).params;
          if (params) {
            const info = this.connections.get(agentId);
            if (info?.onKiroSubagentListUpdate) {
              info.onKiroSubagentListUpdate(params);
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

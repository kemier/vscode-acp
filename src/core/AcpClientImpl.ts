import type {
  Client,
  Agent,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  WriteTextFileRequest,
  WriteTextFileResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  CreateTerminalRequest,
  CreateTerminalResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  CreateElicitationRequest,
  CreateElicitationResponse,
  CompleteElicitationNotification,
} from '@agentclientprotocol/sdk';

import { FileSystemHandler } from '../handlers/FileSystemHandler';
import { TerminalHandler } from '../handlers/TerminalHandler';
import { PermissionHandler } from '../handlers/PermissionHandler';
import { SessionUpdateHandler } from '../handlers/SessionUpdateHandler';
import { ElicitationHandler } from '../handlers/ElicitationHandler';
import { JevClient, readJevSettings, type JevSettings } from '../jev/JevClient';
import { executeJudgeTool } from '../jev/JevJudgeTool';
import { log } from '../utils/Logger';

/**
 * ACP Client implementation for VS Code.
 * Delegates to individual handlers for each capability.
 *
 * Passed as a factory to ClientSideConnection:
 *   new ClientSideConnection((agent) => new AcpClientImpl(...), stream)
 */
export class AcpClientImpl implements Client {
  private agent: Agent | null = null;

  /**
   * The `jev_judge` native tool. ACP has no client→agent tool-registration
   * method, so the tool is delivered through elicitation: when an agent
   * (or its system prompt, per AGENTS.md) asks for a Jev judgement via
   * `unstable_createElicitation` with `_meta.tool === "jev_judge"`, we run
   * the judgement here and return the verdicts as the elicitation content.
   * See docs/jev-integration-spec.md.
   */
  private jevSettings: JevSettings | null = null;
  private jevClient: JevClient | null = null;

  constructor(
    private readonly fsHandler: FileSystemHandler,
    private readonly terminalHandler: TerminalHandler,
    private readonly permissionHandler: PermissionHandler,
    private readonly sessionUpdateHandler: SessionUpdateHandler,
    private readonly elicitationHandler: ElicitationHandler,
  ) {}

  setAgent(agent: Agent): void {
    this.agent = agent;
  }

  getAgent(): Agent | null {
    return this.agent;
  }

  // --- Required methods ---

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    return this.permissionHandler.requestPermission(params);
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.sessionUpdateHandler.handleUpdate(params);
  }

  // --- File system methods ---

  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    log(`Client.writeTextFile: ${params.path}`);
    return this.fsHandler.writeTextFile(params);
  }

  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    log(`Client.readTextFile: ${params.path}`);
    return this.fsHandler.readTextFile(params);
  }

  // --- Terminal methods ---

  async createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    return this.terminalHandler.createTerminal(params);
  }

  async terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
    return this.terminalHandler.terminalOutput(params);
  }

  async waitForTerminalExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
    return this.terminalHandler.waitForTerminalExit(params);
  }

  async killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse> {
    return this.terminalHandler.killTerminal(params);
  }

  async releaseTerminal(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
    return this.terminalHandler.releaseTerminal(params);
  }

  // --- Elicitation methods (experimental) ---
  // Used by agents that need structured user input (forms or URL-based flows).
  // Note: codex-acp currently uses requestPermission for MCP elicitation
  // rather than unstable_createElicitation, so these are for other agents.

  async unstable_createElicitation(params: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    log(`Client.unstable_createElicitation: mode=${params.mode}`);
    // Native-tool dispatch: an elicitation carrying _meta.tool === "jev_judge"
    // is a Jev judgement request, not a form for the user. Run it against the
    // Jev API and answer directly — no prompt shown.
    const meta = (params as any)?._meta;
    if (meta && meta.tool === 'jev_judge') {
      return this.handleJevJudge(meta);
    }
    return this.elicitationHandler.createElicitation(params);
  }

  /**
   * Execute a `jev_judge` native-tool call arriving over elicitation.
   * `meta.input` carries { state, judgements } (see JevJudgeTool).
   * Always answers with action=accept so the agent never blocks on a human
   * for a machine judgment; errors come back in the content text.
   */
  private async handleJevJudge(meta: any): Promise<CreateElicitationResponse> {
    const settings = this.getJevSettings();
    if (!settings.enabled) {
      return {
        action: 'accept' as const,
        content: { result: 'jev_judge: disabled — set "acp.jev.enabled": true (and acp.jev.apiKey or TYPESAFE_API_KEY) to enable.' },
      };
    }
    const client = this.getJevClient(settings);
    const result = await executeJudgeTool(meta.input, { client, log });
    return { action: 'accept' as const, content: { result } };
  }

  private getJevSettings(): JevSettings {
    if (!this.jevSettings) {
      this.jevSettings = readJevSettings();
    }
    return this.jevSettings;
  }

  private getJevClient(settings: JevSettings): JevClient {
    if (!this.jevClient) {
      this.jevClient = new JevClient({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        timeoutMs: settings.timeoutMs,
      });
    }
    return this.jevClient;
  }

  async unstable_completeElicitation(params: CompleteElicitationNotification): Promise<void> {
    log(`Client.unstable_completeElicitation: id=${params.elicitationId}`);
    return this.elicitationHandler.completeElicitation(params);
  }
}

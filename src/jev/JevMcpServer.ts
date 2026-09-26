import * as path from 'node:path';

import type { McpServer, EnvVariable } from '@agentclientprotocol/sdk';
import { readJevSettings, type JevSettings } from './JevClient';

/**
 * Jev MCP server registration for the Claude Code agent.
 *
 * The Claude CLI only sees a tool if it's in `mcpServers` (vscode-acp →
 * claude-code-acp `--mcp-config`). The `jev-mcp` stdio server
 * (claude-code-acp/dist/jev-mcp-stdio.js) already exists and reads JEV_BASE_URL /
 * JEV_API_KEY / JEV_MODEL / JEV_TIMEOUT_MS from its env. This module builds the
 * one ACP `McpServer` entry that makes the CLI spawn it — gated to the Claude
 * Code agent only (ericli has a native `jev_decide`, codex has none), and only
 * when `acp.jev.enabled` is true.
 *
 * The emitted shape is the ACP *wire* type (`McpServerStdio`: flat
 * `{name, command, args, env: EnvVariable[]}`), which is what
 * `newSession`/`loadSession`/`resumeSession` accept. The agent side must parse
 * that flat shape (see claude-code-acp agent.ts newSession).
 */

/** The `acp.agents` key for the Claude Code CLI.
 *
 * NOTE: the runtime agentName passed by SessionManager is the config key from
 * `acp.agents`. In the deployed setup this is "ClaudeCode CLI" (Machine-scope),
 * not "Claude Code" (the package.json default / User-scope displayName).
 */
export const CLAUDE_AGENT_NAME = 'ClaudeCode CLI';

/**
 * Resolve the absolute path to the `jev-mcp` stdio server.
 *
 * Derives it from the Claude Code agent's own `command` (which points at
 * claude-code-acp/bin/claude-code-acp.js) so the server used is the sibling
 * `dist/jev-mcp-stdio.js` of whichever claude-code-acp build is actually
 * deployed — no cross-repo hard-coding. Falls back to a known default when the
 * agent config is absent.
 */
export function resolveJevMcpServerPath(claudeCommand?: string): string {
  if (claudeCommand) {
    return path.join(path.dirname(claudeCommand), '..', 'dist', 'jev-mcp-stdio.js');
  }
  // Fallback for unit tests / when getAgentConfig is unavailable.
  return 'claude-code-acp/dist/jev-mcp-stdio.js';
}

/**
 * Build the `mcpServers` entry that registers `jev-mcp` for the Claude Code
 * agent. Returns `[]` for any other agent or when Jev is disabled / keyless, so
 * callers can splice the result in place of the literal `mcpServers: []` with no
 * further branching.
 *
 * `settings` and `claudeCommand` are injected for unit-testability; the
 * no-arg form resolves them from live config.
 */
export function buildJevMcpServers(
  agentName: string,
  settings?: JevSettings,
  claudeCommand?: string,
): McpServer[] {
  if (agentName !== CLAUDE_AGENT_NAME) {
    return [];
  }
  const jev = settings ?? readJevSettings();
  if (!jev.enabled || !jev.apiKey) {
    return [];
  }
  const env: EnvVariable[] = [
    { name: 'JEV_BASE_URL', value: jev.baseUrl },
    { name: 'JEV_API_KEY', value: jev.apiKey },
    { name: 'JEV_MODEL', value: jev.model },
    { name: 'JEV_TIMEOUT_MS', value: String(jev.timeoutMs) },
  ];
  return [
    {
      name: 'jev-mcp',
      command: 'node',
      args: [resolveJevMcpServerPath(claudeCommand)],
      env,
    },
  ];
}

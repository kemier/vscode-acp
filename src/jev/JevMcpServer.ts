import * as path from 'node:path';

import type { McpServer, EnvVariable } from '@agentclientprotocol/sdk';
import { getAgentConfig, getAgentConfigs } from '../config/AgentConfig';
import { readJevSettings, type JevSettings } from './JevClient';

/**
 * Jev MCP server registration for agents that discover tools via ACP
 * `mcpServers` (Claude Code + Cursor).
 *
 * vscode-acp injects the `jev-mcp` stdio server (claude-code-acp's
 * `dist/jev-mcp-stdio.js`) into session/new|load|resume when
 * `acp.jev.enabled` is true. The child agent then sees a real `jev_judge`
 * tool mid-turn. Ericli has a native `jev_decide`; Codex has neither path.
 *
 * Cursor's ACP session-resources parser accepts the flat ACP wire shape
 * `{name, command, args, env: [{name,value}]}` and maps entries with
 * `command` to stdio MCP — same shape Claude Code uses.
 *
 * The emitted shape is the ACP *wire* type (`McpServerStdio`).
 */

export interface AgentCommandHint {
  command?: string;
  args?: string[];
}

/** Join command + args for binary detection (handles `node …/claude-code-acp.js`). */
function commandBlob(command?: string, args?: string[]): string {
  return [command, ...(args ?? [])].filter((x): x is string => typeof x === 'string' && x.length > 0).join(' ');
}

function resolveHint(agentName: string, hint?: AgentCommandHint | string): AgentCommandHint {
  if (typeof hint === 'string') {
    // Back-compat: SessionManager used to pass only `command`.
    try {
      const cfg = getAgentConfig(agentName);
      return { command: hint, args: cfg?.args };
    } catch {
      return { command: hint };
    }
  }
  if (hint && (hint.command !== undefined || hint.args !== undefined)) {
    return hint;
  }
  try {
    const cfg = getAgentConfig(agentName);
    return { command: cfg?.command, args: cfg?.args };
  } catch {
    return {};
  }
}

/**
 * True when this `acp.agents` entry is the Claude Code ACP binary.
 * Matches command *or* args (settings often use `command: "node"` + script path).
 */
export function isClaudeCodeAgent(agentName: string, hint?: AgentCommandHint | string): boolean {
  const { command, args } = resolveHint(agentName, hint);
  const blob = commandBlob(command, args);
  if (blob && /claude-code-acp/i.test(blob)) {
    return true;
  }
  if (!blob) {
    return /^(Claude\s*Code|ClaudeCode(\s*CLI)?)$/i.test(agentName.trim());
  }
  return false;
}

/**
 * True when this `acp.agents` entry is the Cursor ACP agent.
 * Cursor accepts session `mcpServers` with stdio `command` the same way Claude does.
 */
export function isCursorAgent(agentName: string, hint?: AgentCommandHint | string): boolean {
  const { command, args } = resolveHint(agentName, hint);
  const blob = commandBlob(command, args);
  if (blob && /cursor-agent|cursor-acp/i.test(blob)) {
    return true;
  }
  if (!blob) {
    return /^Cursor$/i.test(agentName.trim());
  }
  // Name contains Cursor and command isn't another known agent binary.
  return /cursor/i.test(agentName) && !/claude-code-acp|codex-acp|kiro|ericli/i.test(blob);
}

/** Agents that receive the jev-mcp stdio injection. */
export function isJevMcpEligibleAgent(agentName: string, hint?: AgentCommandHint | string): boolean {
  return isClaudeCodeAgent(agentName, hint) || isCursorAgent(agentName, hint);
}

/**
 * @deprecated Use {@link isClaudeCodeAgent}. Kept for call sites / docs that
 * still refer to the Machine-scope key spelling.
 */
export const CLAUDE_AGENT_NAME = 'ClaudeCode CLI';

/** Absolute path to a configured `claude-code-acp.js` (or bare command name). */
function findClaudeCodeAcpScript(): string | undefined {
  try {
    for (const entry of Object.values(getAgentConfigs())) {
      if (typeof entry.command === 'string' && /claude-code-acp/i.test(entry.command)) {
        return entry.command;
      }
      const arg = entry.args?.find((a) => typeof a === 'string' && /claude-code-acp/i.test(a));
      if (arg) {
        return arg;
      }
    }
  } catch {
    // unit-test shim / no vscode
  }
  return undefined;
}

/**
 * Resolve the absolute path to the `jev-mcp` stdio server.
 *
 * The server ships with claude-code-acp (`dist/jev-mcp-stdio.js`), not with
 * cursor-agent. Prefer the Claude Code script path from the current hint or
 * from any `acp.agents` entry, then fall back to a relative default.
 */
export function resolveJevMcpServerPath(hint?: AgentCommandHint | string): string {
  let script: string | undefined;
  if (typeof hint === 'string') {
    script = /claude-code-acp/i.test(hint) ? hint : undefined;
  } else if (hint) {
    if (hint.command && /claude-code-acp/i.test(hint.command)) {
      script = hint.command;
    } else {
      script = hint.args?.find((a) => /claude-code-acp/i.test(a));
    }
  }
  script = script ?? findClaudeCodeAcpScript();
  if (script && path.isAbsolute(script)) {
    // …/bin/claude-code-acp.js → …/dist/jev-mcp-stdio.js
    return path.join(path.dirname(script), '..', 'dist', 'jev-mcp-stdio.js');
  }
  if (script && /claude-code-acp/i.test(script)) {
    return path.join(path.dirname(script), '..', 'dist', 'jev-mcp-stdio.js');
  }
  return 'claude-code-acp/dist/jev-mcp-stdio.js';
}

/**
 * Build the `mcpServers` entry that registers `jev-mcp` for Claude Code or
 * Cursor. Returns `[]` for any other agent or when Jev is disabled / keyless.
 *
 * `settings` and `hint` are injected for unit-testability; when `hint` is
 * omitted, command/args come from `acp.agents` via {@link getAgentConfig}.
 */
export function buildJevMcpServers(
  agentName: string,
  settings?: JevSettings,
  hint?: AgentCommandHint | string,
): McpServer[] {
  const resolved = resolveHint(agentName, hint);
  if (!isJevMcpEligibleAgent(agentName, resolved)) {
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
      args: [resolveJevMcpServerPath(resolved)],
      env,
    },
  ];
}

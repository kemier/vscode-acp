import * as fs from 'node:fs';
import * as path from 'node:path';

import type { McpServer, EnvVariable } from '@agentclientprotocol/sdk';
import { getAgentConfig, getAgentConfigs } from '../config/AgentConfig';
import { readJevSettings, type JevSettings } from './JevClient';

/**
 * Jev MCP server registration for agents that discover tools via ACP
 * `mcpServers` (Claude Code + Cursor + Codex CLI).
 *
 * vscode-acp injects the `jev-mcp` stdio server (claude-code-acp's
 * `dist/jev-mcp-stdio.js`) into session/new|load|resume when
 * `acp.jev.enabled` is true. The child agent then sees a real `jev_judge`
 * tool mid-turn. Ericli has a native `jev_decide` (env-gated), so it is
 * NOT covered here.
 *
 * All three consumers (claude-code-acp, cursor-agent, codex-acp) accept the
 * flat ACP wire shape `{name, command, args, env: [{name,value}]}`. The
 * claude-code-acp `normalizeMcpServers` layer accepts both the flat shape and
 * the legacy `{transport}` wrapper, so the flat shape is safe for all three.
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

/**
 * True when this `acp.agents` entry is the Codex CLI ACP agent.
 * codex-acp reads the flat ACP `McpServerStdio` and forwards it to the Codex
 * app-server `mcp_servers` (the ACP SDK's zod layer silently drops a
 * non-matching `transport` wrapper, so the flat shape is required here — which
 * is the same shape this module already emits for Claude Code / Cursor).
 */
export function isCodexAgent(agentName: string, hint?: AgentCommandHint | string): boolean {
  const { command, args } = resolveHint(agentName, hint);
  const blob = commandBlob(command, args);
  if (blob && /codex-acp/i.test(blob)) {
    return true;
  }
  if (!blob) {
    return /codex/i.test(agentName.trim());
  }
  // Name contains codex and command isn't another known agent binary.
  return /codex/i.test(agentName) && !/claude-code-acp|cursor|kiro|ericli/i.test(blob);
}

/** Agents that receive the jev-mcp stdio injection. */
export function isJevMcpEligibleAgent(agentName: string, hint?: AgentCommandHint | string): boolean {
  return isClaudeCodeAgent(agentName, hint) || isCursorAgent(agentName, hint) || isCodexAgent(agentName, hint);
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

/** The Jev MCP server entry, relative to the root of a claude-code-acp checkout. */
const JEV_MCP_SERVER_RELATIVE = path.join('dist', 'jev-mcp-stdio.js');

/**
 * Directory candidates for locating the `jev-mcp` stdio server, derived from a
 * configured `claude-code-acp` command path.
 *
 * The `acp.agents` command is not always the real binary. It may be:
 *   - the binary itself (…/bin/claude-code-acp.js) — the common case;
 *   - a **symlink** to the binary (…/.local/bin/claude-code-acp → repo/bin/…);
 *   - a **wrapper shell script** that `exec`s the real binary
 *     (…/.local/bin/claude-code-acp-ccr → exec …/.local/bin/claude-code-acp).
 *
 * A naive `dirname(command) + '/../dist'` only works for the first case. For a
 * wrapper, the script lives beside no `dist/`, and `realpath` is a no-op (it is
 * a regular file, not a symlink) — so the derived path points at a non-existent
 * `dist/jev-mcp-stdio.js` and the Claude CLI silently fails to spawn the server
 * (no `jev_judge` tool, no error). To handle all three shapes we collect every
 * plausible "script directory": the command's own dir, the symlink-resolved
 * dir, and — when the command is a wrapper script — the dir of the absolute
 * path it `exec`s (and that target's symlink resolution). Callers pick the first
 * candidate that actually contains the server.
 */
function jevMcpServerCandidateDirs(script: string): string[] {
  const dirs = new Set<string>();
  const add = (p?: string): void => {
    if (p && path.isAbsolute(p)) {
      dirs.add(p);
    }
  };
  add(path.dirname(script));
  try {
    add(path.dirname(fs.realpathSync(script)));
  } catch {
    // not resolvable — fine, other candidates may still work
  }
  // Wrapper script: follow the `exec <absolute path>` it launches.
  try {
    if (fs.statSync(script).isFile()) {
      const text = fs.readFileSync(script, 'utf8');
      const m = text.match(/\bexec\s+(\/\S+)/);
      if (m) {
        add(path.dirname(m[1]));
        try {
          add(path.dirname(fs.realpathSync(m[1])));
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
  return [...dirs];
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
    // …/bin/claude-code-acp.js (or a wrapper/symlink to it) → …/dist/jev-mcp-stdio.js
    // Probe candidate dirs so wrapper/symlink launchers resolve to the real
    // checkout; fall back to the legacy `dirname/../dist` derivation when no
    // candidate exists on disk (unit tests, or a not-yet-deployed layout).
    for (const dir of jevMcpServerCandidateDirs(script)) {
      const candidate = path.join(dir, '..', JEV_MCP_SERVER_RELATIVE);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return path.join(path.dirname(script), '..', JEV_MCP_SERVER_RELATIVE);
  }
  if (script && /claude-code-acp/i.test(script)) {
    return path.join(path.dirname(script), '..', JEV_MCP_SERVER_RELATIVE);
  }
  return 'claude-code-acp/dist/jev-mcp-stdio.js';
}

/**
 * Build the `mcpServers` entry that registers `jev-mcp` for Claude Code,
 * Cursor, or Codex CLI. Returns `[]` for any other agent or when Jev is
 * disabled / keyless.
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

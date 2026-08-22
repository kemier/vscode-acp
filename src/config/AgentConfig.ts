import * as vscode from 'vscode';
import { execFileSync } from 'node:child_process';

import { log } from '../utils/Logger';

/**
 * Configuration for a single ACP agent.
 */
export interface AgentConfigEntry {
  /** NPX package to run (e.g., "@anthropic-ai/claude-code@latest") */
  command: string;
  /** Command-line arguments */
  args?: string[];
  /** Environment variables */
  env?: Record<string, string>;
  /** Display name */
  displayName?: string;
}

/** True when `command` resolves on PATH (cursor-agent, codex-acp, etc.). */
function isCommandOnPath(command: string): boolean {
  try {
    if (process.platform === 'win32') {
      execFileSync('where', [command], { stdio: 'ignore' });
    } else {
      execFileSync('which', [command], { stdio: 'ignore' });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Prefer `cursor-agent acp` on PATH over the `cursor-acp` wrapper script.
 * Falls back to `cursor-acp` when cursor-agent is not installed.
 */
function resolveCursorAgentEntry(entry: AgentConfigEntry): AgentConfigEntry {
  if (entry.command === 'cursor-acp') {
    if (isCommandOnPath('cursor-agent')) {
      return { ...entry, command: 'cursor-agent', args: ['acp'] };
    }
    return entry;
  }
  if (entry.command !== 'cursor-agent') {
    return entry;
  }
  if (isCommandOnPath('cursor-agent')) {
    return { ...entry, args: entry.args?.length ? entry.args : ['acp'] };
  }
  if (isCommandOnPath('cursor-acp')) {
    log('cursor-agent not on PATH — falling back to cursor-acp');
    return { ...entry, command: 'cursor-acp', args: [] };
  }
  return { ...entry, args: entry.args?.length ? entry.args : ['acp'] };
}

/**
 * Read agent configurations from VS Code settings.
 * Returns a map of agent name → config.
 *
 * VS Code merges object-typed settings with package.json defaults, so a
 * removed built-in agent must be tombstoned as `null` in user/workspace
 * settings (same pattern as `terminal.integrated.profiles.*`). Filter those
 * out here so the tree / connect UI never shows them.
 */
export function getAgentConfigs(): Record<string, AgentConfigEntry> {
  const config = vscode.workspace.getConfiguration('acp');
  const agents = config.get<Record<string, AgentConfigEntry | null>>('agents', {});
  const result: Record<string, AgentConfigEntry> = {};
  for (const [name, entry] of Object.entries(agents)) {
    if (entry && typeof entry === 'object' && typeof entry.command === 'string') {
      const resolved =
        entry.command === 'cursor-agent' || entry.command === 'cursor-acp'
          ? resolveCursorAgentEntry(entry)
          : entry;
      result[name] = resolved;
    }
  }
  return result;
}

/**
 * Get the list of agent names available.
 */
export function getAgentNames(): string[] {
  return Object.keys(getAgentConfigs());
}

/**
 * Get a specific agent config by name.
 */
export function getAgentConfig(name: string): AgentConfigEntry | undefined {
  return getAgentConfigs()[name];
}

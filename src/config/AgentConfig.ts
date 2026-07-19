import * as vscode from 'vscode';

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
      result[name] = entry;
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

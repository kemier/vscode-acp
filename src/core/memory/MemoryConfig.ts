/**
 * VS Code settings for TencentDB Agent Memory (Model B).
 *
 * Model B: shared team_id / user_id / service_id across all ACP agents;
 * each agent type maps to its own agent_id (codex / claude / kiro / …)
 * so L2/L3 profiles stay separate while team-visible Skills / Knowledge
 * can still be shared via Memory Hub ACLs.
 */
import * as vscode from 'vscode';
import * as os from 'os';

export { resolveMemoryAgentId } from './MemoryAgentId';

export interface MemorySettings {
  enabled: boolean;
  endpoint: string;
  apiKey: string;
  serviceId: string;
  teamId: string;
  userId: string;
  /** Optional explicit overrides: ACP agent name → MemoryCore agent_id. */
  agentIdMap: Record<string, string>;
  recallMaxResults: number;
  includePersona: boolean;
  includeSceneNav: boolean;
  includeSkills: boolean;
  skillCharBudget: number;
  captureEnabled: boolean;
  timeoutMs: number;
  /** Verbose timing/debug logging for recall + injection. Off by default. */
  debug: boolean;
}

const DEFAULT_ENDPOINT = 'http://127.0.0.1:8420';

export function readMemorySettings(): MemorySettings {
  // Read via the root 'acp' section with the full dotted suffix
  // ('acp').get('memory.<key>') so the resolved key is unambiguously
  // 'acp.memory.<key>' — the same id declared in package.json. Keep this form
  // when adding keys; use `describeMemoryConfigSources()` to see which
  // settings scope each value came from.
  const cfg = vscode.workspace.getConfiguration('acp');
  const agentIdMapRaw = cfg.get<Record<string, string>>('memory.agentIdMap') ?? {};
  const agentIdMap: Record<string, string> = {};
  for (const [k, v] of Object.entries(agentIdMapRaw)) {
    if (typeof k === 'string' && typeof v === 'string' && k.trim() && v.trim()) {
      agentIdMap[k.trim()] = v.trim();
    }
  }

  const userIdSetting = (cfg.get<string>('memory.userId') ?? '').trim();
  const userId = userIdSetting || os.userInfo().username || process.env.USER || process.env.USERNAME || 'default';

  return {
    enabled: cfg.get<boolean>('memory.enabled') === true,
    endpoint: (cfg.get<string>('memory.endpoint') || DEFAULT_ENDPOINT).replace(/\/+$/, ''),
    apiKey: (cfg.get<string>('memory.apiKey') || '').trim(),
    serviceId: (cfg.get<string>('memory.serviceId') || 'default').trim() || 'default',
    teamId: (cfg.get<string>('memory.teamId') || 'default').trim() || 'default',
    userId,
    agentIdMap,
    recallMaxResults: Math.max(1, cfg.get<number>('memory.recallMaxResults') ?? 5),
    includePersona: cfg.get<boolean>('memory.includePersona') !== false,
    includeSceneNav: cfg.get<boolean>('memory.includeSceneNav') !== false,
    includeSkills: cfg.get<boolean>('memory.includeSkills') !== false,
    skillCharBudget: Math.max(0, cfg.get<number>('memory.skillCharBudget') ?? 8000),
    captureEnabled: cfg.get<boolean>('memory.captureEnabled') !== false,
    timeoutMs: Math.max(1000, cfg.get<number>('memory.timeoutMs') ?? 15_000),
    debug: cfg.get<boolean>('memory.debug') === true,
  };
}

/** True when memory is enabled and required connection settings are present. */
export function isMemoryConfigured(settings: MemorySettings = readMemorySettings()): boolean {
  return (
    settings.enabled &&
    !!settings.endpoint &&
    !!settings.apiKey &&
    !!settings.serviceId &&
    !!settings.teamId &&
    !!settings.userId
  );
}

/** Settings keys that must resolve for memory to be usable. */
const REQUIRED_KEYS = ['memory.enabled', 'memory.endpoint', 'memory.apiKey'] as const;

/**
 * Per-key report of which settings scope supplied each memory value.
 *
 * On a remote (Remote-SSH / code-server) setup the **User** scope lives on the
 * client machine, so `acp.memory.*` written into the remote
 * `~/.vscode-server/data/User/settings.json` is invisible to the remote
 * extension host. Setting them in the remote (Machine) settings — i.e.
 * `~/.vscode-server/data/Machine/settings.json` — makes them resolve.
 * This report makes that class of misconfiguration obvious instead of
 * silently falling back to defaults.
 */
export function describeMemoryConfigSources(): string[] {
  const cfg = vscode.workspace.getConfiguration('acp');
  return REQUIRED_KEYS.map((key) => {
    const ins = cfg.inspect(key);
    const scopes: string[] = [];
    if (ins?.workspaceFolderValue !== undefined) {
      scopes.push('workspaceFolder');
    }
    if (ins?.workspaceValue !== undefined) {
      scopes.push('workspace');
    }
    if (ins?.globalValue !== undefined) {
      scopes.push('user/remote');
    }
    const source = scopes.length > 0 ? scopes.join('+') : 'default';
    const raw = cfg.get(key);
    const value = key === 'memory.apiKey' ? (raw ? '<set>' : '<empty>') : JSON.stringify(raw);
    return `acp.${key}=${value} (from ${source})`;
  });
}

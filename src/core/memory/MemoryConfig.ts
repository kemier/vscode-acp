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
  captureEnabled: boolean;
  timeoutMs: number;
}

const DEFAULT_ENDPOINT = 'http://127.0.0.1:8420';

export function readMemorySettings(): MemorySettings {
  const cfg = vscode.workspace.getConfiguration('acp.memory');
  const agentIdMapRaw = cfg.get<Record<string, string>>('agentIdMap') ?? {};
  const agentIdMap: Record<string, string> = {};
  for (const [k, v] of Object.entries(agentIdMapRaw)) {
    if (typeof k === 'string' && typeof v === 'string' && k.trim() && v.trim()) {
      agentIdMap[k.trim()] = v.trim();
    }
  }

  const userIdSetting = (cfg.get<string>('userId') ?? '').trim();
  const userId = userIdSetting || os.userInfo().username || process.env.USER || process.env.USERNAME || 'default';

  return {
    enabled: cfg.get<boolean>('enabled') === true,
    endpoint: (cfg.get<string>('endpoint') || DEFAULT_ENDPOINT).replace(/\/+$/, ''),
    apiKey: (cfg.get<string>('apiKey') || '').trim(),
    serviceId: (cfg.get<string>('serviceId') || 'default').trim() || 'default',
    teamId: (cfg.get<string>('teamId') || 'default').trim() || 'default',
    userId,
    agentIdMap,
    recallMaxResults: Math.max(1, cfg.get<number>('recallMaxResults') ?? 5),
    includePersona: cfg.get<boolean>('includePersona') !== false,
    includeSceneNav: cfg.get<boolean>('includeSceneNav') !== false,
    captureEnabled: cfg.get<boolean>('captureEnabled') !== false,
    timeoutMs: Math.max(1000, cfg.get<number>('timeoutMs') ?? 15_000),
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

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';
import { log, logError } from '../utils/Logger';

/**
 * Normalized representation of a Kiro session discovered on disk.
 * Mirrors the fields needed by the session tree and `session/load`.
 */
export interface KiroDiscoveredSession {
  /** Session ID issued by Kiro (UUID, optionally prefixed with `sess_`). */
  sessionId: string;
  /** Working directory the session was created in. */
  cwd: string;
  /** Session title (first user prompt or explicit title). */
  title: string;
  /** ISO timestamp of creation. */
  createdAt: string;
  /** ISO timestamp of last activity. */
  lastActiveAt: string;
  /** Where the session was discovered: CLI flat files or IDE nested dirs. */
  source: 'cli' | 'ide';
  /** Model ID used by the session, if available. */
  modelId?: string;
}

/** CLI session JSON shape (~/.kiro/sessions/cli/<uuid>.json). */
interface CliSessionJson {
  session_id: string;
  cwd: string;
  title?: string;
  created_at: string;
  updated_at: string;
  session_created_reason?: string;
}

/** IDE session JSON shape (~/.kiro/sessions/<hash>/sess_<uuid>/session.json). */
interface IdeSessionJson {
  id: string;
  title?: string;
  workspacePaths?: string[];
  createdAt: string;
  lastModifiedAt: string;
  status?: string;
  modelId?: string;
}

/**
 * Resolve the Kiro home directory.
 *
 * Priority:
 *   1. `KIRO_HOME` env var (documented override).
 *   2. `~/.kiro` (default on all platforms).
 */
function resolveKiroHome(): string | undefined {
  const envHome = process.env.KIRO_HOME;
  if (envHome && envHome.trim()) {
    return envHome.trim();
  }
  const home = os.homedir();
  if (!home) {
    return undefined;
  }
  return path.join(home, '.kiro');
}

/**
 * Safely read and parse a JSON file. Returns `undefined` on any error.
 */
function readJsonFile<T>(filePath: string): T | undefined {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/**
 * Scan the `~/.kiro/sessions/cli/` directory for CLI-spawned sessions.
 *
 * Each session has:
 *   <uuid>.json   — metadata (CliSessionJson)
 *   <uuid>.jsonl  — conversation log
 *   <uuid>.history — shell history
 *
 * We read only the `.json` files and extract the fields we need.
 */
function scanCliSessions(sessionsDir: string): KiroDiscoveredSession[] {
  const cliDir = path.join(sessionsDir, 'cli');
  let files: string[];
  try {
    files = fs.readdirSync(cliDir);
  } catch {
    return [];
  }

  const results: KiroDiscoveredSession[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) {
      continue;
    }
    const fullPath = path.join(cliDir, file);
    const data = readJsonFile<CliSessionJson>(fullPath);
    if (!data || !data.session_id) {
      continue;
    }
    results.push({
      sessionId: data.session_id,
      cwd: data.cwd || '',
      title: data.title || '',
      createdAt: data.created_at || '',
      lastActiveAt: data.updated_at || data.created_at || '',
      source: 'cli',
    });
  }
  return results;
}

/**
 * Scan the `~/.kiro/sessions/<hash>/sess_<uuid>/session.json` directory
 * structure for IDE-spawned sessions.
 *
 * The hash directory name is derived from the workspace path but we don't
 * need to reverse it — we just walk all subdirectories.
 */
function scanIdeSessions(sessionsDir: string): KiroDiscoveredSession[] {
  let hashDirs: string[];
  try {
    hashDirs = fs
      .readdirSync(sessionsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== 'cli')
      .map((d) => d.name);
  } catch {
    return [];
  }

  const results: KiroDiscoveredSession[] = [];
  for (const hashDir of hashDirs) {
    const hashPath = path.join(sessionsDir, hashDir);
    let sessDirs: string[];
    try {
      sessDirs = fs
        .readdirSync(hashPath, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const sessDir of sessDirs) {
      const sessionJsonPath = path.join(hashPath, sessDir, 'session.json');
      const data = readJsonFile<IdeSessionJson>(sessionJsonPath);
      if (!data || !data.id) {
        continue;
      }
      results.push({
        sessionId: data.id,
        cwd: data.workspacePaths?.[0] || '',
        title: data.title || '',
        createdAt: data.createdAt || '',
        lastActiveAt: data.lastModifiedAt || data.createdAt || '',
        source: 'ide',
        modelId: data.modelId,
      });
    }
  }
  return results;
}

/**
 * Discovers Kiro CLI sessions stored on disk in `~/.kiro/sessions/`.
 *
 * Kiro CLI does NOT implement the ACP `session/list` capability (its
 * `sessionCapabilities` is `{}`). However, it DOES advertise `loadSession:
 * true`, meaning the agent can load any session by ID via `session/load`.
 *
 * This module bridges the gap: by reading the on-disk session metadata that
 * Kiro writes to `~/.kiro/sessions/`, we can populate the session tree with
 * sessions spawned from the CLI — the same way codex-acp's built-in
 * `session/list` reads `~/.codex/sessions/` rollout files.
 *
 * Two on-disk formats are supported:
 *   - CLI:  `~/.kiro/sessions/cli/<uuid>.json`
 *   - IDE:  `~/.kiro/sessions/<hash>/sess_<uuid>/session.json`
 *
 * The discovery is read-only — we never write or delete session files. The
 * Kiro agent process manages its own files.
 */
export class KiroSessionDiscovery extends EventEmitter {
  private cached: KiroDiscoveredSession[] | null = null;
  private lastScanTime = 0;
  /** Cache TTL in ms — avoids re-scanning the filesystem on every tree refresh. */
  private readonly cacheTtlMs: number;
  private readonly kiroHome: string | undefined;

  constructor(cacheTtlMs = 10_000) {
    super();
    this.cacheTtlMs = cacheTtlMs;
    this.kiroHome = resolveKiroHome();
  }

  /** True if Kiro home directory exists and contains a `sessions/` subdirectory. */
  isAvailable(): boolean {
    if (!this.kiroHome) {
      return false;
    }
    const sessionsDir = path.join(this.kiroHome, 'sessions');
    return fs.existsSync(sessionsDir);
  }

  /**
   * Discover all Kiro sessions on disk. Results are cached for `cacheTtlMs`
   * to avoid hammering the filesystem on every tree render.
   *
   * @param opts.cwd If provided, filter sessions to this working directory.
   * @param opts.force Bypass the cache and re-scan immediately.
   */
  discover(opts: { cwd?: string; force?: boolean } = {}): KiroDiscoveredSession[] {
    if (!this.kiroHome) {
      return [];
    }
    const sessionsDir = path.join(this.kiroHome, 'sessions');

    const now = Date.now();
    if (!opts.force && this.cached && now - this.lastScanTime < this.cacheTtlMs) {
      return this.filterByCwd(this.cached, opts.cwd);
    }

    let sessions: KiroDiscoveredSession[] = [];
    try {
      sessions = [...scanCliSessions(sessionsDir), ...scanIdeSessions(sessionsDir)];
      // Sort by lastActiveAt descending (most recent first).
      sessions.sort((a, b) => (b.lastActiveAt || '').localeCompare(a.lastActiveAt || ''));
    } catch (e: any) {
      logError('KiroSessionDiscovery: scan failed', e);
    }

    this.cached = sessions;
    this.lastScanTime = now;
    log(
      `KiroSessionDiscovery: discovered ${sessions.length} sessions${opts.cwd ? ` (filtered by cwd: ${opts.cwd})` : ''}`,
    );
    return this.filterByCwd(sessions, opts.cwd);
  }

  private filterByCwd(sessions: KiroDiscoveredSession[], cwd?: string): KiroDiscoveredSession[] {
    if (!cwd) {
      return sessions;
    }
    return sessions.filter((s) => s.cwd === cwd);
  }

  /** Force a re-scan on the next `discover()` call and notify listeners. */
  refresh(): void {
    this.cached = null;
    this.lastScanTime = 0;
    this.emit('did-change');
  }

  /** Get the Kiro home directory path (for logging/debugging). */
  getKiroHome(): string | undefined {
    return this.kiroHome;
  }
}

import { spawn, ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { log, logError } from '../utils/Logger';
import { sendEvent, sendError } from '../utils/TelemetryManager';
import type { AgentConfigEntry } from '../config/AgentConfig';

/**
 * Escape a single argument for safe inclusion in a shell command string.
 * Wraps in single quotes, escaping any embedded single quotes.
 */
function shellEscape(arg: string): string {
  // Replace ' with '\'' (end quote, escaped quote, start quote)
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Determine the appropriate shell and whether it supports the -l (login) flag
 * on macOS/Linux. A login shell sources the user's profile (~/.zshrc,
 * ~/.bash_profile, etc.) so that PATH includes nvm, Homebrew, and other
 * user-installed tool directories.
 *
 * Shell support:
 *   zsh, bash, ksh  →  -l supported
 *   fish, sh, dash  →  use as-is without -l (fish auto-loads config;
 *                      sh/dash don't support -l reliably)
 *   csh, tcsh, etc. →  not POSIX-compatible; fall back to bash or /bin/sh
 */
function resolveUnixShell(): { shell: string; useLoginFlag: boolean } {
  const userShell = process.env.SHELL;

  if (userShell) {
    const base = userShell.split('/').pop() || '';

    // POSIX-compatible shells that support -l (login) flag
    if (['zsh', 'bash', 'ksh'].includes(base)) {
      return { shell: userShell, useLoginFlag: true };
    }

    // fish auto-loads config without -l; sh/dash are POSIX-compatible but
    // don't support -l reliably
    if (['fish', 'sh', 'dash'].includes(base)) {
      return { shell: userShell, useLoginFlag: false };
    }

    // Non-POSIX shells (csh, tcsh, etc.) — fall back to a known POSIX shell
    log(`User shell "${userShell}" is not POSIX-compatible, falling back to bash/sh`);
  }

  // $SHELL not set or not POSIX-compatible — probe for common shells
  if (existsSync('/bin/bash')) {
    return { shell: '/bin/bash', useLoginFlag: true };
  }
  if (existsSync('/usr/bin/bash')) {
    return { shell: '/usr/bin/bash', useLoginFlag: true };
  }
  // Ultimate fallback
  return { shell: '/bin/sh', useLoginFlag: false };
}

export interface AgentInstance {
  id: string;
  name: string;
  process: ChildProcess;
  config: AgentConfigEntry;
}

/**
 * Manages spawning and killing ACP agent child processes.
 */
export interface AgentManagerEvents {
  'agent-stderr': [evt: { agentId: string; line: string }];
  'agent-error': [evt: { agentId: string; error: any }];
  'agent-closed': [evt: { agentId: string; code: number | null; signal: string | null }];
}

export class AgentManager extends EventEmitter {
  on<K extends keyof AgentManagerEvents>(event: K, listener: (...args: AgentManagerEvents[K]) => void): this {
    return super.on(event, listener as any);
  }
  emit<K extends keyof AgentManagerEvents>(event: K, ...args: AgentManagerEvents[K]): boolean {
    return super.emit(event, ...args);
  }

  private agents: Map<string, AgentInstance> = new Map();
  private nextId = 1;
  private agentEnvProvider: ((agentName: string) => Record<string, string>) | null = null;

  /**
   * Supply extra spawn-time environment variables, resolved per agent name.
   *
   * Used to hand the agent the memory skill bridge URL and its memory agent id so it
   * can read memory-only skills through a normal tool call. The bridge port is chosen
   * at runtime, so this cannot live in static `acp.agents` config. Values are applied
   * BELOW `config.env`, so user configuration always wins.
   */
  setAgentEnvProvider(provider: ((agentName: string) => Record<string, string>) | null): void {
    this.agentEnvProvider = provider;
  }

  private resolveSpawnEnv(name: string, config: AgentConfigEntry): NodeJS.ProcessEnv {
    let extra: Record<string, string> = {};
    try {
      extra = this.agentEnvProvider?.(name) || {};
    } catch (err) {
      // A failing provider must never block spawning an agent.
      log(`Agent env provider failed for "${name}": ${err}`);
    }
    return { ...process.env, ...extra, ...(config.env || {}) };
  }

  /**
   * Spawn an agent as a child process with stdin/stdout piped.
   */
  spawnAgent(name: string, config: AgentConfigEntry, cwd?: string): AgentInstance {
    const id = `agent_${this.nextId++}`;
    const spawnEnv = this.resolveSpawnEnv(name, config);
    log(`Spawning agent "${name}" (${id}): ${config.command} ${(config.args || []).join(' ')}`);

    const child = (() => {
      if (process.platform === 'win32') {
        // On Windows, commands like npx are batch scripts (.cmd) that require
        // shell resolution via cmd.exe.
        return spawn(config.command, config.args || [], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: spawnEnv,
          cwd: cwd || undefined,
          shell: true,
        });
      }

      // On macOS/Linux, use the user's login shell so that PATH includes
      // nvm, Homebrew, and other user-installed tool directories.
      const { shell, useLoginFlag } = resolveUnixShell();
      const commandStr = [config.command, ...(config.args || [])].map(shellEscape).join(' ');
      const shellArgs = useLoginFlag ? ['-l', '-c', commandStr] : ['-c', commandStr];

      log(`Using shell: ${shell} ${shellArgs.join(' ')}`);
      const shellName = shell.split('/').pop() || shell;
      sendEvent('agent/spawn/shell', { shell: shellName, useLoginFlag: String(useLoginFlag) });
      return spawn(shell, shellArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: spawnEnv,
        cwd: cwd || undefined,
        // Put the child in its own process group (POSIX setsid) so we can
        // kill the entire tree (shell + npx + node + codex-acp) with a
        // single signal to the process group (-pid). Without this, killing
        // the shell leaves grandchild processes orphaned and reparented to
        // PID 1.
        detached: true,
      });
    })();

    const instance: AgentInstance = { id, name, process: child, config };
    this.agents.set(id, instance);

    // Forward stderr for debugging
    child.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) {
        log(`[${name} stderr] ${line}`);
        this.emit('agent-stderr', { agentId: id, line });
      }
    });

    child.on('error', (err) => {
      logError(`Agent "${name}" process error`, err);
      sendError('agent/error', { agentName: name, errorType: err.message });
      this.emit('agent-error', { agentId: id, error: err });
    });

    child.on('close', (code, signal) => {
      log(`Agent "${name}" exited (code=${code}, signal=${signal})`);
      this.agents.delete(id);
      this.emit('agent-closed', { agentId: id, code, signal });
    });

    return instance;
  }

  /**
   * Kill an agent process.
   */
  killAgent(agentId: string): boolean {
    const instance = this.agents.get(agentId);
    if (!instance) {
      return false;
    }

    log(`Killing agent "${instance.name}" (${agentId})`);

    try {
      // Kill the entire process group. On Unix, when the child was spawned
      // with detached:true, the child became its own process group leader.
      // Sending a signal to -pid targets the whole group, which includes
      // the shell and all its descendants (npx → node → codex-acp).
      try {
        process.kill(-instance.process.pid!, 'SIGTERM');
      } catch {
        // Fallback: if process-group kill fails (e.g. process already gone,
        // or on Windows), fall back to killing just the direct child.
        instance.process.kill('SIGTERM');
      }

      // Force-kill after 5s if still running
      setTimeout(() => {
        try {
          if (instance.process.exitCode === null) {
            process.kill(-instance.process.pid!, 'SIGKILL');
          }
        } catch {
          // Process or group already gone — nothing to do.
        }
      }, 5000);
    } catch (e) {
      logError(`Failed to kill agent ${agentId}`, e);
    }

    this.agents.delete(agentId);
    return true;
  }

  /**
   * Get a running agent by ID.
   */
  getAgent(agentId: string): AgentInstance | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Get all running agents.
   */
  getRunningAgents(): AgentInstance[] {
    return Array.from(this.agents.values());
  }

  /**
   * Kill all running agents. Called on extension deactivate.
   */
  killAll(): void {
    for (const [id] of this.agents) {
      this.killAgent(id);
    }
  }

  /**
   * Immediately SIGKILL all agent process groups. Used during extension
   * deactivation where the Node event loop may be torn down before the
   * 5-second SIGKILL timeout in killAgent() fires.
   */
  forceKillAll(): void {
    for (const [, instance] of this.agents) {
      try {
        process.kill(-instance.process.pid!, 'SIGKILL');
      } catch {
        try {
          instance.process.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
    this.agents.clear();
  }

  dispose(): void {
    this.killAll();
    this.forceKillAll();
    this.removeAllListeners();
  }
}

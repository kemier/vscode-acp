import * as vscode from 'vscode';
import { log, logError } from '../utils/Logger';

import type {
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
} from '@agentclientprotocol/sdk';

import { spawn, ChildProcess } from 'node:child_process';

interface OutputBuffer {
  output: string;
  truncated: boolean;
}

interface ManagedTerminal {
  id: string;
  process: ChildProcess;
  buf: OutputBuffer;
  outputByteLimit: number;
  exitCode: number | null;
  exitSignal: string | null;
  exited: boolean;
  exitPromise: Promise<void>;
  vsTerminal?: vscode.Terminal;
}

/**
 * Manages terminals that ACP agents request (terminal/create, terminal/output,
 * terminal/wait_for_exit, terminal/kill, terminal/release — the full v1 terminal
 * capability surface). Uses real child processes for capturing output, with
 * VS Code terminals for display.
 */
export class TerminalHandler {
  private terminals: Map<string, ManagedTerminal> = new Map();
  private nextId = 1;

  async createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    const terminalId = `term_${this.nextId++}`;
    const outputByteLimit = params.outputByteLimit ?? 1024 * 1024; // 1MB default

    log(`createTerminal: ${params.command} ${(params.args || []).join(' ')} (id=${terminalId})`);

    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    if (params.env) {
      for (const v of params.env) {
        env[v.name] = v.value;
      }
    }

    const child = spawn(params.command, params.args || [], {
      cwd: params.cwd || undefined,
      env,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Shared output buffer: appends mutate it in place, so terminalOutput
    // always sees the latest bytes without a sync timer.
    const buf: OutputBuffer = { output: '', truncated: false };

    const appendOutput = (data: Buffer) => {
      buf.output += data.toString();
      // Truncate from beginning if over limit
      const byteLength = Buffer.byteLength(buf.output, 'utf-8');
      if (byteLength > outputByteLimit) {
        const excess = byteLength - outputByteLimit;
        // Find a safe character boundary to truncate at
        let cutPoint = 0;
        let bytes = 0;
        for (let i = 0; i < buf.output.length; i++) {
          bytes += Buffer.byteLength(buf.output[i], 'utf-8');
          if (bytes >= excess) {
            cutPoint = i + 1;
            break;
          }
        }
        buf.output = buf.output.substring(cutPoint);
        buf.truncated = true;
      }
    };

    // Also create a VS Code terminal for visual output
    const writeEmitter = new vscode.EventEmitter<string>();
    const pty: vscode.Pseudoterminal = {
      onDidWrite: writeEmitter.event,
      open() {
        writeEmitter.fire(`$ ${params.command} ${(params.args || []).join(' ')}\r\n`);
      },
      close() {
        /* no-op */
      },
    };
    const vsTerminal = vscode.window.createTerminal({
      name: `ACP: ${params.command}`,
      pty,
    });

    // Capture and mirror output in one pass per stream
    const onData = (data: Buffer) => {
      appendOutput(data);
      writeEmitter.fire(data.toString().replace(/\n/g, '\r\n'));
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    const managed: ManagedTerminal = {
      id: terminalId,
      process: child,
      buf,
      outputByteLimit,
      exitCode: null,
      exitSignal: null,
      exited: false,
      exitPromise: undefined as unknown as Promise<void>, // assigned below
      vsTerminal,
    };

    const exitPromise = new Promise<void>((resolve) => {
      child.on('close', (code, signal) => {
        managed.exitCode = code;
        managed.exitSignal = signal;
        managed.exited = true;
        // Show the exit status in the VS Code terminal so the user sees how
        // the command ended, per the live-output display contract.
        const status = signal !== null ? `signal ${signal}` : `exit ${code ?? 'unknown'}`;
        writeEmitter.fire(`\r\n[${status}]\r\n`);
        resolve();
      });
      child.on('error', (e) => {
        // Spawn failed (e.g. ENOENT): the process never ran. Synthesize a
        // failed exit so waitForTerminalExit/terminalOutput report a valid
        // status instead of an all-null one.
        logError(`Terminal ${terminalId} spawn failed`, e);
        managed.exited = true;
        managed.exitCode = 1;
        writeEmitter.fire('\r\n[spawn failed]\r\n');
        resolve();
      });
    });
    managed.exitPromise = exitPromise;

    this.terminals.set(terminalId, managed);

    return { terminalId };
  }

  async terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
    const managed = this.terminals.get(params.terminalId);
    if (!managed) {
      throw new Error(`Terminal not found: ${params.terminalId}`);
    }

    const response: TerminalOutputResponse = {
      output: managed.buf.output,
      truncated: managed.buf.truncated,
    };

    if (managed.exited) {
      response.exitStatus = {
        exitCode: managed.exitCode,
        signal: managed.exitSignal,
      };
    }

    return response;
  }

  async waitForTerminalExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
    const managed = this.terminals.get(params.terminalId);
    if (!managed) {
      throw new Error(`Terminal not found: ${params.terminalId}`);
    }

    await managed.exitPromise;

    return {
      exitCode: managed.exitCode,
      signal: managed.exitSignal,
    };
  }

  async killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse> {
    const managed = this.terminals.get(params.terminalId);
    if (!managed) {
      throw new Error(`Terminal not found: ${params.terminalId}`);
    }

    try {
      managed.process.kill('SIGTERM');
    } catch (e) {
      logError(`Failed to kill terminal ${params.terminalId}`, e);
    }

    return {};
  }

  async releaseTerminal(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
    const managed = this.terminals.get(params.terminalId);
    if (!managed) {
      throw new Error(`Terminal not found: ${params.terminalId}`);
    }

    log(`releaseTerminal: ${params.terminalId}`);

    // Kill if still running
    if (!managed.exited) {
      try {
        managed.process.kill('SIGTERM');
      } catch {
        // ignore
      }
    }

    // Don't dispose VS Code terminal — keep output visible per ACP spec
    this.terminals.delete(params.terminalId);

    return {};
  }

  dispose(): void {
    for (const [, managed] of this.terminals) {
      try {
        if (!managed.exited) {
          managed.process.kill('SIGKILL');
        }
        managed.vsTerminal?.dispose();
      } catch {
        // ignore
      }
    }
    this.terminals.clear();
  }
}

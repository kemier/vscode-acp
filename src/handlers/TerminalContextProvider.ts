import * as vscode from 'vscode';
import { log } from '../utils/Logger';

/**
 * Captures terminal output from shell integration for @terminal context injection.
 */
export class TerminalContextProvider {
  private lastOutput = '';
  private lastTerminalName = '';
  private disposables: vscode.Disposable[] = [];
  private activeOutputs = new Map<vscode.TerminalShellExecution, string>();

  constructor() {
    log('[TerminalContext] Provider initialized');

    this.disposables.push(
      vscode.window.onDidStartTerminalShellExecution(async (e) => {
        log(`[TerminalContext] Execution started in terminal: ${e.terminal.name}`);
        try {
          let output = '';
          const stream = e.execution.read();
          for await (const chunk of stream) {
            output += chunk;
            // Update progressively so @terminal works even while the
            // command is still running.
            this.activeOutputs.set(e.execution, output);
          }
          log(`[TerminalContext] Captured ${output.length} chars from: ${e.terminal.name}`);
          this.activeOutputs.set(e.execution, output);
        } catch (err) {
          log(`[TerminalContext] Read failed: ${err}`);
        }
      }),
      vscode.window.onDidEndTerminalShellExecution((e) => {
        log(`[TerminalContext] Execution ended in terminal: ${e.terminal.name}`);
        const output = this.activeOutputs.get(e.execution);
        this.activeOutputs.delete(e.execution);
        if (output && output.trim()) {
          this.lastOutput = output;
          this.lastTerminalName = e.terminal.name;
          log(`[TerminalContext] Stored ${output.length} chars from: ${e.terminal.name}`);
        } else {
          log(`[TerminalContext] No output captured for this execution`);
        }
      }),
    );
  }

  /** Get the most recent terminal output, or empty string if none. */
  getLastOutput(): { text: string; name: string } {
    // If a command is still running, return its output so far.
    for (const [_exec, output] of this.activeOutputs) {
      if (output && output.trim()) {
        log(`[TerminalContext] getLastOutput: returning ${output.length} chars from active execution`);
        return { text: output, name: '' };
      }
    }
    log(`[TerminalContext] getLastOutput called: ${this.lastOutput.length} chars from "${this.lastTerminalName}"`);
    return { text: this.lastOutput, name: this.lastTerminalName };
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

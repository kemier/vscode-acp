import * as vscode from 'vscode';
import { log } from '../utils/Logger';

/**
 * Captures terminal output for @terminal context injection.
 *
 * Primary path: VS Code shell integration
 * (`onDidStart/EndTerminalShellExecution`). This is the reliable, bounded
 * capture — but it requires shell integration to be active, which fails when
 * VS Code cannot create its zsh ZDOTDIR under /tmp (`$USER-code-zsh`).
 *
 * Fallback path: `onDidWriteTerminalData` (deprecated) was removed — it is
 * gated inconsistently across VS Code builds via proposed-API rules.
 */
export class TerminalContextProvider {
  private lastOutput = '';
  private lastTerminalName = '';
  /** True once any shell-integration execution event has fired. */
  private seenExecution = false;

  private disposables: vscode.Disposable[] = [];
  private activeOutputs = new Map<vscode.TerminalShellExecution, string>();

  constructor() {
    log('[TerminalContext] Provider initialized');

    this.disposables.push(
      vscode.window.onDidStartTerminalShellExecution(async (e) => {
        this.seenExecution = true;
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
        this.seenExecution = true;
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
    if (this.lastOutput) {
      log(`[TerminalContext] getLastOutput: returning ${this.lastOutput.length} chars from "${this.lastTerminalName}"`);
      return { text: this.lastOutput, name: this.lastTerminalName };
    }
    log(
      `[TerminalContext] getLastOutput: no output available ` +
        `(seenExecution=${this.seenExecution}, shellIntegration=${this.isCaptureAvailable})`,
    );
    return { text: '', name: '' };
  }

  /**
   * Human-readable hint when {@link getLastOutput} is empty.
   * Distinguishes "never tracked a command" from "buffer empty".
   */
  getEmptyCaptureHint(): string {
    if (this.seenExecution) {
      return 'The last tracked command produced no output. Run a command that prints something, then retry @terminal.';
    }
    if (this.isCaptureAvailable) {
      return (
        'Shell integration is present but has not tracked any command yet. ' +
        'Kill the terminal, open a new one, run a command, then retry @terminal.'
      );
    }
    return (
      'VS Code shell integration is not active in this terminal (zsh ZDOTDIR inject often fails). ' +
      'Kill the terminal, open a new one, run a command, then retry. ' +
      'Verify with: echo $VSCODE_SHELL_INTEGRATION  (should print 1). ' +
      'If it stays empty, add to ~/.zshrc: ' +
      '[[ "$TERM_PROGRAM" == "vscode" ]] && . "$(code --locate-shell-integration-path zsh)"'
    );
  }

  /** True if shell integration capture is available on the active terminal. */
  get isCaptureAvailable(): boolean {
    return vscode.window.activeTerminal?.shellIntegration !== undefined;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

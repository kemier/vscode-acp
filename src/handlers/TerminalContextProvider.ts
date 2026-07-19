import * as vscode from 'vscode';
import { log } from '../utils/Logger';

/**
 * Captures terminal output for @terminal context injection.
 *
 * Primary path: VS Code shell integration
 * (`onDidStart/EndTerminalShellExecution`). This is the reliable, bounded
 * capture — but it requires shell integration to be active, which is not the
 * case for all vscode-server / SSH / shell setups.
 *
 * Fallback path: `onDidWriteTerminalData` (deprecated but still present at
 * runtime in many builds). It fires for any terminal output regardless of
 * shell integration, giving best-effort capture with no command boundaries.
 *
 * When neither path produces output, {@link getLastOutput} returns empty and
 * the caller should warn the user.
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

    // NOTE: The deprecated onDidWriteTerminalData (terminalDataWriteEvent
    // proposed API) previously lived here as a fallback. It has been removed
    // because it is gated inconsistently across VS Code builds: some builds
    // require it to be declared in enabledApiProposals, some have stabilized
    // it, and some have removed it entirely. Declaring it breaks activation on
    // builds where it is stabilized, and referencing it (even via runtime
    // string lookup) trips the static proposed-API scanner on other builds.
    // See https://github.com/microsoft/vscode/issues/78502 and the VS Code
    // proposed-API guidance. The stable shell-integration path above
    // (onDidStartTerminalShellExecution) handles terminal capture for all
    // modern builds, which is the reliable and published-extension-safe approach.
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
    log('[TerminalContext] getLastOutput: no output available (shell integration inactive)');
    return { text: '', name: '' };
  }

  /** True if shell integration capture is available. */
  get isCaptureAvailable(): boolean {
    return vscode.window.activeTerminal?.shellIntegration !== undefined;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

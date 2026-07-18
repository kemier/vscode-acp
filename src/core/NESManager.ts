import * as vscode from 'vscode';
import type { ClientSideConnection } from '@agentclientprotocol/sdk';

import { log, logError } from '../utils/Logger';

/** ACP NES edit suggestion as returned by nes/suggest. */
export interface NESSuggestion {
  id: string;
  kind: 'edit';
  uri: string;
  edits: {
    range: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
    newText: string;
  }[];
  cursorPosition?: { line: number; character: number };
}

/** Debounce delay before sending nes/suggest (ms). */
const SUGGEST_DEBOUNCE_MS = 300;

/**
 * Manages the NES (Next Edit Suggestion) lifecycle for an ACP agent connection.
 *
 * Uses the SDK's unstable_* methods (unstable_startNes, unstable_suggestNes,
 * unstable_closeNes, unstable_acceptNes, unstable_rejectNes) and document
 * sync notifications (unstable_didOpenDocument, etc.).
 *
 * Note: codex-acp does NOT currently support NES. If the agent doesn't
 * advertise the nes capability, start() will log a warning and return.
 */
export class NESManager {
  private nesSessionId: string | null = null;
  private connection: ClientSideConnection | null = null;
  private disposables: vscode.Disposable[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private warned = false;

  /**
   * Start NES for a connection.
   * Called after successful agent connection + auth.
   * Returns false if the agent does not support NES.
   */
  async start(connection: ClientSideConnection): Promise<boolean> {
    this.connection = connection;

    const startNes = (connection as any).unstable_startNes;
    if (typeof startNes !== 'function') {
      if (!this.warned) {
        log('NESManager: agent does not support NES (unstable_startNes not available) — skipping');
        this.warned = true;
      }
      return false;
    }

    try {
      const result = await startNes.call(connection, {
        workspaceUri: vscode.workspace.workspaceFolders?.[0]?.uri.toString(),
        workspaceFolders: vscode.workspace.workspaceFolders?.map((f) => ({
          uri: f.uri.toString(),
          name: f.name,
        })),
      });
      this.nesSessionId = result?.sessionId as string;
      log(`NESManager: started NES session ${this.nesSessionId}`);
    } catch (e) {
      const msg = String((e as any)?.message || e);
      if (/method not found|not found/i.test(msg)) {
        // Agent doesn't support NES — this is expected for codex-acp.
        if (!this.warned) {
          log(`NESManager: agent does not support NES (method not found) — skipping`);
          this.warned = true;
        }
      } else {
        logError('NESManager: failed to start NES session', e);
      }
      return false;
    }

    this.registerDocumentListeners();
    this.syncOpenDocuments();
    return true;
  }

  /**
   * Request a suggestion for the current cursor position.
   */
  async suggest(
    document: vscode.TextDocument,
    position: vscode.Position,
    triggerKind: 'automatic' | 'manual',
    token: vscode.CancellationToken,
  ): Promise<NESSuggestion[] | null> {
    if (!this.connection || !this.nesSessionId) {
      return null;
    }

    await this.debounce(token);
    if (token.isCancellationRequested) {
      return null;
    }

    const suggestNes = (this.connection as any).unstable_suggestNes;
    if (typeof suggestNes !== 'function') {
      return null;
    }

    try {
      const result = await suggestNes.call(this.connection, {
        sessionId: this.nesSessionId,
        uri: document.uri.toString(),
        version: document.version,
        position: { line: position.line, character: position.character },
        triggerKind,
      });
      return (result?.suggestions as NESSuggestion[]) ?? null;
    } catch (e) {
      logError('NESManager: nes/suggest failed', e);
      return null;
    }
  }

  /** Notify agent that user accepted a suggestion. */
  accept(id: string): void {
    if (!this.connection) {
      return;
    }
    const acceptNes = (this.connection as any).unstable_acceptNes;
    if (typeof acceptNes === 'function') {
      log(`NESManager: accept ${id}`);
      void acceptNes.call(this.connection, { sessionId: this.nesSessionId, id });
    }
  }

  /** Notify agent that user rejected/ignored a suggestion. */
  reject(id: string, reason: 'rejected' | 'ignored' | 'replaced'): void {
    if (!this.connection) {
      return;
    }
    const rejectNes = (this.connection as any).unstable_rejectNes;
    if (typeof rejectNes === 'function') {
      log(`NESManager: reject ${id} (${reason})`);
      void rejectNes.call(this.connection, { sessionId: this.nesSessionId, id, reason });
    }
  }

  /** Whether NES is currently active. */
  get isActive(): boolean {
    return this.nesSessionId !== null;
  }

  /** Stop NES and clean up listeners. */
  stop(): void {
    if (this.nesSessionId && this.connection) {
      const closeNes = (this.connection as any).unstable_closeNes;
      if (typeof closeNes === 'function') {
        void closeNes.call(this.connection, { sessionId: this.nesSessionId }).catch(() => {});
      }
    }
    log('NESManager: stopping');
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    this.nesSessionId = null;
    this.connection = null;
  }

  dispose(): void {
    this.stop();
  }

  // --- Private ---

  private debounce(token: vscode.CancellationToken): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }
      this.debounceTimer = setTimeout(resolve, SUGGEST_DEBOUNCE_MS);
      token.onCancellationRequested(() => {
        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
          this.debounceTimer = null;
        }
        resolve();
      });
    });
  }

  private sendDocNotification(method: string, params: Record<string, unknown>): void {
    if (!this.connection) {
      return;
    }
    const fn = (this.connection as any)[method];
    if (typeof fn === 'function') {
      void fn.call(this.connection, params).catch((e: any) => {
        logError(`NESManager: ${method} failed`, e);
      });
    }
  }

  private registerDocumentListeners(): void {
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => {
        if (doc.uri.scheme !== 'file') {
          return;
        }
        this.sendDocNotification('unstable_didOpenDocument', {
          uri: doc.uri.toString(),
          languageId: doc.languageId,
          version: doc.version,
          text: doc.getText(),
        });
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.uri.scheme !== 'file' || event.contentChanges.length === 0) {
          return;
        }
        this.sendDocNotification('unstable_didChangeDocument', {
          sessionId: this.nesSessionId,
          uri: event.document.uri.toString(),
          version: event.document.version,
          contentChanges: event.contentChanges.map((c) => ({
            range: {
              start: { line: c.range.start.line, character: c.range.start.character },
              end: { line: c.range.end.line, character: c.range.end.character },
            },
            text: c.text,
          })),
        });
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        if (doc.uri.scheme !== 'file') {
          return;
        }
        this.sendDocNotification('unstable_didCloseDocument', {
          sessionId: this.nesSessionId,
          uri: doc.uri.toString(),
        });
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (doc.uri.scheme !== 'file') {
          return;
        }
        this.sendDocNotification('unstable_didSaveDocument', {
          sessionId: this.nesSessionId,
          uri: doc.uri.toString(),
        });
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (!editor || editor.document.uri.scheme !== 'file') {
          return;
        }
        this.sendDocNotification('unstable_didFocusDocument', {
          sessionId: this.nesSessionId,
          uri: editor.document.uri.toString(),
          version: editor.document.version,
          position: {
            line: editor.selection.active.line,
            character: editor.selection.active.character,
          },
          visibleRange: {
            start: { line: editor.visibleRanges[0]?.start.line ?? 0, character: 0 },
            end: { line: editor.visibleRanges[0]?.end.line ?? 0, character: 0 },
          },
        });
      }),
    );
  }

  private syncOpenDocuments(): void {
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme === 'file') {
        this.sendDocNotification('unstable_didOpenDocument', {
          uri: doc.uri.toString(),
          languageId: doc.languageId,
          version: doc.version,
          text: doc.getText(),
        });
      }
    }
    const active = vscode.window.activeTextEditor;
    if (active && active.document.uri.scheme === 'file') {
      this.sendDocNotification('unstable_didFocusDocument', {
        sessionId: this.nesSessionId,
        uri: active.document.uri.toString(),
        version: active.document.version,
        position: {
          line: active.selection.active.line,
          character: active.selection.active.character,
        },
        visibleRange: {
          start: { line: active.visibleRanges[0]?.start.line ?? 0, character: 0 },
          end: { line: active.visibleRanges[0]?.end.line ?? 0, character: 0 },
        },
      });
    }
  }
}

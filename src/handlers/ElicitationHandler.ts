import * as vscode from 'vscode';
import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  CompleteElicitationNotification,
} from '@agentclientprotocol/sdk';
import { log } from '../utils/Logger';

/**
 * Handles ACP elicitation requests from agents.
 *
 * Two modes:
 * - "form": Shows a QuickPick/InputBox flow based on the JSON schema.
 *   The user fills in the fields and accepts/declines/cancels.
 * - "url": Opens the URL in an external browser. The agent later calls
 *   unstable_completeElicitation to signal completion.
 *
 * Note: codex-acp currently uses requestPermission for MCP elicitation
 * rather than unstable_createElicitation. These handlers are for agents
 * that do use the elicitation protocol (e.g. Zed's agent).
 */
export class ElicitationHandler {
  /** Pending URL elicitations, keyed by elicitationId. */
  private pendingUrl: Map<string, vscode.Disposable | undefined> = new Map();

  /**
   * Ask in the chat panel instead of a QuickPick, when one is available.
   *
   * Injected rather than imported so this handler keeps no dependency on the
   * webview: it must still work (via QuickPick) before the panel exists, and in
   * tests. Returns null when the panel cannot ask, which selects the fallback.
   */
  private askInChat:
    | ((params: {
        title?: string;
        questions: Array<{
          id: string;
          prompt: string;
          options: Array<{ id: string; label: string }>;
          allowMultiple?: boolean;
        }>;
      }) => Promise<
        | { outcome: 'answered'; answers: Array<{ questionId: string; selectedOptionIds: string[] }> }
        | { outcome: 'cancelled' }
        | null
      >)
    | null = null;

  setAskInChat(fn: NonNullable<ElicitationHandler['askInChat']>): void {
    this.askInChat = fn;
  }

  async createElicitation(params: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    if (params.mode === 'url') {
      return this.handleUrlElicitation(params as Extract<CreateElicitationRequest, { mode: 'url' }>);
    }
    return this.handleFormElicitation(params as Extract<CreateElicitationRequest, { mode: 'form' }>);
  }

  async completeElicitation(params: CompleteElicitationNotification): Promise<void> {
    const disposable = this.pendingUrl.get(params.elicitationId);
    if (disposable) {
      disposable.dispose();
    }
    this.pendingUrl.delete(params.elicitationId);
    log(`ElicitationHandler: completeElicitation for ${params.elicitationId}`);
  }

  // --- Private ---

  private async handleUrlElicitation(
    params: Extract<CreateElicitationRequest, { mode: 'url' }>,
  ): Promise<CreateElicitationResponse> {
    log(`ElicitationHandler: opening URL ${params.url}`);
    await vscode.env.openExternal(vscode.Uri.parse(params.url));
    return { action: 'accept' as const, content: null };
  }

  private async handleFormElicitation(
    params: Extract<CreateElicitationRequest, { mode: 'form' }>,
  ): Promise<CreateElicitationResponse> {
    const schema = params.requestedSchema;
    const properties = schema?.properties ?? {};
    const required = (schema as any)?.required ?? [];
    const content: Record<string, string | number | boolean | string[]> = {};

    if (params.message) {
      const infoItem = await vscode.window.showInformationMessage(params.message, { modal: true }, 'Continue');
      if (infoItem !== 'Continue') {
        return { action: 'cancel' as const };
      }
    }

    for (const [key, propSchema] of Object.entries(properties)) {
      const p = propSchema as any;
      const isRequired = required.includes(key);
      const title = p?.title || key;
      const description = p?.description ? ` — ${p.description}` : '';
      const placeholder = p?.placeholder || `Enter ${title}`;

      // Enum → a choice. Rendered in the chat when possible (see askInChat), so
      // codex-acp's elicitations read like the conversation they belong to instead
      // of a QuickPick over the editor; QuickPick remains the fallback.
      if (Array.isArray(p?.enum) && p.enum.length > 0) {
        const inChat = this.askInChat
          ? await this.askInChat({
              title: `${title}${description}`,
              questions: [
                {
                  id: key,
                  prompt: placeholder,
                  options: p.enum.map((v: string) => ({ id: String(v), label: String(v) })),
                  allowMultiple: false,
                },
              ],
            })
          : null;
        if (inChat) {
          if (inChat.outcome !== 'answered') {
            return { action: 'cancel' as const };
          }
          const chosen = inChat.answers?.[0]?.selectedOptionIds?.[0];
          if (chosen === undefined) {
            return { action: 'cancel' as const };
          }
          content[key] = chosen;
          continue;
        }
        const items = p.enum.map((v: string) => ({ label: String(v), value: v }));
        const picked = await vscode.window.showQuickPick(items, {
          title: `${title}${description}`,
          placeHolder: placeholder,
          canPickMany: false,
        });
        if (!picked) {
          return { action: 'cancel' as const };
        }
        content[key] = (picked as any).value;
        continue;
      }

      // Boolean → QuickPick yes/no
      if (p?.type === 'boolean') {
        const picked = await vscode.window.showQuickPick(
          [
            { label: 'Yes', value: true },
            { label: 'No', value: false },
          ],
          { title: `${title}${description}`, placeHolder: placeholder },
        );
        if (!picked) {
          return { action: 'cancel' as const };
        }
        content[key] = (picked as any).value;
        continue;
      }

      // Number → InputBox with validation
      if (p?.type === 'number' || p?.type === 'integer') {
        const value = await vscode.window.showInputBox({
          prompt: `${title}${description}`,
          placeHolder: placeholder,
          validateInput: (v) => {
            if (!v && isRequired) {
              return `${title} is required`;
            }
            if (v && isNaN(Number(v))) {
              return 'Must be a number';
            }
            return null;
          },
        });
        if (value === undefined) {
          return { action: 'cancel' as const };
        }
        content[key] = Number(value);
        continue;
      }

      // Default: string InputBox
      const value = await vscode.window.showInputBox({
        prompt: `${title}${description}`,
        placeHolder: placeholder,
        validateInput: (v) => {
          if (!v && isRequired) {
            return `${title} is required`;
          }
          return null;
        },
      });
      if (value === undefined) {
        return { action: 'cancel' as const };
      }
      content[key] = value;
    }

    const submit = await vscode.window.showInformationMessage('Submit the form?', { modal: true }, 'Submit', 'Decline');
    if (submit === 'Decline') {
      return { action: 'decline' as const };
    }
    if (submit !== 'Submit') {
      return { action: 'cancel' as const };
    }
    return { action: 'accept' as const, content };
  }

  dispose(): void {
    for (const d of this.pendingUrl.values()) {
      d?.dispose();
    }
    this.pendingUrl.clear();
  }
}

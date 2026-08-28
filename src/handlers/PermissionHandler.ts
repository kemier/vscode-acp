import * as vscode from 'vscode';
import { log } from '../utils/Logger';
import { sendEvent } from '../utils/TelemetryManager';
import {
  extractCommandFromToolCall,
  extractPermissionToolFingerprint,
  isApprovedToolFingerprint,
  normalizeApprovedToolFingerprint,
} from './permissionUtils';
import { mergePermissionLists, readPermissionStore, writePermissionStore } from './PermissionStore';

import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';

/**
 * Handles ACP permission requests from agents.
 * Shows diff preview for edit operations, then QuickPick for approval.
 *
 * Permission strategy:
 * - "ask": prompt for every command (default)
 * - "allowAll": auto-approve every command (dangerous)
 * - "remember": auto-approve commands matching the allowlist (persisted
 *   across sessions). Uses longest-prefix-match: approving "gh" auto-approves
 *   "gh issue view 3715", "gh pr list", etc. A denylist takes precedence
 *   when its prefix is equally or more specific.
 *   Non-command tools (e.g. Kiro "Spawning agent crew") are remembered by a
 *   stable tool fingerprint when the user picks allow_always / Allow.
 */

type CommandDecision = 'auto_approve' | 'auto_deny' | 'ask_user';

/** Detect dangerous parameter substitutions that could execute commands. */
function containsDangerousSubstitution(source: string): boolean {
  // ${var@P} - prompt string expansion (interprets escape sequences)
  if (/\$\{[^}]*@[PQEAa][^}]*\}/.test(source)) {
    return true;
  }
  // ${var=value} with escape sequences (octal/hex/unicode → backtick injection)
  if (/\$\{[^}]*[=+\-?][^}]*\\[0-7]{3}[^}]*\}/.test(source)) {
    return true;
  }
  if (/\$\{[^}]*[=+\-?][^}]*\\x[0-9a-fA-F]{2}[^}]*\}/.test(source)) {
    return true;
  }
  if (/\$\{[^}]*[=+\-?][^}]*\\u[0-9a-fA-F]{4}[^}]*\}/.test(source)) {
    return true;
  }
  // ${!var} - indirect variable references
  if (/\$\{![^}]+\}/.test(source)) {
    return true;
  }
  // <<<$(...) or <<<`...` - here-strings with command substitution
  if (/<<<\s*(\$\(|`)/.test(source)) {
    return true;
  }
  // zsh process substitution =(...)
  if (/(?:(?<=^)|(?<=[\s;|&(<]))=\([^)]+\)/.test(source)) {
    return true;
  }
  // zsh glob qualifiers with code execution (e:...:)
  if (/[*?+@!]\(e:[^:]+:\)/.test(source)) {
    return true;
  }
  return false;
}

/** Split a command string into sub-commands by &&, ||, ;, | */
function parseSubCommands(command: string): string[] {
  // Split by &&, ||, ;, | but NOT inside single or double quoted strings.
  const result: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }
    if (!inSingle && !inDouble) {
      const two = command.substring(i, i + 2);
      if (two === '&&' || two === '||') {
        if (current.trim()) {
          result.push(current.trim());
        }
        current = '';
        i++;
        continue;
      }
      if (ch === ';' || ch === '|') {
        if (current.trim()) {
          result.push(current.trim());
        }
        current = '';
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) {
    result.push(current.trim());
  }
  return result;
}

/** Strip simple shell redirections like 2>&1, 2>, >file, etc. */
function stripRedirection(cmd: string): string {
  return cmd
    .replace(/\s*\d*>&\d*/g, '')
    .replace(/\s*\d*>[^\s]*/g, '')
    .replace(/\s*2>&1/g, '')
    .trim();
}

/**
 * Find the longest matching prefix from a list of prefixes.
 * "*" matches any command (treated as length 1).
 */
function findLongestPrefixMatch(command: string, prefixes: string[]): string | null {
  if (!command || !prefixes?.length) {
    return null;
  }
  const lower = command.trim().toLowerCase();
  let longest: string | null = null;
  for (const prefix of prefixes) {
    const lp = prefix.toLowerCase();
    if (lp === '*' || lower.startsWith(lp)) {
      if (!longest || lp.length > longest.length) {
        longest = lp;
      }
    }
  }
  return longest;
}

/**
 * Get decision for a single command using longest-prefix-match.
 * Denylist wins when its prefix is equally or more specific.
 */
function getSingleCommandDecision(command: string, allowed: string[], denied: string[]): CommandDecision {
  if (!command) {
    return 'auto_approve';
  }
  // Try both the raw command and the unwrapped (inner) command.
  // e.g. "/usr/bin/bash -lc 'gh issue view 1354 ...'" also checks "gh issue view 1354 ..."
  const candidates = [command];
  const bashMatch = command.match(/^(?:\/usr\/bin\/)?(?:bash|sh|zsh)\s+-l?c\s+['"]([^'"]+)['"]/);
  if (bashMatch) {
    candidates.push(bashMatch[1].trim());
  }
  let allowMatch: string | null = null;
  let denyMatch: string | null = null;
  for (const c of candidates) {
    const a = findLongestPrefixMatch(c, allowed);
    if (a && (!allowMatch || a.length > allowMatch.length)) {
      allowMatch = a;
    }
    const d = findLongestPrefixMatch(c, denied);
    if (d && (!denyMatch || d.length > denyMatch.length)) {
      denyMatch = d;
    }
  }
  if (allowMatch && !denyMatch) {
    return 'auto_approve';
  }
  if (!allowMatch && denyMatch) {
    return 'auto_deny';
  }
  if (allowMatch && denyMatch) {
    return allowMatch.length > denyMatch.length ? 'auto_approve' : 'auto_deny';
  }
  return 'ask_user';
}

/**
 * Get decision for a full command string (may contain sub-commands).
 * Any denied sub-command → deny whole command.
 * Dangerous patterns → always ask user.
 */
function getCommandDecision(command: string, allowed: string[], denied: string[]): CommandDecision {
  if (!command?.trim()) {
    return 'auto_approve';
  }
  if (containsDangerousSubstitution(command)) {
    return 'ask_user';
  }
  const subCommands = parseSubCommands(command);
  const decisions = subCommands.map((cmd) => {
    const clean = stripRedirection(cmd);
    return getSingleCommandDecision(clean, allowed, denied);
  });
  if (decisions.includes('auto_deny')) {
    return 'auto_deny';
  }
  if (decisions.every((d) => d === 'auto_approve')) {
    return 'auto_approve';
  }
  return 'ask_user';
}

/** Default dangerous commands to deny */
const DEFAULT_DENIED_COMMANDS = [
  'rm -rf',
  'rm -r',
  'rmdir',
  'sudo',
  'dd',
  'mkfs',
  'shutdown',
  'reboot',
  'chmod -R',
  'chown -R',
  'kill -9',
  'curl | sh',
  'wget | sh',
  'git push --force',
  'git push -f',
  'git reset --hard',
  ':(){:|:&};:',
  '>/dev/sda',
  '>/dev/null',
];

export class PermissionHandler {
  private pendingPermissionQueue: Array<{
    params: RequestPermissionRequest;
    resolve: (response: RequestPermissionResponse) => void;
  }> = [];
  private isProcessingPermission = false;
  /** Sync cache so back-to-back identical tool permissions (two subagents) hit
   *  before vscode.ConfigurationTarget.Global finishes writing. */
  private approvedToolsCache: Set<string> | null = null;

  /** Extract the command string from a tool call's rawInput (title fallback for Cursor). */
  private extractCommand(toolCall: any): string | undefined {
    return extractCommandFromToolCall(toolCall);
  }

  /** Extract the command prefix (first N tokens) for saving to the allowlist. */
  private extractPrefix(command: string): string {
    // Unwrap common shell wrappers to extract the meaningful command.
    // e.g. "/usr/bin/bash -lc 'cd /foo && gh issue view 1354 ...'"
    //   → "gh issue view 1354 ..."  →  prefix "gh"
    let cmd = command.trim();
    const bashMatch = cmd.match(/^(?:\/usr\/bin\/)?(?:bash|sh|zsh)\s+-l?c\s+['"]([^'"]+)['"]/);
    if (bashMatch) {
      cmd = bashMatch[1].trim();
    }
    // Use the first token as the prefix by default
    // e.g. "gh issue view 3715" → "gh"
    //      "PATH=... ninja -j4" → "PATH=... ninja"
    const parts = cmd.split(/\s+/);
    // If first token looks like ENV=val, include the next token too
    if (parts.length >= 2 && parts[0].includes('=')) {
      return parts.slice(0, 2).join(' ');
    }
    return parts[0] || cmd;
  }

  private loadAllowedCommands(): string[] {
    const fromSettings = vscode.workspace.getConfiguration('acp').get<string[]>('approvedCommands', []);
    const fromFile = readPermissionStore().approvedCommands;
    return mergePermissionLists(fromSettings, fromFile, false);
  }

  private loadDeniedCommands(): string[] {
    const userDenied = vscode.workspace.getConfiguration('acp').get<string[]>('deniedCommands', []);
    return [...new Set([...DEFAULT_DENIED_COMMANDS, ...userDenied])];
  }

  private saveAllowedCommand(prefix: string): void {
    if (!prefix) {
      return;
    }
    const approved = this.loadAllowedCommands();
    if (approved.includes(prefix)) {
      return;
    }
    approved.push(prefix);
    if (approved.length > 500) {
      approved.splice(0, approved.length - 500);
    }
    this.persistApprovedCommands(approved);
  }

  private extractToolFingerprint(params: RequestPermissionRequest): string | undefined {
    return extractPermissionToolFingerprint(params);
  }

  private loadApprovedTools(): string[] {
    if (this.approvedToolsCache) {
      return Array.from(this.approvedToolsCache);
    }
    const fromSettings = vscode.workspace.getConfiguration('acp').get<string[]>('approvedTools', []);
    const fromFile = readPermissionStore().approvedTools;
    const merged = mergePermissionLists(fromSettings, fromFile, true);
    this.approvedToolsCache = new Set(merged);
    return merged;
  }

  private persistApprovedCommands(approved: string[]): void {
    writePermissionStore({
      approvedCommands: approved,
      approvedTools: this.loadApprovedTools(),
    });
    vscode.workspace
      .getConfiguration('acp')
      .update('approvedCommands', approved, vscode.ConfigurationTarget.Global)
      .then(undefined, (e) => log(`Failed to save approved command: ${e}`));
  }

  private persistApprovedTools(approved: string[]): void {
    writePermissionStore({
      approvedCommands: this.loadAllowedCommands(),
      approvedTools: approved,
    });
    vscode.workspace
      .getConfiguration('acp')
      .update('approvedTools', approved, vscode.ConfigurationTarget.Global)
      .then(undefined, (e) => log(`Failed to save approved tool: ${e}`));
  }

  private saveApprovedTool(fingerprint: string): void {
    if (!fingerprint) {
      return;
    }
    const normalized = normalizeApprovedToolFingerprint(fingerprint);
    if (!this.approvedToolsCache) {
      this.loadApprovedTools();
    }
    if (this.approvedToolsCache!.has(normalized)) {
      return;
    }
    this.approvedToolsCache!.add(normalized);
    const approved = Array.from(this.approvedToolsCache!);
    if (approved.length > 500) {
      const trimmed = approved.slice(approved.length - 500);
      this.approvedToolsCache = new Set(trimmed);
    }
    this.persistApprovedTools(Array.from(this.approvedToolsCache!));
  }

  private isToolApproved(fingerprint: string | undefined): boolean {
    return isApprovedToolFingerprint(this.loadApprovedTools(), fingerprint);
  }

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const early = await this.tryAutoApprove(params);
    if (early) {
      return early;
    }

    // Slow path: needs user interaction — queue to prevent overlapping QuickPicks
    return new Promise((resolve) => {
      this.pendingPermissionQueue.push({ params, resolve });
      this.processPermissionQueue();
    });
  }

  /**
   * Evaluate the auto-approve fast paths (allowAll, previously allow_always'd
   * tool fingerprint, remember-mode command allow/denylist).
   *
   * Returns a response when the request can be settled without asking the
   * user, otherwise undefined.
   *
   * This MUST be re-evaluated when a request is dequeued, not only when it is
   * enqueued. Agents emit parallel tool calls: kiro-cli sends one
   * session/request_permission per tool call, so two edits to the same file
   * arrive milliseconds apart and both get queued while `isToolApproved()` is
   * still false. Approving the first one saves the fingerprint — but without a
   * dequeue-time re-check the second (identical) request still prompts, so the
   * user is asked twice for the same file.
   */
  private async tryAutoApprove(params: RequestPermissionRequest): Promise<RequestPermissionResponse | undefined> {
    const config = vscode.workspace.getConfiguration('acp');
    const autoApprove = config.get<string>('autoApprovePermissions', 'ask');
    const rawCommand = this.extractCommand(params.toolCall);
    const toolFp = this.extractToolFingerprint(params);

    // Fast path: allowAll auto-approves everything
    if (autoApprove === 'allowAll') {
      return this.handleAutoApproveAll(params);
    }

    // Fast path: previously allow_always'd non-command tools (Kiro subagent, etc.)
    // Honor regardless of ask/remember — allow_always means don't ask again.
    if (this.isToolApproved(toolFp)) {
      log(`Auto-approving (approved tool): ${toolFp}`);
      return this.handleAutoApproveAll(params);
    }

    // Fast path: remember mode — check prefix-based allowlist
    if (autoApprove === 'remember' && rawCommand) {
      const allowed = this.loadAllowedCommands();
      const denied = this.loadDeniedCommands();
      const decision = getCommandDecision(rawCommand, allowed, denied);
      if (decision === 'auto_approve') {
        log(`Auto-approving (prefix match): ${rawCommand.substring(0, 80)}...`);
        return this.handleAutoApproveAll(params);
      }
      if (decision === 'auto_deny') {
        log(`Auto-denying (denylist match): ${rawCommand.substring(0, 80)}...`);
        return { outcome: { outcome: 'cancelled' } };
      }
      // decision === 'ask_user' — fall through to manual
    }

    return undefined;
  }

  private async processPermissionQueue(): Promise<void> {
    if (this.isProcessingPermission || this.pendingPermissionQueue.length === 0) {
      return;
    }
    this.isProcessingPermission = true;
    const { params, resolve } = this.pendingPermissionQueue.shift()!;
    try {
      // Re-check the fast paths: an earlier request in this batch may have just
      // saved a matching fingerprint / command prefix while this one sat in the
      // queue (parallel tool calls on the same file).
      const late = await this.tryAutoApprove(params);
      resolve(late ?? (await this.handleManualPermission(params)));
    } catch (e) {
      log(`Permission handler error: ${e}`);
      resolve({ outcome: { outcome: 'cancelled' } });
    } finally {
      this.isProcessingPermission = false;
      if (this.pendingPermissionQueue.length > 0) {
        this.processPermissionQueue();
      }
    }
  }

  private async handleAutoApproveAll(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const title = params.toolCall?.title || 'Permission Request';
    const allowOption =
      params.options.find((o) => o.kind === 'allow_always') || params.options.find((o) => o.kind === 'allow_once');
    if (allowOption) {
      sendEvent('permission/requested', { permissionType: title, autoApproved: 'true' });
      return { outcome: { outcome: 'selected', optionId: allowOption.optionId } };
    }
    return { outcome: { outcome: 'cancelled' } };
  }

  private async handleManualPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const config = vscode.workspace.getConfiguration('acp');
    const autoApprove = config.get<string>('autoApprovePermissions', 'ask');
    const rawCommand = this.extractCommand(params.toolCall);
    const toolFp = this.extractToolFingerprint(params);

    const title = params.toolCall?.title || 'Permission Request';
    log(`requestPermission: ${title} (autoApprove=${autoApprove}${toolFp ? `, tool=${toolFp}` : ''})`);

    // Show diff preview for edit operations
    const content = (params.toolCall as any)?.content as
      Array<{ type: string; path?: string; oldText?: string; newText?: string }> | undefined;
    if (content && content.length > 0) {
      for (const item of content) {
        if (item.type === 'diff' && item.path) {
          await this.showDiff(item.path, item.oldText || '', item.newText || '');
        }
      }
    }

    // Build QuickPick items from agent-provided options
    const items: (vscode.QuickPickItem & { optionId: string })[] = params.options.map((option) => {
      const icon = option.kind.startsWith('allow') ? '$(check)' : '$(x)';
      return {
        label: `${icon} ${option.name}`,
        description: option.kind,
        optionId: option.optionId,
      };
    });

    // Add "Allow + remember prefix" option in remember mode
    if (autoApprove === 'remember' && rawCommand) {
      const prefix = this.extractPrefix(rawCommand);
      // Check if prefix is already in the allowlist
      const allowed = this.loadAllowedCommands();
      if (!allowed.includes(prefix)) {
        items.unshift({
          label: `$(check) Allow + remember "${prefix}" prefix`,
          description: 'allow_always',
          optionId: '__remember_prefix__',
        } as vscode.QuickPickItem & { optionId: string });
      }
    }

    sendEvent('permission/requested', { permissionType: title, autoApproved: 'false' });

    const placeHolder =
      autoApprove === 'remember' && rawCommand ? `${title} — command: ${rawCommand.substring(0, 100)}` : title;

    const selection = await vscode.window.showQuickPick(items, {
      placeHolder,
      title: 'ACP Agent Permission Request',
      ignoreFocusOut: true,
    });

    if (!selection) {
      log('Permission cancelled by user');
      sendEvent('permission/responded', { permissionType: title, outcome: 'cancelled' });
      return { outcome: { outcome: 'cancelled' } };
    }

    log(`Permission selected: ${selection.optionId}`);

    // If user chose "Allow + remember prefix", save the prefix and map to the first allow option
    if (selection.optionId === '__remember_prefix__' && rawCommand) {
      const prefix = this.extractPrefix(rawCommand);
      this.saveAllowedCommand(prefix);
      log(`Saved prefix "${prefix}" for future auto-approval`);
      const allowOption =
        params.options.find((o) => o.kind === 'allow_always') || params.options.find((o) => o.kind === 'allow_once');
      if (allowOption) {
        sendEvent('permission/responded', { permissionType: title, action: allowOption.optionId, outcome: 'selected' });
        return { outcome: { outcome: 'selected', optionId: allowOption.optionId } };
      }
    }

    const selectedOption = params.options.find((o) => o.optionId === selection.optionId);
    const isAllow = !!(selectedOption && selectedOption.kind.startsWith('allow'));

    // Shell commands: remember mode saves the command prefix on any allow.
    if (autoApprove === 'remember' && rawCommand && isAllow) {
      const prefix = this.extractPrefix(rawCommand);
      this.saveAllowedCommand(prefix);
      log(`Saved prefix "${prefix}" for future auto-approval`);
    }

    // Non-command tools (edit/read/grep/MCP): persist on allow_always, and also
    // on any allow in remember mode so reload/resume does not re-prompt.
    // Shell/execute uses approvedCommands prefix list — skip tool:execute bucket.
    if (toolFp && isAllow && toolFp !== 'tool:execute') {
      if (selectedOption?.kind === 'allow_always' || autoApprove === 'remember') {
        this.saveApprovedTool(toolFp);
        log(`Saved tool fingerprint "${toolFp}" for future auto-approval`);
      }
    }

    sendEvent('permission/responded', {
      permissionType: title,
      action: selection.optionId,
      outcome: 'selected',
    });
    return {
      outcome: {
        outcome: 'selected',
        optionId:
          selection.optionId === '__remember_prefix__'
            ? (
                params.options.find((o) => o.kind === 'allow_always') ||
                params.options.find((o) => o.kind === 'allow_once')
              )?.optionId || selection.optionId
            : selection.optionId,
      },
    };
  }

  private async showDiff(filePath: string, oldText: string, newText: string): Promise<void> {
    const oldUri = vscode.Uri.parse(`acp-diff:${filePath}?version=old`);
    const newUri = vscode.Uri.parse(`acp-diff:${filePath}?version=new`);

    const disposables: vscode.Disposable[] = [];
    const provider = new (class implements vscode.TextDocumentContentProvider {
      provideTextDocumentContent(uri: vscode.Uri): string {
        return uri.query.includes('old') ? oldText : newText;
      }
    })();

    disposables.push(vscode.workspace.registerTextDocumentContentProvider('acp-diff', provider));

    try {
      const fileName = filePath.split(/[\\/]/).pop() || filePath;
      await vscode.commands.executeCommand('vscode.diff', oldUri, newUri, `${fileName} (proposed changes)`);
    } catch (e) {
      log(`Failed to show diff: ${e}`);
    } finally {
      setTimeout(() => disposables.forEach((d) => d.dispose()), 5000);
    }
  }
}

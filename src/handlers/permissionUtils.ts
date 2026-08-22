import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { isCursorStubToolTitle } from '../core/CursorToolEnricher';

const STABLE_BUCKETS = new Set(['read', 'edit', 'delete', 'search', 'execute', 'move']);

/** Map tool name / kind to a stable permission bucket (survives title / rawInput stub changes). */
export function stablePermissionToolBucket(toolCall: unknown): string | undefined {
  const tc = toolCall as Record<string, unknown> | null | undefined;
  if (!tc) {
    return undefined;
  }
  const kind = typeof tc.kind === 'string' ? tc.kind.trim().toLowerCase() : '';
  const raw = tc.rawInput && typeof tc.rawInput === 'object' && !Array.isArray(tc.rawInput)
    ? (tc.rawInput as Record<string, unknown>)
    : null;
  const toolName = String(
    (raw && typeof raw._toolName === 'string' && raw._toolName) ||
      (raw && typeof raw.toolName === 'string' && raw.toolName) ||
      '',
  )
    .trim()
    .toLowerCase();

  const isRead = (n: string) => n === 'read' || n === 'read_file' || n === 'readfile';
  const isEdit = (n: string) =>
    n === 'edit' ||
    n === 'streplace' ||
    n === 'strreplace' ||
    n === 'str_replace' ||
    n === 'applypatch' ||
    n === 'write' ||
    n === 'write_file' ||
    n === 'writefile';
  const isDelete = (n: string) => n === 'delete' || n === 'delete_file';
  const isSearch = (n: string) =>
    n === 'grep' || n === 'rg' || n === 'ripgrep' || n === 'search' || n === 'find' || n === 'glob';
  const isShell = (n: string) =>
    n === 'shell' || n === 'bash' || n === 'run' || n === 'run_terminal_cmd';

  if (isRead(toolName) || kind === 'read') return 'read';
  if (isEdit(toolName) || kind === 'edit') return 'edit';
  if (isDelete(toolName) || kind === 'delete') return 'delete';
  if (isSearch(toolName) || kind === 'search' || kind === 'fetch') return 'search';
  if (isShell(toolName) || kind === 'execute') return 'execute';
  if (kind === 'move') return 'move';
  return undefined;
}

/** Normalize legacy fingerprints (title/command embedded) to stable buckets. */
export function normalizeApprovedToolFingerprint(fingerprint: string): string {
  if (!fingerprint) {
    return fingerprint;
  }
  if (/^tool:(read|edit|delete|search|execute|move)$/.test(fingerprint)) {
    return fingerprint;
  }
  const legacy = fingerprint.match(
    /^tool:(?:untitled|edit file|read file|write file|grep|find|[^|]+)\|(read|edit|delete|search|execute|move|fetch|other)$/i,
  );
  if (legacy) {
    const bucket = legacy[1] === 'fetch' ? 'search' : legacy[1].toLowerCase();
    if (STABLE_BUCKETS.has(bucket)) {
      return `tool:${bucket}`;
    }
  }
  if (/^tool:.+\|execute$/i.test(fingerprint)) {
    return 'tool:execute';
  }
  return fingerprint;
}

/** Extract shell command from toolCall rawInput, with title fallback for Cursor stubs. */
export function extractCommandFromToolCall(toolCall: unknown): string | undefined {
  const tc = toolCall as Record<string, unknown> | null | undefined;
  if (!tc) {
    return undefined;
  }
  const rawInput = tc.rawInput as Record<string, unknown> | undefined;
  if (rawInput) {
    if (typeof rawInput.command === 'string' && rawInput.command.trim()) {
      return rawInput.command;
    }
    if (Array.isArray(rawInput.command)) {
      return rawInput.command.join(' ');
    }
    if (Array.isArray(rawInput.parsed_cmd)) {
      const cmds = rawInput.parsed_cmd
        .map((p: unknown) =>
          typeof p === 'object' && p && ('cmd' in (p as object) || 'command' in (p as object))
            ? String((p as { cmd?: string; command?: string }).cmd || (p as { command?: string }).command || '')
            : String(p),
        )
        .filter((s: string) => s.length > 0);
      if (cmds.length > 0) {
        return cmds.join(' && ');
      }
    }
  }

  // Cursor ACP often omits command in rawInput; title carries the real command after enrichment.
  const kind = typeof tc.kind === 'string' ? tc.kind.trim().toLowerCase() : '';
  const title = typeof tc.title === 'string' ? tc.title.trim() : '';
  if ((kind === 'execute' || stablePermissionToolBucket(tc) === 'execute') && title && !isCursorStubToolTitle(title)) {
    return title;
  }
  return undefined;
}

/** Stable fingerprint for non-command tools; bucket-based for standard Cursor/Kiro tools. */
export function extractPermissionToolFingerprint(params: RequestPermissionRequest): string | undefined {
  const toolCall = params.toolCall as Record<string, unknown> | undefined;
  if (!toolCall) {
    return undefined;
  }

  const bucket = stablePermissionToolBucket(toolCall);
  if (bucket) {
    return `tool:${bucket}`;
  }

  const title = typeof toolCall.title === 'string' ? toolCall.title.trim().toLowerCase() : '';
  const kind = typeof toolCall.kind === 'string' ? toolCall.kind.trim().toLowerCase() : '';
  if (!title && !kind) {
    return undefined;
  }
  return `tool:${title || 'untitled'}|${kind || 'other'}`;
}

export function isApprovedToolFingerprint(approved: Iterable<string>, fingerprint: string | undefined): boolean {
  if (!fingerprint) {
    return false;
  }
  const normalized = normalizeApprovedToolFingerprint(fingerprint);
  for (const entry of approved) {
    if (entry === fingerprint) {
      return true;
    }
    if (normalizeApprovedToolFingerprint(entry) === normalized) {
      return true;
    }
  }
  return false;
}

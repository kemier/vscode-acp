import { resolve as resolvePath } from 'node:path';

/**
 * Tool-call title normalization shared by every agent.
 *
 * Agents label shell tool calls inconsistently: Kiro CLI prefixes the title
 * with `Running: `, and several agents wrap the command in a login shell and/or
 * a `cd <dir> &&` preamble. Left alone, the fold row reads
 * `Running: cd /workspace/git/... && grep -n foo` and the part the user cares
 * about is pushed off the end of the row.
 *
 * The full, unmodified command always remains available in the tool call's
 * `rawInput` (Kiro sends `rawInput.command`), which is what the hover tooltip
 * and the diff viewer use — only the one-line title is shortened.
 *
 * Semantics deliberately match codex-acp's `stripShellPrefix`
 * (codex-acp/src/CommandUtils.ts) so a row looks the same whichever agent
 * produced it, and so applying this to an already-normalized Codex title is a
 * no-op rather than a second transformation.
 */

/** True when two paths denote the same directory (trailing slashes ignored). */
function isSameDir(a: string, b: string): boolean {
  const normalize = (p: string) => p.replace(/\/+$/, '') || '/';
  try {
    return normalize(resolvePath(a)) === normalize(resolvePath(b));
  } catch {
    return false;
  }
}

/**
 * Strip a login-shell wrapper and a redundant `cd` preamble from a command.
 *
 * When `cwd` is given and the `cd` target IS that directory, the `cd` is KEPT:
 * the command genuinely runs in the session's working directory and showing it
 * makes that explicit. When the `cd` points somewhere else it is stripped,
 * because the interesting part is the command, not the navigation.
 *
 * A bare `cd <dir>` with no following command is returned unchanged — there is
 * nothing else to show.
 */
export function stripShellPrefix(command: string, cwd?: string): string {
  let withoutShell = command.replace(/^(?:\/bin\/)?(?:bash|zsh|sh)\s+(?:-[lc]+\s+)?/, '');
  if (withoutShell.startsWith("'") && withoutShell.endsWith("'")) {
    withoutShell = withoutShell.slice(1, -1);
  }
  const nl = withoutShell.indexOf('\n');
  const firstLine = (nl === -1 ? withoutShell : withoutShell.slice(0, nl)).trim();
  const rest = nl === -1 ? '' : withoutShell.slice(nl + 1);
  // `cd <dir> && <cmd>` — cd and the command share the first line.
  const cdAnd = firstLine.match(/^cd\s+(\S[^&]*?)\s*&&\s*(.+)$/);
  if (cdAnd && cdAnd[2]) {
    const inline = cdAnd[2].trim();
    if (cwd && isSameDir(cdAnd[1].trim(), cwd)) {
      return firstLine;
    }
    return rest ? `${inline}\n${rest}` : inline;
  }
  // Bare `cd <dir>` on its own line — the command starts on the next line.
  const cdOnly = firstLine.match(/^cd\s+(\S.*)$/);
  if (cdOnly && rest.trim()) {
    if (cwd && isSameDir(cdOnly[1].trim(), cwd)) {
      return withoutShell;
    }
    return rest.replace(/^\n+/, '');
  }
  return withoutShell;
}

/** Leading label Kiro CLI puts on shell tool calls. */
const RUNNING_PREFIX = /^Running:[ \t]+/;

/**
 * Extract a shell command from a tool call's rawInput, including the legacy
 * `{ arguments: { cmd | command } }` shape used by raw-rollout fallbacks.
 */
function commandFromRawInput(rawInput: unknown): string {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    return '';
  }
  const ri = rawInput as Record<string, unknown>;
  if (typeof ri.command === 'string' && ri.command.trim()) {
    return ri.command.trim();
  }
  if (Array.isArray(ri.command)) {
    return ri.command.join(' ').trim();
  }
  const args = ri.arguments;
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const a = args as Record<string, unknown>;
    for (const key of ['cmd', 'command'] as const) {
      const v = a[key];
      if (typeof v === 'string' && v.trim()) {
        return v.trim();
      }
    }
  }
  return '';
}

/**
 * True when a title is a bare tool NAME rather than a description of the work.
 *
 * Kiro CLI replays shell tool calls with the tool name alone (`shell`,
 * `execute`, `shell_command`, …), so the command exists only in rawInput. A
 * single token with no whitespace is never a shell command worth showing when a
 * real command is available alongside it.
 */
function isBareToolName(title: string): boolean {
  const t = title.trim();
  return t.length > 0 && t.length <= 24 && !/\s/.test(t);
}

/**
 * Normalize an agent-supplied tool-call title for display.
 *
 * When the agent supplied only a bare tool name and rawInput carries the real
 * command, the command is substituted (normalized). Doing this here rather than
 * in the webview matters twice over: the session cwd is only known on this side,
 * and the webview's own bare-title fallback would otherwise re-insert the raw,
 * unstripped command and undo the normalization.
 *
 * Returns the input unchanged when there is nothing to do, so callers can apply
 * it unconditionally to every agent's titles.
 */
export function cleanAgentToolTitle(
  title: string | null | undefined,
  cwd?: string,
  rawInput?: unknown,
): string {
  const raw = typeof title === 'string' ? title : '';
  // Bare tool name + a real command in rawInput → show the command.
  if (isBareToolName(raw)) {
    const cmd = commandFromRawInput(rawInput);
    if (cmd) {
      const fromRaw = stripShellPrefix(cmd, cwd);
      return fromRaw.trim() ? fromRaw : cmd;
    }
  }
  if (!raw.trim()) {
    return raw;
  }
  // Drop Kiro's `Running: ` label. Guard against a title that is ONLY the
  // label — stripping it would leave an empty row.
  let out = raw;
  if (RUNNING_PREFIX.test(out)) {
    const stripped = out.replace(RUNNING_PREFIX, '');
    if (stripped.trim()) {
      out = stripped;
    }
  }
  const shortened = stripShellPrefix(out, cwd);
  return shortened.trim() ? shortened : out;
}

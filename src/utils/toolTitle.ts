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
 * Normalize an agent-supplied tool-call title for display.
 *
 * Returns the input unchanged when there is nothing to strip, so callers can
 * apply it unconditionally to every agent's titles.
 */
export function cleanAgentToolTitle(title: string | null | undefined, cwd?: string): string {
  const raw = typeof title === 'string' ? title : '';
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

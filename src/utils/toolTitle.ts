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
 * Recognises both `cd <dir> && <cmd>` and `cd <dir>; <cmd>`, plus a bare
 * `cd <dir>` followed by the command on the next line.
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
  // `cd <dir> && <cmd>` / `cd <dir>; <cmd>` — cd and the command share the
  // first line. Both separators are common in agent output (Kiro CLI emits the
  // `;` form), and handling only `&&` left the whole `cd /some/other/repo; …`
  // preamble in the fold title.
  const cdAnd = firstLine.match(/^cd\s+(\S[^;&]*?)\s*(?:&&|;)\s*(.+)$/);
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

/** Basename for display; handles both separators without touching node:path. */
function baseName(p: string): string {
  const cleaned = p.trim().replace(/[\\/]+$/, '');
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/** Write sub-verbs some agents put in `rawInput.command` instead of a shell command. */
const WRITE_SUB_VERBS = /^(create|strreplace|insert|append|write|edit|delete|remove)$/i;

/**
 * Describe a read/write tool call from its rawInput.
 *
 * Kiro CLI labels tool calls richly while streaming (`Reading foo.ts:10-40`,
 * `Editing foo.ts`) but replays them on session/load with the bare tool name
 * (`read`, `write`) — and for `write` the only other hint is
 * `rawInput.command: "strReplace" | "create"`, which is why a resumed row read
 * just "read" or "create". The wording here mirrors the live titles so a
 * resumed row looks like the row it replaces.
 */
export function describeToolFromRawInput(rawInput: unknown): string {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    return '';
  }
  const ri = rawInput as Record<string, unknown>;

  // Read tool: { operations: [{ mode, path, offset, limit } | { image_paths }] }
  const ops = ri.operations;
  if (Array.isArray(ops) && ops.length > 0) {
    const parts: string[] = [];
    for (const op of ops) {
      if (!op || typeof op !== 'object') {
        continue;
      }
      const o = op as Record<string, unknown>;
      const imagePaths = Array.isArray(o.image_paths) ? (o.image_paths as unknown[]) : [];
      if (imagePaths.length > 0) {
        for (const ip of imagePaths) {
          if (typeof ip === 'string' && ip.trim()) {
            parts.push(baseName(ip));
          }
        }
        continue;
      }
      if (typeof o.path !== 'string' || !o.path.trim()) {
        continue;
      }
      const name = baseName(o.path);
      const offset = typeof o.offset === 'number' ? o.offset : null;
      const limit = typeof o.limit === 'number' ? o.limit : null;
      // Live wording: offset 1960 + limit 60 → "foo.ts:1961-2020".
      parts.push(offset !== null && limit !== null ? `${name}:${offset + 1}-${offset + limit}` : name);
    }
    if (parts.length > 0) {
      return `Reading ${parts.join(', ')}`;
    }
  }

  // Write/edit tools: a single path plus a sub-verb in `command`.
  const pathish = [ri.path, ri.file_path, ri.filePath].find((v) => typeof v === 'string' && (v as string).trim());
  if (typeof pathish === 'string') {
    const name = baseName(pathish);
    const verb = typeof ri.command === 'string' ? ri.command.trim().toLowerCase() : '';
    if (verb === 'create') {
      return `Creating ${name}`;
    }
    return WRITE_SUB_VERBS.test(verb) ? `Editing ${name}` : name;
  }
  return '';
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
export function cleanAgentToolTitle(title: string | null | undefined, cwd?: string, rawInput?: unknown): string {
  const raw = typeof title === 'string' ? title : '';
  // Bare tool name → recover a description from rawInput.
  if (isBareToolName(raw)) {
    const cmd = commandFromRawInput(rawInput);
    // `command: "strReplace"` is a write sub-verb, not a shell command; using it
    // as the title produced the "create" / "strReplace" stub rows on resume.
    if (cmd && !WRITE_SUB_VERBS.test(cmd)) {
      const fromRaw = stripShellPrefix(cmd, cwd);
      return fromRaw.trim() ? fromRaw : cmd;
    }
    const described = describeToolFromRawInput(rawInput);
    if (described) {
      return described;
    }
    // Nothing better available — the tool name beats a sub-verb.
    return raw;
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

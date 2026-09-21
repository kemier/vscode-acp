import { isAbsolute as isAbsolutePath, relative as relativePath, resolve as resolvePath } from 'node:path';

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

/**
 * Relative path when `target` is a directory INSIDE `cwd`, else null.
 *
 * `cwd` itself returns null: running in the session directory is the default and
 * needs no announcement in the title.
 */
function subdirOfCwd(target: string, cwd?: string): string | null {
  if (!cwd) {
    return null;
  }
  try {
    // A RELATIVE target is relative to the session cwd, never to the extension
    // host's process.cwd(). Resolving it against the process would land outside
    // the session root, so an already-normalized title from an adapter
    // ("cd src/ui && npm test") looked foreign and got stripped again — the
    // client would undo agent-side normalization depending on where the host
    // happened to be started.
    const base = resolvePath(cwd);
    const abs = isAbsolutePath(target) ? resolvePath(target) : resolvePath(base, target);
    const rel = relativePath(base, abs);
    if (!rel || rel === '.' || rel.startsWith('..') || isAbsolutePath(rel)) {
      return null;
    }
    return rel;
  } catch {
    return null;
  }
}

/**
 * Strip a login-shell wrapper and a redundant `cd` preamble from a command.
 *
 * Recognises both `cd <dir> && <cmd>` and `cd <dir>; <cmd>`, plus a bare
 * `cd <dir>` followed by the command on the next line.
 *
 * What happens to the `cd` depends on where it points, relative to `cwd`:
 *  - the session cwd itself → STRIPPED. That is where the command runs by
 *    default, so `cd /long/path/to/repo && …` is pure noise in a one-line title.
 *  - a directory INSIDE the session cwd → KEPT, rewritten relative:
 *    `cd /repo/src/ui && npm test` shows as `cd src/ui && npm test`. The
 *    location matters here and the relative form is what a reader needs.
 *  - anywhere else (another repo, /tmp, …) → STRIPPED; the command is the
 *    interesting part, not the navigation.
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
  const cdAnd = firstLine.match(/^cd\s+(\S[^;&]*?)\s*(&&|;)\s*(.+)$/);
  if (cdAnd && cdAnd[3]) {
    const inline = cdAnd[3].trim();
    const sub = subdirOfCwd(cdAnd[1].trim(), cwd);
    if (sub) {
      const joined = `cd ${sub}${cdAnd[2] === ';' ? ';' : ' &&'} ${inline}`;
      return rest ? `${joined}\n${rest}` : joined;
    }
    return rest ? `${inline}\n${rest}` : inline;
  }
  // Bare `cd <dir>` on its own line — the command starts on the next line.
  const cdOnly = firstLine.match(/^cd\s+(\S.*)$/);
  if (cdOnly && rest.trim()) {
    // The newline form is always stripped, even for a subdirectory: the client
    // renders only the FIRST line of a title, so keeping "cd src" would show the
    // directory and hide the command. The single-line && / ; form keeps the
    // relative cd because there both fit on the rendered line.
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
 * Every `rawInput.command` value that is a tool SUB-VERB rather than a shell
 * command, and so must never become a row title.
 *
 * A superset of WRITE_SUB_VERBS, which stays narrow because it also decides
 * whether to label a row "Editing X" — and `complete` or `list` is not an edit.
 *
 * The todo-list verbs are here because their absence had a second, invisible
 * effect. Kiro replays its task board as `title: "todo_list"` with the state in
 * rawInput, and cleanAgentToolTitle rewrote a bare tool name using
 * rawInput.command. `create` was already listed so it survived as "todo_list";
 * `complete` was not, so those frames reached the client titled "complete".
 * Measured in one replay: 3 frames posted as todo_list, 5 as "complete". That
 * both produced a meaningless row AND made the completions unrecognisable to the
 * board mapper, so every checkbox stayed unticked.
 */
const TOOL_SUB_VERBS = /^(create|strreplace|insert|append|write|edit|delete|remove|complete|add|list|view|update)$/i;

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
      return `Writing ${name}`;
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
    // `command: "strReplace"` is a sub-verb, not a shell command; using it as the
    // title produced the "create" / "strReplace" stub rows on resume — and, for
    // kiro's todo_list, a row titled "complete" whose board updates then went
    // unrecognised. TOOL_SUB_VERBS is the full set; WRITE_SUB_VERBS stays narrow
    // because it also decides the "Editing X" label.
    if (cmd && !TOOL_SUB_VERBS.test(cmd)) {
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

/**
 * Helpers for resolving code links clicked in the chat panel.
 *
 * Both exist because of one concrete failure: an ericli session working in
 * /workspace/git/ezennin/llama.cpp emitted `src/llama-memory-recurrent.cpp:898`,
 * the extension joined that onto THIS workspace root, found nothing, and then
 * fell back to a workspace symbol search for the first identifier in the link
 * text — "src" — which matched 15349 symbols and jumped into an unrelated repo.
 */

/**
 * Roots a relative code link may be resolved against, most specific first and
 * de-duplicated.
 *
 * The agent's cwd wins over the workspace: a relative path in agent output is
 * relative to where the agent runs, which is often a different repository.
 */
export function orderedLinkRoots(
  activeSessionCwd: string | undefined,
  otherSessionCwds: readonly (string | undefined)[],
  workspaceRoots: readonly (string | undefined)[],
): string[] {
  const roots: string[] = [];
  for (const candidate of [activeSessionCwd, ...otherSessionCwds, ...workspaceRoots]) {
    if (candidate && !roots.includes(candidate)) {
      roots.push(candidate);
    }
  }
  return roots;
}

/**
 * Symbol name to fall back on when a link's file cannot be opened — undefined
 * when the link text is a path rather than a symbol.
 *
 * A path is never a symbol, so `src/foo.cpp:898`, `foo.cpp` and `./a/b` get no
 * fallback and the caller reports the real "file not found" instead of jumping
 * somewhere unrelated. `?symbol=` links and `[name](…)` anchors still qualify.
 */
export function symbolFallbackFromLinkText(linkText?: string | null): string | undefined {
  const text = (linkText || '').trim();
  if (!text) {
    return undefined;
  }
  // Drop a trailing :line / :line-end / :line:col before judging the shape.
  const withoutLine = text.replace(/:\d+(?:[-:]\d+)?$/, '');
  if (/[\\/]/.test(withoutLine)) {
    return undefined;
  }
  if (/\.[A-Za-z0-9]{1,8}$/.test(withoutLine)) {
    return undefined;
  }
  return withoutLine.match(/^([a-zA-Z_][a-zA-Z0-9_]*(?:::[a-zA-Z_][a-zA-Z0-9_]*)*)/)?.[1];
}

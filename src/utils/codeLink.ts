/**
 * Helpers for resolving code links clicked in the chat panel.
 *
 * Both exist because of one concrete failure: an codex session working in
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

/** Path segments that mark a copy/derived tree rather than the real source. */
const NOISE_SEGMENTS = new Set([
  'node_modules',
  '.git',
  '.cache',
  '.ccls-cache',
  'build',
  'out',
  'dist',
  'target',
  'third_party',
  '3pp',
  'test',
  'tests',
  'test_cpp',
  'testing',
  'mock',
  'mocks',
  'backup',
]);

function posixSegments(p: string): string[] {
  return p.replace(/\\/g, '/').split('/').filter(Boolean);
}

/**
 * Directories to search on disk for a file that neither a known root nor the
 * workspace index could resolve, most specific first.
 *
 * `vscode.workspace.findFiles` only ever sees the OPEN workspace, so a session
 * running in /workspace/git/ezennin/vepg while the window has vepg/epg open
 * cannot resolve `icr_worker.c` — the file sits in vepg/ssr/…, outside the
 * workspace. Each root's parent is appended last so a sibling repository is
 * still reachable, and `minDepth` keeps the widening from ever reaching / or a
 * two-level directory like /workspace/git.
 */
export function fileSearchRoots(roots: readonly string[], minDepth = 3): string[] {
  const out: string[] = [];
  const push = (candidate: string | undefined): void => {
    if (!candidate) {
      return;
    }
    const normalized = candidate.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!normalized || posixSegments(normalized).length < minDepth || out.includes(normalized)) {
      return;
    }
    out.push(normalized);
  };
  for (const root of roots) {
    push(root);
  }
  for (const root of roots) {
    const normalized = (root || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash > 0) {
      push(normalized.substring(0, lastSlash));
    }
  }
  return out;
}

/**
 * Best on-disk candidate for a relative link path, or undefined when there is
 * none.
 *
 * All candidates already end with the requested name, so the ranking only has
 * to answer "which copy did the agent mean": an exact tail match wins, derived
 * or test trees lose, and the shallowest path breaks the remaining ties.
 */
export function pickBestFileMatch(candidates: readonly string[], relPath: string): string | undefined {
  const rel = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  let best: string | undefined;
  let bestScore = -Infinity;
  for (const candidate of candidates) {
    const p = candidate.replace(/\\/g, '/');
    if (!p) {
      continue;
    }
    const segments = posixSegments(p);
    let score = 0;
    if (p === rel || p.endsWith('/' + rel)) {
      score += 1000;
    } else if (p.includes('/' + rel + '/') || p.includes(rel)) {
      score += 500;
    }
    for (const segment of segments) {
      if (NOISE_SEGMENTS.has(segment.toLowerCase())) {
        score -= 40;
      }
    }
    score -= segments.length;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
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

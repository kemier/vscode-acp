/**
 * Single source of truth for the auto-linkifier's regexes.
 *
 * These lived inline in ChatWebviewProvider.renderMarkdown() and were COPIED into
 * linkifier.test.ts, which carried the note "When the production code changes, update
 * this too". That does not work: a copy cannot notice a change to the original. By the
 * time this module was created the copy had already drifted —
 *
 *   production  ([a-zA-Z_][a-zA-Z0-9_]+_t)   (>=2 chars before _t)
 *   test copy   ([a-zA-Z_][a-zA-Z0-9_]*_t)   (still matched k_t, c_t, v_t)
 *
 * so the test was asserting behaviour production no longer had, on the very rule that
 * had just been fixed.
 *
 * Every export is a FACTORY, not a shared RegExp instance. All of these carry the `g`
 * flag, and a `g` regex keeps `lastIndex` between calls — sharing one instance across
 * passes or across tests silently skips matches.
 */

/** Skip already-rendered KaTeX when splitting HTML: see markdownMath.ts. */
export const ACP_MATH_SPLIT_PATTERN = '<acp-math\\b[^>]*>[\\s\\S]*?</acp-math>';

/**
 * File extensions treated as code for bare-filename linkification.
 * Ordered longest-first where prefixes collide (`c++` before `c`), because the
 * alternation is first-match.
 */
export const CODE_EXTENSIONS_PATTERN =
  '(?:c\\+\\+|h\\+\\+|hpp|hxx|htc|cpp|cxx|cc|hh|cu|cuh|tsx|jsx|mjs|cjs|pyi|pyw|kts|csx|fsx|exs|cljs|sc|sh|rs|py|go|java|kt|swift|ts|js|rb|cs|php|scala|bash|zsh|sql|proto|graphql|vue|svelte|zig|nim|lua|pl|pm|erl|clj|hs|ml|fs|elm|inl|tpp|ipp|mm|ex|jl|d|v|h|c|m|cmake|make|mk|gradle|toml|yaml|yml|json|xml|svg|txt|md|rst|cfg|conf|ini|env|lock|log|diff|patch|csv|tsv|wxs|wxi|wxl|iss|nsi|nsh|doxy|doxygen|dockerfile|gemspec|podspec|rake|gemfile|procfile|vagrantfile|bashrc|zshrc|vimrc|gitignore|gitattributes|editorconfig|dockerignore|npmrc|yarnrc|service|timer|socket|mount|automount|swap|link|path|network|netdev|plantuml|puml)';

/**
 * Paths and bare filenames, with an optional `:line` or `:line-end` suffix.
 * Filenames may contain spaces ("DI_Lodge SMF BGP Route Details.txt:40") and may be
 * dotfiles (`.env`, `.md`).
 */
export function makeFilePathRegex(): RegExp {
  const codeExt = CODE_EXTENSIONS_PATTERN;
  return new RegExp(
    '(^|[^\\w\\/])' + // prefix: start or non-word, non-slash
      '(' +
      '(?:~\\/|\\.?\\/?[\\w.-]+\\/)+' + // at least one dir separator; ~/ home-relative
      '[\\w.-]*(?:\\s+[\\w.-]+)*\\.' + //   filename may be a dotfile or contain spaces
      codeExt +
      '(?::\\d+(?:-\\d+)?)?' + //   + filename.ext[:line[:-end]]
      '(?=$|[\\s,;:\\)\\]\\}\\<|])' + //   word boundary after extension
      '|' +
      '[\\w.-]+(?:\\s+[\\w.-]+)*\\.' + // bare filename.ext:line, spaces allowed
      codeExt +
      '(?::\\d+(?:-\\d+)?)' +
      '|' +
      '[\\w.-]*\\.' + //   bare filename may be a dotfile (.env, .md)
      codeExt +
      '(?=$|[\\s,;:\\)\\]\\}<|])' + // bare filename.ext (no line)
      ')',
    'g',
  );
}

/**
 * PascalCase types: ConfigDataPrivate, N2ResModifyUpdateHandlerBase, PiafData, N11Info.
 *
 * The `(?<![\w:._])` lookbehind blocks matches inside a longer identifier, which is what
 * keeps `IXmlConfigHandlerTx`, `addSliceRouteReq`, `std::Foo`, `obj.Method` and
 * `TC123_Test` from being split apart. The lookahead excludes `:` so `Service::Builder`
 * does not match just `Service`.
 */
export function makePascalCaseRegex(): RegExp {
  return /(?<![\w:._])([A-Z][a-z0-9]+(?:[A-Z][a-zA-Z0-9]*)+)(?=$|[\s,;)\]\}<])/g;
}

/**
 * snake_case functions: process_data, get_user_info, handle_request.
 * Requires two or more segments, so ALL_CAPS constants and single words are excluded.
 * The lookbehind skips `std::to_underlying` and `obj.get_data`.
 */
export function makeSnakeCaseRegex(): RegExp {
  return /(?<![:.])([a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?=$|[\s,;:\)\]\}\.<])/g;
}

/**
 * C typedef-style names ending in `_t`, linkified in prose as well as in code.
 *
 * At least TWO characters must precede the suffix. One is a math subscript, not a type:
 * `k_t`, `c_t`, `v_t`, `h_t`. Reported from a Chinese course document where
 * `k_t = W_up_k c_t, v_t = W_up_v c_t` rendered with three variables as symbol links.
 * Every real short typedef still qualifies — id_t, fd_t, pid_t, uid_t, off_t, size_t.
 */
export function makeTypedefRegex(): RegExp {
  return /(?<![\w:._])([a-zA-Z_][a-zA-Z0-9_]+_t)(?=$|[\s,;:\)\]\}\.<])/g;
}

/** Hosts whose URLs are recognised bare (no scheme) and must not be re-linkified. */
const KNOWN_DOC_HOSTS =
  '(?:github|gitlab|bitbucket|stackoverflow|developer\\.mozilla|en\\.wikipedia|docs\\.python|docs\\.rust-lang|crates\\.io|pypi\\.org|npmjs\\.com|docs\\.oracle|learn\\.microsoft|developer\\.android|kubernetes\\.io|docker\\.com|nodejs\\.org|python\\.org|go\\.dev|rust-lang\\.org|swift\\.org|jetbrains\\.com|visualstudio\\.com|atlassian\\.com|confluence\\.atlassian|jira\\.atlassian|gerrit\\.googlesource|gerrit-review\\.googlesource)\\.[a-z]+\\/[^\\s<]+';

const NOLINK_SPAN = '<span class="nolink">.*?</span>';
const FILE_REF_SPAN = '<span class="file-ref">.*?</span>';
const ANCHOR_AND_URLS =
  `<a\\s[^>]*>.*?</a>|https?:\\/\\/[^\\s<]+|www\\.[^\\s<]+` +
  `|file:\\/\\/\\/[^\\s<"]+|${KNOWN_DOC_HOSTS}`;

/**
 * Split HTML so linkification only touches prose. Even indices are plain text, odd
 * indices are regions to leave alone (rendered math, code, existing links, URLs).
 *
 * Alternation order is preserved from the original inline definitions — it is
 * first-match, so reordering can change which region wins at a given position.
 */
export function makeSplitRegex(): RegExp {
  return new RegExp(
    `(${ACP_MATH_SPLIT_PATTERN}|<pre>.*?</pre>|${NOLINK_SPAN}|${ANCHOR_AND_URLS})`,
    'gs',
  );
}

/**
 * As makeSplitRegex, but also protects `<code>` spans and already-resolved file refs.
 * Used by the passes that must NOT reach inside a code span.
 */
export function makeSplitRegexWithFileRef(): RegExp {
  return new RegExp(
    `(${ACP_MATH_SPLIT_PATTERN}|<pre>.*?</pre>|<code>.*?</code>` +
      `|${NOLINK_SPAN}|${FILE_REF_SPAN}|${ANCHOR_AND_URLS})`,
    'gs',
  );
}

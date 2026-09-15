import * as assert from 'assert';
import {
  makeFilePathRegex,
  makePascalCaseRegex,
  makeSplitRegex,
  makeSplitRegexWithFileRef,
  makeTypedefRegex,
} from '../ui/markdownLinkifyPatterns';
import { LANGUAGE_KEYWORDS, NON_SYMBOL_PASCAL_CASE } from '../ui/markdownLinkifyKeywords';

// The keyword sets are imported, not restated. The local copies had drifted badly:
// pascalKeywords was missing 208 of production's entries (language and product names
// like ActionScript, AutoHotkey) so the test linkified names production leaves alone,
// while carrying 148 of its own that pascalCaseRegex can never match anyway (The, This,
// Note — single humps). langKeywords carried 278 plain keywords (auto, const, int) that
// production deliberately omits, because Pass 2b already requires an underscore or `::`
// structurally, so only keywords that could slip through THAT filter need listing
// (thread_local, static_assert, _Bool, and_eq).
const pascalKeywords = NON_SYMBOL_PASCAL_CASE;
const langKeywords = LANGUAGE_KEYWORDS;

/**
 * Reimplementation of the linkification PIPELINE from
 * ChatWebviewProvider.renderMarkdown(), for testing without vscode deps.
 *
 * The regexes are NOT reimplemented — they are imported from
 * markdownLinkifyPatterns.ts, the same module production uses. They used to be copied
 * here under the note "When the production code changes, update this too", and the copy
 * had silently drifted: `typedefRegex` still carried `*` after production moved to `+`
 * (so the copy still matched the math subscripts `k_t`/`c_t`/`v_t` that the fix removed),
 * and `filePathRegex` was missing production's space-in-filename support.
 *
 * What remains local is the ORDER of the passes. If you change that order in production,
 * change it here too.
 */

// --- Code extensions (must match ChatWebviewProvider.ts) ---

// --- Split regexes (must match ChatWebviewProvider.ts) ---
const splitRegex = makeSplitRegex();
const splitRegexWithFileRef = makeSplitRegexWithFileRef();


// --- Code span keywords (must match ChatWebviewProvider.ts) ---
// --- Language keywords (C/C++/Go/Rust/TS/JS/Python) — must match ChatWebviewProvider.langKeywords ---
// Sources: en.cppreference.com, go.dev/ref/spec, doc.rust-lang.org, typescriptlang.org, docs.python.org

// --- Code span keywords = langKeywords (for Pass 2b) ---
const codeSymKw = [...langKeywords];

// --- Pass 3 keywords = langKeywords (for Pass 3) ---
const pass3Keywords = [...langKeywords];

// --- Regexes (must match ChatWebviewProvider.ts) ---
const pascalCaseRegex = makePascalCaseRegex();
const typedefRegex = makeTypedefRegex();
const filePathRegex = makeFilePathRegex();

/**
 * Simplified renderMarkdown that tests only the linkification passes
 * (skips marked.parse — tests use pre-parsed HTML).
 */
function linkify(html: string): string {
  // Pass 0: Markdown link processing
  html = html.replace(/<a\s+href="([^"]*)"[^>]*>(.*?)<\/a>/g, (match, href, inner) => {
    if (href.startsWith('@symbol:')) {
      return match;
    }
    if (href.startsWith('http://') || href.startsWith('https://')) {
      return match;
    }
    if (href.startsWith('file://')) {
      return match;
    }
    if (href.includes('.') && !href.endsWith('/') && !href.endsWith('/.')) {
      if (/:\d+/.test(href)) {
        return match;
      }
      const looksLikeSymbol =
        /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(inner.trim()) &&
        !inner.includes('/') &&
        !inner.includes('\\') &&
        !/\.[a-zA-Z]{1,5}$/.test(inner.trim());
      if (looksLikeSymbol) {
        const hrefBase = href.split('/').pop() || '';
        const hrefStem = hrefBase.replace(/\.[a-zA-Z0-9]+$/, '');
        if (hrefStem === inner.trim()) {
          return match;
        }
        // Skip C++ stdlib namespace and language keywords — not project symbols
        const symLower = inner.trim().toLowerCase();
        if (symLower.startsWith('std::') || langKeywords.has(symLower)) {
          return `<span class="nolink">${inner}</span>`;
        }
        return `<a href="@symbol:${inner.trim()}" class="symbol-link">${inner}</a>`;
      }
      const looksLikeFilePath = inner.includes('/') || inner.includes('\\') || /\.[a-zA-Z]{1,5}$/.test(inner.trim());
      if (looksLikeFilePath) {
        return match;
      }
      return `<span class="nolink">${inner}</span>`;
    }
    return `<span class="nolink">${inner}</span>`;
  });

  // Pass 1: file paths
  let parts = html.split(splitRegex);
  for (let pi = 0; pi < parts.length; pi++) {
    if (pi % 2 === 1) {
      continue;
    }
    parts[pi] = parts[pi].replace(filePathRegex, (match, prefix, pathMatch) => {
      const colonIdx = pathMatch.lastIndexOf(':');
      let path = pathMatch;
      let line: string | undefined;
      let lineEnd: string | undefined;
      if (colonIdx > 0) {
        const afterColon = pathMatch.slice(colonIdx + 1);
        const dashIdx = afterColon.indexOf('-');
        let lineStr, endStr;
        if (dashIdx > 0) {
          lineStr = afterColon.slice(0, dashIdx);
          endStr = afterColon.slice(dashIdx + 1);
        } else {
          lineStr = afterColon;
          endStr = '';
        }
        if (lineStr && /^[0-9]+$/.test(lineStr)) {
          path = pathMatch.slice(0, colonIdx);
          line = lineStr;
          if (endStr && /^[0-9]+$/.test(endStr)) {
            lineEnd = endStr;
          }
        }
      }
      let linePart = '';
      let label = path;
      if (line) {
        linePart = ` data-line="${line}"`;
        if (lineEnd) {
          linePart += ` data-line-end="${lineEnd}"`;
          label = `${path}:${line}-${lineEnd}`;
        } else {
          label = `${path}:${line}`;
        }
        return `${prefix}<a href="#" class="file-link" data-file="${path}"${linePart}>${label}</a>`;
      }
      return `${prefix}<a href="#" class="file-link bare-file-link" data-file="${path}">${path}</a>`;
    });
  }
  html = parts.join('');

  // Pass 2: PascalCase
  parts = html.split(splitRegexWithFileRef);
  for (let pi = 0; pi < parts.length; pi++) {
    if (pi % 2 === 1) {
      continue;
    }
    parts[pi] = parts[pi].replace(pascalCaseRegex, (match, sym) => {
      if (pascalKeywords.has(sym)) {
        return match;
      }
      if (!/[a-z]/.test(sym)) {
        return match;
      }
      if (sym.length > 40) {
        return match;
      }
      return `<a href="@symbol:${sym}" class="symbol-link">${sym}</a>`;
    });
  }
  html = parts.join('');

  // Pass 2a: typedef _t
  parts = html.split(splitRegexWithFileRef);
  for (let pi = 0; pi < parts.length; pi++) {
    if (pi % 2 === 1) {
      continue;
    }
    parts[pi] = parts[pi].replace(typedefRegex, (match, sym: string) => {
      return `<a href="@symbol:${sym}" class="symbol-link">${sym}</a>`;
    });
  }
  html = parts.join('');

  // Pass 2b: code spans
  html = html.replace(
    /<code>([a-zA-Z_][a-zA-Z0-9_]*(?:::[a-zA-Z_][a-zA-Z0-9_]*)*)(\(\))?<\/code>/g,
    (match, symName, parens) => {
      if (codeSymKw.includes(symName.toLowerCase())) {
        return match;
      }
      // Skip ALL_CAPS identifiers (CMake variables like CMAKE_CONFIGURE_DEPENDS,
      // constants like MAX_BUFFER_SIZE, macros like NDEBUG).
      if (/^[A-Z][A-Z0-9_]*$/.test(symName) && symName.includes('_')) {
        return match;
      }
      // Skip C++ stdlib namespace (std::variant, std::string, std::vector, etc.)
      if (symName.startsWith('std::')) {
        return match;
      }
      const hasUnder = symName.includes('_');
      const hasNS = symName.includes('::');
      const upperCount = (symName.match(/[A-Z]/g) || []).length;
      const isPascal = upperCount >= 2 && /[a-z]/.test(symName);
      if (!hasUnder && !hasNS && !isPascal) {
        return match;
      }
      const display = parens ? `${symName}()` : symName;
      return `<a href="@symbol:${symName}" class="symbol-link"><code>${display}</code></a>`;
    },
  );

  // Pass 3: symbol (file:line)
  html = html.replace(
    /([a-zA-Z_][a-zA-Z0-9_]*)\s*\(\s*([\w.-]+\.[a-zA-Z]+)(?::(\d+))?\s*\)/g,
    (match, symName, fileName, lineNum) => {
      if (pass3Keywords.includes(symName.toLowerCase())) {
        return match;
      }
      // Skip ALL_CAPS identifiers (CMake variables, constants, macros).
      if (/^[A-Z][A-Z0-9_]*$/.test(symName) && symName.includes('_')) {
        return match;
      }
      if (!fileName.includes('.')) {
        return match;
      }
      const display = lineNum ? `${symName} (${fileName}:${lineNum})` : `${symName} (${fileName})`;
      if (lineNum) {
        return `<a href="@symbol:${symName}" class="symbol-link">${display}</a>`;
      }
      return `<a href="#" class="file-link" data-file="${fileName}">${display}</a>`;
    },
  );

  return html;
}

// --- Helper assertions ---
function assertContains(html: string, substring: string, msg?: string): void {
  assert.ok(html.includes(substring), msg || `Expected HTML to contain "${substring}", got: ${html}`);
}
function assertNotContains(html: string, substring: string, msg?: string): void {
  assert.ok(!html.includes(substring), msg || `Expected HTML to NOT contain "${substring}", got: ${html}`);
}

suite('Linkifier Test Suite', () => {
  // === Markdown Link Processing (Pass 0) ===

  test('file:// links are kept clickable', () => {
    const html = linkify('<a href="file:///path/to/file.rs#L42" class="something">file.rs</a>');
    assertContains(html, 'href="file://');
  });

  test('http(s) links are kept clickable', () => {
    const html = linkify('<a href="https://example.com">Example</a>');
    assertContains(html, 'href="https://');
  });

  test('@symbol: links are kept', () => {
    const html = linkify('<a href="@symbol:my_func" class="symbol-link">my_func</a>');
    assertContains(html, 'href="@symbol:my_func"');
  });

  test('markdown link with symbol inner text and file href → @symbol link', () => {
    const html = linkify('<a href="src/main.c">my_function</a>');
    assertContains(html, 'href="@symbol:my_function"');
  });

  test('markdown link with file path inner text → kept as link', () => {
    const html = linkify('<a href="src/main.c">src/main.c</a>');
    assertContains(html, '<a ');
    assertNotContains(html, 'class="nolink"');
  });

  test('markdown link with prose inner text (X-Macro Pattern) → unwrapped', () => {
    const html = linkify('<a href="docs/ModernCppFeatures.md">X-Macro Pattern</a>');
    assertContains(html, 'class="nolink"');
    assertNotContains(html, 'href=');
    assertContains(html, 'X-Macro Pattern');
  });

  test('markdown link with directory href → unwrapped', () => {
    const html = linkify('<a href="some/directory/">some/directory/</a>');
    assertContains(html, 'class="nolink"');
  });

  test('markdown link with symbol:line href → kept as link', () => {
    const html = linkify('<a href="src/main.c:42">my_function</a>');
    assertNotContains(html, 'class="nolink"');
  });

  // === File Path Linkification (Pass 1) ===

  test('file path with :line → clickable file-link', () => {
    const html = linkify('<p>See src/main.rs:74 for details</p>');
    assertContains(html, 'class="file-link"');
    assertContains(html, 'data-file="src/main.rs"');
    assertContains(html, 'data-line="74"');
  });

  test('file path with :line-range → clickable file-link', () => {
    const html = linkify('<p>See src/main.rs:74-80 for details</p>');
    assertContains(html, 'data-line="74"');
    assertContains(html, 'data-line-end="80"');
  });

  test('bare file path with known extension → clickable bare-file-link', () => {
    const html = linkify('<p>See tools/build/cmake/ControlPlaneCommonCompileFlags.cmake</p>');
    assertContains(html, 'class="file-link bare-file-link"');
    assertContains(html, 'data-file="tools/build/cmake/ControlPlaneCommonCompileFlags.cmake"');
  });

  test('bare filename with .cmake extension → clickable', () => {
    const html = linkify('<p>See CMakeLists.txt</p>');
    assertContains(html, 'class="file-link bare-file-link"');
    assertContains(html, 'data-file="CMakeLists.txt"');
  });

  test('bare filename with .md extension → clickable', () => {
    const html = linkify('<p>See BUILD.md</p>');
    assertContains(html, 'class="file-link bare-file-link"');
  });

  test('bare filename with .h extension → clickable', () => {
    const html = linkify('<p>See Handler.h</p>');
    assertContains(html, 'class="file-link bare-file-link"');
  });

  test('file path in <pre> block → NOT linkified', () => {
    const html = linkify('<pre>src/main.rs:74</pre>');
    assertNotContains(html, 'class="file-link"');
  });

  test('file path inside <code> block IS linkified by Pass 1', () => {
    // This asserted the opposite for as long as the file existed, and was wrong the whole
    // time: it was written against the local copy of splitRegex, which listed
    // `<code>.*?</code>` among the protected regions. Production's splitRegex has NEVER
    // contained it — verified against the pre-KaTeX revision (d5184f6^) as well. Only
    // splitRegexWithFileRef protects code spans, and that one is used by the SYMBOL
    // passes, not by Pass 1.
    //
    // The production behaviour is also the useful one: models routinely write a file
    // reference as `src/main.rs:74` in backticks, and that should be clickable.
    const html = linkify('<code>src/main.rs:74</code>');
    assertContains(html, 'class="file-link"');
    assertContains(html, 'data-file="src/main.rs"');
    assertContains(html, 'data-line="74"');
  });

  test('symbol passes still do NOT reach inside a code span', () => {
    // The complement of the above, and the reason two split regexes exist: Pass 2a would
    // otherwise linkify a typedef twice (once as prose, once inside the span).
    const html = linkify('<code>uint32_t</code>');
    assertNotContains(html, 'class="symbol-link"');
  });

  // === ~/ (home-relative) path linkification (Pass 1) ===

  test('~/ path → clickable file-link with ~ kept in data-file', () => {
    const html = linkify('<p>See ~/notes/project.md for details</p>');
    assertContains(html, 'class="file-link bare-file-link"');
    assertContains(html, 'data-file="~/notes/project.md"');
    // The ~ must be part of the clickable path, not stripped into the prefix.
    assertNotContains(html, 'data-file="/notes/project.md"');
  });

  test('~/.vscode-server/.../settings.json → clickable file-link with ~ kept', () => {
    const html = linkify('<p>The path is ~/.vscode-server/data/Machine/settings.json</p>');
    assertContains(html, 'class="file-link bare-file-link"');
    assertContains(html, 'data-file="~/.vscode-server/data/Machine/settings.json"');
  });

  test('~/.zshrc → clickable file-link (bare dotfile, no directory slash after ~/)', () => {
    const html = linkify('<p>Loaded from ~/.zshrc</p>');
    // .zshrc is a dotfile starting with '.'; the regex dir-segment allows a leading dot,
    // so the path must include the ~ prefix.
    assertContains(html, 'data-file="~/.zshrc"');
  });

  test('~/ path with :line → clickable file-link with line', () => {
    const html = linkify('<p>See ~/src/main.rs:74</p>');
    assertContains(html, 'class="file-link"');
    assertContains(html, 'data-file="~/src/main.rs"');
    assertContains(html, 'data-line="74"');
  });

  test('bare dotfile .env → clickable file-link', () => {
    const html = linkify('<p>Config lives in .env</p>');
    assertContains(html, 'class="file-link bare-file-link"');
    assertContains(html, 'data-file=".env"');
  });

  // === PascalCase Linkification (Pass 2) ===

  test('PascalCase symbol → @symbol link', () => {
    const html = linkify('<p>Uses ConfigDataPrivate for requests</p>');
    assertContains(html, 'href="@symbol:ConfigDataPrivate"');
  });

  test('PascalCase with numbers → @symbol link', () => {
    const html = linkify('<p>See N2ResModifyUpdateHandlerBase</p>');
    assertContains(html, 'href="@symbol:N2ResModifyUpdateHandlerBase"');
  });

  test('common English words (The, This, etc.) → NOT linkified', () => {
    const html = linkify('<p>The quick brown fox</p>');
    assertNotContains(html, 'href="@symbol:The"');
  });

  test('tech terms (WebSocket, Docker) → NOT linkified', () => {
    const html = linkify('<p>Uses WebSocket and Docker</p>');
    assertNotContains(html, 'href="@symbol:WebSocket"');
    assertNotContains(html, 'href="@symbol:Docker"');
  });

  test('PascalCase inside <a> tag → NOT double-linkified', () => {
    const html = linkify('<a href="@symbol:FooBar" class="symbol-link">FooBar</a>');
    assertContains(html, 'href="@symbol:FooBar"');
    assertNotContains(html, 'href="@symbol:FooBar" class="symbol-link"><a');
  });

  test('single capitalized word (Macro, Pattern) → NOT linkified', () => {
    const html = linkify('<p>Macro Pattern</p>');
    assertNotContains(html, 'href="@symbol:Macro"');
    assertNotContains(html, 'href="@symbol:Pattern"');
  });

  test('X-Macro in prose → NOT linkified', () => {
    const html = linkify('<p>X-Macro Pattern</p>');
    assertNotContains(html, 'href="@symbol:X');
    assertNotContains(html, 'href="@symbol:Macro"');
  });

  // === Typedef Linkification (Pass 2a) ===

  test('_t typedef → @symbol link', () => {
    const html = linkify('<p>Uses my_struct_t</p>');
    assertContains(html, 'href="@symbol:my_struct_t"');
  });

  test('uint32_t → @symbol link', () => {
    const html = linkify('<p>Uses uint32_t</p>');
    assertContains(html, 'href="@symbol:uint32_t"');
  });

  // === Code Span Linkification (Pass 2b) ===

  test('<code>snake_case()</code> → @symbol link', () => {
    const html = linkify('<code>my_function()</code>');
    assertContains(html, 'href="@symbol:my_function"');
    assertContains(html, '<code>my_function()</code>');
  });

  test('<code>PascalCase</code> → @symbol link', () => {
    const html = linkify('<code>FooBar</code>');
    assertContains(html, 'href="@symbol:FooBar"');
  });

  test('<code>Type::method()</code> → @symbol link', () => {
    const html = linkify('<code>MyClass::init()</code>');
    assertContains(html, 'href="@symbol:MyClass::init"');
  });

  test('<code>single_word</code> without underscore → NOT linkified', () => {
    const html = linkify('<code>hello</code>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>Tagged</code> single capitalized → NOT linkified', () => {
    const html = linkify('<code>Tagged</code>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>Union</code> single capitalized → NOT linkified', () => {
    const html = linkify('<code>Union</code>');
    assertNotContains(html, 'href="@symbol');
  });

  // === Tool Name Exclusion (Pass 2b) ===

  test('<code>apply_patch</code> → NOT linkified (Codex tool)', () => {
    const html = linkify('<code>apply_patch</code>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>exec_command</code> → NOT linkified (Codex tool)', () => {
    const html = linkify('<code>exec_command</code>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>update_plan</code> → NOT linkified (Codex tool)', () => {
    const html = linkify('<code>update_plan</code>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>view_image</code> → NOT linkified (Codex tool)', () => {
    const html = linkify('<code>view_image</code>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>write_stdin</code> → NOT linkified (Codex tool)', () => {
    const html = linkify('<code>write_stdin</code>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>create_goal</code> → NOT linkified (Codex tool)', () => {
    const html = linkify('<code>create_goal</code>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>request_user_input</code> → NOT linkified (Codex tool)', () => {
    const html = linkify('<code>request_user_input</code>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>shell_command</code> → NOT linkified (Codex tool)', () => {
    const html = linkify('<code>shell_command</code>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>fs_read</code> → NOT linkified (Kiro tool)', () => {
    const html = linkify('<code>fs_read</code>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>fs_write</code> → NOT linkified (Kiro tool)', () => {
    const html = linkify('<code>fs_write</code>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>execute_bash</code> → NOT linkified (Kiro tool)', () => {
    const html = linkify('<code>execute_bash</code>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>use_aws</code> → NOT linkified (Kiro tool)', () => {
    const html = linkify('<code>use_aws</code>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>apply_patch()</code> with parens → NOT linkified', () => {
    const html = linkify('<code>apply_patch()</code>');
    assertNotContains(html, 'href="@symbol');
  });

  // === C++ stdlib exclusion ===

  test('<code>std::variant</code> → NOT linkified (C++ stdlib)', () => {
    const html = linkify('<code>std::variant</code>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>std::string</code> → NOT linkified (C++ stdlib)', () => {
    const html = linkify('<code>std::string</code>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>std::vector</code> → NOT linkified (C++ stdlib)', () => {
    const html = linkify('<code>std::vector</code>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>std::map</code> → NOT linkified (C++ stdlib)', () => {
    const html = linkify('<code>std::map</code>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>std::shared_ptr</code> → NOT linkified (C++ stdlib)', () => {
    const html = linkify('<code>std::shared_ptr</code>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>std::unique_ptr</code> → NOT linkified (C++ stdlib)', () => {
    const html = linkify('<code>std::unique_ptr</code>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>std::optional</code> → NOT linkified (C++ stdlib)', () => {
    const html = linkify('<code>std::optional</code>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>std::function</code> → NOT linkified (C++ stdlib)', () => {
    const html = linkify('<code>std::function</code>');
    assertNotContains(html, 'href="@symbol');
  });

  // === Pass 3: symbol (file:line) ===

  test('symbol (file:line) pattern → @symbol link', () => {
    // Pass 1 linkifies the file path inside parens first, so Pass 3
    // never sees the original "symbol (file:line)" pattern.
    // The file path inside parens gets linkified, and the symbol name
    // stays as plain text.
    const html = linkify('<p>cl_create_http_server (cl_main.c:170)</p>');
    assertContains(html, 'class="file-link"');
    assertContains(html, 'data-file="cl_main.c"');
  });

  test('symbol (file) pattern → file-link', () => {
    const html = linkify('<p>my_func (main.c)</p>');
    assertContains(html, 'class="file-link bare-file-link"');
    assertContains(html, 'data-file="main.c"');
  });

  test('tool name (file:line) → NOT linkified', () => {
    // Pass 1 still linkifies the file path, but the tool name is not
    // converted to a @symbol link.
    const html = linkify('<p>apply_patch (main.c:42)</p>');
    assertNotContains(html, 'href="@symbol');
  });

  // === Edge Cases ===

  test('ModernCppFeatures.md not linkified as PascalCase', () => {
    const html = linkify('<p>See ModernCppFeatures.md</p>');
    assertNotContains(html, 'href="@symbol:ModernCppFeatures"');
    // Should be linkified as a file path instead
    assertContains(html, 'class="file-link bare-file-link"');
  });

  test('[ModernCppFeatures](docs/ModernCppFeatures.md) → kept as file link, not @symbol', () => {
    const html = linkify('<a href="docs/ModernCppFeatures.md">ModernCppFeatures</a>');
    assertNotContains(html, 'href="@symbol:ModernCppFeatures"');
    assertNotContains(html, 'class="nolink"');
    // Should remain a clickable <a> tag pointing to the file
    assertContains(html, 'href="docs/ModernCppFeatures.md"');
  });

  test('[Handler](include/Handler.h) → kept as file link, not @symbol', () => {
    const html = linkify('<a href="include/Handler.h">Handler</a>');
    assertNotContains(html, 'href="@symbol:Handler"');
    assertContains(html, 'href="include/Handler.h"');
  });

  test('[main](src/main.c) → kept as file link, not @symbol', () => {
    const html = linkify('<a href="src/main.c">main</a>');
    assertNotContains(html, 'href="@symbol:main"');
    assertContains(html, 'href="src/main.c"');
  });

  test('[flags](tools/build/flags.cmake) → kept as file link, not @symbol', () => {
    const html = linkify('<a href="tools/build/flags.cmake">flags</a>');
    assertNotContains(html, 'href="@symbol:flags"');
    assertContains(html, 'href="tools/build/flags.cmake"');
  });

  test('[CMakeLists](CMakeLists.txt) → kept as file link, not @symbol', () => {
    const html = linkify('<a href="CMakeLists.txt">CMakeLists</a>');
    assertNotContains(html, 'href="@symbol:CMakeLists"');
    assertContains(html, 'href="CMakeLists.txt"');
  });

  test('std::variant not linkified as symbol', () => {
    const html = linkify('<p>std::variant as Tagged Union</p>');
    // 'variant' is preceded by '::' which blocks the typedef regex
    // 'Tagged' and 'Union' are single capitalized words, not PascalCase
    assertNotContains(html, 'href="@symbol:variant"');
    assertNotContains(html, 'href="@symbol:Tagged"');
    assertNotContains(html, 'href="@symbol:Union"');
  });

  test('multiple file paths in one paragraph', () => {
    const html = linkify('<p>See src/main.rs:10 and src/utils.rs:20</p>');
    assertContains(html, 'data-file="src/main.rs"');
    assertContains(html, 'data-file="src/utils.rs"');
    assertContains(html, 'data-line="10"');
    assertContains(html, 'data-line="20"');
  });

  test('file path at end of string', () => {
    const html = linkify('<p>See Handler.h</p>');
    assertContains(html, 'class="file-link bare-file-link"');
    assertContains(html, 'data-file="Handler.h"');
  });

  test('already linkified content not double-processed', () => {
    const html = linkify('<a href="@symbol:FooBar" class="symbol-link">FooBar</a>');
    // Should still have exactly one link
    const linkCount = (html.match(/href="@symbol:FooBar"/g) || []).length;
    assert.strictEqual(linkCount, 1);
  });

  // === File path linkification (codeExt trailing semicolon bug) ===

  test('docs/ModernCppFeatures.md → clickable file link (not symbol)', () => {
    const html = linkify('<p>See docs/ModernCppFeatures.md for details</p>');
    assertContains(html, 'class="file-link bare-file-link"');
    assertContains(html, 'data-file="docs/ModernCppFeatures.md"');
    assertNotContains(html, 'href="@symbol');
  });

  test('docs/ModernCppFeatures.md in markdown link → file link', () => {
    const html = linkify('<a href="docs/ModernCppFeatures.md">docs/ModernCppFeatures.md</a>');
    assertContains(html, 'href="docs/ModernCppFeatures.md"');
    assertNotContains(html, 'class="nolink"');
    assertNotContains(html, 'href="@symbol');
  });

  test('tools/build/cmake/ControlPlaneCommonCompileFlags.cmake → clickable', () => {
    const html = linkify('<p>Set in tools/build/cmake/ControlPlaneCommonCompileFlags.cmake</p>');
    assertContains(html, 'class="file-link bare-file-link"');
    assertContains(html, 'data-file="tools/build/cmake/ControlPlaneCommonCompileFlags.cmake"');
  });

  test('up/common/cmake/base.cmake → clickable', () => {
    const html = linkify('<p>Set in up/common/cmake/base.cmake</p>');
    assertContains(html, 'class="file-link bare-file-link"');
    assertContains(html, 'data-file="up/common/cmake/base.cmake"');
  });

  test('Traits.h in prose → clickable file link', () => {
    const html = linkify('<p>See Traits.h for details</p>');
    assertContains(html, 'class="file-link bare-file-link"');
    assertContains(html, 'data-file="Traits.h"');
    assertNotContains(html, 'href="@symbol');
  });

  test('Serializer.h in prose → clickable file link', () => {
    const html = linkify('<p>See Serializer.h for details</p>');
    assertContains(html, 'class="file-link bare-file-link"');
    assertContains(html, 'data-file="Serializer.h"');
    assertNotContains(html, 'href="@symbol');
  });

  // === C++ cast keywords not linkified ===

  test('<code>reinterpret_cast</code> → NOT linkified (C++ keyword)', () => {
    const html = linkify('<p>Type-safe <code>reinterpret_cast</code> replacement</p>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>static_cast</code> → NOT linkified (C++ keyword)', () => {
    const html = linkify('<p>Use <code>static_cast</code> for conversions</p>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>dynamic_cast</code> → NOT linkified (C++ keyword)', () => {
    const html = linkify('<p>Use <code>dynamic_cast</code> for polymorphism</p>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>const_cast</code> → NOT linkified (C++ keyword)', () => {
    const html = linkify('<p>Use <code>const_cast</code> to add const</p>');
    assertNotContains(html, 'href="@symbol');
  });

  // === C++ keywords not linkified ===

  test('<code>consteval</code> → NOT linkified (C++ keyword)', () => {
    const html = linkify('<p><code>consteval</code> functions</p>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>constinit</code> → NOT linkified (C++ keyword)', () => {
    const html = linkify('<p><code>constinit</code> guarantees</p>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>constexpr</code> → NOT linkified (C++ keyword)', () => {
    const html = linkify('<p><code>constexpr</code> is used</p>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>decltype</code> → NOT linkified (C++ keyword)', () => {
    const html = linkify('<p><code>decltype</code> derivation</p>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>co_await</code> → NOT linkified (C++ keyword)', () => {
    const html = linkify('<p><code>co_await</code> expression</p>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>co_return</code> → NOT linkified (C++ keyword)', () => {
    const html = linkify('<p><code>co_return</code> statement</p>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>co_yield</code> → NOT linkified (C++ keyword)', () => {
    const html = linkify('<p><code>co_yield</code> expression</p>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>noexcept</code> → NOT linkified (C++ keyword)', () => {
    const html = linkify('<p><code>noexcept</code> specifier</p>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>override</code> → NOT linkified (C++ keyword)', () => {
    const html = linkify('<p><code>override</code> specifier</p>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>explicit</code> → NOT linkified (C++ keyword)', () => {
    const html = linkify('<p><code>explicit</code> constructor</p>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>final</code> → NOT linkified (C++ keyword)', () => {
    const html = linkify('<p><code>final</code> class</p>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>requires</code> → NOT linkified (C++ keyword)', () => {
    const html = linkify('<p><code>requires</code> clause</p>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>concept</code> → NOT linkified (C++ keyword)', () => {
    const html = linkify('<p><code>concept</code> definition</p>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>typename</code> → NOT linkified (C++ keyword)', () => {
    const html = linkify('<p><code>typename</code> parameter</p>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>template</code> → NOT linkified (C++ keyword)', () => {
    const html = linkify('<p><code>template</code> declaration</p>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>namespace</code> → NOT linkified (C++ keyword)', () => {
    const html = linkify('<p><code>namespace</code> declaration</p>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>operator</code> → NOT linkified (C++ keyword)', () => {
    const html = linkify('<p><code>operator</code> overload</p>');
    assertNotContains(html, 'href="@symbol');
  });

  // === C++ stdlib in code spans not linkified ===

  test('<code>std::move_only_function</code> → NOT linkified', () => {
    const html = linkify('<p>Uses <code>std::move_only_function</code></p>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>std::expected</code> → NOT linkified', () => {
    const html = linkify('<p>Uses <code>std::expected</code></p>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>std::ranges::to</code> → NOT linkified', () => {
    const html = linkify('<p>Uses <code>std::ranges::to</code></p>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>std::bit_cast</code> → NOT linkified', () => {
    const html = linkify('<p>Uses <code>std::bit_cast</code></p>');
    assertNotContains(html, 'href="@symbol');
  });

  // === C++ keywords in markdown links not linkified ===

  test('[reinterpret_cast](file.h) → NOT @symbol link (keyword)', () => {
    const html = linkify('<a href="some_file.h">reinterpret_cast</a>');
    assertNotContains(html, 'href="@symbol');
    assertContains(html, 'class="nolink"');
  });

  test('[static_cast](file.h) → NOT @symbol link (keyword)', () => {
    const html = linkify('<a href="some_file.h">static_cast</a>');
    assertNotContains(html, 'href="@symbol');
    assertContains(html, 'class="nolink"');
  });

  test('[consteval](file.h) → NOT @symbol link (keyword)', () => {
    const html = linkify('<a href="some_file.h">consteval</a>');
    assertNotContains(html, 'href="@symbol');
    assertContains(html, 'class="nolink"');
  });

  test('[co_await](file.h) → NOT @symbol link (keyword)', () => {
    const html = linkify('<a href="some_file.h">co_await</a>');
    assertNotContains(html, 'href="@symbol');
    assertContains(html, 'class="nolink"');
  });

  // === Go keywords not linkified ===

  test('<code>defer</code> → NOT linkified (Go keyword)', () => {
    const html = linkify('<p>Use <code>defer</code> for cleanup</p>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>go</code> → NOT linkified (Go keyword)', () => {
    const html = linkify('<p>Use <code>go</code> keyword</p>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>chan</code> → NOT linkified (Go keyword)', () => {
    const html = linkify('<p>Use <code>chan</code> type</p>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>select</code> → NOT linkified (Go keyword)', () => {
    const html = linkify('<p>Use <code>select</code> statement</p>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>interface</code> → NOT linkified (Go keyword)', () => {
    const html = linkify('<p>Use <code>interface</code> type</p>');
    assertNotContains(html, 'href="@symbol');
  });

  // === Rust keywords not linkified ===

  test('<code>impl</code> → NOT linkified (Rust keyword)', () => {
    const html = linkify('<p>Use <code>impl</code> block</p>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>match</code> → NOT linkified (Rust keyword)', () => {
    const html = linkify('<p>Use <code>match</code> expression</p>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>trait</code> → NOT linkified (Rust keyword)', () => {
    const html = linkify('<p>Define <code>trait</code></p>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>unsafe</code> → NOT linkified (Rust keyword)', () => {
    const html = linkify('<p>Use <code>unsafe</code> block</p>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>dyn</code> → NOT linkified (Rust keyword)', () => {
    const html = linkify('<p>Use <code>dyn</code> trait</p>');
    assertNotContains(html, 'href="@symbol');
  });

  // === TypeScript keywords not linkified ===

  test('<code>keyof</code> → NOT linkified (TS keyword)', () => {
    const html = linkify('<p>Use <code>keyof</code> operator</p>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>infer</code> → NOT linkified (TS keyword)', () => {
    const html = linkify('<p>Use <code>infer</code> keyword</p>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>satisfies</code> → NOT linkified (TS keyword)', () => {
    const html = linkify('<p>Use <code>satisfies</code> operator</p>');
    assertNotContains(html, 'href="@symbol');
  });

  // === Python keywords not linkified ===

  test('<code>lambda</code> → NOT linkified (Python keyword)', () => {
    const html = linkify('<p>Use <code>lambda</code> function</p>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>nonlocal</code> → NOT linkified (Python keyword)', () => {
    const html = linkify('<p>Use <code>nonlocal</code> declaration</p>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>assert</code> → NOT linkified (Python keyword)', () => {
    const html = linkify('<p>Use <code>assert</code> statement</p>');
    assertNotContains(html, 'href="@symbol');
  });

  // === C standard types not linkified ===

  test('<code>size_t</code> → NOT linkified (C type)', () => {
    const html = linkify('<p>Uses <code>size_t</code> type</p>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>uint32_t</code> → NOT linkified (C type)', () => {
    const html = linkify('<p>Uses <code>uint32_t</code> type</p>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>int64_t</code> → NOT linkified (C type)', () => {
    const html = linkify('<p>Uses <code>int64_t</code> type</p>');
    assertNotContains(html, 'href="@symbol');
  });

  // === Prose text not linkified ===

  test('CRTP (Curiously Recurring Template Pattern) → NOT linkified', () => {
    const html = linkify('<p>CRTP (Curiously Recurring Template Pattern)</p>');
    assertNotContains(html, 'href="@symbol');
  });

  test('Concept-Constrained Template Specialization Dispatch → NOT linkified', () => {
    const html = linkify('<p>Concept-Constrained Template Specialization Dispatch</p>');
    assertNotContains(html, 'href="@symbol');
  });

  test('X-Macro Pattern → NOT linkified', () => {
    const html = linkify('<p>X-Macro Pattern</p>');
    assertNotContains(html, 'href="@symbol');
  });

  // === ALL_CAPS identifiers not linkified ===

  test('<code>CMAKE_CONFIGURE_DEPENDS</code> → NOT linkified (CMake variable)', () => {
    const html = linkify('<p>Set <code>CMAKE_CONFIGURE_DEPENDS</code> in CMakeLists.txt</p>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>MAX_BUFFER_SIZE</code> → NOT linkified (constant)', () => {
    const html = linkify('<p>Uses <code>MAX_BUFFER_SIZE</code> constant</p>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>NDEBUG</code> → NOT linkified (macro)', () => {
    const html = linkify('<p>When <code>NDEBUG</code> is defined</p>');
    assertNotContains(html, 'href="@symbol');
  });

  test('<code>VERSION_MAJOR</code> → NOT linkified (CMake variable)', () => {
    const html = linkify('<p>Set <code>VERSION_MAJOR</code> to 1</p>');
    assertNotContains(html, 'href="@symbol');
  });
});

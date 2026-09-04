# Symbol Resolution & Clickable Links

The ACP Client renders LLM markdown output in the chat webview with clickable links
for code symbols and file paths. This document describes how symbol resolution works,
the link formats supported, and the fallback strategies used.

## Cross-Editor Compatibility

The same LLM output is rendered in **both** VS Code (via this extension) and Zed
(via `codex-acp`). Link formats must therefore be compatible with both editors.

| Format | Zed | VS Code |
|--------|-----|---------|
| `file:///abs/path?symbol=name#L123` | ✅ `MentionUri::Symbol` | ✅ `handleOpenFile` (symbol correction) |
| `file:///abs/path#L123` | ✅ `MentionUri::Selection` | ✅ `handleOpenFile` |
| `file:///abs/path` (no fragment) | ✅ `MentionUri::File` | ✅ `handleOpenFile` |
| `[text](relative/path:123)` (markdown link) | ❌ not parsed | ✅ auto-linkified |
| `@symbol:name` | ❌ not parsed | ✅ `handleOpenSymbol` (LSP) |

### ⚠️ Critical: URL Fragment Order (RFC 3986)

The `?symbol=` query param MUST come **before** the `#L` fragment:

```
CORRECT: file:///abs/path/to/file.rs?symbol=function_name#L42
WRONG:   file:///abs/path/to/file.rs#L42?symbol=function_name
```

If reversed, the `#L` fragment swallows the `?symbol=` query string — Zed sees
the entire `L42?symbol=function_name` as the fragment, fails to parse the line
number (falls back to line 1), and the symbol query param is lost entirely.

**Zed's `MentionUri::parse()`** (in `acp_thread/src/mention.rs`):
- Parses `url.fragment()` and `url.query_pairs()` separately
- `?symbol=` must be in the query string (before `#`)
- `#L{line}` must be the fragment (after `?`)

**Zed does NOT do LSP symbol resolution on link click.** It jumps to the exact
`#L` line. The `?symbol=` name is stored as metadata but never used for line
correction. Only VS Code corrects wrong line numbers.

## Link Formats

### 1. `file:///absolute/path?symbol=name#L123` — Primary (both editors)

```markdown
[main](file:///workspace/git/ezennin/codex-acp/src/main.ts?symbol=main#L10)
[CodexAcpServer](file:///workspace/git/ezennin/codex-acp/src/CodexAcpServer.ts?symbol=CodexAcpServer#L1)
```

- **Zed**: Parses as `MentionUri::Symbol` → `open_abs_path_at_point()` at exact `#L` line
- **VS Code**: Extracts `?symbol=` → `handleOpenFile()` with ±200 line text search + LSP fallback
- Use for ALL code symbols (functions, types, structs, macros)
- The `?symbol=` param is a safety net for VS Code — it corrects wrong line numbers
- **Zed has no correction** — the LLM MUST verify line numbers with `grep -n`

### 2. `file:///absolute/path#L123` — File at line (both editors)

```markdown
[CodexAcpClient.ts](file:///workspace/git/ezennin/codex-acp/src/CodexAcpClient.ts#L100)
```

- Use for file references (not specific symbols) or when symbol name is unknown
- Zed: `MentionUri::Selection` → jumps to exact line
- VS Code: `handleOpenFile()` at exact line (no symbol correction)

### 3. `@symbol:name` — VS Code fallback only

```markdown
[nats_msgbus_create](@symbol:nats_msgbus_create)
```

- Uses VS Code's LSP (clangd / rust-analyzer) to resolve the symbol to its exact
  file:line definition.
- **Zed does NOT parse this format** — Zed users see non-clickable text.
- Only use when the absolute file path cannot be determined.

## Symbol Resolution Pipeline (`handleOpenSymbol`)

When a user clicks an `@symbol:` link (VS Code only):

```
1. LSP workspace symbol search (up to 2 retries with 2s delay)
   │
   ├─ Exact name match found?
   │   ├─ Multiple exact matches? → Prefer non-SDK paths
   │   │   (/workspace/git/ over /proj/epg-sdk/)
   │   └─ Single match → use it
   │
   ├─ Type::method? → Try matching bare method name, then type name
   │
   ├─ Word-boundary containment match? → Use if only 1 match
   │
   ├─ Best match in a header (.h)?
   │   ├─ Check LSP results for a source file (.c/.cpp) with same name
   │   └─ Try VS Code definition provider for source redirect
   │
   └─ Open the file at the resolved location
```

### Ripgrep Fallback

If LSP returns **zero** results (e.g. clangd background index not ready):

```
2. Ripgrep search in workspace + parent directory (covers ../ssr)
   │
   ├─ Score candidates:
   │   +100  Definition at start of line (return_type symbol_name()
   │   +100  C typedef close: } type_name_t;
   │   +50   Definition keywords (fn, func, struct, enum, class, typedef...)
   │   +30   Symbol is first token on line
   │   +20   Source file (.c/.cpp) over header (.h)
   │   +15   Project source over SDK/install paths
   │   -10   Call site (symbol followed by ( but no preceding type)
   │
   └─ Best scoring candidate wins
```

## File Link Resolution (`handleOpenFile`)

When a user clicks a `file://` link or an auto-linkified `path:line` link:

```
1. Resolve file path
   ├─ file:// URL → parse pathname (already decoded)
   ├─ Relative path → try workspace-relative, then parent dirs (up to 4 levels)
   └─ Fallback: search by filename with workspace.findFiles()

2. Line correction (if symbol name from ?symbol= or linkText doesn't match target line)
   │
   ├─ Extract symbol name from linkText or ?symbol= query param
   │   "fen_shutdown()"          → "fen_shutdown"
   │   "FenAdapter::subscribe()" → "FenAdapter::subscribe" → "subscribe"
   │
   ├─ Step 2a: Search ±200 lines for the symbol name (text search)
   │   Score: distance (closer = better)
   │   +0   if definition-like (symbol followed by ( ; { )
   │   +100 if not definition-like
   │
   ├─ Step 2b: For Type::method links: second search for full "Type::method" pattern
   │   with -50 score bonus (prefers exact class::method over bare method name)
   │
   └─ Step 2c (NEW): LSP workspace symbol search fallback
       If ±200 text search finds nothing, uses executeWorkspaceSymbolProvider
       to find the exact definition via clangd/rust-analyzer/etc.
```

### `?symbol=` Query Param

When a `file://` URL includes a `?symbol=name` query param (Zed's
`MentionUri::Symbol` format), VS Code extracts the symbol name and uses it as
`linkText` for the line correction pipeline above. This allows the editor to
verify that the symbol actually appears on the target line, and if not, search
nearby lines (±200) or use LSP to find the correct definition.

**Zed does NOT use `?symbol=` for line correction** — it only uses the `#L`
fragment. The `?symbol=` name is stored as metadata in `MentionUri::Symbol`
but `open_link()` calls `open_abs_path_at_point()` with the exact line from
the fragment.

## Non-SDK Path Preference

When LSP returns multiple exact name matches (e.g. same symbol in both
`/workspace/git/vepg/ssr/` and `/proj/epg-sdk/`), the plugin prefers non-SDK paths:

```
Preferred:  /workspace/git/...
Skipped:    /proj/epg-sdk/, /sdk/, /install/, .cache/
```

## Mermaid Diagram Rendering

` ```mermaid ` code fences are rendered as interactive diagrams using mermaid.js:

- The mermaid library (3.4MB) is bundled in `resources/mermaid.min.js`
- Loaded via a `<script>` tag with CSP nonce
- `renderMermaidBlocks()` converts `<pre><code class="language-mermaid">` to
  `<div class="mermaid">` and calls `mermaid.run()`
- Supports flowcharts, sequence diagrams, state diagrams, etc.

## LLM Instructions (`base_instructions`)

The link format instructions sent to the LLM are defined in
agent/catalog update scripts as `BASE_INSTRUCTIONS`, and injected
into each model's `base_instructions` field in `~/.codex/model_catalog.json`.

The instructions tell the LLM to:
1. Use `file:///absolute/path?symbol=name#L123` as the **primary** link format
   - `?symbol=` MUST come before `#L` (RFC 3986)
2. **Always verify line numbers with `grep -n`** before emitting links
   - Zed jumps to exact `#L` line with no correction
   - VS Code corrects ±200 lines using `?symbol=` + LSP fallback
3. Use `@symbol:name` **only** as a VS Code-only fallback when the path is unknown
4. **Never** use relative `path:line` in markdown links (Zed can't resolve them)
5. **Never** put symbol names in backticks without a markdown link

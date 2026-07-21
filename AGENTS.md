# Repository Guidelines — vscode-acp

## Project Overview

`vscode-acp` is a VS Code extension that implements the Agent Client Protocol (ACP) for desktop chat with local agent binaries (Codex CLI, Kiro CLI, etc.). It communicates with agents via stdio./JSON-RPC and renders the conversation in a webview panel.

The same ACP agents are also consumed by Zed (via `codex-acp`). Link formats emitted by the LLM must therefore be compatible with **both** VS Code and Zed.

## Code-Reference Link Format

The LLM must emit links that work in both editors. There is one primary format.

### 1. Primary — `file:///absolute/path?symbol=name#L123` (both editors)

```markdown
[process_line](file:///workspace/git/ezennin/ericai-proxy/src/translate_response.rs?symbol=process_line#L195)
```

- **CRITICAL**: `?symbol=` MUST come BEFORE `#L` (RFC 3986). If reversed, Zed
  swallows the query into the fragment and every link jumps to line 1.
- Zed: parses as `MentionUri::Symbol`, jumps to exact `#L` line (NO correction).
- VS Code: extracts `?symbol=` for ±200 line text search + LSP workspace symbol fallback.
- **Always verify line numbers with `grep -n`** — Zed does not correct wrong lines.
- Use for ALL symbols, files, headers, types, functions, macros.
- Always include `:line` number.

### 2. `@symbol:` (VS Code only, last resort)

- `[nats_msgbus_create](@symbol:nats_msgbus_create)`
- Zed does NOT parse this. Only use when the file path cannot be determined.

**NEVER use relative `path:line` in markdown links** like `[foo](src/main.rs:42)` — Zed cannot resolve these.

## Architecture Notes

- Source lives under `src/`; the entry point is `src/extension.ts`.
- Chat rendering is done by `src/ui/ChatWebviewProvider.ts`, which:
  - runs `marked` to convert assistant markdown to HTML;
  - keeps `http(s)://` links clickable (opens external browser via `vscode.env.openExternal`);
  - keeps `file://` links clickable (parses `#L123` or `:123` suffix, opens file at line);
  - extracts `?symbol=` query param from `file://` URLs for symbol-based line correction;
  - auto-linkifies bare relative `path:line` strings into `<a class="file-link">` elements (VS Code only);
  - converts `[symbol](@symbol:...)` links into LSP workspace symbol lookups;
  - handles `openFile`, `openSymbol`, and `openExternalUrl` messages from the webview.
- VS Code jumping is implemented by `handleOpenFile()` and `handleOpenSymbol()`, using `vscode.workspace.openTextDocument` and the workspace symbol provider.
 
 ## Related Repositories
 
 This extension depends on sibling repositories on the local filesystem:
 
 | Repo | Path | Description |
 |---|---|---|
 | **codex-acp** | `~/projects/codex-acp` | ACP adapter for Codex CLI (`@agentclientprotocol/codex-acp`). The agent binary spawned by this extension. Key files: `src/CodexAcpServer.ts` (ACP server — session/cancel, prompt, turn/interrupt), `src/CodexAcpClient.ts` (Codex app-server client), `src/CodexAppServerClient.ts` (JSON-RPC transport to Codex core). |
| **codex** | `../codex` | Codex CLI core (Rust). The actual agent engine. Key crate: `codex-rs/app-server/` (app-server protocol, turn/interrupt handling in `src/request_processors/turn_processor.rs`). |
| **ericli** | `../ericli` | EricAI CLI — a Codex CLI alternative that talks to EricAI's vLLM backend. Provides the `ericli acp` command for ACP stdio. Key files: `src/acp/acp-server.ts` (ACP server — prompt/cancel/newSession), `src/core/tool-executor.ts` (tool flow + streaming LLM calls), `src/agents/agent-runtime.ts` (subagent execution + model fallback), `src/ericai/client.ts` (vLLM streaming client). Install: `bash scripts/install-acp.sh --local` → `/workspace/git/ezennin/.local/bin/ericli-acp`. |
| **ericai-proxy** | `../ericai-proxy` | Rust proxy translating OpenAI Responses API ↔ Chat Completions API for EricAI's vLLM backend (GLM-5.2, Qwen3, etc.). Used by codex-acp AND ericli. Key files: `src/translate_response.rs` (SSE translation, reasoning block lifecycle), `src/translate_request.rs` (request translation), `src/main.rs` (HTTP/WS routes). Build & install: `make install` → `/workspace/git/ezennin/.local/share/ericai-proxy/`. |

When debugging agent-side issues (cancel not working, turn not interrupting, etc.), inspect the codex-acp source first — it is the bridge between this extension's JSON-RPC notifications and the Codex core's internal `Op::Interrupt`.
 
 ### Cancel flow
 
 1. VS Code extension sends `session/cancel` notification → codex-acp
 2. codex-acp `cancel()` → `interruptSessionTurn()` → `getInterruptibleTurnId()` → `turnInterrupt()` → Codex core
 3. Codex core receives `Op::Interrupt`, emits `TurnAborted` event → codex-acp sends `turn/completed` with status `interrupted`
 4. codex-acp resolves the prompt with `stopReason: "cancelled"` → VS Code extension renders `promptEnd`
 
 **Known issue**: if `sessionState.currentTurnId` is null and no `pendingTurnStart` exists (e.g. turn hasn't started yet), `getInterruptibleTurnId()` returns null and the cancel is silently dropped. The VS Code extension has a 5s fallback timer that forces `promptEnd` if the agent doesn't acknowledge.

## Build, Test, and Package

- `npm install` — Install dependencies
- `npm run compile` — Webpack build for development
- `npm run package` — Production build into `dist/extension.js`
- `npm run lint` — ESLint over `src/`
- `npm run test` — Run VS Code extension tests
- `vsce package` — Produce `.vsix` package
- `npm run format` — Format code with Prettier (like clang-format)
- `npm run format:check` — Check formatting without writing
- `npm run deploy` — All-in-one: format → typecheck → test → lint → build → package → deploy
- `npm run deploy:fast` — Same but skip tests and lint

## Deploy to Local VS Code

This extension runs on a local desktop VS Code installation. Deployment is done by packaging a VSIX and extracting it into `~/.vscode/extensions/`.

### One-command build + deploy

The all-in-one deploy script runs: Prettier format → TypeScript typecheck → Mocha tests → ESLint → Webpack build → VSIX package → install to `~/.vscode/extensions/`.

```bash
npm run deploy

# Skip tests and lint for quick iteration
npm run deploy:fast

# Or run directly:
bash scripts/deploy-all.sh
```

Flags: `--skip-tests`, `--skip-lint`, `--skip-format`

### Build + install (no checks)

```bash
npm run package && npx vsce package && ./scripts/install-vscode-server.sh
```

Then reload VS Code: `⌘⇧P` (Mac) / `Ctrl+Shift+P` (Win/Linux) → `Reload Window`.

### What the install script does

`scripts/install-vscode-server.sh` reads `publisher`, `name`, and `version` from `package.json`, locates the built `*.vsix`, removes the old extension directory at `~/.vscode/extensions/<publisher>.<name>-<version>/`, and extracts the new VSIX contents there.

## Deploy to VS Code Server (`~/.vscode-server`)

For remote sessions (VS Code Remote SSH, code-server, vscode.dev), extensions install into `~/.vscode-server/extensions/` instead of `~/.vscode/extensions/`. Package the VSIX, then extract it there:

```bash
npm run package && npx vsce package && bash scripts/install-vscode-server-remote.sh
```

Or use the npm target (equivalent):

```bash
npm run package && npx vsce package && npm run install:server
```

Then reload the remote VS Code window: `⌘⇧P` (Mac) / `Ctrl+Shift+P` (Win/Linux) → `Reload Window`.

`scripts/install-vscode-server-remote.sh` reads `publisher`, `name`, and `version` from `package.json`, locates the built `*.vsix`, removes the old extension directory at `~/.vscode-server/extensions/<publisher>.<name>-<version>/`, and extracts the new VSIX contents there.

### Install targets at a glance

| Target | npm script | Install location | Use when |
|---|---|---|---|
| Mac desktop | `npm run install:local` | `~/.vscode/extensions/` + `~/.cursor/extensions/` | Local VS Code / Cursor |
| Remote (all) | `ACP_SSH_HOST=workstation npm run install:server` | remote `~/.vscode-server/extensions/`, `~/.vscode/extensions/`, `~/.cursor/extensions/` | Remote SSH + local editors on that host |

`npm run deploy` installs Mac local **and** remote (`ACP_SSH_HOST`, default `workstation`). Skip remote with `--skip-remote`.

Both require a packaged VSIX first (`npm run package && npx vsce package`, or `npm run deploy`).

## Checking Logs

VS Code writes extension output channels to disk under `~/Library/Application Support/Code/logs/<timestamp>/exthost<N>/output_logging_<timestamp>/`. This extension logs to two channels:

| Channel | File pattern | Contents |
|---|---|---|
| **ACP Client** | `N-ACP Client.log` | Extension lifecycle, session management, terminal context, symbol lookups, errors |
| **ACP Traffic** | `N-ACP Traffic.log` | All JSON-RPC frames sent/received to/from the agent (request/response/notification), stderr lines |

### Finding the latest logs

```bash
# Find the most recent log directory
ls -lt ~/Library/Application Support/Code/logs/ | head -3

# List ACP log files in the latest session
find ~/Library/Application Support/Code/logs/ -name "*ACP*" -type f | sort | tail -5

# Tail the latest ACP Client log
tail -50 $(find ~/Library/Application Support/Code/logs/ -name "*ACP Client.log" -type f | sort | tail -1)

# Tail the latest ACP Traffic log
tail -100 $(find ~/Library/Application Support/Code/logs/ -name "*ACP Traffic.log" -type f | sort | tail -1)
```

### Useful grep patterns for debugging

```bash
LOGDIR=$(dirname $(find ~/Library/Application Support/Code/logs/ -name "*ACP Client.log" -type f | sort | tail -1))

# Session lifecycle (create/delete/load/resume)
grep -n "sendPrompt\|deleteSession\|loadSession\|resumeSession\|clearActiveSession" "$LOGDIR/1-ACP Client.log"

# Terminal context capture (@terminal)
grep -n "TerminalContext" "$LOGDIR/1-ACP Client.log"

# Agent connection / spawn
grep -n "Spawning\|ConnectionManager\|initialized\|exited" "$LOGDIR/1-ACP Client.log"

# JSON-RPC traffic for a specific session/prompt
grep -n "session/prompt\|session/update\|session/load" "$LOGDIR/2-ACP Traffic.log"
```

### Traffic log rotation

The traffic log is an in-memory `OutputChannel` that auto-rotates after `acp.logTrafficMaxEntries` entries (default 1000). To keep more history, increase this in settings:

```json
"acp.logTrafficMaxEntries": 5000
```

To export a structured JSON dump of the traffic ring buffer (last 2000 entries), use the `acp.exportTraffic` command from the Command Palette.

## Coding Style

- TypeScript 5.x with strict settings.
- 2-space indentation, single quotes, semicolons.
- Prefer explicit return types on public methods.
- Keep webview HTML/JS bundled inside `ChatWebviewProvider`; avoid separate `.html` files.

## Webview Template Literal Escapes

The webview HTML is a **template literal** (backtick string) in `ChatWebviewProvider.ts`. Inside a template literal, escape sequences like `\n`, `\t`, `\d`, `\w` are **processed by the template literal**, not passed through verbatim. This means:

- `\n` (single backslash + n) → produces an **actual newline character** → breaks string literals, regexes, and code.
- `\\n` (double backslash + n) → produces the literal text `\n` → correct for JS string escapes and regexes.

**Rule**: Inside the webview template literal (the `/*html*/` template literal block), ALWAYS use `\\n`, `\\t`, `\\d`, `\\w`, etc. (double backslash) — never single backslash. Single-backslash escapes silently corrupt the output HTML/JS, causing `SyntaxError: Invalid or unexpected token` that crashes the entire webview. When adding new JS code to the webview `<script>` section, audit every `\` character — if it is inside a string or regex, it must be doubled.

## Code Link Compatibility

Because the same LLM output is rendered in Zed and VS Code, do **not** introduce features that depend on `@symbol:` links being the only clickable form. Any new link handler should at minimum preserve `file:///absolute/path#L...` behavior, and accept `@symbol:` only as a VS Code-specific fallback.

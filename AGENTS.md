# Repository Guidelines — vscode-acp

## Project Overview

`vscode-acp` is a VS Code extension that implements the Agent Client Protocol (ACP) for desktop chat with local agent binaries (Codex CLI, Kiro CLI, EricCLI, etc.). It communicates with agents via stdio JSON-RPC and renders the conversation in a webview panel.

The same ACP agents are also consumed by Zed (via `codex-acp`). Link formats emitted by the LLM must therefore be compatible with **both** VS Code and Zed.

## Branch Strategy

- **`local/dev`** — Main development branch. Non-A2A bug fixes, UI improvements, and feature work. Backed by `origin/local/dev` (GitHub: kemuer/vscode-acp). Rebases onto `origin/local/dev` to pick up collaborator commits.
- **`feat-local-a2a-agents`** — Feature branch for local A2A (Agent-to-Agent) agent spawning. All A2A-related work (spawning, delegation, session tree integration, lifecycle management) lives here. Non-A2A fixes are cherry-picked to `local/dev`.
- **Do NOT push to remote** unless explicitly asked. All work stays local.
- `dist/extension.js` is in `.gitignore` and untracked — never commit build artifacts.

## Key Source Files

| File | Responsibility |
|---|---|
| `src/extension.ts` | Entry point. Registers commands (`acp.connectAgent`, `acp.openSession`, `acp.newConversation`, `acp.openLocalAgentSession`). Wires SessionManager, ChatWebviewProvider, SessionTreeProvider. |
| `src/ui/ChatWebviewProvider.ts` | Core webview (~13k lines). Renders chat, tool calls, thoughts, plans, message queue, session/load replay, compaction, mode/model pickers. All webview HTML/JS is inline as a template literal. |
| `src/ui/SessionTreeProvider.ts` | Session tree view. Shows agent sessions, A2A agent children, rename/delete/resume actions. |
| `src/core/SessionManager.ts` | Session lifecycle: `connectToAgent`, `loadSession` (full history replay), `resumeSession` (light path, no replay), `deleteSession`. Manages active session, in-flight prompts, config options. |
| `src/core/LocalAgentManager.ts` | A2A agent spawning/management (feature branch only). Spawns local ACP sessions for A2A agents, persists agent metadata, restores agents on session resume, handles dead agent respawning. |
| `src/core/ConnectionManager.ts` | JSON-RPC connection to agent processes. Initialize, loadSession, prompt, cancel. |
| `src/core/SessionHistoryStore.ts` | Persists session metadata (title, agent, timestamps) to workspace state. |
| `src/handlers/SessionUpdateHandler.ts` | Routes `session/update` notifications to listeners (ChatWebviewProvider). |
| `src/handlers/PermissionHandler.ts` | ACP permission requests (file edits, command execution). Auto-approve rules, "Always allow" persistence. |
| `src/handlers/TerminalContextProvider.ts` | Captures terminal output for `@terminal` context injection. |
| `src/handlers/ElicitationHandler.ts` | ACP elicitation forms (auth, user input). |

## A2A Local Agents (feat-local-a2a-agents branch)

The extension supports spawning local A2A agents — additional ACP sessions that run as subprocesses and can be delegated tasks by the main agent. Key concepts:

- **Spawning**: `/a2a register local <name>` creates a new ACP session in the IDE. The spawned agent appears as a child of the main session in the session tree.
- **Delegation**: The main agent uses `delegate_to_a2a` and `a2a_task_status` tools to send tasks and poll results. Tasks are async — the main agent can continue other work while A2A agents process.
- **Lifecycle**: A2A agents are scoped to their parent session. Switching sessions does not kill them (they run in their own subprocess). Deleting the parent session terminates all its A2A agents. Dead agents can be respawned from the tree.
- **Persistence**: A2A agent metadata is persisted to `~/.config/cli-4-ericai/a2a-agents.json` so they survive VS Code restarts. On resume, agents are restored and reconnected.
- **UI**: A2A agents show a colored status bubble (green=working, red=dead) in the session tree. Clicking an A2A agent loads its session history in the chat view.



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
 | **codex-acp** | `/workspace/git/ezennin/codex-acp` | ACP adapter for Codex CLI (`@agentclientprotocol/codex-acp`). The agent binary spawned by this extension. Key files: `src/CodexAcpServer.ts` (ACP server — session/cancel, prompt, turn/interrupt), `src/CodexAcpClient.ts` (Codex app-server client), `src/CodexAppServerClient.ts` (JSON-RPC transport to Codex core). |
| **codex** | `/workspace/git/ezennin/codex` | Codex CLI core (Rust). The actual agent engine. Key crate: `codex-rs/app-server/` (app-server protocol, turn/interrupt handling in `src/request_processors/turn_processor.rs`). |
| **ericli** | `/workspace/git/ezennin/ericli` | EricAI CLI — a Codex CLI alternative that talks to EricAI's vLLM backend. Provides the `ericli acp` command for ACP stdio. Key files: `src/acp/acp-server.ts` (ACP server — prompt/cancel/newSession/loadSession), `src/core/tool-executor.ts` (tool flow + streaming LLM calls + hook execution), `src/core/hook-manager.ts` (Codex-compatible PreToolUse hooks via hooks.json), `src/agents/agent-runtime.ts` (subagent execution + model fallback), `src/ericai/client.ts` (vLLM streaming client). Install: `bash scripts/install-acp.sh --local` → `/workspace/git/ezennin/.local/bin/ericli-acp`. Branch: `feat-local-a2a-agents`. |
| **ericai-proxy** | `/workspace/git/ezennin/ericai-proxy` | Rust proxy translating OpenAI Responses API ↔ Chat Completions API for EricAI's vLLM backend (GLM-5.2, Qwen3, DeepSeek, etc.). Used by codex-acp AND ericli. Key files: `src/translate_response.rs` (SSE translation, reasoning block lifecycle), `src/translate_request.rs` (request translation), `src/main.rs` (HTTP/WS routes). Build & install: `make install` → `/workspace/git/ezennin/.local/share/ericai-proxy/`. Runtime config: `~/.cli-proxy-api/config.yaml`. |

When debugging agent-side issues (cancel not working, turn not interrupting, etc.), inspect the codex-acp source first — it is the bridge between this extension's JSON-RPC notifications and the Codex core's internal `Op::Interrupt`.
 
 ### Cancel flow
 
 1. VS Code extension sends `session/cancel` notification → codex-acp
 2. codex-acp `cancel()` → `interruptSessionTurn()` → `getInterruptibleTurnId()` → `turnInterrupt()` → Codex core
 3. Codex core receives `Op::Interrupt`, emits `TurnAborted` event → codex-acp sends `turn/completed` with status `interrupted`
 4. codex-acp resolves the prompt with `stopReason: "cancelled"` → VS Code extension renders `promptEnd`
 
 **Known issue**: if `sessionState.currentTurnId` is null and no `pendingTurnStart` exists (e.g. turn hasn't started yet), `getInterruptibleTurnId()` returns null and the cancel is silently dropped. The VS Code extension has a 5s fallback timer that forces `promptEnd` if the agent doesn't acknowledge. **Fixed**: the stop button no longer kills the agent process on cancel timeout — it only terminates the streaming response and lets the user input a new prompt for steering.

## Build, Test, and Package

- `npm install` — Install dependencies
- `npm run compile` — Webpack build for development
- `npm run package` — Production build into `dist/extension.js`
- `npm run lint` — ESLint over `src/`
- `npm run test` — Run VS Code extension tests
- `vsce package` — Produce `.vsix` package
- `npm run format` — Format code with Prettier (like clang-format)
- `npm run format:check` — Check formatting without writing
- `npm run deploy` — All-in-one: build → package → install to `~/.vscode-server/extensions/` (lean: no typecheck/test/lint gates — the webpack build type-checks via ts-loader)

## Deploy to Local VS Code

This extension runs on the VS Code extension host (desktop, Remote SSH, or vscode-server). Deployment is done by packaging a VSIX and extracting it into `~/.vscode-server/extensions/`.

### One-command build + deploy

The all-in-one deploy script runs: Webpack build (which type-checks via ts-loader) → VSIX package → install to `~/.vscode-server/extensions/`. It deliberately skips the separate typecheck/test/lint gates for a fast hot-deploy loop — run `npm run test:unit` / `npm run lint` yourself when you want them. There is no remote-SSH deploy step — this extension is driven from the VS Code Remote / vscode-server extension host, so the VSIX is only installed into the local `~/.vscode-server/extensions`.

```bash
npm run deploy

# Same lean deploy (no gates to skip — deploy is already fast)
npm run deploy:fast

# Or run directly:
bash scripts/deploy-all.sh
```

The deploy script takes no flags — it always builds, packages, and installs to `~/.vscode-server/extensions/`.

### Build + install (no checks)

```bash
npm run package && npx vsce package && ./scripts/install-vscode-server.sh
```

Then reload VS Code: `⌘⇧P` (Mac) / `Ctrl+Shift+P` (Win/Linux) → `Reload Window`.

### What the install script does

`scripts/install-vscode-server.sh` reads `publisher`, `name`, and `version` from `package.json`, locates the built `*.vsix`, removes the old extension directory at `~/.vscode-server/extensions/<publisher>.<name>-<version>/`, and extracts the new VSIX contents there. It installs **only** into `~/.vscode-server/extensions` (override the target list with `ACP_INSTALL_TARGETS` for desktop VS Code / Cursor).

## Install target at a glance

| Target | Command | Install location | Use when |
|---|---|---|---|
| vscode-server (default) | `npm run install:local` / `npm run deploy` | `~/.vscode-server/extensions/` | VS Code Remote SSH / code-server / vscode.dev |
| Override | `ACP_INSTALL_TARGETS="/path/to/ext /other" npm run install:local` | any dirs you specify | desktop VS Code / Cursor |

`npm run deploy` installs **only** into local `~/.vscode-server/extensions` — there is no remote-SSH deploy. Each target requires a packaged VSIX first (`npm run package && npx vsce package`, or `npm run deploy`). After installing, reload the editor: `⌘⇧P` (Mac) / `Ctrl+Shift+P` (Win/Linux) → `Reload Window`.

## Checking Logs

VS Code writes extension output channels to disk. On remote VS Code Server, logs are under `~/.vscode-server/data/logs/<timestamp>/exthost<N>/output_logging_<timestamp>/`. On Mac desktop, under `~/Library/Application Support/Code/logs/<timestamp>/exthost<N>/output_logging_<timestamp>/`. This extension logs to two channels:

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

## EricCLI Hooks System (ericli repo)

EricCLI supports Codex-compatible PreToolUse hooks via `~/.config/cli-4-ericai/hooks.json` (falls back to `~/.codex/hooks.json`). This allows external tools like **dcg** (Destructive Command Guard) to block dangerous commands without hardcoding them into ericli's source.

- Hook config format: `{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"dcg","timeout":5}]}]}}`
- JSON-stdin protocol: ericli pipes `{"tool_name":"Bash","tool_input":{"command":"rm -rf /"}}` to the hook command's stdin
- Hook can block via non-zero exit (stderr = reason) or JSON output `{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"..."}}`
- Install dcg for ericli: `bash scripts/install-dcg-hook.sh` (in ericli repo)
- dcg binary: `/workspace/git/ezennin/.local/bin/dcg`

## EricCLI Proxy Config Paths

EricCLI reads the ericai-proxy config from these paths (in order):
1. `~/.local/share/ericai-proxy/config.yaml` (runtime, highest priority)
2. `/workspace/git/$USER/ericai-proxy/config.yaml` (repo/development)
3. `~/.cli-proxy-api/config.yaml` (older runtime location)

The runtime config may use a `*` wildcard in the models list (meaning "all models"). EricCLI falls through to the next candidate when only a wildcard is found, to get the full explicit model list.

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

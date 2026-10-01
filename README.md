# ACP Client for VS Code

A [Visual Studio Code extension](https://marketplace.visualstudio.com/items?itemName=formulahendry.acp-client) that provides a client for the [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) — connect to any ACP-compatible AI coding agent directly from your editor.

![ACP Client Screenshot](resources/screenshot.png)

## Features

- **Multi-Agent Support**: Connect to 3 pre-configured ACP agents or add your own
- **Single-Agent Focus**: One agent active at a time — seamlessly switch between agents
- **Per-Agent Session List**: Each agent in the Agents view is expandable into its previous sessions. Click a session to restore its history in the chat. Backed by `session/list` when the agent supports it, or by a local per-workspace cache otherwise.
- **Session Config Options**: Dynamic per-session selectors (mode, model, reasoning level, …) advertised by the agent are rendered automatically in the composer toolbar.
- **Interactive Chat**: Built-in chat panel with Markdown rendering, inline tool call display, and collapsible tool sections
- **Thinking Display**: See agent reasoning in a collapsible block with streaming animation and elapsed time
- **Slash Commands**: Autocomplete popup for agent-provided commands with keyboard navigation
- **Mode & Model Picker**: Switch agent modes and models directly from the chat toolbar (kept for agents that haven't migrated to Session Config Options yet)
- **File System Integration**: Agents can read and write files in your workspace
- **Terminal Execution**: Agents can run commands with terminal output display
- **Permission Management**: Configurable auto-approve policies (`ask` / `allowAll` / `remember`) with persisted command and tool approvals
- **Message Queue & Auto-Steer**: Messages typed mid-turn become queue chips; optionally steer into the running turn (`acp.autoSteerQueuedMessages`)
- **Follow Agent**: Mirror an external agent's session into the panel (`ACP: Toggle Follow Agent`)
- **Fork Session**: Fork the current conversation in-place or onto another agent
- **Shared Memory**: Optional TencentDB Agent Memory (Model B) for cross-agent recall and capture (`acp.memory.*`)
- **Protocol Traffic Logging**: Inspect all ACP JSON-RPC messages with request/response/notification labels
- **Voice Dictation**: Click the mic in the composer to dictate a prompt. Transcription runs against any OpenAI-style STT endpoint (`acp.voice.stt.endpoint`) — Whisper, a local whisper.cpp server, etc. Silence auto-stop and a Bluetooth "audio flowing" probe included; on Windows the built-in MCI recorder works with nothing to install.
- **Screen Recording → Video Vision**: Click 🖥 in the composer to record a display or window (extended screens included) as MP4. On send, the take is analyzed by a video-capable endpoint (StepFun-style `video_url`, `acp.vision.endpoint`) and the summary is injected into the prompt; with no endpoint configured, frames are extracted and attached as images for image-capable agents. See [docs/vision-models.md](docs/vision-models.md) for the provider matrix.
- **Remote SSH / WSL / Containers**: Voice and screen capture run on the **client** machine via the `acp-local-capture` companion extension (`extensionKind: ["ui"]`), so both work when the extension host is a headless remote server. See [docs/voice-remote-ssh.md](docs/voice-remote-ssh.md) and [docs/vision-remote-ssh.md](docs/vision-remote-ssh.md).
- **Agent Registry**: Browse and discover available ACP agents
- **Chat Persistence**: Conversations are preserved when switching panels
- **Attach File**: Attach a workspace file to the next prompt (`ACP: Attach File to Prompt`)

## Quick Start

1. Install: [Visual Studio Code Marketplace](https://marketplace.visualstudio.com/items?itemName=formulahendry.acp-client) | [Open in VS Code](https://vscode.dev/redirect?url=vscode%3Aextension%2Fformulahendry.acp-client) | [Open VSX Marketplace](https://open-vsx.org/extension/formulahendry/acp-client)
2. Ensure a default agent binary is on your `PATH` (`claude-code-acp`, `codex-acp`, or `cursor-agent`)
3. Open the ACP Client panel from the Activity Bar (ACP icon)
4. Click an agent to connect (or **+** to add a custom config)
5. Start chatting — use the mic for dictation or 🖥 for screen recording when configured
6. Remote window? Install `companion/acp-local-capture/*.vsix` once so mic/screen capture on the client

## Requirements

- An ACP-compatible agent binary on your `PATH` (defaults: `claude-code-acp`, `codex-acp`, `cursor-agent`), or available via `npx` for custom configs
- **Voice (optional)**: SoX (`rec`) on macOS/Linux; Windows uses built-in MCI (no install). An OpenAI-style STT endpoint (`acp.voice.stt.endpoint`)
- **Screen recording (optional)**: `ffmpeg` on the machine that captures; a video-vision endpoint (`acp.vision.endpoint`) or an image-capable agent for the frame fallback
- **Remote SSH / WSL / Containers**: install the companion VSIX (`npm run package:companion` → `companion/acp-local-capture/*.vsix`) so mic and screen capture on the client machine

## Pre-configured Agents

The extension ships with these defaults (agent binaries must be on your `PATH`):

| Agent | Command |
|-------|---------|
| Claude Code | `claude-code-acp` |
| Codex CLI | `codex-acp` |
| Cursor | `cursor-agent acp` |

Add any other ACP-compatible agent under `acp.agents` in settings, or use **ACP: Browse Agent Registry**. Examples people commonly add:

| Agent | Command |
|-------|---------|
| GitHub Copilot | `npx @github/copilot-language-server@latest --acp` |
| Gemini CLI | `npx @google/gemini-cli@latest --experimental-acp` |
| Qwen Code | `npx @qwen-code/qwen-code@latest --acp --experimental-skills` |
| Auggie CLI | `npx @augmentcode/auggie@latest --acp` |
| Qoder CLI | `npx @qoder-ai/qodercli@latest --acp` |
| OpenCode | `npx opencode-ai@latest acp` |
| OpenClaw | `npx openclaw acp` |
| [Kiro CLI](https://kiro.dev/docs/cli/acp/) | `kiro-cli acp` |
| [Hermes Agent](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp) | `hermes acp` |

> **Note on Hermes Agent**: Hermes is a Python package, not an npm package. Install it via the [Hermes Quickstart](https://hermes-agent.nousresearch.com/docs/getting-started/quickstart) (Linux/macOS/WSL2 only — Windows requires [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install)). Make sure `hermes` is on your `PATH` and launch VS Code from the same shell/venv. Configure credentials with `hermes model`.

## Extension Settings

Core settings (voice / vision subsections below; the Settings UI lists every key):

| Setting | Default | Description |
|---------|---------|-------------|
| `acp.agents` | *(3 agents)* | Agent configurations. Each key is the agent name, value has `command`, `args`, and `env`. |
| `acp.autoApprovePermissions` | `remember` | How permission requests are handled: `ask`, `allowAll`, or `remember` (persist prior approvals). |
| `acp.approvedCommands` | `[]` | Commands auto-approved in `remember` mode. |
| `acp.approvedTools` | `[]` | Non-command tool fingerprints approved via allow-always / remember. |
| `acp.deniedCommands` | `[]` | Command prefixes always denied (merged with a built-in denylist). |
| `acp.defaultWorkingDirectory` | `""` | Default working directory for agent sessions. Empty uses current workspace. |
| `acp.autoSteerQueuedMessages` | `true` | Deliver a mid-turn typed message into the running turn instead of waiting for it to end. |
| `acp.compaction.hookWatcher` | `true` | Watch the Cursor preCompact hook log and reset memory capture across compaction. |
| `acp.logTraffic` | `true` | Log all ACP protocol traffic to the ACP Traffic output channel. |
| `acp.logTrafficMaxEntries` | `1000` | Maximum entries kept in the ACP Traffic output channel before it is cleared. |
| `acp.debug` | `false` | Master debug switch (verbose fork / resume / queue diagnostics). |

### Shared memory (`acp.memory.*`)

Optional TencentDB Agent Memory (Model B). When enabled, prompts can recall L1 memories (and optionally L3 persona) and completed turns are captured as L0.

| Setting | Default | Description |
|---------|---------|-------------|
| `acp.memory.enabled` | `true` | Master switch for shared memory recall/capture. |
| `acp.memory.endpoint` | *(gateway URL)* | MemoryCore Gateway base URL. |
| `acp.memory.apiKey` | `""` | Gateway API key. |
| `acp.memory.serviceId` | `default` | Memory space id shared by all ACP agents. |
| `acp.memory.recallMaxResults` | `5` | Max L1 memories injected per prompt. |
| `acp.memory.includePersona` | `true` | Include L3 persona on recall. |
| `acp.memory.captureEnabled` | `true` | Write L0 turns after each prompt completes. |

### Session summary (`acp.sessionSummary.*`)

Used by `/session` look-ups — summarises another session via a responses-compatible proxy.

| Setting | Default | Description |
|---------|---------|-------------|
| `acp.sessionSummary.endpoint` | `http://127.0.0.1:8317` | Proxy base URL (`POST /v1/summarize-session`). |
| `acp.sessionSummary.model` | `qwen38-27b` | Model alias for summarization. |
| `acp.sessionSummary.timeoutMs` | `120000` | Request timeout. |

### Jev judge (`acp.jev.*`)

Optional native judgement tool: elicitation requests with `_meta.tool="jev_judge"` are answered by Jev instead of prompting the user.

| Setting | Default | Description |
|---------|---------|-------------|
| `acp.jev.enabled` | `false` | Enable the `jev_judge` tool. |
| `acp.jev.baseUrl` | `https://api.typesafe.ai` | Jev / OpenJev API base URL. |
| `acp.jev.apiKey` | `""` | API key (`TYPESAFE_API_KEY` also accepted). |
| `acp.jev.model` | `jev-latest` | Jev model id / alias. |
| `acp.jev.timeoutMs` | `5000` | Per-request timeout. |

### Voice dictation

| Setting | Default | Description |
|---------|---------|-------------|
| `acp.voice.enabled` | `true` | Master switch for the mic button. |
| `acp.voice.stt.endpoint` | `""` | OpenAI-style STT endpoint (`POST /v1/audio/transcriptions`). Empty disables dictation. |
| `acp.voice.stt.apiKey` | `""` | API key for the STT endpoint. |
| `acp.voice.stt.model` | `""` | Model name sent to the STT endpoint. |
| `acp.voice.stt.language` | `""` | Language hint passed to the STT endpoint. |
| `acp.voice.stt.prompt` | `""` | Prompt/context passed to the STT endpoint. |
| `acp.voice.stt.timeoutMs` | `60000` | STT request timeout. |
| `acp.voice.captureMode` | `auto` | `auto` uses the companion in remote windows, the extension host locally. `localCompanion` forces the companion, `extensionHost` forces local. |
| `acp.voice.recordCommand` | `""` | Override the recorder binary (resolved on the machine that captures). |
| `acp.voice.windowsRecorder` | `auto` | Windows backend: `auto` picks MCI when no recorder binary is on PATH, `mci` forces the built-in recorder, `binary` forces SoX/ffmpeg. |
| `acp.voice.maxDurationSec` | `120` | Dictation take length cap. |
| `acp.voice.silenceAutoStopSec` | `2.5` | Stop the take after this many seconds of silence (SoX backend only; 0 disables). |
| `acp.voice.silenceThresholdPct` | `3` | Silence threshold for auto-stop, percent of full scale. |
| `acp.voice.autoSend` | `false` | Send the transcribed prompt immediately instead of leaving it in the composer. |
| `acp.voice.keepTakes` | `failed` | Which WAV takes to keep on disk: `all`, `failed`, or `none`. |
| `acp.voice.corrections` | `{}` | Voice Memory corrections applied to transcripts (e.g. homophone fixes). |
| `acp.voice.corrector.enabled` | `false` | Run an LLM pass over the transcript before it lands in the composer. |
| `acp.voice.corrector.endpoint` | `http://127.0.0.1:11434/v1/chat/completions` | OpenAI-compatible endpoint for the corrector pass (defaults to a local Ollama). |
| `acp.voice.corrector.model` | `qwen2.5:7b` | Corrector model name. |
| `acp.voice.corrector.apiKey` | `""` | Corrector API key. |
| `acp.voice.corrector.timeoutMs` | `15000` | Corrector request timeout. |
| `acp.voice.memoryFile` | `""` | Path to the Voice Memory file (learned corrections). |

### Screen recording / video vision

| Setting | Default | Description |
|---------|---------|-------------|
| `acp.vision.enabled` | `true` | Master switch for the 🖥 screen-record button. |
| `acp.vision.endpoint` | `https://api.stepfun.com/v1` | OpenAI-compatible video-vision endpoint. Empty falls back to frame extraction for image-capable agents. |
| `acp.vision.apiKey` | `""` | API key for the vision endpoint. |
| `acp.vision.model` | `step-5-preview` | Video model name. |
| `acp.vision.provider` | `openai-compat` | Provider hint controlling payload shape (`openai-compat`, `stepfun`, …). |
| `acp.vision.prompt` | *(summary prompt)* | Instruction sent with the video. |
| `acp.vision.timeoutMs` | `180000` | Vision API timeout. |
| `acp.vision.inlineMaxBytes` | `15728640` | MP4s larger than this go through the provider's Files API instead of a base64 data URI. |
| `acp.vision.maxDurationSec` | `90` | Screen take length cap. |
| `acp.vision.ffmpegPath` | `""` | ffmpeg binary when it is not on PATH (resolved on the machine that captures). |
| `acp.vision.maxFrames` | `8` | Frames extracted in the no-endpoint fallback. |

## Commands

All commands are accessible via the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`):

| Command | Description |
|---------|-------------|
| `ACP: Connect to Agent` | Connect to an agent |
| `ACP: New Conversation` | Start a new conversation with the connected agent |
| `ACP: Open Session` | Open / resume a session from the Agents tree |
| `ACP: Send Prompt` | Send a message to the agent |
| `ACP: Cancel Current Turn` | Cancel the current agent turn |
| `ACP: Toggle Follow Agent` | Follow an external agent session into the panel |
| `ACP: Fork Session` | Fork the current conversation |
| `ACP: Fork to Another Agent` | Fork the conversation onto a different agent |
| `ACP: Disconnect Agent` | Disconnect from the current agent |
| `ACP: Restart Agent` | Restart the current agent process |
| `ACP: Logout Agent` | Log the agent out (when supported) |
| `ACP: Open Chat Panel` | Focus the chat webview |
| `ACP: Attach File to Prompt` | Attach a workspace file to the next prompt |
| `ACP: Add Agent Configuration` | Add a new agent to settings |
| `ACP: Remove Agent` | Remove an agent configuration |
| `ACP: Set Agent Mode` | Change the agent's operating mode |
| `ACP: Set Agent Model` | Change the agent's model |
| `ACP: Refresh Sessions` | Re-fetch the session list for an agent (also on the agent's right-click menu) |
| `ACP: Load More Sessions` | Page in older sessions |
| `ACP: Show Log` | Open the ACP Client log output channel |
| `ACP: Show Protocol Traffic` | Open the ACP Traffic output channel |
| `ACP: Export Protocol Traffic` | Export the traffic ring buffer as JSON |
| `ACP: Browse Agent Registry` | Browse the ACP agent registry |
| `ACP: Voice Input Diagnostics` | Probe mic / companion / STT configuration |
| `ACP: Retry Last Voice Take` | Re-transcribe the last kept WAV take |
| `ACP: Review Voice Memory Updates` | Review pending Voice Memory corrections |
| `ACP: Show Shared Memory Status` | Show MemoryCore connection / config status |

Tree-view context actions also include Copy Session ID, Forget Session, and Delete Session (Agent).

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+A` (`Cmd+Shift+A` on Mac) | Open Chat Panel |
| `Escape` (when turn in progress) | Cancel Current Turn |

## Development

### Prerequisites

- Node.js 18+
- VS Code 1.85+

### Setup

```bash
git clone https://github.com/formulahendry/vscode-acp.git
cd vscode-acp
npm install
```

### Build & Run

```bash
npm run compile    # One-time build
npm run watch      # Watch mode for development
```

Press `F5` in VS Code to launch the Extension Development Host.

### Testing

```bash
npm run pretest      # Compile tests + lint
npm run test:unit    # Fast mocha unit suite (no VS Code window)
npm test             # Full VS Code extension tests
```

### Packaging

```bash
npm run package              # Production build of the main extension
npx @vscode/vsce package     # Create the main .vsix
npm run package:companion    # Build companion/acp-local-capture/*.vsix (client mic + screen)
npm run deploy               # Build → package → install into local extension dirs
```

After installing either VSIX, reload the window (`Developer: Reload Window`). For Remote SSH, install the companion VSIX from the remote window — VS Code routes `extensionKind: ["ui"]` to the client machine.

## Architecture

```
┌─────────────────┐     JSON-RPC / stdio      ┌──────────────────┐
│  VS Code host   │ ◄──────────────────────► │  ACP agent       │
│  (this ext)     │                          │  (claude-code-acp│
│                 │                          │   /codex-acp/…)  │
└────────┬────────┘                          └──────────────────┘
         │
         ├─ ChatWebviewProvider  (composer, tool calls, thoughts, queue)
         ├─ SessionManager       (connect / load / resume / prompt / cancel)
         ├─ ConnectionManager    (JSON-RPC transport)
         ├─ PermissionHandler    (ask / allowAll / remember)
         ├─ voice/               (mic → STT → composer)
         ├─ vision/              (screen MP4 → video API or frames → prompt)
         └─ companion (ui-kind)  (client mic + screen over Remote SSH)
```

| Area | Responsibility |
|------|----------------|
| **Core** | `SessionManager`, `ConnectionManager`, `AgentManager`, `SessionHistoryStore`, `AcpClientImpl` |
| **Handlers** | `PermissionHandler`, `SessionUpdateHandler`, `FileSystemHandler`, `TerminalHandler`, `TerminalContextProvider`, `ElicitationHandler` |
| **UI** | `ChatWebviewProvider`, `SessionTreeProvider`, `StatusBarManager` |
| **Voice** | `AudioRecorder` / `MciRecorder`, `CompanionRecorder`, `SttClient`, `VoiceInputManager` — see [docs/voice-remote-ssh.md](docs/voice-remote-ssh.md) |
| **Vision** | `WindowRecorder`, `VideoVisionClient`, `FrameExtractor`, `WindowRecordManager`, `CompanionScreenRecorder` — see [docs/vision-remote-ssh.md](docs/vision-remote-ssh.md) and [docs/vision-models.md](docs/vision-models.md) |
| **Companion** | `companion/acp-local-capture/` — `extensionKind: ["ui"]` VSIX; captures on the client, analysis stays remote (`acpLocalCapture.*`) |
| **Config** | `AgentConfig`, `RegistryClient` |
| **Utils** | `Logger`, `StreamAdapter` |

Communication with agents uses the ACP protocol (JSON-RPC 2.0 over stdio). For contributor-level detail see [AGENTS.md](AGENTS.md).

## Known Issues

- Default agents must be available on the system `PATH` (`claude-code-acp`, `codex-acp`, `cursor-agent`); custom configs may use `npx`
- Some agents require additional authentication setup (e.g. `agent login` / API keys) — IDE login is not inherited by the spawned agent process
- Image attachment is only shown when the current model supports image input. For Codex CLI, this is determined from `~/.codex/model_catalog.json`. For Kiro CLI, Claude models are assumed to support images; all others (minimax, qwen, glm, kimi) are text-only. Clipboard paste of images is also gated by this check.
- ACP `ContentBlock` has no video type — screen recordings are analyzed via `acp.vision.endpoint` (or framed into images); the raw MP4 is never sent as an ACP block
- Over Remote SSH / WSL / Containers, mic and screen capture require the `acp-local-capture` companion; without it the buttons fail with an install hint (no silent fallback to the headless server)

## Links

- [ACP Client on Visual Studio Code Marketplace](https://marketplace.visualstudio.com/items?itemName=formulahendry.acp-client)
- [Agent Client Protocol](https://agentclientprotocol.com/)
- [GitHub Repository](https://github.com/formulahendry/vscode-acp)
- [Voice over Remote SSH](docs/voice-remote-ssh.md) · [Screen recording over Remote SSH](docs/vision-remote-ssh.md) · [Vision model matrix](docs/vision-models.md) · [Contributor notes](AGENTS.md)

## Related Projects

- [ACP UI](https://github.com/formulahendry/acp-ui) — A modern, cross-platform desktop client for the Agent Client Protocol (ACP)
- [WeChat ACP](https://github.com/formulahendry/wechat-acp) — Bridge WeChat chat messages to any ACP-compatible AI agent (Claude, Codex, Copilot, Qwen, Gemini, OpenCode and more)

## License

MIT — see [LICENSE](LICENSE) for details.

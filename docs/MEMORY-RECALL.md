# Shared-Memory Recall — Panel & Capture Requirements

**Applies to:** the Model-B shared-memory integration (`MemoryCore` gateway +
`src/core/memory/*`, prompt injection in `SessionManager.sendPrompt`, and the
webview rendering in `src/ui/ChatWebviewProvider.ts`).

This document is the contract for what the memory recall feature may inject
into an agent prompt and — critically — what may **never** appear in the main
chat panel or be written back into the memory store.

---

## 1. Requirement: memory context is machine context — it must never render as

user-facing chat content

The extension injects a recall blob (L1 memories + L3 persona + L2 scene
navigation) as an `embeddedContext` resource at
`vscode-acp:///memory/<agentId>` in front of every user prompt. The blob is
intended for the **agent's context window**, not for human reading:

- When the agent supports `embeddedContext`, the recall is sent as a
  `resource` block and the webview must render it as a compact **memory pill**
  (`[Memory context]`), never as the raw blob text.
- When the agent flattens the resource back into the user message text
  (e.g. codex's `extractUserTextFromContentBlocks` emits
  `<context ref="vscode-acp:///memory/<id>">…</context>`), the panel must
  strip that wrapper on replay via `cleanUserMessage` / `stripTag('context')`,
  and a message that is _only_ machine context must not render at all
  (`isMachineContextOnly`).
- Live `user_message_chunk` notifications that echo the prompt (including the
  flattened memory wrapper) must not coalesce into the user bubble — the
  webview already added the real user text locally when the prompt was sent.

## 2. Requirement: no feedback loop — the recall blob is never written back to

memory

Capturing a turn must **not** persist the injected recall blob, the flattened
`<context ref="vscode-acp:///memory/...">` wrapper, or the agent's echo of it.
`sanitizeMemoryText` strips all `agent-memory` / `relevant-memories` /
`user-persona` / `relevant-scenes` / `scene-navigation` / `memory-tools-guide`
blocks **and** the flattened memory-context wrapper before L0 capture, so a
recall does not re-enter the store and reinforce itself turn after turn.

## 3. Requirement: summarizer instruction-echo is never captured or emitted

Observed failure (session `9ad39a1e`, 2026-08-09, DeepSeek-V4-Flash):

1. The model returned empty post-tool replies 3× in a row; codex's
   empty-reply guard exhausted its retries and asked the LLM to synthesize a
   closing summary (`handleTimeoutCompletion`).
2. The synthesizer echoed its own instruction as "content":
   _"Note: The summary must be based strictly on the actual tool results shown
   above. Do not fabricate or invent any results. If a tool failed or returned
   an error, report that honestly."_
3. That text was streamed as `agent_message_chunk` (ending the turn
   prematurely with a raw instruction leak in the panel) and then captured as
   L0 by the memory module, whose recall re-injected it into every later turn.

Requirements that prevent this class of bug:

- **codex side** (`sanitizeSynthesizedSummary` in `tool-executor.ts`): a
  synthesized closing summary that is a short instruction-echo ("Note:",
  "Do not fabricate", "must be based strictly", ...) must be rejected and
  replaced with the honest fallback text — never emitted to the IDE.
- **vscode-acp side** (`shouldCaptureL0` in `MemorySanitize.ts`): assistant
  replies that are instruction-echo fragments must not enter the memory store.

## 4. Captured assistant content is sanitized before storage

`endTurn` in `SharedMemoryProvider` applies `sanitizeMemoryText` → `stripCodeBlocks`
→ `truncateForCapture` to both the user text and the assistant text before
`/v3/conversation/add`. Any of:

- the 8192-char gateway content cap,
- injected recall / context wrappers,
- instruction-echo fragments,

must be handled client-side so the gateway never stores them verbatim.

---

**Tests:** `src/test/memory.test.ts` covers the sanitize/`shouldCaptureL0`
contracts; `codex`'s `test/tool-executor-empty-reply.test.ts` covers
`isPromptEcho` / `sanitizeSynthesizedSummary`.

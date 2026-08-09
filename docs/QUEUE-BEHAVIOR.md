# Mid-Turn Message Queue — Behavior & Requirements

**Applies to:** the chat webview message queue (`messageQueue` +
`drainQueue`/`handleQueue` in `src/ui/ChatWebviewProvider.ts`).

This document is the contract for how a message typed while the agent is
still producing a turn (streaming) is handled. The queue decision helpers
`queueIsMutatingCommand` and `queueDrainStartedTurn` are kept as standalone
top-level functions inside the webview template literal so they can be
extracted and tested verbatim (`src/test/messageQueue.test.ts`).

---

## 1. Requirement: every mid-turn message is QUEUED — never steered, never dropped

Typing or pasting a message (or attaching an image) while a turn is in
progress must **not**:

- be sent as a second concurrent `session/prompt` (races the in-flight turn —
  claude-code-acp serializes via `sessionPromptLocks`, but codex/ericli would
  drop or duplicate output);
- be dropped silently;
- be "steered" into the active turn.

**Why no steering?** No agent provides reliable mid-turn injection from this
client today:

| Agent | Steer behavior | Why it is not used |
|---|---|---|
| EricLI | `session/steer` drains only at tool-iteration boundaries | a long single tool call or LLM response queues steers client-side with no live response |
| codex-acp | `session/steer` notification is fire-and-forget; silently drops when `currentTurnId` is null (turn tail) | the message can vanish without ever reaching the LLM |
| claude-code-acp | cannot inject mid-turn at all; steers are deferred to sequential `--resume` turns | a bubble shows with no live response (misleading) |

Instead every mid-turn message goes into the **visible message queue** (the
queue chip below the input). The chat bubble for the message is added **at
drain time**, when the message is actually sent to the agent — never at queue
time — so a prompt queued during a long turn (e.g. `/compact` running for
minutes) does not appear "accepted" before it is processed.

## 2. Requirement: strict FIFO — ONE queued message per agent turn

`drainQueue()` sends **exactly one** queued message per `promptEnd`. A burst
of N messages typed during a long turn is therefore answered by **N
sequential turns** — never batched, never reordered, never dropped.

Drain triggers:

- `promptEnd` (normal turn end / error / cancel) — the normal path;
- manual `/compact` completion (`flushCompactionMessages`);
- immediately after a drained **local** slash command that does **not** start a
  turn (`/stop`, `/rename`, `/ps`, `/session`) — chained right away so the
  queue never stalls behind an unrelated turn;
- `Send Now` on the queue chip — interrupts the current turn
  (`cancelTurn`), then sends after the cancel completes
  (`pendingSendAfterCancel`).

## 3. Requirement: the transition tick must queue, not race

Between `drainQueue()` / `Send Now` posting `sendPrompt` and the host's
`promptStart` arriving, the previous send is still in flight host-side. A
message typed in this tiny window (`isSendingPrompt === true`) must be
**queued**, not sent:

- the Enter key handler checks `isSendingPrompt` first and queues;
- `handleSend()` (send-button / slash-command buttons) checks
  `isSendingPrompt` first and queues;
- `isSendingPrompt` is set by every path that posts `sendPrompt`
  (`drainQueue`, `sendQueuedMessageNow`), and cleared by `promptStart`
  (turn started) and by `promptEnd`/`setProcessing(false)` (turn finished).

## 4. Requirement: mutating slash commands are queued as real prompts

`/compact`, `/summarize`, `/compress`, `/clear`, `/index build|rebuild|…`
are **mutating**: they must run as a full `session/prompt` after the current
turn ends, never injected anywhere mid-turn. `queueIsMutatingCommand(text)`
is the single source of truth for this classification and is applied in
`handleQueue`.

Read-only commands (`/ps`, `/status`, `/tools`, …) are handled by
`handleSend` before queueing — they run as side-channels without starting a
turn.

## 5. Requirement: no deadlock / no stall

- When the drained message is a **local** command that does not start a turn
  (`/rename`, `/ps`, `/stop`, `/session`), the next queued message drains
  immediately instead of waiting for an unrelated `promptEnd`.
- When the drained message **starts** a turn (a normal prompt, or
  `/compact`/`/clear` which set `isProcessing`), the next queued message
  waits for that turn's `promptEnd` — `queueDrainStartedTurn(handledLocal,
  startedTurn, isProcessingNow)` encodes exactly this decision.
- `/compact`/`/clear` queued mid-turn are drained only after the current
  turn ends (`promptEnd`), at which point `handleLocalSlashCommand` runs
  with `isProcessing=false` and starts the compaction turn.

## Testing

`messageQueue.test.ts` extracts the real `queueIsMutatingCommand` and
`queueDrainStartedTurn` from `ChatWebviewProvider.ts` and asserts the
classification/drain decisions above. Run with:

```bash
npm run test:unit
```

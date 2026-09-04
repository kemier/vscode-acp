# Mid-Turn Message Queue — Behavior & Requirements

**Applies to:** the chat webview message queue (`messageQueue` +
`drainQueue`/`handleQueue` in `src/ui/ChatWebviewProvider.ts`).

This document is the contract for how a message typed while the agent is
still producing a turn (streaming) is handled. The queue decision helpers
`queueIsMutatingCommand`, `queueDrainStartedTurn` and `agentSupportsSteering`
are kept as standalone top-level functions inside the webview template literal
so they can be extracted and tested verbatim
(`src/test/messageQueue.test.ts`).

---

## 1. Requirement: every mid-turn message is delivered — never lost

Typing or pasting a message (or attaching an image) while a turn is in
progress must **not**:

- be sent as a second concurrent `session/prompt` (races the in-flight turn —
  claude-code-acp serializes via `sessionPromptLocks`, but codex/codex would
  drop or duplicate output);
- be dropped silently;
- be held for the whole turn when the agent can accept it mid-turn.

**Option B — every agent takes the deferred-queue path (default).**
`agentSupportsSteering(agentName)` currently returns `false` for ALL agents
(Codex and Codex included). Option A (real mid-turn steering via
`session/steer` → live `turn/steer` injection) was enabled for Codex/Codex in
commit `2892a07`, but it rendered the user's prompt as an instant chat bubble
before the agent consumed it — misleading when the steer was actually only
drained at the next tool-iteration boundary (or not at all, e.g. when the model
ends the turn first), and it could end the turn prematurely. Option B:

- every mid-turn message goes into the **visible message queue** (the queue
  chip below the input) — the chat bubble is added **at drain time**, when the
  message is actually sent to the agent, never at queue time;
- messages drain strictly FIFO, **one per turn** (`drainQueue()` sends exactly
  one queued message per `promptEnd`), a burst of N messages during a long turn
  is answered by N sequential turns — never batched, never dropped;
- a queued prompt does not appear "accepted" before it is processed (important
  during a long turn e.g. `/compact` running for minutes).

## 1b. Memory recall is NOT disabled by Option B

Disabling mid-turn steering (`agentSupportsSteering → false`) does **not**
disable shared-memory recall. Recall is attached to the **`sendPrompt`** path,
not the steer path:

- every turn-starting prompt (`sendPrompt` in `SessionManager.ts`) runs the
  same `buildRecallBlocks` pipeline and prefixes the prompt with the formatted
  `<agent-memory>` blob (see `docs/MEMORY-RECALL.md`);
- a mid-turn message queued under Option B is drained after the current
  `promptEnd` as a real `sendPrompt` — so it also gets the memory recall,
  just delayed until the turn finishes;
- the only thing Option B removes is the *optimistic* steer-time recall that
  used to attach a `memory` field to `session/steer`
  (`steerPrompt` in the a2a branch). With steering off, an interjected message
  is no longer answered inside the live turn; it is answered by the next turn
  with full memory context, which also eliminates the premature-`end_turn`
  issues observed with steer injection.

Net effect: **Option B keeps memory recall working for every message that is
actually sent to the agent.** The recall just happens at `sendPrompt` time
instead of at steer time.

## 2. Requirement: strict FIFO — ONE queued message per agent turn

With Option B all agents take the deferred-queue path. `drainQueue()` sends
**exactly one** queued message per `promptEnd`. A burst of N messages typed
during a long turn is therefore answered by **N sequential turns** — never
batched, never reordered, never dropped.

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

## 4. Requirement: mutating slash commands are queued as real prompts —

never steered

`/compact`, `/summarize`, `/compress`, `/clear`, `/index build|rebuild|…`
are **mutating**: they must run as a full `session/prompt` after the current
turn ends, never injected anywhere mid-turn. `queueIsMutatingCommand(text)`
is the single source of truth for this classification and is applied in
`handleQueue`.

Read-only commands (`/ps`, `/status`, `/tools`, …) are handled by
`handleSend` before queueing — they run as side-channels without starting a
turn.

This check applies to steer-capable agents too: `handleQueue` routes a
mutating command to the FIFO queue (`queueMessage`) even when the agent
supports steering, so `/compact`/`/clear` never race the live turn. When that
turn ends, the queued command drains as a full `session/prompt`.

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

`messageQueue.test.ts` extracts the real `queueIsMutatingCommand`,
`queueDrainStartedTurn` and `agentSupportsSteering` from
`ChatWebviewProvider.ts` and asserts the classification/drain decisions above.
Run with:

```bash
npm run test:unit
```

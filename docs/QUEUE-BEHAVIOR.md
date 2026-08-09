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
  claude-code-acp serializes via `sessionPromptLocks`, but codex/ericli would
  drop or duplicate output);
- be dropped silently;
- be held for the whole turn when the agent can accept it mid-turn.

**Option A — steer-capable agents get real mid-turn injection.**
`agentSupportsSteering(agentName)` decides the delivery path:

| Agent           | Steer behavior                                                                                                | Delivery                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| EricLI          | `session/steer` → `steerQueue` drained at every tool-iteration boundary, injected as `[User interjection]: …` | **Steered** into the active turn — live response within the same streaming turn      |
| codex-acp       | `session/steer` → per-session `SteeringQueue` → `turn/steer` inject-or-startNewTurn                           | **Steered** into the active turn — never dropped                                     |
| claude-code-acp | cannot inject mid-turn; steers are deferred to sequential `--resume` turns                                    | **Queued** (a steer would show an instant bubble with no live response — misleading) |
| Kiro / others   | no reliable mid-turn channel                                                                                  | **Queued**                                                                           |

For steer-capable agents every mid-turn message is steered (EricLI and
codex-acp both support MULTIPLE steers per turn). The message appears as a
user bubble immediately and is delivered to the agent at the next iteration
boundary, matching Codex TUI behavior.

For deferred-queue agents (Claude, Kiro, …) the message goes into the
**visible message queue** (the queue chip below the input). The chat bubble
for the message is added **at drain time**, when the message is actually sent
to the agent — never at queue time — so a prompt queued during a long turn
(e.g. `/compact` running for minutes) does not appear "accepted" before it is
processed.

## 2. Requirement: strict FIFO — ONE queued message per agent turn

This section applies to deferred-queue agents. Steer-capable agents bypass the
queue entirely (section 1), so a burst of N messages during a long turn is
delivered as N live steers within the same turn.

For queued agents, `drainQueue()` sends **exactly one** queued message per
`promptEnd`. A burst of N messages typed during a long turn is therefore
answered by **N sequential turns** — never batched, never reordered, never
dropped.

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

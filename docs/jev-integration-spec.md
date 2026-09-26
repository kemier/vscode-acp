# Jev (System One) Integration into the ACP System

**Status:** Draft
**Date:** 2026-09-21
**Author:** ezennin + EriCLI

## 1. Problem Statement

The ACP system (vscode-acp + ericli/claude-code-acp/codex-acp + ericai-proxy) is built around **generative LLMs** that produce text token-by-token. Many decisions in the agent loop — permission gating, tool routing, context triage, confidence scoring — don't need a paragraph; they need a **typed, calibrated, fast decision**. Jev (TypeSafe) and its open-source counterpart OpenJev (razorback16) fill that gap: they return `Choice`/`Score`/`Noul` answers with probabilities in 70–500 ms, at $0.042/M input tokens (or free when self-hosted on DiffusionGemma 26B).

This spec defines how to integrate a System One decision model into the existing ACP stack.

## 2. Design Constraints

- **Jev is not an LLM.** It does not generate text. It evaluates a `state` against typed `questions` and returns probability distributions. It cannot replace the main agent model.
- **Two deployment modes:** hosted TypeSafe API (`api.typesafe.ai`) and self-hosted OpenJev (`razorback16/openjev`, DiffusionGemma 26B via vLLM or MLX). Both speak the same wire API: `POST /v1/systemone`.
- **Must work with existing agents.** The integration should not require forking or modifying the main agent binaries (ericli, claude-code-acp, codex-acp). It should be additive.
- **vscode-acp is the client.** All ACP agents connect through vscode-acp's `AgentManager` → `ConnectionManager` → `AcpClientImpl`. The permission flow, tool call rendering, and session management all live in vscode-acp.

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        VS Code (vscode-acp)                        │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────────┐ │
│  │  Agent A     │  │  Agent B     │  │  Jev Decision Agent       │ │
│  │  (ericli)    │  │  (codex-acp) │  │  (jev-acp / openjev-acp)  │ │
│  │  main LLM    │  │  main LLM    │  │  NO LLM — decision only   │ │
│  └──────┬───────┘  └──────┬───────┘  └─────────────┬─────────────┘ │
│         │                 │                        │               │
│         └─────────────────┼────────────────────────┘               │
│                           │                                         │
│                    ┌──────┴──────┐                                 │
│                    │ Connection  │  JSON-RPC over stdio            │
│                    │ Manager     │  (ACP protocol)                 │
│                    └──────┬──────┘                                 │
│                           │                                         │
│                    ┌──────┴──────┐                                 │
│                    │ AcpClient   │                                 │
│                    │ Impl        │                                 │
│                    └──────┬──────┘                                 │
│                           │                                         │
│              ┌────────────┼────────────┐                           │
│              │            │            │                           │
│         ┌────┴───┐  ┌────┴────┐  ┌────┴──────┐                    │
│         │Permission│ │ ToolCall│ │  Session  │                    │
│         │ Handler  │ │ Render  │ │  Manager  │                    │
│         └────┬────┘  └─────────┘  └──────────┘                    │
│              │                                                      │
│         ┌────┴─────────────────────────────┐                       │
│         │  Jev Confidence Gate (NEW)       │                       │
│         │  auto-approve / ask / deny       │                       │
│         │  based on calibrated probability │                       │
│         └──────────────────────────────────┘                       │
└─────────────────────────────────────────────────────────────────────┘
         │                    │                     │
         ▼                    ▼                     ▼
   ┌───────────┐      ┌────────────┐       ┌──────────────────┐
   │ ericai-   │      │  Jev API   │       │  OpenJev Server  │
   │ proxy     │      │ (TypeSafe) │       │  (self-hosted)   │
   │ (LLM)     │      │  $0.042/M  │       │  DiffusionGemma  │
   └───────────┘      └────────────┘       │  26B-A4B         │
                                            │  :8080           │
                                            └──────────────────┘
```

## 4. Integration Points

### 4.1 Jev as a Standalone ACP Agent (Option A — minimal effort)

**What:** Register `jev-acp` as a new agent in vscode-acp's `acp.agents` config. The user gets a "Jev" entry in the agent picker and can open a Jev session alongside their LLM agents.

**How:**
- Add to `package.json` defaults (or user settings):
  ```json
  "Jev": {
    "command": "npx",
    "args": ["-y", "jev-acp"],
    "env": {
      "TYPESAFE_API_KEY": "...",
      "TYPESAFE_BASE_URL": "http://127.0.0.1:8080"
    }
  }
  ```
- `jev-acp` implements the minimum ACP surface: `initialize`, `session/new`, `session/prompt`, `session/cancel`, `session/set_config_option`.
- The user types `/choice`, `/score`, `/noul`, `/decide` commands in the chat. Results render as tool calls with probability distributions.

**Effort:** ~0 code changes to vscode-acp. Just a config entry.

**Limitation:** Jev is a separate chat session. The main LLM agent cannot call Jev mid-turn. The user must switch to the Jev session to make a decision.

### 4.2 Jev as a Tool Inside an Existing Agent (Option B — recommended)

**What:** Add a `jev_decide` tool to ericli (and optionally claude-code-acp) so the main LLM can call Jev for specific decisions during a turn.

**How (ericli):**

1. **New tool definition** in `src/core/tool-executor.ts`:
   ```typescript
   // Tool: jev_decide
   // Args: { state: string, questions: Record<string, JevQuestion> }
   // Returns: { answers: { [id]: { type, value, probabilities, confidence } }, usage }
   ```

2. **HTTP client** — a small `JevClient` class in `src/ericai/jev-client.ts`:
   ```typescript
   class JevClient {
     constructor(baseUrl: string, apiKey?: string) {}
     async decide(state: string, questions: JevQuestion[]): Promise<JevResult> {
       // POST /v1/systemone
       // model: "jev-latest" (hosted) or "openjev-latest" (self-hosted)
     }
   }
   ```
   - `baseUrl` from env `JEV_BASE_URL` (default `https://api.typesafe.ai`) or `http://127.0.0.1:8080` for OpenJev.
   - `apiKey` from env `JEV_API_KEY` or `TYPESAFE_API_KEY`.
   - Timeout: 5 s (Jev is 70–500 ms; OpenJev is ~100–400 ms).
   - Retry: 1 retry on 429/529 with 200 ms backoff.

3. **Tool schema** (function-calling format for the LLM):
   ```json
   {
     "name": "jev_decide",
     "description": "Make a typed, calibrated decision using the Jev System One model. Use for routing, triage, confidence scoring, or yes/no judgments where you need a probability, not a paragraph.",
     "parameters": {
       "type": "object",
       "properties": {
         "state": { "type": "string", "description": "The context or document to evaluate" },
         "questions": {
           "type": "object",
           "description": "Map of question_id → question definition",
           "additionalProperties": {
             "type": "object",
             "properties": {
               "type": { "enum": ["choice", "score", "noul"] },
               "instructions": { "type": "string" },
               "criteria": { "description": "Choice: {name: desc}. Score: [level0, level1, ...]. Noul: {true: desc, false: desc} (optional)" }
             },
             "required": ["type", "instructions"]
           }
         }
       },
       "required": ["state", "questions"]
     }
   }
   ```

4. **Tool kind mapping** in `src/acp/tool-mapper.ts`:
   - `mapToolKind('jev_decide')` → `'search'` (it's a read-only evaluation, not a file mutation).
   - `buildToolTitle('jev_decide', args)` → `"Decide: <first question instructions>"` (truncated to 48 chars).
   - `toolRequiresPermission('jev_decide')` → `false` (read-only, no side effects).

5. **Config** in `package.json` / settings:
   ```json
   "acp.jev": {
     "type": "object",
     "properties": {
       "baseUrl": { "type": "string", "default": "https://api.typesafe.ai" },
       "apiKey": { "type": "string", "default": "" },
       "enabled": { "type": "boolean", "default": false }
     }
   }
   ```
   When `enabled: false`, the `jev_decide` tool is not registered.

**Effort:** ~200 lines in ericli (JevClient + tool handler + schema + mapper entries). No vscode-acp changes.

### 4.3 Jev Confidence Gate in Permission Flow (Option C — the killer feature)

**What:** Before vscode-acp shows a permission prompt, call Jev to assess the risk of the proposed action. Use the calibrated probability to decide: auto-approve, ask the user, or deny.

**How:**

1. **New module** in vscode-acp: `src/handlers/JevConfidenceGate.ts`
   ```typescript
   interface JevGateConfig {
     enabled: boolean;
     baseUrl: string;      // Jev API endpoint
     apiKey: string;
     autoApproveThreshold: number;  // e.g. 0.95
     denyThreshold: number;         // e.g. 0.05
     timeoutMs: number;             // e.g. 2000
   }

   class JevConfidenceGate {
     async assess(toolCall: ToolCall, context: PermissionContext): Promise<GateDecision> {
       // Build state from: tool name, rawInput (command/path), session cwd, recent history
       // Ask Jev:
       //   noul: "Is this action safe to auto-approve?"
       //   choice: "risk_level" → { low: "read-only or reversible", medium: "moderate impact", high: "destructive or irreversible" }
       // Return: { probability, riskLevel, shouldAutoApprove, shouldDeny }
     }
   }
   ```

2. **Hook into `PermissionHandler.tryAutoApprove`** (line 380 of `PermissionHandler.ts`):
   ```
   Current flow:
     tryAutoApprove(params)
       → allowAll? → approve
       → approved fingerprint? → approve
       → denylist? → deny
       → fall through to manual prompt

   New flow:
     tryAutoApprove(params)
       → allowAll? → approve
       → approved fingerprint? → approve
       → denylist? → deny
       → JevGate.enabled? → assess(params)
           → probability > autoApproveThreshold → approve (log "Jev auto-approved: P(safe)=0.97")
           → probability < denyThreshold → deny (log "Jev denied: P(safe)=0.03")
           → else → fall through to manual prompt (show Jev's risk level in the QuickPick)
       → fall through to manual prompt
   ```

3. **UI enhancement** in the permission QuickPick:
   - When Jev assessed the action, show a confidence badge:
     - `Low risk (P=0.92)` — green
     - `Medium risk (P=0.55)` — yellow
     - `High risk (P=0.08)` — red
   - The badge is informational; the user still decides (unless the threshold auto-approves/denies).

4. **Config** in `package.json`:
   ```json
   "acp.jevGate": {
     "type": "object",
     "properties": {
       "enabled": { "type": "boolean", "default": false },
       "baseUrl": { "type": "string", "default": "http://127.0.0.1:8080" },
       "apiKey": { "type": "string", "default": "" },
       "autoApproveThreshold": { "type": "number", "default": 0.95 },
       "denyThreshold": { "type": "number", "default": 0.05 },
       "timeoutMs": { "type": "number", "default": 2000 }
     }
   }
   ```

**Effort:** ~300 lines in vscode-acp (JevConfidenceGate + PermissionHandler hook + QuickPick badge + config). Reuses the same `JevClient` HTTP pattern.

**Key design decision:** The Jev gate is **advisory by default**. It never blocks a user who wants to approve. The thresholds are configurable. If the Jev API is down or times out, the gate is skipped and the normal manual prompt appears (fail-open, not fail-closed).

## 5. Deployment Topology

```
                    ┌─────────────────────────────────┐
                    │         VS Code (client)        │
                    │  vscode-acp extension           │
                    │  - AgentManager (spawns agents) │
                    │  - PermissionHandler (+ JevGate)│
                    └──────────┬──────────────────────┘
                               │ stdio (ACP JSON-RPC)
              ┌────────────────┼────────────────┐
              │                │                │
       ┌──────┴──────┐  ┌──────┴──────┐  ┌──────┴──────┐
       │  ericli     │  │  codex-acp  │  │  jev-acp    │
       │  (main LLM) │  │  (main LLM) │  │  (decision) │
       └──────┬──────┘  └─────────────┘  └──────┬──────┘
              │                                  │
              │ jev_decide tool call             │ /choice, /score, /noul
              ▼                                  ▼
       ┌──────────────────────────────────────────────────┐
       │              Jev / OpenJev Server                │
       │  POST /v1/systemone                              │
       │  ┌────────────────────────────────────────────┐  │
       │  │ Hosted: api.typesafe.ai (TypeSafe)         │  │
       │  │ Self-hosted: OpenJev on :8080              │  │
       │  │   - vLLM + DiffusionGemma 26B (NVIDIA)     │  │
       │  │   - MLX + DiffusionGemma 26B (Apple)       │  │
       │  └────────────────────────────────────────────┘  │
       └──────────────────────────────────────────────────┘
              │
              │ (LLM requests only)
              ▼
       ┌──────────────────┐
       │  ericai-proxy    │
       │  :8317           │
       │  (OpenAI-compat) │
       └──────────────────┘
```

**Key point:** Jev/OpenJev is a **separate service** from ericai-proxy. It does not go through the proxy. The proxy handles LLM chat completions; Jev handles typed decisions. They are independent backends.

## 6. Phased Delivery

### Phase 1: Standalone Jev Agent (1 day)
- Register `jev-acp` in `acp.agents` config
- Verify it appears in the agent picker
- Test `/choice`, `/score`, `/noul` commands
- **Deliverable:** User can open a Jev session and make typed decisions

### Phase 2: Jev Tool in ericli (2–3 days)
- Implement `JevClient` (HTTP, retry, timeout)
- Add `jev_decide` tool to ericli's tool executor
- Add tool schema, kind mapping, title builder
- Add `acp.jev` config (baseUrl, apiKey, enabled)
- Test: ericli calls `jev_decide` mid-turn for routing/triage
- **Deliverable:** Main LLM agent can call Jev for fast decisions during a turn

### Phase 3: Confidence Gate in vscode-acp (3–5 days)
- Implement `JevConfidenceGate` module
- Hook into `PermissionHandler.tryAutoApprove`
- Add risk badge to permission QuickPick
- Add `acp.jevGate` config (thresholds, timeout)
- Test: auto-approve safe actions, flag risky ones, fail-open on Jev timeout
- **Deliverable:** Permission prompts show Jev's risk assessment; safe actions auto-approve

### Phase 4: OpenJev Self-Hosted Deployment (1 day)
- Docker-compose for OpenJev on a GPU machine
- Point `JEV_BASE_URL` / `acp.jev.baseUrl` at the local server
- Verify identical API behavior to hosted Jev
- **Deliverable:** Fully local, zero-cost decision model

## 7. What Jev Can and Cannot Do — The Context Boundary

Jev is a **stateless classifier**. It sees exactly the `state` string sent in the request and nothing else. No memory of prior reads, no ability to fetch more context, no tool calls, no file access. This is the single most important constraint when evaluating where Jev adds value.

### 7.1 Where Jev is strong (low context dependency)

The `state` is self-contained — Jev can judge it without the LLM having read a codebase first:

| Use case | State Jev sees | Why it works |
|---|---|---|
| **Permission gating** | The command string (`"rm -rf /tmp/build"`) | Jev judges "is this destructive?" from the command alone. No code context needed. |
| **Tool routing** | The task description ("find all references to function X") | Jev picks the right tool from the task text. No code needed. |
| **Intent classification** | The user message text | Jev classifies question/task/correction from the message. No code needed. |
| **Ticket triage** | The ticket text | Jev routes to a team from the ticket description. No code needed. |
| **Sentiment/severity** | The error log or user complaint text | Jev scores severity from the text. No code needed. |

### 7.2 Where Jev is weak (high context dependency)

The `state` requires the LLM to have already gathered relevant context. Jev only replaces the **reasoning about what was read**, not the **reading itself**:

| Use case | What Jev needs in `state` | What the LLM must do first |
|---|---|---|
| **Code review** | The diff + surrounding function + called signatures + project conventions | Read the file, grep for patterns, read related files (50k–150k tokens) |
| **Architecture decisions** | The options + system context + constraints | Read the codebase, understand the system (100k+ tokens) |
| **Bug diagnosis** | The stack trace + related code + recent changes | Read logs, trace the call chain, read the implicated files |
| **Context triage/compaction** | A summary of each message block | Read the entire conversation to build the summaries |

In these cases, the token savings are **modest**: Jev replaces the LLM's output-token analysis paragraph (2k–10k tokens), but the input-token context gathering (50k–150k tokens) is unavoidable. The LLM still does 90% of the work.

### 7.3 Revised token savings per coding task

| Decision type | Frequency | Tokens saved | Why |
|---|---|---|---|
| Permission gating | 5–20× | **0 LLM tokens** (saves user time, 5–20 clicks) | Jev judges the command string directly |
| Tool routing | 10–30× | **5k–30k** (LLM skips deliberation) | Jev picks from task description alone |
| Intent/triage | 1–5× | **2k–10k** | Jev classifies the message text |
| Code review (second opinion) | 1–3× | **2k–10k** (NOT 100k) | LLM still reads everything; Jev only replaces the analysis paragraph |
| Context triage/compaction | 1–3× | **5k–20k** (NOT 150k) | LLM still needs to read the context to build the state |
| **Realistic total** | | **~15k–70k per task (5–20%)** | |

The **latency savings** are more consistent than the token savings:

| Operation | LLM (tokens/s) | Jev (ms) |
|---|---|---|
| "Which tool should I use?" | 2–5 s | **70–150 ms** |
| "Is this command safe?" | 3–10 s | **100–300 ms** |
| "What's the severity?" | 2–5 s | **100–200 ms** |
| Permission check (user click) | 5–30 s (human) | **auto-approve in 100 ms** |

In a session with 20–50 micro-decisions, Jev saves **2–10 minutes of wall-clock time**.

### 7.4 The honest framing

> The LLM reads the code (expensive, unavoidable). Jev makes the judgment call on what the LLM read (cheap, fast). The LLM no longer needs to spend output tokens writing "I think this is safe because..." — it gets a calibrated probability instead.

Jev is a **decision classifier**, not a **context analyzer**. Its highest-value use case is **permission gating** (Phase 3), where the state is just a command string and no code context is needed. That's also the feature that saves the user the most time.

### 7.5 Input-size limits (what `state` can carry)

Jev's `state` is bounded by the backend model's context window. Requests over the limit are **rejected with HTTP 400** (not timed out) — `JevClient.decide()` treats that as "Jev unavailable" and **fails open**, so an oversized `state` silently degrades to "no verdict" rather than erroring.

**Officially documented caps** (OpenJev README):

| Backend / model | `state` limit | Notes |
|---|---|---|
| **Laya** encoder | **1,024 tokens** | small model |
| **Verdict** encoder | **512 tokens** | small model |
| **MLX** backend (Apple) | **32,768 tokens** | `OPENJEV_MLX_MAX_PROMPT`; "longest request, before a 400" |
| **DiffusionGemma 26B** (vLLM, hosted) | **not stated** | ceiling = the model's own context window |

Question-shape caps: **choice** ≤ 255 options, **score** ≤ 10 levels (exceeding → 400). The server reads questions in chunks of ~12 per read.

**Measured ceiling (2026-09-26, hosted `api.codiv.ai`, DiffusionGemma 26B via vLLM):**

| `state` size | input tokens | result |
|---|---|---|
| ~200k realistic chars | ~57,838 | ✅ 3.7 s, under 5 s timeout |
| ~250k+ chars | ~70k+ | ❌ rejected (400), <1.1 s |

The vLLM-26B ceiling is therefore **~58k–70k input tokens per call** — undocumented, effectively the model's max context. The 5 s `timeoutMs` is rarely the binding constraint (calls complete in <4 s at this size); the **token cap is**.

**Practical rule:** keep a single `state` **under ~50k tokens**. For a bulk triage job (e.g. thousands of items against a large corpus), **chunk** — batch ~50–100 items per call, each carrying only its own relevant context rather than the whole corpus. The diagnose-style workflows stay well within this (a few hundred tokens per candidate); only a naive "dump the entire corpus in one `state`" would breach the cap and fail open.

## 8. Risk Assessment

| Risk | Mitigation |
|---|---|
| Jev API down / slow | Fail-open: gate skipped, normal prompt appears. `acp.jev.timeoutMs` default 5 s. |
| OpenJev quality < TypeSafe Jev | Configurable: user picks baseUrl. Hosted API for production, OpenJev for dev. |
| Extra latency on permission flow | Jev is 70–500 ms. `timeoutMs` default 5 s. Only called when no auto-approve rule matches. |
| `state` exceeds the input-token cap (~58k–70k) | HTTP 400 → `decide()` returns null → fail-open (no verdict, not an error). Keep `state` < ~50k tokens; chunk bulk triage. See §7.5. |
| API key leakage | Key in VS Code settings (not in code). `acp.jev.apiKey` is a secret field. |
| Jev misjudges risk | Thresholds are conservative by default (0.95 / 0.05). Badge is advisory. User always has final say. |
| Jev judges without full context | Jev is a second opinion, not a replacement. The LLM retains final authority. For code review, Jev's P(breaks_pattern) is a flag, not a verdict. |
| Token cost (hosted) | $0.042/M input. A permission check is ~200 tokens = $0.0000084. Negligible. |

## 9. Files to Create/Modify

| File | Change | Phase |
|---|---|---|
| `vscode-acp/package.json` | Add `acp.jev` + `acp.jevGate` config schemas; add Jev to default agents | 1, 3 |
| `vscode-acp/src/handlers/JevConfidenceGate.ts` | New: Jev HTTP client + gate logic | 3 |
| `vscode-acp/src/handlers/PermissionHandler.ts` | Hook JevGate into `tryAutoApprove` | 3 |
| `vscode-acp/src/ui/ChatWebviewProvider.ts` | Risk badge in permission QuickPick | 3 |
| `ericli/src/ericai/jev-client.ts` | New: JevClient HTTP wrapper | 2 |
| `ericli/src/core/tool-executor.ts` | Add `jev_decide` tool handler | 2 |
| `ericli/src/core/prompt-fragments/tool-schemas.ts` | Add `jev_decide` schema | 2 |
| `ericli/src/acp/tool-mapper.ts` | Add `jev_decide` to kind/title/permission maps | 2 |
| `ericli/package.json` | Add `acp.jev` config | 2 |

## 10. Open Questions

1. **Should the Jev gate apply to all agents or just ericli?** Recommendation: all agents (it's in vscode-acp's PermissionHandler, which is agent-agnostic).
2. **Should `jev_decide` be available in claude-code-acp and codex-acp too?** Recommendation: ericli first (it's the primary agent). The tool pattern is portable.
3. **Should OpenJev also serve as an LLM backend via ericai-proxy?** It does serve `/v1/chat/completions` with `diffusiongemma-26b`. Could be added as a proxy backend for text generation, but that's a separate feature.
4. **Template system:** `jev-acp` supports saved question templates. Should vscode-acp expose a template picker in the Jev session? Nice-to-have, not Phase 1.

## 11. Implementation Status (2026-09-25)

**Phase 3 variant shipped: `jev_judge` native tool in vscode-acp.**

ACP v1 has no client→agent tool-registration method (checked against
`@agentclientprotocol/sdk` v1.4.0 `ClientCapabilities` and the protocol
initialization spec), so the native tool is delivered over the one
agent→client request channel that already exists: `unstable_createElicitation`
carrying `_meta.tool === "jev_judge"`. The client intercepts it in
`AcpClientImpl.unstable_createElicitation`, runs the judgement against
`POST {baseUrl}/v1/systemone`, and answers with `action: "accept"` and the
verdicts in `content.result` — the user is never prompted for a machine
judgment. Fail-open everywhere: disabled / no key / timeout / bad body →
text telling the agent to fall back to its own reasoning.

| File | Role |
|---|---|
| `src/jev/JevClient.ts` | HTTP client (`POST /v1/systemone`, 429/529 one-retry, `AbortSignal.timeout`), settings loader (`acp.jev.*` + `TYPESAFE_API_KEY`/`JEV_BASE_URL` env fallback), wire types |
| `src/jev/JevJudgeTool.ts` | The tool: request validation (choice ≥2 ≤255 options, score 2–10 levels, unique ids), judgement→question mapping, verdict extraction, confidence-flagged rendering |
| `src/core/AcpClientImpl.ts` | `_meta.tool === "jev_judge"` dispatch + lazily-built client |
| `package.json` | `acp.jev.enabled/baseUrl/apiKey/model/timeoutMs` settings; test registered in `test:unit` |
| `src/test/jevJudgeTool.test.ts` | 11 unit tests (shim harness, stubbed client) — all passing |

Judgement kinds map 1:1 to the AGENTS.md audit battery: `noul` for
URL-liveness/anchor/pointer integrity questions, `choice` for classification
and routing (risk level, covered-vs-gap, BARE/PARTIAL/BACKTICK/NESTED link
defect kinds), `score` for severity/currency rubrics. One call fans out all
questions in parallel against one `state`; sub-0.5 confidence answers are
flagged `LOW-CONFIDENCE — escalate`.

Verified against live docs 2026-09-25: `POST https://api.typesafe.ai/v1/systemone`,
`model: "jev-latest"` (→ `jev-1.13.0`), $0.042/M input tokens (output free),
64k context, errors 401/422/429/529 — docs.typesafe.ai/api.

Not yet implemented (earlier phases of this spec): standalone `jev-acp` agent
registration (Phase 1), `jev_decide` inside ericli (Phase 2), the permission-flow
confidence gate (Phase 3 original), OpenJev docker-compose (Phase 4).

## 12. References

- [Jev — TypeSafe AI](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
- [Jev API docs](https://docs.typesafe.ai/models)
- [jev-acp — ACP adapter](https://github.com/formulahendry/jev-acp)
- [OpenJev — self-hosted, Jev-compatible](https://github.com/razorback16/openjev)
- [Jevbridge — ACP/MCP adapter](https://github.com/tacticocc/Jevbridge)
- [ACP protocol spec](https://agentclientprotocol.com/)

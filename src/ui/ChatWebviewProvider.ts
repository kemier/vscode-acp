import * as vscode from 'vscode';
import { marked } from 'marked';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { SessionManager } from '../core/SessionManager';
import { SessionUpdateHandler, SessionUpdateListener } from '../handlers/SessionUpdateHandler';
import { TerminalContextProvider } from '../handlers/TerminalContextProvider';
import type { SessionNotification, ContentBlock } from '@agentclientprotocol/sdk';
import {
  buildFileBlock,
  buildDirectoryBlock,
  buildTerminalBlock,
  buildDiagnosticsBlock,
} from '../core/ContextBlockBuilder';
import { TerminalOutputStore } from '../core/TerminalOutputStore';
import { StreamCoalescer } from '../core/StreamCoalescer';
import { FollowCoalescer, pickFollowTarget, type ToolCallLocationLike } from '../core/FollowAgent';
import { needsRestoreAfterCapture } from '../core/SessionCaptureRestore';
import {
  CursorSessionToolEnricher,
  findCursorSessionStorePath,
  isCursorAgentName,
  isCursorStubToolTitle,
  hasActionableToolArgs,
  needsCursorToolEnrichment,
} from '../core/CursorToolEnricher';
import { log, logError, formatAcpErrorMessage, getOutputChannel } from '../utils/Logger';
import { sendEvent } from '../utils/TelemetryManager';
import { cleanSessionTitle } from '../utils/TitleCleaner';
import { ACP_MATH_SPLIT_RE, createMathExtension } from '../utils/markdownMath';
import { balanceMarkdownForPartialRender } from '../utils/markdownBalance';
import { cleanAgentToolTitle } from '../utils/toolTitle';
import { orderedLinkRoots, symbolFallbackFromLinkText } from '../utils/codeLink';
import { readSessionSummarySettings } from '../core/SessionSummaryConfig';
import { summarizeSession } from '../core/SessionSummarizer';
import { VoiceInputManager, VoiceEvent } from '../voice/VoiceInputManager';

const execFileAsync = promisify(execFile);

// Set to true to enable verbose [DEBUG-WV] / [DEBUG-MD] / [DEBUG-SUBAGENT] logs
// in the ACP Client output channel. Keep false in normal use — the per-chunk
// logging floods the channel during streaming.
const DEBUG = false;
// TEMP-DEBUG master switch for the Kiro-resume "Send button stuck" fix
// instrumentation (HOST-PROMPT / HOST-SLASH / sendCurrentState / IN-FLIGHT /
// [WV-MSG] / [WV-PROBE] / [WV-CHUNK] / [WV-SLASH-ECHO] …). Keep false in normal
// use; flip to true (or set acp.debugResume) to re-enable the full trace when
// debugging resumes / streaming again.
const DEBUG_LIVE = false;

/** Webview debugLog lines forwarded when acp.debugResume is true (even if DEBUG is off). */
const RESUME_DIAG_MARKERS = [
  '[WV-DIAG]',
  '[WV-MERGE]',
  '[REPLAY-TRACE]',
  // Replay ORDER trace. session/load replays a turn as
  // tool → text → tool → text …; if chatHistory ends up grouped
  // (all tools, then all texts) the fold renders one big tool block followed
  // by every reply, which is the "grouped per section instead of interleaved"
  // resume symptom. These three markers give the three orders needed to tell
  // WHERE the interleave is lost: host post order ([WV-ORDER] host-post),
  // webview arrival order ([WV-ORDER] wv-recv), and the chatHistory push order
  // ([WV-ADDTC] for tools / [WV-COMMIT] for assistant text).
  '[WV-ORDER]',
  '[WV-ADDTC]',
  '[WV-COMMIT]',
  // Subagent/crew routing. A resumed Kiro session rendered a "spawned 1
  // subagent" card although the agent reported an empty subagent list and no
  // tool call in the session had a qualifying title or rawInput — so the
  // trigger is not on the wire and has to be caught where the card is built.
  // [WV-CREW] names the predicate that fired; [STAGE-DBG] (already emitted
  // unconditionally, previously filtered out here) shows the stage role.
  '[WV-CREW]',
  '[STAGE-DBG]',
  // A replay tail chunk that arrives after loadSessionEnd is dropped as an
  // "idle" chunk — that is how an codex resume lost its last summary. Keep the
  // drop visible so the next occurrence is one grep away.
  '[WV-CHUNK-DROP]',
  '[WV-LOAD-TAIL]',
  'UMC chunk:',
  'UMC load-turn:',
  'restoreState',
  'handleLoadSession',
  'orphan merge:',
];

/**
 * How long `notifyLoadSessionEnd` waits before declaring a replay finished.
 *
 * Must exceed the StreamCoalescer interval (8 ms) so a final
 * agent_message_chunk whose handler runs after the session/load response still
 * reaches the webview while `isLoadingSession` is true. Small enough to be
 * invisible: the load overlay is already up.
 */
const LOAD_END_TAIL_FLUSH_MS = 30;

function isResumeDiagWebviewMessage(message: string): boolean {  if (!message) {
    return false;
  }
  return RESUME_DIAG_MARKERS.some((marker) => message.includes(marker));
}

/** Result of a fork-to-agent conversation export: flat transcript + messages. */
export interface ConversationExportResult {
  /** The whole (post-compaction) transcript as one text block. */
  text: string;
  /** The same content split per turn, for the summarizer. */
  messages: Array<{ role: string; content: string }>;
  /** True when the export starts after a compaction boundary (content is the post-compaction summary). */
  exportStartsAtCompactionBoundary?: boolean;
  /** True when a compaction is currently in progress in the webview. */
  compactionInProgress?: boolean;
}

/**
 * WebviewViewProvider for the ACP chat sidebar.
 * Renders chat messages, tool calls, plans, and handles user input.
 */
export class ChatWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'acp-chat';

  private view?: vscode.WebviewView;
  private webviewReady = false;
  private pendingMessages: any[] = [];
  private updateListener: SessionUpdateListener;
  private readonly voiceInput: VoiceInputManager;
  /** When true, suppress webview notifications (used during background session capture). */
  /** When true, suppress webview notifications (used during background session capture or reconnect). */
  suppressWebviewUpdates = false;
  private _hasChatContent = false;
  /** Resolver for the pending conversation export request (fork-to-agent). */
  private _conversationExportResolver: ((result: ConversationExportResult) => void) | undefined = undefined;
  /**
   * Ensure the chat webview is loaded and ready, revealing the panel if
   * needed. Polls webviewReady (with a timeout) because a WebviewView is only
   * instantiated when its container is visible; a fork triggered from the
   * command palette / session tree may fire before the panel has opened.
   */
  async waitForWebviewReady(timeoutMs = 15000): Promise<void> {
    if (this.webviewReady) {
      return;
    }
    // Reveal the chat view container so the provider's resolveWebviewView runs
    // and the webview starts loading.
    try {
      await vscode.commands.executeCommand(`${ChatWebviewProvider.viewType}.focus`);
    } catch {
      // Some hosts don't register the .focus command; fall through to polling.
    }
    const start = Date.now();
    while (!this.webviewReady) {
      if (Date.now() - start > timeoutMs) {
        throw new Error('Conversation export failed: chat webview did not become ready in time');
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /**
   * Request the current conversation from the webview (for fork-to-agent).
   *
   * Returns both the flat transcript and the discrete { role, content }
   * messages. The fork summarizes the messages (the summarizer caps per-message
   * length, so one concatenated blob would be reduced to its tail) and falls
   * back to the transcript only when the user opts in.
   */
  /**
   * @param sessionId When given and different from the session currently
   *   rendered, the webview exports its ARCHIVE of that session instead of the
   *   visible chat. Forking a session picked from the tree — or one whose
   *   session/load was refused because another process owns it — otherwise
   *   exports whatever happens to be on screen, or nothing at all.
   */
  async requestConversationExport(
    timeoutMs = 5000,
    sessionId?: string,
  ): Promise<ConversationExportResult> {
    // Ensure the webview is loaded and ready before posting the export
    // request. If it isn't ready, postMessage silently drops the request and
    // the resolver would never fire → timeout. Reveal the panel and wait.
    await this.waitForWebviewReady(15000);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._conversationExportResolver = undefined;
        reject(new Error('Conversation export timed out'));
      }, timeoutMs);
      this._conversationExportResolver = (result: ConversationExportResult) => {
        clearTimeout(timer);
        resolve(result);
      };
      this.postMessage({ type: 'requestConversationExport', sessionId });
    });
  }


  /**
   * Dispatch a prompt to the webview so it goes through the normal
   * handleSendPrompt flow (promptStart → streaming → promptEnd).
   * Used by fork-to-agent and other extension-host commands that need
   * the webview's streaming lifecycle set up properly.
   */
  dispatchPrompt(text: string, hideBubble?: boolean): void {
    this.postMessage({
      type: 'sendPrompt',
      text,
      hideBubble: hideBubble === true,
      // Carry the session fact with the prompt. handleSend() bails on
      // !hasActiveSession WITHOUT consuming the input, so a stale webview flag
      // left the forked summary sitting in the composer waiting for a manual
      // Send. The flag is set from a `state` message, and fork-to-agent connects
      // the target agent inside a suppressWebviewUpdates window — so its
      // delivery races this dispatch. The host knows whether a session exists,
      // so it is authoritative here rather than the webview's cached copy.
      hasActiveSession: !!this.sessionManager.getActiveSessionId(),
    });
  }
  private toolCallDiffs = new Map<string, Array<{ path: string; oldText?: string; newText: string }>>();
  private terminalContext = new TerminalContextProvider();
  /** Optional store that persists oversize @terminal output to a file and
   *  keeps a truncated preview inline. Wired from activate(); undefined keeps
   *  the legacy inline-verbatim behaviour. */
  private terminalOutputStore: TerminalOutputStore | undefined;
  /**
   * Coalesces per-token streaming chunks. See `StreamCoalescer` for details.
   * Codex emits `agent_message_chunk` / `agent_thought_chunk` per LLM delta,
   * so forwarding each one to the webview costs an IPC roundtrip + a traffic
   * log entry. Buffering for 8 ms and flushing one combined chunk per kind
   * cuts both by roughly 6× at typical OpenAI token rates.
   */
  private streamCoalescer: StreamCoalescer;

  /**
   * Cursor ACP omits tool args on the wire (rawInput: {}, stub titles).
   * Enrich from ~/.cursor/acp-sessions/<id>/store.db when needed.
   */
  private cursorToolEnrichers = new Map<string, CursorSessionToolEnricher>();
  /** Deduplicate concurrent enrich polls for the same toolCallId. */
  private cursorToolEnrichInFlight = new Set<string>();
  /** toolCallIds that already have actionable args / enriched title on the wire. */
  private cursorToolArgsSatisfied = new Set<string>();
  /** Coalesce batch-enrich requests (reload + loadSessionEnd + webview ready). */
  private cursorBatchEnrichTimer: ReturnType<typeof setTimeout> | null = null;
  /** Per-tool enrich requests deferred while the agent turn is in flight. */
  private deferredCursorToolEnrich = new Map<string, Set<string>>();

  /** Serialize acp.connectAgent from the webview (onDidReceiveMessage is not awaited). */
  private connectAgentCommandChain: Promise<unknown> = Promise.resolve();

  /**
   * "Follow Agent" feature — mirrors Zed's `workspace.follow(CollaboratorId::Agent)`.
   * When `_isFollowing` is true and a `tool_call` / `tool_call_update` carries
   * a `locations` array, the editor auto-opens the first location's file at
   * the given line. A 200 ms burst-coalescer prevents flicker when the agent
   * fires a multi-file tool call.
   */
  private _isFollowing = false;
  private followCoalescer: FollowCoalescer;

  /**
   * Cache of model slug → supports-image flag, loaded from ~/.codex
   * catalog JSON files (`model_catalog.json`, `model.json`, `*models.json`).
   * Only `true` when `input_modalities` explicitly includes `"image"`.
   */
  private modelImageSupport: Map<string, boolean> | null = null;
  private modelImageSupportLoaded = false;

  /**
   * Fallback timer for cancel: if the agent doesn't acknowledge a
   * session/cancel within 5s (some agents ignore it or hang), force
   * the webview out of processing mode so the Stop button recovers.
   */
  private _cancelFallbackTimer: ReturnType<typeof setTimeout> | null = null;

  /** Monotonic counter incremented each time a new prompt starts. The cancel
   *  fallback timer captures the value at creation time and only fires if it
   *  hasn't changed, preventing a stale timer from force-aborting a new prompt
   *  that started after the cancel was acknowledged. */
  private _cancelGeneration: number = 0;

  /**
   * Sessions whose in-flight turn was abandoned by the cancel fallback (the
   * agent ignored session/cancel for 5s and the webview was force-unblocked).
   * Late session/update events from that abandoned turn must be suppressed so
   * they don't interleave with a new prompt and drop/mangle user messages.
   * Cleared when a new prompt starts for the session (see handleSendPrompt).
   */
  private _abandonedTurnSessions: Set<string> = new Set();

  /** Cached git branch for the active session's cwd, shown in the banner. */
  private _cachedGitBranch: string | null = null;

  private isDebugResume(): boolean {
    return vscode.workspace.getConfiguration('acp').get<boolean>('debugResume', false);
  }

  /** ACP Client + optional ~/.cursor/acp-debug/resume-diag.jsonl when acp.debugResume is on. */
  private logResumeDiag(message: string): void {
    log(message);
    if (!this.isDebugResume()) {
      return;
    }
    try {
      const dir = path.join(os.homedir(), '.cursor', 'acp-debug');
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(
        path.join(dir, 'resume-diag.jsonl'),
        JSON.stringify({ ts: new Date().toISOString(), msg: message }) + '\n',
        'utf8',
      );
    } catch {
      // Best-effort diagnostic file — never block the chat UI.
    }
  }

  /** Trace Cursor ACP session/update traffic (compaction investigation). Enable acp.debugResume. */
  private isDebugCursorCompactionTrace(): boolean {
    return DEBUG || this.isDebugResume();
  }

  private logCursorSessionUpdate(
    sessionId: string,
    updateData: Record<string, unknown> | undefined,
    activeId: string | null,
  ): void {
    if (!this.isDebugCursorCompactionTrace() || !updateData) {
      return;
    }
    const session = this.sessionManager.getSession(sessionId);
    const agentLabel = session?.agentName || session?.agentDisplayName || '';
    if (!isCursorAgentName(agentLabel)) {
      return;
    }
    const kind = String(updateData.sessionUpdate || 'unknown');
    const parts: string[] = [
      `kind=${kind}`,
      `session=${sessionId.slice(0, 8)}`,
      `active=${sessionId === activeId}`,
    ];
    if (kind === 'compaction_update') {
      parts.push(`status=${String(updateData.status || '')}`);
      if (updateData.error) {
        parts.push(`error=${String(updateData.error).slice(0, 80)}`);
      }
      if (updateData.summary) {
        parts.push(`summaryLen=${String(updateData.summary).length}`);
      }
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      parts.push(`title="${String(updateData.title || '').slice(0, 60)}"`);
      parts.push(`status=${String(updateData.status || '')}`);
      const meta = updateData._meta as Record<string, unknown> | undefined;
      if (meta?.contextCompaction != null) {
        parts.push(`contextCompaction=${JSON.stringify(meta.contextCompaction)}`);
      }
      if (meta && Object.keys(meta).length > 0) {
        parts.push(`_metaKeys=${Object.keys(meta).join(',')}`);
      }
    }
    if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
      const content = updateData.content as { type?: string; text?: string } | undefined;
      if (content?.type === 'text' && typeof content.text === 'string') {
        const t = content.text.trim();
        parts.push(`textLen=${t.length}`);
        if (/compact/i.test(t) || t.length < 200) {
          parts.push(`preview="${t.replace(/\s+/g, ' ').slice(0, 100)}"`);
        }
      }
    }
    const line = `[CURSOR-ACP] ${parts.join(' ')}`;
    log(line);
    this.logResumeDiag(line);
  }

  private postDebugResumeConfig(): void {
    this.postMessage({ type: 'debugResume', enabled: this.isDebugResume() });
  }

  /** Refresh the cached git branch for the given cwd. Called on session switch. */
  private async refreshGitBranch(cwd?: string): Promise<void> {
    if (!cwd) {
      this._cachedGitBranch = null;
      return;
    }
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeout: 2000 });
      this._cachedGitBranch = stdout.trim() || null;
    } catch {
      this._cachedGitBranch = null;
    }
  }

  /**
   * Session ID that currently has a prompt in flight. Used by the
   * cancel fallback timer to ensure it only fires for the correct session.
   */
  private _pendingPromptSessionId: string | null = null;

  /**
   * Snapshot of modelImageSupport as a plain object (slug → boolean),
   * sent to the webview so it can check image support locally on model
   * switch without waiting for a round-trip.
   */
  private getModelImageMap(): Record<string, boolean> {
    this.loadModelImageSupport();
    if (!this.modelImageSupport) {
      return {};
    }
    const obj: Record<string, boolean> = {};
    for (const [k, v] of this.modelImageSupport) {
      obj[k] = v;
    }
    return obj;
  }

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sessionManager: SessionManager,
    private readonly sessionUpdateHandler: SessionUpdateHandler,
    private readonly workspaceState: vscode.Memento,
    terminalOutputStore?: TerminalOutputStore,
  ) {
    this.terminalOutputStore = terminalOutputStore;
    // Configure marked for safe rendering + KaTeX math (\(...\), \[...\], $$)
    marked.setOptions({
      breaks: true,
      gfm: true,
    });
    marked.use(createMathExtension());

    this.streamCoalescer = new StreamCoalescer({
      flushIntervalMs: 8,
      onFlush: (sessionId, kind, text, messageId) => {
        this.postMessage({
          type: 'sessionUpdate',
          sessionId,
          update: {
            sessionUpdate: kind === 'message' ? 'agent_message_chunk' : 'agent_thought_chunk',
            content: { type: 'text', text },
            // Preserve the ACP messageId so the webview can group chunks of
            // one logical message into a single bubble (text→tool→text stays
            // one message instead of splitting into separate bubbles).
            ...(messageId ? { messageId } : {}),
          },
          // Inline the loading flag so the webview syncs isLoadingSession
          // with the extension host's authoritative state on every chunk.
          // This eliminates the race where loadSessionStart's postMessage
          // arrives at the webview AFTER replay chunks (the SDK dispatches
          // session/update notifications synchronously while loadSession's
          // RPC is in-flight).
          isLoading: this.sessionManager.isLoading(sessionId),
        });
      },
    });

    this.followCoalescer = new FollowCoalescer({
      flushIntervalMs: 200,
      onFlush: (target) => {
        // Open the file in a tab next to the chat panel without stealing
        // focus from the message editor. If the line is known, position the
        // selection there so users can see where the agent is working.
        //
        // Out-of-repo paths (system headers, installed deps, sibling repos)
        // are opened the same way — VS Code's showTextDocument doesn't
        // require the file to be under a workspace root.
        const uri = vscode.Uri.file(target.absPath);
        const selection =
          typeof target.line === 'number' && target.line >= 1
            ? new vscode.Range(target.line - 1, 0, target.line - 1, 0)
            : undefined;
        vscode.window
          .showTextDocument(uri, {
            preserveFocus: true,
            preview: true,
            selection,
          })
          .then(undefined, (err) => {
            // Common reasons: file doesn't exist on disk, permission denied,
            // remote-SSH workspace can't reach the path. Surface clearly.
            logError(
              `Follow Agent: could not open ${target.absPath}${typeof target.line === 'number' ? ':' + target.line : ''}`,
              err,
            );
          });
      },
    });

    // Register as a session update listener
    this.updateListener = (update: SessionNotification) => {
      this.handleSessionUpdate(update);
    };
    this.sessionUpdateHandler.addListener(this.updateListener);

    // Voice input (dictation). Recording happens here in the extension host
    // — webviews cannot access the microphone (Permissions-Policy). Events
    // are forwarded to the webview so the mic button mirrors state and the
    // transcript lands in the composer of the session that started the take.
    this.voiceInput = new VoiceInputManager(
      (evt: VoiceEvent) => this.handleVoiceEvent(evt),
      () => this.sessionManager.getActiveSessionId() ?? undefined,
    );
  }

  private handleVoiceEvent(evt: VoiceEvent): void {
    switch (evt.type) {
      case 'state':
        this.postMessage({ type: 'voiceState', state: evt.state });
        break;
      case 'transcript':
        this.postMessage({ type: 'voiceTranscript', text: evt.text, autoSend: evt.autoSend });
        break;
      case 'error':
        this.postMessage({ type: 'voiceError', message: evt.message });
        break;
    }
  }

  // Language keywords (C/C++/Go/Rust/TS/JS/Python) that should never be linkified as project symbols
  // Language keywords (C/C++/Go/Rust/TS/JS/Python) — never linkify as project symbols
  // Sources: en.cppreference.com, go.dev/ref/spec, doc.rust-lang.org, typescriptlang.org, docs.python.org
  private static readonly langKeywords = new Set([
    // === C keywords (en.cppreference.com/w/c/keyword) ===
    'thread_local',
    'static_assert',
    'typeof_unqual',
    '_Bool',
    '_Complex',
    '_Imaginary',
    '_Atomic',
    '_Generic',
    '_Noreturn',
    '_Alignas',
    '_Alignof',
    '_Static_assert',
    '_Thread_local',
    // === C++ keywords (en.cppreference.com/w/cpp/keyword) ===
    'and_eq',
    'atomic_cancel',
    'atomic_commit',
    'atomic_noexcept',
    'char8_t',
    'char16_t',
    'char32_t',
    'const_cast',
    'contract_assert',
    'co_await',
    'co_return',
    'co_yield',
    'dynamic_cast',
    'not_eq',
    'or_eq',
    'reinterpret_cast',
    'static_assert',
    'static_cast',
    'thread_local',
    'wchar_t',
    'xor_eq',
    // === C++ standard library common types ===
    'std::move',
    'std::forward',
    'std::swap',
    'std::pair',
    'std::make_pair',
    'std::tuple',
    'std::make_tuple',
    'std::get',
    'std::array',
    'std::vector',
    'std::deque',
    'std::list',
    'std::forward_list',
    'std::set',
    'std::map',
    'std::multiset',
    'std::multimap',
    'std::unordered_set',
    'std::unordered_map',
    'std::stack',
    'std::queue',
    'std::priority_queue',
    'std::string',
    'std::string_view',
    'std::wstring',
    'std::optional',
    'std::variant',
    'std::any',
    'std::function',
    'std::bind',
    'std::shared_ptr',
    'std::unique_ptr',
    'std::weak_ptr',
    'std::make_shared',
    'std::make_unique',
    'std::enable_shared_from_this',
    'std::thread',
    'std::mutex',
    'std::lock_guard',
    'std::unique_lock',
    'std::scoped_lock',
    'std::shared_mutex',
    'std::condition_variable',
    'std::future',
    'std::promise',
    'std::async',
    'std::packaged_task',
    'std::atomic',
    'std::call_once',
    'std::barrier',
    'std::latch',
    'std::counting_semaphore',
    'std::binary_semaphore',
    'std::filesystem',
    'std::chrono',
    'std::ratio',
    'std::expected',
    'std::unexpected',
    'std::move_only_function',
    'std::span',
    'std::format',
    'std::formatter',
    'std::source_location',
    'std::bit_cast',
    'std::to_underlying',
    'std::byteswap',
    'std::endian',
    'std::is_constant_evaluated',
    'std::to_address',
    'std::invoke',
    'std::invoke_r',
    'std::to_array',
    'std::as_const',
    'std::launder',
    'std::hardware_destructive_interference_size',
    'std::hardware_constructive_interference_size',
    'std::same_as',
    'std::integral',
    'std::floating_point',
    'std::derived_from',
    'std::convertible_to',
    'std::totally_ordered',
    'std::three_way_comparable',
    'std::equality_comparable',
    'std::default_initializable',
    'std::copyable',
    'std::ranges::to',
    'std::ranges::contains',
    'std::ranges::fold_left',
    'std::views::enumerate',
    'std::views::join_with',
    'std::from_chars',
    'std::to_chars',
    'std::chars_format',
    'std::errc',
    'std::nullopt',
    'std::make_optional',
    'std::get_if',
    'std::holds_alternative',
    'std::visit',
    'std::clamp',
    'std::gcd',
    'std::lcm',
    'std::sample',
    'std::countl_zero',
    'std::countl_one',
    'std::countr_zero',
    'std::countr_one',
    'std::rotr',
    'std::rotl',
    'std::bit_ceil',
    'std::bit_floor',
    'std::bit_width',
    'std::has_single_bit',
    'std::popcount',
    // === C standard library types ===
    'size_t',
    'ptrdiff_t',
    'nullptr_t',
    'int8_t',
    'int16_t',
    'int32_t',
    'int64_t',
    'uint8_t',
    'uint16_t',
    'uint32_t',
    'uint64_t',
    'intptr_t',
    'uintptr_t',
    'int_least8_t',
    'int_least16_t',
    'int_least32_t',
    'int_least64_t',
    'uint_least8_t',
    'uint_least16_t',
    'uint_least32_t',
    'uint_least64_t',
    'int_fast8_t',
    'int_fast16_t',
    'int_fast32_t',
    'int_fast64_t',
    'uint_fast8_t',
    'uint_fast16_t',
    'uint_fast32_t',
    'uint_fast64_t',
    'intmax_t',
    'uintmax_t',
    'wchar_t',
    'FILE',
    'fpos_t',
    // === Go keywords (go.dev/ref/spec) ===
    // === Go builtin functions and types ===
    'complex64',
    'complex128',
    'float32',
    'float64',
    'int8',
    'int16',
    'int32',
    'int64',
    'uint8',
    'uint16',
    'uint32',
    'uint64',
    // === Rust keywords (doc.rust-lang.org/reference/keywords.html) ===
    // === Rust reserved keywords ===
    'macro_rules',
    // === Rust std types and functions ===
    'RefCell',
    'RwLock',
    'HashMap',
    'HashSet',
    'BTreeMap',
    'BTreeSet',
    // === TypeScript/JavaScript keywords ===
    // === Python keywords (docs.python.org/3/library/keyword.html) ===
    // === Python builtins (docs.python.org/3/library/builtins.html) ===
    // === Codex/agent tool names — must NOT be linkified as symbols ===
    'apply_patch',
    'exec_command',
    'shell_command',
    'update_plan',
    'view_image',
    'write_stdin',
    'create_goal',
    'update_goal',
    'get_goal',
    'request_user_input',
    'request_permissions',
    'curr_time',
    'get_context_remaining',
    'new_context',
    'wait_for_environment',
    'tool_search',
    'list_available_plugins_to_install',
    'request_plugin_install',
    'list_mcp_resources',
    'list_mcp_resource_templates',
    'read_mcp_resource',
    'report_agent_job_result',
    'spawn_agents_on_csv',
    'close_agent',
    'resume_agent',
    'send_input',
    'spawn_agent',
    'wait_agent',
    'followup_task',
    'interrupt_agent',
    'list_agents',
    'send_message',
    'extension_echo',
    'generated_image',
    'set_timeout',
    'yield_control',
    'all_tools',
    // === Kiro CLI tool names (from https://kiro.dev/docs/cli/hooks) ===
    'fs_read',
    'fs_write',
    'execute_bash',
    'use_aws',
  ]);
  /**
   * Render markdown text to HTML using marked.
   */
  private renderMarkdown(text: string): string {
    try {
      // Balance any unterminated code fence / inline backtick so PARTIAL text
      // (streaming render + interim commits at tool-call boundaries) doesn't
      // get rendered as a code block. See markdownBalance.ts for the full
      // rationale. A complete, balanced reply is returned unchanged.
      const balanced = balanceMarkdownForPartialRender(text);
      let html = marked.parse(balanced) as string;
      // Unwrap markdown links that point to non-file paths
      // (e.g. [3pp/sources/nats-c/](3pp/sources/nats-c/) -> plain text)
      // Keeps links to actual files (.ext) and @symbol: links; unwraps everything else
      html = html.replace(/<a\s+href="([^"]*)"[^>]*>(.*?)<\/a>/g, (match, href, inner) => {
        // Keep @symbol: links
        if (href.startsWith('@symbol:')) {
          return match;
        }
        // Keep http(s) links clickable — click handler opens external browser
        if (href.startsWith('http://') || href.startsWith('https://')) {
          return match;
        }
        // Keep file:// links clickable — click handler parses absolute file:// URLs
        if (href.startsWith('file://')) {
          return match;
        }
        // If href looks like a file path (contains a dot for extension)
        // but the link text is a symbol name (not a file path), convert to @symbol: link.
        // This handles cases where the LLM writes [function_name](file.c:123) — the LLM
        // guessed the wrong line, but LSP can find the exact definition.
        if (href.includes('.') && !href.endsWith('/') && !href.endsWith('/.')) {
          // If the href already includes a :line number, the LLM is telling us the
          // exact file and line. Respect it — don't convert to @symbol:, because LSP
          // may resolve to a different file (SDK header, stale index, sibling repo, etc.).
          // Only convert to @symbol: when there is no line number (LSP resolves the rest).
          if (/:\d+/.test(href)) {
            return match;
          }
          // Check if inner text looks like a symbol name (identifier) rather than a file path
          // Symbol names: snake_case, camelCase, PascalCase identifiers
          // File paths: contain / or \ or end with a file extension
          const looksLikeSymbol =
            /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(inner.trim()) &&
            !inner.includes('/') &&
            !inner.includes('\\') &&
            !/\.[a-zA-Z]{1,5}$/.test(inner.trim());
          if (looksLikeSymbol) {
            // But if the inner text is the filename stem of the href (e.g.
            // [ModernCppFeatures](docs/ModernCppFeatures.md)), keep it as a
            // file link — the LLM is linking to a file, not a symbol.
            const hrefBase = href.split('/').pop() || '';
            const hrefStem = hrefBase.replace(/\.[a-zA-Z0-9]+$/, '');
            if (hrefStem === inner.trim()) {
              return match;
            }
            // Skip C++ stdlib namespace and language keywords — not project symbols
            const symLower = inner.trim().toLowerCase();
            if (symLower.startsWith('std::') || ChatWebviewProvider.langKeywords.has(symLower)) {
              return `<span class="nolink">${inner}</span>`;
            }
            return `<a href="@symbol:${inner.trim()}" class="symbol-link">${inner}</a>`;
          }
          // Check if inner text looks like a file path (contains / or ends with
          // a known file extension). If so, keep it as a clickable file-link.
          // Otherwise (e.g. "X-Macro Pattern" linked to a file), unwrap to
          // plain text — the LLM made prose text into a link to a hallucinated file.
          const looksLikeFilePath =
            inner.includes('/') || inner.includes('\\') || /\.[a-zA-Z]{1,5}$/.test(inner.trim());
          if (looksLikeFilePath) {
            return match;
          }
          return `<span class="nolink">${inner}</span>`;
        }
        // Otherwise unwrap: return inner text without the <a> tag
        return `<span class="nolink">${inner}</span>`;
      });

      // --- Auto-linkify bare file paths and PascalCase symbols ---
      // Both transformations must skip <code>/<pre> blocks and existing <a>
      // tags.  We split the HTML on those elements, process only the text
      // in between, then rejoin.

      // File path regex: matches paths with optional :line or :line-range
      //   src/main.rs:74  |  application/.../Handler.h:69  |  Handler.h:98  |  Handler.h
      // Also matches bare filenames with known code extensions (no line number).
      const codeExt =
        '(?:c\\+\\+|h\\+\\+|hpp|hxx|htc|cpp|cxx|cc|hh|cu|cuh|tsx|jsx|mjs|cjs|pyi|pyw|kts|csx|fsx|exs|cljs|sc|sh|rs|py|go|java|kt|swift|ts|js|rb|cs|php|scala|bash|zsh|sql|proto|graphql|vue|svelte|zig|nim|lua|pl|pm|erl|clj|hs|ml|fs|elm|inl|tpp|ipp|mm|ex|jl|d|v|h|c|m|cmake|make|mk|gradle|toml|yaml|yml|json|xml|svg|txt|md|rst|cfg|conf|ini|env|lock|log|diff|patch|csv|tsv|wxs|wxi|wxl|iss|nsi|nsh|doxy|doxygen|dockerfile|gemspec|podspec|rake|gemfile|procfile|vagrantfile|bashrc|zshrc|vimrc|gitignore|gitattributes|editorconfig|dockerignore|npmrc|yarnrc|service|timer|socket|mount|automount|swap|link|path|network|netdev|plantuml|puml)';
      const filePathRegex = new RegExp(
        '(^|[^\\w\\/])' + // prefix: start or non-word, non-slash
          '(' +
          '(?:~\\/|\\.?\\/?[\\w.-]+\\/)+' + // at least one dir separator (path with /); ~/ home-relative dir
          '[\\w.-]*(?:\\s+[\\w.-]+)*\\.' + //   filename may be a dotfile or have spaces (e.g. "DI_Lodge SMF BGP Route Details.txt")
          codeExt +
          '(?::\\d+(?:-\\d+)?)?' + //   + filename.ext[:line[:-end]]
          '(?=$|[\\s,;:\\)\\]\\}\\<|])' + //   word boundary after extension
          '|' +
          '[\\w.-]+(?:\\s+[\\w.-]+)*\\.' + // bare filename.ext:line — allows spaces in filename (e.g. "DI_Lodge SMF BGP Route Details.txt:40")
          codeExt +
          '(?::\\d+(?:-\\d+)?)' + // bare filename.ext:line[:-end]
          '|' +
          '[\\w.-]*\\.' + //   bare filename may be a dotfile (.env, .md)
          codeExt +
          '(?=$|[\\s,;:\\)\\]\\}<|])' + // bare filename.ext (no line)
          ')',
        'g',
      );

      // PascalCase symbol regex: C++, Rust types, Go exported, Java, C#
      //   ConfigDataPrivate  |  N2ResModifyUpdateHandlerBase  |  PiafData  |  N11Info
      // Negative lookbehind (?<![:.]) skips namespaced types (std::Foo, boost::Bar)
      // and method calls (obj.MyMethod).
      // Negative lookbehind (?<![:._]) skips namespaced types (std::Foo, boost::Bar),
      // method calls (obj.MyMethod), and test_case names (TC12345_SomeTest).
      // Max length 40 chars to exclude very long generated test names.
      // Negative lookbehind (?<![\w:._]) blocks matching inside longer identifiers:
      // - IXmlConfigHandlerTx → 'I' is a word char, blocks 'XmlConfigHandlerTx'
      // - addSliceRouteReq → 'd' is a word char, blocks 'SliceRouteReq'
      // - std::Foo / obj.Method / TC123_Test → blocked by : . _
      // Lookahead excludes ':' so 'Service::Builder' doesn't match 'Service'
      const pascalCaseRegex = /(?<![\w:._])([A-Z][a-z0-9]+(?:[A-Z][a-zA-Z0-9]*)+)(?=$|[\s,;)\]\}<])/g;
      // snake_case symbol regex: Python, Rust functions, C, Go unexported
      //   process_data  |  get_user_info  |  handle_request
      // Excludes ALL_CAPS (constants). Requires 2+ underscore segments.
      // Negative lookbehind (?<![:.]) skips namespaced functions (std::to_underlying,
      // boost::split) and method calls (obj.get_data).
      const _snakeCaseRegex = /(?<![:.])([a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?=$|[\s,;:\)\]\}\.<])/g;
      const keywords = new Set([
        // Common tech/domain terms that are PascalCase but NOT code symbols
        'WebSocket',
        'WebSockets',
        'HttpServer',
        'HttpClient',
        'GitHub',
        'GitLab',
        'OpenAI',
        'JavaScript',
        'TypeScript',
        'MacOS',
        'NodeJS',
        'CMake',
        'ESLint',
        // Product/tool names that look like PascalCase but aren't code symbols
        'ChatGPT',
        'ClaudeCode',
        'GeminiCLI',
        'OpenCode',
        'TeraScript',
        'GoLang',
        'WSO2',
        'NATS',
        'MongoDB',
        'MySQL',
        'PostgreSQL',
        'SQLite',
        'ElasticSearch',
        'GitLab',
        'SonarQube',
        'ReactJS',
        'VueJS',
        'AngularJS',
        'NextJS',
        'NuxtJS',
        'ExpressJS',
        'SpringBoot',
        'DotNet',
        'AspNet',
        'MonoDevelop',
        'VisualStudio',
        'VSCode',
        'IntelliJ',
        'EclipseIDE',
        'NetBeans',
        'CLion',
        'PyCharm',
        'GoLand',
        'RustRover',
        'DataGrip',
        'AppCode',
        'RubyMine',
        'InnoDB',
        'MyISAM',
        'RabbitMQ',
        'KafkaMQ',
        'ActiveMQ',
        'ZeroMQ',
        'FreeRTOS',
        'MbedOS',
        'NuttX',
        'VxWorks',
        'QNX',
        'ThreadX',
        // More tech products/tools from web search
        'ActionScript',
        'AutoHotkey',
        'AutoIt',
        'BeanShell',
        'BlitzMax',
        'ColdFusion',
        'FoxPro',
        'FreeBASIC',
        'GraphTalk',
        'HyperText',
        'LabVIEW',
        'LiveCode',
        'NetRexx',
        'NoSQL',
        'PostScript',
        'PowerShell',
        'PureBasic',
        'CoffeeScript',
        'IronPython',
        'PyQt',
        'PySide',
        'WebAssembly',
        'ActiveState',
        'AppCode',
        'BitBucket',
        'BitKeeper',
        'ChromeOS',
        'ClearCase',
        'ClickHouse',
        'CockroachDB',
        'CodeLite',
        'CodePlex',
        'CodeWarrior',
        'CouchDB',
        'CrossOver',
        'DataGrip',
        'DbVisualizer',
        'DigitalOcean',
        'DuckDB',
        'DynamoDB',
        'FileMaker',
        'FlashDevelop',
        'FreeBSD',
        'FreeMarker',
        'FrontBase',
        'GoLand',
        'HeidiSQL',
        'JetBrains',
        'LaTeX',
        'MapReduce',
        'MariaDB',
        'MediaWiki',
        'MinGW',
        'MongoDB',
        'MonoDevelop',
        'MySQL',
        'NetBSD',
        'NetBeans',
        'NexusDB',
        'NiFi',
        'OpenBSD',
        'OpenOffice',
        'OpenVMS',
        'PhpStorm',
        'PostgreSQL',
        'PyCharm',
        'PyDev',
        'PyScripter',
        'QuickBASIC',
        'RocketMQ',
        'RubyMine',
        'RustRover',
        'ScalaIDE',
        'SlickEdit',
        'SourceForge',
        'SourceSafe',
        'SpamAssassin',
        'StarTeam',
        'TeamCity',
        'TypeScript',
        'VisualAge',
        'VisualWorks',
        'WebStorm',
        'WinRT',
        'ZooKeeper',
        'BigQuery',
        'CrateDB',
        'HiveMQ',
        'JestJS',
        'KarmaJS',
        'MochaJS',
        'SinonJS',
        'ChaiJS',
        'BabylonJS',
        'ThreeJS',
        'ChartJS',
        'D3JS',
        'MomentJS',
        'DayJS',
        'LodashJS',
        'UnderscoreJS',
        'ImmutableJS',
        'RamdaJS',
        'RxJS',
        'ReduxJS',
        'MobXJS',
        'ZustandJS',
        'PiniaJS',
        'VuexJS',
        'NgrxJS',
        'NestJS',
        'FastAPI',
        'ActixWeb',
        'GinGonic',
        'EchoGo',
        'FiberGo',
        'ChiGo',
        'BuffaloGo',
        'SpringBoot',
        'PlayFramework',
        'HBase',
        'ArangoDB',
        'OrientDB',
        'JanusGraph',
        'TigerGraph',
        'TeamCity',
        'CircleCI',
        'TravisCI',
        'DroneCI',
        'ConcourseCI',
        'ArgoCD',
        'FluxCD',
        'CodeDeploy',
        'SaltStack',
        'CloudInit',
        'HCL',
        'CueLang',
        // Additional tech products from web search (Wikipedia)
        // Programming languages
        'AdvPL',
        'AmbientTalk',
        'AngelScript',
        'ArkTS',
        'AssemblyScript',
        'CobolScript',
        'DataFlex',
        'HyperTalk',
        'KiXtart',
        'LilyPond',
        'LiveCode',
        'LotusScript',
        'NetLogo',
        'NetRexx',
        'NewLISP',
        'NewtonScript',
        'ObjectLOGO',
        'OmniMark',
        'OpenCL',
        'OpenQASM',
        'OptimJ',
        'PeopleCode',
        'PowerBuilder',
        'PureScript',
        'QtScript',
        'QuakeC',
        'ReScript',
        'SabreTalk',
        'SenseTalk',
        'SequenceL',
        'SuperCollider',
        'SuperTalk',
        'UnrealScript',
        'VisualFoxPro',
        'ZetaLisp',
        'ScratchJr',
        // Databases
        'AllegroGraph',
        'ArangoDB',
        'BaseX',
        'CouchDB',
        'DocumentDB',
        'FlockDB',
        'FoundationDB',
        'GigaSpaces',
        'InfiniteGraph',
        'InfinityDB',
        'JanusGraph',
        'MarkLogic',
        'MemcacheDB',
        'ObjectDB',
        'ObjectStore',
        'OrientDB',
        'RavenDB',
        'RethinkDB',
        'TerminusDB',
        'SolidDB',
        'MonetDB',
        'NuoDB',
        'LucidDB',
        'SingleStore',
        'InterBase',
        'MaxDB',
        // Messaging
        'HornetQ',
        // OS/Platforms
        'AmigaOS',
        'AppArmor',
        'ArcaOS',
        'ChromiumOS',
        'EComStation',
        'EulerOS',
        'GhostBSD',
        'HarmonyOS',
        'LiteOS',
        'MirageOS',
        'TempleOS',
        // Web servers
        'BusyBox',
        'GlassFish',
        'NaviServer',
        'OpenResty',
        'WildFly',
        // Cloud/DevOps
        'CloudBees',
        'CloudControl',
        'CloudForge',
        'CruiseControl',
        'OutSystems',
        // Source control
        'BitKeeper',
        'CodePlex',
        'CollabNet',
        'FusionForge',
        'RhodeCode',
        'StarTeam',
        'BerliOS',
        // IDE/Editors
        'BlueJ',
        'CodeWarrior',
        'EiffelStudio',
        'LispWorks',
        'SlickEdit',
        'IntelliJ',
        // Frameworks
        'PlayFramework',
        // JS testing/libraries
        'BabylonJS',
        'ThreeJS',
        'ChartJS',
        'D3JS',
        'MomentJS',
        'DayJS',
        'LodashJS',
        'UnderscoreJS',
        'ImmutableJS',
        'RamdaJS',
        'RxJS',
        'ReduxJS',
        'MobXJS',
        'ZustandJS',
        'PiniaJS',
        'VuexJS',
        'NgrxJS',
        'JestJS',
        'KarmaJS',
        'MochaJS',
        'SinonJS',
        'ChaiJS',
      ]);

      // Common English snake_case phrases to exclude from linkification
      const _snakeKeywords = new Set([
        'a_b',
        'a_c',
        'x_y',
        'x_z',
        'y_z',
        'a_few',
        'a_lot',
        'a_bit',
        'as_well',
        'at_least',
        'at_most',
        'by_default',
        'for_example',
        'for_instance',
        'in_general',
        'in_particular',
        'in_order',
        'in_place',
        'on_purpose',
        'so_that',
        'such_as',
        'to_do',
        'up_to',
        'use_case',
        'use_cases',
        'work_around',
        'wrap_up',
        'end_of',
        'start_of',
        'type_of',
        'kind_of',
        'sort_of',
        'out_of',
        'off_of',
        'none_of',
        'some_of',
        'many_of',
        'most_of',
        'all_of',
        'each_of',
        'both_of',
        'few_of',
        'more_of',
        'much_of',
        'little_of',
        'enough_of',
        'in_case',
        'just_like',
        'rather_than',
        'other_than',
        'more_than',
        'less_than',
        // C++ stdlib names (belt-and-suspenders with the :: lookbehind)
        'to_underlying',
        'flat_map',
        'flat_set',
        'flat_multimap',
        'flat_multiset',
        'move_only_function',
        'from_chars',
        'to_chars',
        'to_string',
        'to_wstring',
        'get_if',
        'holds_alternative',
        'forward_as_tuple',
        'make_tuple',
        'make_pair',
        'make_shared',
        'make_unique',
        'make_optional',
        'hash_combine',
        'variant_alternative',
        'tuple_element',
        'tuple_size',
        // Python stdlib / builtins (belt-and-suspenders with the :: lookbehind)
        'isinstance',
        'issubclass',
        'hasattr',
        'getattr',
        'setattr',
        'delattr',
        'is_none',
        'is_not',
        'not_none',
        'get_type',
        'set_type',
        'get_name',
        'set_name',
        'to_dict',
        'from_dict',
        'to_list',
        'from_list',
        'to_json',
        'from_json',
        'get_logger',
        'set_logger',
        'get_config',
        'set_config',
        'get_default',
        'set_default',
        'get_env',
        'set_env',
        'type_hints',
        'type_check',
        'type_hint',
        'get_type_hints',
        'dataclass_transform',
        'runtime_checkable',
        'get_origin',
        'get_args',
        'typing_extensions',
        'asyncio_run',
        'asyncio_sleep',
        'asyncio_gather',
        'copy_deepcopy',
        'copy_copy',
        'partial_func',
        'wraps_func',
      ]);

      // Split on <pre> blocks, <code> blocks, and existing <a> tags.
      // Even indices = plain text (prose); odd indices = HTML elements to skip.
      // For snake_case linkification, we need a second pass that splits on
      // <code> tags too, so we only linkify snake_case inside code spans.
      const splitRegex = new RegExp(
        `(${ACP_MATH_SPLIT_RE}|<pre>.*?</pre>|<span class="nolink">.*?</span>|<a\\s[^>]*>.*?</a>|https?:\\/\\/[^\\s<]+|www\\.[^\\s<]+|file:\\/\\/\\/[^\\s<"]+|(?:github|gitlab|bitbucket|stackoverflow|developer\\.mozilla|en\\.wikipedia|docs\\.python|docs\\.rust-lang|crates\\.io|pypi\\.org|npmjs\\.com|docs\\.oracle|learn\\.microsoft|developer\\.android|kubernetes\\.io|docker\\.com|nodejs\\.org|python\\.org|go\\.dev|rust-lang\\.org|swift\\.org|jetbrains\\.com|visualstudio\\.com|atlassian\\.com|confluence\\.atlassian|jira\\.atlassian|gerrit\\.googlesource|gerrit-review\\.googlesource)\\.[a-z]+\\/[^\\s<]+)`,
        'gs',
      );
      const splitRegexWithFileRef = new RegExp(
        `(${ACP_MATH_SPLIT_RE}|<pre>.*?</pre>|<code>.*?</code>|<span class="nolink">.*?</span>|<span class="file-ref">.*?</span>|<a\\s[^>]*>.*?</a>|https?:\\/\\/[^\\s<]+|www\\.[^\\s<]+|file:\\/\\/\\/[^\\s<"]+|(?:github|gitlab|bitbucket|stackoverflow|developer\\.mozilla|en\\.wikipedia|docs\\.python|docs\\.rust-lang|crates\\.io|pypi\\.org|npmjs\\.com|docs\\.oracle|learn\\.microsoft|developer\\.android|kubernetes\\.io|docker\\.com|nodejs\\.org|python\\.org|go\\.dev|rust-lang\\.org|swift\\.org|jetbrains\\.com|visualstudio\\.com|atlassian\\.com|confluence\\.atlassian|jira\\.atlassian|gerrit\\.googlesource|gerrit-review\\.googlesource)\\.[a-z]+\\/[^\\s<]+)`,
        'gs',
      );

      // Pass 1: linkify file paths (creates new <a> tags)
      let parts = html.split(splitRegex);
      for (let pi = 0; pi < parts.length; pi++) {
        if (pi % 2 === 1) {
          continue;
        }
        parts[pi] = parts[pi].replace(filePathRegex, (match, prefix, pathMatch) => {
          const colonIdx = pathMatch.lastIndexOf(':');
          let path = pathMatch;
          let line = undefined;
          let lineEnd = undefined;
          if (colonIdx > 0) {
            const afterColon = pathMatch.slice(colonIdx + 1);
            const dashIdx = afterColon.indexOf('-');
            let lineStr, endStr;
            if (dashIdx > 0) {
              lineStr = afterColon.slice(0, dashIdx);
              endStr = afterColon.slice(dashIdx + 1);
            } else {
              lineStr = afterColon;
              endStr = null;
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
          // Bare file path without line number — render as clickable file-link
          return `${prefix}<a href="#" class="file-link bare-file-link" data-file="${path}">${path}</a>`;
        });
      }
      html = parts.join('');

      // Pass 2: linkify symbols.
      // PascalCase: linkify everywhere (prose + code) — they're almost always
      //   real type/class names, not English words.
      // snake_case: linkify ONLY inside <code> tags — in prose, snake_case
      //   words like 'response_id' or 'logging_to_file' are usually variable
      //   references in narrative text, not clickable symbols.
      parts = html.split(splitRegexWithFileRef);
      for (let pi = 0; pi < parts.length; pi++) {
        if (pi % 2 === 1) {
          continue;
        }
        // PascalCase symbols (C++, Rust types, Go exported, Java, C#)
        parts[pi] = parts[pi].replace(pascalCaseRegex, (match, sym) => {
          if (keywords.has(sym)) {
            return match;
          }
          if (!/[a-z]/.test(sym)) {
            return match;
          }
          // Skip very long symbols (>40 chars) — almost certainly generated
          // test case names, not real type/class names.
          if (sym.length > 40) {
            return match;
          }
          return `<a href="@symbol:${sym}" class="symbol-link">${sym}</a>`;
        });
      }
      html = parts.join('');

      // Pass 2a: linkify C/Rust typedef-style identifiers ending with _t (e.g.
      // icr_gen_state_msg_t, my_struct_t, uint32_t). The _t suffix is a very
      // strong signal in C that this is a type name, not a variable.  We
      // linkify these in prose too (not just <code>), because the model often
      // references type names in narrative text. Standard types like uint32_t
      // won't be found in project source, so clicking them harmlessly falls back
      // to Quick Open.
      const typedefRegex = /(?<![\w:._])([a-zA-Z_][a-zA-Z0-9_]*_t)(?=$|[\s,;:\)\]\}\.<])/g;
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

      // Pass 2b: linkify function_name() and Type::method() patterns inside <code> tags.
      // The model often writes `icrlib_client_send_client_msg()` or `FenAdapter::init()`
      // as backtick code instead of as a markdown link. Convert these to @symbol: links.
      // handleOpenSymbol has ripgrep fallback to handle cases where LSP finds the wrong file.
      // Pass 2b: linkify function_name(), Type::method(), and bare symbol_name patterns
      // inside <code> tags. The model often writes `icrlib_client_send_client_msg()` or
      // `FenAdapter::init()` or `up_icr_adapter_client_create` as backtick code instead
      // of as a markdown link. Convert these to @symbol: links.
      const codeSymKw = [...ChatWebviewProvider.langKeywords];
      html = html.replace(
        /<code>([a-zA-Z_][a-zA-Z0-9_]*(?:::[a-zA-Z_][a-zA-Z0-9_]*)*)(\(\))?<\/code>/g,
        (match, symName, parens) => {
          if (codeSymKw.includes(symName.toLowerCase())) {
            return match;
          }
          // Skip ALL_CAPS identifiers (CMake variables like CMAKE_CONFIGURE_DEPENDS,
          // constants like MAX_BUFFER_SIZE, macros like NDEBUG). These are almost
          // never clickable project symbols and produce false-positive links.
          if (/^[A-Z][A-Z0-9_]*$/.test(symName) && symName.includes('_')) {
            return match;
          }
          // Skip C++ stdlib namespace (std::variant, std::string, std::vector, etc.)
          if (symName.startsWith('std::')) {
            return match;
          }
          // Must have at least one underscore (snake_case), or contain :: (namespaced),
          // or be true PascalCase (2+ uppercase letters with lowercase).
          // Single capitalized words like Tagged or Union should NOT be linkified.
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

      // Pass 3: Linkify "function_name (file.ext:line)" or "function_name(file:line)"
      // patterns where the model wrote a symbol followed by a file:line in parens.
      // This converts the whole thing into a single @symbol link so the user
      // can click the function name, not just the file path.
      // Matches: cl_create_http_server (cl_main.c:170)  |  main() (cl_main.c:519)
      //          process_line (translate_response.rs:130)
      html = html.replace(
        /([a-zA-Z_][a-zA-Z0-9_]*)\s*\(\s*([\w.-]+\.[a-zA-Z]+)(?::(\d+))?\s*\)/g,
        (match, symName, fileName, lineNum) => {
          // Skip if already inside an <a> tag (check by looking at preceding context)
          // The regex only runs on text outside <a> tags because we split on <a> above
          // and this runs after join. However, to be safe, skip common keywords.
          const keywords = [
            'if',
            'for',
            'while',
            'switch',
            'return',
            'sizeof',
            'typeof',
            'apply_patch',
            'exec_command',
            'shell_command',
            'shell',
            'update_plan',
            'view_image',
            'write_stdin',
            'create_goal',
            'update_goal',
            'get_goal',
            'request_user_input',
            'request_permissions',
            'sleep',
            'curr_time',
            'get_context_remaining',
            'new_context',
            'wait_for_environment',
            'tool_search',
            'list_available_plugins_to_install',
            'request_plugin_install',
            'list_mcp_resources',
            'list_mcp_resource_templates',
            'read_mcp_resource',
            'report_agent_job_result',
            'spawn_agents_on_csv',
            'close_agent',
            'resume_agent',
            'send_input',
            'spawn_agent',
            'wait_agent',
            'followup_task',
            'interrupt_agent',
            'list_agents',
            'send_message',
            'imagegen',
            'extension_echo',
            'wait',
            'exec',
            'exit',
            'text',
            'image',
            'generated_image',
            'generatedimage',
            'store',
            'load',
            'notify',
            'set_timeout',
            'cleartimeout',
            'yield_control',
            'all_tools',
            'fs_read',
            'fs_write',
            'execute_bash',
            'use_aws',
            'function',
            'def',
            'class',
            'struct',
            'enum',
            'union',
            'typedef',
            'static',
            'const',
            'void',
            'int',
            'char',
            'double',
            'float',
            'bool',
            'auto',
            'var',
            'let',
          ];
          if (keywords.includes(symName.toLowerCase())) {
            return match;
          }
          // Skip ALL_CAPS identifiers (CMake variables, constants, macros).
          if (/^[A-Z][A-Z0-9_]*$/.test(symName) && symName.includes('_')) {
            return match;
          }
          // Must have a file extension to be a real file reference
          if (!fileName.includes('.')) {
            return match;
          }
          // Build the display text: function_name (file:line)
          const display = lineNum ? `${symName} (${fileName}:${lineNum})` : `${symName} (${fileName})`;
          // With :line number → @symbol: link (LSP resolves exact definition)
          // Without :line → file-link (opens the file, symbol name may be ambiguous)
          if (lineNum) {
            return `<a href="@symbol:${symName}" class="symbol-link">${display}</a>`;
          }
          return `<a href="#" class="file-link" data-file="${fileName}">${display}</a>`;
        },
      );

      // Note: snake_case symbols are NOT linkified standalone — too many false positives
      // (variable names like 'response_id', 'logging_to_file' in prose and code).
      // PascalCase covers the primary use case (C++/Rust/Java/Go type names).
      // File paths with :line are handled by Pass 1 above.
      // The "function_name (file:line)" pattern above handles the common case
      // where the model writes a symbol next to its file location.
      return html;
    } catch {
      return this.escapeHtml(text);
    }
  }

  private escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    const debugResumeConfigSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('acp.debugResume')) {
        this.postDebugResumeConfig();
      }
      if (e.affectsConfiguration('acp.voice.enabled')) {
        const enabled = vscode.workspace.getConfiguration('acp.voice').get<boolean>('enabled', true);
        if (!enabled) {
          // Feature switched off mid-take — kill the recorder so the
          // process doesn't leak into a webview that no longer shows the mic.
          this.voiceInput.cancel();
        }
        this.postMessage({ type: 'voiceEnabled', enabled });
      }
    });
    webviewView.onDidDispose(() => {
      debugResumeConfigSub.dispose();
      // A disposed webview can never receive the transcript — kill any
      // in-flight recording so the recorder process doesn't leak.
      this.voiceInput.cancel();
    });

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'sendPrompt':
          this._hasChatContent = true;
          await this.handleSendPrompt(message.text, message.images);
          break;
        case 'executeKiroCommand':
          this._hasChatContent = true;
          await this.handleExecuteKiroCommandFromWebview(message.command, message.args);
          break;
        case 'renameSession':
          this.handleRenameSession(message.title);
          break;
        case 'cancelTurn':
          await this.handleCancelTurn();
          break;
        case 'voiceToggle':
          await this.voiceInput.toggle();
          break;
        case 'steerPrompt':
          await this.handleSteerPrompt(message.text);
          break;
        case 'stopProcesses':
          await this.handleStopProcesses(message.suppressNotice);
          break;
        case 'setMode':
          await this.handleSetMode(message.modeId);
          break;
        case 'setModel':
          await this.handleSetModel(message.modelId);
          break;
        case 'setConfigOption':
          await this.handleSetConfigOption(message.configId, message.value);
          break;
        case 'goalControl':
          if (this.sessionManager.getActiveSessionId()) {
            await this.sessionManager.goalControl(this.sessionManager.getActiveSessionId()!, message.action);
          }
          break;
        case 'executeCommand':
          if (message.command) {
            if (message.command === 'acp.connectAgent') {
              const run = this.connectAgentCommandChain.then(() =>
                vscode.commands.executeCommand(message.command, ...(message.args || [])),
              );
              this.connectAgentCommandChain = run.catch(() => undefined);
              await run;
            } else {
              await vscode.commands.executeCommand(message.command, ...(message.args || []));
            }
          }
          break;
        case 'cursorRequestToolEnrich':
          this.scheduleCursorBatchEnrich(
            message.sessionId || this.sessionManager.getActiveSessionId(),
            typeof message.reason === 'string' ? message.reason : undefined,
          );
          break;
        case 'ready':
          // Webview loaded — flush any queued messages, then send state
          this.webviewReady = true;
          if (this.pendingMessages.length > 0) {
            for (const msg of this.pendingMessages) {
              this.view?.webview.postMessage(msg);
            }
            this.pendingMessages = [];
          }
          // sendCurrentState is skipped if a load is in progress (handled
          // by the isLoading guard inside sendCurrentState itself).
          this.sendCurrentState();
          this.postDebugResumeConfig();
          this.scheduleCursorBatchEnrich(this.sessionManager.getActiveSessionId());
          break;
        case 'openDiff':
          await this.handleOpenDiff(message.toolCallId);
          break;
        case 'openFile':
          await this.handleOpenFile(message.filePath, message.lineNumber, message.lineEnd, message.linkText);
          break;
        case 'openSymbol':
          await this.handleOpenSymbol(message.symbolName);
          break;
        case 'openExternalUrl':
          await this.handleOpenExternalUrl(message.url);
          break;
        case 'pickContext':
          await this.handlePickContext(message.contextType);
          break;
        case 'copyToClipboard':
          vscode.env.clipboard.writeText(message.text || '');
          break;
        case 'summarizeSession':
          await this.handleSummarizeSessionCommand(message.sessionName, message.queryText);
          break;
        case 'getSessionNames':
          this.handleGetSessionNames();
          break;
        case 'toggleFollowAgent':
          this.toggleFollow();
          break;
        case 'requestConversationExport':
          // Extension host requests the current conversation for forking to
          // another agent. Forward to webview which has chatHistory access.
          this.postMessage({ type: 'requestConversationExport' });
          break;
        case 'conversationExported':
          // Webview responded with the formatted conversation — forward to
          // whoever is waiting (the forkToAgent command). `messages` may be
          // absent when an older webview build is still loaded.
          this._conversationExportResolver?.({
            text: typeof message.text === 'string' ? message.text : '',
            messages: Array.isArray(message.messages) ? message.messages : [],
            exportStartsAtCompactionBoundary: message.exportStartsAtCompactionBoundary === true,
            compactionInProgress: message.compactionInProgress === true,
          });
          this._conversationExportResolver = undefined;
          break;
        case 'compactionCompleted':
          // The webview finished wiping the conversation after compaction
          // (manual /compact or engine auto-compaction). The previously
          // injected memory profile + skills block was summarized away with
          // the wiped history, so reset the memory-inject gates for this
          // session — the next real prompt will do a full re-inject (persona
          // + scenes + <available_skills>) instead of being gated to l1-only.
          if (message.sessionId || this.sessionManager.getActiveSessionId()) {
            this.sessionManager.onContextCompacted(
              (message.sessionId as string) || this.sessionManager.getActiveSessionId()!,
              typeof message.summaryText === 'string' ? message.summaryText : undefined,
            );
            if (DEBUG) {
              log(
                `[MEM-CACHE] compaction completed → reset memory-inject gates for ` +
                  `session=${(message.sessionId as string) || this.sessionManager.getActiveSessionId()}`,
              );
            }
          }
          break;
        case 'renderMarkdown': {
          // Webview requests markdown rendering for history items
          const items: Array<{ index: number; text: string; gen?: number; hgen?: number }> = message.items || [];
          if (DEBUG) {
            log(
              `[DEBUG-MD] renderMarkdown request: ${items.length} items, indices=[${items.map((i) => i.index).join(',')}]`,
            );
          }
          const rendered = items.map((item: { index: number; text: string; gen?: number; hgen?: number }) => ({
            index: item.index,
            html: this.renderMarkdown(item.text),
            gen: item.gen,
            hgen: item.hgen,
          }));
          if (DEBUG) {
            log(
              `[DEBUG-MD] renderMarkdown response: ${rendered.length} items rendered, html lengths=[${rendered.map((i) => i.html.length).join(',')}]`,
            );
          }
          this.postMessage({ type: 'markdownRendered', items: rendered });
          break;
        }
        case 'debugLog': {
          const wvMsg = message.message || '(empty)';
          // TEMP-DEBUG (copy button / cannot-send investigation): forward
          // every webview debugLog to the ACP Client log so a repro captures
          // the latch state. Gated behind DEBUG_LIVE (default off) so normal
          // use stays silent — flip DEBUG_LIVE (or keep DEBUG/acp.debugResume)
          // to re-enable whenever the trace is needed again.
          if (DEBUG_LIVE) {
            log('[DEBUG-WV] ' + wvMsg);
          } else if (DEBUG) {
            log('[DEBUG-WV] ' + wvMsg);
          } else if (this.isDebugResume() && isResumeDiagWebviewMessage(wvMsg)) {
            this.logResumeDiag('[DEBUG-WV] ' + wvMsg);
          }
          break;
        }
      }
    });

    webviewView.onDidDispose(() => {
      this.view = undefined;
      this.webviewReady = false;
    });
  }

  /**
   * Forward session update to webview.
   */
  private handleSessionUpdate(update: SessionNotification): void {
    if (this.suppressWebviewUpdates) {
      return;
    }
    // Suppress late session/update events from a turn that was abandoned by
    // the cancel fallback (agent ignored session/cancel for 5s). The webview
    // already got promptEnd(cancelled); forwarding these would interleave the
    // old turn's tool calls / message chunks into the next prompt and drop or
    // mangle user messages. Cleared when a new prompt starts (handleSendPrompt).
    if (this._abandonedTurnSessions.has(update.sessionId)) {
      if (DEBUG) {
        log(`Suppressing late session/update (${String(update.update?.sessionUpdate || '')}) for abandoned turn session ${update.sessionId}`);
      }
      return;
    }
    const updateData = update.update as any;

    const activeIdForTrace = this.sessionManager.getActiveSessionId();
    this.logCursorSessionUpdate(update.sessionId, updateData, activeIdForTrace);

    // Debug: log user_message_chunk updates (especially during session/load replay).
    if (updateData?.sessionUpdate === 'user_message_chunk') {
      const content = updateData.content;
      if (content?.type === 'text' && typeof content.text === 'string') {
        const preview = content.text.length > 200 ? content.text.substring(0, 200) + '...' : content.text;
        const isLoading = this.sessionManager.isLoading(update.sessionId);
        if (DEBUG) {
          log(
            '[DEBUG-UMC] user_message_chunk received on ext host: len=' +
              content.text.length +
              ' text="' +
              preview +
              '"',
          );
        }
        if (this.isDebugResume()) {
          this.logResumeDiag(
            `[WV-DIAG] ext UMC: loading=${isLoading} session=${String(update.sessionId).slice(0, 8)} len=${content.text.length} text="${preview.replace(/\n/g, '\\n')}"`,
          );
        }
      }
    }

    // Persist session state BEFORE the active-session check. During session
    // creation the agent can dispatch notifications (e.g.
    // `available_commands_update`) before connectToAgent finishes setting
    // `activeSessionId`. Without this, those updates would be dropped and
    // the slash-command popup would never have commands to show.
    if (updateData?.sessionUpdate === 'available_commands_update') {
      this.sessionManager.applyAvailableCommands(update.sessionId, updateData.availableCommands || []);
    }
    if (updateData?.sessionUpdate === 'config_option_update') {
      this.sessionManager.applyConfigOptions(update.sessionId, updateData.configOptions || []);
    }
    if (updateData?.sessionUpdate === 'session_info_update') {
      this.sessionManager.applySessionInfoUpdate(update.sessionId, {
        title: updateData.title,
        updatedAt: updateData.updatedAt,
      });
      // Forward goal snapshot from _meta.codex.goal (codex-acp extension).
      // The raw update is already forwarded to the webview below, but we
      // also store it on the session for the webview restore path.
      // Read _meta from the UPDATE DATA level (updateData), not the
      // notification level. The ACP SDK wraps agent updates as:
      //   { sessionId, update: { sessionUpdate: "...", _meta: {...} } }
      // SessionInfoUpdate._meta lives inside update.update, so we must
      // read updateData._meta, NOT update._meta (which is the notification-
      // level _meta and is typically undefined for session_info_update).
      const goalMeta = updateData?._meta?.codex?.goal;
      if (goalMeta !== undefined) {
        this.applyGoalSnapshot(update.sessionId, goalMeta);
      }
    }

    // Only forward to the webview if this is the active session — the
    // webview only ever shows one session at a time.
    const activeId = this.sessionManager.getActiveSessionId();
    // [DEBUG-SUBAGENT] Trace which session agent_message_chunk events come from
    if (
      DEBUG &&
      (updateData?.sessionUpdate === 'agent_message_chunk' || updateData?.sessionUpdate === 'agent_thought_chunk')
    ) {
      const preview = updateData?.content?.text ? updateData.content.text.replace(/\\s+/g, ' ').slice(0, 60) : '';
      log(
        `[DEBUG-SUBAGENT] ${updateData.sessionUpdate} session=${update.sessionId} active=${activeId} match=${update.sessionId === activeId} text="${preview}"`,
      );
    }
    if (update.sessionId !== activeId) {
      return;
    }

    // Coalesce per-token streaming chunks. Codex emits agent_message_chunk /
    // agent_thought_chunk once per LLM delta — typically dozens per second.
    // Buffer the text for a few milliseconds and ship one combined chunk to
    // the webview. Flush synchronously before any other event so ordering
    // is preserved (text-then-tool-call shows up in that order).
    const updateKind = updateData?.sessionUpdate as string | undefined;
    if (
      (updateKind === 'agent_message_chunk' || updateKind === 'agent_thought_chunk') &&
      updateData?.content?.type === 'text' &&
      typeof updateData.content.text === 'string' &&
      updateData.content.text.length > 0
    ) {
      // Suppress the agent's own "/stop" kill notice (codex emits
      // "🛑 Killed N running process(es)." as an agent_message_chunk). It
      // would render as a PERSISTENT assistant bubble and stick in the chat
      // forever. The webview shows its own transient (auto-vanishing)
      // "Killed N..." notice in the processesStopped handler instead, so we
      // drop the agent's copy here to avoid a permanent "Killed" line.
      if (
        updateKind === 'agent_message_chunk' &&
        // codex emits "🛑 Killed N running process(es)." — the "Killed" word
        // sits between the emoji and the count, so match it optionally.
        /^\s*🛑\s*(?:Killed\s+)?\d+\s+running process(?:es)?\.?/.test(
          updateData.content.text,
        )
      ) {
        return;
      }
      this.streamCoalescer.append(
        activeId,
        updateKind === 'agent_message_chunk' ? 'message' : 'thought',
        updateData.content.text,
        // Forward the ACP messageId so same-message chunks coalesce into one
        // run and reach the webview tagged for bubble grouping.
        typeof updateData.messageId === 'string' ? updateData.messageId : undefined,
      );
      // TEMP-DEBUG: trace every appended chunk so we can see WHEN the Kiro
      // "/effort xhigh" echo text enters the pipeline (load-replay tail vs
      // live post-load) and whether it precedes/follows promptEnd.
      if (DEBUG_LIVE) {
        log(
          `HOST-CHUNK-APPEND: kind=${updateKind === 'agent_message_chunk' ? 'message' : 'thought'} session=${activeId} len=${updateData.content.text.length} text="${updateData.content.text.replace(/\\s+/g, ' ').slice(0, 50)}" isLoadingSession=${this.sessionManager.isLoading(activeId)} inFlight=${this.sessionManager.isPromptInFlight(activeId)}`,
        );
      }
      return;
    }
    // Any non-chunk update must come after the buffered text so users see
    // the prose before the tool call / plan / completion marker.
    this.streamCoalescer.flush(activeId);

    // Capture diff content from tool calls for later display
    if (updateData?.sessionUpdate === 'tool_call' || updateData?.sessionUpdate === 'tool_call_update') {
      const id = updateData.toolCallId;
      const content = updateData.content as
        Array<{ type: string; path?: string; oldText?: string; newText?: string }> | undefined;
      if (id && content) {
        // Codex apply_patch sends {"type":"diff","oldText":"...","newText":"..."}
        // without a "path" field. Extract path from the tool call title so
        // the diff viewer and tooltip still work.
        const tcTitle = (updateData as any)?.title || '';
        const titlePath = tcTitle.match(/'([^']+)'|"([^"]+)"/);
        const fallbackPath = titlePath ? titlePath[1] || titlePath[2] || '' : '';
        const diffs = content
          .filter((c: any) => c.type === 'diff')
          .map((c: any) => (c.path ? c : { ...c, path: c.path || fallbackPath }))
          .filter((c: any) => c.path);
        if (diffs.length > 0) {
          this.toolCallDiffs.set(
            id,
            diffs.map((d: any) => ({ path: d.path, oldText: d.oldText, newText: d.newText })),
          );
        }
      }

      // Follow Agent: every tool call may include `locations: ToolCallLocation[]`.
      // When following, open the first location in the editor. See
      // ../core/FollowAgent.ts and Zed's
      // `crates/workspace/src/workspace.rs::handle_agent_location_changed`.
      if (this._isFollowing) {
        const locations = updateData.locations as ToolCallLocationLike[] | undefined;
        const session = this.sessionManager.getSession(activeId);
        const target = pickFollowTarget(locations, {
          sessionCwd: session?.cwd,
          workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
          homeDir: process.env.HOME,
        });
        if (target) {
          this.followCoalescer.submit(target);
        }
      }

      // Normalize the one-line title: drop Kiro CLI's `Running: ` label and a
      // redundant shell / `cd <dir> &&` preamble, matching what codex-acp
      // already does agent-side so a row reads the same for every agent. The
      // untouched command stays in rawInput for the tooltip and diff viewer.
      // Applying this to an already-normalized Codex title is a no-op.
      if (typeof updateData.title === 'string' && updateData.title) {
        const cleanedTitle = cleanAgentToolTitle(
          updateData.title,
          this.sessionManager.getSession(activeId)?.cwd,
          updateData.rawInput,
        );
        if (cleanedTitle && cleanedTitle !== updateData.title) {
          updateData.title = cleanedTitle;
        }
      }
    }

    // Plan "file" type: the webview cannot read files, so resolve the URI
    // here at the extension host and rewrite it as a "markdown" plan update
    // before forwarding to the webview.
    const upd = update.update as any;
    if (upd?.sessionUpdate === 'plan_update' && upd.plan?.type === 'file' && upd.plan?.uri) {
      void this.resolvePlanFile(upd).then((resolved) => {
        this.postMessage({
          type: 'sessionUpdate',
          update: resolved,
          sessionId: update.sessionId,
          isLoading: this.sessionManager.isLoading(update.sessionId),
        });
      });
      return;
    }

    this.postMessage({
      type: 'sessionUpdate',
      update: update.update,
      sessionId: update.sessionId,
      isLoading: this.sessionManager.isLoading(update.sessionId),
    });

    // Cursor: stub tool titles / empty rawInput — recover path/pattern from store.db
    // and push a follow-up tool_call_update so the webview title + tooltip update.
    if (updateData?.sessionUpdate === 'tool_call' || updateData?.sessionUpdate === 'tool_call_update') {
      this.noteCursorToolArgsIfPresent(update.sessionId, updateData);
    }
    void this.maybeEnrichCursorToolCall(update.sessionId, updateData);
    // Live per-tool enrich is deferred while the turn is in flight (see
    // maybeEnrichCursorToolCall). Batch enrich is post-merge/restore only.
  }

  private getCursorToolEnricher(sessionId: string): CursorSessionToolEnricher {
    let enricher = this.cursorToolEnrichers.get(sessionId);
    if (!enricher) {
      enricher = new CursorSessionToolEnricher(sessionId);
      this.cursorToolEnrichers.set(sessionId, enricher);
    }
    return enricher;
  }

  /**
   * Remember tool calls whose wire payload already has paths/commands so a
   * later bare tool_call_update (status-only) does not re-poll store.db.
   */
  private noteCursorToolArgsIfPresent(sessionId: string, updateData: any): void {
    const toolCallId = updateData?.toolCallId as string | undefined;
    if (!toolCallId) return;
    const key = `${sessionId}::${toolCallId}`;
    const rawInput = updateData.rawInput;
    if (
      rawInput &&
      typeof rawInput === 'object' &&
      !Array.isArray(rawInput) &&
      hasActionableToolArgs(rawInput as Record<string, unknown>)
    ) {
      this.cursorToolArgsSatisfied.add(key);
      return;
    }
    const title = updateData.title;
    if (typeof title === 'string' && title.trim() && !isCursorStubToolTitle(title)) {
      this.cursorToolArgsSatisfied.add(key);
    }
  }

  /**
   * When Cursor ACP sends tool_call with empty rawInput, poll store.db for
   * the real args and emit a synthetic tool_call_update.
   */
  private async maybeEnrichCursorToolCall(
    sessionId: string,
    updateData: any,
    options?: { force?: boolean },
  ): Promise<void> {
    try {
      if (!needsCursorToolEnrichment(updateData)) return;
      const toolCallId = updateData.toolCallId as string;
      if (!toolCallId || String(toolCallId).startsWith('replay-')) return;
      const satisfiedKey = `${sessionId}::${toolCallId}`;
      if (this.cursorToolArgsSatisfied.has(satisfiedKey)) return;
      // session/load uses synthetic replay-* ids that are never in store.db —
      // skip per-tool polls (batch enrich runs at loadSessionEnd instead).
      if (this.sessionManager.isLoading(sessionId)) return;
      const session = this.sessionManager.getSession(sessionId);
      const agentLabel = session?.agentName || session?.agentDisplayName || '';
      if (!isCursorAgentName(agentLabel)) return;

      // Per-tool store.db polls block the extension host (Git SCM starves on
      // large sessions). Batch enrich is already deferred; defer live polls too.
      if (
        !options?.force &&
        this.sessionManager.isPromptInFlight(sessionId)
      ) {
        let pending = this.deferredCursorToolEnrich.get(sessionId);
        if (!pending) {
          pending = new Set();
          this.deferredCursorToolEnrich.set(sessionId, pending);
        }
        pending.add(toolCallId);
        return;
      }

      const inflightKey = satisfiedKey;
      if (this.cursorToolEnrichInFlight.has(inflightKey)) return;
      this.cursorToolEnrichInFlight.add(inflightKey);
      let enriched;
      try {
        enriched = await this.getCursorToolEnricher(sessionId).enrich(toolCallId, {
          timeoutMs: 8000,
        });
      } finally {
        this.cursorToolEnrichInFlight.delete(inflightKey);
      }

      if (!enriched || Object.keys(enriched.args).length === 0) {
        log(`Cursor tool enrich miss: ${toolCallId.slice(0, 48).replace(/\n/g, '\\n')}`);
        return;
      }
      // Session may have switched while we waited.
      if (this.sessionManager.getActiveSessionId() !== sessionId) return;
      if (this.suppressWebviewUpdates) return;

      const patch: Record<string, unknown> = {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        title: enriched.title,
        rawInput: {
          ...enriched.args,
          _toolName: enriched.toolName,
        },
      };
      if (enriched.locations && enriched.locations.length > 0) {
        patch.locations = enriched.locations;
      }
      if (DEBUG) {
        log(`Cursor tool enrich hit: ${enriched.title.slice(0, 80)}`);
      } else {
        log(`Cursor tool enrich: ${enriched.title.slice(0, 80)}`);
      }
      this.postMessage({
        type: 'sessionUpdate',
        update: patch,
        sessionId,
        isLoading: this.sessionManager.isLoading(sessionId),
      });

      // Follow Agent: open path once locations are recovered.
      if (this._isFollowing && enriched.locations) {
        const target = pickFollowTarget(enriched.locations as ToolCallLocationLike[], {
          sessionCwd: session?.cwd,
          workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
          homeDir: process.env.HOME,
        });
        if (target) this.followCoalescer.submit(target);
      }
    } catch (e: any) {
      log(`Cursor tool enrich failed: ${e?.message || e}`);
    }
  }

  /** Run per-tool enrich polls queued during an in-flight agent turn. */
  private async flushDeferredCursorToolEnrich(sessionId: string): Promise<void> {
    const pending = this.deferredCursorToolEnrich.get(sessionId);
    if (!pending?.size) return;
    // A newer turn may have started before a stale sendPrompt resolved.
    if (this.sessionManager.isPromptInFlight(sessionId)) return;
    this.deferredCursorToolEnrich.delete(sessionId);
    log(
      `Cursor tool enrich: flushing ${pending.size} deferred tool(s) (session=${sessionId.slice(0, 8)}…)`,
    );
    for (const toolCallId of pending) {
      await this.maybeEnrichCursorToolCall(
        sessionId,
        {
          sessionUpdate: 'tool_call',
          toolCallId,
          title: 'Edit File',
          rawInput: {},
        },
        { force: true },
      );
    }
  }

  private onAgentTurnEnded(sessionId: string): void {
    void this.flushDeferredCursorToolEnrich(sessionId);
  }

  /**
   * After session/load or webview restore, push store.db tool titles so stub
   * "Read File" / "grep" rows get paths (replay-* ids cannot be looked up).
   * Live-turn requests are deferred — a synchronous full-table store.db scan
   * on large DBs blocks the extension host and starves Git SCM change
   * detection until the agent turn ends.
   */
  private scheduleCursorBatchEnrich(
    sessionId: string | null | undefined,
    reason?: string,
  ): void {
    if (!sessionId) return;
    if (this.cursorBatchEnrichTimer) {
      clearTimeout(this.cursorBatchEnrichTimer);
    }
    const delayMs =
      reason === 'deferred-inflight' || reason === 'stub-retry' ? 1500 : 40;
    this.cursorBatchEnrichTimer = setTimeout(() => {
      this.cursorBatchEnrichTimer = null;
      void this.maybeBatchEnrichCursorToolsAfterLoad(sessionId, reason);
    }, delayMs);
  }

  /**
   * After session/load, push store.db tool titles into the webview so stub
   * "Read File" / "grep" / "Edit File" rows get paths (replay-* ids cannot
   * be looked up individually).
   */
  private async maybeBatchEnrichCursorToolsAfterLoad(
    sessionId: string | null,
    reason?: string,
  ): Promise<void> {
    const reasonTag = reason ? ` reason=${reason}` : '';
    try {
      if (!sessionId) {
        log(`Cursor batch enrich failed: missing sessionId${reasonTag}`);
        return;
      }
      const session = this.sessionManager.getSession(sessionId);
      const agentLabel = session?.agentName || session?.agentDisplayName || '';
      if (!isCursorAgentName(agentLabel)) return;
      // Batch enrich scans store.db on the extension host. While the agent is
      // mid-turn (file edits streaming), defer so Git SCM / other extensions
      // are not starved by a multi-second SQLite read.
      const allowDuringPrompt =
        reason === 'post-restore' ||
        reason === 'post-merge' ||
        reason === 'post-load' ||
        this.sessionManager.isLoading(sessionId);
      if (!allowDuringPrompt && this.sessionManager.isPromptInFlight(sessionId)) {
        this.scheduleCursorBatchEnrich(sessionId, reason || 'deferred-inflight');
        return;
      }
      if (this.suppressWebviewUpdates) {
        log(`Cursor batch enrich failed: suppressWebviewUpdates active (session=${sessionId.slice(0, 8)}…${reasonTag})`);
        return;
      }
      const tools = await this.getCursorToolEnricher(sessionId).listEnrichedTools();
      if (!tools.length) {
        const dbPath = findCursorSessionStorePath(sessionId);
        log(
          `Cursor batch enrich: 0 tools indexed (session=${sessionId.slice(0, 8)}… store=${dbPath || 'none'}${reasonTag})`,
        );
        return;
      }
      log(`Cursor batch enrich: ${tools.length} tools → webview (session=${sessionId.slice(0, 8)}…${reasonTag})`);
      this.postMessage({
        type: 'cursorToolEnrichBatch',
        sessionId,
        tools: tools.map((t) => ({
          toolCallId: t.toolCallId,
          toolName: t.toolName,
          title: t.title,
          rawInput: { ...t.args, _toolName: t.toolName },
          locations: t.locations,
        })),
      });
    } catch (e: any) {
      log(`Cursor batch enrich failed: ${e?.message || e}${reasonTag}`);
    }
  }

  /**
   * Read a plan file URI and rewrite the plan_update as a markdown type
   * so the webview can render it without filesystem access.
   */
  private async resolvePlanFile(update: any): Promise<any> {
    try {
      const uri = vscode.Uri.parse(update.plan.uri);
      const buf = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(buf).toString('utf8');
      return {
        ...update,
        plan: {
          id: update.plan.id,
          type: 'markdown',
          markdown: text,
        },
      };
    } catch (e: any) {
      log('Failed to read plan file: ' + (e?.message || e));
      return {
        ...update,
        plan: {
          id: update.plan.id,
          type: 'markdown',
          markdown: `_(Plan file unavailable: ${update.plan.uri})_`,
        },
      };
    }
  }

  /**
   * Drain pending coalesced text for a session and post one combined
   * `agent_message_chunk` / `agent_thought_chunk` to the webview.
   * Delegates to the {@link StreamCoalescer}.
   */
  private flushStreamBuffer(sessionId: string): void {
    this.streamCoalescer.flush(sessionId);
  }

  /**
   * Handle a prompt sent from the webview.
   */
  private async handleSendPrompt(text: string, images?: Array<{ data: string; mimeType: string }>): Promise<void> {
    // TEMP-DEBUG (cannot-send investigation): entry marker so we can tell
    // "webview never posted" apart from "host received but dropped".
    if (DEBUG_LIVE) {
      log(`handleSendPrompt ENTER: text="${(text || '').substring(0, 60)}" activeId=${this.sessionManager.getActiveSessionId()}`);
    }
    const activeId = this.sessionManager.getActiveSessionId();
    if (!activeId) {
      this.postMessage({
        type: 'error',
        message: 'No active session. Create a session first.',
      });
      return;
    }

    // Voice Memory feedback: if this send carries a recent voice transcript
    // (verbatim or hand-edited), record the outcome for the review command.
    this.voiceInput.captureFeedback(text, activeId);

    // Capture whether the session was still loading (resume replay in
    // progress) when this prompt arrived. The webview's handleSend() adds a
    // user bubble for normal prompts, but when a prompt is sent while
    // isLoadingSession is true the webview-side send path can deliver it to
    // the agent WITHOUT rendering the bubble. We only post a userBubble in
    // that resume case; posting it unconditionally after EVERY prompt causes
    // duplicate user bubbles (dedup fails on context-token-stripped text or
    // when the resume merge re-injects an older prompt) and can truncate an
    // in-progress assistant stream (addMessage('user') resets
    // currentAssistantEl), producing an empty assistant bubble.
    const promptSentWhileLoading = this.sessionManager.isLoading(activeId);
    // Snapshot the text the USER typed, before the context-block processing
    // below rewrites it (@terminal / @problems are stripped and the resolved
    // output is prepended as <terminal>/<problems> XML, file references are
    // removed). The userBubble must show what was typed, not the augmented
    // payload sent to the model — and the webview dedups the bubble by
    // comparing against the most recent user message, which handleSend()
    // rendered from the raw text. Posting the rewritten text made that
    // comparison miss, so a resume-phase prompt using any context token got a
    // SECOND bubble containing the machine-facing XML.
    const promptDisplayText = text;

    sendEvent(
      'chat/messageSent',
      {
        agentName: this.sessionManager.getActiveAgentName() ?? '',
      },
      {
        messageLength: text.length,
      },
    );

    // Record the first prompt for the history store (used as a label
    // fallback when no title is supplied by the agent).
    this.sessionManager.recordFirstPrompt(activeId, text);

    // Slash commands (e.g. /ps, /status, /mcp) are handled by the agent
    // without starting an LLM turn. Skip context gathering and send
    // the text directly so the agent can intercept it.
    if (text.startsWith('/')) {
      // Send promptStart so the webview sets isProcessing=true. Without this,
      // agent_message_chunk notifications from slash commands (e.g. /index build,
      // /tools, /stats) are dropped by the "After promptEnd the turn is closed"
      // guard in the webview's sessionUpdate handler.
      if (DEBUG_LIVE) {
        log(`HOST-SLASH: posting promptStart for slash text="${text.substring(0, 40)}" activeId=${activeId} isPromptInFlight=${this.sessionManager.isPromptInFlight(activeId)}`);
      }
      this.postMessage({ type: 'promptStart' });
      let slashStopReason: string = 'end_turn';
      try {
        // Kiro does not intercept `/compact` as a prompt — it requires
        // `_kiro.dev/commands/execute` (see kiro.dev ACP extensions).
        const session = this.sessionManager.getSession(activeId);
        const compactName = text.match(/^\/(compact|summarize|compress)(?:\s|$)/i)?.[1];
        if (compactName && this.sessionManager.isKiroAgentName(session?.agentName)) {
          await this.handleExecuteKiroCommand('compact');
        } else {
          // Increment cancel generation so stale timers from a previous
          // cancel don't fire during this new prompt.
          this._cancelGeneration++;
          const slashResponse = await this.sessionManager.sendPrompt(activeId, text);
          if (slashResponse?.stopReason) {
            slashStopReason = slashResponse.stopReason;
          }
        }
      } catch (e: any) {
        logError('Slash command failed', e);
        this.postMessage({ type: 'error', message: formatAcpErrorMessage(e, 'Command failed') });
      } finally {
        // Flush any buffered streaming text before sending promptEnd.
        // Without this, the coalescer's 8ms timer may still be holding
        // the last agent_message_chunk(s) (e.g. the "Context compacted"
        // summary or the "Heads up" warning), causing promptEnd to arrive
        // at the webview first and queued messages to be drained before
        // the compacted text is rendered.
        this.streamCoalescer.flush(activeId);
        // Clear the cancel fallback timer — the prompt has resolved
        // (either completed or cancelled). Without this, a stale timer
        // from a previous cancel can fire during the NEXT prompt and
        // force-abort it, causing "Prompt already in progress" errors.
        if (this._cancelFallbackTimer) {
          clearTimeout(this._cancelFallbackTimer);
          this._cancelFallbackTimer = null;
        }
        this._pendingPromptSessionId = null;
        // Only deliver promptEnd to the webview if this session is still the
        // active one. If the user switched agents mid-turn, the old session's
        // prompt resolves here after the webview has already moved on to the
        // new agent's panel — posting promptEnd: cancelled would leak the
        // "— Conversation interrupted —" notice into the wrong chat.
        if (this.sessionManager.getActiveSessionId() === activeId) {
          if (DEBUG_LIVE) {
            log(`HOST-SLASH: posting promptEnd stopReason=${slashStopReason} for slash text="${text.substring(0, 40)}" activeId=${activeId} isPromptInFlight=${this.sessionManager.isPromptInFlight(activeId)}`);
          }
          this.postMessage({ type: 'promptEnd', sessionId: activeId, stopReason: slashStopReason });
        }
        this.onAgentTurnEnded(activeId);
      }
      return;
    }

    // Tell webview we're processing
    if (DEBUG_LIVE) {
      log(`HOST-PROMPT: posting promptStart for text="${text.substring(0, 40)}" activeId=${activeId} isPromptInFlight=${this.sessionManager.isPromptInFlight(activeId)}`);
    }
    this.postMessage({ type: 'promptStart' });

    // Capture all non-empty selections from the active editor.
    //
    // Mirrors Zed's `AddSelectionToThread` flow (see
    // `zed-industries/zed::crates/agent_ui/src/mention_set.rs::
    //  confirm_mention_for_selection`): each selection is forwarded to the
    // agent as a dedicated `resource` (or `resource_link`) ACP ContentBlock
    // rather than wrapped inline in the prompt text. The decision between
    // the two is made by SessionManager based on
    // `promptCapabilities.embeddedContext`.
    const selections: import('../core/SessionManager').SelectionContext[] = [];
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      for (const sel of editor.selections) {
        if (sel.isEmpty) {
          continue;
        }
        const text = editor.document.getText(sel);
        if (!text) {
          continue;
        }
        selections.push({
          absPath: editor.document.uri.scheme === 'file' ? editor.document.uri.fsPath : null,
          uri: editor.document.uri.scheme === 'file' ? undefined : editor.document.uri.toString(),
          startLine: sel.start.line + 1,
          endLine: sel.end.line + 1,
          text,
          languageId: editor.document.languageId,
        });
      }
    }

    // Collect additional ACP content blocks for workspace context that used
    // to be wrapped in pseudo-XML tags (<open_files>, <file>, <folder>,
    // <terminal>, <problems>). Each is now expressed as a proper ACP
    // ContentBlock — `resource` (EmbeddedResource) when the agent advertises
    // `promptCapabilities.embeddedContext`, otherwise a `resource_link` (for
    // file/folder URIs the agent can dereference itself). Terminal output
    // and diagnostics still fall back to inline text when embedded context
    // is unavailable, since their `zed:///agent/...` URIs are not
    // dereferenceable.
    const contextBlocks: ContentBlock[] = [];
    const supportsEmbedded = !!this.sessionManager.getPromptCapabilities(activeId)?.embeddedContext;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;

    // Detect @terminal — terminal output. EmbeddedResource when supported,
    // else inline fallback (a resource_link would point to an unresolvable
    // zed:///agent/terminal-selection URI).
    if (/@terminal\b/i.test(text)) {
      const { text: termOutput, name } = this.terminalContext.getLastOutput();
      if (termOutput) {
        text = text.replace(/@terminal\b/gi, '').trim();
        const block = buildTerminalBlock(termOutput, supportsEmbedded, this.terminalOutputStore);
        if (block) {
          contextBlocks.push(block);
        } else {
          text = `<terminal name="${name || 'active'}">\n${termOutput}\n</terminal>\n\n${text}`;
        }
      } else {
        // No terminal output available — usually zsh shell integration never
        // activated (VS Code ZDOTDIR inject), not "user forgot to run a command".
        vscode.window.showWarningMessage(
          `@terminal: no terminal output captured. ${this.terminalContext.getEmptyCaptureHint()}`,
        );
      }
    }

    // Detect @problems — workspace diagnostics. Same embedded-or-inline
    // fallback as @terminal.
    if (/@problems\b/i.test(text)) {
      const diags = vscode.languages.getDiagnostics();
      const lines: string[] = [];
      for (const [uri, issues] of diags) {
        const errs = issues.filter(
          (d) => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning,
        );
        if (errs.length === 0) {
          continue;
        }
        for (const d of errs) {
          const sev = d.severity === vscode.DiagnosticSeverity.Error ? 'ERROR' : 'WARN';
          lines.push(`${vscode.workspace.asRelativePath(uri)}:${d.range.start.line + 1}: [${sev}] ${d.message}`);
        }
      }
      text = text.replace(/@problems\b/gi, '').trim();
      if (lines.length > 0) {
        const diagText = lines.join('\n');
        const block = buildDiagnosticsBlock(diagText, supportsEmbedded);
        if (block) {
          contextBlocks.push(block);
        } else {
          text = `<problems count="${lines.length}">\n${diagText}\n</problems>\n\n${text}`;
        }
      }
    }

    // Detect @file:path — file mention. Strips the @file token from the
    // text and emits one ContentBlock per file: a `resource`
    // (EmbeddedResource with inline content) when embeddedContext is
    // supported, otherwise a `resource_link` so the agent can read it from
    // disk via the URI.
    const fileMatches = text.match(/@file:([^\s]+)/gi);
    if (fileMatches && workspaceRoot) {
      for (const match of fileMatches) {
        const filePath = match.replace(/@file:/i, '');
        try {
          const uri = vscode.Uri.joinPath(workspaceRoot, filePath);
          let content: string | undefined;
          if (supportsEmbedded) {
            try {
              content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
            } catch {
              /* fall through to resource_link */
            }
          }
          contextBlocks.push(buildFileBlock(uri.fsPath, supportsEmbedded, content));
        } catch {
          /* ignore */
        }
        text = text.replace(match, '').trim();
      }
    }

    // Detect @folder:path — directory mention. Always emitted as a
    // `resource_link` to the directory URI (trailing `/`). The agent
    // dereferences the URI to list entries.
    const folderMatches = text.match(/@folder:([^\s]+)/gi);
    if (folderMatches && workspaceRoot) {
      for (const match of folderMatches) {
        const folderPath = match.replace(/@folder:/i, '');
        try {
          const uri = vscode.Uri.joinPath(workspaceRoot, folderPath);
          contextBlocks.push(buildDirectoryBlock(uri.fsPath));
        } catch {
          /* ignore */
        }
        text = text.replace(match, '').trim();
      }
    }

    // Capture the generation at prompt start so we can detect stale
    // promptEnd responses from a previous turn's sendPrompt promise.
    this._cancelGeneration++;
    const promptGeneration = this._cancelGeneration;
    // A new prompt starts a fresh turn — clear the abandoned-turn suppression
    // flag so this turn's session/update events flow normally again.
    this._abandonedTurnSessions.delete(activeId);
    try {
      this._pendingPromptSessionId = activeId;
      const response = await this.sessionManager.sendPrompt(
        activeId,
        text,
        images,
        undefined,
        selections,
        contextBlocks,
      );
      // Ensure the user bubble is rendered in the webview. Normally the
      // webview's handleSend() adds the bubble before posting sendPrompt, but
      // when a prompt is sent while isLoadingSession is true (resume still
      // replaying), the webview-side send path can deliver the prompt to the
      // agent WITHOUT rendering the bubble — the LLM answers but the user
      // message never appears in the chat panel. Post a userBubble so the
      // webview renders it (dedup: the webview skips if the last user message
      // already matches). Only post when the prompt arrived during the load —
      // for normal prompts handleSend() already rendered the bubble, and
      // posting unconditionally re-adds it when the resume merge re-injects an
      // older prompt or the text was context-token-stripped.
      if (promptSentWhileLoading) {
        this.postMessage({
          type: 'userBubble',
          text: promptDisplayText || '(image)',
        });
      }
      // Flush any buffered streaming text before sending promptEnd.  The
      // coalescer's 8 ms timer may still be holding the last agent_message_chunk(s);
      // without flushing, promptEnd arrives at the webview first and
      // commitCurrentTextSegment commits incomplete text.
      this.streamCoalescer.flush(activeId);
      // ── Stale-resolution guard, BEFORE touching shared cancel state ──────
      // When "Send Now" fires the cancel fallback, forceAbortPrompt removes the
      // session from the in-flight set so a NEW sendPrompt can start (bumping
      // _cancelGeneration). The OLD promise is still alive — when the agent
      // finally processes the cancel (13s in one measured codex session, and
      // 60-90s for long-running commands) it resolves here.
      //
      // This must not touch _cancelFallbackTimer / _pendingPromptSessionId,
      // because those now belong to the NEW prompt. Clearing them stranded the
      // next cancel: handleCancelTurn armed its fallback, the fallback's
      // `_pendingPromptSessionId === activeId` guard was false, so it silently
      // did nothing — no promptEnd, the turn never ended, the queued Send Now
      // message never drained and the "Interrupting" status stuck forever.
      // Measured: `Cancelling turn` at 06:38:22 with no `Cancel fallback` line
      // after it, where the earlier cancel at 06:36:10 did produce one.
      if (promptGeneration !== this._cancelGeneration) {
        log(
          `handleSendPrompt: stale response (gen ${promptGeneration} → ${this._cancelGeneration}), suppressing promptEnd (cancel state left to the current prompt)`,
        );
        this.onAgentTurnEnded(activeId);
        return;
      }
      // Agent acknowledged — cancel the fallback timer and clear pending session.
      if (this._cancelFallbackTimer) {
        clearTimeout(this._cancelFallbackTimer);
        this._cancelFallbackTimer = null;
      }
      this._pendingPromptSessionId = null;
      // Render the accumulated assistant text as markdown
      // The webview will have sent us the raw text via promptEnd handling
      // Only deliver promptEnd to the webview if this session is still the
      // active one. On agent switch mid-turn, disconnectAgent cancels the old
      // session's in-flight prompt, which resolves here after the webview has
      // already switched to the new agent. Posting promptEnd: cancelled would
      // render "— Conversation interrupted —" in the WRONG agent's panel.
      if (this.sessionManager.getActiveSessionId() === activeId) {
        const session = this.sessionManager.getSession(activeId);
        if (DEBUG_LIVE) {
          log(`HOST-PROMPT: posting promptEnd stopReason=${response.stopReason} activeId=${activeId} isPromptInFlight=${this.sessionManager.isPromptInFlight(activeId)} (after sendPrompt resolved)`);
        }
        this.postMessage({
          type: 'promptEnd',
          sessionId: activeId,
          stopReason: response.stopReason,
          usage: (response as any).usage,
          goalSnapshot: (session as any)?.goalSnapshot ?? null,
        });
      }
      this.onAgentTurnEnded(activeId);
      this.sessionManager.touchHistory(activeId);
    } catch (e: any) {
      // Stale-resolution guard FIRST — same reasoning as the success path: a
      // superseded prompt failing late must not clear the cancel state that now
      // belongs to the current prompt, or the next cancel's fallback is
      // stranded and the turn never ends.
      if (promptGeneration !== this._cancelGeneration) {
        log(
          `handleSendPrompt: stale error (gen ${promptGeneration} → ${this._cancelGeneration}), suppressing promptEnd (cancel state left to the current prompt)`,
        );
        this.streamCoalescer.flush(activeId);
        return;
      }
      // Clear fallback timer and pending session on error too.
      if (this._cancelFallbackTimer) {
        clearTimeout(this._cancelFallbackTimer);
        this._cancelFallbackTimer = null;
      }
      this._pendingPromptSessionId = null;
      logError('Prompt failed', e);
      const errMsg = formatAcpErrorMessage(e, 'Prompt failed');
      // Suppress the error if the connection was closed because the user
      // started a new conversation or switched sessions — the old session's
      // in-flight prompt is expected to fail during teardown.
      if (/connection closed/i.test(errMsg) && this.sessionManager.getActiveSessionId() !== activeId) {
        this.streamCoalescer.flush(activeId);
        // The session is no longer active (user switched agents), so the
        // webview is showing a different chat. Do NOT post promptEnd here —
        // it would leak "— Conversation interrupted —" into the new agent's
        // panel. The webview's new state already cleared processing.
        return;
      }
      // Detect context length errors and provide actionable guidance
      this.postMessage({
        type: 'error',
        message: errMsg,
      });
      this.streamCoalescer.flush(activeId);
      this.postMessage({ type: 'promptEnd', sessionId: activeId, stopReason: 'error' });
      this.onAgentTurnEnded(activeId);
    }
  }

  /**
   * Handle cancel request from webview.
   */
  private async handleCancelTurn(): Promise<void> {
    const activeId = this.sessionManager.getActiveSessionId();
    if (activeId) {
      // Dedup: multiple rapid stop-button clicks each post a cancelTurn.
      // If a cancel fallback timer is already pending for this session, a
      // second cancel is a no-op — otherwise each click spawns its own 5s
      // fallback timer and every one posts promptEnd(cancelled), rendering
      // duplicate "— Conversation interrupted —" notices in the webview.
      if (this._cancelFallbackTimer) {
        log(`Cancel dedup: fallback timer already pending for session ${activeId}, ignoring repeat cancel`);
        return;
      }
      try {
        await this.sessionManager.cancelTurn(activeId);
      } catch (e) {
        logError('Cancel failed', e);
      }
      // Fallback: if the agent doesn't acknowledge the cancel within 5s
      // (some agents ignore session/cancel, or are stuck inside an in-flight
      // HTTP call / backpressure retry loop that doesn't check the abort
      // signal), force the webview out of processing mode so the user can
      // type a new prompt (steering). We do NOT kill the agent process -
      // killing the process terminates the entire session, losing all
      // context. The agent's in-flight request will eventually time out
      // or complete on its own; the user can continue the conversation
      // once the webview is unblocked. This matches codex-acp behavior
      // (turn interrupt without process kill).
      if (this._cancelFallbackTimer) {
        clearTimeout(this._cancelFallbackTimer);
      }
      const cancelGen = this._cancelGeneration;
      this._cancelFallbackTimer = setTimeout(() => {
        // Only fire if the SAME prompt is still pending — if a new prompt
        // has started (pendingSendAfterCancel drained a queued message and
        // a new sendPrompt was issued), the cancel generation will have
        // changed. This prevents a stale timer from force-aborting a new
        // prompt that started after the cancel was acknowledged.
        if (this._pendingPromptSessionId === activeId && this._cancelGeneration === cancelGen) {
          log('Cancel fallback: agent did not acknowledge within 5s, forcing promptEnd (session kept alive)');
          this.streamCoalescer.flush(activeId);
          this.sessionManager.forceAbortPrompt(activeId);
          // Mark the turn as abandoned so late session/update events from it
          // are suppressed (see handleSessionUpdate) — otherwise they interleave
          // with a new prompt and drop/mangle user messages. Cleared when a
          // new prompt starts for this session.
          this._abandonedTurnSessions.add(activeId);
          // Same session-is-still-active guard as handleSendPrompt: if the user
          // switched agents while this cancel was in flight, do not leak the
          // "— Conversation interrupted —" notice into the new agent's panel.
          if (this.sessionManager.getActiveSessionId() === activeId) {
            this.postMessage({ type: 'promptEnd', sessionId: activeId, stopReason: 'cancelled' });
          }
          this.onAgentTurnEnded(activeId);
          this._pendingPromptSessionId = null;
        }
        this._cancelFallbackTimer = null;
      }, 5_000);
    }
  }

  /**
   * Steer the active turn by sending a user message mid-turn without
   * cancelling. Uses session/steer notification (Codex, Codex, Claude Code).
   * For agents that don't support it, the notification is silently ignored
   * and the message is only queued for the next turn (via handleQueue).
   */
  private async handleSteerPrompt(text: string): Promise<void> {
    const activeId = this.sessionManager.getActiveSessionId();
    if (!activeId) {
      return;
    }
    // Steer sends composer text too — same Voice Memory feedback path.
    this.voiceInput.captureFeedback(text, activeId);
    try {
      await this.sessionManager.steerPrompt(activeId, text);
    } catch (e) {
      logError('Steer failed', e);
    }
  }

  private async handleStopProcesses(suppressNotice?: boolean): Promise<void> {
    const activeId = this.sessionManager.getActiveSessionId();
    if (!activeId) {
      return;
    }
    try {
      await this.sessionManager.stopProcesses(activeId);
    } catch (e) {
      logError('Stop processes failed', e);
    }
    // Notify the webview so it can locally mark the killed tool calls as
    // 'failed' and dismiss/refresh the /ps panel. Without this, the /ps
    // panel keeps showing stale "running" processes because codex-acp's
    // stopProcesses() clears its internal backgroundProcesses map but never
    // emits tool_call_update notifications for the killed processes.
    //
    // suppressNotice: when true, the webview skips the transient "Killed N
    // running process." notice. This is set by the "Send Now" path, which
    // kills processes as a side effect of interrupting the turn — the user
    // did not run /stop, so the "Killed" feedback is noise, not intent.
    this.postMessage({ type: 'processesStopped', suppressNotice: !!suppressNotice });
    // An explicit /stop means the user is done with this turn. Killing the
    // processes does NOT end the ACP turn: the agent's prompt promise stays
    // pending, so no promptEnd arrives, a queued "Send Now" message never
    // drains and the composer stays blocked showing "Interrupting…".
    // Measured: `Stop processes for session …` was the LAST line in the log,
    // 8 minutes after the cancel, with no promptEnd and no new turn.
    // Route through the same cancel + 5s fallback path so the turn reliably
    // ends. handleCancelTurn dedups when a fallback is already pending, and
    // this is a no-op when nothing is in flight.
    if (this.sessionManager.isPromptInFlight(activeId)) {
      log(`Stop processes: turn still in flight for ${activeId}, requesting cancel so the turn ends`);
      // /stop is a process kill, not an interruption — suppress the
      // "Conversation interrupted" notice in the webview.
      this.postMessage({ type: 'setSuppressInterruptNotice' });
      await this.handleCancelTurn();
    }
  }

  /**
   * Webview-initiated Kiro slash command (e.g. `/compact`). Wraps execute +
   * promptEnd so the chat leave-processing path matches sendPrompt.
   */
  private async handleExecuteKiroCommandFromWebview(command: string, args?: Record<string, string>): Promise<void> {
    const activeId = this.sessionManager.getActiveSessionId();
    if (!activeId) {
      return;
    }
    try {
      await this.handleExecuteKiroCommand(command, args);
    } catch (e: any) {
      logError('Kiro command failed', e);
      this.postMessage({ type: 'error', message: formatAcpErrorMessage(e, 'Command failed') });
    } finally {
      this.streamCoalescer.flush(activeId);
      this.postMessage({ type: 'promptEnd', sessionId: activeId, stopReason: 'end_turn' });
      this.onAgentTurnEnded(activeId);
    }
  }

  /**
   * Run a Kiro slash command via `_kiro.dev/commands/execute`.
   * Does not emit promptEnd — callers own that.
   */
  private async handleExecuteKiroCommand(command: string, args?: Record<string, string>): Promise<void> {
    const activeId = this.sessionManager.getActiveSessionId();
    if (!activeId || !command) {
      return;
    }
    const name = String(command).replace(/^\//, '');
    try {
      const msg = await this.sessionManager.executeKiroCommand(activeId, name, args || {});
      if (name === 'compact') {
        this.postMessage({ type: 'kiroCompactDone', message: msg || undefined });
      } else if (name === 'clear') {
        this.postMessage({ type: 'kiroClearDone', message: msg || undefined });
      }
    } catch (e: any) {
      const raw = String(e?.message || e || 'Command failed');
      // kiro-cli 2.11 can exit the ACP process on a bad execute payload;
      // surface a clearer hint than the generic "ACP connection closed".
      const message =
        (name === 'compact' || name === 'clear') && /connection closed|exited/i.test(raw)
          ? 'Kiro exited while running /' + name + ' (ACP connection closed). Reconnect to Kiro CLI and try again.'
          : raw;
      if (name === 'compact') {
        this.postMessage({ type: 'kiroCompactDone', error: true, message });
      } else if (name === 'clear') {
        this.postMessage({ type: 'kiroClearDone', error: true, message });
      }
      throw new Error(message);
    }
  }

  /** Handle /rename command from webview — sets session title locally. */
  private handleRenameSession(title: string): void {
    const activeId = this.sessionManager.getActiveSessionId();
    if (!activeId || !title) {
      return;
    }
    this.sessionManager.renameSession(activeId, title);
    this.notifySessionInfoUpdate(title);
  }

  /**
   * Handle mode change from webview picker.
   */
  private async handleSetMode(modeId: string): Promise<void> {
    const activeId = this.sessionManager.getActiveSessionId();
    if (!activeId || !modeId) {
      return;
    }
    try {
      await this.sessionManager.setMode(activeId, modeId);
    } catch (e: any) {
      logError('Failed to set mode', e);
      this.postMessage({
        type: 'error',
        message: `Failed to set mode: ${e.data ? e.message + ': ' + (typeof e.data === 'string' ? e.data : JSON.stringify(e.data)) : e.message}`,
      });
    }
  }

  /**
   * Load model → supports-image map from ~/.codex catalog JSON files.
   * A model is image-capable only when `input_modalities` explicitly
   * includes `"image"`. Missing / unclear modalities → false.
   */
  private loadModelImageSupport(): void {
    if (this.modelImageSupportLoaded) {
      return;
    }
    this.modelImageSupportLoaded = true;
    const map = new Map<string, boolean>();
    const codexDir = path.join(os.homedir(), '.codex');
    const catalogPaths = new Set<string>([
      path.join(codexDir, 'model_catalog.json'),
      path.join(codexDir, 'model.json'),
    ]);
    try {
      for (const name of fs.readdirSync(codexDir)) {
        if (/model.*\.json$/i.test(name) || /models\.json$/i.test(name)) {
          catalogPaths.add(path.join(codexDir, name));
        }
      }
    } catch {
      // ~/.codex missing — leave map empty
    }

    for (const catalogPath of catalogPaths) {
      try {
        const data = JSON.parse(fs.readFileSync(catalogPath, 'utf-8'));
        for (const m of data.models || []) {
          const slug = typeof m?.slug === 'string' ? m.slug : '';
          if (!slug) {
            continue;
          }
          const modalities = m.input_modalities;
          // Only show image upload when the catalog explicitly lists image.
          const supports = Array.isArray(modalities) && modalities.map(String).includes('image');
          // Prefer an explicit true if any catalog file claims image support.
          if (supports || !map.has(slug)) {
            map.set(slug, supports);
          }
        }
      } catch {
        // Catalog not found or invalid — skip it
      }
    }
    this.modelImageSupport = map;
  }

  /**
   * Check if a model supports image input.
   * For Codex / catalog-backed agents: true only when ~/.codex catalogs
   * list the model with `input_modalities` including `"image"`. Unknown
   * models and text-only entries return false (hide upload).
   * For Kiro CLI: Claude models support images; others are text-only.
   */
  private modelSupportsImage(modelId: string, agentName?: string): boolean {
    // Strip effort suffix: "glm-5.2[high]" → "glm-5.2"
    const base = modelId.replace(/\[(?:low|medium|high|xhigh|max|none)\]$/, '');
    // For Kiro CLI, determine from model name — no catalog file.
    if (agentName && /kiro/i.test(agentName)) {
      return /claude/i.test(base);
    }
    this.loadModelImageSupport();
    if (!this.modelImageSupport || this.modelImageSupport.size === 0) {
      return false;
    }
    return this.modelImageSupport.get(base) === true;
  }

  /**
   * Handle model change from webview picker.
   */
  private async handleSetModel(modelId: string): Promise<void> {
    const activeId = this.sessionManager.getActiveSessionId();
    if (!activeId || !modelId) {
      return;
    }
    try {
      await this.sessionManager.setModel(activeId, modelId);
    } catch (e: any) {
      logError('Failed to set model', e);
      this.postMessage({
        type: 'error',
        message: `Failed to set model: ${e.data ? e.message + ': ' + (typeof e.data === 'string' ? e.data : JSON.stringify(e.data)) : e.message}`,
      });
    }
  }

  /**
   * Handle generic config-option change from webview picker
   * (ACP "Session Config Options"). The agent returns the full
   * configOptions state which we re-broadcast so any cascading
   * changes are reflected in the UI.
   */
  private async handleSetConfigOption(configId: string, value: string): Promise<void> {
    const activeId = this.sessionManager.getActiveSessionId();
    if (!activeId || !configId) {
      return;
    }
    try {
      const options = await this.sessionManager.setConfigOption(activeId, configId, value);
      this.postMessage({ type: 'configOptionsUpdate', configOptions: options });
    } catch (e: any) {
      logError('Failed to set config option', e);
      this.postMessage({
        type: 'error',
        message: `Failed to set ${configId}: ${e.data ? e.message + ': ' + (typeof e.data === 'string' ? e.data : JSON.stringify(e.data)) : e.message}`,
      });
      // Roll back optimistic update on the webview by replaying current state
      const session = this.sessionManager.getSession(activeId);
      this.postMessage({
        type: 'configOptionsUpdate',
        configOptions: session?.configOptions ?? null,
      });
    }
  }

  /**
   * Open a file at a specific line number (clicked from chat panel).
   * Resolves relative paths against workspace root.
   */
  /**
   * Open a file at a specific line or line range (clicked from chat panel).
   * Supports:
   *   - Relative paths (resolved against workspace root)
   *   - Absolute paths
   *   - file:// protocol URIs
   *   - file:// URIs with ?symbol= query param (Zed MentionUri::Symbol format)
   * Ported from Roo-Code's openFile() with simplifications.
   */
  private async handleOpenExternalUrl(url: string): Promise<void> {
    try {
      const uri = vscode.Uri.parse(url);
      await vscode.env.openExternal(uri);
    } catch (e) {
      logError('[ACP] handleOpenExternalUrl failed', e as Error);
      vscode.window.showErrorMessage(`Could not open URL: ${url}`);
    }
  }

  /**
   * Roots a relative code link may be resolved against, most specific first.
   *
   * The agent's own cwd comes first: `src/foo.cpp` in a session working in
   * another repo is relative to THAT repo, not to this workspace. Workspace
   * folders follow, so links about the open project keep working.
   */
  private linkResolutionRoots(): string[] {
    const activeId = this.sessionManager.getActiveSessionId();
    return orderedLinkRoots(
      activeId ? this.sessionManager.getSession(activeId)?.cwd : undefined,
      this.sessionManager.getOpenSessions().map((s) => s.cwd),
      (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath),
    );
  }

  /**
   * Symbol name to fall back on when a link's file cannot be opened — or
   * undefined when the link text is a path rather than a symbol.
   *
   * The old regex took the first identifier out of ANY link text, so clicking
   * `src/llama-memory-recurrent.cpp:898` searched the workspace for a symbol
   * named "src", matched 15349 candidates and jumped into an unrelated repo.
   */
  private symbolFallbackFromLinkText(linkText?: string): string | undefined {
    return symbolFallbackFromLinkText(linkText);
  }

  private async handleOpenFile(
    filePath: string,
    lineNumber?: number,
    lineEnd?: number,
    linkText?: string,
  ): Promise<void> {
    getOutputChannel().appendLine(
      `[ACP-DEBUG] handleOpenFile: filePath="${filePath}" line=${lineNumber} lineEnd=${lineEnd} linkText="${linkText || ''}"`,
    );
    try {
      // Strip file:// protocol
      let cleanPath = filePath;
      if (cleanPath.startsWith('file://')) {
        cleanPath = vscode.Uri.parse(cleanPath).fsPath;
      }

      // Expand a leading ~ to the user's home dir (e.g. ~/notes/x.md, ~/.zshrc).
      // The linkifier emits ~/ paths verbatim into data-file, so without this
      // the expanded absolute path is required for openTextDocument to resolve.
      if (cleanPath === '~' || cleanPath.startsWith('~/')) {
        cleanPath = path.join(os.homedir(), cleanPath.slice(1));
      }

      // Build the initial URI from the path
      const isAbsolute = cleanPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(cleanPath);
      let uri: vscode.Uri;
      if (isAbsolute) {
        uri = vscode.Uri.file(cleanPath);
      } else {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
          uri = vscode.Uri.joinPath(workspaceFolders[0].uri, cleanPath);
        } else {
          uri = vscode.Uri.file(cleanPath);
        }
      }

      // Try to open directly. If it fails, try parent directories (for ../ paths
      // that reference sibling repos outside the workspace root), then fall back
      // to workspace search by filename.
      let doc: vscode.TextDocument | undefined;
      const tryPaths: vscode.Uri[] = [uri];

      // A relative path from the agent is relative to the AGENT's cwd, which is
      // not necessarily the workspace root: an codex session working in
      // /workspace/git/ezennin/llama.cpp emits `src/llama-memory-recurrent.cpp`,
      // and joining that onto this workspace root resolves to nothing. Try every
      // known session cwd, then every workspace folder.
      if (!isAbsolute) {
        for (const root of this.linkResolutionRoots()) {
          tryPaths.push(vscode.Uri.joinPath(vscode.Uri.file(root), cleanPath));
        }
      }

      // If the path contains ".." segments, also try resolving from parent
      // directories of the workspace root (handles sibling repos like
      // "up/../ssr/..." where ssr is a sibling of epg, not inside it).
      if (!isAbsolute && cleanPath.includes('..')) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
          const rootPath = workspaceFolders[0].uri.fsPath.replace(/\\/g, '/');
          // Try parent directories up to 3 levels up
          let parent = rootPath;
          for (let i = 0; i < 4; i++) {
            const lastSlash = parent.lastIndexOf('/');
            if (lastSlash <= 0) {
              break;
            }
            parent = parent.substring(0, lastSlash);
            tryPaths.push(vscode.Uri.joinPath(vscode.Uri.file(parent), cleanPath));
          }
        }
      }

      let opened = false;
      for (const tryUri of tryPaths) {
        try {
          doc = await vscode.workspace.openTextDocument(tryUri);
          uri = tryUri;
          opened = true;
          break;
        } catch {
          // try next path
        }
      }

      if (!opened && !isAbsolute && cleanPath.includes('..')) {
        // Try normalizing the path (resolve ".." segments) relative to workspace root
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
          const rootPath = workspaceFolders[0].uri.fsPath.replace(/\\/g, '/');
          const parts = (rootPath + '/' + cleanPath).split('/');
          const resolved: string[] = [];
          for (const p of parts) {
            if (p === '..') {
              resolved.pop();
            } else if (p !== '.' && p !== '') {
              resolved.push(p);
            }
          }
          const normalized = resolved.join('/');
          try {
            doc = await vscode.workspace.openTextDocument(vscode.Uri.file(normalized));
            uri = vscode.Uri.file(normalized);
            opened = true;
          } catch {
            // fall through to workspace search
          }
        }
      }

      if (!opened) {
        if (isAbsolute) {
          throw new Error(`File not found: ${cleanPath}`);
        }
        // Workspace-wide search by filename only
        const fileName = cleanPath.split('/').pop() || cleanPath;
        const foundFiles = await vscode.workspace.findFiles('**/' + fileName, '**/node_modules/**', 10);
        if (foundFiles.length === 0) {
          throw new Error(`File not found: ${cleanPath}`);
        }
        // Prefer the match whose path contains the original relative path
        const relPath = cleanPath.replace(/^\.\//, '');
        let best = foundFiles[0];
        let bestScore = -1;
        for (const f of foundFiles) {
          const fPath = f.fsPath.replace(/\\/g, '/');
          let score = 0;
          if (fPath.endsWith(relPath)) {
            score = relPath.length;
          } else if (fPath.includes(relPath)) {
            score = relPath.length - 10;
          } else {
            score = -fPath.length;
          }
          if (score > bestScore) {
            bestScore = score;
            best = f;
          }
        }
        uri = best;
        doc = await vscode.workspace.openTextDocument(uri);
      }

      if (!doc) {
        // File not found — if we have a symbol name (linkText), fall back
        // to workspace symbol search (LSP / ripgrep) to find the definition
        // in any file, not just the (possibly hallucinated) path from the LLM.
        const symFallback = this.symbolFallbackFromLinkText(linkText);
        if (symFallback) {
          getOutputChannel().appendLine(
            `[ACP-DEBUG] handleOpenFile: file not found, falling back to symbol search: "${symFallback}"`,
          );
          await this.handleOpenSymbol(symFallback);
          return;
        }
        throw new Error(`File not found: ${cleanPath}`);
      }
      const editor = await vscode.window.showTextDocument(doc, { preview: true });
      if (lineNumber && lineNumber > 0) {
        // The LLM may provide an inaccurate line number. Extract the symbol
        // name from the link text and verify it appears on the target line.
        // If not, search nearby lines (±80) for the symbol name and jump
        // to the closest match that looks like a definition.
        let effectiveLine = lineNumber;
        // Extract symbol name from linkText (e.g. "fen_shutdown()" → "fen_shutdown").
        // Guarded: a path-shaped link text yields no symbol, so `foo/bar.cpp:898`
        // no longer "corrects" the line to the nearest line containing "foo".
        const fullSym = this.symbolFallbackFromLinkText(linkText);
        // For Type::method(), use the method name for line searching
        // (the class name appears on many lines, the method name is more specific)
        const symName = fullSym?.includes('::') ? fullSym.split('::').pop() : fullSym;
        if (symName && lineEnd === undefined) {
          const targetLine = Math.min(lineNumber - 1, doc.lineCount - 1);
          const targetText = doc.lineAt(targetLine).text;
          // Check if the symbol name appears on the target line
          if (!targetText.includes(symName)) {
            // Search ±80 lines for the symbol name, preferring lines that
            // look like definitions (symbol followed by ( , ; or { )
            let bestLine = -1;
            let bestDist = 999;
            for (let i = -200; i <= 200; i++) {
              const checkLine = targetLine + i;
              if (checkLine < 0 || checkLine >= doc.lineCount) {
                continue;
              }
              const text = doc.lineAt(checkLine).text;
              if (text.includes(symName)) {
                const dist = Math.abs(i);
                // Prefer definition-like lines (symbol followed by ( or ; or {)
                const isDef =
                  new RegExp(symName + '\\s*[(;{]').test(text) ||
                  new RegExp('\\}\\s*' + symName + '\\s*[;=,]').test(text);
                const score = isDef ? dist : dist + 100;
                if (score < bestDist) {
                  bestDist = score;
                  bestLine = checkLine;
                }
              }
            }
            // For Type::method() links, if the full "Type::method" pattern was found,
            // prefer it over lines that only contain the bare method name (e.g.
            // "fen_shutdown()" vs "FenAdapter::shutdown()").
            if (fullSym && fullSym.includes('::')) {
              for (let i = -200; i <= 200; i++) {
                const checkLine = targetLine + i;
                if (checkLine < 0 || checkLine >= doc.lineCount) {
                  continue;
                }
                const text = doc.lineAt(checkLine).text;
                if (text.includes(fullSym)) {
                  const dist = Math.abs(i);
                  const isDef = new RegExp(fullSym.replace(/::/g, '::') + '\\s*[(;{]').test(text);
                  // Give fullSym matches a bonus (-50) so they beat bare method name matches
                  // that are closer but less specific (e.g. fen_shutdown() vs FenAdapter::shutdown())
                  const score = (isDef ? dist : dist + 100) - 50;
                  if (score < bestDist) {
                    bestDist = score;
                    bestLine = checkLine;
                  }
                }
              }
            }
            if (bestLine >= 0) {
              effectiveLine = bestLine + 1;
              getOutputChannel().appendLine(
                `[ACP-DEBUG] handleOpenFile: corrected line ${lineNumber} → ${effectiveLine} ` +
                  `(symbol "${symName}" not on target line, found nearby)`,
              );
            } else {
              // ±80 text search failed — try LSP workspace symbol search.
              // Uses clangd/rust-analyzer/etc. to find the exact definition,
              // which is far more reliable than text matching.
              try {
                const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
                  'vscode.executeWorkspaceSymbolProvider',
                  symName,
                );
                if (symbols && symbols.length > 0) {
                  const docUriStr = uri.toString();
                  let bestSym: vscode.SymbolInformation | undefined;
                  let bestSymScore = Infinity;
                  for (const sym of symbols) {
                    let score = 0;
                    const symFileStr = sym.location.uri.toString();
                    if (symFileStr !== docUriStr) {
                      score += 10000;
                    }
                    if (sym.name !== symName && !sym.name.endsWith('.' + symName)) {
                      score += 100;
                    }
                    if (score < bestSymScore) {
                      bestSymScore = score;
                      bestSym = sym;
                    }
                  }
                  if (bestSym) {
                    // If the symbol is in a different file, open that file instead
                    const symFileStr = bestSym.location.uri.toString();
                    if (symFileStr !== uri.toString()) {
                      const symDoc = await vscode.workspace.openTextDocument(bestSym.location.uri);
                      const symEditor = await vscode.window.showTextDocument(symDoc, { preview: true });
                      const symLine = bestSym.location.range.start.line + 1;
                      getOutputChannel().appendLine(
                        `[ACP-DEBUG] handleOpenFile: opened different file for LSP symbol "${symName}": ${bestSym.location.uri.fsPath}:${symLine}`,
                      );
                      this.revealLine(symLine, undefined, symEditor);
                      return;
                    }
                    effectiveLine = bestSym.location.range.start.line + 1;
                    getOutputChannel().appendLine(
                      `[ACP-DEBUG] handleOpenFile: corrected line ${lineNumber} → ${effectiveLine} ` +
                        `(LSP workspace symbol "${symName}")`,
                    );
                  }
                }
              } catch {
                // LSP not available — keep original line
              }
            }
          }
        }
        this.revealLine(effectiveLine, lineEnd, editor);
      }
    } catch (e) {
      // If the file could not be opened but we have a symbol name,
      // fall back to workspace symbol search (LSP / ripgrep).
      const symFallback = this.symbolFallbackFromLinkText(linkText);
      if (symFallback) {
        getOutputChannel().appendLine(
          `[ACP-DEBUG] handleOpenFile: error opening file, falling back to symbol search: "${symFallback}"`,
        );
        await this.handleOpenSymbol(symFallback);
      } else {
        vscode.window.showWarningMessage(`Could not open ${filePath}: ${(e as Error).message}`);
      }
    }
  }

  /**
   * Reveal a line (or line range) in the active editor.
   */
  private revealLine(lineNumber: number, lineEnd?: number, editor?: vscode.TextEditor): void {
    if (!editor) {
      editor = vscode.window.activeTextEditor;
    }
    if (editor) {
      const startLine = Math.min(lineNumber - 1, editor.document.lineCount - 1);
      const endLine =
        lineEnd && lineEnd > lineNumber ? Math.min(lineEnd - 1, editor.document.lineCount - 1) : startLine;
      const range = new vscode.Range(startLine, 0, endLine, editor.document.lineAt(endLine).text.length);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      editor.selection = new vscode.Selection(range.start, range.start);
    }
  }

  /**
   * Jump to a symbol in the workspace.
   * Uses the workspace symbol provider to find the definition, then
   * opens the file and reveals the location directly.
   * Falls back to Quick Open if no exact match is found.
   * Retries with backoff while language server (e.g. clangd) is still indexing.
   */
  private async handleOpenSymbol(symbolName: string): Promise<void> {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    // Show a progress notification while searching
    const status = vscode.window.setStatusBarMessage(`Searching for symbol ${symbolName}…`);

    try {
      // Try up to 2 times with short backoff. The first attempt is immediate;
      // if clangd returns nothing (still indexing), retry once after 2s.
      // The executeCommand itself has a 5s timeout to prevent hanging.
      const delays = [0, 2000];
      let symbols: vscode.SymbolInformation[] | undefined;

      const searchStart = Date.now();
      for (let attempt = 0; attempt < delays.length; attempt++) {
        if (delays[attempt] > 0) {
          await sleep(delays[attempt]);
        }
        try {
          const attemptStart = Date.now();
          symbols = await Promise.race([
            vscode.commands.executeCommand<vscode.SymbolInformation[]>(
              'vscode.executeWorkspaceSymbolProvider',
              symbolName,
            ),
            new Promise<undefined>((r) => setTimeout(() => r(undefined), 5000)),
          ]);
          getOutputChannel().appendLine(
            `[ACP-DEBUG] handleOpenSymbol: attempt=${attempt} took=${Date.now() - attemptStart}ms found=${symbols?.length ?? 0}`,
          );
        } catch {
          // Provider not ready yet — keep retrying
        }
        if (symbols && symbols.length > 0) {
          break;
        }
      }
      getOutputChannel().appendLine(`[ACP-DEBUG] handleOpenSymbol: total took=${Date.now() - searchStart}ms`);

      status.dispose();

      if (symbols && symbols.length > 0) {
        getOutputChannel().appendLine(
          `[ACP-DEBUG] handleOpenSymbol: "${symbolName}" found ${symbols.length} symbols: ` +
            symbols.map((s) => `${s.name}@${s.location.uri.fsPath}:${s.location.range.start.line + 1}`).join(', '),
        );
        // Try to find an exact name match first
        // When multiple exact matches exist, prefer non-SDK paths
        // (workspace/git repos over /proj/epg-sdk/ install paths)
        const exactMatches = symbols.filter((s) => s.name === symbolName);
        let best: (typeof symbols)[0] | undefined;
        if (exactMatches.length === 1) {
          best = exactMatches[0];
        } else if (exactMatches.length > 1) {
          // Prefer non-SDK paths: /workspace/git/ over /proj/
          best =
            exactMatches.find(
              (s) => !/(\/proj\/|\/epg-sdk\/|\/sdk\/|\/install\/|\.cache\/)/.test(s.location.uri.fsPath),
            ) || exactMatches[0];
        }
        // If symbolName is "Type::method", try matching just "method"
        if (!best && symbolName.includes('::')) {
          const parts = symbolName.split('::');
          const methodName = parts[parts.length - 1];
          best = symbols.find((s) => s.name === methodName);
          if (!best) {
            // Try the type name (first part)
            const typeName = parts[0];
            best = symbols.find((s) => s.name === typeName);
          }
        }
        if (!best) {
          // No exact match — try word-boundary containment match.
          // E.g. clicking 'N2ResModify' should NOT jump to a class named
          // 'DedicatedQosFlowsModificationFailure3N2ResourceModify...'
          // just because it fuzzy-matched. Only accept symbols where the
          // search term appears as a distinct word/token.
          const wordBoundaryMatches = symbols.filter((s) => {
            const name = s.name;
            // Check if symbolName appears as a whole word in the symbol name
            // Word boundaries in C++/Rust/Go: camelCase transitions, underscores, ::
            const re = new RegExp(
              '(?:^|_|::|[A-Z])' + symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=$|_|::|[A-Z])',
            );
            return re.test(name);
          });
          if (wordBoundaryMatches.length === 1) {
            best = wordBoundaryMatches[0];
          } else if (wordBoundaryMatches.length > 1) {
            // Multiple candidates — let user pick via Quick Open
            await vscode.commands.executeCommand('workbench.action.quickOpen', '#' + symbolName);
            return;
          }
          // If no word-boundary match either, fall through to Quick Open
        }

        if (best) {
          let loc = best.location;
          getOutputChannel().appendLine(
            `[ACP-DEBUG] handleOpenSymbol: symbolName="${symbolName}" best.name="${best.name}" ` +
              `kind=${best.kind} uri=${loc.uri.fsPath} line=${loc.range.start.line + 1} char=${loc.range.start.character}`,
          );

          // If the best match is in a header file (.h/.hpp/.hxx), try to find
          // the implementation in a source file (.c/.cpp/.cc/.rs) instead.
          // clangd's workspace symbol search often returns only the declaration
          // in the header, not the definition in the source file.
          const headerExts = ['.h', '.hpp', '.hxx', '.hh', '.H'];
          const srcExts = ['.c', '.cpp', '.cc', '.cxx', '.rs', '.go', '.ts', '.js'];
          const bestFsPath = loc.uri.fsPath;
          const isHeader = headerExts.some((ext) => bestFsPath.endsWith(ext));
          const _isSrcFile = srcExts.some((ext) => bestFsPath.endsWith(ext));
          // Check if any other symbol from the results is in a source file
          if (isHeader) {
            // First, check if there's another symbol in a source file with exact name match
            const srcMatch = symbols.find(
              (s) => s.name === best.name && srcExts.some((ext) => s.location.uri.fsPath.endsWith(ext)),
            );
            if (srcMatch) {
              loc = srcMatch.location;
              getOutputChannel().appendLine(
                `[ACP-DEBUG] handleOpenSymbol: preferred source file over header: ` +
                  `${loc.uri.fsPath}:${loc.range.start.line + 1}`,
              );
            } else {
              // No source match in results — use definition provider to find implementation
              try {
                const defs = await Promise.race([
                  vscode.commands.executeCommand<vscode.Location[] | vscode.Location>(
                    'vscode.executeDefinitionProvider',
                    loc.uri,
                    loc.range.start,
                  ),
                  new Promise<undefined>((r) => setTimeout(() => r(undefined), 3000)),
                ]);
                if (defs) {
                  const defArr = Array.isArray(defs) ? defs : [defs];
                  // Find a definition that's in a source file (not the same header)
                  const srcDef = defArr.find(
                    (d) => srcExts.some((ext) => d.uri.fsPath.endsWith(ext)) && d.uri.fsPath !== bestFsPath,
                  );
                  if (srcDef) {
                    loc = srcDef;
                    getOutputChannel().appendLine(
                      `[ACP-DEBUG] handleOpenSymbol: definition provider found source: ` +
                        `${loc.uri.fsPath}:${loc.range.start.line + 1}`,
                    );
                  }
                }
              } catch {
                // Definition provider failed — stick with header location
              }
            }
          }

          // NOTE: The header→source ripgrep fallback was removed because it
          // frequently redirected to call sites or test files instead of the
          // actual definition. The LSP result (or definition provider result)
          // is now used as-is. For sibling-repo symbols, the LLM should use
          // path:line links instead of @symbol: links.

          const doc = await vscode.workspace.openTextDocument(loc.uri);
          const editor = await vscode.window.showTextDocument(doc, { preview: true });
          editor.revealRange(loc.range, vscode.TextEditorRevealType.InCenter);
          editor.selection = new vscode.Selection(loc.range.start, loc.range.start);
          return;
        }
      }

      // No exact or word-boundary match found — fall back to Quick Open
      // LSP workspace symbols returned nothing (clangd background index may
      // not be ready). Try a ripgrep-based search for the symbol definition
      // in C/C++/Rust/Go source files before falling back to Quick Open.
      const rgResult = await this.findSymbolWithRipgrep(symbolName);
      if (rgResult) {
        getOutputChannel().appendLine(
          `[ACP-DEBUG] handleOpenSymbol: ripgrep fallback found: ` +
            `${rgResult.location.uri.fsPath}:${rgResult.location.range.start.line + 1}`,
        );
        const doc = await vscode.workspace.openTextDocument(rgResult.location.uri);
        const editor = await vscode.window.showTextDocument(doc, { preview: true });
        editor.revealRange(rgResult.location.range, vscode.TextEditorRevealType.InCenter);
        editor.selection = new vscode.Selection(rgResult.location.range.start, rgResult.location.range.start);
        return;
      }
      // Ripgrep found nothing either — fall back to Quick Open
      await vscode.commands.executeCommand('workbench.action.quickOpen', '#' + symbolName);
    } catch (e) {
      status.dispose();
      // Fallback: try ripgrep, then Quick Open with # prefix
      const rgResult = await this.findSymbolWithRipgrep(symbolName);
      if (rgResult) {
        const doc = await vscode.workspace.openTextDocument(rgResult.location.uri);
        const editor = await vscode.window.showTextDocument(doc, { preview: true });
        editor.revealRange(rgResult.location.range, vscode.TextEditorRevealType.InCenter);
        editor.selection = new vscode.Selection(rgResult.location.range.start, rgResult.location.range.start);
        return;
      }
      try {
        await vscode.commands.executeCommand('workbench.action.quickOpen', '#' + symbolName);
      } catch {
        vscode.window.showWarningMessage(`Could not find symbol ${symbolName}: ${(e as Error).message}`);
      }
    }
  }

  /**
   * Fallback symbol search using ripgrep when LSP workspace symbols return
   * nothing (e.g. clangd background index not ready). Searches for the symbol
   * name as a definition in C/C++/Rust/Go/Java source files.
   * Returns the best match as a vscode.Location, or undefined.
   */
  private async findSymbolWithRipgrep(
    symbolName: string,
  ): Promise<{ location: vscode.Location; score: number } | undefined> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return undefined;
    }

    // Build search roots: workspace folders + their parent directory.
    // The parent covers sibling repos (e.g. ../ssr) that are outside the
    // workspace root but share a common parent (e.g. vepg/epg + vepg/ssr).
    const searchRoots: string[] = [];
    const seenRoots = new Set<string>();
    for (const folder of folders) {
      const fp = folder.uri.fsPath;
      if (!seenRoots.has(fp)) {
        seenRoots.add(fp);
        searchRoots.push(fp);
      }
      const parent = fp.substring(0, fp.lastIndexOf('/'));
      if (parent && !seenRoots.has(parent)) {
        seenRoots.add(parent);
        searchRoots.push(parent);
      }
    }

    // Escape regex special chars in the symbol name
    const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // rg --word-regexp matches the symbol name as a whole word.
    // We then score candidates by how definition-like each line is.
    const srcGlobs = [
      '*.c',
      '*.cpp',
      '*.cc',
      '*.cxx',
      '*.h',
      '*.hpp',
      '*.hxx',
      '*.hh',
      '*.rs',
      '*.go',
      '*.java',
      '*.kt',
      '*.ts',
      '*.js',
    ];

    for (const root of searchRoots) {
      try {
        const rgArgs = [
          '--no-heading',
          '--line-number',
          '--with-filename',
          '--max-count',
          '20',
          ...srcGlobs.flatMap((g) => ['-g', g]),
          '--word-regexp',
          symbolName,
          root,
        ];
        const { stdout } = await execFileAsync('rg', rgArgs, { timeout: 10000, maxBuffer: 1024 * 1024 });

        const lines = stdout
          .trim()
          .split('\n')
          .filter((l) => l.length > 0);
        if (lines.length === 0) {
          continue;
        }

        // Parse rg output: file:line:content
        const candidates: { uri: vscode.Uri; line: number; content: string; score: number }[] = [];
        for (const line of lines) {
          const m = line.match(/^(.+?):(\d+):(.*)$/);
          if (!m) {
            continue;
          }
          const [, filePath, lineStr, content] = m;
          const lineNum = parseInt(lineStr, 10) - 1; // 0-based for VS Code

          // Score candidates: prefer definition-like lines
          let score = 0;
          const trimmed = content.trim();
          // Symbol name appears at start of line (after optional return type)
          const defRe = new RegExp(`^(?:\\w+[\\s\\*]+)*${escaped}\\s*[(\\{;]`);
          if (defRe.test(trimmed)) {
            score += 100;
          }
          // C typedef struct close: "} type_name_t;" or "} type_name_t ="
          if (new RegExp(`^\\}\\s*${escaped}\\s*[;=,]`).test(trimmed)) {
            score += 100;
          }
          // Contains definition keywords
          if (/\b(?:fn|func|struct|enum|class|interface|typedef|type|union)\b/.test(trimmed)) {
            score += 50;
          }
          // Symbol name is the first token on the line
          if (new RegExp(`^${escaped}\\b`).test(trimmed)) {
            score += 30;
          }
          // Prefer source files over headers
          if (/\.(c|cpp|cc|cxx|rs|go|java|kt|ts|js)$/.test(filePath)) {
            score += 20;
          }
          // Prefer project source over SDK/install paths
          if (!/(\/proj\/|\/epg-sdk\/|\/sdk\/|\/install\/|\.cache\/)/.test(filePath)) {
            score += 15;
          }
          // Penalize lines that look like calls (symbol followed by ( but not
          // preceded by a type — likely a function call, not a definition)
          if (score === 0 && new RegExp(`${escaped}\\s*\\(`).test(trimmed)) {
            score -= 10;
          }

          candidates.push({ uri: vscode.Uri.file(filePath), line: lineNum, content, score });
        }

        if (candidates.length === 0) {
          continue;
        }

        // Sort by score descending, pick the best
        candidates.sort((a, b) => b.score - a.score);
        const best = candidates[0];
        getOutputChannel().appendLine(
          `[ACP-DEBUG] findSymbolWithRipgrep: "${symbolName}" best candidate ` +
            `${best.uri.fsPath}:${best.line + 1} score=${best.score} content="${best.content.trim()}"`,
        );
        return {
          location: new vscode.Location(best.uri, new vscode.Range(best.line, 0, best.line, 0)),
          score: best.score,
        };
      } catch (e: any) {
        // rg returns exit code 1 when no matches found — that's fine
        if (e.code !== 1) {
          getOutputChannel().appendLine(`[ACP-DEBUG] findSymbolWithRipgrep: rg error: ${e.message}`);
        }
      }
    }
    return undefined;
  }

  /**
   * Open VS Code diff editor for a tool call's file changes.
   */
  private async handleOpenDiff(toolCallId: string): Promise<void> {
    const diffs = this.toolCallDiffs.get(toolCallId);
    if (!diffs || diffs.length === 0) {
      return;
    }
    for (const diff of diffs) {
      const oldUri = vscode.Uri.parse(`acp-diff:${diff.path}?tc=${toolCallId}&v=old`);
      const newUri = vscode.Uri.parse(`acp-diff:${diff.path}?tc=${toolCallId}&v=new`);
      const provider: vscode.TextDocumentContentProvider = {
        provideTextDocumentContent(uri: vscode.Uri): string {
          return uri.query.includes('v=old') ? diff.oldText || '' : diff.newText;
        },
      };
      const reg = vscode.workspace.registerTextDocumentContentProvider('acp-diff', provider);
      try {
        const fileName = diff.path.split(/[\\/]/).pop() || diff.path;
        await vscode.commands.executeCommand('vscode.diff', oldUri, newUri, `${fileName} (changes)`);
      } catch {
        /* ignore */
      }
      setTimeout(() => reg.dispose(), 10000);
    }
  }

  /**
   * Pick a file or folder via Quick Pick and send the path back to the webview.
   */
  private async handlePickContext(contextType: string): Promise<void> {
    if (contextType === 'file') {
      const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 500);
      const items = files.map((f) => ({ label: vscode.workspace.asRelativePath(f), uri: f }));
      const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select a file to attach' });
      if (picked) {
        this.postMessage({ type: 'contextPicked', contextType: 'file', path: picked.label });
      }
    } else if (contextType === 'folder') {
      const _folders = await vscode.workspace.findFiles('**/', '**/node_modules/**', 200);
      // Get unique directories from workspace
      const dirSet = new Set<string>();
      const allFiles = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 1000);
      for (const f of allFiles) {
        const rel = vscode.workspace.asRelativePath(f);
        const dir = rel.includes('/') ? rel.substring(0, rel.lastIndexOf('/')) : '.';
        dirSet.add(dir);
      }
      const items = [...dirSet].sort().map((d) => ({ label: d }));
      const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select a folder to attach' });
      if (picked) {
        this.postMessage({ type: 'contextPicked', contextType: 'folder', path: picked.label });
      }
    } else if (contextType === 'session') {
      // Show a QuickPick of renamed sessions across all agents
      const historyStore = this.sessionManager.getHistoryStore();
      if (!historyStore) {
        this.postMessage({ type: 'sessionSummary', error: 'No session history available.' });
        return;
      }
      const renamedEntries = historyStore.listAllRenamed();
      if (renamedEntries.length === 0) {
        this.postMessage({
          type: 'sessionSummary',
          error: 'No renamed sessions found. Use /rename in a session to name it first.',
        });
        return;
      }
      // Sort by lastActiveAt descending (most recent first)
      renamedEntries.sort((a, b) => (b.lastActiveAt || '').localeCompare(a.lastActiveAt || ''));
      const items = renamedEntries.map((e) => ({
        label: e.title!,
        description:
          (e.lastActiveAt ? new Date(e.lastActiveAt).toLocaleString() : '') +
          (e.agentName ? ' (' + e.agentName + ')' : ''),
        detail: e.firstPrompt ? e.firstPrompt.slice(0, 80) : '',
        sessionId: e.sessionId,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a session to summarize as context',
      });
      if (picked) {
        // Reuse the summarize flow with the picked session title
        await this.handleSummarizeSessionCommand(picked.label);
      }
    }
  }

  /**
   * Handle /session <name> slash command.
   * Finds renamed sessions matching the given name (fuzzy contains match),
   * summarizes the best match via responses-vllm-proxy POST /v1/summarize-session
   * (configured by acp.sessionSummary.endpoint), and posts the summary back to
   * the webview to display as a context block in the chat.
   */
  private async handleSummarizeSessionCommand(sessionName: string, queryText?: string): Promise<void> {
    const historyStore = this.sessionManager.getHistoryStore();
    if (!historyStore) {
      this.postMessage({ type: 'sessionSummary', error: 'Session history not available.', queryText });
      return;
    }

    const activeAgent = this.sessionManager.getActiveAgentName();
    if (!activeAgent) {
      this.postMessage({ type: 'sessionSummary', error: 'No active agent. Connect to an agent first.', queryText });
      return;
    }

    // List all renamed sessions across ALL agents (cross-agent /session)
    const renamedEntries = historyStore.listAllRenamed();
    if (renamedEntries.length === 0) {
      this.postMessage({
        type: 'sessionSummary',
        error: 'No renamed sessions found. Use /rename in a session to name it first.',
      });
      return;
    }

    // Find the best matching session (case-insensitive contains match)
    const query = sessionName.toLowerCase();
    let bestMatch: { sessionId: string; title: string; lastActiveAt: string; agentName: string } | null = null;
    for (const e of renamedEntries) {
      const title = (e.title || '').toLowerCase();
      if (title === query) {
        bestMatch = { sessionId: e.sessionId, title: e.title!, lastActiveAt: e.lastActiveAt, agentName: e.agentName };
        break;
      }
      if (title.includes(query)) {
        if (!bestMatch || (e.lastActiveAt || '') > bestMatch.lastActiveAt) {
          bestMatch = { sessionId: e.sessionId, title: e.title!, lastActiveAt: e.lastActiveAt, agentName: e.agentName };
        }
      }
    }
    if (!bestMatch) {
      for (const e of renamedEntries) {
        const fp = (e.firstPrompt || '').toLowerCase();
        if (fp.includes(query)) {
          if (!bestMatch || (e.lastActiveAt || '') > bestMatch.lastActiveAt) {
            bestMatch = {
              sessionId: e.sessionId,
              title: e.title!,
              lastActiveAt: e.lastActiveAt,
              agentName: e.agentName,
            };
          }
        }
      }
    }

    if (!bestMatch) {
      const available = renamedEntries.map((e) => '"' + e.title + '"').join(', ');
      this.postMessage({
        type: 'sessionSummary',
        error: 'No session matching "' + sessionName + '". Renamed sessions: ' + available,
        queryText,
      });
      return;
    }

    const picked = bestMatch;

    try {
      // Capture messages from the selected session. captureSessionMessages
      // now unconditionally restores the original (agent, session)
      // afterward and throws if the restore fails — so on a successful
      // return the active connection is guaranteed back to where it was,
      // and a cross-agent /session lookup can no longer morph the picker.
      const messages = await this.captureSessionMessages(picked.sessionId, picked.agentName);

      if (messages.length === 0) {
        this.postMessage({ type: 'sessionSummary', error: 'No messages found in that session.', queryText });
        return;
      }

      const summaryCfg = readSessionSummarySettings();

      // Shared with acp.forkToAgent: responses-vllm-proxy primary, then the
      // configured OpenAI-compatible fallback. The outer catch reports any
      // other failure (capture, etc.); this one keeps the summarize error text.
      let result: { summary: string; model: string };
      try {
        result = await summarizeSession(picked.title, messages, summaryCfg);
      } catch (e: any) {
        this.postMessage({
          type: 'sessionSummary',
          error: e?.message || String(e),
          queryText,
        });
        return;
      }

      this.postMessage({
        type: 'sessionSummary',
        summary: result.summary,
        sessionTitle: picked.title,
        model: result.model,
        queryText,
      });
    } catch (e: any) {
      this.postMessage({
        type: 'sessionSummary',
        error: 'Failed to summarize session: ' + (e?.message || e),
        queryText,
      });
    }
  }

  /**
   * Send the list of renamed session names to the webview for autocomplete.
   */
  private handleGetSessionNames(): void {
    const historyStore = this.sessionManager.getHistoryStore();
    if (!historyStore) {
      this.postMessage({ type: 'sessionNames', names: [] });
      return;
    }
    const renamed = historyStore.listAllRenamed().map((e) => e.title!);
    this.postMessage({ type: 'sessionNames', names: renamed });
  }

  /**
   * Capture messages from a session by doing a background session/load.
   * Registers a temporary listener on the SessionUpdateHandler to collect
   * user_message_chunk and agent_message_chunk updates, then restores
   * the original active session.
   */
  private async captureSessionMessages(
    sessionId: string,
    targetAgentName?: string,
  ): Promise<Array<{ role: string; content: string }>> {
    const activeAgent = this.sessionManager.getActiveAgentName();
    if (!activeAgent) {
      return [];
    }

    // Use the target agent if specified (cross-agent session summarization),
    // otherwise fall back to the currently active agent.
    const sessionAgent = targetAgentName || activeAgent;

    const originalSessionId = this.sessionManager.getActiveSessionId();
    const messages: Array<{ role: string; content: string }> = [];
    let currentUserText = '';
    let currentAgentText = '';

    // Suppress webview updates during the background load/restore —
    // otherwise the chat flashes as sessions are swapped in and out.
    this.suppressWebviewUpdates = true;

    // Temporary listener to capture replayed messages
    const captureListener = (update: SessionNotification) => {
      const data = update.update as any;
      const kind = data?.sessionUpdate;
      if (kind === 'user_message_chunk' && data?.content?.text) {
        currentUserText += data.content.text;
      } else if (kind === 'agent_message_chunk' && data?.content?.text) {
        currentAgentText += data.content.text;
      } else if (kind === 'promptEnd') {
        // End of a turn — flush accumulated text
        if (currentUserText) {
          messages.push({ role: 'user', content: currentUserText });
          currentUserText = '';
        }
        if (currentAgentText) {
          messages.push({ role: 'assistant', content: currentAgentText });
          currentAgentText = '';
        }
      }
    };

    this.sessionUpdateHandler.addListener(captureListener);

    // Capture the exact (agent, session) to restore. The cross-agent
    // session/load below disconnects the active agent and connects the target
    // agent; without an unconditional restore the user is left on the target
    // agent (e.g. a /session lookup that matched a Kiro CLI session would morph
    // an Codex session's picker to Kiro/Claude models and never switch back).
    const restoreTarget = { agent: activeAgent, sessionId: originalSessionId };

    try {
      // Load the session — this replays all messages as session/update
      await this.sessionManager.loadSession(sessionAgent, sessionId);
      // Flush any remaining text after the replay completes
      if (currentUserText) {
        messages.push({ role: 'user', content: currentUserText });
      }
      if (currentAgentText) {
        messages.push({ role: 'assistant', content: currentAgentText });
      }
    } finally {
      this.sessionUpdateHandler.removeListener(captureListener);
    }

    // Unconditionally restore the original (agent, session) if the capture
    // left the active connection on anything else. This runs whether or not the
    // load above threw, and regardless of whether the active session is null
    // (prior restore swallowed errors and was skipped when a truthy target
    // session remained active — that was the morph bug).
    const postCaptureAgent = this.sessionManager.getActiveAgentName();
    const postCaptureSession = this.sessionManager.getActiveSessionId();
    const needsRestore = needsRestoreAfterCapture(restoreTarget, postCaptureAgent, postCaptureSession);
    if (needsRestore) {
      try {
        // Reconnect the original agent first (loadSession disconnects any
        // other active agent), then reload the original session so the
        // webview, model picker, and config options all return to the
        // pre-/session state.
        await this.sessionManager.connectToAgent(restoreTarget.agent);
        await this.sessionManager.loadSession(restoreTarget.agent, restoreTarget.sessionId!);
      } catch (e: any) {
        // The restore failed — most commonly because the original session
        // was a fresh session/new that never received a prompt (no rollout
        // persisted to disk). loadSession's catch block already handles
        // "not found" / "no rollout" by creating a new session, but if the
        // error is something else, log it and let loadSession's fallback
        // (new session creation) take over. Do NOT throw — throwing here
        // crashes the /session flow and leaves the user on a "Resume Codex"
        // button screen with no way to continue.
        log(
          `captureSessionMessages: restore to ${restoreTarget.agent}/${restoreTarget.sessionId} failed: ${e?.message || e}`,
        );
        // If loadSession already created a new session as its fallback,
        // there is nothing more to do. If not (non-"not found" error),
        // the connectToAgent above already spawned a fresh agent process
        // with a new session — the user can continue from there.
      }
    }
    this.suppressWebviewUpdates = false;
    this.sendCurrentState();

    return messages;
  }

  /**
   * Send current session state to the webview on load.
   */
  private sendCurrentState(opts?: { isPromptInFlightOverride?: boolean }): void {
    const activeId = this.sessionManager.getActiveSessionId();
    const session = activeId ? this.sessionManager.getSession(activeId) : null;
    // TEMP-DEBUG: log every state push with the in-flight snapshot so we can
    // see which state message carries isPromptInFlight when Kiro resume loads.
    const _inflightAtSend =
      typeof opts?.isPromptInFlightOverride === 'boolean'
        ? opts.isPromptInFlightOverride
        : !!(activeId && this.sessionManager.isPromptInFlight(activeId));
    if (DEBUG_LIVE) {
      try {
        const _st = new Error().stack?.split('\n').slice(1, 4).map((l) => l.trim().replace(/^at /, '')).join(' | ') || '';
        log(`sendCurrentState: activeId=${activeId || '(none)'} session=${session?.sessionId || '(none)'} isPromptInFlight=${_inflightAtSend} caller=[${_st}]`);
      } catch {
        log(`sendCurrentState: activeId=${activeId || '(none)'} session=${session?.sessionId || '(none)'} isPromptInFlight=${_inflightAtSend} caller=[unknown]`);
      }
    }
    // Read the last connected agent from workspaceState (persists across restarts).
    const lastAgent = this.workspaceState.get<string>('acp.lastConnectedAgent');
    const lastAgentDisplay = this.workspaceState.get<string>('acp.lastConnectedAgentDisplay');
    const lastSessionId = this.workspaceState.get<string>('acp.lastConnectedSessionId');
    this.postMessage({
      type: 'state',
      // Off by default. Pushing a mid-turn message into the running turn means the
      // agent may answer only the most recent interjection: observed on codex —
      // two messages steered at 07:11:45 and 07:12:07, both echoed and both
      // removed from the queue, and only the second was answered. Queue-and-drain
      // keeps order and gives every message its own turn.
      autoSteerQueued: vscode.workspace.getConfiguration('acp').get<boolean>('autoSteerQueuedMessages') !== false,
      activeSessionId: activeId,
      session: session
        ? {
            sessionId: session.sessionId,
            agentName: session.agentDisplayName,
            agentConfigKey: session.agentName,
            title: cleanSessionTitle(session.title) || session.title,
            cwd: session.cwd,
            gitBranch: this._cachedGitBranch || undefined,
            modes: session.modes,
            models: session.models,
            configOptions: session.configOptions,
            availableCommands: session.availableCommands,
            promptCapabilities: activeId ? this.sessionManager.getPromptCapabilities(activeId) : undefined,
            currentModelImageSupport: session.models?.currentModelId
              ? this.modelSupportsImage(session.models.currentModelId, session.agentName)
              : undefined,
            modelImageMap: this.getModelImageMap(),
            goalSnapshot: (session as any)?.goalSnapshot ?? null,
          }
        : null,
      lastAgent: lastAgent || undefined,
      lastAgentDisplay: lastAgentDisplay || undefined,
      lastSessionId: lastSessionId || undefined,
      isFollowing: this._isFollowing,
      // If the active session has an in-flight prompt, signal the webview to
      // restore isProcessing=true. When the webview is disposed/recreated
      // (e.g. user switches to Copilot Chat and back), its module-level
      // isProcessing resets to false, so the Send button shows instead of
      // Stop even though the agent is still streaming. This re-establishes
      // the correct processing state on webview ready.
      isPromptInFlight: _inflightAtSend,
    });
  }

  /**
   * Post a message to the webview if it exists and is ready.
   * Queues messages while the webview hasn't sent 'ready' yet.
   */
  private postMessage(message: any): void {
    this.traceReplayPost(message);
    if (this.webviewReady) {
      this.view?.webview.postMessage(message);
    } else {
      this.pendingMessages.push(message);
    }
  }

  /**
   * Record the exact order in which session/update messages are handed to the
   * webview during a session/load replay.
   *
   * The coalesced text path (StreamCoalescer.onFlush) and the direct path
   * (tool_call, plan_update, …) both funnel through postMessage, so logging
   * here — rather than at each call site — captures the true post order.
   * Diffing it against the webview's arrival order and the chatHistory push
   * order localizes a lost interleave to exactly one stage.
   *
   * No-op unless `acp.debugResume` is on AND the session is mid-load.
   */
  private replayPostSeq = 0;

  private traceReplayPost(message: any): void {
    if (!message || message.type !== 'sessionUpdate' || !this.isDebugResume()) {
      return;
    }
    const sessionId = message.sessionId as string | undefined;
    if (!sessionId || !this.sessionManager.isLoading(sessionId)) {
      this.replayPostSeq = 0;
      return;
    }
    const upd = message.update as any;
    const kind = String(upd?.sessionUpdate || '?');
    let detail = '';
    if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
      detail = ` id=${upd?.messageId || '-'} len=${String(upd?.content?.text || '').length}`;
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      detail = ` tool="${String(upd?.title || '').replace(/\s+/g, ' ').slice(0, 40)}"`;
    } else if (kind === 'user_message_chunk') {
      detail = ` len=${String(upd?.content?.text || '').length}`;
    }
    this.logResumeDiag(`[WV-ORDER] host-post #${++this.replayPostSeq} ${kind}${detail}`);
  }

  /**
   * Notify webview of a new active session.
   */
  notifyActiveSessionChanged(): void {
    if (this.suppressWebviewUpdates) {
      return;
    }
    // Drop any pending coalesced text from the previous session — its
    // webview-side state is about to be replaced.
    this.dropAllStreamBuffers();
    // Refresh git branch for the new session's cwd, then send state.
    const session = this.sessionManager.getActiveSession();
    if (session?.cwd) {
      // Capture the in-flight snapshot BEFORE starting the async git-branch
      // refresh. It is re-posted by the .then() below; reading it AFTER the
      // await races other host activity (e.g. restoreConfigOptions →
      // sendSlashCommand adding the session to inFlightPromptSessions for
      // ~1ms), which would post a STALE isPromptInFlight=true to the webview
      // and latch isProcessing forever (bug: resumed Kiro session shows a
      // permanent Stop button, messages can't be sent).
      const _inflightBeforeGit = !!(
        this.sessionManager.getActiveSessionId() &&
        this.sessionManager.isPromptInFlight(this.sessionManager.getActiveSessionId()!)
      );
      this.refreshGitBranch(session.cwd).then(() => {
        // The deferred state push must reflect the snapshot taken at call
        // time, not whatever happened during the git refresh await — so a
        // transient in-flight flag from an unrelated concurrent operation
        // can never leak into this state message.
        this.sendCurrentState({ isPromptInFlightOverride: _inflightBeforeGit });
      });
    }
    this.sendCurrentState();
    if (session && isCursorAgentName(session.agentName)) {
      this.scheduleCursorBatchEnrich(session.sessionId);
    }
  }

  /**
   * Notify webview of mode state changes.
   *
   * Guarded by suppressWebviewUpdates so a cross-agent /session capture (which
   * swaps agents mid-flight and emits mode-changed for the *target* agent) can't
   * flash the picker to the foreign agent's modes. The final sendCurrentState()
   * after the capture re-publishes the original agent's state.
   */
  notifyModesUpdate(modes: any): void {
    if (this.suppressWebviewUpdates) {
      return;
    }
    this.postMessage({ type: 'modesUpdate', modes });
  }

  /**
   * Notify webview of model state changes.
   *
   * Same suppression guard as notifyModesUpdate: without it a cross-agent
   * /session lookup would briefly morph the model picker to the captured-from
   * agent's models (e.g. an Codex session picker flashing to Kiro/Claude
   * models and back) even though the active connection is restored afterward.
   */
  notifyModelsUpdate(models: any): void {
    if (this.suppressWebviewUpdates) {
      return;
    }
    const currentModelId = models?.currentModelId;
    this.postMessage({
      type: 'modelsUpdate',
      models,
      currentModelImageSupport: currentModelId
        ? this.modelSupportsImage(currentModelId, this.sessionManager.getActiveAgentName() ?? undefined)
        : undefined,
    });
  }

  /**
   * Notify webview of session config-option state changes.
   *
   * Same suppression guard: a cross-agent /session capture emits
   * config-options-changed for the target agent, which would otherwise flash
   * the config strip (model selector, thought_level, etc.) to the foreign
   * agent's options mid-capture.
   */
  notifyConfigOptionsUpdate(configOptions: any): void {
    if (this.suppressWebviewUpdates) {
      return;
    }
    this.postMessage({ type: 'configOptionsUpdate', configOptions });
  }

  /** Notify webview of _kiro.dev/metadata (Kiro CLI: contextUsagePercentage, effort). */
  notifyKiroMetadata(params: any): void {
    this.postMessage({ type: 'kiroMetadata', params });
  }

  /** Notify webview of _kiro.dev/subagent/list_update (Kiro CLI: live subagent statuses). */
  notifyKiroSubagentListUpdate(params: any): void {
    this.postMessage({ type: 'kiroSubagentListUpdate', params });
  }

  /** Notify webview of merged available slash commands (ACP + Kiro). */
  notifyAvailableCommands(commands: any[]): void {
    this.postMessage({
      type: 'sessionUpdate',
      update: { sessionUpdate: 'available_commands_update', availableCommands: commands || [] },
    });
  }

  /** Notify webview of _kiro.dev/compaction/status progress. */
  notifyKiroCompactionStatus(params: any): void {
    this.postMessage({ type: 'kiroCompactionStatus', params });
  }

  /** Notify webview of _kiro.dev/clear/status progress. */
  notifyKiroClearStatus(params: any): void {
    this.postMessage({ type: 'kiroClearStatus', params });
  }

  /** Store and forward a Codex/Kiro goal snapshot so the chip can leave `active`. */
  private applyGoalSnapshot(sessionId: string, goalSnapshot: any): void {
    const session = this.sessionManager.getSession(sessionId);
    if (session) {
      (session as any).goalSnapshot = goalSnapshot;
    }
    const status = goalSnapshot?.status ?? 'cleared';
    const objective = typeof goalSnapshot?.objective === 'string' ? goalSnapshot.objective.slice(0, 80) : '';
    log(`goal snapshot: session=${sessionId} status=${status} objective="${objective}"`);
    if (sessionId === this.sessionManager.getActiveSessionId()) {
      this.postMessage({ type: 'kiroGoalStatus', sessionId, goalSnapshot });
    }
  }

  /** Notify webview of _kiro.dev/goal/status (Kiro CLI goal lifecycle). */
  notifyKiroGoalStatus(params: any): void {
    const { sessionId, goalSnapshot } = params;
    // Forward goal snapshot to webview as a session_info_update-like message
    this.postMessage({ type: 'kiroGoalStatus', sessionId, goalSnapshot });
    // Also update the session's goalSnapshot for webview restore
    this.sendCurrentState();
  }

  /** Notify webview of `_session/terminate` (subagent ended). */
  notifySessionTerminate(params: any): void {
    this.postMessage({ type: 'sessionTerminate', params });
  }

  /** Notify webview of Cursor `cursor/task` (subagent task). */
  notifyCursorTask(params: any): void {
    this.postMessage({ type: 'cursorTask', params });
  }

  /** Notify webview of Cursor `cursor/update_todos`. */
  notifyCursorUpdateTodos(params: any): void {
    this.postMessage({ type: 'cursorUpdateTodos', params });
  }

  /** Notify webview of Cursor `cursor/generate_image`. */
  notifyCursorGenerateImage(params: any): void {
    this.postMessage({ type: 'cursorGenerateImage', params });
  }

  /** Notify webview that a Cursor plan was accepted. */
  notifyCursorCreatePlan(params: any): void {
    this.postMessage({ type: 'cursorCreatePlan', params });
  }

  /**
   * Notify webview that a `session/load` replay is starting. The webview
   * wipes any previously-displayed history, disables input, and shows a
   * loading overlay until {@link notifyLoadSessionEnd} fires.
   */
  notifyLoadSessionStart(): void {
    if (this.suppressWebviewUpdates) {
      return;
    }
    this.postMessage({ type: 'loadSessionStart' });
  }

  /** Notify webview that the active replay finished (success or failure). */
  notifyLoadSessionEnd(ok: boolean): void {
    if (this.suppressWebviewUpdates) {
      return;
    }
    // Flush any buffered streaming text before notifying the webview that
    // the replay is done.  Without this, the last agent_message_chunk(s)
    // may still be sitting in the 8 ms coalescer buffer and arrive at the
    // webview AFTER loadSessionEnd — causing the text to be committed via
    // the normal (non-replay) path or lost entirely.
    const activeId = this.sessionManager.getActiveSessionId();
    if (activeId) {
      this.streamCoalescer.flush(activeId);
    }
    // …but flushing here is not sufficient on its own. The agent can put its
    // final agent_message_chunk on the wire immediately before the session/load
    // response (measured: 2 ms), and the notification handler that appends it to
    // the coalescer runs AFTER the response promise resolves — i.e. after the
    // flush above. The chunk then reached the webview behind loadSessionEnd,
    // where isLoadingSession was already false and the idle-chunk guard dropped
    // it: an codex resume lost the whole final summary of its last turn that
    // way, and the interim reply was promoted in its place.
    //
    // Give the notification queue one macrotask to drain (longer than the
    // coalescer interval), flush again, and only then declare the replay over.
    // The delay is invisible to the user — the load overlay is already up.
    setTimeout(() => {
      if (this.suppressWebviewUpdates) {
        return;
      }
      if (activeId) {
        const pending = this.streamCoalescer._pending(activeId);
        if (pending && (pending.msg || pending.thought)) {
          getOutputChannel().appendLine(
            `[ACP-DEBUG] [WV-LOAD-TAIL] flushing replay tail after load response: ` +
              `msg=${pending.msg.length} thought=${pending.thought.length}`,
          );
        }
        this.streamCoalescer.flush(activeId);
      }
      this.postMessage({ type: 'loadSessionEnd', ok });
    }, LOAD_END_TAIL_FLUSH_MS);
    // Cursor batch enrich is requested by the webview after snapshot-merge +
    // renderChatHistory (handleLoadSessionEnd). Scheduling here races ahead of
    // merge and enrichments get wiped when chatHistory is rebuilt.
  }

  /** Notify webview that session title / metadata changed. */
  notifySessionInfoUpdate(title: string | undefined | null): void {
    // Only send when title is explicitly a string or null. When undefined
    // (e.g. session_info_update carrying only _meta.codex.goal with no title
    // field), do NOT post — the webview would interpret null as "delete
    // title" and fall back to the agent name ("Codex"), losing the real title.
    if (title !== undefined) {
      this.postMessage({ type: 'sessionInfoUpdate', title });
    }
  }

  /**
   * Clear the chat history and reset to welcome state.
   * Called when starting a new conversation.
   */
  clearChat(showWelcome: boolean = true): void {
    this._hasChatContent = false;
    this.toolCallDiffs.clear();
    this.dropAllStreamBuffers();
    this.postMessage({ type: 'clearChat', showWelcome });
  }

  /**
   * Whether the chat has any messages.
   */
  get hasChatContent(): boolean {
    return this._hasChatContent;
  }

  /**
   * Generate the HTML content for the webview.
   */
  private getHtmlContent(webview: vscode.Webview): string {
    const nonce = getNonce();
    const mermaidUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'resources', 'mermaid.min.js'));
    const katexCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'resources', 'katex', 'katex.min.css'),
    );
    const buildStamp = Date.now();
    const voiceEnabled = vscode.workspace.getConfiguration('acp.voice').get<boolean>('enabled', true);

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob:; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};">
  <title>ACP Chat</title>
  <!-- BUILD-STAMP: ${buildStamp} -->
  <link rel="stylesheet" href="${katexCssUri}">
  <style>
    acp-math {
      color: var(--vscode-editor-foreground);
    }
    acp-math[data-display="1"] {
      display: block;
      overflow-x: auto;
      margin: 0.75em 0;
      text-align: center;
    }
    acp-math .katex { font-size: 1.05em; }
    :root {
      --container-padding: 12px;
      --message-radius: 8px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

   .resume-bar {
        display: flex;
        flex-shrink: 0;
        justify-content: center;
        align-items: center;
        gap: 8px;
        padding: 10px 20px;
        background: var(--vscode-editorWidget-background);
        border-top: 1px solid var(--vscode-panel-border);
        position: relative;
      }
      .resume-bar::before {
        content: '';
        position: absolute;
        top: 0; left: 0; right: 0;
        height: 1px;
        background: linear-gradient(90deg, transparent, var(--vscode-button-background, #0e639c), transparent);
        opacity: 0.4;
      }
      .resume-bar .resume-info {
        font-size: 0.8em;
        opacity: 0.55;
        font-family: var(--vscode-font-family);
      }
      .resume-bar .resume-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 8px 22px;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        font-weight: 600;
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        pointer-events: auto;
        transition: background 0.15s ease, transform 0.1s ease;
        box-shadow: 0 1px 3px rgba(0,0,0,0.2);
      }
      .resume-bar .resume-btn:hover {
        background: var(--vscode-button-hoverBackground);
        transform: translateY(-1px);
        box-shadow: 0 2px 6px rgba(0,0,0,0.3);
      }
      .resume-bar .resume-btn:active {
        transform: translateY(0);
        box-shadow: 0 1px 2px rgba(0,0,0,0.2);
      }
      .resume-bar .resume-btn .resume-icon {
        font-size: 1.1em;
        line-height: 1;
      }
      @keyframes resumePulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.6; }
      }
      .resume-bar .resume-btn .resume-icon {
        animation: resumePulse 2s ease-in-out infinite;
      }

    /* Session connected banner */
    .session-banner {
      display: none;
      padding: 10px var(--container-padding);
      background: var(--vscode-editorWidget-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      font-size: 0.9em;
    }
    .session-banner.visible { display: flex; align-items: center; gap: 8px; }
    .session-banner .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--vscode-testing-iconPassed);
      flex-shrink: 0;
    }
    .session-banner .info { flex: 1; min-width: 0; overflow: hidden; }
    .session-banner .agent {
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
   .session-banner .cwd {
     font-size: 0.85em;
     opacity: 0.6;
     margin-top: 1px;
     white-space: nowrap;
     overflow: hidden;
     text-overflow: ellipsis;
   }
   .session-banner .cwd .git-branch {
     color: var(--vscode-charts-blue, inherit);
     font-weight: 600;
     opacity: 0.9;
   }
  .session-banner .status {
     font-size: 0.85em;
     opacity: 0.7;
     flex-shrink: 0;
      white-space: nowrap;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      line-height: 1;
   }
    .session-banner .follow-toggle {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      font-size: 0.85em;
      background: transparent;
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 4px;
      cursor: pointer;
      opacity: 0.7;
      transition: opacity 120ms;
      flex-shrink: 0;
    }
    .session-banner .follow-toggle:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
    .session-banner .goal-chip {
      display: none;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      font-size: 0.82em;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border-radius: 10px;
      border: 1px solid transparent;
      max-width: 300px;
      overflow: hidden;
      white-space: nowrap;
      flex-shrink: 0;
      cursor: default;
    }
    .session-banner .goal-chip.visible { display: inline-flex; }
    .session-banner .goal-chip .goal-icon { flex-shrink: 0; font-size: 0.9em; }
    .session-banner .goal-chip .goal-text { overflow: hidden; text-overflow: ellipsis; }
   .session-banner .goal-chip .goal-status {
     flex-shrink: 0;
     font-size: 0.85em;
     opacity: 0.8;
     text-transform: capitalize;
   }
   .session-banner .goal-chip .goal-progress {
     flex-shrink: 0;
     font-size: 0.8em;
     opacity: 0.7;
     font-variant-numeric: tabular-nums;
   }
   .session-banner .goal-chip .goal-btn {
      flex-shrink: 0;
      background: none;
      border: none;
      color: inherit;
      cursor: pointer;
      font-size: 0.9em;
      padding: 0 2px;
      opacity: 0.6;
    }
    .session-banner .goal-chip .goal-btn:hover { opacity: 1; }
    .session-banner .goal-chip.status-active { border-color: var(--vscode-charts-blue, #3794ff); }
    .session-banner .goal-chip.status-paused { border-color: var(--vscode-charts-yellow, #e2c08d); opacity: 0.75; }
    .session-banner .goal-chip.status-blocked { border-color: var(--vscode-charts-red, #f48771); }
    .session-banner .goal-chip.status-complete { border-color: var(--vscode-charts-green, #89d185); }
    .session-banner .goal-chip.status-budgetLimited,
    .session-banner .goal-chip.status-usageLimited { border-color: var(--vscode-charts-orange, #d18616); }
    .session-banner .follow-toggle[aria-pressed="true"] {
      color: var(--vscode-charts-blue, var(--vscode-button-background));
      opacity: 1;
      border-color: var(--vscode-charts-blue, var(--vscode-button-background));
    }
   .session-banner .follow-toggle .icon { font-family: monospace; line-height: 1; font-size: 1.05em; }

  /* Messages area */
    .messages-wrap {
      flex: 1;
      min-height: 0;
      position: relative;
      display: flex;
      flex-direction: column;
    }
   .messages {
     flex: 1;
     overflow-y: auto;
     padding: var(--container-padding);
     display: flex;
     flex-direction: column;
     gap: 4px;
   }
    .jump-latest-btn {
      display: none;
      position: absolute;
      bottom: 16px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 20;
      align-items: center;
      gap: 6px;
      padding: 6px 14px;
      border-radius: 16px;
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      font-family: var(--vscode-font-family);
      font-size: 0.85em;
      cursor: pointer;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
      opacity: 0.95;
    }
    .jump-latest-btn.visible {
      display: inline-flex;
    }
    .jump-latest-btn:hover {
      opacity: 1;
      filter: brightness(1.08);
    }

    .message {
      padding: 8px 12px;
      border-radius: var(--message-radius);
      max-width: 95%;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }
   .message.user {
     align-self: flex-end;
     background: var(--vscode-button-background);
     color: var(--vscode-button-foreground);
   }
   .session-mention-pill {
     display: inline-block;
     padding: 1px 8px;
     border-radius: 10px;
     background: var(--vscode-badge-background);
     color: var(--vscode-badge-foreground);
     font-size: 0.85em;
     font-weight: 600;
     border: 1px solid var(--vscode-focusBorder);
     vertical-align: middle;
   }
   .session-mention-separator {
     color: var(--vscode-button-foreground);
     opacity: 0.6;
     margin: 0 4px;
   }
   .message.assistant {
      align-self: flex-start;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
    }
    /* Markdown body inside assistant messages */
    .message.assistant.md-rendered {
      white-space: normal;
    }
    /* While waiting for markdown render, show raw text in pre-wrap to
       preserve formatting, but dim it slightly to indicate it's loading */
    .message.assistant:not(.md-rendered) {
      white-space: pre-wrap;
      opacity: 0.85;
    }
    .message.assistant.md-rendered p {
      margin: 0 0 0.5em;
    }
    .message.assistant.md-rendered p:last-child {
      margin-bottom: 0;
    }
    .message.assistant.md-rendered pre {
      background: var(--vscode-textCodeBlock-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 8px 10px;
      overflow-x: auto;
      margin: 0.5em 0;
      font-family: var(--vscode-editor-font-family);
      position: relative;
    }
    .message.assistant.md-rendered .code-fence-wrapper {
      position: relative;
      margin: 0.5em 0;
    }
    .message.assistant.md-rendered .code-fence-wrapper .copy-btn {
      position: absolute;
      top: 4px;
      right: 4px;
      padding: 2px 8px;
      font-size: 11px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 3px;
      cursor: pointer;
      opacity: 0.55;
      transition: opacity 0.15s;
      z-index: 10;
      user-select: none;
    }
    .message.assistant.md-rendered .code-fence-wrapper:hover .copy-btn {
      opacity: 1;
    }
    .message.assistant.md-rendered .code-fence-wrapper .copy-btn:hover {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .message.assistant.md-rendered .code-fence-wrapper .copy-btn.copied {
      background: var(--vscode-testing-iconPassed);
      color: var(--vscode-testing-iconPassed-foreground, #fff);
      border-color: var(--vscode-testing-iconPassed);
      opacity: 1;
      font-size: 0.9em;
      line-height: 1.4;
    }
    .message.assistant.md-rendered code {
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
      background: var(--vscode-textCodeBlock-background);
      padding: 1px 4px;
      border-radius: 3px;
    }
   .message.assistant.md-rendered pre code {
     background: none;
     padding: 0;
     border-radius: 0;
   }
   .message.assistant.md-rendered .mermaid {
     background: var(--vscode-textCodeBlock-background);
     border-radius: 6px;
     padding: 12px;
     margin: 8px 0;
     text-align: center;
     overflow-x: auto;
   }
   .message.assistant.md-rendered .mermaid svg {
     max-width: 100%;
     height: auto;
   }
   .message.assistant.md-rendered ul,
   .message.assistant.md-rendered ol {
     margin: 0.4em 0;
      padding-left: 1.5em;
    }
    .message.assistant.md-rendered li {
      margin: 0.15em 0;
    }
    .message.assistant.md-rendered h1,
    .message.assistant.md-rendered h2,
    .message.assistant.md-rendered h3,
    .message.assistant.md-rendered h4 {
      margin: 0.6em 0 0.3em;
      font-weight: 600;
    }
    .message.assistant.md-rendered h1 { font-size: 1.3em; }
    .message.assistant.md-rendered h2 { font-size: 1.15em; }
    .message.assistant.md-rendered h3 { font-size: 1.05em; }
    .message.assistant.md-rendered blockquote {
      border-left: 3px solid var(--vscode-focusBorder);
      margin: 0.4em 0;
      padding: 0.2em 0 0.2em 0.8em;
      opacity: 0.85;
    }
    .message.assistant.md-rendered a {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }
   .message.assistant.md-rendered .file-ref {
     color: var(--vscode-textLink-foreground);
     background: var(--vscode-textCodeBlock-background);
     padding: 0 3px;
     border-radius: 3px;
     font-family: var(--vscode-editor-font-family);
     font-size: 0.9em;
     cursor: default;
     text-decoration: none;
   }
  .message.assistant.md-rendered a.file-link {
    color: var(--vscode-textLink-foreground);
    text-decoration: underline dotted;
    cursor: pointer;
  }
  .message.user a.user-file-link {
    color: var(--vscode-textLink-foreground);
    text-decoration: underline dotted;
    cursor: pointer;
  }
  .message.user a.user-file-link:hover {
    color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground));
    text-decoration: underline solid;
  }
  .message.assistant.md-rendered a.bare-file-link {
     color: var(--vscode-symbolIcon-fileForeground, var(--vscode-textLink-foreground));
     background: var(--vscode-textCodeBlock-background);
     padding: 0 3px;
     border-radius: 3px;
     font-family: var(--vscode-editor-font-family);
     font-size: 0.9em;
     text-decoration: none;
     cursor: pointer;
   }
   .message.assistant.md-rendered a.bare-file-link:hover {
     text-decoration: underline solid;
     color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground));
   }
   .message.assistant.md-rendered a.external-link {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }
    .message.assistant.md-rendered a.external-link:hover {
      text-decoration: underline solid;
    }
    .message.assistant.md-rendered a.file-link:hover {
      text-decoration: underline solid;
    }
    .message.assistant.md-rendered a.symbol-link {
      color: var(--vscode-textLink-foreground);
      text-decoration: underline dotted;
      cursor: pointer;
    }
    .message.assistant.md-rendered a.symbol-link:hover {
      text-decoration: underline solid;
    }
    .message.assistant.md-rendered .nolink {
      color: inherit;
      text-decoration: none;
      cursor: text;
    }
    .message.assistant.md-rendered a:hover {
      text-decoration: underline;
    }
    .message.assistant.md-rendered table {
      border-collapse: collapse;
      margin: 0.4em 0;
      font-size: 0.9em;
    }
    .message.assistant.md-rendered th,
    .message.assistant.md-rendered td {
      border: 1px solid var(--vscode-panel-border);
      padding: 4px 8px;
    }
    .message.assistant.md-rendered th {
      background: var(--vscode-editorWidget-background);
      font-weight: 600;
    }
    .message.assistant.md-rendered hr {
      border: none;
      border-top: 1px solid var(--vscode-panel-border);
      margin: 0.6em 0;
    }
    /* Thought block — collapsible <details> element */
    .thought-block {
      width: 100%;
      margin-bottom: 4px;
    }
    .thought-block summary {
      font-size: 0.85em;
      opacity: 0.7;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 4px;
      user-select: none;
      display: flex;
      align-items: center;
      gap: 6px;
      list-style: none;
    }
    .thought-block summary::-webkit-details-marker { display: none; }
    .thought-block summary::before {
      content: '▸';
      font-size: 0.9em;
      transition: transform 0.15s;
    }
    .thought-block[open] summary::before {
      content: '▾';
    }
    .thought-block summary:hover { opacity: 1; }
    .thought-block.streaming summary .thought-indicator {
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--vscode-progressBar-background);
      animation: thoughtPulse 1.2s ease-in-out infinite;
      flex-shrink: 0;
    }
    @keyframes thoughtPulse {
      0%, 100% { opacity: 0.4; }
      50% { opacity: 1; }
    }
    .thought-block .thought-content {
      margin-top: 4px;
      padding: 8px 12px;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      font-size: 0.88em;
      opacity: 0.75;
      font-style: italic;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 300px;
      overflow-y: auto;
    }

   .message.error {
     align-self: center;
     background: var(--vscode-inputValidation-errorBackground);
     color: var(--vscode-inputValidation-errorForeground);
     border: 1px solid var(--vscode-inputValidation-errorBorder);
   }

   .message.system {
     align-self: center;
     color: var(--vscode-descriptionForeground);
     font-size: 0.85em;
     font-style: italic;
     padding: 4px 12px;
     opacity: 0.7;
   }

   .message.ps-output {
     align-self: flex-start;
     color: var(--vscode-descriptionForeground);
     font-size: 0.9em;
     padding: 8px 0;
     white-space: pre-wrap;
     font-family: var(--vscode-editor-font-family);
   }
   .message.ps-output .ps-cmd {
     color: #c586c0;  /* purple, matches codex TUI magenta */
     font-weight: 600;
   }
   .message.ps-output .ps-header {
     font-weight: 700;
     color: var(--vscode-foreground);
   }
   .message.ps-output .ps-item {
     color: var(--vscode-descriptionForeground);
   }

   .ps-panel {
     flex-shrink: 0;
     max-height: 200px;
     overflow-y: auto;
     padding: 8px 12px;
     border-radius: var(--message-radius);
     background: var(--vscode-editorWidget-background);
     border: 1px solid var(--vscode-panel-border);
     border-left: 3px solid #c586c0;  /* purple accent to distinguish from plan */
     font-family: var(--vscode-editor-font-family);
     font-size: 0.85em;
   }
   .ps-panel:empty { display: none; }
   .ps-panel .ps-cmd {
     color: #c586c0;
     font-weight: 600;
     margin-bottom: 4px;
   }
   .ps-panel .ps-header {
     font-weight: 600;
     color: var(--vscode-foreground);
     margin-bottom: 4px;
   }
   .ps-panel .ps-item {
     padding: 2px 0;
     color: var(--vscode-descriptionForeground);
     display: flex;
     align-items: center;
     gap: 6px;
   }



  /* Turn container — groups assistant text + tool calls */
   .turn {
     display: flex;
     flex-direction: column;
     gap: 2px;
     align-self: flex-start;
     max-width: 95%;
   }

   /* Tool calls group inside a turn */
   .turn-tools {
     display: flex;
     flex-direction: column;
     gap: 2px;
     padding-left: 10px;
     border-left: 2px solid var(--vscode-panel-border);
     margin: 1px 0;
   }
    .turn-tools-summary {
     font-size: 0.8em;
     opacity: 0.6;
     cursor: pointer;
     padding: 2px 0;
     user-select: none;
   }
   .turn-tools-summary:hover { opacity: 0.9; }
   .turn-tools-summary .tc-summary-detail {
     opacity: 0.7;
     margin-left: 4px;
   }
   .turn-tools-list { }
   .turn-tools-list.collapsed { display: none; }
   /* Compact mode: summary + fold wrap thought/tools/interim. Final assistant
      reply sits outside the fold. Fold body is HIDDEN by default when Collapse
      is on — missing .collapsed used to leave thoughts/tools visible. */
   .turn > .turn-tools-summary { margin: 2px 0; }
   /* Plan-mode handoff row: the plan is ready but edits are blocked until the
      collaboration mode leaves 'plan'. */
   .message.system.implement-plan-row {
     display: flex;
     align-items: center;
     gap: 6px;
     flex-wrap: wrap;
   }
   .implement-plan-btn {
     background: var(--vscode-button-background);
     color: var(--vscode-button-foreground);
     border: none;
     border-radius: 3px;
     padding: 2px 10px;
     font-size: 0.9em;
     cursor: pointer;
   }
   .implement-plan-btn:hover { background: var(--vscode-button-hoverBackground); }

   .turn-fold-body {
     display: flex;
     flex-direction: column;
     gap: 4px;
   }
   .turn-fold-body.collapsed { display: none; }
   /* Fail-safe: in Collapse mode, hide fold unless explicitly expanded. */
   .messages.compact-mode .turn > .turn-fold-body { display: none; }
   .messages.compact-mode .turn > .turn-fold-body.expanded { display: flex; }
   /* Subagent stage details stay inside the fold — never paint when collapsed. */
   .messages.compact-mode .turn > .turn-fold-body:not(.expanded) .tc-stages {
     display: none !important;
   }
   .messages.compact-mode .turn > .turn-fold-body:not(.expanded) .tc-stage-desc {
     display: none !important;
   }

   /* Compact inline tool call */
   .tool-call-inline {
     display: flex;
      align-items: center;
      gap: 6px;
      padding: 3px 6px;
      font-size: 0.85em;
      border-radius: 4px;
      background: var(--vscode-editorWidget-background);
      opacity: 0.85;
    }
    .tool-call-inline .tc-icon {
      flex-shrink: 0;
      width: 14px;
      text-align: center;
      /* inline-block required — CSS transform/spin is ignored on pure inline */
      display: inline-block;
    }
   .tool-call-inline .tc-icon.pending,
   .tool-call-inline .tc-icon.running,
   .tool-call-inline .tc-icon.in_progress { color: var(--vscode-progressBar-background); animation: tc-spin 1s linear infinite; }
   .tool-call-inline .tc-icon.completed { color: var(--vscode-testing-iconPassed); }
    .tool-call-inline .tc-icon.failed { color: var(--vscode-testing-iconFailed); }
    @keyframes tc-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    .tool-call-inline .tc-title {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
   .tool-call-inline.has-diff { cursor: pointer; }
   .tool-call-inline.has-diff:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }
  .tool-call-inline.has-diff .tc-diff-icon { margin-left: auto; opacity: 0.6; font-size: 0.9em; }
   /* Subagent tool calls — highlighted to stand out from routine read/edit */
   .tool-call-inline.tc-subagent { border-left: 2px solid var(--vscode-symbolIcon-iconForeground); padding-left: 6px; }
   .tool-call-inline.tc-subagent .tc-icon { color: var(--vscode-symbolIcon-iconForeground); }
   .tool-call-inline.tc-subagent .tc-title { font-weight: 600; }
  .tc-nested {
    margin: 1px 0 1px 10px;
    padding-left: 8px;
    border-left: 1px solid var(--vscode-widget-border);
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  /* Subagent stages (Kiro crew) */
  .tool-call-inline .tc-stages { margin-top: 2px; margin-left: 20px; }
   .tool-call-inline .tc-stage { padding: 2px 0; font-size: 0.9em; opacity: 0.85; }
  .tool-call-inline .tc-stage-icon { color: var(--vscode-symbolIcon-iconForeground); margin-right: 4px; display: inline-block; }
  .tool-call-inline .tc-stage-name { font-weight: 500; }
   .tool-call-inline .tc-stage-role { margin-left: 6px; font-size: 0.85em; opacity: 0.7; }
   .tool-call-inline .tc-stage-depends { margin-left: 6px; font-size: 0.85em; opacity: 0.6; }
  .tool-call-inline .tc-stage-desc { margin-left: 18px; font-size: 0.85em; opacity: 0.6; }
 .tool-call-inline .tc-stage-icon.running,
 .tool-call-inline .tc-stage-icon.in_progress,
 .tool-call-inline .tc-stage-icon.pending { color: var(--vscode-progressBar-background); animation: tc-spin 1s linear infinite; }
 .tool-call-inline .tc-stage-icon.completed { color: var(--vscode-testing-iconPassed); }
 .tool-call-inline .tc-stage-icon.error { color: var(--vscode-testing-iconFailed); }
 .tool-call-inline .tc-stage { padding: 2px 4px; border-radius: 3px; }
 .tool-call-inline .tc-stage:hover { background: var(--vscode-list-hoverBackground); }

 /* Tooltip popover for tool call raw input.
     pointer-events:none is required — the popover is positioned at the
     cursor, so with pointer-events:auto it immediately steals hover from
     the tool row, fires pointerleave, and the tooltip vanishes (looks like
     "no tooltip" when compact mode is toggled off and rows are visible). */
  .tc-tooltip {
    position: fixed;
    top: 0;
    left: 0;
    z-index: 10000;
    max-width: 600px;
    max-height: 400px;
    overflow: auto;
    padding: 8px 12px;
    border-radius: 6px;
    background: var(--vscode-editorHoverWidget-background);
    border: 1px solid var(--vscode-editorHoverWidget-border);
    color: var(--vscode-editorHoverWidget-foreground);
   font-family: var(--vscode-editor-font-family);
   font-size: calc(var(--vscode-editor-font-size, 13px) * 0.85);
   white-space: pre-wrap;
    word-break: break-all;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    pointer-events: none;
  }
  .tc-tooltip pre {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .tc-tooltip pre, .tc-tooltip code {
    font-family: inherit;
    font-size: inherit;
  }
  .tc-tooltip-trunc {
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px solid var(--vscode-editorHoverWidget-border);
    font-size: 0.85em;
    opacity: 0.7;
    font-style: italic;
  }
  .tc-tooltip-scroll-hint {
    position: sticky;
    bottom: 0;
    text-align: center;
    padding: 2px 0;
    font-size: 0.8em;
    opacity: 0.6;
    background: var(--vscode-editorHoverWidget-background);
    border-top: 1px solid var(--vscode-editorHoverWidget-border);
  }

  /* Ensure tool-call elements can anchor tooltips */
  .tool-call-inline { position: relative; }
  .tool-call { position: relative; }

    /* Legacy standalone tool-call card (for history restore) */
    .tool-call {
      padding: 8px 12px;
      border-radius: var(--message-radius);
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border);
      font-size: 0.9em;
    }
    .tool-call .title {
      font-weight: 600;
      margin-bottom: 4px;
    }
    .tool-call .status-badge {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 3px;
      font-size: 0.8em;
      margin-left: 6px;
    }
    .tool-call .status-badge.pending { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    .tool-call .status-badge.running { background: var(--vscode-progressBar-background); color: white; }
    .tool-call .status-badge.completed { background: var(--vscode-testing-iconPassed); color: white; }
    .tool-call .status-badge.failed { background: var(--vscode-testing-iconFailed); color: white; }

   /* Plan */
   .plan-bar {
     flex-shrink: 0;
     max-height: 200px;
     overflow-y: auto;
   }
   .plan-bar:empty {
     display: none;
   }
   .plan {
     padding: 8px 12px;
     border-radius: var(--message-radius);
     background: var(--vscode-editorWidget-background);
     border: 1px solid var(--vscode-panel-border);
   }
    .plan .plan-title { font-weight: 600; margin-bottom: 6px; }
    .plan .plan-entry {
      padding: 2px 0;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .plan .plan-entry.completed { text-decoration: line-through; opacity: 0.6; }

    /* Token usage — circular progress ring, inline in the toolbar (like Zed) */
    .token-usage-ring {
      display: none;
      align-items: center;
      gap: 6px;
      padding: 2px 8px;
      border-radius: 3px;
      position: relative;
      flex-shrink: 0;
      cursor: default;
    }
    .token-usage-ring.visible { display: inline-flex; }
    .token-usage-ring svg {
      display: block;
      flex-shrink: 0;
    }
    .token-usage-ring .ring-label {
      font-size: calc(var(--vscode-font-size) - 1px);
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
      opacity: 0.8;
    }
    .token-usage-ring .ring-bg {
      stroke: var(--vscode-input-background);
    }
    .token-usage-ring .ring-fg {
      transition: stroke-dashoffset 0.3s ease, stroke 0.3s ease;
    }
    .token-usage-ring .ring-fg.warning { stroke: var(--vscode-charts-yellow); }
    .token-usage-ring .ring-fg.danger  { stroke: var(--vscode-charts-red); }
    .token-usage-ring .ring-fg.normal  { stroke: var(--vscode-descriptionForeground); }
    /* Hover tooltip for the ring */
    .token-usage-tooltip {
      position: fixed;
      display: none;
      min-width: 160px;
      padding: 8px 12px;
      background: var(--vscode-editorHoverWidget-background);
      color: var(--vscode-editorHoverWidget-foreground);
      border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-panel-border));
      border-radius: 4px;
      font-size: calc(var(--vscode-font-size) - 1px);
      line-height: 1.5;
      white-space: nowrap;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
      pointer-events: none;
      z-index: 300;
    }
    .token-usage-tooltip.visible { display: block; }
    .token-usage-tooltip .tooltip-header {
      color: var(--vscode-descriptionForeground);
      font-size: 0.85em;
      margin-bottom: 4px;
    }
    .token-usage-tooltip .tooltip-cost {
      margin-top: 6px;
      padding-top: 6px;
      border-top: 1px solid var(--vscode-panel-border);
      color: var(--vscode-descriptionForeground);
    }
    /* Empty / welcome state */
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      text-align: center;
      padding: 24px 20px;
      gap: 6px;
      position: relative;
      z-index: 1;
    }
    .empty-state .icon { font-size: 2.4em; margin-bottom: 4px; opacity: 0.85; }
    .empty-state .title {
      font-size: 1.1em;
      font-weight: 600;
      margin-bottom: 2px;
    }
    .empty-state .subtitle {
      font-size: 0.85em;
      opacity: 0.6;
      margin-bottom: 12px;
      line-height: 1.4;
    }
    .empty-state .actions {
      display: flex;
      flex-direction: column;
      gap: 8px;
      width: 100%;
      max-width: 220px;
    }
    .empty-state .action-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 8px 16px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      font-weight: 500;
      pointer-events: auto;
      position: relative;
      z-index: 2;
    }
    .empty-state .action-btn.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .empty-state .action-btn.primary:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .empty-state .action-btn.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .empty-state .action-btn.secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .empty-state .hint {
      font-size: 0.8em;
      opacity: 0.5;
      margin-top: 8px;
    }
    .empty-state .hint kbd {
      padding: 1px 5px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.95em;
      background: var(--vscode-editor-background);
    }

    /* Session connected banner */
    .session-banner {
      display: none;
      padding: 10px var(--container-padding);
      background: var(--vscode-editorWidget-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      font-size: 0.9em;
    }
    .session-banner.visible { display: flex; align-items: center; gap: 8px; }

    /* Input area states: dim toolbar and send row when disabled,
       but keep the textarea editable so user can type ahead */
    .input-area.disabled .input-toolbar,
    .input-area.disabled .input-send-row { opacity: 0.4; pointer-events: none; }

    /* Input area container */
    .input-area {
      position: relative;
      border-top: 1px solid var(--vscode-panel-border);
      display: flex;
      flex-direction: column;
      background: var(--vscode-sideBar-background);
    }

    /* Resize handle */
    .input-resize-handle {
      height: 4px;
      cursor: ns-resize;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .input-resize-handle::after {
      content: '';
      width: 32px;
      height: 2px;
      border-radius: 1px;
      background: var(--vscode-panel-border);
      transition: background 0.15s;
    }
    .input-resize-handle:hover::after {
      background: var(--vscode-focusBorder);
    }

    /* Toolbar row */
    .input-toolbar {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px var(--container-padding) 0;
      flex-shrink: 0;
      flex-wrap: wrap;
    }

    /* Picker wrapper — positioned relatively to anchor the dropdown */
    .picker-wrap {
      position: relative;
      min-width: 0;
      max-width: 100%;
    }
    .picker-wrap.hidden { display: none; }

    /* Picker buttons */
    .picker-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border: none;
      border-radius: 3px;
      background: transparent;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: calc(var(--vscode-font-size) - 1px);
      cursor: pointer;
      white-space: nowrap;
      max-width: 100%;
      min-width: 0;
      opacity: 0.8;
    }
    .picker-btn:hover {
      background: var(--vscode-toolbar-hoverBackground);
      opacity: 1;
    }
    .picker-btn .picker-icon {
      flex-shrink: 0;
      font-size: 14px;
    }
    .picker-btn .picker-label {
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }
    .picker-btn .picker-chevron {
      flex-shrink: 0;
      font-size: 10px;
      opacity: 0.6;
    }

    /* Picker dropdown — sibling of button, positioned from wrapper */
    .picker-dropdown {
      display: none;
      position: absolute;
      bottom: 100%;
      left: 0;
      min-width: 180px;
      max-width: min(420px, calc(100vw - 16px));
      max-height: 240px;
      overflow-y: auto;
      background: var(--vscode-dropdown-background);
      border: 1px solid var(--vscode-dropdown-border);
      border-radius: 4px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      z-index: 100;
      margin-bottom: 4px;
    }
    .picker-dropdown.open { display: block; }
    .picker-dropdown-item {
      padding: 6px 10px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: calc(var(--vscode-font-size) - 1px);
      color: var(--vscode-dropdown-foreground);
    }
    .picker-dropdown-item:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .picker-dropdown-item.selected {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    .picker-dropdown-item .check {
      width: 14px;
      text-align: center;
      flex-shrink: 0;
    }
    .picker-dropdown-item .item-label {
      flex: 1 1 auto;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* Floating tooltip used by all picker dropdowns to show option
       description on hover (positioned outside the dropdown). */
    .picker-tooltip {
      position: fixed;
      display: none;
      max-width: 280px;
      padding: 6px 10px;
      background: var(--vscode-editorHoverWidget-background);
      color: var(--vscode-editorHoverWidget-foreground);
      border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-panel-border));
      border-radius: 4px;
      font-size: calc(var(--vscode-font-size) - 1px);
      line-height: 1.4;
      white-space: normal;
      word-break: break-word;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
      pointer-events: none;
      z-index: 300;
    }
    .picker-tooltip.visible { display: block; }

    /* Header for grouped picker options */
    .picker-dropdown-group-header {
      padding: 6px 10px 2px;
      font-size: 0.75em;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      opacity: 0.6;
      pointer-events: none;
      color: var(--vscode-dropdown-foreground);
    }
    .picker-dropdown-group-header:not(:first-child) {
      border-top: 1px solid var(--vscode-panel-border);
      margin-top: 4px;
    }

    /* Dynamic config-options picker row — sits inline with legacy pickers */
    .picker-row {
      display: contents;
    }

    /* Toolbar spacer */
    .toolbar-spacer { flex: 1; }

    /* Editor wrapper */
    .input-editor-wrap {
      padding: 0 var(--container-padding);
      flex: 1;
      min-height: 0;
      display: flex;
    }
    .input-editor-wrap textarea {
      flex: 1;
      resize: none;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 6px;
      padding: 8px 10px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      line-height: 1.4;
      min-height: 38px;
      outline: none;
    }
    .input-editor-wrap textarea:focus {
      border-color: var(--vscode-focusBorder);
    }

    /* Send row */
    .input-send-row {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      padding: 4px var(--container-padding) 8px;
      gap: 6px;
      flex-shrink: 0;
    }

    .attach-btn {
      background: none;
      border: none;
      cursor: pointer;
      font-size: 16px;
      padding: 4px 6px;
      border-radius: 4px;
      opacity: 0.7;
    }
    .attach-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }

    /* Voice input mic button — sits left of attach/send in the send row.
       Recording state pulses red; transcribing shows a waiting spinner. */
    .mic-btn {
      background: none;
      border: none;
      cursor: pointer;
      font-size: 16px;
      padding: 4px 6px;
      border-radius: 4px;
      opacity: 0.7;
      line-height: 1;
    }
    .mic-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
    .mic-btn.recording {
      opacity: 1;
      color: var(--vscode-inputValidation-errorForeground, #f48771);
      animation: mic-pulse 1.2s ease-in-out infinite;
    }
    .mic-btn.transcribing { opacity: 1; cursor: wait; }
    @keyframes mic-pulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.25); }
    }

    .image-preview-strip {
      display: flex;
      gap: 4px;
      padding: 0 4px;
      flex-wrap: wrap;
    }
    .image-preview-strip:empty { display: none; }
    .image-preview-strip .img-thumb {
      position: relative;
      width: 48px; height: 48px;
      border-radius: 4px;
      overflow: hidden;
      border: 1px solid var(--vscode-widget-border);
    }
    .image-preview-strip .img-thumb img {
      width: 100%; height: 100%; object-fit: cover;
    }
    .image-preview-strip .img-thumb .img-remove {
      position: absolute; top: 0; right: 0;
      background: rgba(0,0,0,0.6); color: white;
      border: none; cursor: pointer; font-size: 12px;
      width: 16px; height: 16px; line-height: 16px;
      text-align: center; border-radius: 0 0 0 4px;
    }

    /* Send / Stop toggle button — pill-shaped */
    .send-stop-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      padding: 4px 14px;
      border: none;
      border-radius: 12px;
      cursor: pointer;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      font-weight: 500;
      white-space: nowrap;
      min-width: 60px;
      height: 26px;
      transition: background 0.15s;
    }
    .send-stop-btn.send {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .send-stop-btn.send:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .send-stop-btn.send:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .send-stop-btn.stop {
      background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
      color: var(--vscode-inputValidation-errorForeground, #f48771);
      border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
    }
    .send-stop-btn.stop:hover {
      opacity: 0.9;
    }

    /* Message queue — shows messages waiting to be sent */
    .msg-queue {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 4px 8px;
      max-height: 120px;
      overflow-y: auto;
    }
    .msg-queue:empty {
      display: none;
    }
    .msg-queue-item {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border-radius: 8px;
      padding: 3px 8px;
      font-size: 0.85em;
      max-width: 300px;
      overflow: hidden;
    }
    .msg-queue-item .queue-text {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
   .msg-queue-item .queue-remove {
     cursor: pointer;
     opacity: 0.7;
     font-weight: bold;
     margin-left: 2px;
   }
   .msg-queue-item .queue-remove:hover {
     opacity: 1;
   }
    .msg-queue-item .queue-action {
      cursor: pointer;
      opacity: 0.7;
      font-weight: bold;
      margin-left: 2px;
      padding: 0 2px;
      font-size: 0.9em;
    }
    .msg-queue-item .queue-action:hover {
      opacity: 1;
    }
    .msg-queue-item .queue-sent-tag {
      font-size: 0.8em;
      opacity: 0.7;
      margin-left: 4px;
      padding: 0 4px;
      border-radius: 3px;
      background: var(--vscode-badge-background, rgba(128,128,128,0.25));
      color: var(--vscode-badge-foreground, inherit);
    }
    .msg-queue-item.queue-steered {
      border-style: dashed;
    }
    .msg-queue-item .queue-send-now {
      cursor: pointer;
      opacity: 0.8;
      font-weight: normal;
      margin-left: 4px;
      padding: 1px 6px;
      border-radius: 4px;
      background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.2));
      color: var(--vscode-button-secondaryForeground, inherit);
      font-size: 0.85em;
      white-space: nowrap;
    }
    .msg-queue-item .queue-send-now:hover {
      opacity: 1;
    }
   .msg-queue-label {
     font-size: 0.8em;
     opacity: 0.7;
     padding: 2px 8px;
   }

    /* Slash command autocomplete popup */
    .slash-popup {
      display: none;
      position: absolute;
      bottom: 100%;
      left: var(--container-padding);
      right: var(--container-padding);
      max-height: 200px;
      overflow-y: auto;
      background: var(--vscode-editorSuggestWidget-background, var(--vscode-dropdown-background));
      border: 1px solid var(--vscode-editorSuggestWidget-border, var(--vscode-dropdown-border));
      border-radius: 6px;
      box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.25);
      z-index: 200;
      margin-bottom: 4px;
    }
    .slash-popup.open { display: block; }
    .slash-popup-header {
      padding: 6px 10px 4px;
      font-size: 0.8em;
      opacity: 0.5;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .slash-popup-item {
      padding: 6px 10px;
      cursor: pointer;
      display: flex;
      align-items: baseline;
      gap: 8px;
    }
    .slash-popup-item:hover,
    .slash-popup-item.active {
      background: var(--vscode-list-hoverBackground);
    }
    .slash-popup-item .cmd-name {
      font-weight: 600;
      color: var(--vscode-textLink-foreground);
      white-space: nowrap;
      font-family: var(--vscode-editor-font-family);
    }
    .slash-popup-item .cmd-desc {
      font-size: 0.9em;
      opacity: 0.7;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }

    /* Spinner */
    .spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid var(--vscode-foreground);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      opacity: 0.6;
      flex-shrink: 0;
      vertical-align: middle;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Full-area overlay shown while a session is being loaded via session/load */
    .load-overlay {
      display: none;
      position: fixed;
      inset: 0;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 10px;
      background: color-mix(in srgb, var(--vscode-sideBar-background) 88%, transparent);
      backdrop-filter: blur(2px);
      z-index: 400;
      font-size: 0.9em;
      color: var(--vscode-foreground);
      pointer-events: all;
    }
    .load-overlay.visible { display: flex; }
    /* Short-lived UI notice (e.g. a mid-turn model switch). Not a chat message:
       it is feedback about the UI's own state, so it must never reach
       chatHistory or be replayed on session load. */
    .transient-hint {
      font-size: 11px;
      opacity: 0;
      margin-left: 8px;
      color: var(--vscode-descriptionForeground);
      transition: opacity 0.15s ease-in-out;
      pointer-events: none;
    }
    .transient-hint.visible { opacity: 0.85; }

    /* Elapsed / idle figure beside the turn spinner. Muted: it is reassurance,
       not content. */
    .turn-elapsed {
      font-size: 11px;
      opacity: 0.55;
      vertical-align: middle;
      font-variant-numeric: tabular-nums;
    }
    .load-overlay .spinner {
      width: 22px;
      height: 22px;
      border-width: 3px;
      opacity: 0.9;
    }
    .load-overlay .label { opacity: 0.85; }
  </style>
</head>
<body>
  <div class="session-banner" id="sessionBanner">
    <span class="dot"></span>
    <div class="info">
      <div class="agent" id="bannerAgent"></div>
      <div class="cwd" id="bannerCwd"></div>
    </div>
   <button class="follow-toggle active" id="compactToggle" title="Collapse turn details — hide thoughts, tools, and replies" aria-pressed="true">
    <span class="icon">⊟</span>
    <span class="label">Collapse</span>
  </button>
  <button class="follow-toggle" id="followToggleBtn" title="Follow Agent — open whichever file the agent is working on" aria-pressed="false">
    <span class="icon">⌖</span>
    <span class="label">Follow</span>
  </button>
  <span class="status" id="status"></span>
  <span class="turn-elapsed" id="turn-elapsed-label" style="display:none"></span>
 <span class="transient-hint" id="transientHint"></span>
 <div class="goal-chip" id="goalChip">
   <span class="goal-icon">🎯</span>
   <span class="goal-text" id="goalText"></span>
   <span class="goal-status" id="goalStatus"></span>
   <span class="goal-progress" id="goalProgress"></span>
   <button class="goal-btn" id="goalPauseBtn" title="Pause goal">⏸</button>
   <button class="goal-btn" id="goalClearBtn" title="Clear goal">✕</button>
 </div>
 </div>

 <div class="messages-wrap">
 <div class="messages" id="messages">
   <div class="empty-state" id="emptyState">
     <div class="icon">🤖</div>
     <div class="title">ACP Chat</div>
     <div class="subtitle">Connect to an AI coding agent to start chatting.</div>
    <div class="actions">
     <button class="action-btn primary" id="welcomeConnectAgent">
       🔌 Connect to Agent
     </button>
    </div>
     <div class="hint">or press <kbd>Ctrl+Shift+A</kbd> anytime</div>
   </div>
 </div>
 <button type="button" class="jump-latest-btn" id="jumpLatestBtn" title="Jump to latest streaming output">↓ Latest</button>
 </div>


 <div class="resume-bar" id="resumeBar" style="display:none;"></div>
 <div class="ps-panel" id="psPanel" style="display:none;"></div>
 <div class="plan-bar" id="planBar"></div>
 <div class="input-area" id="inputArea">
    <div class="slash-popup" id="slashPopup">
      <div class="slash-popup-header">Commands</div>
    </div>
    <div class="input-resize-handle" id="resizeHandle"></div>
    <div class="input-toolbar">
      <div class="token-usage-ring" id="tokenUsageRing">
        <svg width="16" height="16" viewBox="0 0 16 16">
          <circle class="ring-bg" cx="8" cy="8" r="6" fill="none" stroke-width="2"></circle>
          <circle class="ring-fg normal" id="tokenUsageRingFg" cx="8" cy="8" r="6" fill="none" stroke-width="2"
            stroke-dasharray="37.7" stroke-dashoffset="37.7" transform="rotate(-90 8 8)" stroke-linecap="round"></circle>
        </svg>
        <span class="ring-label" id="tokenUsageRingLabel"></span>
      </div>
      <!-- Dynamic config-options pickers (ACP "Session Config Options"). -->
      <div class="picker-row" id="configOptionsContainer"></div>
      <!-- Legacy pickers — used only when the agent has not migrated to configOptions -->
      <div class="picker-wrap hidden" id="modePickerWrap">
        <button class="picker-btn" id="modePickerBtn" title="Select mode">
          <span class="picker-icon">⚡</span>
          <span class="picker-label" id="modePickerLabel">Mode</span>
          <span class="picker-chevron">▾</span>
        </button>
        <div class="picker-dropdown" id="modeDropdown"></div>
      </div>
      <div class="picker-wrap hidden" id="modelPickerWrap">
        <button class="picker-btn" id="modelPickerBtn" title="Select model">
          <span class="picker-icon">🧠</span>
          <span class="picker-label" id="modelPickerLabel">Model</span>
          <span class="picker-chevron">▾</span>
        </button>
        <div class="picker-dropdown" id="modelDropdown"></div>
      </div>
     <span class="toolbar-spacer"></span>
   </div>
   <div class="msg-queue-label" id="msgQueueLabel" style="display:none;">Queued messages — will send automatically when the current turn finishes.</div>
   <div class="msg-queue" id="msgQueue"></div>
   <div class="input-editor-wrap">
     <div class="image-preview-strip" id="imagePreviewStrip"></div>
     <textarea
       id="promptInput"
       placeholder="Type a message..."
       rows="2"
     ></textarea>
   </div>
<div class="input-send-row">
  <button class="mic-btn" id="micBtn" title="Dictate: click to start recording, click again to transcribe (local STT)" ${voiceEnabled ? '' : 'style="display:none;"'}>🎙</button>
   <button class="attach-btn" id="attachBtn" title="Attach image (or paste)" style="display:none;">📎</button>
  <button class="send-stop-btn send" id="sendStopBtn" disabled>Send</button>
</div>
 </div>

  <!-- Shared hover tooltip for picker dropdown items -->
  <div class="picker-tooltip" id="pickerTooltip" role="tooltip"></div>
  <!-- Hover tooltip for token usage ring -->
  <div class="token-usage-tooltip" id="tokenUsageTooltip"></div>

  <!-- Overlay shown during session/load history replay -->
  <div class="load-overlay" id="loadOverlay" role="status" aria-live="polite">
    <div class="spinner"></div>
    <div class="label">Loading conversation history…</div>
  </div>

  <script nonce="${nonce}">
    // BUILD-STAMP: ${buildStamp}
   const vscode = acquireVsCodeApi();
   // mermaid.min.js (~3.5 MB) is loaded lazily by ensureMermaidLoaded() the
   // first time a "mermaid" fenced code block is rendered. Stash the URI +
   // nonce on window so renderMermaidBlocks() can inject the <script> tag
   // on demand.
   window.__acpMermaidUri = ${JSON.stringify(mermaidUri.toString())};
   window.__acpNonce = ${JSON.stringify(nonce)};
   // Re-declare DEBUG inside the webview iframe (separate JS context from the
   // extension host). DEBUG_RESUME is synced from acp.debugResume via postMessage.
   const DEBUG = false;
   var DEBUG_RESUME = false;
   function resumeDiag(msg) {
     if (DEBUG || DEBUG_RESUME) vscode.postMessage({ type: 'debugLog', message: msg });
   }
   function countRealUserMessages(arr) {
     if (!arr) return 0;
     var n = 0;
     for (var i = 0; i < arr.length; i++) {
       var it = arr[i];
       if (!it || it.kind !== 'message' || it.role !== 'user') continue;
       var t = String(it.text || '').trim();
       if (/^\\[Request interrupted by user\\]/i.test(t)) continue;
       if (/^Request interrupted by user\\.?$/i.test(t)) continue;
       n++;
     }
     return n;
   }
  const messagesEl = document.getElementById('messages');
  const psPanel = document.getElementById('psPanel');
  const resumeBar = document.getElementById('resumeBar');
  const planBar = document.getElementById('planBar');
   const emptyState = document.getElementById('emptyState');
    const promptInput = document.getElementById('promptInput');
    const sendStopBtn = document.getElementById('sendStopBtn');
    const attachBtn = document.getElementById('attachBtn');
    const micBtn = document.getElementById('micBtn');
    const imagePreviewStrip = document.getElementById('imagePreviewStrip');
    const statusEl = document.getElementById('status');
    const sessionBanner = document.getElementById('sessionBanner');
  const bannerAgent = document.getElementById('bannerAgent');
  const bannerCwd = document.getElementById('bannerCwd');
  const followToggleBtn = document.getElementById('followToggleBtn');
    if (followToggleBtn) {
      followToggleBtn.addEventListener('click', function () {
        vscode.postMessage({ type: 'toggleFollowAgent' });
      });
    }
    function setFollowingUI(isFollowing) {
      if (!followToggleBtn) { return; }
      followToggleBtn.setAttribute('aria-pressed', isFollowing ? 'true' : 'false');
      var labelEl = followToggleBtn.querySelector('.label');
      if (labelEl) { labelEl.textContent = isFollowing ? 'Following' : 'Follow'; }
    }
    const inputArea = document.getElementById('inputArea');
    const resizeHandle = document.getElementById('resizeHandle');
    const slashPopup = document.getElementById('slashPopup');

    // Picker elements
    const modePickerWrap = document.getElementById('modePickerWrap');
    const modePickerBtn = document.getElementById('modePickerBtn');
    const modePickerLabel = document.getElementById('modePickerLabel');
    const modeDropdown = document.getElementById('modeDropdown');
    const modelPickerWrap = document.getElementById('modelPickerWrap');
    const modelPickerBtn = document.getElementById('modelPickerBtn');
    const modelPickerLabel = document.getElementById('modelPickerLabel');
    const modelDropdown = document.getElementById('modelDropdown');
    const configOptionsContainer = document.getElementById('configOptionsContainer');

  let hasActiveSession = false;
  // Remembers the last connected agent so "Connect to Agent" can reconnect
  // without showing the picker — survives showNoSession() which clears sessionState.
 let lastConnectedAgent = null;
  let lastConnectedAgentDisplay = null;
 let lastConnectedSessionId = null;
 var resumeConnectInFlight = false;
 var pinnedRestoreSessionId = null;
 function requestResumeConnect() {
   if (resumeConnectInFlight || !lastConnectedAgent) return;
   resumeConnectInFlight = true;
   pinnedRestoreSessionId = lastConnectedSessionId;
   if (loadOverlay) loadOverlay.classList.add('visible');
   if (resumeBar) {
     var btns = resumeBar.querySelectorAll('.resume-btn');
     for (var bi = 0; bi < btns.length; bi++) {
       btns[bi].disabled = true;
       btns[bi].style.opacity = '0.55';
       btns[bi].style.pointerEvents = 'none';
     }
   }
   if (welcomeConnectAgent) {
     welcomeConnectAgent.disabled = true;
     welcomeConnectAgent.style.opacity = '0.55';
     welcomeConnectAgent.style.pointerEvents = 'none';
   }
   vscode.postMessage({
     type: 'executeCommand',
     command: 'acp.connectAgent',
     args: [{ agentName: lastConnectedAgent, sessionId: pinnedRestoreSessionId }],
   });
 }
 function resetResumeConnectUi() {
   resumeConnectInFlight = false;
   pinnedRestoreSessionId = null;
   if (resumeBar) {
     var btns2 = resumeBar.querySelectorAll('.resume-btn');
     for (var bj = 0; bj < btns2.length; bj++) {
       btns2[bj].disabled = false;
       btns2[bj].style.opacity = '';
       btns2[bj].style.pointerEvents = '';
     }
   }
   if (welcomeConnectAgent) {
     welcomeConnectAgent.disabled = false;
     welcomeConnectAgent.style.opacity = '';
     welcomeConnectAgent.style.pointerEvents = '';
   }
 }
let isProcessing = false;
let isForceCancelled = false; // true after cancel fallback forces promptEnd
// Track the "— Conversation interrupted —" system message (DOM el + chatHistory
// index) so it can be removed when a new turn starts (promptStart). This keeps
// the notice from lingering in the chat panel after the user sends a follow-up.
let interruptedNoticeEl = null;
let interruptedNoticeHistoryIdx = -1;
// Turn-tail grace window: agents (Codex, Codex, Claude Code, Kiro) can emit
// the FINAL agent_message_chunk a few ms AFTER the session/prompt response
// that carries end_turn — the response resolves first, promptEnd is posted,
// and the late chunk hit the "After promptEnd the turn is closed" guard and
// was silently dropped → user sees "nothing happened" / premature end_turn.
// We accept chunks for a short window after promptEnd and append them to the
// last committed assistant bubble instead of dropping.
let turnTailGraceUntil = 0; // timestamp until which late chunks are accepted
// Same problem at the OTHER turn boundary: session/load. An agent can put its
// final agent_message_chunk on the wire microseconds before the session/load
// response (codex: 1-2 ms), and its notification handler can run after the
// response resolves — so the chunk reaches the webview behind loadSessionEnd,
// where isLoadingSession is already false and the guard above dropped it. That
// lost the entire final summary of a resumed turn, and the INTERIM reply was
// promoted in its place ("Let me investigate how …" left sitting in the panel).
// The host now defers loadSessionEnd to flush the tail first; this window is the
// belt-and-braces net for agents that emit the text truly after the response.
// Messages only — thoughts keep their idle-drop guard so a resumed session does
// not grow a stray Thinking card at the bottom.
let loadTailGraceUntil = 0;
let _loadTailCommitTimer = null;
let _pendingStaleInFlightWatchdogTimer = null;
// When a state.isPromptInFlight latch is suspected of being stale (no send in
// flight, no user prompt, nothing streaming), arm a short watchdog. If no real
// turn activity (promptStart / promptEnd / agent chunk) arrives before it
// fires, the latch was caused by a transient in-flight flag (e.g. the Kiro
// restoreConfigOptions → sendSlashCommand race) and must be cleared — otherwise
// the Send button would stay stuck on "■ Stop" forever.
const STALE_INFLIGHT_WATCHDOG_MS = 3000;
const TURN_TAIL_GRACE_MS = 1500;
/** Window after a replay ends in which a straggling reply chunk is still taken. */
const LOAD_TAIL_GRACE_MS = 2500;
let hasSentPrompt = false;
// Track whether the last sent prompt was a slash command (e.g. /ps, /stats).
// Used to delay queue draining after slash command output so the result
// stays visible for at least 3 seconds before the next turn starts.
let lastPromptWasSlash = false;
// Track whether we've already sent a steer notification during the current
// turn. The FIRST message typed while a turn is streaming gets steered into
// the active turn (shown as a user bubble + session/steer). Any
// subsequent messages are queued and drained after the turn ends.
let hasSteeredThisTurn = false;
// True in the tiny window between drainQueue() posting sendPrompt and the
// host's promptStart arriving (the turn-transition tick). A message typed in
// that window must NOT be sent as a prompt — the previous sendPrompt is still
// in flight host-side and a second concurrent session/prompt would race the
// in-flight turn (claude-code-acp serializes via sessionPromptLocks, but
// codex/codex would drop/duplicate). Instead it is queued and waits for the
// next drain. Cleared by promptStart (turn actually started) and by the
// promptEnd/error path (turn fully finished).
let isSendingPrompt = false;
// When true, the next handleSend() skips rendering a visible user bubble
// (used by fork-to-agent so the forked summary isn't shown in the panel —
// the summary is still sent to the agent for context, just not displayed).
let suppressNextUserBubble = false;
var pendingRenderRetries = {}; // keys of pending renderMarkdown retries
var historyRenderGen = 0; // generation counter for history renders (invalidated on DOM rebuild)
var suppressFoldOrdering = false; // true during renderChatHistory to skip intermediate re-ordering
let isCompacting = false;  // true while /compact is running
 let isClearing = false;    // true while Kiro /clear (or clear/status) is running
 // True only for user-typed /compact — auto-compact must not leave a sticky
 // "Conversation compacted." banner while the agent keeps streaming.
 let manualCompacting = false;
 let compactedWarningText = '';  // buffered warning text during compaction
 // "*Context compacted*" notice — Codex emits this BEFORE the Heads-up
 // warning (item/completed → thread/compacted → Warning). Buffer both and
 // flush Warning first so the UI matches the intended order.
 let compactedNoticeText = '';
 let compactionFlushTimer = null;
 // Chunks that arrived while a compaction flush was pending (post-completed,
 // pre-flush window). Held back so the flush's innerHTML='' wipe doesn't drop
 // the first tokens of the resumed reply; drained into currentAssistantText
 // AFTER the wipe so they render cleanly in the fresh panel. See the
 // agent_message_chunk handler's compactionFlushTimer gate.
 let pendingPostCompactChunks = [];
 // Drain buffered post-compact chunks into currentAssistantText and render them.
 // Used by flushCompactionMessages (after the wipe, so they land in the fresh
 // panel) and by the agent_message_chunk gate when the flush timer is no longer
 // armed but the buffer still holds orphaned tokens (the timer was cleared by a
 // failed/superseded compaction). Preserves order: buffered tokens first, then
 // any new chunk appended by the caller. No-op when nothing is buffered.
 function drainPendingPostCompactChunks() {
   if (pendingPostCompactChunks.length === 0) return;
   var _drained = pendingPostCompactChunks;
   pendingPostCompactChunks = [];
   var _drainedText = _drained.join('');
   if (_drainedText) {
     currentAssistantText += _drainedText;
     if (!isLoadingSession) {
       scheduleStreamingRender();
     }
   }
 }
 let kiroCompactWatchdog = null; // safety timeout while waiting for true Kiro done
 // After a successful compact flush, drop late Codex boilerplate
 // ("Warning: Heads up…", "*Context compacted…") that arrives after isCompacting
 // is cleared so it never lands in the chat panel.
 let suppressPostCompactNoiseUntil = 0;

   // --- Message queue ---
    // When the agent is generating, new messages are queued and
    // auto-sent when the current turn completes (promptEnd).
    // Each entry: { text: string, images: Array<{data:string,mimeType:string}> }
    let messageQueue = [];
    const msgQueueEl = document.getElementById('msgQueue');
    const msgQueueLabelEl = document.getElementById('msgQueueLabel');

    function renderQueue() {
      if (!msgQueueEl) return;
      msgQueueEl.innerHTML = '';
      if (messageQueue.length === 0) {
        msgQueueLabelEl.style.display = 'none';
        msgQueueEl.style.display = 'none';
        return;
      }
      msgQueueLabelEl.style.display = 'block';
      msgQueueEl.style.display = 'block';
      messageQueue.forEach((entry, index) => {
       const chip = document.createElement('div');
       chip.className = 'msg-queue-item';
       const textSpan = document.createElement('span');
       textSpan.className = 'queue-text';
       textSpan.textContent = entry.text || '(image)';
       textSpan.title = entry.text || '';
       chip.appendChild(textSpan);
       // Edit button — moves message text back to prompt input
       const editBtn = document.createElement('span');
       editBtn.className = 'queue-action';
       editBtn.textContent = '✎';
       editBtn.title = 'Edit queued message';
       editBtn.addEventListener('click', () => {
         editQueuedMessage(index);
       });
       chip.appendChild(editBtn);
       // Delete button — removes from queue
       const removeBtn = document.createElement('span');
       removeBtn.className = 'queue-action';
       removeBtn.textContent = '×';
       removeBtn.title = 'Remove from queue';
       removeBtn.addEventListener('click', () => {
         removeQueuedMessage(index);
       });
       chip.appendChild(removeBtn);
       // Send Now button — sends immediately, cancelling in-flight generation
       const sendNowBtn = document.createElement('span');
       sendNowBtn.className = 'queue-send-now';
       sendNowBtn.textContent = 'Send Now';
       sendNowBtn.title = 'Send this message now (interrupts current generation)';
       sendNowBtn.addEventListener('click', () => {
         sendQueuedMessageNow(index);
       });
       // Steered entries are already on their way; say so instead of leaving them
       // looking like they are still waiting for the turn to end.
       if (entry.steered) {
         chip.classList.add('queue-steered');
         const sentTag = document.createElement('span');
         sentTag.className = 'queue-sent-tag';
         // Two different states, and the difference matters: still waiting for this
         // turn's confirmation, versus sent but unconfirmed once the turn has ended
         // (which means it will be sent as a normal prompt instead).
         sentTag.textContent = entry.steerPending ? 'in turn' : 'sent';
         sentTag.title = entry.steerPending
           ? 'Delivered into the running turn — waiting for the agent to confirm it'
           : 'Sent into the previous turn but never confirmed — it will go as a normal prompt';
         chip.appendChild(sentTag);
       }
       // Withheld while a steer for this entry awaits confirmation: pressing it cancelled
       // the turn and re-sent a message the agent had already taken (steer 02:14:26, echo
       // 02:14:28, Send Now 02:17:20, duplicate prompt id=10 at 02:17:30). Once a turn
       // ends without a confirmation it is offered again, since then it truly did not land.
       if (!entry.steerPending) chip.appendChild(sendNowBtn);
       // Steer button — injects into the RUNNING turn instead of waiting for it
       // to end. Only for agents whose steer path is dependable (see
       // agentSupportsMidTurnSteer); everyone else keeps queue-and-drain.
       if (isProcessing && !entry.steered && agentSupportsMidTurnSteer(currentAgentLabel())) {
         const steerBtn = document.createElement('span');
         steerBtn.className = 'queue-send-now queue-steer';
         steerBtn.textContent = 'Steer';
         steerBtn.title = 'Send into the running turn — the agent picks it up at its next step, without interrupting';
         steerBtn.addEventListener('click', () => {
           steerQueuedMessage(index);
         });
         chip.appendChild(steerBtn);
       }
       msgQueueEl.appendChild(chip);
     });
   }

   function queueMessage(text, images) {
     const entry = { text, images: images || [] };
     messageQueue.push(entry);
     renderQueue();
     maybeAutoSteerNext();
   }

   /**
    * Deliver the next eligible queued message into the RUNNING turn.
    *
    * One at a time: the entry stays in the queue until the agent echoes it, and
    * only then does the next one go. A steer that never lands still drains as a
    * normal prompt at promptEnd, so this is at-least-once with no duplicate on the
    * agents that echo.
    */
   function maybeAutoSteerNext() {
     // Gated by acp.autoSteerQueuedMessages (default on). Ordering depends on the
     // agent echoing a steered message when it DELIVERS it to the model, not when it
     // receives it — codex echoing on receipt let two interjections pile up and the
     // model answered only the last (codex now echoes at drain time).
     if (!autoSteerQueuedEnabled) return false;
     if (!isProcessing || isCompacting || isClearing) return false;
     if (!agentAutoSteersQueuedMessages(currentAgentLabel())) return false;
     var idx = nextAutoSteerIndex(messageQueue);
     if (idx < 0) return false;
     var entry = messageQueue[idx];
     entry.steered = true;
     entry.steerPending = true;
     hasSteeredThisTurn = true;
     vscode.postMessage({ type: 'steerPrompt', text: entry.text || ' ' });
     renderQueue();
     showTransientHint('Sent into the running turn — the agent picks it up at its next step.');
     return true;
   }

   /**
    * Promote a steered entry into the chat once the agent confirms it.
    *
    * The echo is the only delivery signal available, since session/steer is a
    * notification. It does NOT render anything by itself: the live
    * user_message_chunk path returns early (the webview normally adds user bubbles
    * locally), so acking by deletion alone made the message disappear — chip gone,
    * nothing in the transcript. The bubble is therefore added here, at the moment
    * delivery is confirmed, and only then is the chip removed.
    */
   function ackSteeredQueueEntry(echoText) {
     for (var i = 0; i < messageQueue.length; i++) {
       var e = messageQueue[i];
       if (e && e.steered && steerEchoMatchesEntry(e.text, echoText)) {
         messageQueue.splice(i, 1);
         renderQueue();
         addUserBubbleForQueuedEntry(e);
         vscode.postMessage({
           type: 'debugLog',
           message: '[STEER] agent confirmed a steered message; promoted it into the chat',
         });
         // The channel is free again — release the next queued message.
         maybeAutoSteerNext();
         return true;
       }
     }
     return false;
   }

   // Add a user bubble for a queue entry at the moment it is actually being
   // sent to the agent (drain / "Send Now" / pending-after-cancel). handleQueue
   // deliberately does NOT show the bubble at queue time so a prompt queued
   // during a long turn (e.g. /compact) stays hidden until it's processed.
   function addUserBubbleForQueuedEntry(entry) {
     chatHistory.push({ kind: 'message', role: 'user', text: entry.text || '(image)' });
     saveState();
     addMessageDOM('user', entry.text || '(image)');
     // Reset turn + tool state so the next agent_message_chunk / tool_call
     // creates a fresh turn container under this user bubble. Retire the tool
     // registry too — this is the Send Now path, where the interrupted turn is
     // still emitting and its ids may collide with the replacement turn's.
     if (typeof retireToolCallRegistry === 'function') retireToolCallRegistry();
     currentTurnEl = null;
     currentToolsListEl = null;
     currentToolsCountEl = null;
     currentToolCount = 0;
   }

   // Remove a message from the queue by index
   function removeQueuedMessage(index) {
     messageQueue.splice(index, 1);
     renderQueue();
   }

   /**
    * Deliver a queued message into the turn that is already running.
    *
    * Unlike Send Now this does NOT cancel: the agent receives session/steer and
    * folds the text in at its next tool-iteration boundary, so it lands between
    * tool calls rather than after promptEnd. The bubble is added immediately
    * because the message really is on its way — that is the difference from
    * queueing, where the bubble waits for drain time.
    */
   function steerQueuedMessage(index) {
     if (index < 0 || index >= messageQueue.length) return;
     const entry = messageQueue[index];
     if (!entry) return;
     if (!isProcessing || !agentSupportsMidTurnSteer(currentAgentLabel())) return;
     // Keep the entry queued until the agent echoes it, exactly like the automatic
     // path. It used to be removed here, with the bubble rendered immediately — but
     // session/steer is a NOTIFICATION, so an agent that does not implement it (or
     // whose turn has just ended) drops it in silence and the message was gone while
     // the UI claimed it was delivered. Queued-until-confirmed means an unacked steer
     // still drains as a normal prompt at promptEnd.
     entry.steered = true;
     entry.steerPending = true;
     hasSteeredThisTurn = true;
     renderQueue();
     vscode.postMessage({ type: 'steerPrompt', text: entry.text || ' ' });
     showTransientHint('Sent into the running turn — the agent picks it up at its next step.');
   }

   // Edit a queued message — moves text back to the prompt input and
   // removes it from the queue
   function editQueuedMessage(index) {
     if (index < 0 || index >= messageQueue.length) return;
     const entry = messageQueue[index];
     // Put the text back in the prompt input (append if there's existing text)
     if (promptInput.value.trim()) {
       promptInput.value = promptInput.value.trim() + '\\n' + (entry.text || '');
     } else {
       promptInput.value = entry.text || '';
     }
    // Restore images if any
    if (entry.images && entry.images.length > 0) {
      for (const img of entry.images) {
        pendingImages.push(img);
        // Rebuild the preview thumbnail for this restored image
        var dataUrl = 'data:' + img.mimeType + ';base64,' + img.data;
        var byteChars = atob(img.data);
        var byteArrays = [];
        for (var j = 0; j < byteChars.length; j += 512) {
          var slice = byteChars.slice(j, j + 512);
          var byteNumbers = new Array(slice.length);
          for (var k = 0; k < slice.length; k++) {
            byteNumbers[k] = slice.charCodeAt(k);
          }
          byteArrays.push(new Uint8Array(byteNumbers));
        }
        var blob = new Blob(byteArrays, { type: img.mimeType });
        var blobUrl = URL.createObjectURL(blob);
        var thumb = document.createElement('div');
        thumb.className = 'img-thumb';
        var imgEl = document.createElement('img');
        imgEl.src = blobUrl;
        var rmBtn = document.createElement('button');
        rmBtn.className = 'img-remove';
        rmBtn.textContent = '×';
        (function(capturedThumb, capturedIdx) {
          rmBtn.addEventListener('click', function() {
            var idx = Array.from(imagePreviewStrip.children).indexOf(capturedThumb);
            if (idx >= 0) pendingImages.splice(idx, 1);
            URL.revokeObjectURL(blobUrl);
            capturedThumb.remove();
          });
        })(thumb);
        thumb.appendChild(imgEl);
        thumb.appendChild(rmBtn);
        imagePreviewStrip.appendChild(thumb);
      }
    }
    // Remove from queue
    messageQueue.splice(index, 1);
    renderQueue();
    promptInput.focus();
    updateSendButton();
   }

   // Send a queued message immediately — cancels any in-flight generation,
   // then sends the message. After the cancel completes and promptEnd
   // fires, the message is sent via a one-shot flag.
   var pendingSendAfterCancel = null;
   // Set when /stop triggers the cancel path. Like pendingSendAfterCancel,
   // this suppresses the "Conversation interrupted" notice — /stop is a
   // process kill, not an interruption — and lets queued messages drain.
   var suppressInterruptNotice = false;
 function sendQueuedMessageNow(index) {
   if (index < 0 || index >= messageQueue.length) return;
   // A steer for this entry is still awaiting confirmation: re-sending would deliver it
   // twice. The button is hidden in that state; this guards a stale click.
   if (messageQueue[index] && messageQueue[index].steerPending) {
     showTransientHint('Already sent into the running turn — waiting for the agent to pick it up.');
     return;
   }
   const entry = messageQueue[index];
   // Remove from queue immediately
   messageQueue.splice(index, 1);
   renderQueue();

  // The user bubble is added when the message is actually sent (not at
  // queue time), so it must be added here. Helper centralizes the
  // chatHistory/DOM/turn-reset so every drain path is consistent.
  if (isProcessing) {
   // Set the pending message; it will be sent once promptEnd fires
   // after the cancel completes.
   pendingSendAfterCancel = entry;
   // Do NOT add the user bubble yet. The in-flight turn is still streaming, and
   // addUserBubbleForQueuedEntry resets currentTurnEl — so every tool_call /
   // chunk that the cancelled turn still emits opened a FRESH turn BELOW the
   // new bubble. The queued message then rendered ABOVE the prior turn's own
   // commands, i.e. before the work it was meant to interrupt.
   //
   // The bubble is added by the promptEnd drain path instead (guarded by
   // entry.bubbleShown), which runs after the cancelled turn has closed, so the
   // message lands after the prior turn's content. promptEnd is guaranteed:
   // the host forces it via the cancel-timeout fallback if the agent never
   // acknowledges session/cancel.
   //
   // Immediate feedback comes from the status line rather than a chat row: a
   // row inserted here would sit in the same wrong position we are fixing.
   if (statusEl) {
     statusEl.textContent = 'Interrupting — your message sends next…';
   }
   // Kill long-running commands from the current turn BEFORE cancelling,
   // so they don't keep running in the background after the new prompt
   // starts. Without this, the cancel ends the ACP turn but spawned
   // processes (builds, test suites, etc.) keep running and their output
   // leaks into the next turn.
   //
   // suppressNotice: this is NOT a /stop — the user clicked "Send Now" and
   // the kill is a side effect of interrupting the turn. The host will skip
   // the transient "Killed N running process." notice so it doesn't look
   // like the user explicitly stopped the processes.
   vscode.postMessage({ type: 'stopProcesses', suppressNotice: true });
   vscode.postMessage({ type: 'cancelTurn' });
  } else {
     // Not processing — send directly now and show the bubble.
    // Route slash commands through handleLocalSlashCommand so local UI
    // (compaction progress, clear, etc.) is triggered properly.
    if (entry.text && entry.text.startsWith('/') && handleLocalSlashCommand(entry.text)) {
      // Local slash command handled it — no user bubble.
    } else {
      addUserBubbleForQueuedEntry(entry);
      hasSentPrompt = true;
     // Guard the transition tick: the sendPrompt is now in flight host-side
     // and until promptStart lands, new input must queue, not send.
     isSendingPrompt = true;
     // Optimistically set processing=true so the Stop button shows immediately.
     setProcessing(true, 'drainQueue-localslash-notprocessing');
     vscode.postMessage({ type: 'sendPrompt', text: entry.text || ' ', images: entry.images });
    }
  }
}

// Pure decision helpers for the message queue. Kept as standalone top-level
// functions inside the webview template literal (NOT nested in a closure) so
// the test suite can extract them verbatim via new Function(...) — the same
// pattern used by foldOrdering.test.ts / cleanUserMessage.test.ts. They encode
// the queue requirements:
//   - every mid-turn message is queued (never steered, never dropped);
//   - messages drain strictly FIFO, one per agent turn;
//   - the transition tick (sendPrompt posted, promptStart not yet received)
//     queues instead of racing the in-flight prompt.
/**
 * The model id carried by a session's configOptions, or '' when absent.
 *
 * Agents that use configOptions exclusively (Kiro CLI) express the active model
 * as the option with category 'model'; the legacy models field may be missing
 * entirely. The attach-button rule for Kiro / Codex reads currentModelId, so
 * without this the image button stays hidden on a vision model.
 *
 * Matches SessionManager's lookup (o.category === 'model') and falls back to
 * an id of 'model' for agents that set only the id.
 */
/**
 * Whether a queued message can be injected into the RUNNING turn.
 *
 * Mid-turn steering was removed wholesale in c397673 because it behaved
 * differently per agent: codex drains only at tool-iteration boundaries,
 * codex-acp dropped notifications at the turn tail, and claude-code deferred to
 * sequential --resume turns, so steered text could vanish with no response. That
 * fix made every mid-turn message queue and drain one-per-turn, which is why a
 * queued message waits for promptEnd instead of landing between tool calls.
 *
 * Since then all three became dependable, verified in their sources:
 *   - codex drains at every tool-iteration boundary and re-loops once if the
 *     model replies without acting on the interjection;
 *   - claude-code queues it with the same in-flight test handleSteer uses;
 *   - codex-acp no longer sends a notification that can be dropped — it calls
 *     Codex's native turn/steer RPC and rejects outright when there is no
 *     currentTurnId, so the text is either delivered or refused, never lost.
 *
 * pi-acp has no steer path at all (it queues whole prompts internally instead),
 * and kiro-cli / cursor are external binaries with no adapter here, so none of
 * them are offered it. The default for every agent stays queue-and-drain.
 */
/**
 * Whether a message typed mid-turn should be steered AUTOMATICALLY, rather than
 * waiting for the queue to drain at promptEnd.
 *
 * Narrower than agentSupportsMidTurnSteer on purpose. Auto-steering is only safe
 * when delivery can be CONFIRMED, because session/steer is a notification: the
 * client never learns whether the agent took it. codex and claude-code both echo
 * the steered text back as a user_message_chunk when they accept it, so the entry
 * can stay queued until that echo arrives and drain normally if it never does —
 * at-least-once with no duplicate.
 *
 * codex-acp joined once it started echoing an accepted steer (881decb): its
 * turn/steer RPC was already reliable, but silence was indistinguishable from
 * refusal, so an auto-steer could be neither confirmed nor safely retried.
 *
 * pi-acp implements no steer at all — it queues whole prompts internally — and
 * kiro-cli / cursor are external binaries with no adapter of ours, so for those
 * three a mid-turn message still waits for the turn to end. That is not a policy
 * choice; there is nowhere to deliver it.
 */
function agentAutoSteersQueuedMessages(agentLabel) {
  var label = String(agentLabel || '');
  if (!label) return false;
  if (/^pi([ _-]?acp)?$/i.test(label.trim())) return false;
  if (/claude/i.test(label)) return true;
  if (/codex/i.test(label)) return true;
  // NOT kiro. https://kiro.dev/docs/cli/acp/ lists its whole core protocol as
  // initialize, session/new, session/load, session/prompt, session/cancel,
  // session/set_mode and session/set_model — no steering, no mid-turn input — and
  // its extensions all use the _kiro.dev/ prefix, which the same page says clients
  // may "safely ignore". A session/steer notification to kiro is therefore dropped
  // in silence, and steerQueuedMessage would have removed the message from the
  // queue and shown its bubble before sending it: lost, while looking delivered.
  return false;
}

/**
 * Collapse whitespace runs WITHOUT a regex.
 *
 * Regex escapes are hazardous in this file: it is one big template literal, so a
 * whitespace-class escape collapses to the bare letter s (silently matching that
 * letter instead of whitespace), and spelling the class out with tab/newline
 * escapes collapses to a real newline, which cannot appear inside a regex literal
 * at all — that one broke the emitted script outright. Character codes sidestep
 * the question entirely; see the escape rule in AGENTS.md.
 */
function collapseWhitespaceChars(text) {
  var str = String(text || '');
  var out = '';
  var pendingSpace = false;
  for (var i = 0; i < str.length; i++) {
    var code = str.charCodeAt(i);
    if (code === 32 || code === 9 || code === 10 || code === 13) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) {
      out += ' ';
      pendingSpace = false;
    }
    out += str.charAt(i);
  }
  return out;
}

/**
 * Index of the next queued message eligible for automatic steering, or -1.
 *
 * At most ONE steer is in flight at a time. Steering the whole queue at once
 * delivered every message as a separate interjection at the agent's next
 * iteration boundary, which buries the earlier ones — and there is no way to tell
 * which of several unacked steers a given echo belongs to, since matching is by
 * text. Waiting for the ack keeps the order intact and the accounting honest.
 *
 * Skips what cannot ride session/steer: images (text-only channel) and slash
 * commands (they must start their own turn).
 */
function nextAutoSteerIndex(queue) {
  if (!Array.isArray(queue)) return -1;
  for (var i = 0; i < queue.length; i++) {
    // steerPending means "sent in THIS turn, still waiting for the agent to confirm".
    // Deliberately not the sent-ever flag, which stays set for the life of the entry so
    // echo can still be matched: codex's steer queue survives a turn boundary, so an
    // echo can arrive during the NEXT turn (measured: steer 08:50:48, echo 08:52:42,
    // with a new prompt at 08:52:32 in between).
    if (queue[i] && queue[i].steerPending) return -1;
    // Already delivered once — never steer the same entry twice.
    if (queue[i] && queue[i].steered && !queue[i].steerPending) continue;
  }
  for (var j = 0; j < queue.length; j++) {
    var e = queue[j];
    if (!e) continue;
    if (e.steered) continue; // already sent once; waiting for its echo or for drain
    if (e.images && e.images.length) continue;
    if (String(e.text || '').trim().indexOf('/') === 0) continue;
    return j;
  }
  return -1;
}

/** Normalized compare for matching an agent echo back to a queued entry. */
function steerEchoMatchesEntry(entryText, echoText) {
  var a = collapseWhitespaceChars(entryText);
  var b = collapseWhitespaceChars(echoText);
  if (!a || !b) return false;
  if (a === b) return true;
  // Agents may append context (memory blocks) after the text they echo.
  return b.indexOf(a) === 0;
}

function agentSupportsMidTurnSteer(agentLabel) {
  var label = String(agentLabel || '');
  if (!label) return false;
  // kiro is excluded for the reason spelled out on
  // agentAutoSteersQueuedMessages: its documented protocol has no steering method
  // and unknown extensions are ignored silently.
  if (/kiro/i.test(label)) return false;
  // pi must be excluded before the generic checks — "pi-acp" contains no other
  // marker, but keep the guard explicit so a rename cannot silently enable it.
  if (/^pi([ _-]?acp)?$/i.test(label.trim())) return false;
  if (/claude/i.test(label)) return true;
  if (/codex/i.test(label)) return true;
  return false;
}

function modelIdFromConfigOptions(configOptions) {
  if (!Array.isArray(configOptions)) return '';
  for (var i = 0; i < configOptions.length; i++) {
    var o = configOptions[i];
    if (!o || typeof o !== 'object') continue;
    var cat = String(o.category || '').toLowerCase();
    var id = String(o.id || '').toLowerCase();
    if (cat === 'model' || id === 'model') {
      var v = o.currentValue;
      return typeof v === 'string' ? v.trim() : '';
    }
  }
  return '';
}

/**
 * Explain WHY a tool call was routed into the subagent/crew UI, or 'none'.
 *
 * Mirrors isSubagentSpawnTitle / looksLikeClaudeAgentSpawn but returns the
 * specific predicate that fired, so a false "spawned N subagent(s)" card can be
 * traced to its trigger. Diagnostics only — the routing decision still belongs
 * to isSubagentSpawnTitle.
 *
 * Why this exists: a Kiro resume rendered a "spawned 1 subagent" card although
 * the agent reported {"subagents": [], "pendingStages": []} and NO tool call in
 * the whole session had a qualifying title or rawInput (title census: shell,
 * write, read, grep, glob, Running:, Editing, Creating). The trigger was not on
 * the wire, so it has to be identified at the moment the card is built.
 *
 * Uses indexOf rather than regexes: this lives inside the webview template
 * literal, where a single-backslash escape would be collapsed and corrupt the
 * emitted script.
 */
function subagentSpawnReason(title, rawInput) {
  var tn = String(title || '').trim();
  var tl = tn.toLowerCase();
  var ri = (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) ? rawInput : null;
  if (ri && typeof ri.subagent_type === 'string' && ri.subagent_type.trim()) {
    return 'rawInput.subagent_type=' + ri.subagent_type.trim();
  }
  if (ri && String(ri._toolName || '').trim().toLowerCase() === 'agent') {
    return 'rawInput._toolName=agent';
  }
  if (tl === 'task' || tl === 'agent' || tl === 'subagent') return 'title==' + tl;
  if (tn === 'spawnAgent' || tn === 'spawn_agent' || tn === 'spawn_agents_on_csv') return 'title==' + tn;
  if (tl.indexOf('spawn') === 0 && tl.indexOf('agent') >= 0) return 'title:spawn*agent';
  if (tl.indexOf('spawning') >= 0 && tl.indexOf('agent') >= 0) return 'title:spawning+agent';
  if (tl.indexOf('agent crew') >= 0) return 'title:agent-crew';
  return 'none';
}

/**
 * True when an incoming agent_thought_chunk has no turn to belong to and must
 * be dropped rather than appended.
 *
 * A thought that arrives while the panel is idle — session/load finished,
 * nothing streaming, no compaction, and outside the post-end_turn tail-grace
 * window — cannot be attached to any turn. Appending it pushes a thought block
 * to the very END of chatHistory, after the entire conversation: the "thinking
 * blocks grouped at the bottom" symptom on resume. Measured on a Kiro resume:
 * chatHistory ended with ten consecutive thoughts (indices 672-681) even though
 * the wire delivered them interleaved, because the replay tail landed after
 * loadSessionEnd had already flipped isLoadingSession to false.
 *
 * This mirrors the guard the agent_message_chunk case has always had. The
 * tail-grace window is what keeps a legitimately late final thought (agent
 * still flushing after end_turn) from being discarded.
 */
function shouldDropIdleThoughtChunk(isLoadingSession, isProcessing, isCompacting, inTailGrace) {
  return !isLoadingSession && !isProcessing && !isCompacting && !inTailGrace;
}

function queueIsMutatingCommand(text) {
  // NOTE: this block lives inside the webview HTML template literal, so every
  // backslash must be DOUBLED (\\/) — a single backslash is collapsed by the
  // template literal into a plain "/" and the emitted script fails to parse
  // with 'Invalid or unexpected token' (webview crash). The unit test reads
  // the raw .ts text where the single-backslash form would pass, which is
  // exactly why the escape must be correct here in the source.
  return /^\\/(compact|summarize|compress)\\b/i.test(text) ||
    /^\\/clear\\b/i.test(text) ||
    /^\\/index\\s+(build|rebuild|refresh|update|embed|clear|delete)\\b/i.test(text);
}

// Decide whether a drained message counts as "sent to the agent" (a turn will
// start and the next queued message must wait for its promptEnd) or was
// handled purely client-side (no turn, chain the next message immediately).
// handledLocal is true when handleLocalSlashCommand consumed the message as
// a local command; startedTurn is true when that command set isProcessing
// (e.g. /compact, /clear) and therefore a real turn is in flight.
function queueDrainStartedTurn(handledLocal, startedTurn, isProcessingNow) {
  if (!handledLocal) return true;               // sent as a prompt -> turn
  if (startedTurn) return true;                 // /compact,/clear -> turn
  return !!isProcessingNow;                     // defensive: anything processing
}

// Whether an agent supports REAL mid-turn steering from this client.
// Option B is active: EVERY agent (Codex, Codex included) takes the
// deferred-queue path — a message typed mid-turn is held as a queue chip (no
// chat bubble yet) and drained via drainQueue() one-per-turn FIFO after the
// current turn's promptEnd. Steers (session/steer → live turn injection)
// caused the prompt to appear in the chat panel immediately and, for some
// models, ended the turn prematurely — the visible bubble was misleading
// because the agent had not actually consumed it yet. Keeping this false
// guarantees the user bubble only appears when the message is actually sent,
// matching the documented Option B behavior in docs/QUEUE-BEHAVIOR.md.
function agentSupportsSteering(agentName) {
  return false;
}

function drainQueue() {
 if (messageQueue.length === 0) return false;
 vscode.postMessage({ type: 'debugLog', message: '[DRAIN-DBG] drainQueue: dequeuing, remaining=' + (messageQueue.length - 1) + ' isProcessing=' + isProcessing });
const entry = messageQueue.shift();
renderQueue();
 // Dismiss /ps panel (respecting min display window) — a new turn is starting.
 dismissPsPanel(false);
 // The user message is shown as a bubble NOW (at drain time, not queue
 // time) — handleQueue only added the queue chip so the prompt stayed
 // hidden while it was genuinely queued (e.g. during a long /compact).
hasSentPrompt = true;
 if (entry.text && entry.text.startsWith('/') && handleLocalSlashCommand(entry.text)) {
   vscode.postMessage({ type: 'debugLog', message: '[DRAIN-DBG] drainQueue: handled as local slash command' });
   // Local slash command handled it — don't send as prompt, and don't add
   // a user bubble (slash commands render their own output).
   // Some local commands (/rename, /ps, /stop, /session) do NOT start a turn
   // and get no promptEnd. Chain the next queued message immediately instead
   // of stalling until an unrelated turn completes. Commands that DO start a
   // turn (/compact, /clear) leave isProcessing true — the next message waits
   // for that turn's promptEnd (strict FIFO, one per turn).
   // /compact and /clear set isProcessing true (a turn is in flight), so the
   // next queued message must wait for that turn's promptEnd. /stop,/rename,
   // /ps,/session stay idle → chain the next message right away.
   var _drainStartedTurn = queueDrainStartedTurn(true, isProcessing, isProcessing);
   if (messageQueue.length > 0 && !_drainStartedTurn && !isCompacting && !isClearing) {
     vscode.postMessage({ type: 'debugLog', message: '[DRAIN-DBG] drainQueue: chaining next (local slash, no turn started), remaining=' + messageQueue.length });
     setTimeout(function() { if (!isProcessing && messageQueue.length > 0) { drainQueue(); } }, 0);
   }
 } else {
    vscode.postMessage({ type: 'debugLog', message: '[DRAIN-DBG] drainQueue: sending as sendPrompt' });
    addUserBubbleForQueuedEntry(entry);
   // The sendPrompt is now in flight — a message typed in the transition
   // tick (before promptStart arrives) must queue, and the next queued
   // message must wait for THIS turn's promptEnd (strict FIFO, one per turn).
  isSendingPrompt = true;
  // Optimistically set processing=true so the Stop button shows immediately.
  // See handleSend() for rationale (VS Code webview postMessage throttling).
  setProcessing(true, 'drainQueue-sendPrompt');
  vscode.postMessage({ type: 'sendPrompt', text: entry.text || ' ', images: entry.images });
}
return true;
}

    // Modes / models state (legacy fallback path)
    let availableModes = [];
    let currentModeId = null;
    let availableModels = [];
    let currentModelId = null;

    // ACP Session Config Options state (preferred path)
    let configOptions = [];        // SessionConfigOption[]
    let useConfigOptions = false;  // true when the agent provided configOptions

    // Thinking state
    let currentThoughtEl = null;
    // When a mid-turn thought resumes after ensureTurnTools cleared the JS
    // pointers, we reuse the existing .thought-block at the top of the turn.
    // thoughtDomBase holds the text already committed to that DOM node so new
    // chunks append instead of replacing — and only the new portion is pushed
    // to chatHistory (avoiding duplicates on replay).
    let thoughtDomBase = '';
    let currentThoughtTextEl = null;
    let currentThoughtText = '';
    let thoughtStartTime = null;
    let thoughtEndTime = null;

   // Slash commands state
  let availableCommands = [];
  let slashPopupSelectedIdx = -1;
  let slashFilteredCommands = [];
  let savedPlaceholder = 'Type a message...';
  let sessionNames = [];
  let sessionNamesRequested = false;
 let isSessionAutocomplete = false;
 let sessionAutocompleteSelectedIdx = -1;
 let sessionAutocompleteFiltered = [];
 var goalSubcommands = [
   { name: 'clear', description: 'Clear the active goal' },
   { name: 'pause', description: 'Pause the active goal' },
   { name: 'resume', description: 'Resume a paused goal' },
 ];
 let isGoalSubcommandAutocomplete = false;
 let goalSubcommandSelectedIdx = -1;
 let goalSubcommandFiltered = [];

  /** Built-in client-side slash commands (always available). */
const builtinCommands = [
  { name: 'rename', description: 'Rename the current conversation' },
  { name: 'session', description: 'Add a past session summary as context' },
  { name: 'stop', description: 'Kill all running background processes spawned in this session' },
];

   /** Merge built-in commands with agent-provided ones (dedupe by name; builtin wins). */
   function getMergedCommands() {
     var seen = Object.create(null);
     var merged = [];
     function add(c) {
       if (!c || !c.name || seen[c.name]) return;
       seen[c.name] = true;
       merged.push(c);
     }
     // Builtins first so client-side rename/session handlers win over
     // agents (e.g. Claude Code) that also advertise the same names.
     builtinCommands.forEach(add);
     availableCommands.forEach(add);
     return merged;
   }

   /** Render the session name autocomplete popup. */
   function renderSessionAutocomplete(names) {
     slashPopup.innerHTML = '<div class="slash-popup-header">Sessions</div>';
     names.forEach(function(name, i) {
       var item = document.createElement('div');
       item.className = 'slash-popup-item' + (i === 0 ? ' active' : '');
       item.dataset.index = String(i);
       item.innerHTML =
         '<span class="cmd-name">' + escapeHtml(name) + '</span>';
       item.addEventListener('click', function() { selectSessionName(name); });
       item.addEventListener('mouseenter', function() {
         sessionAutocompleteSelectedIdx = i;
         var items = slashPopup.querySelectorAll('.slash-popup-item');
         items.forEach(function(el, j) { el.classList.toggle('active', j === i); });
       });
       slashPopup.appendChild(item);
     });
   }

  function selectSessionName(name) {
    slashPopup.classList.remove('open');
    isSessionAutocomplete = false;
    // Replace the partial session name with the selected one.
    // Current input: "/session ue" → "/session ue session route path "
    // If there was query text after a space, preserve it:
    // "/session ue what's this" → "/session ue session route path what's this"
    var val = promptInput.value;
    var slashIdx = val.indexOf('/session ');
    if (slashIdx >= 0) {
      var afterCmd = val.substring(slashIdx + 9); // after "/session "
      var firstSpaceIdx = afterCmd.indexOf(' ');
      var remainingQuery = firstSpaceIdx >= 0 ? afterCmd.substring(firstSpaceIdx + 1) : '';
      promptInput.value = '/session ' + name + (remainingQuery ? ' ' + remainingQuery : ' ');
    } else {
      promptInput.value = '/session ' + name + ' ';
    }
    promptInput.focus();
    // Place cursor at the end
    var pos = promptInput.value.length;
    promptInput.setSelectionRange(pos, pos);
    updateSendButton();
  }

   function updatePlaceholder() {
      // Always show "/ for commands" since built-in commands (e.g. /rename)
      // are always available even when the agent provides none.
      savedPlaceholder = 'Type a message, / for commands, @ for context...';
     if (!promptInput.value.startsWith('/')) {
       promptInput.placeholder = savedPlaceholder;
     }
   }

    // --- State persistence ---
    let chatHistory = [];
    let sessionState = null;
    // Snapshot taken at loadSessionStart so Claude incomplete session/load
    // (interrupted mid-turn often replays only the user prompt) can restore
    // tools/thoughts that were already in the webview / vscode.setState.
    let preLoadChatHistorySnapshot = null;
    // Track which session the snapshot was taken from. The merge logic in
    // handleLoadSessionEnd should ONLY restore items from the snapshot when
    // we're loading the SAME session that was displayed when the snapshot
    // was taken. Without this guard, switching from session A to session B
    // causes session A's chatHistory to be merged into session B's replay.
    // Note: sessionState.sessionId is already the NEW session by the time
    // handleLoadSessionStart runs (active-session-changed fires first), so
    // we capture the PREVIOUS session ID in showSessionConnected before
    // overwriting sessionState.
    let preLoadSnapshotSessionId = null;
    /**
     * Per-session history archive, keyed by session ID.
     *
     * The live snapshot (preLoadChatHistorySnapshot) only ever covers the
     * session that was on screen when the load started, so switching A → B → A
     * left A with no snapshot and no way to repair a lossy replay. That matters
     * because several agents drop assistant text on session/load: Kiro omits
     * every assistant record that carries no tool call (i.e. each end-of-turn
     * reply, plus its thinking), and Codex does not replay agent_message_chunk
     * at all. Without a snapshot for the session being loaded, the final reply
     * simply disappears from the restored transcript.
     *
     * In-memory only — it holds slices of chatHistory that are already in
     * memory, so it costs nothing extra, and it is bounded to the most recent
     * few sessions.
     */
    var SESSION_ARCHIVE_MAX_SESSIONS = 6;
    let sessionHistoryArchive = {};
    let sessionHistoryArchiveOrder = [];

    function archiveSessionHistory(sessionId, items) {
      if (!sessionId || !items || !items.length) return;
      if (!sessionHistoryArchive[sessionId]) {
        sessionHistoryArchiveOrder.push(sessionId);
      }
      sessionHistoryArchive[sessionId] = items.slice();
      while (sessionHistoryArchiveOrder.length > SESSION_ARCHIVE_MAX_SESSIONS) {
        var evicted = sessionHistoryArchiveOrder.shift();
        if (evicted !== sessionId) delete sessionHistoryArchive[evicted];
      }
    }
   let previousSessionId = null;
   // Tracks the session ID that the current chatHistory was built for.
   // Set in restoreState (from saved state) and in showSessionConnected
   // (when chatHistory is cleared/rebuilt for a new live session).
   // Used by handleLoadSessionStart to correctly label the snapshot:
   // when resuming after restart, previousSessionId is a temp session
   // from connectToAgent, but the chatHistory belongs to the session
   // being loaded (sessionState.sessionId). Without this, the merge
   // in handleLoadSessionEnd is skipped because the IDs don't match.
   let chatHistoryOriginSessionId = null;

    /**
     * Strip injected context blocks from user message text.
     * Uses string indexOf/slice instead of RegExp with backslash escapes
     * to avoid webpack mangling inside the HTML template literal.
     */
    function stripTag(text, tagName, replacement) {
      var openTag = '<' + tagName;
      var closeTag = '</' + tagName + '>';
      var result = '';
      var i = 0;
      while (i < text.length) {
        var start = text.indexOf(openTag, i);
        if (start === -1) {
          result += text.slice(i);
          break;
        }
        result += text.slice(i, start);
        var end = text.indexOf(closeTag, start);
        if (end === -1) {
          // No closing tag found — drop the unclosed tag and everything
          // after it (it's likely malformed context injection).
          break;
        }
        var block = text.slice(start, end + closeTag.length);
        if (replacement) {
          result += replacement(block);
        }
        i = end + closeTag.length;
        while (i < text.length) {
          var c = text.charCodeAt(i);
          if (c === 32 || c === 10 || c === 13 || c === 9) { i++; } else break;
        }
      }
      return result;
    }

    /**
     * True when a user message is nothing but injected machine context —
     * currently the shared-memory recall payload.
     *
     * Both render paths fall back to the RAW text when cleanUserMessage()
     * empties a message, so that a session/load prompt is never silently
     * dropped. For a recall-only message that fallback re-displayed the whole
     * <agent-memory> blob in the panel. Only complete (properly closed) blocks
     * count: an unterminated block may have swallowed real user text after it,
     * and in that case showing the raw message is still the lesser evil.
     */
    function isMachineContextOnly(rawText) {
      var raw = String(rawText || '');
      if (!raw.trim()) return true;
      var tags = ['agent-memory', 'relevant-memories', 'user-persona', 'relevant-scenes', 'scene-navigation', 'memory-tools-guide'];
      for (var i = 0; i < tags.length; i++) {
        var open = raw.indexOf('<' + tags[i]);
        if (open < 0) continue;
        var close = raw.indexOf('</' + tags[i] + '>', open);
        if (close > open) return true;
      }
      // A replayed chunk that is nothing but JSON-stringified resource_link
      // blocks is machine context too. session/load replays each stored
      // content block as its OWN user_message_chunk, so an attachment arrives
      // alone as {"name":...,"uri":...,"type":"resource_link"}. cleanUserMessage
      // strips it to empty — and then the raw-text fallback above put it
      // straight back, because this predicate did not recognise the shape. That
      // is why such links kept rendering after every resume.
      if (!stripLeadingResourceLinkJson(raw).trim()) return true;
      return false;
   }

   /**
    * Truncate a session title for display in the banner.
    * The full title is kept in sessionState.title for tooltips/persistence;
    * only the visible text is capped. CSS text-overflow:ellipsis handles
    * the visual cutoff, but pre-truncating avoids storing a huge string
    * in the DOM and keeps the tooltip readable.
    */
   function truncateForBanner(text, max) {
     max = max || 120;
     if (!text || text.length <= max) return text;
     // Try to break at a word boundary near the limit.
     var cut = text.lastIndexOf(' ', max);
     if (cut < max * 0.6) cut = max; // no good break point — hard cut
     return text.substring(0, cut) + '…';
   }

   /**
    * Clean a user message by stripping all injected context blocks
    * (<open_files>, <selection>, <terminal>, <problems>, <file>, <folder>).
    * Falls back to the original if the result is empty.
    */
   /**
    * Strip JSON-stringified resource_link blocks from the FRONT of a string:
    *   {"name":"...","uri":"file:///...","type":"resource_link"}
    * Kiro concatenates them with no separator ahead of the real user text.
    *
    * Called both before and after the <context> / <agent-memory> tag strips.
    * Running it only once up front missed the common case where the links sit
    * AFTER a memory or context block — the text then starts with '<', the scan
    * bailed on the first character, and the raw JSON survived into the bubble
    * on every session/load replay.
    *
    * The closing brace is found by trying each '}' in turn and keeping the
    * first that parses, because a link's "name" is arbitrary user-ish text and
    * may itself contain '}' (these names are often broken fragments such as
    * a lone backtick).
    */
   function stripLeadingResourceLinkJson(text) {
     var out = String(text || '');
     for (var guard = 0; guard < 200; guard++) {
       var start = 0;
       while (start < out.length) {
         var c = out.charCodeAt(start);
         if (c === 32 || c === 10 || c === 13 || c === 9) { start++; } else break;
       }
       if (out.charCodeAt(start) !== 123) return out; // 123 = opening brace
       var consumedTo = -1;
       var probe = out.indexOf('}', start);
       while (probe >= 0) {
         try {
           var parsed = JSON.parse(out.substring(start, probe + 1));
           if (parsed && parsed.type === 'resource_link' && typeof parsed.uri === 'string') {
             consumedTo = probe + 1;
           }
           // Parsed cleanly: this is the object boundary either way. A JSON
           // object that is NOT a resource_link must be left alone.
           break;
         } catch (e) {
           probe = out.indexOf('}', probe + 1);
         }
       }
       if (consumedTo < 0) return out;
       out = out.substring(consumedTo);
     }
     return out;
   }

 function cleanUserMessage(rawText) {
    var displayText = rawText;
    // Debug: log cleanUserMessage entry
    var _dbgPreview = rawText.length > 200 ? rawText.substring(0, 200) + '...' : rawText;
    vscode.postMessage({ type: 'debugLog', message: 'cleanUserMessage IN len=' + rawText.length + ' text="' + _dbgPreview + '"' });
    displayText = stripTag(displayText, 'open_files', null);
    displayText = stripTag(displayText, 'terminal', null);
    displayText = stripTag(displayText, 'problems', null);
    displayText = stripTag(displayText, 'file', null);
    displayText = stripTag(displayText, 'folder', null);
    displayText = stripTag(displayText, 'selection', function(block) {
       var pathMatch = block.match(/path="([^"]+)"/);
       var linesMatch = block.match(/lines="([^"]+)"/);
       if (pathMatch && linesMatch) {
         var lineStart = linesMatch[1].split('-')[0];
         return '[Selected code: ' + pathMatch[1] + ':' + lineStart + ']' + String.fromCharCode(10) + String.fromCharCode(10);
       }
       return '';
     });
   // Strip markdown-style context reference links that some agents (e.g.
   // Codex CLI) inline into the user message text during session/load
   // replay. These look like:
   //   [@Symbol](file:///absolute/path?symbol=Symbol#L123)
   //   [@settings.json](file:///path/to/settings.json)
   //   [@terminal](zed:///agent/terminal-selection?lines=42)
 // They are concatenated without separators before the real user text.
// Match any URI scheme, not just file:// — covers zed:// and others.
 // Strip <context ref="...">...</context> blocks that Codex inlines
 // before the real user text during session/load replay.
 // NOTE: Both strippers above use new RegExp with backslash escapes inside
 // the HTML template literal. This is fragile — webpack/template literal
 // double-processing can corrupt the regex, causing 'Unterminated group'
 // SyntaxError that crashes the entire webview. Replaced with string-based
 // stripping below.

 // Strip leading markdown-style context reference links:
   //   [@Symbol](file:///absolute/path?symbol=Symbol#L123)
   //   [@settings.json](file:///path/to/settings.json)
   //   [@terminal](zed:///agent/terminal-selection?lines=42)
   // These are concatenated before the real user text during session/load.
  while (true) {
    // Trim leading whitespace (manual to avoid regex in template literal)
    var start = 0;
    while (start < displayText.length) {
      var c = displayText.charCodeAt(start);
      if (c === 32 || c === 10 || c === 13 || c === 9) { start++; } else break;
    }
    var trimmed = displayText.substring(start);
    if (trimmed.charCodeAt(0) !== 91 /* '[' */) break;
    var closeBracket = trimmed.indexOf('](');
    if (closeBracket < 0) break;
    var closeParen = trimmed.indexOf(')', closeBracket + 2);
    if (closeParen < 0) break;
    // Check the URI part has a scheme: letters followed by ://
    var uriPart = trimmed.substring(closeBracket + 2, closeParen);
    var colonSlash = uriPart.indexOf('://');
    if (colonSlash < 1) break;
    // Verify scheme is all letters/digits/+/./-
    var validScheme = true;
    for (var si = 0; si < colonSlash; si++) {
      var sc = uriPart.charCodeAt(si);
      if (!((sc >= 97 && sc <= 122) || (sc >= 48 && sc <= 57) || sc === 43 || sc === 46 || sc === 45)) {
        validScheme = false;
        break;
      }
    }
    if (!validScheme) break;
    // Debug: log each stripped link
    vscode.postMessage({ type: 'debugLog', message: 'cleanUserMessage STRIP link uri="' + uriPart.substring(0, 80) + '"' });
    displayText = trimmed.substring(closeParen + 1);
  }
  // Debug: log result after link stripping
  var _dbgAfter = displayText.length > 200 ? displayText.substring(0, 200) + '...' : displayText;
  vscode.postMessage({ type: 'debugLog', message: 'cleanUserMessage AFTER-LINKS len=' + displayText.length + ' text="' + _dbgAfter + '"' });
// Strip leading JSON-stringified resource_link blocks (Kiro format):
   // {"name":"...","uri":"file:///...","type":"resource_link"}
   // These are concatenated without separators before the real user text.
   displayText = stripLeadingResourceLinkJson(displayText);
 // Strip leading <context ref="...">...</context> blocks
 displayText = stripTag(displayText, 'context', null);
 // Strip the shared-memory recall blob. SharedMemoryProvider prepends it to
 // the prompt (as a resource, or as plain text for agents without embedded
 // context), so session/load replay hands it back as part of the user
 // message. It is machine context, never something the user typed.
 displayText = stripTag(displayText, 'agent-memory', null);
 // Older / partial recall payloads arrive without the <agent-memory> wrapper.
 displayText = stripTag(displayText, 'relevant-memories', null);
 displayText = stripTag(displayText, 'user-persona', null);
 displayText = stripTag(displayText, 'relevant-scenes', null);
 displayText = stripTag(displayText, 'scene-navigation', null);
 displayText = stripTag(displayText, 'memory-tools-guide', null);
 // Second pass: the tag strips above may have UNCOVERED resource_link JSON
 // that was sitting behind a <context> / <agent-memory> block. That is the
 // usual layout — memory blob first, then the links, then the typed text — so
 // without this the raw {"name":"...","type":"resource_link"} objects leaked
 // into the bubble on every session/load replay.
 displayText = stripLeadingResourceLinkJson(displayText);
 // Cursor Agent inlines open-file / resource attachments into the user
 // message text during session/load as a trailing "Additional ACP context:"
 // block (followed by "[ACP resource_link] ..." dumps). Keep only the real
 // user text. (Do NOT put backslash-n in this comment — template literal.)
 var acpCtxMarker = 'Additional ACP context:';
 var acpCtxIdx = displayText.indexOf(acpCtxMarker);
 if (acpCtxIdx >= 0) {
   var acpCut = acpCtxIdx;
   while (acpCut > 0) {
     var ac = displayText.charCodeAt(acpCut - 1);
     if (ac === 32 || ac === 10 || ac === 13 || ac === 9) { acpCut--; } else break;
   }
   displayText = displayText.substring(0, acpCut);
 }
 // Strip bare zed:/// URIs that appear without a [@...] wrapper
 // (e.g. "zed:///agent/terminal-selection?lines=243")
 // Use string-based stripping to avoid regex backslash mangling inside
 // the HTML template literal (webpack double-processing causes SyntaxError).
 var zedProto = 'zed:///';
 var zedIdx = displayText.indexOf(zedProto);
 while (zedIdx !== -1) {
   var zedEnd = zedIdx + zedProto.length;
   while (zedEnd < displayText.length) {
     var zc = displayText.charCodeAt(zedEnd);
     if (zc === 32 || zc === 10 || zc === 13 || zc === 9) break;
     zedEnd++;
   }
   displayText = displayText.slice(0, zedIdx) + displayText.slice(zedEnd);
   zedIdx = displayText.indexOf(zedProto);
 }
 // Strip bare vscode-acp:///memory/<agentId> URIs that the agent flattens
 // back into the user message during session/load replay. The shared-memory
 // recall is injected as a resource at vscode-acp:///memory/<id>; agents
 // without embeddedContext support often echo it as a plain leading line:
 //   vscode-acp:///memory/codex
 //   <context ref="vscode-acp:///memory/codex">…</context><actual prompt>
 // cleanUserMessage strips the <context>/<agent-memory> tags above, which
 // leaves the bare URI line behind. Remove it too — it is machine context,
 // never text the user typed. String-based to avoid regex mangling inside
 // the HTML template literal (webpack double-processing).
 var memUriProto = 'vscode-acp:///memory/';
 var memUriIdx = displayText.indexOf(memUriProto);
 while (memUriIdx !== -1) {
   var memUriStart = memUriIdx;
   // Walk back over whitespace so a URI at the start of a paragraph (or any
   // earlier in the text) is removed with its trailing space/newline.
   while (memUriStart > 0) {
     var mbc = displayText.charCodeAt(memUriStart - 1);
     if (mbc === 32 || mbc === 10 || mbc === 13 || mbc === 9) {
       memUriStart--;
     } else {
       break;
     }
   }
   var memUriEnd = memUriIdx + memUriProto.length;
   while (memUriEnd < displayText.length) {
     var mec = displayText.charCodeAt(memUriEnd);
     // URI id is [A-Za-z0-9_-] (encodeURIComponent output, no '/' in the id
     // itself). Stop at the trailing whitespace / punctuation / closing tag.
     if (mec === 32 || mec === 10 || mec === 13 || mec === 9 ||
         mec === 60 /* '<' */ || mec === 41 /* ')' */ || mec === 44 /* ',' */) {
       break;
     }
     memUriEnd++;
   }
   displayText = displayText.slice(0, memUriStart) + displayText.slice(memUriEnd);
   memUriIdx = displayText.indexOf(memUriProto);
 }
 // Strip any remaining leading whitespace after stripping
 var leadEnd = 0;
 while (leadEnd < displayText.length) {
   var lc = displayText.charCodeAt(leadEnd);
   if (lc === 32 || lc === 10 || lc === 13 || lc === 9) { leadEnd++; } else break;
 }
 if (leadEnd > 0) displayText = displayText.slice(leadEnd);
var end = displayText.length;
      while (end > 0) {
        var ch = displayText.charCodeAt(end - 1);
        if (ch === 32 || ch === 10 || ch === 13 || ch === 9) { end--; } else break;
      }
      displayText = displayText.slice(0, end);
      // Only fall back to raw text if the original had NO context links/tags
      // to strip. If we stripped everything (e.g. a chunk that was purely
      // [@file](file:///...) links), return empty string so the coalescing
      // logic in user_message_chunk can skip it instead of appending raw
      // context links to the user message.
      if (displayText.trim() === '' && rawText.trim() !== '') {
        // Check if rawText contained any context-style content
        var hadContext = rawText.indexOf('[@') >= 0
          || rawText.indexOf('<open_files') >= 0
          || rawText.indexOf('<selection') >= 0
          || rawText.indexOf('<terminal') >= 0
          || rawText.indexOf('<problems') >= 0
          || rawText.indexOf('<file') >= 0
          || rawText.indexOf('<folder') >= 0
          || rawText.indexOf('<context') >= 0
          || rawText.indexOf('<agent-memory') >= 0
          || rawText.indexOf('<relevant-memories') >= 0
          || rawText.indexOf('<user-persona') >= 0
          || rawText.indexOf('zed:///') >= 0
          || rawText.indexOf('"type":"resource_link"') >= 0
          || rawText.indexOf('Additional ACP context:') >= 0
          || rawText.indexOf('[ACP resource_link]') >= 0;
        if (hadContext) {
          return '';
        }
       displayText = rawText;
     }
     // Debug: log final result
     var _dbgFinal = displayText.length > 200 ? displayText.substring(0, 200) + '...' : displayText;
     vscode.postMessage({ type: 'debugLog', message: 'cleanUserMessage OUT len=' + displayText.length + ' text="' + _dbgFinal + '"' });
     return displayText;
   }

    /**
     * Render a one-line context pill for any ACP resource URI:
     *   - "file:///abs/foo.ts#L5:9"             -> "[Selected code: foo.ts:5-9]"
     *   - "file:///abs/foo.ts"                  -> "[File: foo.ts]"
     *   - "file:///abs/dir/"                    -> "[Directory: dir/]"
     *   - "zed:///agent/terminal-selection?lines=N" -> "[Terminal: N lines]"
     *   - "zed:///agent/diagnostics"            -> "[Problems]"
     * Returns '' if the URI is empty (no fallbackName).
     */
    function formatResourcePill(uri, fallbackName) {
      if (!uri && !fallbackName) { return ''; }
      var u = null;
      try { u = uri ? new URL(uri) : null; } catch (e) { /* keep null */ }
      var nl2 = String.fromCharCode(10) + String.fromCharCode(10);

      // Zed-style synthetic URIs.
      if (u && u.protocol === 'zed:') {
        if (u.pathname.indexOf('/agent/terminal-selection') === 0) {
          var lines = u.searchParams.get('lines') || '?';
          return '[Terminal: ' + lines + ' lines]' + nl2;
        }
        if (u.pathname.indexOf('/agent/diagnostics') === 0) {
          return '[Problems]' + nl2;
        }
        return '[' + (fallbackName || uri) + ']' + nl2;
      }

      // Shared-memory recall (Model B). The extension injects it as a
      // resource block at vscode-acp:///memory/<agentId> before the user
      // prompt. It is machine context, not a file — render it as a compact
      // "Memory context" pill instead of a misleading [File: <agentId>].
      if (u && u.protocol === 'vscode-acp:' && u.pathname.indexOf('/memory/') === 0) {
        return '[Memory context]' + nl2;
      }

      // Parse "#L<start>(:<end>)?" range fragment if present.
      var lineLabel = '';
      var fragMatch = uri && uri.match(/#L(\\d+)(?::(\\d+))?/);
      if (fragMatch) {
        lineLabel = fragMatch[2] && fragMatch[2] !== fragMatch[1]
          ? fragMatch[1] + '-' + fragMatch[2]
          : fragMatch[1];
      }

      // Compute display name from URI path or fallback.
      var pathPart = uri ? uri.split('#')[0] : '';
      var name = fallbackName;
      if (!name && u) {
        var pathname = u.pathname.replace(/\\/+$/, '');
        name = pathname.substring(pathname.lastIndexOf('/') + 1) || pathname || pathPart;
        try { name = decodeURIComponent(name); } catch (e) { /* keep raw */ }
      }
      if (!name) { name = pathPart || uri || ''; }

      // Trailing slash on the original URI path => directory mention.
      var isDirectory = u && /\\/$/.test(u.pathname);

      if (lineLabel) {
        return '[Selected code: ' + name + ':' + lineLabel + ']' + nl2;
      }
      if (isDirectory) {
        var dirName = name.replace(/\\/+$/, '');
        return '[Directory: ' + dirName + '/]' + nl2;
      }
      return '[File: ' + name + ']' + nl2;
    }

    /**
     * Persist current panel state to vscode.setState(). Caps the persisted
     * chatHistory at PERSISTED_HISTORY_MAX entries to keep the in-extension-
     * host snapshot bounded — VS Code holds this object in memory until the
     * panel is disposed. The in-memory chatHistory keeps growing for the
     * live panel; only the persistence snapshot is trimmed.
     */
   var PERSISTED_HISTORY_MAX = 500;
  function saveState() {
   var capped = (chatHistory.length > PERSISTED_HISTORY_MAX
     ? chatHistory.slice(chatHistory.length - PERSISTED_HISTORY_MAX)
    : chatHistory).map(function(item) {
      if (item && item.kind === 'toolCall' && item.rawInput) {
        // Strip taskResult before persisting — it contains raw markdown
        // from Kiro subagent summaries that is redundant with the main
        // agent's rendered output and bloats saved state.
        if (item.rawInput.taskResult) {
          item = Object.assign({}, item, { rawInput: stripTaskResult(item.rawInput) });
        }
        // Cap rawInput to 10KB so tooltips work on restored history
        // without bloating vscode.getState() excessively. For Kiro crew
        // spawns, always keep a slim stages[] so "spawned N subagents"
        // survives VS Code restart (full prompts can be huge).
        var rawStr = typeof item.rawInput === 'string'
          ? item.rawInput
          : (function() { try { return JSON.stringify(item.rawInput); } catch(e) { return ''; } })();
         if (rawStr.length > 10240) {
           var copy = Object.assign({}, item);
           if (item.rawInput && typeof item.rawInput === 'object' &&
               Array.isArray(item.rawInput.stages) && item.rawInput.stages.length > 0) {
             copy.rawInput = slimSubagentRawInput(item.rawInput);
           } else {
             copy.rawInput = rawStr.slice(0, 10240);
           }
           return copy;
         }
         return item;
       }
       return item;
     });
  vscode.setState({
    chatHistory: capped,
    sessionState,
    hasActiveSession,
    lastConnectedAgent,
    lastConnectedAgentDisplay,
    lastConnectedSessionId,
    interruptedSessionIds: interruptedSessionIds,
  });
  // Debug: log saveState (only user messages)
  for (var _si = 0; _si < capped.length; _si++) {
    if (capped[_si] && capped[_si].kind === 'message' && capped[_si].role === 'user') {
      var _dbgSaved = typeof capped[_si].text === 'string' ? (capped[_si].text.length > 100 ? capped[_si].text.substring(0, 100) + '...' : capped[_si].text) : '(non-string)';
      vscode.postMessage({ type: 'debugLog', message: 'saveState user[' + _si + '] len=' + (typeof capped[_si].text === 'string' ? capped[_si].text.length : -1) + ' text="' + _dbgSaved + '"' });
    }
  }
}

  function restoreState() {
    const saved = vscode.getState();
    if (!saved) return;
    // Debug: log restoreState entry
    vscode.postMessage({ type: 'debugLog', message: 'restoreState START: saved.chatHistory.length=' + (saved.chatHistory ? saved.chatHistory.length : 0) });
   // Restore the last connected agent so the welcome button can offer
   // "Resume <agent>" even after showNoSession cleared sessionState.
   // Only restore if there is chat history — on a new project with no
   // sessions, the saved lastConnectedAgent may be stale (seeded from
   // global on-disk sessions in older versions). The extension host's
   // 'state' message will set the correct value shortly.
   if (saved.chatHistory && saved.chatHistory.length > 0) {
     lastConnectedAgent = saved.lastConnectedAgent || null;
     lastConnectedAgentDisplay = saved.lastConnectedAgentDisplay || null;
     lastConnectedSessionId = saved.lastConnectedSessionId || null;
   }
   interruptedSessionIds = (saved.interruptedSessionIds && typeof saved.interruptedSessionIds === 'object')
      ? saved.interruptedSessionIds
      : {};
    updateWelcomeButton();

    // Clean user messages so restored state does not show raw
     // <open_files>/<selection>/etc. blocks from before the fix.
     var rawHistory = saved.chatHistory || [];
     chatHistory = [];
     for (var ri = 0; ri < rawHistory.length; ri++) {
       var riItem = rawHistory[ri];
       // Debug: log each restored item
       if (riItem && riItem.kind === 'message' && riItem.role === 'user') {
         var _dbgRaw = typeof riItem.text === 'string' ? (riItem.text.length > 100 ? riItem.text.substring(0, 100) + '...' : riItem.text) : '(non-string)';
         vscode.postMessage({ type: 'debugLog', message: 'restoreState item[' + ri + '] user textLen=' + (typeof riItem.text === 'string' ? riItem.text.length : -1) + ' text="' + _dbgRaw + '"' });
       }
      // Skip error messages on restore -- they are transient and
      // should not persist across reloads (e.g. "Failed to load session
      // history" from a stale session that has since been resolved).
       if (riItem && riItem.kind === 'message' && riItem.role === 'error') {
         continue;
       }
       // Skip plan entries on restore — the plan is turn-scoped and
       // LLM-managed.  It should not reappear after a VS Code restart.
       if (riItem && riItem.kind === 'plan') {
         continue;
       }
       // Skip interrupt notices on restore — a "— Conversation interrupted —"
       // (system role, added by addMessage at promptEnd) or "[Request
       // interrupted by user]" (user role, recorded by Claude/adapters) is a
       // transient turn-scoped event. Persisting it means it re-renders in
       // the MIDDLE of the chat after a session resume, looking like a stray
       // marker. The promptStart handler also strips these on the next prompt;
       // filtering here ensures a resumed session never shows one at all.
       if (riItem && riItem.kind === 'message' &&
           (riItem.role === 'system' || riItem.role === 'user') &&
           isSessionInterruptNotice(riItem.text)) {
         continue;
       }
       // Clean user messages so restored state does not show raw
        // <open_files>/<selection>/etc. blocks from before the fix.
        if (riItem && riItem.kind === 'message' && riItem.role === 'user' && typeof riItem.text === 'string') {
          riItem = { kind: 'message', role: 'user', text: cleanUserMessage(riItem.text) };
        }
       // Sync in-progress tool calls to a terminal status.
       // When a session is closed abruptly, in_progress/running tool calls
       // will never receive a completion update. However, Codex often only
       // sends tool_call with 'in_progress' and never sends tool_call_update
       // with 'completed' — the completion is implicit in promptEnd.
       // So: if there is an assistant message AFTER this tool call (the turn
       // finished), mark it 'completed'. Only force 'failed' when the turn
       // was truly interrupted (no assistant message follows).
       if (riItem && riItem.kind === 'toolCall' && (riItem.status === 'in_progress' || riItem.status === 'running' || riItem.status === 'pending')) {
         var _hasFollowingAssistant = false;
         for (var _fa = ri + 1; _fa < rawHistory.length; _fa++) {
           var _faItem = rawHistory[_fa];
           if (_faItem && _faItem.kind === 'message' && _faItem.role === 'assistant' && !(_faItem.interrupted)) {
             _hasFollowingAssistant = true;
             break;
           }
           // A new user message means the turn ended — tools before it completed.
           if (_faItem && _faItem.kind === 'message' && _faItem.role === 'user' && !isSessionInterruptNotice(_faItem.text)) {
             _hasFollowingAssistant = true;
             break;
           }
         }
         riItem = { ...riItem, status: _hasFollowingAssistant ? 'completed' : 'failed' };
       }
      // Drop Kiro Summarizing/summary tool rows — redundant with the main
      // agent_message summary and used to reappear as a wrapped tool block.
      if (riItem && riItem.kind === 'toolCall' && isKiroSummaryToolTitle(riItem.title)) {
        continue;
      }
      // Deduplicate consecutive thought entries where a later one is a
      // superset of an earlier one (resume artifact: the merge logic used
      // to push a new entry with old+new text instead of updating the old one).
      if (riItem && riItem.kind === 'thought' && chatHistory.length > 0) {
        var _prevThought = chatHistory[chatHistory.length - 1];
        if (_prevThought && _prevThought.kind === 'thought' &&
            typeof riItem.text === 'string' && typeof _prevThought.text === 'string' &&
            riItem.text.startsWith(_prevThought.text)) {
          // Replace the previous entry with the merged (longer) text.
          _prevThought.text = riItem.text;
          if (riItem.durationSec) _prevThought.durationSec = riItem.durationSec;
          continue;
        }
      }
      // Kiro crew stages: only fail explicitly in-flight statuses. Missing
       // status on a completed parent is a finished historical crew — keep
       // completed so the final summary stays outside the fold after restart.
       if (riItem && riItem.kind === 'toolCall' && riItem.rawInput &&
           Array.isArray(riItem.rawInput.stages) && riItem.rawInput.stages.length > 0) {
         var _parentDone = riItem.status === 'completed';
         var _rstStages = riItem.rawInput.stages.map(function(st) {
           if (!st || typeof st !== 'object') return st;
           var ss = st.status;
           if (ss === 'completed' || ss === 'done' || ss === 'success' || ss === 'terminated' ||
               ss === 'failed' || ss === 'error') {
             return st;
           }
           if (ss === 'running' || ss === 'in_progress' || ss === 'pending' || ss === 'working') {
             return Object.assign({}, st, { status: 'failed' });
           }
           return Object.assign({}, st, { status: _parentDone ? 'completed' : 'failed' });
         });
         var _rstFailed = _rstStages.some(function(st) {
           return st && (st.status === 'failed' || st.status === 'error');
         });
         riItem = Object.assign({}, riItem, {
           rawInput: Object.assign({}, riItem.rawInput, { stages: _rstStages }),
           status: _rstFailed ? 'failed' : riItem.status,
         });
       }
       // Strip taskResult from restored tool calls — it contains raw
       // markdown from Kiro subagent summaries that duplicates the main
       // agent's rendered output. Old saved state may still have it.
       if (riItem && riItem.kind === 'toolCall' && riItem.rawInput && riItem.rawInput.taskResult) {
         riItem = { ...riItem, rawInput: stripTaskResult(riItem.rawInput) };
       }
       // Older builds truncated huge rawInput to a JSON string — parse back
       // so stages[] is available for "spawned N subagents" after restart.
       if (riItem && riItem.kind === 'toolCall' && typeof riItem.rawInput === 'string') {
         var parsedRaw = null;
         try { parsedRaw = JSON.parse(riItem.rawInput); } catch (e) { parsedRaw = null; }
         if (parsedRaw && typeof parsedRaw === 'object') {
           riItem = { ...riItem, rawInput: parsedRaw };
         }
       }
       chatHistory.push(riItem);
     }
    saveState();
   sessionState = saved.sessionState || null;
   // The restored chatHistory belongs to the saved session.
   chatHistoryOriginSessionId = (sessionState && sessionState.sessionId) || null;
   // Clean title from saved state — it may contain raw context links
   // from a previous version that didn't clean at the source.
    if (sessionState && sessionState.title) {
      sessionState.title = cleanUserMessage(sessionState.title) || undefined;
    }
    hasActiveSession = saved.hasActiveSession || false;
     // Remember the last agent for auto-reconnect on "Connect to Agent" click.
   if (sessionState && sessionState.agentName) {
     lastConnectedAgent = sessionState.agentConfigKey || sessionState.agentName;
     lastConnectedAgentDisplay = sessionState.agentName;
     lastConnectedSessionId = sessionState.sessionId || null;
   }
   updateWelcomeButton();

    if (hasActiveSession && sessionState) {
     showSessionConnectedFromState(sessionState);
   }

   // Only render chat history on restore if the session was NOT interrupted.
   // If the session was interrupted (turn was in-progress when VS Code closed),
   // skip rendering — the session/load flow will either replay the full history
   // (if the session exists on the agent side) or clear it (if not found).
   // Rendering the stale partial state first causes a flash of "Conversation
   // interrupted" + unfinished tool calls that disappears after load.
   var _skipRestoreRender = sessionMarkedInterrupted();
   if (_skipRestoreRender) {
     vscode.postMessage({ type: 'debugLog', message: 'restoreState: skipping render — session was interrupted, waiting for session/load' });
   }
   if (!_skipRestoreRender) {
     // Render chat history using compact turn-based inline layout
     // (groups tool calls into collapsible containers instead of standalone cards)
     reconcileInterruptedSessionFlag(false);
     failInterruptedSpawnToolsInHistory();
     failInterruptedSubagentStagesInHistory();
     foldInterruptedAssistantsOnPromote = true;
     var assistantItems = renderChatHistory();
     foldInterruptedAssistantsOnPromote = false;
     failRunningSubagentStagesInDom();
     failCompletedCrewsInInterruptedTurn();
     forceCollapseTurnFolds();
     failRunningSubagentStagesInDom();
     failCompletedCrewsInInterruptedTurn();
     if (assistantItems.length > 0) {
        vscode.postMessage({ type: 'debugLog', message: 'restoreState: sending renderMarkdown for ' + assistantItems.length + ' assistant items' });
        vscode.postMessage({ type: 'renderMarkdown', items: assistantItems });
        vscode.postMessage({ type: 'debugLog', message: 'restoreState: renderMarkdown sent' });
        // Retry mechanism: if the extension host doesn't respond within 2s,
        // re-send the renderMarkdown request. This handles a race condition
        // where the initial postMessage is lost during webview initialization.
       var _retryItems = assistantItems.slice();
       var _retryCount = 0;
      var _retryKey = 'restore_' + Date.now();
      pendingRenderRetries[_retryKey] = true;
     var _retryFn = function() {
       if (pendingRenderRetries[_retryKey] && _retryCount < 3) {
         _retryCount++;
         vscode.postMessage({ type: 'debugLog', message: 'restoreState: RETRY ' + _retryCount + ' sending renderMarkdown for ' + _retryItems.length + ' items' });
         vscode.postMessage({ type: 'renderMarkdown', items: _retryItems });
         setTimeout(_retryFn, 2000);
       }
     };
     setTimeout(_retryFn, 2000);
     }
   } else {
     // Still reconcile interrupt flags so the state is clean for session/load.
     reconcileInterruptedSessionFlag(false);
     failInterruptedSpawnToolsInHistory();
     failInterruptedSubagentStagesInHistory();
   }

  // If there's chat history but no active session, show a prominent
    // resume button in the fixed resume bar (always visible, no scroll needed).
    updateResumeBar();
   // Defer until renderChatHistory DOM is committed (same race as loadSessionEnd).
   setTimeout(function() {
     vscode.postMessage({ type: 'debugLog', message: '[WV-DIAG] post-restore cursor tool enrich request' });
     requestCursorToolEnrichIfNeeded('post-restore');
   }, 50);

   // Start with input disabled
   }

   // Start with input disabled
   if (inputArea) inputArea.classList.add('disabled');
    let currentAssistantEl = null;
    let currentAssistantText = '';
    // ACP messageId (ContentChunk.messageId) groups chunks into one logical
    // message. When a tool call splits the streaming text (commitCurrentTextSegment
    // nulls currentAssistantEl), we remember the committed segment messageId +
    // element + text so a later chunk with the SAME messageId can REATTACH to it
    // instead of starting a new bubble — this is what keeps text-tool-text as ONE
    // continuous assistant message instead of separate bubbles.
    let currentMessageId = null;          // messageId of the in-flight bubble
    let lastCommittedAssistantEl = null;  // last bubble committed by a tool-call split
    let lastCommittedMessageId = null;    // its messageId
    let lastCommittedText = '';           // its text (to resume appending)
    // Synthetic per-turn messageId for agents that never emit one (legacy
    // Kiro CLI, older codex builds). kiro-cli streams agent_message_chunk
    // without messageId, so every sentence lands as its OWN bubble
    // (hasCurrentAssistantEl=false on every chunk). Assigning a stable
    // per-turn id lets vscode-acp group the whole turn into one bubble and
    // reattach text after a tool-call split (text→tool→text), same as agents
    // that send a real messageId. Reset to a fresh value at each promptStart.
    let fallbackMessageId = 'turn-' + (Date.now().toString(36)) + '-' + (Math.random().toString(36).slice(2, 8));
    // Counter for per-segment fallback messageIds (agents without real messageId).
    // Each post-tool-call text block gets a unique fallback so it creates a NEW
    // bubble instead of reattaching to (and concatenating with) the prior one.
    let messageSegmentCounter = 0;
    // Set true as soon as a chunk carrying a REAL (agent-provided) messageId
    // arrives in this turn. While true we trust the agent's ids and never
    // synthesise; agents that mix none+real ids fall back to real only.
    let sawRealMessageIdThisTurn = false;
    // When a reactivated bubble is committed again, update this chatHistory
    // entry in place instead of pushing a new one (avoids duplicate entries +
    // index drift from splicing). -1 = not reactivated (normal push).
    let reactivatedHistoryIndex = -1;
    let currentTurnEl = null;       // .turn container for current response
    let currentToolsListEl = null;  // .turn-tools-list inside current turn
    let currentToolsCountEl = null; // .turn-tools-summary counter
    let currentToolCount = 0;
    // Maximum tool rows in a single .turn-tools-list before ensureTurnTools
    // starts a fresh group. Guards against an agent that emits a long run of
    // consecutive tool calls with no assistant text between them (seen on
    // session/load replay), which otherwise builds one unbounded list.
    const TOOL_GROUP_MAX_ROWS = 50;
    currentPsEl = null;
    if (psPanel) psPanel.style.display = 'none';
    let toolCalls = {};
    // Tool rows from turns that have already ended, keyed by wire id.
    //
    // Agents may restart their tool-call numbering each turn — codex minted
    // tc-1..tc-8 for a turn and opened the NEXT turn at tc-1 again (traffic log
    // 06:25:51). toolCalls was never cleared between turns, and DOM ids are
    // 'tc-' + wireId, so the new turn's tc-1 resolved to the PREVIOUS turn's
    // element: after a Send Now interrupt the old tool result and the old
    // assistant text reappeared under the new prompt. Retiring at the turn
    // boundary makes a repeated id unambiguous, while keeping late updates from
    // the finished turn pointed at their original row.
    let retiredToolCalls = {};
    // Mirrors acp.autoSteerQueuedMessages (default on). The host sends the real
    // value with the state message; until then assume on, matching the setting.
    let autoSteerQueuedEnabled = true;
    let toolIdRetireGen = 0;
    let toolCallDiffs = {};

   // --- /ps panel minimum display timer ---
   // When /ps is shown, keep it visible for at least 3 seconds even if a
   // quick turn (tool call, assistant text) arrives immediately.
   let psMinDisplayUntil = 0;
   let psHideTimer = null;
   /**
    * Dismiss the /ps panel. If force=false (default), respects the minimum
    * display window — if we are still within it, schedules a deferred hide
    * instead of hiding immediately. Use force=true for full DOM resets
    * (session load, clearChat).
    */
   function dismissPsPanel(force) {
     if (!currentPsEl && (!psPanel || psPanel.style.display === "none")) return;
     if (!force && psMinDisplayUntil > 0 && Date.now() < psMinDisplayUntil) {
       if (psHideTimer) clearTimeout(psHideTimer);
       var remaining = psMinDisplayUntil - Date.now();
       psHideTimer = setTimeout(function() {
         psHideTimer = null;
         psMinDisplayUntil = 0;
         currentPsEl = null;
         if (psPanel) psPanel.style.display = "none";
       }, remaining);
       return;
     }
     if (psHideTimer) { clearTimeout(psHideTimer); psHideTimer = null; }
     psMinDisplayUntil = 0;
     currentPsEl = null;
     if (psPanel) psPanel.style.display = "none";
   }

   /**
    * Re-render the /ps panel from the CURRENT chatHistory state if it is
    * visible. The /ps panel is a snapshot taken at /ps-invocation time —
    * without this, it keeps showing processes as "running" long after they
    * completed/failed (only cleared on the next turn's drainQueue, which
    * under rate-limiting can be a long time). Called from promptEnd (after
    * the in-flight tool status sync) and from updateToolCall (when a listed
    * tool transitions to a terminal status).
    *
    * If no tool calls remain running, dismisses the panel (respecting the
    * min-display window). Otherwise re-renders the running list in place so
    * the user sees the live set without re-typing /ps.
    */
   function refreshPsPanelIfVisible() {
     if (!psPanel || psPanel.style.display === 'none') return;
     var running = [];
     for (var ri = 0; ri < chatHistory.length; ri++) {
       var rItem = chatHistory[ri];
       if (rItem && rItem.kind === 'toolCall' &&
           (rItem.status === 'in_progress' || rItem.status === 'running' || rItem.status === 'pending')) {
         running.push(rItem);
       }
     }
     if (running.length === 0) {
       // Nothing left running — dismiss (respect min-display window).
       dismissPsPanel(false);
       return;
     }
     // Re-render the running list in place. Preserve the /ps command header
     // styling; only the item list changes.
     var bullet = String.fromCharCode(8226);
     psPanel.innerHTML = '';
     var cmdLine = document.createElement('div');
     cmdLine.className = 'ps-cmd';
     cmdLine.textContent = '/ps';
     psPanel.appendChild(cmdLine);
     var header = document.createElement('div');
     header.className = 'ps-header';
     header.textContent = 'Background terminals';
     psPanel.appendChild(header);
     for (var bi = 0; bi < running.length; bi++) {
       var item = document.createElement('div');
       item.className = 'ps-item';
       var cmd = running[bi].title || running[bi].toolCallId || '(unknown)';
       item.textContent = bullet + ' ' + cmd;
       psPanel.appendChild(item);
     }
     currentPsEl = psPanel;
   }

    // --- Resize handle ---
    let inputAreaHeight = 140;
    const MIN_INPUT_HEIGHT = 90;
    const MAX_INPUT_HEIGHT = 400;

    function applyInputHeight(h) {
      inputAreaHeight = Math.max(MIN_INPUT_HEIGHT, Math.min(MAX_INPUT_HEIGHT, h));
      inputArea.style.height = inputAreaHeight + 'px';
    }

    resizeHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const startHeight = inputArea.offsetHeight;
      function onMove(ev) {
        const delta = startY - ev.clientY;
        applyInputHeight(startHeight + delta);
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    // --- Auto-resize textarea (within the input area constraints) ---
   // TEMP-DEBUG (cannot-send investigation): always-on probe, forwarded to the
   // ACP Client log unconditionally by the extension host.
   function wvProbe(tag, detail) {
     vscode.postMessage({
       type: 'debugLog',
       message: '[WV-PROBE] ' + tag + ' isProcessing=' + isProcessing +
         ' isSendingPrompt=' + isSendingPrompt +
         ' isCompacting=' + isCompacting +
         ' isClearing=' + isClearing +
         ' hasActiveSession=' + hasActiveSession +
         ' hasSentPrompt=' + hasSentPrompt +
         ' messageQueue.length=' + (typeof messageQueue === 'undefined' ? '?' : messageQueue.length) +
         ' isLoadingSession=' + isLoadingSession +
         (detail ? ' | ' + detail : ''),
     });
   }
   function updateSendButton() {
     if (isProcessing) return; // Stop button is always enabled
     const hasText = promptInput.value.trim().length > 0;
     sendStopBtn.disabled = !hasText || !hasActiveSession;
     wvProbe('updateSendButton', 'hasText=' + hasText + ' disabled=' + sendStopBtn.disabled + ' btnText=' + sendStopBtn.textContent);
   }

    promptInput.addEventListener('input', () => {
    // @mention autocomplete
    const text = promptInput.value;
    updateSendButton();
    const atMatch = text.match(/@(\\w*)$/);
    if (atMatch) {
        const query = atMatch[1].toLowerCase();
      const mentions = [
        { name: 'terminal', description: 'Attach last terminal output' },
        { name: 'file', description: 'Attach a file' },
        { name: 'folder', description: 'Attach folder listing' },
       { name: 'problems', description: 'Attach workspace diagnostics' },
     ];
        // Dedupe by name in case a future merge path injects duplicates.
        var seenMention = {};
        const filtered = mentions.filter(function(m) {
          if (!m.name.startsWith(query)) return false;
          if (seenMention[m.name]) return false;
          seenMention[m.name] = true;
          return true;
        });
        if (filtered.length > 0) {
          slashFilteredCommands = filtered;
          slashPopup.innerHTML = '<div class="slash-popup-header">Context</div>';
          filtered.forEach((cmd, i) => {
            const item = document.createElement('div');
            item.className = 'slash-popup-item' + (i === 0 ? ' active' : '');
            item.dataset.index = String(i);
            item.innerHTML =
              '<span class="cmd-name">@' + escapeHtml(cmd.name) + '</span>' +
              '<span class="cmd-desc">' + escapeHtml(cmd.description) + '</span>';
            item.addEventListener('click', () => selectSlashCommand(cmd));
            item.addEventListener('mouseenter', () => { slashPopupSelectedIdx = i; highlightSlashItem(i); });
            slashPopup.appendChild(item);
          });
          slashPopup.classList.add('open');
          slashPopupSelectedIdx = 0;
          highlightSlashItem(0);
        } else {
          slashPopup.classList.remove('open');
        }
      } else
  // Slash command autocomplete
  if (text.startsWith('/')) {
     const firstSpace = text.indexOf(' ');
     const query = (firstSpace > 0 ? text.slice(1, firstSpace) : text.slice(1)).toLowerCase();
     if (firstSpace < 0) {
       // Still typing command name — show filtered popup
        slashFilteredCommands = getMergedCommands().filter(c =>
         c.name.toLowerCase().startsWith(query)
       );
        if (slashFilteredCommands.length > 0) {
          renderSlashPopup(slashFilteredCommands);
          slashPopup.classList.add('open');
          slashPopupSelectedIdx = 0;
          highlightSlashItem(0);
        } else {
          slashPopup.classList.remove('open');
        }
      } else if (query === 'session' || (firstSpace > 0 && text.slice(1, firstSpace) === 'session')) {
        // /session <partial> — autocomplete session names
        isSessionAutocomplete = true;
        if (!sessionNamesRequested) {
          sessionNamesRequested = true;
          vscode.postMessage({ type: 'getSessionNames' });
        }
        // Extract the partial name after "/session "
        var afterSession = text.substring(firstSpace + 1);
        var secondSpace = afterSession.indexOf(' ');
        var partial = secondSpace >= 0 ? afterSession.substring(0, secondSpace) : afterSession;
        // Filter session names by partial match (case-insensitive)
        sessionAutocompleteFiltered = sessionNames.filter(function(n) {
          return n.toLowerCase().indexOf(partial.toLowerCase()) >= 0;
        });
        if (sessionAutocompleteFiltered.length > 0 && secondSpace < 0) {
          renderSessionAutocomplete(sessionAutocompleteFiltered);
          slashPopup.classList.add('open');
          sessionAutocompleteSelectedIdx = 0;
          var items = slashPopup.querySelectorAll('.slash-popup-item');
          items.forEach(function(el, i) { el.classList.toggle('active', i === 0); });
        } else {
          slashPopup.classList.remove('open');
          isSessionAutocomplete = false;
        }
     } else if (firstSpace > 0 && query === 'goal') {
       // /goal <partial> — autocomplete subcommands (clear, pause, resume)
       var goalPartial = text.substring(firstSpace + 1).toLowerCase().trim();
       if (goalPartial === '' || goalSubcommands.some(function(sc) { return sc.name.startsWith(goalPartial); })) {
         isGoalSubcommandAutocomplete = true;
         isSessionAutocomplete = false;
         goalSubcommandFiltered = goalSubcommands.filter(function(sc) {
           return sc.name.startsWith(goalPartial);
         });
         if (goalSubcommandFiltered.length > 0) {
           slashPopup.innerHTML = '<div class="slash-popup-header">Goal Subcommands</div>';
           goalSubcommandFiltered.forEach(function(sc, i) {
             var item = document.createElement('div');
             item.className = 'slash-popup-item' + (i === 0 ? ' active' : '');
             item.dataset.index = String(i);
             item.innerHTML =
               '<span class="cmd-name">/goal ' + escapeHtml(sc.name) + '</span>' +
               '<span class="cmd-desc">' + escapeHtml(sc.description) + '</span>';
            item.addEventListener('click', function() {
              promptInput.value = '/goal ' + sc.name;
              slashPopup.classList.remove('open');
              isGoalSubcommandAutocomplete = false;
              promptInput.focus();
              handleSend();
            });
             item.addEventListener('mouseenter', function() {
               goalSubcommandSelectedIdx = i;
               var items = slashPopup.querySelectorAll('.slash-popup-item');
               items.forEach(function(el, j) { el.classList.toggle('active', j === i); });
             });
             slashPopup.appendChild(item);
           });
           slashPopup.classList.add('open');
           goalSubcommandSelectedIdx = 0;
         } else {
           slashPopup.classList.remove('open');
           isGoalSubcommandAutocomplete = false;
         }
       } else {
         // User is typing an objective (not a subcommand) — close popup
         slashPopup.classList.remove('open');
         isGoalSubcommandAutocomplete = false;
       }
    } else if (text.startsWith('/session')) {
      // /session autocomplete even when no agent commands are available
      var sFirstSpace = text.indexOf(' ');
      if (sFirstSpace > 0) {
        isSessionAutocomplete = true;
        if (!sessionNamesRequested) {
          sessionNamesRequested = true;
          vscode.postMessage({ type: 'getSessionNames' });
        }
        var sAfter = text.substring(sFirstSpace + 1);
        var sSecondSpace = sAfter.indexOf(' ');
        var sPartial = sSecondSpace >= 0 ? sAfter.substring(0, sSecondSpace) : sAfter;
        sessionAutocompleteFiltered = sessionNames.filter(function(n) {
          return n.toLowerCase().indexOf(sPartial.toLowerCase()) >= 0;
        });
        if (sessionAutocompleteFiltered.length > 0 && sSecondSpace < 0) {
          renderSessionAutocomplete(sessionAutocompleteFiltered);
          slashPopup.classList.add('open');
          sessionAutocompleteSelectedIdx = 0;
          var sItems = slashPopup.querySelectorAll('.slash-popup-item');
          sItems.forEach(function(el, i) { el.classList.toggle('active', i === 0); });
        } else {
          slashPopup.classList.remove('open');
          isSessionAutocomplete = false;
        }
      } else {
        slashPopup.classList.remove('open');
        isSessionAutocomplete = false;
      }
    } else {
      // Other slash commands with args — close popup
      slashPopup.classList.remove('open');
      isSessionAutocomplete = false;
      isGoalSubcommandAutocomplete = false;
    }
    } else {
      // Neither @mention nor slash — reset autocomplete UI
      slashPopup.classList.remove('open');
      isSessionAutocomplete = false;
      isGoalSubcommandAutocomplete = false;
      promptInput.placeholder = savedPlaceholder;
    }
    });

   // Send on Enter (Shift+Enter for newline)
  promptInput.addEventListener('keydown', (e) => {
    // Session name autocomplete navigation
    if (slashPopup.classList.contains('open') && isSessionAutocomplete) {
      // (handled below)
    }
    // /goal subcommand autocomplete navigation
    if (slashPopup.classList.contains('open') && isGoalSubcommandAutocomplete) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        goalSubcommandSelectedIdx = Math.min(goalSubcommandSelectedIdx + 1, goalSubcommandFiltered.length - 1);
        var gsItems = slashPopup.querySelectorAll('.slash-popup-item');
        gsItems.forEach(function(el, i) { el.classList.toggle('active', i === goalSubcommandSelectedIdx); });
        if (gsItems[goalSubcommandSelectedIdx]) gsItems[goalSubcommandSelectedIdx].scrollIntoView({ block: 'nearest' });
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        goalSubcommandSelectedIdx = Math.max(goalSubcommandSelectedIdx - 1, 0);
        var gsItems2 = slashPopup.querySelectorAll('.slash-popup-item');
        gsItems2.forEach(function(el, i) { el.classList.toggle('active', i === goalSubcommandSelectedIdx); });
        return;
      }
     if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
       e.preventDefault();
       if (goalSubcommandFiltered.length > 0) {
         var sc = goalSubcommandFiltered[goalSubcommandSelectedIdx];
         promptInput.value = '/goal ' + sc.name;
         slashPopup.classList.remove('open');
         isGoalSubcommandAutocomplete = false;
         promptInput.focus();
         // For Tab: just fill in the text. For Enter: also send immediately
         // since clear/pause/resume need no further input.
         if (e.key === 'Enter') {
           handleSend();
         }
       }
       return;
     }
      if (e.key === 'Escape') {
        e.preventDefault();
        slashPopup.classList.remove('open');
        isGoalSubcommandAutocomplete = false;
        return;
      }
    }
    // Session name autocomplete navigation
    if (slashPopup.classList.contains('open') && isSessionAutocomplete) {
       if (e.key === 'ArrowDown') {
         e.preventDefault();
         sessionAutocompleteSelectedIdx = Math.min(sessionAutocompleteSelectedIdx + 1, sessionAutocompleteFiltered.length - 1);
         var sItems = slashPopup.querySelectorAll('.slash-popup-item');
         sItems.forEach(function(el, i) { el.classList.toggle('active', i === sessionAutocompleteSelectedIdx); });
         if (sItems[sessionAutocompleteSelectedIdx]) sItems[sessionAutocompleteSelectedIdx].scrollIntoView({ block: 'nearest' });
         return;
       }
       if (e.key === 'ArrowUp') {
         e.preventDefault();
         sessionAutocompleteSelectedIdx = Math.max(sessionAutocompleteSelectedIdx - 1, 0);
         var sItems2 = slashPopup.querySelectorAll('.slash-popup-item');
         sItems2.forEach(function(el, i) { el.classList.toggle('active', i === sessionAutocompleteSelectedIdx); });
         return;
       }
       if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
         e.preventDefault();
         if (sessionAutocompleteFiltered.length > 0) {
           selectSessionName(sessionAutocompleteFiltered[sessionAutocompleteSelectedIdx]);
         }
         return;
       }
       if (e.key === 'Escape') {
         e.preventDefault();
         slashPopup.classList.remove('open');
         isSessionAutocomplete = false;
         return;
       }
     }
     // Slash popup navigation
    if (slashPopup.classList.contains('open')) {
       // If the user has already typed past the command name (has a space),
       // Enter should submit the prompt, not re-select the command from the
       // popup. This fixes /session <name>, /rename <name>, etc. being
       // swallowed by the popup when Enter is pressed.
       var hasCmdArgs = promptInput.value.indexOf(' ') >= 0;
       if (hasCmdArgs && e.key === 'Enter' && !e.shiftKey) {
         slashPopup.classList.remove('open');
         // Fall through to handleSend() below
       } else {
       if (e.key === 'ArrowDown') {
         e.preventDefault();
         slashPopupSelectedIdx = Math.min(slashPopupSelectedIdx + 1, slashFilteredCommands.length - 1);
         highlightSlashItem(slashPopupSelectedIdx);
         return;
       }
       if (e.key === 'ArrowUp') {
         e.preventDefault();
         slashPopupSelectedIdx = Math.max(slashPopupSelectedIdx - 1, 0);
         highlightSlashItem(slashPopupSelectedIdx);
         return;
       }
       if (e.key === 'Tab') {
         e.preventDefault();
         selectSlashCommand(slashFilteredCommands[slashPopupSelectedIdx]);
         return;
       }
       if (e.key === 'Enter' && !e.shiftKey) {
         e.preventDefault();
         selectSlashCommand(slashFilteredCommands[slashPopupSelectedIdx]);
         return;
       }
       if (e.key === 'Escape') {
         e.preventDefault();
         slashPopup.classList.remove('open');
         return;
       }
       }
     }

 if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    // While a turn is streaming, Enter queues the message instead of
    // blocking. Queued messages auto-send when the current turn finishes.
    // Fast-track: if the editor is empty and there are queued messages,
    // pressing Enter sends the first queued message immediately (like Zed).
    // While a turn is streaming, Enter queues the message and shows it as
    // a user bubble immediately (mirrors Codex TUI steering). The message
    // is sent when the turn finishes or when the user presses ESC / Send Now.
    var fastTrackText = promptInput.value.trim();
    // Transition-tick guard: a sendPrompt is in flight host-side but the
    // turn hasn't started yet (promptStart not received). Any input in this
    // window — including Enter on an empty box with queued messages — must
    // queue, not race the in-flight session/prompt. Drain will pick it up
    // once the current turn finishes.
    if (isSendingPrompt) {
      if (fastTrackText || pendingImages.length > 0) {
        handleQueue();
      }
      // Empty input + queued messages: do nothing extra here — the queued
      // message is already awaiting drain; don't force-send while a prompt
      // is mid-flight.
      return;
    }
    if (!fastTrackText && pendingImages.length === 0 && messageQueue.length > 0) {
      sendQueuedMessageNow(0);
      return;
    }
    if (isProcessing) {
      // /rename works even during streaming (like Claude Code's immediate commands)
      if (handleLocalSlashCommand()) { return; }
      // While a turn is streaming, ANY slash command sent to the agent must be
      // queued rather than dispatched immediately. claude-code-acp serializes
      // prompts per session (sessionPromptLocks), so a slash command sent
      // mid-turn waits for the active turn to finish before running — if we
      // sent it immediately the user would see nothing until the turn ends
      // anyway, and historically the concurrent session/prompt raced with the
      // in-flight turn and could drop the command's output entirely (the
      // /skills-mid-turn regression: zero agent_message_chunk in the log).
      // Queuing shows the queue chip so the user knows the command is pending
      // and will run when the turn finishes. Local-only commands (/rename)
      // are already handled above by handleLocalSlashCommand().
      handleQueue();
      return;
    }
     handleSend();
   }
 });

    function handleQueue() {
    const text = promptInput.value.trim();
    wvProbe('handleQueue ENTER', 'text=' + (text || '(empty)').substring(0, 40));
    if (!text && pendingImages.length === 0) return;
    const images = pendingImages.splice(0);
    imagePreviewStrip.innerHTML = '';
    promptInput.value = '';
    updateSendButton();
    // Every message typed while a turn is processing is queued here —
    // NO agent is steered mid-turn from this client anymore (see the
    // per-agent notes below). The message is held as a queue chip only
    // (no chat bubble yet — the bubble is added at drain time, when it is
    // actually sent). The queue chip stays visible so the user can click
    // "Send Now" to interrupt the current turn and deal with the queued
    // message immediately. drainQueue() sends exactly ONE queued message
    // per turn (strict FIFO), so a burst of N messages during a long turn
    // is answered by N sequential turns — never batched, never dropped.
var _isMutatingCmd = queueIsMutatingCommand(text);
if (_isMutatingCmd) {
  // Mutating slash commands are queued too — but they must run as a real
   // prompt — they are NOT shown as a chat bubble until they drain. The
   // queue chip stays visible so the user knows the command is pending.
   vscode.postMessage({ type: 'debugLog', message: '[DRAIN-DBG] handleQueue: QUEUED mutating cmd, messageQueue.length=' + (messageQueue.length + 1) });
   queueMessage(text, images);
 } else {
   // Option B (all agents): do NOT show the message as a user bubble yet —
   // only the queue chip. Showing the bubble immediately is misleading during
   // a long turn: the user sees their prompt in the conversation as if it were
   // being processed, when it is actually still queued. drainQueue() adds the
   // bubble at the moment the message is actually sent to the agent.
   vscode.postMessage({ type: 'debugLog', message: '[DRAIN-DBG] handleQueue: QUEUED msg, isProcessing=' + isProcessing + ' isSendingPrompt=' + isSendingPrompt + ' messageQueue.length=' + (messageQueue.length + 1) });
   queueMessage(text, images);
 }
 }

  /**
   * Handle client-side slash commands that should execute immediately,
   * even during streaming (like Claude Code's immediate:true commands).
   * Returns true if the command was handled (caller should stop).
   */
function handleLocalSlashCommand(cmdText) {
  var text = (cmdText !== undefined) ? cmdText.trim() : promptInput.value.trim();
  if (!text.startsWith('/')) { return false; }
  // /stop — kill all running background processes spawned in this session.
  // Sent as a custom notification (not a prompt) so it doesn't start a new
  // turn or interrupt the active turn's streaming.
  if (text === '/stop') {
    promptInput.value = '';
    updateSendButton();
    vscode.postMessage({ type: 'stopProcesses' });
    return true;
  }
  // /rename <name> — set session title locally
    var renameMatch = text.match(/^\\/rename\\s+(.+)$/);
    if (renameMatch) {
      var title = renameMatch[1].trim();
      promptInput.value = '';
      updateSendButton();
    pendingImages.splice(0);
    imagePreviewStrip.innerHTML = '';
    showTransientNotice('Session renamed to: **' + title + '**');
    vscode.postMessage({ type: 'renameSession', title: title });
    return true;
  }
   // /rename with no args — auto-generate from first prompt
   if (text === '/rename') {
     promptInput.value = '';
     updateSendButton();
     var autoTitle = sessionState?.title || '';
      if (!autoTitle) {
        // Find first user message for fallback
        for (var i = 0; i < chatHistory.length; i++) {
          if (chatHistory[i].kind === 'message' && chatHistory[i].role === 'user') {
            autoTitle = chatHistory[i].text.slice(0, 60);
            break;
          }
        }
      }
     if (autoTitle) {
       showTransientNotice('Session renamed to: **' + autoTitle + '**');
       vscode.postMessage({ type: 'renameSession', title: autoTitle });
     } else {
       showTransientNotice('Could not generate a name: no conversation context yet. Usage: /rename <name>');
     }
     return true;
    }
   // /session with no args — trigger QuickPick picker
   if (text === '/session') {
     promptInput.value = '';
     updateSendButton();
     pendingImages.splice(0);
     imagePreviewStrip.innerHTML = '';
     vscode.postMessage({ type: 'pickContext', contextType: 'session' });
     return true;
   }
   // /session <name> — summarize a past session and add it as context.
   // The name is matched against renamed sessions (fuzzy/contains match).
   // The summary is shown in the chat as a collapsible context block,
   // and the user can continue typing their actual prompt after it.
  var sessionMatch = text.match(/^\\/session\\s+(.+)$/);
  if (sessionMatch) {
    try {
      // Try to match the longest known session name at the start of args.
      // Session names can contain spaces (e.g. "ue session route path").
      var sessionArgs = sessionMatch[1].trim();
      var sessionName = '';
      var remainingQuery = '';
      var bestMatchLen = 0;
      var names = (typeof sessionNames === 'undefined' || !Array.isArray(sessionNames)) ? [] : sessionNames;
      vscode.postMessage({ type: 'debugLog', message: '[SESSION-DBG] /session received: args="' + sessionArgs.substring(0, 80) + '" sessionNames.length=' + names.length });
      for (var si = 0; si < names.length; si++) {
        var sn = names[si];
        if (sessionArgs === sn) {
          sessionName = sn;
          remainingQuery = '';
          bestMatchLen = sn.length;
          break;
        }
        if (sessionArgs.length > sn.length && sessionArgs.substring(0, sn.length) === sn && sessionArgs.charCodeAt(sn.length) === 32) {
          if (sn.length > bestMatchLen) {
            sessionName = sn;
            remainingQuery = sessionArgs.substring(sn.length + 1).trim();
            bestMatchLen = sn.length;
          }
        }
      }
      if (!sessionName) {
        var firstSpace = sessionArgs.indexOf(' ');
        sessionName = firstSpace >= 0 ? sessionArgs.substring(0, firstSpace) : sessionArgs;
        remainingQuery = firstSpace >= 0 ? sessionArgs.substring(firstSpace + 1).trim() : '';
      }
      promptInput.value = '';
      updateSendButton();
      pendingImages.splice(0);
      imagePreviewStrip.innerHTML = '';
      // Show the user message immediately (pill + query) so the user sees
      // their prompt right away, before the summary is generated.
      var mentionLink = '[@' + sessionName + '](session:' + sessionName + ')';
      var displayText = mentionLink;
      if (remainingQuery) {
        displayText += ' ' + remainingQuery;
      }
      addMessage('user', displayText);
      // Show a loading indicator in the status bar
      if (statusEl) {
        statusEl.innerHTML = '<span class="spinner"></span><span>Summarizing session...</span>';
      }
      hasSentPrompt = true;
      vscode.postMessage({ type: 'summarizeSession', sessionName: sessionName, queryText: remainingQuery });
      return true;
    } catch (e) {
      vscode.postMessage({ type: 'debugLog', message: '[SESSION-DBG] /session handler error: ' + (e && e.message ? e.message : String(e)) });
      // Fall through to the agent as a normal prompt rather than silently
      // dropping the user's input. The user can retry after the error is fixed.
      return false;
    }
  }
 // /compact|/summarize|/compress — context compaction where the agent
 // supports it. Kiro: _kiro.dev/commands/execute. Codex/Claude: session/prompt.
 // Cursor Agent has no compact slash command (its available_commands_update
 // never advertises one) — do not fake /summarize or send a dead prompt.
 var compactMatch = text.match(/^\\/(compact|summarize|compress)\\b(.*)$/i);
 if (compactMatch) {
   // During an active turn, /compact must be queued — sending session/prompt
   // while a turn is in-flight causes a race condition. The queued /compact
   // is drained after the current turn ends (promptEnd), at which point
   // handleLocalSlashCommand runs again with isProcessing=false.
   if (isProcessing) { return false; }
   if (isCompacting) { return true; }
   var agentLabel = (sessionState && (sessionState.agentName || sessionState.agentConfigKey || '')) || '';
    var isCursorAgent = /cursor/i.test(agentLabel);
    if (isCursorAgent) {
      promptInput.value = '';
      updateSendButton();
      addMessage('system',
        'Cursor Agent does not support /' + compactMatch[1].toLowerCase() +
        '. Start a new chat to free context.');
      return true;
    }
    promptInput.value = '';
    updateSendButton();
    pendingImages.splice(0);
    imagePreviewStrip.innerHTML = '';
    isCompacting = true;
    manualCompacting = true;
    compactedWarningText = '';
    compactedNoticeText = '';
    if (compactionFlushTimer) { clearTimeout(compactionFlushTimer); compactionFlushTimer = null; }
    pendingPostCompactChunks = []; // new compaction supersedes any buffered resume tokens
    if (kiroCompactWatchdog) { clearTimeout(kiroCompactWatchdog); kiroCompactWatchdog = null; }
    setProcessing(true, 'handleLocalSlashCommand-compact');
    var compactCmd = '/' + compactMatch[1].toLowerCase();
    var compactArgs = (compactMatch[2] || '').trim();
    var compactPrompt = compactArgs ? (compactCmd + ' ' + compactArgs) : compactCmd;
    addMessage('user', compactPrompt);
    showCompactionProgress('Compacting conversation...', null);
    var isKiro = /kiro/i.test(agentLabel);
    if (isKiro) {
      kiroCompactWatchdog = setTimeout(function() {
        kiroCompactWatchdog = null;
        if (!isCompacting) return;
        handleKiroCompactDone({
          error: true,
          message: 'Kiro /compact timed out waiting for a compaction notice. Conversation was left unchanged.',
        });
      }, 600000);
      vscode.postMessage({ type: 'executeKiroCommand', command: 'compact' });
    } else {
      // Codex/Claude resolve /compact (and aliases) as a prompt slash command.
      // Keep waiting after promptEnd for contextCompaction completed / notice.
      kiroCompactWatchdog = setTimeout(function() {
        kiroCompactWatchdog = null;
        if (!isCompacting) return;
        isCompacting = false;
        compactedWarningText = '';
        compactedNoticeText = '';
        if (compactionFlushTimer) { clearTimeout(compactionFlushTimer); compactionFlushTimer = null; }
        pendingPostCompactChunks = []; // compaction timed out — discard any buffered resume tokens
        hideCompactionProgress();
        if (statusEl) statusEl.innerHTML = '';
        setProcessing(false, 'compact-timeout-watchdog');
        addMessage('system',
          'Timed out waiting for compaction to finish. Conversation was left unchanged.');
      }, 600000);
      vscode.postMessage({ type: 'sendPrompt', text: compactPrompt });
    }
    return true;
  }
  // /clear — wipe conversation history.
  // Kiro: _kiro.dev/commands/execute + _kiro.dev/clear/status progress.
  // Other agents: send as a prompt (or local clear if unknown).
 if (text === '/clear') {
   // During an active turn, /clear must be queued — wiping conversation
   // state while the LLM is mid-turn causes corruption. The queued /clear
   // is drained after the current turn ends.
   if (isProcessing) { return false; }
   if (isClearing || isCompacting) { return true; }
    promptInput.value = '';
    updateSendButton();
    pendingImages.splice(0);
    imagePreviewStrip.innerHTML = '';
    var isKiroClear = sessionState && /kiro/i.test(sessionState.agentName || sessionState.agentConfigKey || '');
    if (isKiroClear) {
      isClearing = true;
      setProcessing(true, 'handleLocalSlashCommand-clear');
      addMessage('user', '/clear');
      showStatusBanner('clear', 'Clearing conversation...', null);
      vscode.postMessage({ type: 'executeKiroCommand', command: 'clear' });
    } else {
      // Local clear for non-Kiro (Codex /clear is usually a prompt; still
      // wipe the UI immediately so the chat feels responsive).
      addMessage('user', '/clear');
      chatHistory = [];
      messagesEl.innerHTML = '';
      historyRenderGen++;
      for (var _clrRk in pendingRenderRetries) { delete pendingRenderRetries[_clrRk]; }
      currentTurnEl = null;
      currentAssistantEl = null;
      currentAssistantText = '';
      currentMessageId = null;
      lastCommittedAssistantEl = null;
      lastCommittedMessageId = null;
      lastCommittedText = '';
      reactivatedHistoryIndex = -1;
      currentToolsListEl = null;
      currentToolsCountEl = null;
      currentToolCount = 0;
      toolCalls = {};
      toolCallDiffs = {};
      saveState();
     vscode.postMessage({ type: 'sendPrompt', text: '/clear' });
     // After /clear, chatHistory belongs to current session.
     chatHistoryOriginSessionId = (sessionState && sessionState.sessionId) || null;
   }
   return true;
 }
 // /ps — list background terminal processes (client-side, like codex TUI)
 if (text === '/ps') {
    promptInput.value = '';
    updateSendButton();
    pendingImages.splice(0);
    imagePreviewStrip.innerHTML = '';
    // Find tool calls that are still running (background processes)
    var bgProcs = [];
    for (var pi = 0; pi < chatHistory.length; pi++) {
      var pItem = chatHistory[pi];
      if (pItem && pItem.kind === 'toolCall' &&
          (pItem.status === 'in_progress' || pItem.status === 'running' || pItem.status === 'pending')) {
        bgProcs.push(pItem);
      }
    }
    var nl = String.fromCharCode(10);
    var bullet = String.fromCharCode(8226);
    // Render into psPanel (above input box, not in messages area)
    // If panel already shows 'No background terminals' and still none,
    // don't re-render — avoids flicker on repeated /ps polls.
    if (bgProcs.length === 0 && psPanel.style.display === 'block' && psPanel.textContent.indexOf('No background terminals') !== -1) {
      return true;
    }
    if (!psPanel) { return true; }
    psPanel.innerHTML = '';
    psPanel.style.display = 'block';
    var cmdLine = document.createElement('div');
    cmdLine.className = 'ps-cmd';
    cmdLine.textContent = '/ps';
    psPanel.appendChild(cmdLine);
    var header = document.createElement('div');
    header.className = 'ps-header';
    header.textContent = 'Background terminals';
    psPanel.appendChild(header);
    if (bgProcs.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'ps-item';
      empty.textContent = bullet + ' No background terminals running.';
      psPanel.appendChild(empty);
    } else {
      for (var bi = 0; bi < bgProcs.length; bi++) {
        var item = document.createElement('div');
        item.className = 'ps-item';
        var cmd = bgProcs[bi].title || bgProcs[bi].toolCallId || '(unknown)';
        item.textContent = bullet + ' ' + cmd;
        psPanel.appendChild(item);
      }
    }
    currentPsEl = psPanel;
    // Keep /ps visible for at least 3 seconds, even if a quick turn arrives.
    psMinDisplayUntil = Date.now() + 3000;
    if (psHideTimer) { clearTimeout(psHideTimer); psHideTimer = null; }
    // Auto-scroll messages to bottom so latest streamed content stays visible
    // even when the ps panel takes vertical space on small chat panels.
    scrollToBottom();
    return true;
  }
  
  
  
  return false;
}

function handleSend() {
  const text = promptInput.value.trim();
  wvProbe('handleSend ENTER', 'textLen=' + text.length + ' hasImages=' + (pendingImages.length > 0));
  if (!text && pendingImages.length === 0) return;
  // Guard: don't send if there's no active agent session (e.g. after reload
  // before reconnecting). The Send button is also disabled via
  // updateSendButton, but this catches edge cases like Enter key.
  if (!hasActiveSession) {
    wvProbe('handleSend GUARD:no-active-session', 'showResumeBar');
    // Show the resume bar instead
    updateResumeBar();
    return;
  }
   // Transition-tick guard: a sendPrompt was just posted by drainQueue /
   // Send Now but the turn hasn't started yet (promptStart not received).
   // Sending now would race the in-flight session/prompt. Queue instead.
   if (isSendingPrompt) {
     wvProbe('handleSend GUARD:isSendingPrompt-stuck', 'queueing instead of posting sendPrompt');
     handleQueue();
     return;
   }
   // Block input during /compact — compaction is an atomic operation
   // (like codex TUI's set_task_running(true) during compact).
   // BUT allow local slash commands (e.g. /ps, /rename) that don't
   // interact with the agent.
   if (isCompacting || isClearing) {
     wvProbe('handleSend GUARD:compacting-clearing', 'isCompacting=' + isCompacting + ' isClearing=' + isClearing);
     // Local slash commands (e.g. /ps, /rename) execute immediately even
     // during compaction — they don't interact with the agent.
     if (text.startsWith('/') && handleLocalSlashCommand()) { return; }
     // Non-local commands (e.g. /goal, regular prompts) must NOT be
     // dropped — queue them so they are sent after compaction finishes.
     // handleQueue shows the user bubble immediately and queues it for
     // draining when compaction completes.
     handleQueue();
     return;
   }
   // /rename works immediately, even during streaming
   if (handleLocalSlashCommand()) {
     wvProbe('handleSend GUARD:local-slash', 'text=' + text.substring(0, 40));
     return;
   }
// Allow slash commands through during streaming — the agent
   // handles read-only commands (e.g. /ps, /status) without
   // interrupting the in-progress LLM turn.
   // Non-slash messages typed while a turn is streaming are QUEUED (never
   // sent concurrently, never dropped) — they drain one per turn, FIFO.
   if (isProcessing && !text.startsWith('/')) {
     wvProbe('handleSend GUARD:isProcessing-queued', 'text=' + text.substring(0, 40));
     handleQueue();
     return;
   }

  wvProbe('handleSend POSTING', 'text=' + text.substring(0, 40));
  if (suppressNextUserBubble) {
    // Fork-to-agent: the summary is sent to the agent for context but the
    // user bubble is hidden. clearChat already reset the turn state, so we
    // skip the visible bubble (and the chatHistory entry) entirely. Clear
    // the flag so a subsequent normal send renders its bubble.
    suppressNextUserBubble = false;
  } else {
    addMessage('user', text || '(image)');
  }
   promptInput.value = '';
   const images = pendingImages.splice(0);
   imagePreviewStrip.innerHTML = '';
   updateSendButton();
 hasSentPrompt = true;
 lastPromptWasSlash = !!(text && text.startsWith('/') && !text.startsWith('/rename') && !text.startsWith('/session'));
  // Optimistically set processing=true so the Stop button shows immediately.
  // The extension host will send promptStart back, but postMessage round-trips
  // can be delayed by VS Code webview iframe throttling (observed 16-second
  // delay in some sessions). Setting isProcessing here ensures the user sees
  // the Stop button without waiting for the round-trip.
  // isSendingPrompt guards against concurrent sends; promptStart will clear it.
  isSendingPrompt = true;
  setProcessing(true, 'handleSend');
 vscode.postMessage({ type: 'sendPrompt', text: text || ' ', images });
}

    function handleCancel() {
      vscode.postMessage({ type: 'cancelTurn' });
    }

    // --- Image attach/paste support ---
    let pendingImages = [];

    function isImageInputSupported() {
      if (!attachBtn) return false;
      return attachBtn.style.display !== 'none';
    }

    function addPendingImage(dataUrl) {
      // dataUrl format: data:<mime>;base64,<data>
      const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) return;
      pendingImages.push({ data: match[2], mimeType: match[1] });
      // Convert to blob URL for CSP-safe thumbnail display
      const byteChars = atob(match[2]);
      const byteArray = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) byteArray[i] = byteChars.charCodeAt(i);
      const blob = new Blob([byteArray], { type: match[1] });
      const blobUrl = URL.createObjectURL(blob);
      const thumb = document.createElement('div');
      thumb.className = 'img-thumb';
      const img = document.createElement('img');
      img.src = blobUrl;
      const removeBtn = document.createElement('button');
      removeBtn.className = 'img-remove';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', () => {
        const idx = Array.from(imagePreviewStrip.children).indexOf(thumb);
        if (idx >= 0) pendingImages.splice(idx, 1);
        URL.revokeObjectURL(blobUrl);
        thumb.remove();
      });
      thumb.appendChild(img);
      thumb.appendChild(removeBtn);
      imagePreviewStrip.appendChild(thumb);
    }

    // Paste handler
   promptInput.addEventListener('paste', (e) => {
     if (!isImageInputSupported()) return;
     const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (!file) continue;
          const reader = new FileReader();
          reader.onload = () => addPendingImage(reader.result);
          reader.readAsDataURL(file);
        }
      }
    });

    // Attach button — opens file picker
   attachBtn.addEventListener('click', () => {
     if (!isImageInputSupported()) return;
     const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.multiple = true;
      input.addEventListener('change', () => {
        for (const file of input.files) {
          const reader = new FileReader();
          reader.onload = () => addPendingImage(reader.result);
          reader.readAsDataURL(file);
        }
      });
      input.click();
    });

   function execCmd(command) {
    vscode.postMessage({ type: 'executeCommand', command });
  }

  // --- Voice input (dictation) ---
  // Recording runs in the extension host (webviews cannot access the mic).
  // The button just toggles and mirrors state; the transcript arrives as a
  // voiceTranscript message and is inserted at the cursor.
  var voiceState = 'idle';
  function setVoiceState(next) {
    voiceState = next;
    if (!micBtn) return;
    micBtn.classList.toggle('recording', next === 'recording');
    micBtn.classList.toggle('transcribing', next === 'transcribing');
    micBtn.textContent = next === 'recording' ? '⏺' : next === 'transcribing' ? '⏳' : '🎙';
    micBtn.title = next === 'recording'
      ? 'Recording… click to stop, or just stop talking (auto-stop on silence)'
      : next === 'transcribing'
        ? 'Transcribing…'
        : 'Dictate: click to start recording, click again to transcribe (local STT)';
  }
  if (micBtn) {
    micBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'voiceToggle' });
    });
  }
  function insertVoiceTranscript(text, autoSend) {
    if (!text) return;
    // Insert at the cursor (or replace the current selection), then run the
    // normal input pipeline so auto-resize and the Send button stay in sync.
    var start = promptInput.selectionStart;
    var end = promptInput.selectionEnd;
    if (typeof start !== 'number' || typeof end !== 'number') {
      start = promptInput.value.length;
      end = start;
    }
    var before = promptInput.value.slice(0, start);
    var after = promptInput.value.slice(end);
    var needsSpace = before.length > 0 && !/\\s$/.test(before);
    var insert = (needsSpace ? ' ' : '') + text;
    promptInput.value = before + insert + after;
    var caret = start + insert.length;
    promptInput.selectionStart = caret;
    promptInput.selectionEnd = caret;
    promptInput.dispatchEvent(new Event('input', { bubbles: true }));
    promptInput.focus();
    if (autoSend) {
      handleSend();
    }
  }

  // Compact mode toggle — collapse/expand all turn folds (thought + tools + reply)
 var compactMode = true; // default: compact (collapsed)
 // When true, promoteFinalAssistantForTurn keeps interrupted-turn assistants
 // inside the fold (webview crash restore + session/load resume).
 var foldInterruptedAssistantsOnPromote = false;
 var keepAssistantsInFold = false;
 // sessionId → true after a cancelled turn; cleared on a successful end_turn.
 // Survives restart via vscode.setState so Codex/Kiro resume can keep the
 // partial reply folded even when agent history marks tools completed.
 var interruptedSessionIds = {};
 const compactToggleBtn = document.getElementById('compactToggle');
 if (messagesEl) messagesEl.classList.add('compact-mode');
 if (compactToggleBtn) {
   compactToggleBtn.addEventListener('click', function() {
     compactMode = !compactMode;
     compactToggleBtn.classList.toggle('active', compactMode);
      compactToggleBtn.setAttribute('aria-pressed', compactMode ? 'true' : 'false');
     if (messagesEl) messagesEl.classList.toggle('compact-mode', compactMode);
     applyCompactModeToAllTurns(compactMode);
     // Compact mode toggle — todos remain visible in plan bar.
   });
  }

   // Wire up buttons
    sendStopBtn.addEventListener('click', () => {
      wvProbe('sendStopBtn CLICK', 'isProcessing=' + isProcessing + ' btnText=' + sendStopBtn.textContent);
      if (isProcessing) {
        handleCancel();
      } else {
        handleSend();
      }
    });

  const welcomeConnectAgent = document.getElementById('welcomeConnectAgent');
  // Update the welcome button label based on whether we have a prior agent to resume.
  function updateWelcomeButton() {
    if (welcomeConnectAgent) {
     welcomeConnectAgent.textContent = lastConnectedAgent
       ? '🔄 Resume ' + (lastConnectedAgentDisplay || lastConnectedAgent)
       : '🔌 Connect to Agent';
    }
  }
if (welcomeConnectAgent) welcomeConnectAgent.addEventListener('click', () => {
  // If we have a restored session with an agent name, reconnect to
  // that agent directly instead of showing the agent picker.
  if (lastConnectedAgent) {
    requestResumeConnect();
  } else {
    execCmd('acp.connectAgent');
  }

 });
 updateWelcomeButton();

   // --- Send/Stop toggle ---
  // Turn progress feedback. Agent-independent: while a turn runs the status area
  // used to show a bare spinner, so a slow model call is indistinguishable from a
  // hang. Measured on one turn: 47s, then 99s, then 120s of complete silence
  // between frames — over four minutes where the only signal was a spinner.
  var turnStartedAt = 0;
  var lastAgentUpdateAt = 0;
  var turnTicker = null;

  /**
   * Status label for a running turn: elapsed time, plus how long the agent has
   * been silent once that becomes the interesting part.
   *
   * The idle figure is what distinguishes "working" from "stuck": frames arrive
   * steadily while tools run, then stop dead during a long model call.
   */
  function formatTurnStatusLabel(elapsedMs, idleMs) {
    function human(ms) {
      var total = Math.max(0, Math.round(ms / 1000));
      var m = Math.floor(total / 60);
      var sec = total % 60;
      return m > 0 ? m + 'm ' + sec + 's' : sec + 's';
    }
    var label = human(elapsedMs);
    if (idleMs >= 20000) {
      label += ' \u00b7 waiting on agent ' + human(idleMs);
    }
    return label;
  }

  /** Repaint the spinner label; no-op unless a plain spinner is showing. */
  function refreshTurnStatusLabel() {
    if (!isProcessing) {
      var hidden = document.getElementById('turn-elapsed-label');
      if (hidden) hidden.style.display = 'none';
      return;
    }
    if (isCompacting || isClearing) return;
    var now = Date.now();
    var label = formatTurnStatusLabel(
      turnStartedAt ? now - turnStartedAt : 0,
      lastAgentUpdateAt ? now - lastAgentUpdateAt : 0
    );
    var el = document.getElementById('turn-elapsed-label');
    if (el) {
      el.style.display = '';
      el.textContent = label;
    }
  }

  /** Any agent frame counts as liveness for the idle figure. */
  function noteAgentActivity() {
    lastAgentUpdateAt = Date.now();
  }

  function setProcessing(processing, caller) {
    if (isProcessing !== processing) {
      vscode.postMessage({ type: 'debugLog', message: '[DRAIN-DBG] setProcessing: ' + isProcessing + ' → ' + processing + ' caller=' + (caller || 'anon') + ' messageQueue.length=' + messageQueue.length + ' hasSteeredThisTurn=' + hasSteeredThisTurn });
    }
    isProcessing = processing;
    if (!processing) {
      // Clear only the per-turn pending flag, never the sent-ever flag. Clearing it
      // made a late echo unmatchable, so the entry stayed queued and drainQueue sent
      // it AGAIN as a prompt — the same message delivered twice (steer 08:50:48,
      // echo 08:52:42, duplicate prompt 08:54:25).
      for (var _qi = 0; _qi < messageQueue.length; _qi++) {
        if (messageQueue[_qi] && messageQueue[_qi].steerPending) {
          delete messageQueue[_qi].steerPending;
        }
      }
      if (turnTicker) { clearInterval(turnTicker); turnTicker = null; }
      turnStartedAt = 0;
      lastAgentUpdateAt = 0;
      hasSteeredThisTurn = false;
      var _tl = document.getElementById('turn-elapsed-label');
      if (_tl) _tl.style.display = 'none';
      // A turn ended (promptEnd / error) — the transition-tick guard is no
      // longer needed. This is the same point promptEnd clears it, kept here
      // as a safety net for any path that ends processing without promptEnd.
      isSendingPrompt = false;
    }
    wvProbe('setProcessing', '→ ' + processing + ' caller=' + (caller || 'anon'));
     if (processing) {
        sendStopBtn.className = 'send-stop-btn stop';
        sendStopBtn.textContent = '■ Stop';
        sendStopBtn.disabled = false;
        // Keep textarea enabled so user can type next message while processing.
        // The Send button is replaced by Stop, so sending is blocked via isProcessing.
        promptInput.disabled = false;
        statusEl.innerHTML = '<span class="spinner"></span>';
        // Start (or keep) the elapsed/idle ticker so a silent model call still
        // shows movement. Re-entry through setProcessing(true) must not restart
        // the clock — the turn is the same one.
        if (!turnStartedAt) turnStartedAt = Date.now();
        if (!lastAgentUpdateAt) lastAgentUpdateAt = turnStartedAt;
        if (!turnTicker) turnTicker = setInterval(refreshTurnStatusLabel, 1000);
        refreshTurnStatusLabel();
        // Manual-operation hints: /compact and /clear start with a labeled
        // status pill ("Compacting conversation..." / "Clearing
        // conversation..."), but a later re-entry through setProcessing(true)
        // (promptStart, promptEnd keep-waiting, restored in-flight job, Kiro
        // status/RPC paths) would overwrite the label with a bare spinner.
        // Restore the hint so the user always sees what is running — same
        // pattern /session uses ("Summarizing session...").
        if (isCompacting) {
          showCompactionProgress('Compacting conversation...', null);
        } else if (isClearing) {
          showStatusBanner('clear', 'Clearing conversation...', null);
        }
      } else {
        sendStopBtn.className = 'send-stop-btn send';
        sendStopBtn.textContent = 'Send';
        promptInput.disabled = false;
        statusEl.textContent = '';
        updateSendButton();
      }
      if (typeof updateJumpLatestBtn === 'function') updateJumpLatestBtn();
    }

    // --- Session/load overlay ---
    const loadOverlay = document.getElementById('loadOverlay');
    // True while a session/load replay is in progress. Used to suppress
    // per-chunk markdown rendering until the replay finishes.
    let isLoadingSession = false;
    // Monotonic counter for the [WV-ORDER] replay arrival trace. Reset at each
    // handleLoadSessionStart so the numbering matches one replay.
    let replayRecvSeq = 0;
    // Snapshot of chatHistory kinds/roles captured at render time so the trace
    // can show the exact ordering the replay path consumes.
    function traceHistorySnapshot() {
      if (!DEBUG) return;
      var s = [];
      for (var j = 0; j < chatHistory.length; j++) {
        var it = chatHistory[j];
        if (!it) { s.push('null'); continue; }
        if (it.kind === 'message') s.push(it.role);
        else if (it.kind === 'thought') s.push('thought(' + (it.durationSec || 0) + 's,len=' + (it.text ? it.text.length : 0) + ')');
        else if (it.kind === 'toolCall') s.push('tool');
        else if (it.kind === 'plan') s.push('plan');
        else s.push(it.kind);
      }
      trace('chatHistory order: [' + s.join(',') + ']');
    }
    // Lightweight trace: posts when DEBUG or acp.debugResume is enabled.
    function trace(msg) {
      if (DEBUG || DEBUG_RESUME) vscode.postMessage({ type: 'debugLog', message: '[REPLAY-TRACE] ' + msg });
    }

    /** Match a loaded history item to its index in a merged array. */
    function findMergedHistoryAnchor(merged, item) {
      if (!item || !merged || !merged.length) return -1;
      if (item.kind === 'toolCall') {
        if (item.toolCallId) {
          for (var ti = 0; ti < merged.length; ti++) {
            if (merged[ti] && merged[ti].kind === 'toolCall' &&
                merged[ti].toolCallId === item.toolCallId) {
              return ti;
            }
          }
        }
        // session/load replay uses synthetic ids (replay-N-M) — fall back to title.
        var toolTitle = String(item.title || '').trim();
        if (toolTitle) {
          for (var tti = 0; tti < merged.length; tti++) {
            if (merged[tti] && merged[tti].kind === 'toolCall' &&
                String(merged[tti].title || '').trim() === toolTitle) {
              return tti;
            }
          }
        }
        return -1;
      }
      if (item.kind === 'message' && item.role === 'assistant') {
        var asstText = String(item.text || '').trim();
        if (!asstText) return -1;
        for (var ai = 0; ai < merged.length; ai++) {
          if (merged[ai] && merged[ai].kind === 'message' && merged[ai].role === 'assistant' &&
              String(merged[ai].text || '').trim() === asstText) {
            return ai;
          }
        }
        return -1;
      }
      if (item.kind === 'thought') {
        var thoughtText = String(item.text || '').trim();
        if (!thoughtText) return -1;
        var thoughtPrefix = thoughtText.slice(0, 120);
        for (var thi = 0; thi < merged.length; thi++) {
          if (merged[thi] && merged[thi].kind === 'thought') {
            var mergedThought = String(merged[thi].text || '').trim();
            if (mergedThought === thoughtText || mergedThought.indexOf(thoughtPrefix) === 0 ||
                thoughtText.indexOf(mergedThought.slice(0, 120)) === 0) {
              return thi;
            }
          }
        }
      }
      return -1;
    }

    function countRealUsers(arr) {
      if (!arr) return 0;
      var n = 0;
      for (var i = 0; i < arr.length; i++) {
        var it = arr[i];
        if (it && it.kind === 'message' && it.role === 'user' && !isSessionInterruptNotice(it.text)) {
          n++;
        }
      }
      return n;
    }

    function realUserEntries(arr) {
      var out = [];
      if (!arr) return out;
      for (var i = 0; i < arr.length; i++) {
        var it = arr[i];
        if (it && it.kind === 'message' && it.role === 'user' && !isSessionInterruptNotice(it.text)) {
          out.push({ index: i, item: it });
        }
      }
      return out;
    }

    function thoughtPrefixKey(text) {
      return String(text || '').trim().slice(0, 120);
    }

    /**
     * session/load preserves user-turn boundaries; the webview snapshot has richer
     * thoughts/assistants but may have lost earlier user prompts. Overlay snapshot
     * extras onto loaded instead of replacing the whole timeline.
     */
    function mergeLoadedWithSnapshotOverlay(loaded, snapshot) {
      var statusById = {};
      var statusByTitle = {};
      for (var si = 0; si < snapshot.length; si++) {
        var s = snapshot[si];
        if (s && s.kind === 'toolCall') {
          if (s.toolCallId) statusById[s.toolCallId] = s.status;
          var st = String(s.title || '').trim();
          if (st) statusByTitle[st] = s.status;
        }
      }

      var merged = [];
      // Row identity → position in the LOADED replay. The agent's session/load
      // replay IS the transcript chronology, so it is authoritative for the
      // order of every row it contains; only snapshot-ONLY rows (inserted
      // below) need snapshot-relative placement. See flushBucket().
      var loadedOrder = new Map();
      for (var li = 0; li < loaded.length; li++) {
        var item = loaded[li];
        if (!item) continue;
        if (item.kind === 'toolCall') {
          var copy = Object.assign({}, item);
          if (copy.toolCallId && statusById[copy.toolCallId]) {
            copy.status = statusById[copy.toolCallId];
          } else {
            var ct = String(copy.title || '').trim();
            if (ct && statusByTitle[ct]) copy.status = statusByTitle[ct];
          }
          loadedOrder.set(copy, li);
          merged.push(copy);
        } else {
          loadedOrder.set(item, li);
          merged.push(item);
        }
      }

      var mergedThoughtKeys = {};
      var mergedAsstKeys = {};
      for (var mi = 0; mi < merged.length; mi++) {
        var m = merged[mi];
        if (m && m.kind === 'thought') mergedThoughtKeys[thoughtPrefixKey(m.text)] = true;
        if (m && m.kind === 'message' && m.role === 'assistant') {
          mergedAsstKeys[String(m.text || '').trim()] = true;
        }
      }

      function toolAnchorKey(it) {
        if (!it || it.kind !== 'toolCall') return null;
        var t = String(it.title || '').trim();
        // Key by TITLE (not id): snapshot ids (call_abc) and loaded/replay
        // ids (replay-N-M) never match each other, and each snapshot id is
        // unique, so id-keying would make every identical Edit "count=1" and
        // fall back to the first-title-match bug. Title groups the duplicates
        // so ordinal matching can interleave thoughts between them.
        if (t) return 'title:' + t;
        if (it.toolCallId) return 'id:' + it.toolCallId;
        return null;
      }
      // Ordinal of the Nth occurrence of a tool (by id, else title) within
      // arr[0..index] inclusive. Returns 1-based ordinal.
      function toolOrdinalThrough(arr, index, key) {
        var n = 0;
        for (var i = 0; i <= index && i < arr.length; i++) {
          if (arr[i] && arr[i].kind === 'toolCall' && toolAnchorKey(arr[i]) === key) n++;
        }
        return n;
      }
      // Find the index of the n-th occurrence of a tool (by id, else title)
      // in arr. Returns -1 if fewer than n exist.
      function nthToolIndex(arr, n, key) {
        var seen = 0;
        for (var i = 0; i < arr.length; i++) {
          if (arr[i] && arr[i].kind === 'toolCall' && toolAnchorKey(arr[i]) === key) {
            seen++;
            if (seen === n) return i;
          }
        }
        return -1;
      }
      // Anchor a snapshot tool call to its MERGED counterpart. When the same
      // tool (same title, e.g. several consecutive Edit of the same file)
      // appears multiple times, the plain findMergedHistoryAnchor always
      // returns the FIRST match, which clusters every interleaved thought onto
      // that first tool and groups all identical tools together. Instead,
      // match by ordinal: the Nth occurrence in the snapshot maps to the Nth
      // occurrence in the merged timeline, restoring the interleave.
      function findMergedToolAnchorOrdinal(mergedArr, snapTool, snapArr, snapIndex) {
        var key = toolAnchorKey(snapTool);
        if (!key) return findMergedHistoryAnchor(mergedArr, snapTool);
        // If only one occurrence of this tool exists in merged, the plain
        // matcher is already exact.
        var mergedCount = 0;
        for (var i = 0; i < mergedArr.length; i++) {
          if (mergedArr[i] && mergedArr[i].kind === 'toolCall' && toolAnchorKey(mergedArr[i]) === key) mergedCount++;
        }
        if (mergedCount <= 1) return findMergedHistoryAnchor(mergedArr, snapTool);
        var ordinal = toolOrdinalThrough(snapArr, snapIndex, key);
        if (ordinal <= 0) return findMergedHistoryAnchor(mergedArr, snapTool);
        var idx = nthToolIndex(mergedArr, ordinal, key);
        if (idx >= 0) return idx;
        // Fallback if the snapshot has more occurrences than merged (loaded
        // replay dropped some): clamp to the last available occurrence.
        return nthToolIndex(mergedArr, mergedCount, key);
      }

      function insertSnapshotItem(snapItem, snapIndex) {
        // Thoughts belong BEFORE the next snapshot row already present in merged
        // (e.g. the tool call they precede). Backward-only anchoring after the
        // previous tool made thoughts appear after tools in the fold.
       if (snapItem.kind === 'thought') {
         for (var after = snapIndex + 1; after < snapshot.length; after++) {
           var next = snapshot[after];
           if (!next) continue;
           // STOP at user-turn boundaries: a thought must only anchor to items
           // within its OWN turn. Without this, a thought from turn 2 could be
           // inserted before a tool from turn 5 if the snapshot's turn 2 tools
           // were not replayed by session/load.
           if (next.kind === 'message' && next.role === 'user' &&
               !isSessionInterruptNotice(next.text)) {
             break;
           }
           if (next.kind === 'message' && (next.role === 'system' || next.role === 'user') &&
               isSessionInterruptNotice(next.text)) {
             continue;
           }
           var nextAnchor = findMergedHistoryAnchor(merged, next);
           // The thought anchors BEFORE this next tool. If the next tool is a
           // duplicate (several identical Edit of the same file), a plain
           // first-match would place the thought before the FIRST edit instead
           // of the edit that actually follows it in the snapshot. Anchor by
           // ordinal so the thought lands immediately before the right edit.
           if (next.kind === 'toolCall') {
             nextAnchor = findMergedToolAnchorOrdinal(merged, next, snapshot, after);
           }
           if (nextAnchor >= 0) {
             merged.splice(nextAnchor, 0, Object.assign({}, snapItem));
             return;
           }
         }
       }

       // ASSISTANT messages: anchor BEFORE the next snapshot item in the SAME
       // turn (the tool/thought that follows them in the snapshot), using
       // ordinal matching for duplicate tools. This fixes two resume symptoms:
       //  (1) "assistant msg + tool call grouped together" — when the loaded
       //      replay dropped the assistant (exact-text findMergedHistoryAnchor
       //      fails), the old backward walk anchored it after a nearby tool,
       //      landing it INSIDE that tool's fold group.
       //  (2) "some assistant msg not ordered" — the backward walk could skip
       //      over intermediate assistants/tools absent from merged, placing
       //      the orphan assistant after items that should follow it.
       // Anchoring immediately before the FOLLOWING snapshot tool/thought keeps
       // the assistant adjacent to its own tool and in turn order.
       if (snapItem.kind === 'message' && snapItem.role === 'assistant') {
         var _asstLogText = String(snapItem.text || '').trim().slice(0, 60);
         for (var aAfter = snapIndex + 1; aAfter < snapshot.length; aAfter++) {
           var aNext = snapshot[aAfter];
           if (!aNext) continue;
           // STOP at user-turn boundaries (and interrupt notices are skipped).
           if (aNext.kind === 'message' && aNext.role === 'user' &&
               !isSessionInterruptNotice(aNext.text)) {
             break;
           }
           if (aNext.kind === 'message' && (aNext.role === 'system' || aNext.role === 'user') &&
               isSessionInterruptNotice(aNext.text)) {
             continue;
           }
           // Skip over the assistant's OWN trailing thoughts (they follow it in
           // the snapshot) — anchor to the first tool/other-assistant after it.
           var aAnchor = aNext.kind === 'toolCall'
             ? findMergedToolAnchorOrdinal(merged, aNext, snapshot, aAfter)
             : findMergedHistoryAnchor(merged, aNext);
           if (aAnchor >= 0) {
             merged.splice(aAnchor, 0, Object.assign({}, snapItem));
             if (typeof resumeDiag === 'function') resumeDiag('[WV-DIAG] insertSnapshotItem(assistant): snapIdx=' + snapIndex +
               ' anchored BEFORE next=' + (aNext.kind + (aNext.role ? ':' + aNext.role : '')) +
               ' at merged[' + aAnchor + '] text="' + _asstLogText + '"');
             return;
           }
         }
         // No forward anchor found in the same turn — fall through to the
         // generic backward/forward walk below.
         if (typeof resumeDiag === 'function') resumeDiag('[WV-DIAG] insertSnapshotItem(assistant): snapIdx=' + snapIndex +
           ' NO forward anchor in turn, falling back to generic walk text="' + _asstLogText + '"');
         // …unless nothing follows it in the snapshot at all. Then it IS the
         // final reply of the last turn and belongs at the very end. The generic
         // walk anchors backward, which put it in the middle of the history when
         // a same-titled tool matched earlier — and the corrupted position then
         // became the next resume's snapshot, so the summary never came back.
         var _hasLaterSnapItem = false;
         for (var aTail = snapIndex + 1; aTail < snapshot.length; aTail++) {
           var aTailItem = snapshot[aTail];
           if (!aTailItem) continue;
           if (aTailItem.kind === 'message' && (aTailItem.role === 'system' || aTailItem.role === 'user') &&
               isSessionInterruptNotice(aTailItem.text)) {
             continue;
           }
           _hasLaterSnapItem = true;
           break;
         }
         if (!_hasLaterSnapItem) {
           merged.push(Object.assign({}, snapItem));
           if (typeof resumeDiag === 'function') resumeDiag('[WV-DIAG] insertSnapshotItem(assistant): snapIdx=' + snapIndex +
             ' trailing reply — appended at merged[' + (merged.length - 1) + '] text="' + _asstLogText + '"');
           return;
         }
       }

       var insertAt = merged.length;
       for (var before = snapIndex - 1; before >= 0; before--) {
         var prev = snapshot[before];
         if (!prev) continue;
         // STOP at user-turn boundaries: when walking backward to find an
         // anchor, we must NOT cross into a previous user turn. Without this,
         // a tool call from turn 3 (not replayed by session/load) would be
         // anchored after an assistant message from turn 1, placing it in the
         // wrong turn group. reconcileInterleavedOrderFromSnapshot only sorts
         // within user-message buckets, so items in the wrong bucket stay there.
         if (prev.kind === 'message' && prev.role === 'user' &&
             !isSessionInterruptNotice(prev.text)) {
           break;
         }
         if (prev.kind === 'message' && (prev.role === 'system' || prev.role === 'user') &&
             isSessionInterruptNotice(prev.text)) {
           continue;
         }
         // The ordinal must be that of the ANCHOR tool (index 'before'), not of
         // the item being inserted. Passing snapIndex counted every later
         // occurrence too, so a tool from the LAST turn mapped onto a
         // same-titled tool in the middle of the history and the trailing final
         // reply was spliced in there (measured: snapshot[249] → merged[81]).
         var anchor = prev.kind === 'toolCall'
           ? findMergedToolAnchorOrdinal(merged, prev, snapshot, before)
           : findMergedHistoryAnchor(merged, prev);
         if (anchor >= 0) {
           insertAt = anchor + 1;
           break;
         }
       }
       // If no backward anchor was found, try a forward anchor: the next
       // snapshot item that IS in the merged timeline. Insert before it.
       // This prevents items from earlier turns (whose neighbours are all
       // absent from the compacted loaded timeline) from being appended
       // at the tail — after the end_turn summary.
       if (insertAt === merged.length) {
         for (var after2 = snapIndex + 1; after2 < snapshot.length; after2++) {
           var nextItem = snapshot[after2];
           if (!nextItem) continue;
           // STOP at user-turn boundaries in forward walk too: a tool call
           // from turn 2 must not anchor to an item in turn 4.
           if (nextItem.kind === 'message' && nextItem.role === 'user' &&
               !isSessionInterruptNotice(nextItem.text)) {
             break;
           }
           if (nextItem.kind === 'message' && (nextItem.role === 'system' || nextItem.role === 'user') &&
               isSessionInterruptNotice(nextItem.text)) {
             continue;
           }
           var fwdAnchor = nextItem.kind === 'toolCall'
             ? findMergedToolAnchorOrdinal(merged, nextItem, snapshot, after2)
             : findMergedHistoryAnchor(merged, nextItem);
           if (fwdAnchor >= 0) {
             insertAt = fwdAnchor;
             break;
           }
         }
       }
       // If still no anchor found (neither backward nor forward), skip
       // the item — the loaded timeline has no reference point for it.
       // Exception: if there are no more snapshot items after this one
       // (i.e. this is in the last turn), appending at the tail IS correct
       // — the loaded timeline's tail is also the last turn.
       var hasMoreSnapshotItems = false;
       for (var _hsi = snapIndex + 1; _hsi < snapshot.length; _hsi++) {
         if (snapshot[_hsi]) { hasMoreSnapshotItems = true; break; }
       }
       if (insertAt === merged.length && hasMoreSnapshotItems) {
         return;
       }
       merged.splice(insertAt, 0, Object.assign({}, snapItem));
       if (snapItem.kind === 'message' && snapItem.role === 'assistant') {
         if (typeof resumeDiag === 'function') resumeDiag('[WV-DIAG] insertSnapshotItem(assistant): snapIdx=' + snapIndex +
           ' generic-walk inserted at merged[' + insertAt + '] (tail=' + (insertAt === merged.length - 1) +
           ') text="' + String(snapItem.text || '').trim().slice(0, 60) + '"');
       }
     }


      function reconcileInterleavedOrderFromSnapshot() {
        var rebuilt = [];
        var bucket = [];
        function flushBucket() {
          if (!bucket.length) return;
          // Key every row ONCE, walking the bucket in merged order.
          //
          // Rows that came from the agent's session/load replay keep their
          // REPLAY order — the replay is the transcript chronology, so it is
          // authoritative for anything it contains. Snapshot-ONLY rows (thoughts
          // that the agent does not replay, assistants missing from a compacted
          // replay) inherit the key of the row they were anchored after, +0.5,
          // so they stay exactly where insertSnapshotItem placed them.
          //
          // This previously scored EVERY row with snapshotOrderIndex, which made
          // the webview snapshot authoritative for intra-turn order. Two ways
          // that broke a correct replay:
          //   1. a row whose snapshot slot was missing scored MAX_SAFE_INTEGER
          //      and sank behind every matched row;
          //   2. when slots did match, the snapshot's order was re-imposed
          //      verbatim over the replay's.
          // Either way the result is persisted by saveState, so a wrong order
          // became the next snapshot and was re-imposed on every later resume.
          // Symptom: an codex turn replayed as tool→text→tool→text rendered as
          // one leading tool block followed by every reply ("grouped per
          // section instead of interleaved").
          //
          // Duplicate same-title tools no longer need ordinal slot claiming
          // here: they carry distinct replay positions, and the thoughts spliced
          // between them by insertSnapshotItem inherit the preceding tool's key.
          var decorated = [];
          var lastKnownKey = -1;
          for (var bi = 0; bi < bucket.length; bi++) {
            var bRow = bucket[bi];
            var bKey;
            if (bRow && loadedOrder.has(bRow)) {
              bKey = loadedOrder.get(bRow);
              lastKnownKey = bKey;
            } else {
              bKey = lastKnownKey + 0.5;
            }
            decorated.push({ row: bRow, key: bKey, idx: bi });
          }
          decorated.sort(function(a, b) {
            if (a.key !== b.key) return a.key - b.key;
            // Equal keys keep merged order (consecutive snapshot-only rows).
            return a.idx - b.idx;
          });
          for (var di = 0; di < decorated.length; di++) rebuilt.push(decorated[di].row);
          bucket = [];
        }
        // Interrupt notices are turn artefacts, not real user prompts — they
        // must act as BOUNDARIES in the merged timeline, not as bucket content.
        // They also delimit turns for reconcileInterruptedSessionFlag →
        // applyInterruptNoticesFromHistory: swallowed into a bucket, a notice
        // could end up after the turn's final assistant, branding a FINISHED
        // reply as interrupted so the collapsed title reads "Interrupted"
        // after a normal reload + resume.
        for (var ri = 0; ri < merged.length; ri++) {
          var row = merged[ri];
          // System and error messages act as turn boundaries (they reset
          // the turn in renderChatHistory), so they must also act as
          // bucket boundaries here — a bucket must never span two turns.
          if (row && row.kind === 'message' && (row.role === 'user' || row.role === 'system' || row.role === 'error')) {
            flushBucket();
            rebuilt.push(row);
          } else {
            bucket.push(row);
          }
        }
        flushBucket();
        merged.length = 0;
        Array.prototype.push.apply(merged, rebuilt);
      }

      for (var ti = 0; ti < snapshot.length; ti++) {
        var snapItem = snapshot[ti];
        if (!snapItem) continue;
        if (snapItem.kind === 'message' && (snapItem.role === 'system' || snapItem.role === 'user') &&
            isSessionInterruptNotice(snapItem.text)) {
          continue;
        }
        if (snapItem.kind === 'thought') {
          var tk = thoughtPrefixKey(snapItem.text);
          if (!tk || mergedThoughtKeys[tk]) continue;
          insertSnapshotItem(snapItem, ti);
          mergedThoughtKeys[tk] = true;
          continue;
        }
       if (snapItem.kind === 'message' && snapItem.role === 'assistant') {
         var ak = String(snapItem.text || '').trim();
         if (!ak || mergedAsstKeys[ak]) continue;
         // A turn has ONE final reply. When this snapshot assistant is the
         // TERMINAL assistant of its snapshot turn and the merged timeline's
         // corresponding turn ALREADY ends with a terminal assistant, the
         // loaded replay is authoritative for the final reply — skip the
         // snapshot copy. Otherwise (the merged turn ends with a tool or has
         // no assistant) the snapshot supplies the final reply.
         //
         // Without this, session/load resume left TWO assistant messages in
         // the last turn whenever the loaded replay's final text differed
         // from the webview snapshot's (e.g. Codex compacts the reply):
         // collapsed mode promoted the wrong (shorter) copy, expand showed
         // both copies, and collapsing again re-promoted the trailing copy.
         if (snapshotAssistantHasMergedCounterpart(merged, snapItem, ti, snapshot)) {
           if (typeof resumeDiag === 'function') resumeDiag('[WV-DIAG] main-loop(assistant): snapIdx=' + ti +
             ' SKIPPED (loaded replay has terminal counterpart) text="' + ak.slice(0, 60) + '"');
           continue;
         }
         insertSnapshotItem(snapItem, ti);
         mergedAsstKeys[ak] = true;
         if (typeof resumeDiag === 'function') resumeDiag('[WV-DIAG] main-loop(assistant): snapIdx=' + ti +
           ' inserted (snapshot assistant not in loaded replay) text="' + ak.slice(0, 60) + '"');
       }

       /**
        * True when this snapshot assistant is the terminal reply of its
        * snapshot turn AND the merged timeline's corresponding turn already
        * ends with a terminal assistant (its last meaningful item — ignoring
        * trailing thoughts — is an assistant, i.e. no tool call follows it).
        * In that case the loaded (agent replay) copy wins and the snapshot
        * copy must not be re-inserted. Mid-turn interim assistants (followed
        * by tools / another assistant) are never suppressed.
        */
       function snapshotAssistantHasMergedCounterpart(merged, snapItem, snapIndex, snapshot) {
         // Snapshot side: terminal only if no assistant follows within the turn.
         for (var s2 = snapIndex + 1; s2 < snapshot.length; s2++) {
           var nx = snapshot[s2];
           if (!nx) continue;
           if (nx.kind === 'message' && (nx.role === 'user' || nx.role === 'system' || nx.role === 'error')) break;
           if (nx.kind === 'message' && nx.role === 'assistant') return false;
         }
         // Preceding user/system/error boundary in the snapshot.
         var snapBase = -1;
         for (var b2 = snapIndex - 1; b2 >= 0; b2--) {
           var pb = snapshot[b2];
           if (!pb) continue;
           if (pb.kind === 'message' && (pb.role === 'user' || pb.role === 'system' || pb.role === 'error')) {
             snapBase = b2;
             break;
           }
         }
         // Walk the merged timeline to the matching turn and check whether it
         // ends with a terminal assistant (no tool call after the last one).
         var seenTurn = snapBase < 0;
         var lastMeaningfulWasAsst = false;
         for (var m3 = 0; m3 < merged.length; m3++) {
           var mm = merged[m3];
           if (!mm) continue;
           if (!seenTurn) {
             if (mm.kind === snapshot[snapBase].kind && mm.role === snapshot[snapBase].role &&
                 String(mm.text || '').trim() === String(snapshot[snapBase].text || '').trim()) {
               seenTurn = true;
             }
             continue;
           }
           if (mm.kind === 'message' && (mm.role === 'user' || mm.role === 'system' || mm.role === 'error')) break;
           if (mm.kind === 'toolCall') lastMeaningfulWasAsst = false;
           if (mm.kind === 'thought') { /* ignore trailing thoughts */ }
           if (mm.kind === 'message' && mm.role === 'assistant') lastMeaningfulWasAsst = true;
         }
         return lastMeaningfulWasAsst;
       }
        if (snapItem.kind === 'toolCall') {
          // Merge snapshot tool calls that are NOT already in the loaded
          // timeline. Codex's session/load may only replay a subset of
          // tool calls (compacted or limited history), so the snapshot
          // can contain tool calls the loaded timeline is missing.
          var snapToolId = snapItem.toolCallId;
          var snapToolTitle = String(snapItem.title || '').trim();
          var toolAlreadyMerged = false;
          for (var _mt = 0; _mt < merged.length; _mt++) {
            var _mItem = merged[_mt];
            if (!_mItem || _mItem.kind !== 'toolCall') continue;
            if (snapToolId && _mItem.toolCallId === snapToolId) { toolAlreadyMerged = true; break; }
            if (snapToolTitle && String(_mItem.title || '').trim() === snapToolTitle) { toolAlreadyMerged = true; break; }
          }
          if (!toolAlreadyMerged) {
            insertSnapshotItem(snapItem, ti);
          }
        }
      }

      reconcileInterleavedOrderFromSnapshot();
      return merged;
    }

    function userMessageKey(text) {
      var cleaned = cleanUserMessage(String(text || ''));
      if (String(cleaned || '').trim()) return String(cleaned).trim();
      return String(text || '').trim();
    }

    /**
     * Full snapshot merge can drop earlier user prompts (compaction / interrupted
     * save). session/load still replays them — re-inject so renderChatHistory keeps
     * correct per-turn boundaries.
     */
    function mergeMissingUsersFromLoaded(merged, loaded) {
      if (!merged || !loaded || !loaded.length) return 0;
      var loadedUsers = realUserEntries(loaded);
      var mergedUsers = realUserEntries(merged);
      if (loadedUsers.length === 0) return 0;

      var mergedUserKeys = {};
      for (var mu = 0; mu < mergedUsers.length; mu++) {
        var mk = userMessageKey(mergedUsers[mu].item.text);
        if (mk) mergedUserKeys[mk] = true;
      }

      var injected = 0;
      for (var u = 0; u < loadedUsers.length; u++) {
        var lu = loadedUsers[u];
        var userKey = userMessageKey(lu.item.text);
        if (!userKey) continue;

        // Same ordinal slot but different text — loaded (session/load) wins.
        if (u < mergedUsers.length) {
          var mergedKey = userMessageKey(mergedUsers[u].item.text);
          if (mergedKey !== userKey) {
            merged[mergedUsers[u].index] = Object.assign({}, lu.item);
            mergedUserKeys[userKey] = true;
            injected++;
          }
          continue;
        }

        if (mergedUserKeys[userKey]) continue;

        var insertBefore = merged.length;
        for (var lk = lu.index + 1; lk < loaded.length; lk++) {
          var afterItem = loaded[lk];
          if (!afterItem) continue;
          if (afterItem.kind === 'message' && afterItem.role === 'user' &&
              !isSessionInterruptNotice(afterItem.text)) {
            break;
          }
          var anchorIdx = findMergedHistoryAnchor(merged, afterItem);
          if (anchorIdx >= 0) {
            insertBefore = anchorIdx;
            break;
          }
        }
        merged.splice(insertBefore, 0, Object.assign({}, lu.item));
        mergedUserKeys[userKey] = true;
        injected++;
      }
      return injected;
    }

    /**
     * Legacy text-scan user injection — kept for snapshot-first path when ordinal
     * counts already match but specific prompts differ by text.
     */
    function mergeMissingUsersFromLoadedByText(merged, loaded) {
      if (!merged || !loaded || !loaded.length) return 0;
      var mergedUserTexts = {};
      for (var mu = 0; mu < merged.length; mu++) {
        var mergedUser = merged[mu];
        if (mergedUser && mergedUser.kind === 'message' && mergedUser.role === 'user' &&
            !isSessionInterruptNotice(mergedUser.text)) {
          var mk = userMessageKey(mergedUser.text);
          if (mk) mergedUserTexts[mk] = true;
        }
      }
      var injected = 0;
      for (var li = 0; li < loaded.length; li++) {
        var loadedItem = loaded[li];
        if (!loadedItem || loadedItem.kind !== 'message' || loadedItem.role !== 'user' ||
            isSessionInterruptNotice(loadedItem.text)) {
          continue;
        }
        var userText = userMessageKey(loadedItem.text);
        if (!userText || mergedUserTexts[userText]) continue;

        var insertBefore = merged.length;
        for (var lk = li + 1; lk < loaded.length; lk++) {
          var afterItem = loaded[lk];
          if (!afterItem) continue;
          if (afterItem.kind === 'message' && afterItem.role === 'user' &&
              !isSessionInterruptNotice(afterItem.text)) {
            break;
          }
          var anchorIdx = findMergedHistoryAnchor(merged, afterItem);
          if (anchorIdx >= 0) {
            insertBefore = anchorIdx;
            break;
          }
        }
        merged.splice(insertBefore, 0, Object.assign({}, loadedItem));
        mergedUserTexts[userText] = true;
        injected++;
      }
      return injected;
    }

    /**
     * Loaded-first overlay keeps ONLY the loaded history's user rows and drops
     * the snapshot's user messages when session/load replays a SPARSER history
     * (e.g. agent-side compaction or a truncated transcript). The snapshot is
     * what the user actually saw, so re-inject snapshot user rows that are
     * missing from the merged history. Anchors each inserted user row before
     * the first tool/assistant that follows it in the SNAPSHOT (falling back to
     * appending at the tail for the last turn). Returns the number injected.
     */
    function mergeMissingUsersFromSnapshot(merged, snapshot) {
      if (!merged || !snapshot || !snapshot.length) return 0;
      var snapUsers = realUserEntries(snapshot);
      if (!snapUsers.length) return 0;

      var mergedUserKeys = {};
      for (var mu = 0; mu < merged.length; mu++) {
        var mIt = merged[mu];
        if (mIt && mIt.kind === 'message' && mIt.role === 'user' && !isSessionInterruptNotice(mIt.text)) {
          var mk = userMessageKey(mIt.text);
          if (mk) mergedUserKeys[mk] = true;
        }
      }

      var injected = 0;
      for (var u = 0; u < snapUsers.length; u++) {
        var su = snapUsers[u];
        var userKey = userMessageKey(su.item.text);
        if (!userKey) continue;

        // Skip interrupt notices / machine-context-only rows.
        if (isSessionInterruptNotice(su.item.text)) continue;
        if (isMachineContextOnly(String(su.item.text || ''))) continue;
        if (mergedUserKeys[userKey]) continue;

        // Anchor: insert before the first snapshot row AFTER this user that is
        // present in the merged history (its own turn's tool/assistant). If none
        // found (last turn), append at the tail.
        var insertBefore = merged.length;
        for (var sk = su.index + 1; sk < snapshot.length; sk++) {
          var afterItem = snapshot[sk];
          if (!afterItem) continue;
          // Stop at the next user-turn boundary: a row from a later turn must
          // not anchor this user's prompt into that turn.
          if (afterItem.kind === 'message' && afterItem.role === 'user' &&
              !isSessionInterruptNotice(afterItem.text)) {
            break;
          }
          var anchorIdx = findMergedHistoryAnchor(merged, afterItem);
          if (anchorIdx >= 0) {
            insertBefore = anchorIdx;
            break;
          }
        }
        merged.splice(insertBefore, 0, Object.assign({}, su.item));
        mergedUserKeys[userKey] = true;
        injected++;
      }
      return injected;
    }

    /**
     * Claude session/load often drops an interrupted mid-turn (tools never
     * flushed to the agent transcript). Re-inject the last turn from the
     * pre-load webview snapshot — including the user prompt when Claude only
     * replayed "[Request interrupted by user]".
     */
    function mergePreLoadInterruptedTurn(snapshot) {
      if (!snapshot || !snapshot.length) return false;

      var snapUserIdx = -1;
      for (var j = snapshot.length - 1; j >= 0; j--) {
        var s = snapshot[j];
        if (s && s.kind === 'message' && s.role === 'user' && !isSessionInterruptNotice(s.text)) {
          snapUserIdx = j;
          break;
        }
      }
      if (snapUserIdx < 0) return false;
      var snapUserText = String(snapshot[snapUserIdx].text || '').trim();
      if (!snapUserText) return false;

      var loadedLastUserIdx = -1;
      for (var i = chatHistory.length - 1; i >= 0; i--) {
        var it = chatHistory[i];
        if (it && it.kind === 'message' && it.role === 'user' && !isSessionInterruptNotice(it.text) &&
            String(it.text || '').trim() === snapUserText) {
          loadedLastUserIdx = i;
          break;
        }
      }

      function failToolCopy(item) {
        var toolCopy = Object.assign({}, item, { status: 'failed' });
        if (toolCopy.rawInput && typeof toolCopy.rawInput === 'object' &&
            Array.isArray(toolCopy.rawInput.stages)) {
          toolCopy.rawInput = Object.assign({}, toolCopy.rawInput, {
            stages: toolCopy.rawInput.stages.map(function(st) {
              if (!st || typeof st !== 'object') return st;
              return Object.assign({}, st, { status: 'failed' });
            }),
          });
        }
        return toolCopy;
      }

      function collectSnapTurn(includeUser) {
        var items = [];
        for (var m = snapUserIdx; m < snapshot.length; m++) {
          var item = snapshot[m];
          if (!item) continue;
          if (m > snapUserIdx && item.kind === 'message' && item.role === 'user' &&
              !isSessionInterruptNotice(item.text)) {
            break;
          }
          if (item.kind === 'message' && item.role === 'user') {
            if (isSessionInterruptNotice(item.text)) {
              items.push({ kind: 'message', role: 'user', text: String(item.text).trim() });
            } else if (includeUser) {
              items.push(Object.assign({}, item));
            }
            continue;
          }
          if (item.kind === 'toolCall') {
            items.push(failToolCopy(item));
            continue;
          }
          if (item.kind === 'thought') {
            items.push(item);
            continue;
          }
          if (item.kind === 'message' && item.role === 'assistant') {
            // Only mark as interrupted if the original snapshot item was
            // already interrupted — don't fabricate interruption for a
            // completed turn that just wasn't fully replayed.
            items.push(Object.assign({}, item, { interrupted: item.interrupted || false }));
          }
        }
        return items;
      }

      // Claude replayed only the interrupt notice (or nothing) — restore the
      // whole last turn so the real user prompt is visible again.
      if (loadedLastUserIdx < 0) {
        var restored = collectSnapTurn(true);
        if (!restored.length) return false;
        var prefix = [];
        for (var p = 0; p < chatHistory.length; p++) {
          var ch = chatHistory[p];
          if (ch && ch.kind === 'message' && ch.role === 'user' && isSessionInterruptNotice(ch.text)) {
            continue;
          }
          prefix.push(ch);
        }
        chatHistory = prefix.concat(restored);
        // Only mark as interrupted if the restored turn has no assistant
        // reply or has running/in-flight tools. A finished turn (with
        // assistant reply and only completed/failed tools) is NOT interrupted.
        var _restoredHasAssistant = restored.some(function(x) {
          return x.kind === 'message' && x.role === 'assistant' && !x.interrupted;
        });
        if (!_restoredHasAssistant) {
          markSessionInterrupted();
        }
        vscode.postMessage({
          type: 'debugLog',
          message: '[WV-MERGE] restored full turn from snapshot (incl. user prompt), items=' + restored.length + ' interrupted=' + (!_restoredHasAssistant),
        });
        return true;
      }

      var haveIds = {};
      var loadedToolCount = 0;
      var insertAt = chatHistory.length;
      // Collect assistant message texts already present in the loaded
      // chatHistory (after the matched user message) so we can skip
      // them in the snapshot — prevents duplicate assistant summaries
      // when session/load replay already delivered agent_message_chunk.
      var loadedAssistantTexts = {};
      // Same for thoughts. Without this the merge re-added EVERY snapshot
      // thought of the turn, even the ones session/load had just replayed, and
      // spliced them in as one contiguous block at the end of the turn — the
      // "thinking blocks are grouped at the bottom, right before the summary"
      // symptom (a Kiro resume re-added 24 duplicate thoughts that way).
      var loadedThoughtKeys = {};
      for (var k = loadedLastUserIdx + 1; k < chatHistory.length; k++) {
        var cur = chatHistory[k];
        if (!cur) continue;
        if (cur.kind === 'message' && cur.role === 'user') {
          insertAt = k;
          break;
        }
        if (cur.kind === 'toolCall') {
          loadedToolCount++;
          if (cur.toolCallId) haveIds[cur.toolCallId] = true;
        }
        if (cur.kind === 'thought' && cur.text) {
          loadedThoughtKeys[thoughtPrefixKey(cur.text)] = true;
        }
        if (cur.kind === 'message' && cur.role === 'assistant' && cur.text) {
          loadedAssistantTexts[String(cur.text).trim()] = true;
        }
      }

      var missing = collectSnapTurn(false).filter(function(item) {
        if (item.kind === 'toolCall') {
          if (item.toolCallId && haveIds[item.toolCallId]) return false;
          return true;
        }
        if (item.kind === 'message' && item.role === 'user' && isSessionInterruptNotice(item.text)) {
          return false;
        }
        if (item.kind === 'thought') {
          // Only thoughts the replay did NOT deliver. Keyed on the first 120
          // chars so a streamed/truncated copy still matches.
          var _snapThoughtKey = item.text ? thoughtPrefixKey(item.text) : '';
          if (_snapThoughtKey && loadedThoughtKeys[_snapThoughtKey]) return false;
          return true;
        }
        if (item.kind === 'message' && item.role === 'assistant') {
          // Skip if this assistant text is already in the loaded chatHistory
          // (session/load replay delivered the agent_message_chunk).
          var snapText = String(item.text || '').trim();
          if (snapText && loadedAssistantTexts[snapText]) return false;
          return true;
        }
        return false;
      });
      if (!missing.length) return false;
      var missingTools = missing.filter(function(x) { return x.kind === 'toolCall'; });
      // Codex session/load only replays tool_calls + user_messages — not
      // agent_thought_chunk or agent_message_chunk. So even when all tools
      // are already loaded, we must still merge missing thoughts and
      // assistant messages from the snapshot. Only skip when there's truly
      // nothing missing.
      if (loadedToolCount > 0 && missingTools.length === 0 &&
          !missing.some(function(x) {
            return x.kind === 'thought' || (x.kind === 'message' && x.role === 'assistant');
          })) return false;
     if (loadedToolCount > 0 && missingTools.length > 0 &&
          missingTools.every(function(t) { return t.toolCallId && haveIds[t.toolCallId]; })) {
        return false;
      }
      if (loadedToolCount === 0 && missingTools.length === 0 &&
          !missing.some(function(x) {
            return x.kind === 'thought' || (x.kind === 'message' && x.role === 'assistant');
          })) {
        return false;
      }
      Array.prototype.splice.apply(chatHistory, [insertAt, 0].concat(missing));
      // Only mark interrupted if the merged items include an interrupted
      // assistant or running tools. Merging a completed assistant from
      // snapshot is NOT an interruption.
      var _mergeHasInterrupted = missing.some(function(x) {
        return (x.kind === 'message' && x.role === 'assistant' && x.interrupted) ||
               (x.kind === 'toolCall' && (x.status === 'running' || x.status === 'in_progress' || x.status === 'pending'));
      });
      if (_mergeHasInterrupted) {
        markSessionInterrupted();
      }
      vscode.postMessage({
        type: 'debugLog',
        message: '[WV-MERGE] restored ' + missing.length + ' pre-load item(s) into turn (tools=' + missingTools.length +
          ' thoughts=' + missing.filter(function(x) { return x.kind === 'thought'; }).length +
          ' interrupted=' + _mergeHasInterrupted + ')',
      });
      return true;
    }

 function handleLoadSessionStart() {
   if (isLoadingSession) {
     vscode.postMessage({ type: 'debugLog', message: 'handleLoadSessionStart: ignored duplicate (already loading)' });
     return;
   }
   vscode.postMessage({ type: 'debugLog', message: 'handleLoadSessionStart' });
   // Cancel all pending render retries from restoreState — the DOM is
   // about to be wiped and rebuilt, so stale renderMarkdown requests
   // would target wrong elements.
   for (var _rk in pendingRenderRetries) { delete pendingRenderRetries[_rk]; }
   dismissPsPanel(true);
    isLoadingSession = true;
    // Arm the replay-tail window NOW, not at load end. showSessionConnected
    // clears isLoadingSession as soon as the session/load response resolves —
    // before handleLoadSessionEnd runs — so a final chunk arriving in that gap
    // saw isLoadingSession=false AND loadTailGrace=false and was dropped
    // (measured: [WV-CHUNK-DROP] 205 ms BEFORE handleLoadSessionEnd). Every
    // replay update refreshes the window, so it always extends past the replay.
    loadTailGraceUntil = Date.now() + LOAD_TAIL_GRACE_MS;
    replayRecvSeq = 0;
    // A historical "Context compacted" tool_call during session/load must NOT
    // leave isCompacting stuck true — that silently blocks handleSend().
    isCompacting = false;
    manualCompacting = false;
    isClearing = false;
    // A session switch (e.g. kiro → codex) must not inherit the previous
    // agent's image-support state. Clear it so updateAttachButtonVisibility
    // defaults to hidden until the new session's state arrives — otherwise a
    // switch from a vision-capable kiro session (opus 5) to a text-only codex
    // model (deepseek-v4-flash) kept the image attach button visible.
    if (sessionState) {
      sessionState.currentModelImageSupport = undefined;
      if (sessionState.promptCapabilities) sessionState.promptCapabilities = undefined;
    }
    compactedWarningText = '';
    compactedNoticeText = '';
    if (compactionFlushTimer) { clearTimeout(compactionFlushTimer); compactionFlushTimer = null; }
    pendingPostCompactChunks = []; // session is being rebuilt — discard stale resume tokens
    hideCompactionProgress();
    tokenUsage = null;
     hasSentPrompt = false;
     hasSteeredThisTurn = false;
     isSendingPrompt = false;
    if (tokenUsageRing) tokenUsageRing.classList.remove('visible');
    if (typeof clearCursorTodosPlan === 'function') clearCursorTodosPlan();
      // Keep a copy of the restored webview history. Claude session/load for an
     // interrupted mid-turn often only replays the user prompt — without this
     // snapshot (and without saveState of the empty array) the collapse block
     // permanently disappears after VS Code restart.
     preLoadChatHistorySnapshot = chatHistory.slice();
    // Label the snapshot with the session ID that the chatHistory belongs to.
    // chatHistoryOriginSessionId tracks the session whose chatHistory was
    // either restored from saveState (resume after restart) or built live
    // (switching between sessions). This correctly handles:
    // - Resume after restart: chatHistoryOriginSessionId = the saved session
    //   (from restoreState), even though previousSessionId is a temp session
    //   created by connectToAgent.
    // - Session switch (A→B): chatHistoryOriginSessionId = A (the previously
    //   displayed session), which won't match B — merge is correctly skipped.
    preLoadSnapshotSessionId = chatHistoryOriginSessionId || previousSessionId || null;
    // Keep the outgoing session's history so switching BACK to it can still
    // repair a lossy replay (see sessionHistoryArchive).
    archiveSessionHistory(preLoadSnapshotSessionId, preLoadChatHistorySnapshot);
    // Reset all chat state; behaves like clearChat but keeps the session
    // banner / input area structure intact.
    chatHistory = [];
      // Do NOT saveState() here — persisting [] would erase tools that Claude
      // will not replay. saveState runs after loadSessionEnd merge instead.
      currentAssistantEl = null;
      currentAssistantText = '';
      currentMessageId = null;
      lastCommittedAssistantEl = null;
      lastCommittedMessageId = null;
      lastCommittedText = '';
      reactivatedHistoryIndex = -1;
      toolCalls = {};
      toolCallDiffs = {};
      currentTurnEl = null;
      currentToolsListEl = null;
      currentToolsCountEl = null;
      currentToolCount = 0;
      currentThoughtEl = null;
      currentThoughtTextEl = null;
      currentThoughtText = '';
      thoughtDomBase = '';
      thoughtStartTime = null;
      thoughtEndTime = null;
      messagesEl.innerHTML = '';
      if (emptyState) {
        messagesEl.appendChild(emptyState);
        emptyState.style.display = 'none';
      }
      if (loadOverlay) loadOverlay.classList.add('visible');
      if (inputArea) inputArea.classList.add('disabled');
      promptInput.disabled = false; // keep textarea editable during load
      setProcessing(false, 'handleLoadSessionStart');
    }

  function handleLoadSessionEnd(ok) {
   resetResumeConnectUi();
   hideEmpty();
   isLoadingSession = false;
   // Commit the replay's trailing reply BEFORE anything merges the snapshot.
   //
   // The agent's final agent_message_chunk arrives at the very end of the
   // replay and only lives in currentAssistantText until something commits it.
   // The full-snapshot merge below used to run first and then DISCARD that text
   // ("it is already in the snapshot") — which is false once the snapshot itself
   // holds the reply in the wrong place: a previous resume had spliced it into
   // an earlier turn, so the merge kept the bad position (merged[81]) and threw
   // away the authoritative copy. Committing first makes the loaded timeline —
   // which is in true wire order — end with the reply, and the snapshot's stale
   // copy is then skipped by the merge's text dedup.
   if (currentAssistantText) {
     vscode.postMessage({ type: 'debugLog', message:
       '[WV-LOAD-TAIL] committing replay tail reply before merge (len=' + currentAssistantText.length + ')' });
     finalizeCurrentAssistantTurn();
   }
   // The live snapshot belongs to whatever session was last on screen. When
   // that is NOT the session we just loaded (A → B → A switch), fall back to
   // this session's archived history so the merge below can still restore what
   // the agent's replay dropped — for Kiro that is every end-of-turn reply,
   // which is why a resumed session came back with its summary missing.
   var _archiveCurId = (sessionState && sessionState.sessionId) || null;
   if (_archiveCurId && preLoadSnapshotSessionId !== _archiveCurId &&
       sessionHistoryArchive[_archiveCurId] && sessionHistoryArchive[_archiveCurId].length) {
     var _archived = sessionHistoryArchive[_archiveCurId];
     vscode.postMessage({ type: 'debugLog', message:
       '[WV-DIAG] resume merge: snapshot belongs to ' + preLoadSnapshotSessionId +
       ' — using archived history for ' + _archiveCurId + ' (' + _archived.length + ' items)' });
     preLoadChatHistorySnapshot = _archived.slice();
     preLoadSnapshotSessionId = _archiveCurId;
   }
   // DIAG: log merge diagnostics
   var _diagSnapLen = preLoadChatHistorySnapshot ? preLoadChatHistorySnapshot.length : 0;
   var _diagLoadedLen = chatHistory.length;
   var _diagSnapId = preLoadSnapshotSessionId;
   var _diagCurId = (sessionState && sessionState.sessionId) || null;
   var _diagSnapHasAssistant = preLoadChatHistorySnapshot && preLoadChatHistorySnapshot.some(function(x) { return x && x.kind === 'message' && x.role === 'assistant'; });
   var _diagSnapHasThought = preLoadChatHistorySnapshot && preLoadChatHistorySnapshot.some(function(x) { return x && x.kind === 'thought'; });
   var _diagLoadedHasAssistant = chatHistory.some(function(x) { return x && x.kind === 'message' && x.role === 'assistant'; });
   var _diagLoadedHasThought = chatHistory.some(function(x) { return x && x.kind === 'thought'; });
   var _diagSnapKinds = {};
   if (preLoadChatHistorySnapshot) { for (var _dk = 0; _dk < preLoadChatHistorySnapshot.length; _dk++) { var _di = preLoadChatHistorySnapshot[_dk]; if (_di) { var _k = _di.kind + (_di.role ? ':' + _di.role : ''); _diagSnapKinds[_k] = (_diagSnapKinds[_k] || 0) + 1; } } }
   var _diagLoadedKinds = {};
   for (var _dlk = 0; _dlk < chatHistory.length; _dlk++) { var _dli = chatHistory[_dlk]; if (_dli) { var _lk = _dli.kind + (_dli.role ? ':' + _dli.role : ''); _diagLoadedKinds[_lk] = (_diagLoadedKinds[_lk] || 0) + 1; } }
   vscode.postMessage({ type: 'debugLog', message: '[WV-DIAG] handleLoadSessionEnd: snapLen=' + _diagSnapLen + ' loadedLen=' + _diagLoadedLen + ' snapId=' + _diagSnapId + ' curId=' + _diagCurId + ' match=' + (_diagSnapId === _diagCurId) + ' snapHasAsst=' + _diagSnapHasAssistant + ' snapHasThought=' + _diagSnapHasThought + ' loadedHasAsst=' + _diagLoadedHasAssistant + ' loadedHasThought=' + _diagLoadedHasThought + ' snapKinds=' + JSON.stringify(_diagSnapKinds) + ' loadedKinds=' + JSON.stringify(_diagLoadedKinds) });
   // DIAG: report the assistant/tool count mismatch that triggers the
   // snapshot-overlay insertions. When the loaded replay drops assistant
   // messages (Codex session/load does not replay agent_message_chunk), the
   // snapshot supplies them — and the ordinal assistant anchoring below
   // decides where they land. This log makes it easy to confirm the trigger
   // and correlate with the insertSnapshotItem(assistant) logs.
   var _diagSnapAsst = _diagSnapKinds['message:assistant'] || 0;
   var _diagLoadedAsst = _diagLoadedKinds['message:assistant'] || 0;
   var _diagSnapTool = _diagSnapKinds['toolCall'] || 0;
   var _diagLoadedTool = _diagLoadedKinds['toolCall'] || 0;
   var _diagAsstDelta = _diagSnapAsst - _diagLoadedAsst;
   var _diagToolDelta = _diagSnapTool - _diagLoadedTool;
   if (_diagAsstDelta !== 0 || _diagToolDelta !== 0) {
     vscode.postMessage({ type: 'debugLog', message: '[WV-DIAG] resume merge count delta: assistant snap=' + _diagSnapAsst + ' loaded=' + _diagLoadedAsst + ' (delta ' + (_diagAsstDelta > 0 ? '+' : '') + _diagAsstDelta + '), tool snap=' + _diagSnapTool + ' loaded=' + _diagLoadedTool + ' (delta ' + (_diagToolDelta > 0 ? '+' : '') + _diagToolDelta + ') — snapshot will supply ' + Math.max(0, _diagAsstDelta) + ' extra assistant(s)' });
   }
  // If session/load returned nothing (loadedLen === 0), the session was
  // not found on the agent side — the extension created a fresh session.
  // In this case, do NOT try to merge the stale snapshot (it may contain
  // an incomplete turn from before the reload). Clear the interrupted flag
  // and start with an empty chat — the user gets a fresh session.
  if (_diagLoadedLen === 0 && (!preLoadChatHistorySnapshot || !preLoadChatHistorySnapshot.some(function(x) { return x && x.kind === 'message' && x.role === 'assistant'; }))) {
    vscode.postMessage({ type: 'debugLog', message: '[WV-DIAG] session/load returned empty + snapshot has no assistant — clearing stale state (session not found on agent side)' });
    // Keep prompts the user sent that were never answered. A fresh session on
    // the agent side means the old transcript is correctly discarded — but a
    // prompt the user just sent is not part of that transcript, and it may
    // still be in flight. handleLoadSessionStart wiped it from chatHistory
    // (the snapshot was taken just before), so discarding the snapshot here
    // dropped it too. When the prompt was sent just BEFORE the load began the
    // host's userBubble fallback does not cover this either — it is gated on
    // isLoadingSession as of send time — so the message was lost outright
    // rather than merely delayed.
    //
    // Only the TRAILING run of user messages is kept: those sit after the last
    // assistant / tool / thought in the snapshot, which is what makes them
    // provably unanswered. Anything earlier belongs to the discarded
    // transcript. Interrupt notices and blank rows are not real prompts.
    var _unanswered = collectUnansweredTrailingPrompts(preLoadChatHistorySnapshot);
    chatHistory = _unanswered;
    preLoadChatHistorySnapshot = null;
    preLoadSnapshotSessionId = null;
    clearSessionInterrupted();
    saveState();
    hasSentPrompt = false;
    hasSteeredThisTurn = false;
    isSendingPrompt = false;
    if (loadOverlay) loadOverlay.classList.remove('visible');
    if (inputArea) inputArea.classList.remove('disabled');
    updateSendButton();
    messagesEl.innerHTML = '';
    if (_unanswered.length) {
      // Re-render the surviving prompt(s) so the bubble stays visible instead
      // of disappearing until the turn resolves.
      for (var _uri = 0; _uri < _unanswered.length; _uri++) {
        addMessageDOM('user', _unanswered[_uri].text || '(image)');
      }
      hideEmpty();
    } else if (emptyState) {
      messagesEl.appendChild(emptyState); emptyState.style.display = '';
    }
    return;
  }
  // After replay, chatHistory belongs to the loaded session.
  chatHistoryOriginSessionId = (sessionState && sessionState.sessionId) || null;
   // Safety: never leave compact-mode latched after a history replay.
    isCompacting = false;
    manualCompacting = false;
    isClearing = false;
    compactedWarningText = '';
    compactedNoticeText = '';
    if (compactionFlushTimer) { clearTimeout(compactionFlushTimer); compactionFlushTimer = null; }
    pendingPostCompactChunks = []; // session is being rebuilt — discard stale resume tokens
    hideCompactionProgress();
    // Claude interrupted mid-turn: merge tools/thoughts from webview snapshot
    // when session/load only returned the user prompt.
    // ONLY merge if we're loading the SAME session that the snapshot was
    // taken from. When switching between sessions, the snapshot contains
    // the OTHER session's history and must NOT be merged — otherwise
    // messages leak across sessions.
    var _currentLoadSessionId = (sessionState && sessionState.sessionId) || null;
   if (preLoadChatHistorySnapshot && preLoadChatHistorySnapshot.length &&
       preLoadSnapshotSessionId && _currentLoadSessionId &&
       preLoadSnapshotSessionId === _currentLoadSessionId) {
     // Codex session/load only replays tool_call + user_message_chunk —
     // it does NOT replay agent_message_chunk or agent_thought_chunk.
     // If the loaded chatHistory has tool_calls but no assistant messages,
     // the snapshot is more complete — merge ALL turns from the snapshot,
     // updating tool call statuses from the replay.
     var _loadedAssistantCount = chatHistory.filter(function(x) {
       return x && x.kind === 'message' && x.role === 'assistant';
     }).length;
     var _loadedToolCount = chatHistory.filter(function(x) {
       return x && x.kind === 'toolCall';
     }).length;
     var _snapAssistantCount = preLoadChatHistorySnapshot.filter(function(x) {
       return x && x.kind === 'message' && x.role === 'assistant';
     }).length;
     var _snapToolCount = preLoadChatHistorySnapshot.filter(function(x) {
       return x && x.kind === 'toolCall';
     }).length;
     var _snapHasAssistant = _snapAssistantCount > 0;
     var _snapHasThoughts = preLoadChatHistorySnapshot.some(function(x) {
       return x && x.kind === 'thought';
     });
     // Codex session/load often replays only a SUBSET of the history
     // (e.g. 3 assistants + 1 tool_call when the snapshot has 28 assistants
     // + 78 tool_calls). The full snapshot merge should trigger whenever
     // the snapshot is significantly more complete than the loaded history.
     var _loadedHasAssistant = _loadedAssistantCount > 0;
     var _loadedHasThoughts = chatHistory.some(function(x) { return x && x.kind === 'thought'; });
     var _loadedRealUsers = countRealUsers(chatHistory);
     var _snapRealUsers = countRealUsers(preLoadChatHistorySnapshot);
     var _loadedUserMsgCount = _diagLoadedKinds['message:user'] || 0;
     var _snapUserMsgCount = _diagSnapKinds['message:user'] || 0;
     var _snapshotMoreComplete = (_snapAssistantCount > _loadedAssistantCount) ||
                                  (_snapToolCount > _loadedToolCount);
     // If the loaded history contains a compaction notice, the session was
     // compacted on the agent side — all pre-compaction history is gone.
     // The snapshot (taken before session/load) may contain the OLD
     // pre-compaction history. Filter the snapshot to only include items
     // AFTER the compaction boundary, then proceed with the normal merge.
     // Without this, pre-compaction tools/assistants are resurrected and
     // push the user message to the end.
     var _loadedHasCompaction = chatHistory.some(function(x) {
       return x && x.kind === 'message' && x.role === 'system' &&
         String(x.text || '').indexOf('compacted') >= 0;
     });
     if (_loadedHasCompaction && preLoadChatHistorySnapshot) {
       // Find the compaction boundary in the snapshot. Items after it are
       // post-compaction and should be kept; items before it are stale.
       var _compactionBoundary = -1;
       for (var _ci = 0; _ci < preLoadChatHistorySnapshot.length; _ci++) {
         var _cItem = preLoadChatHistorySnapshot[_ci];
         if (_cItem && _cItem.kind === 'message' && _cItem.role === 'system' &&
             String(_cItem.text || '').indexOf('compacted') >= 0) {
           _compactionBoundary = _ci;
           break;
         }
       }
       if (_compactionBoundary >= 0) {
         var _preSlice = preLoadChatHistorySnapshot.slice(0, _compactionBoundary);
         var _postSlice = preLoadChatHistorySnapshot.slice(_compactionBoundary + 1);
         preLoadChatHistorySnapshot = _postSlice;
         vscode.postMessage({ type: 'debugLog', message: '[WV-MERGE] compaction boundary at snapshot[' + _compactionBoundary + ']: sliced ' + _preSlice.length + ' pre-compaction items, keeping ' + _postSlice.length + ' post-compaction items' });
         // Recount snapshot stats after slicing
         _snapAssistantCount = preLoadChatHistorySnapshot.filter(function(x) { return x && x.kind === 'message' && x.role === 'assistant'; }).length;
         _snapToolCount = preLoadChatHistorySnapshot.filter(function(x) { return x && x.kind === 'toolCall'; }).length;
         _snapHasAssistant = _snapAssistantCount > 0;
         _snapHasThoughts = preLoadChatHistorySnapshot.some(function(x) { return x && x.kind === 'thought'; });
         _snapshotMoreComplete = (_snapAssistantCount > _loadedAssistantCount) ||
                                  (_snapToolCount > _loadedToolCount);
       }
     }
     if (_snapshotMoreComplete && (_snapHasAssistant || _snapHasThoughts)) {
       var _loadedHistoryForMerge = chatHistory.slice();
       // session/load is authoritative for user-turn boundaries; the webview
       // snapshot may have fewer or coalesced user rows. Always overlay snapshot
       // thoughts/assistants onto loaded whenever replay returned history.
       if (_loadedHistoryForMerge.length > 0) {
         chatHistory = mergeLoadedWithSnapshotOverlay(_loadedHistoryForMerge, preLoadChatHistorySnapshot);
         // session/load can replay a SPARSER history than the snapshot (agent-side
         // compaction or truncated transcript). The loaded-first overlay above keeps
         // only the loaded user rows, silently dropping the snapshot's user messages
         // — including the last few the user actually typed. Re-inject snapshot user
         // rows that are missing so the resumed panel shows the full conversation.
         var _snapUserInjected = mergeMissingUsersFromSnapshot(chatHistory, preLoadChatHistorySnapshot);
         vscode.postMessage({
           type: 'debugLog',
           message: '[WV-MERGE] loaded-first overlay: ' + chatHistory.length + ' items (snap=' +
             preLoadChatHistorySnapshot.length + ' loaded=' + _diagLoadedLen + ' loadedUsers=' +
             _loadedRealUsers + ' snapUsers=' + _snapRealUsers + ' loadedUserMsgs=' +
             _loadedUserMsgCount + ' snapUserMsgs=' + _snapUserMsgCount + ' injectedSnapUsers=' + _snapUserInjected + ')',
         });
         currentAssistantEl = null;
         currentAssistantText = '';
         if (currentTurnEl) { currentTurnEl = null; }
       } else {
       // No replay history — fall back to snapshot as base (rare: empty load).
       var _statusMap = {};
       for (var _si = 0; _si < chatHistory.length; _si++) {
         var _tc = chatHistory[_si];
         if (_tc && _tc.kind === 'toolCall' && _tc.toolCallId) {
           _statusMap[_tc.toolCallId] = _tc.status;
         }
       }
       // Also build a set of loaded tool_call IDs to skip duplicate tools
       // from the snapshot that are already in the loaded history.
       var _loadedToolIds = {};
       for (var _li = 0; _li < chatHistory.length; _li++) {
         var _ltc = chatHistory[_li];
         if (_ltc && _ltc.kind === 'toolCall' && _ltc.toolCallId) {
           _loadedToolIds[_ltc.toolCallId] = true;
         }
       }
       // Use snapshot as base, UPDATE tool statuses from replay in-place.
       // Do NOT skip tool_calls that are in both — that would move them to
       // the end and break the interleaved order (thought → tool → assistant).
       var _merged = [];
      for (var _mi = 0; _mi < preLoadChatHistorySnapshot.length; _mi++) {
        var _snapItem = preLoadChatHistorySnapshot[_mi];
        if (!_snapItem) continue;
        // Skip interrupt notices from the snapshot — they are live-only
        // artifacts of promptEnd(stopReason=cancelled) and should NOT
        // be merged into the loaded history. The loaded history from
        // session/load is the source of truth; if the turn was truly
        // interrupted, reconcileInterruptedSessionFlag will handle it.
        if (_snapItem.kind === 'message' && (_snapItem.role === 'system' || _snapItem.role === 'user') &&
            isSessionInterruptNotice(_snapItem.text)) {
          continue;
        }
        if (_snapItem.kind === 'toolCall' && _snapItem.toolCallId) {
           // Update status from replay if available (keep position in order)
           if (_statusMap[_snapItem.toolCallId]) {
             _snapItem = Object.assign({}, _snapItem, { status: _statusMap[_snapItem.toolCallId] });
           }
         }
         _merged.push(_snapItem);
       }
       // Append any loaded tool_calls not in the snapshot (truly new tools)
       for (var _ai = 0; _ai < _loadedHistoryForMerge.length; _ai++) {
         var _atc = _loadedHistoryForMerge[_ai];
         if (_atc && _atc.kind === 'toolCall' && _atc.toolCallId &&
             !_merged.some(function(x) { return x && x.kind === 'toolCall' && x.toolCallId === _atc.toolCallId; })) {
           _merged.push(_atc);
         }
       }
       var _injectedUsers = mergeMissingUsersFromLoaded(_merged, _loadedHistoryForMerge);
       if (_injectedUsers === 0) {
         _injectedUsers = mergeMissingUsersFromLoadedByText(_merged, _loadedHistoryForMerge);
       }
       chatHistory = _merged;
       var _mergedUserCount = countRealUsers(_merged);
      vscode.postMessage({ type: 'debugLog', message: '[WV-MERGE] full snapshot merge: ' + _merged.length + ' items (snap=' + preLoadChatHistorySnapshot.length + ' loaded=' + _diagLoadedLen + ' injectedUsers=' + _injectedUsers + ' mergedUsers=' + _mergedUserCount + ')' });
      // The replay's trailing reply was already committed at the top of
      // handleLoadSessionEnd, so the loaded timeline carried it into the merge
      // and the snapshot's copy was skipped by the text dedup. Nothing is left
      // in currentAssistantText to clear — only reset the DOM pointers so the
      // next turn starts clean.
      currentAssistantEl = null;
      currentAssistantText = '';
      if (currentTurnEl) { currentTurnEl = null; }
       }
    } else {
      mergePreLoadInterruptedTurn(preLoadChatHistorySnapshot);
     }
   }
   // Capture the snapshot for the kiro dropped-UMC recovery below (it is
   // nulled right after; the recovery needs the pre-load rows).
   var _recoverySnapshot = preLoadChatHistorySnapshot;
   var _recoverySnapshotSid = preLoadSnapshotSessionId;
    preLoadChatHistorySnapshot = null;
   preLoadSnapshotSessionId = null;

   // ── Kiro dropped-user-message recovery ───────────────────────────────
   // Kiro's session/load replay is streamed synchronously right after the
   // request. When loads overlap (or the active-session gate drops the fast
   // replay), the loaded chatHistory can contain tool_calls + thoughts but
   // ZERO real user rows and zero assistant summaries — the user sees a wall
   // of collapsed tool blocks with no prompts and no answers.
   //
   // Recovery: if the loaded history has substantive content (tools/thoughts)
   // but no real user messages at all, and the pre-load snapshot belongs to
   // the SAME session, re-inject the real user rows and assistant summaries
   // from the snapshot (positioned by their following tool anchors). This is a
   // one-way rescue — it never fires when the replay legitimately carried
   // user rows, and it cannot leak rows across sessions (snapshot-session
   // guard). The snapshot rows are authoritative for what the user saw.
   var _loadedRealUsers = countRealUsers(chatHistory);
   var _loadedAsstCount = chatHistory.filter(function(x) {
     return x && x.kind === 'message' && x.role === 'assistant';
   }).length;
   var _loadedToolCount = chatHistory.filter(function(x) {
     return x && x.kind === 'toolCall';
   }).length;
   var _curLoadSid = (sessionState && sessionState.sessionId) || null;
   if (
     _loadedRealUsers === 0 &&
     _loadedToolCount > 0 &&
     _recoverySnapshot &&
     _recoverySnapshot.length > 0 &&
     _recoverySnapshotSid &&
     _curLoadSid &&
     _recoverySnapshotSid === _curLoadSid
   ) {
     var _snapRealUsers = countRealUsers(_recoverySnapshot);
     var _snapAsst = _recoverySnapshot.filter(function(x) {
       return x && x.kind === 'message' && x.role === 'assistant';
     });
     if (_snapRealUsers > 0) {
       // Build anchors: find the snapshot index of the first tool_call after
       // each user row, then insert the user row just before that tool's
       // position in the loaded history. This keeps user prompts in
       // conversation order instead of dumping them all at the top.
       var _snapRealUserIdx = [];
       for (var _su = 0; _su < _recoverySnapshot.length; _su++) {
         var _sIt = _recoverySnapshot[_su];
         if (_sIt && _sIt.kind === 'message' && _sIt.role === 'user' && !isSessionInterruptNotice(_sIt.text)) {
           _snapRealUserIdx.push(_su);
         }
       }
       var _injectedUsers = 0;
       // Insert from the END backwards so earlier insertions don't shift the
       // anchor positions of later ones.
       for (var _ui = _snapRealUserIdx.length - 1; _ui >= 0; _ui--) {
         var _uidx = _snapRealUserIdx[_ui];
         var _userText = _recoverySnapshot[_uidx] ? _recoverySnapshot[_uidx].text : '';
         if (!_userText || typeof _userText !== 'string') continue;
         // Skip interrupt notices / machine-context-only rows.
         if (isSessionInterruptNotice(_userText)) continue;
         if (String(_userText || '').trim() === '') continue;
         var _cleanedUser = cleanUserMessage(_userText);
         if (!String(_cleanedUser || '').trim()) continue;
         // Already have this user text? skip.
         var _dup = chatHistory.some(function(x) {
           return x && x.kind === 'message' && x.role === 'user' && userMessageKey(x.text) === userMessageKey(_userText);
         });
         if (_dup) continue;
         // Find first tool_call in the loaded history AFTER this snapshot
         // position (use the snapshot's own ordering: any tool later than
         // this user in the snapshot).
         var _insertAt = chatHistory.length;
         for (var _sa = _uidx + 1; _sa < _recoverySnapshot.length; _sa++) {
           var _snapAfter = _recoverySnapshot[_sa];
           if (_snapAfter && _snapAfter.kind === 'toolCall' && _snapAfter.toolCallId) {
             for (var _ma = 0; _ma < chatHistory.length; _ma++) {
               var _mIt = chatHistory[_ma];
               if (_mIt && _mIt.kind === 'toolCall' && _mIt.toolCallId === _snapAfter.toolCallId) {
                 _insertAt = _ma;
                 break;
               }
             }
             if (_insertAt !== chatHistory.length) break;
           }
         }
         chatHistory.splice(_insertAt, 0, { kind: 'message', role: 'user', text: _cleanedUser });
         _injectedUsers++;
       }
       vscode.postMessage({ type: 'debugLog', message: '[WV-MERGE] kiro dropped-UMC recovery: injected ' + _injectedUsers + ' user rows (snapUsers=' + _snapRealUsers + ' loadedTools=' + _loadedToolCount + ' loadedAsst=' + _loadedAsstCount + ')' });
       // Also promote assistant summaries from the snapshot that are missing.
       // Only when the loaded history has no assistant rows at all AND the
       // snapshot has some — otherwise we'd duplicate live summaries.
       if (_loadedAsstCount === 0 && _snapAsst.length > 0) {
         var _injectedAsst = 0;
         for (var _ai2 = 0; _ai2 < _snapAsst.length; _ai2++) {
           var _aSnap = _snapAsst[_ai2];
           if (!_aSnap || typeof _aSnap.text !== 'string' || !_aSnap.text.trim()) continue;
           // Skip summaries that belong to a turn whose user row exists.
           // Simple dedupe: skip if identical text already present.
           var _aDup = chatHistory.some(function(x) {
             return x && x.kind === 'message' && x.role === 'assistant' &&
                    String(x.text || '').trim() === _aSnap.text.trim();
           });
           if (_aDup) continue;
           chatHistory.push({ kind: 'message', role: 'assistant', text: _aSnap.text });
           _injectedAsst++;
         }
         if (_injectedAsst > 0) {
           vscode.postMessage({ type: 'debugLog', message: '[WV-MERGE] kiro dropped-UMC recovery: injected ' + _injectedAsst + ' assistant rows' });
         }
       }
     }
   }

   // If history was replayed, there were prior prompts — mark as sent
   // so the context usage ring can appear when metadata arrives.
  if (chatHistory.length > 0) hasSentPrompt = true;
    // Deduplicate consecutive thought entries where a later one is a
    // superset of an earlier one (resume artifact: the merge logic used
    // to push a new entry with old+new text instead of updating the old one).
    for (let _di = 1; _di < chatHistory.length; _di++) {
      var _dPrev = chatHistory[_di - 1];
      var _dCur = chatHistory[_di];
      if (_dPrev && _dCur && _dPrev.kind === 'thought' && _dCur.kind === 'thought' &&
          typeof _dCur.text === 'string' && typeof _dPrev.text === 'string' &&
          _dCur.text.startsWith(_dPrev.text)) {
        _dPrev.text = _dCur.text;
        if (_dCur.durationSec) _dPrev.durationSec = _dCur.durationSec;
        chatHistory.splice(_di, 1);
        _di--;
      }
    }
    saveState();
   // Sync in-progress tool calls to a terminal status.
    // Codex often sends tool_call with 'in_progress' and never sends
    // tool_call_update with 'completed' — the completion is implicit in
    // promptEnd.  So: if there is an assistant message or a new user message
    // after this tool call (the turn finished), mark it 'completed'.  Only
    // force 'failed' when the turn was truly interrupted.
    var _failedAnyTool = false;
    for (let i = 0; i < chatHistory.length; i++) {
      const item = chatHistory[i];
      if (item && item.kind === 'toolCall' &&
          (item.status === 'in_progress' || item.status === 'running' || item.status === 'pending')) {
        // Check forward in chatHistory for a following non-interrupted
        // assistant message or a new user message (excluding interrupt notices).
        var _hasFollowingAssistant = false;
        for (var _fa = i + 1; _fa < chatHistory.length; _fa++) {
          var _faItem = chatHistory[_fa];
          if (_faItem && _faItem.kind === 'message' && _faItem.role === 'assistant' && !(_faItem.interrupted)) {
            _hasFollowingAssistant = true;
            break;
          }
          if (_faItem && _faItem.kind === 'message' && _faItem.role === 'user' && !isSessionInterruptNotice(_faItem.text)) {
            _hasFollowingAssistant = true;
            break;
          }
        }
        var _newStatus = _hasFollowingAssistant ? 'completed' : 'failed';
        item.status = _newStatus;
        if (_newStatus === 'failed') _failedAnyTool = true;
        const el = lookupToolCallEl(item.toolCallId);
        if (el) {
          const iconEl = el.querySelector('.tc-icon');
          if (iconEl) { iconEl.className = 'tc-icon ' + _newStatus; iconEl.textContent = getStatusIcon(_newStatus); }
          const badge = el.querySelector('.status-badge');
          if (badge) { badge.className = 'status-badge ' + _newStatus; badge.textContent = _newStatus; }
          // Codex/Claude crew parents synthesized as running during load.
          if (_newStatus === 'failed' && el.classList.contains('tc-subagent')) {
            var _stSpin = el.querySelectorAll('.tc-stage-icon.running, .tc-stage-icon.in_progress, .tc-stage-icon.pending');
            for (var _ssi = 0; _ssi < _stSpin.length; _ssi++) {
              var _stEl = _stSpin[_ssi].closest('.tc-stage');
              if (_stEl) applyStageIcon(_stEl, 'failed');
            }
            markSubagentCrewStale(el);
          }
        }
      }
    }
     // Do not fail completed→failed until we know the session actually ended
     // interrupted (finished resumes must keep green checks + promote summary).
     reconcileInterruptedSessionFlag(_failedAnyTool);
     failInterruptedSpawnToolsInHistory();
     failInterruptedSubagentStagesInHistory();
     saveState();
    // Commit any trailing assistant turn captured during the replay.
    finalizeCurrentAssistantTurn();
    // Log post-finalize state for debugging merge/interrupt issues.
    {
      var _pfAssistant = chatHistory.filter(function(x) { return x && x.kind === 'message' && x.role === 'assistant'; }).length;
      var _pfTools = chatHistory.filter(function(x) { return x && x.kind === 'toolCall'; }).length;
      var _pfUsers = chatHistory.filter(function(x) { return x && x.kind === 'message' && x.role === 'user'; }).length;
      var _pfInterruptNotices = chatHistory.filter(function(x) { return x && x.kind === 'message' && x.role === 'user' && isSessionInterruptNotice(x.text); }).length;
      var _pfSessionInterrupted = sessionMarkedInterrupted();
      vscode.postMessage({ type: 'debugLog', message: '[WV-DIAG] post-finalize: assistants=' + _pfAssistant + ' tools=' + _pfTools + ' users=' + _pfUsers + ' interruptNotices=' + _pfInterruptNotices + ' sessionInterrupted=' + _pfSessionInterrupted + ' chatHistoryLen=' + chatHistory.length });
    }
    // Rebuild the entire messages DOM from chatHistory.  During replay,
     // the agent_message_chunk / tool_call handlers build DOM piecemeal,
     // but race conditions (coalescer delays, interleaved user_message_chunk
     // calls to finalizeCurrentAssistantTurn) can leave the DOM out of sync
     // with chatHistory — particularly assistant text elements that were
     // committed to history without a corresponding DOM node.  Rebuilding
     // from scratch (same pattern as restoreState) guarantees every
     // chatHistory entry has a DOM element before we batch-render markdown.
    // Rebuild from chatHistory. Keep interrupted-turn assistants folded the
    // same way as webview crash restore — otherwise resume promotes them into
    // the main chat and a completed summary looks like it "showed again".
    foldInterruptedAssistantsOnPromote = true;
    var assistantItems = renderChatHistory();
    foldInterruptedAssistantsOnPromote = false;
    // Codex/Claude: crew stages can still render as running after rebuild —
    // force any leftover spinners to failed and mark crews stale.
    failRunningSubagentStagesInDom();
    failCompletedCrewsInInterruptedTurn();
    // renderChatHistory can leave folds open after promote — force shut.
    forceCollapseTurnFolds();
    failRunningSubagentStagesInDom();
    failCompletedCrewsInInterruptedTurn();
    if (loadOverlay) loadOverlay.classList.remove('visible');
    if (inputArea) inputArea.classList.remove('disabled');
    updateSendButton();
    // The replay is on screen. Keep taking a straggling reply chunk for a short
    // window — an agent can emit its last text after the session/load response,
    // and dropping it loses the turn's whole summary (see loadTailGraceUntil).
    loadTailGraceUntil = Date.now() + LOAD_TAIL_GRACE_MS;
     // Batch-render markdown for every assistant message (now that DOM
     // elements are guaranteed to exist from the rebuild above).
     if (assistantItems.length > 0) {
       // Retry mechanism for loadSessionEnd path too
      var _lsRetryItems = assistantItems.slice();
      var _lsRetryCount = 0;
      var _lsRetryKey = 'loadEnd_' + Date.now();
      pendingRenderRetries[_lsRetryKey] = true;
      vscode.postMessage({ type: 'renderMarkdown', items: assistantItems });
      var _lsRetryFn = function() {
        if (pendingRenderRetries[_lsRetryKey] && _lsRetryCount < 3) {
          _lsRetryCount++;
          vscode.postMessage({ type: 'debugLog', message: 'handleLoadSessionEnd: RETRY ' + _lsRetryCount + ' sending renderMarkdown for ' + _lsRetryItems.length + ' items' });
          vscode.postMessage({ type: 'renderMarkdown', items: _lsRetryItems });
          setTimeout(_lsRetryFn, 2000);
        }
      };
      setTimeout(_lsRetryFn, 2000);
    }
    scrollToBottom();
     if (!ok) {
       addMessage('error', 'Failed to load session history.');
     }
     // Batch enrich must run AFTER snapshot-merge + renderChatHistory — not from
     // notifyLoadSessionEnd (that fires before the webview merges/rebuilds).
     setTimeout(function() {
       vscode.postMessage({ type: 'debugLog', message: '[WV-DIAG] post-merge cursor tool enrich request' });
       requestCursorToolEnrichIfNeeded('post-merge');
     }, 50);
   }

   function handleSessionInfoUpdate(title) {
     if (!sessionState) return;
     if (typeof title === 'string') {
       // Clean context links from session title — codex-acp uses the
       // raw user message (including [@name](file:///...) links) as the
      // title, which shows up raw in the banner and session list.
      const _cleanedTitle = cleanUserMessage(title);
      sessionState.title = _cleanedTitle || undefined;
   } else if (title === null) {
     delete sessionState.title;
    }
   saveState();
  if (bannerAgent) {
     var _bannerTitle = sessionState.title || sessionState.agentName || 'Agent';
     bannerAgent.textContent = truncateForBanner(_bannerTitle);
     bannerAgent.title = _bannerTitle;
  }
}

    // --- Mode / Model pickers ---

    // --- Slash command helpers ---
    function renderSlashPopup(commands) {
      slashPopup.innerHTML = '<div class="slash-popup-header">Commands</div>';
      commands.forEach((cmd, i) => {
        const item = document.createElement('div');
        item.className = 'slash-popup-item' + (i === 0 ? ' active' : '');
        item.dataset.index = String(i);
        item.innerHTML =
          '<span class="cmd-name">/' + escapeHtml(cmd.name) + '</span>' +
          '<span class="cmd-desc">' + escapeHtml(cmd.description) + '</span>';
        item.addEventListener('click', () => selectSlashCommand(cmd));
        item.addEventListener('mouseenter', () => {
          slashPopupSelectedIdx = i;
          highlightSlashItem(i);
        });
        slashPopup.appendChild(item);
      });
    }

    function highlightSlashItem(idx) {
      const items = slashPopup.querySelectorAll('.slash-popup-item');
      items.forEach((el, i) => el.classList.toggle('active', i === idx));
      if (items[idx]) items[idx].scrollIntoView({ block: 'nearest' });
    }

    function selectSlashCommand(cmd) {
      slashPopup.classList.remove('open');
      if (!cmd) return;

   // @mention context item — replace the partial @query with @name
  const atMatch = promptInput.value.match(/@(\\w*)$/);
  if (atMatch) {
     if (cmd.name === 'file' || cmd.name === 'folder') {
        // Ask extension to pick a file/folder and return the path
        promptInput.value = promptInput.value.slice(0, -atMatch[0].length);
        vscode.postMessage({ type: 'pickContext', contextType: cmd.name });
      } else {
        promptInput.value = promptInput.value.slice(0, -atMatch[0].length) + '@' + cmd.name + ' ';
      }
        promptInput.focus();
        return;
      }

     if (cmd.input) {
       // Command expects input — insert "/name " and set placeholder to hint
       promptInput.value = '/' + cmd.name + ' ';
       promptInput.placeholder = cmd.input.hint || 'Type input...';
       promptInput.focus();
   } else if (cmd.name === 'rename') {
     // /rename needs an argument — insert "/rename " and let user type the name
     promptInput.value = '/rename ';
     promptInput.placeholder = 'Type a new session name...';
     promptInput.focus();
   } else if (cmd.name === 'session') {
     // /session needs a session name argument
     promptInput.value = '/session ';
     promptInput.placeholder = 'Type a session name to summarize as context...';
     promptInput.focus();
   } else {
      // No input required — send immediately
      promptInput.value = '/' + cmd.name;
      handleSend();
    }
    }

    // --- Mode / Model pickers (cont.) ---
   function updateModePicker(modes) {
     // If configOptions are active, don't show the legacy mode picker.
     if (useConfigOptions) { modePickerWrap.classList.add('hidden'); return; }
     if (!modes || !modes.availableModes || modes.availableModes.length === 0) {
        modePickerWrap.classList.add('hidden');
        availableModes = [];
        currentModeId = null;
        return;
      }
      availableModes = modes.availableModes;
      currentModeId = modes.currentModeId || null;
      modePickerWrap.classList.remove('hidden');
      const current = availableModes.find(m => m.id === currentModeId);
      modePickerLabel.textContent = current ? current.name : 'Mode';
      modePickerLabel.title = current && current.description ? current.description : '';
      renderModeDropdown();
    }

    function renderModeDropdown() {
      modeDropdown.innerHTML = '';
      for (const mode of availableModes) {
        const item = document.createElement('div');
        item.className = 'picker-dropdown-item' + (mode.id === currentModeId ? ' selected' : '');
        item.dataset.desc = mode.description || '';
        if (mode.description) item.title = mode.description;
        item.innerHTML =
          '<span class="check">' + (mode.id === currentModeId ? '✓' : '') + '</span>' +
          '<span class="item-label">' + escapeHtml(mode.name) + '</span>';
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          closePickers();
          if (mode.id !== currentModeId) {
            currentModeId = mode.id;
            const current = availableModes.find(m => m.id === currentModeId);
            modePickerLabel.textContent = current ? current.name : 'Mode';
            renderModeDropdown();
            vscode.postMessage({ type: 'setMode', modeId: mode.id });
          }
        });
        modeDropdown.appendChild(item);
      }
    }

   function updateModelPicker(models) {
     // Track the model identity FIRST, before any early return. The attach-button
     // rule for Kiro / Codex reads currentModelId (those agents publish no
     // per-model modalities, so the model name is the only signal). Returning
     // early left currentModelId null, so the image button stayed hidden even on
     // a vision model such as claude-opus-5.
     if (models && models.availableModels && models.availableModels.length > 0) {
       availableModels = models.availableModels;
       currentModelId = models.currentModelId || null;
     }
     // If configOptions are active, don't show the legacy model picker.
     if (useConfigOptions) {
       modelPickerWrap.classList.add('hidden');
       updateAttachButtonVisibility();
       return;
     }
     if (!models || !models.availableModels || models.availableModels.length === 0) {
        modelPickerWrap.classList.add('hidden');
        availableModels = [];
        currentModelId = null;
        return;
      }
      modelPickerWrap.classList.remove('hidden');
      const current = availableModels.find(m => m.modelId === currentModelId);
      modelPickerLabel.textContent = current ? current.name : 'Model';
      modelPickerLabel.title = current && current.description ? current.description : '';
      renderModelDropdown();
      updateAttachButtonVisibility();
    }

    function renderModelDropdown() {
      modelDropdown.innerHTML = '';
      for (const model of availableModels) {
        const item = document.createElement('div');
        item.className = 'picker-dropdown-item' + (model.modelId === currentModelId ? ' selected' : '');
        item.dataset.desc = model.description || '';
        if (model.description) item.title = model.description;
        item.innerHTML =
          '<span class="check">' + (model.modelId === currentModelId ? '✓' : '') + '</span>' +
          '<span class="item-label">' + escapeHtml(model.name) + '</span>';
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          closePickers();
          if (model.modelId !== currentModelId) {
            currentModelId = model.modelId;
            const current = availableModels.find(m => m.modelId === currentModelId);
            modelPickerLabel.textContent = current ? current.name : 'Model';
            renderModelDropdown();
            vscode.postMessage({ type: 'setModel', modelId: model.modelId });
            updateAttachButtonVisibility();
          }
        });
        modelDropdown.appendChild(item);
      }
    }

    // --- ACP Session Config Options ---

   function iconForCategory(cat) {
     switch (cat) {
       case 'mode': return '⚡';
       case 'collaboration_mode': return '📋';
       case 'model': return '🧠';
       case 'thought_level': return '💭';
       default: return '⚙';
     }
   }

    function isGroupedOptions(opt) {
      const arr = opt && opt.options;
      if (!Array.isArray(arr) || arr.length === 0) return false;
      const first = arr[0];
      return !!(first && typeof first.group === 'string' && Array.isArray(first.options));
    }

    function findOptionValue(opt, value) {
      if (!opt || !Array.isArray(opt.options)) return null;
      if (isGroupedOptions(opt)) {
        for (const group of opt.options) {
          if (!group || !Array.isArray(group.options)) continue;
          const hit = group.options.find(v => v && v.value === value);
          if (hit) return hit;
        }
        return null;
      }
      return opt.options.find(v => v && v.value === value) || null;
    }

    function pickerLabelFor(opt) {
      const v = findOptionValue(opt, opt.currentValue);
      return v && v.name ? v.name : (opt.name || 'Option');
    }

    function pickerTooltipFor(opt) {
      const v = findOptionValue(opt, opt.currentValue);
      return (v && v.description) || opt.description || opt.name || '';
    }

    function renderConfigPickers(opts) {
      configOptionsContainer.innerHTML = '';
      if (!Array.isArray(opts)) return;

      for (const opt of opts) {
        // Spec: ignore unknown types and empty option lists
        if (!opt || opt.type !== 'select') continue;
        if (!Array.isArray(opt.options) || opt.options.length === 0) continue;
        // Hide OpenAI-specific fast-mode toggle (1.5x speed) — not supported by local/vLLM backends
        if (opt.id === 'fast-mode' || opt.category === 'fast-mode') continue;

        const wrap = document.createElement('div');
        wrap.className = 'picker-wrap';
        wrap.dataset.configId = opt.id;

        const btn = document.createElement('button');
        btn.className = 'picker-btn';
        btn.title = pickerTooltipFor(opt);
        btn.innerHTML =
          '<span class="picker-icon">' + iconForCategory(opt.category) + '</span>' +
          '<span class="picker-label"></span>' +
          '<span class="picker-chevron">▾</span>';
        btn.querySelector('.picker-label').textContent = pickerLabelFor(opt);
        wrap.appendChild(btn);

        const dropdown = document.createElement('div');
        dropdown.className = 'picker-dropdown';
        renderConfigDropdown(dropdown, opt);
        wrap.appendChild(dropdown);

        configOptionsContainer.appendChild(wrap);
      }
    }

    function renderConfigDropdown(dropdown, opt) {
      dropdown.innerHTML = '';
      if (isGroupedOptions(opt)) {
        for (const group of opt.options) {
          if (!group || !Array.isArray(group.options)) continue;
          const header = document.createElement('div');
          header.className = 'picker-dropdown-group-header';
          header.textContent = group.name || group.group || '';
          dropdown.appendChild(header);
          for (const v of group.options) {
            dropdown.appendChild(buildConfigItem(opt, v));
          }
        }
      } else {
        for (const v of opt.options) {
          dropdown.appendChild(buildConfigItem(opt, v));
        }
      }
    }

    function buildConfigItem(opt, v) {
      const selected = v.value === opt.currentValue;
      const item = document.createElement('div');
      item.className = 'picker-dropdown-item' + (selected ? ' selected' : '');
      item.dataset.value = v.value;
      item.dataset.desc = v.description || '';
      item.innerHTML =
        '<span class="check">' + (selected ? '✓' : '') + '</span>' +
        '<span class="item-label"></span>';
      item.querySelector('.item-label').textContent = v.name || v.value;
      return item;
    }

    // Event delegation: handle clicks on dynamically-rendered config pickers
    configOptionsContainer.addEventListener('click', (e) => {
      const target = e.target;
      if (!(target instanceof Element)) return;

      const item = target.closest('.picker-dropdown-item');
      if (item) {
        e.stopPropagation();
        const wrap = item.closest('.picker-wrap');
        const dropdown = item.closest('.picker-dropdown');
        if (!wrap || !dropdown) return;
        const configId = wrap.dataset.configId;
        const value = item.dataset.value;
        if (!configId || value == null) return;

        // Find option in current state
        const opt = configOptions.find(o => o && o.id === configId);
        if (!opt || value === opt.currentValue) {
          dropdown.classList.remove('open');
          return;
        }

        // Optimistic update — agent's response will replace with authoritative state
        opt.currentValue = value;
        const labelEl = wrap.querySelector('.picker-btn .picker-label');
        const btn = wrap.querySelector('.picker-btn');
        if (labelEl) labelEl.textContent = pickerLabelFor(opt);
        if (btn) btn.title = pickerTooltipFor(opt);
        renderConfigDropdown(dropdown, opt);

        dropdown.classList.remove('open');
       vscode.postMessage({ type: 'setConfigOption', configId, value });
       // A model switch made DURING a turn cannot affect the request already in
       // flight — its model is fixed in the POST body — so it applies from the
       // next step. The picker label flips immediately, which on its own reads as
       // if the switch were already live and the agent were ignoring it; measured
       // on one turn, the first call on the new model went out 6s later, but with
       // a long reasoning call in flight that gap can be minutes. Say so once.
       if (isProcessing && (configId === 'model' || (opt && opt.category === 'model'))) {
         showTransientHint('Model switch applies from the next step — the reply in flight finishes on the previous model.');
       }
       // If this is a model change, update attach button visibility immediately.
       if (configId === 'model' || opt.category === 'model') {
         var agent = sessionState && sessionState.agentName ? sessionState.agentName : '';
         var modelBase2 = value.replace(/\\[(?:low|medium|high|xhigh|max|none)\\]$/, '');
         if (agent && /kiro/i.test(agent)) {
           if (attachBtn) attachBtn.style.display = /claude/i.test(modelBase2) ? '' : 'none';
         } else if (sessionState && sessionState.modelImageMap) {
           var mapped = Object.prototype.hasOwnProperty.call(sessionState.modelImageMap, modelBase2)
             ? !!sessionState.modelImageMap[modelBase2]
             : false;
           if (sessionState) sessionState.currentModelImageSupport = mapped;
           updateAttachButtonVisibility(undefined, mapped);
         } else {
           updateAttachButtonVisibility(undefined, false);
         }
       }
       return;
      }

      const btn = target.closest('.picker-btn');
      if (btn) {
        e.stopPropagation();
        const wrap = btn.closest('.picker-wrap');
        if (!wrap) return;
        const dropdown = wrap.querySelector('.picker-dropdown');
        if (!dropdown) return;
        const wasOpen = dropdown.classList.contains('open');
        closePickers();
        if (!wasOpen) dropdown.classList.add('open');
      }
    });

    // Plan mode: agents that expose a 'collaboration_mode' config option
    // (codex, codex-acp, claude-code-acp) refuse to execute while it is 'plan'
    // — an "implement it" request is answered as a plan, so the code lands in
    // the chat instead of on disk. Only codex and claude-code-acp can leave the
    // mode themselves; codex's design leaves it to the user. Offer the switch
    // here so the handoff works for every agent.
    let collabModeIsPlan = false;
    let sawPlanThisTurn = false;
    let implementPlanRowEl = null;

    function planModeValueFrom(opts) {
      for (var i = 0; i < (opts || []).length; i++) {
        var o = opts[i];
        if (o && (o.id === 'collaboration_mode' || o.category === 'collaboration_mode')) {
          return String(o.currentValue == null ? '' : o.currentValue).toLowerCase();
        }
      }
      return '';
    }

    function clearImplementPlanRow() {
      if (implementPlanRowEl && implementPlanRowEl.parentNode) {
        implementPlanRowEl.parentNode.removeChild(implementPlanRowEl);
      }
      implementPlanRowEl = null;
    }

    /** Offer the plan -> execution handoff once a plan-mode turn has produced a plan. */
    function offerImplementPlan() {
      if (!collabModeIsPlan || !sawPlanThisTurn || implementPlanRowEl) return;
      var row = addMessageDOM('system', '');
      if (!row) return;
      row.classList.add('implement-plan-row');
      row.textContent = 'Plan ready. Plan mode blocks edits — ';
      var btn = document.createElement('button');
      btn.className = 'implement-plan-btn';
      btn.textContent = 'Implement this plan';
      btn.title = 'Switch collaboration mode back to Default so the next message can apply changes';
      btn.addEventListener('click', function () {
        vscode.postMessage({ type: 'setConfigOption', configId: 'collaboration_mode', value: 'default' });
        clearImplementPlanRow();
        showTransientNotice('Switched to Default mode — send your next message to implement the plan.');
      });
      row.appendChild(btn);
      implementPlanRowEl = row;
      scrollToBottom();
    }

    function setConfigOptionsState(opts) {
      configOptions = Array.isArray(opts) ? opts : [];
      useConfigOptions = configOptions.length > 0;
      var _planVal = planModeValueFrom(configOptions);
      collabModeIsPlan = _planVal === 'plan';
      if (!collabModeIsPlan) clearImplementPlanRow();

      if (useConfigOptions) {
        // Hide legacy pickers — spec requires configOptions to be used exclusively
        modePickerWrap.classList.add('hidden');
        modelPickerWrap.classList.add('hidden');
        renderConfigPickers(configOptions);
        // Adopt the model from the config option. For agents that publish
        // configOptions INSTEAD of the legacy models field, this is the only
        // place the active model becomes known — and the Kiro / Codex
        // attach-button rule reads currentModelId, so without this the image
        // button stays hidden on a vision model after a resume.
        var _cfgModel = modelIdFromConfigOptions(configOptions);
        if (_cfgModel) {
          currentModelId = _cfgModel;
        }
        updateAttachButtonVisibility();
      } else {
        configOptionsContainer.innerHTML = '';
      }
    }

    // Toggle picker dropdowns
    modePickerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = modeDropdown.classList.contains('open');
      closePickers();
      if (!wasOpen) modeDropdown.classList.add('open');
    });

    modelPickerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = modelDropdown.classList.contains('open');
      closePickers();
      if (!wasOpen) modelDropdown.classList.add('open');
    });

    function closePickers() {
      modeDropdown.classList.remove('open');
      modelDropdown.classList.remove('open');
      // Close any dynamic config-option dropdowns
      const open = configOptionsContainer.querySelectorAll('.picker-dropdown.open');
      open.forEach(el => el.classList.remove('open'));
      hidePickerTooltip();
    }

    // --- Picker hover tooltip (shared by all picker dropdowns) ---
    const pickerTooltip = document.getElementById('pickerTooltip');

    function hidePickerTooltip() {
      if (pickerTooltip) pickerTooltip.classList.remove('visible');
    }

    function showPickerTooltip(itemEl) {
      if (!pickerTooltip || !itemEl) return;
      const desc = itemEl.dataset && itemEl.dataset.desc;
      if (!desc) { hidePickerTooltip(); return; }

      pickerTooltip.textContent = desc;
      // Make it measurable while invisible to the user.
      pickerTooltip.style.left = '-9999px';
      pickerTooltip.style.top = '-9999px';
      pickerTooltip.classList.add('visible');

      const dropdown = itemEl.closest('.picker-dropdown');
      if (!dropdown) { hidePickerTooltip(); return; }
      const dropRect = dropdown.getBoundingClientRect();
      const itemRect = itemEl.getBoundingClientRect();
      const tipRect = pickerTooltip.getBoundingClientRect();
      const gap = 6;

      // Prefer left side; flip to right if not enough room.
      let left = dropRect.left - tipRect.width - gap;
      if (left < 4) left = dropRect.right + gap;
      // Clamp horizontally inside the viewport.
      const maxLeft = window.innerWidth - tipRect.width - 4;
      if (left > maxLeft) left = Math.max(4, maxLeft);

      // Vertically align with the hovered item, clamped inside the viewport.
      let top = itemRect.top;
      const maxTop = window.innerHeight - tipRect.height - 4;
      if (top > maxTop) top = Math.max(4, maxTop);

      pickerTooltip.style.left = left + 'px';
      pickerTooltip.style.top = top + 'px';
    }

    // Delegated hover handling — one listener handles every picker dropdown.
    document.addEventListener('mouseover', (e) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const item = target.closest('.picker-dropdown-item');
      if (!item) return;
      // Only consider items inside an open dropdown.
      const dropdown = item.closest('.picker-dropdown');
      if (!dropdown || !dropdown.classList.contains('open')) return;
      showPickerTooltip(item);
    });

    document.addEventListener('mouseout', (e) => {
      const target = e.target;
      const related = e.relatedTarget;
      if (!(target instanceof Element)) return;
      const item = target.closest('.picker-dropdown-item');
      if (!item) return;
      // Stay visible if the mouse moved to another item inside the same dropdown.
      if (related instanceof Element) {
        const nextItem = related.closest('.picker-dropdown-item');
        if (nextItem && nextItem !== item) return;
      }
      hidePickerTooltip();
    });

    // Hide the tooltip when the user scrolls a dropdown so it doesn't drift.
    function attachScrollHide(dropdownEl) {
      if (!dropdownEl || dropdownEl._tooltipScrollAttached) return;
      dropdownEl._tooltipScrollAttached = true;
      dropdownEl.addEventListener('scroll', hidePickerTooltip);
    }
    attachScrollHide(modeDropdown);
    attachScrollHide(modelDropdown);
    // Dynamic configOption dropdowns: rely on the same handler via event-delegation
    // (they exist inside #configOptionsContainer); attach once per dropdown when created.
    if (configOptionsContainer) {
      const mo = new MutationObserver(() => {
        configOptionsContainer.querySelectorAll('.picker-dropdown').forEach(attachScrollHide);
      });
      mo.observe(configOptionsContainer, { childList: true, subtree: true });
    }

    // Close pickers when clicking outside
    document.addEventListener('click', () => closePickers());

    // --- Messages ---
   function addMessage(role, text) {
     // Drop the post-compact banner once the user continues chatting.
     if (role === 'user') clearCompactNotices();
     // New user message ends the previous assistant turn visually — do not
     // let later agent chunks / placeSummaryAssistant scoop into the old fold
     // (Claude ACP often streams between turns after promptEnd).
     if (role === 'user') {
       // Retire the finished turn's tool rows BEFORE the new turn opens: agents
       // that restart their tool numbering each turn (codex minted tc-1..tc-8
       // then opened the next turn at tc-1) would otherwise have the new turn
       // resolve to the previous turn's elements.
       if (typeof retireToolCallRegistry === 'function') retireToolCallRegistry();
       currentTurnEl = null;
       currentToolsListEl = null;
       currentToolsCountEl = null;
       currentToolCount = 0;
       currentAssistantEl = null;
       currentAssistantText = '';
       resetClaudeCrewState();
     }
     chatHistory.push({ kind: 'message', role, text });
     saveState();
     return addMessageDOM(role, text);
   }

   /** Show a transient system notification that auto-dismisses after 4s. */
   function showTransientNotice(text) {
     var el = addMessageDOM('system', text);
     if (el) {
       setTimeout(function () {
         if (el.parentNode) { el.parentNode.removeChild(el); }
       }, 4000);
     }
   }

   /**
    * Post-compact banner — DOM only (not chatHistory). Cleared when the user
    * sends the next message so it does not stick around forever.
    */
   function showCompactNotice() {
     clearCompactNotices();
     var el = addMessageDOM('system', 'Conversation compacted.');
     if (el) el.classList.add('compact-notice');
   }

   function clearCompactNotices() {
     if (!messagesEl) return;
     var nodes = messagesEl.querySelectorAll('.message.system.compact-notice');
     for (var i = 0; i < nodes.length; i++) {
       if (nodes[i].parentNode) nodes[i].parentNode.removeChild(nodes[i]);
     }
    // Also strip any persisted copy from an older build that saved it to history.
    var kept = [];
    var changed = false;
    for (var j = 0; j < chatHistory.length; j++) {
      var it = chatHistory[j];
      if (it && it.kind === 'message' && it.role === 'system' && (
          // Manual /compact notice.
          String(it.text || '').trim() === 'Conversation compacted.' ||
          // Auto-compact notice (e.g. "*Context compacted to fit the
          // model's context window.*"). Older builds persisted this to
          // chatHistory — strip it so it doesn't survive resume.
          String(it.text || '').trim().indexOf('*Context compacted') === 0 ||
          /conversation compacted/i.test(String(it.text || '').trim())
      )) {
        changed = true;
        continue;
      }
       kept.push(it);
     }
     if (changed) {
       chatHistory = kept;
       saveState();
     }
   }

  // Render user message content into an element, with session mention pills.
   // Uses string ops (not RegExp) to avoid template literal escape issues.
  function renderUserMessageContent(el, text) {
    // Debug: log renderUserMessageContent
    var _dbgRUMC = typeof text === 'string' ? (text.length > 100 ? text.substring(0, 100) + '...' : text) : '(non-string)';
    vscode.postMessage({ type: 'debugLog', message: 'renderUserMessageContent IN len=' + (typeof text === 'string' ? text.length : -1) + ' text="' + _dbgRUMC + '"' });
    if (typeof text !== 'string') { el.textContent = text; return; }
    // Check if text starts with "[@" and find the mention link pattern
    if (text.charCodeAt(0) === 91 /* '[' */ && text.charCodeAt(1) === 64 /* '@' */) {
       var closeBracket = text.indexOf('](', 2);
       if (closeBracket > 2) {
         var pillName = text.substring(2, closeBracket);
         var closeParen = text.indexOf(')', closeBracket + 2);
         if (closeParen > closeBracket) {
           var uriPart = text.substring(closeBracket + 2, closeParen);
           if (uriPart.indexOf('session:') === 0) {
             var afterLink = text.substring(closeParen + 1);
             var wsEnd = 0;
             while (wsEnd < afterLink.length) {
               var wsC = afterLink.charCodeAt(wsEnd);
               if (wsC === 32 || wsC === 10 || wsC === 13 || wsC === 9) { wsEnd++; } else break;
             }
             var restQuery = afterLink.substring(wsEnd);
             var pill = document.createElement('span');
             pill.className = 'session-mention-pill';
             pill.textContent = pillName;
             el.appendChild(pill);
             if (restQuery) {
               var sep = document.createElement('span');
               sep.className = 'session-mention-separator';
               sep.textContent = ' | ';
               el.appendChild(sep);
               var querySpan = document.createElement('span');
               querySpan.textContent = restQuery;
               el.appendChild(querySpan);
             }
             return;
           }
         }
       }
     }
     // Not a session mention — render file:// links as clickable
     renderUserMessageWithLinks(el, text);
   }

   function renderUserMessageWithLinks(el, text) {
     // Parse [@name](file:///path) and [name](file:///path) markdown links in user messages.
     // Uses string-based parsing (not RegExp) to avoid template literal escape issues
     // where backslashes in regex literals get stripped by the webview HTML processing pipeline.
     var pos = 0;
     var hasLink = false;
     while (pos < text.length) {
       var bracketStart = text.indexOf('[', pos);
       if (bracketStart < 0) break;
       var closeBracket = text.indexOf('](', bracketStart + 1);
       if (closeBracket < 0) break;
       var closeParen = text.indexOf(')', closeBracket + 2);
       if (closeParen < 0) break;
       var uriPart = text.substring(closeBracket + 2, closeParen);
       if (uriPart.indexOf('file:') !== 0) {
         pos = bracketStart + 1;
         continue;
       }
       // Found a valid link
       if (bracketStart > pos) {
         el.appendChild(document.createTextNode(text.substring(pos, bracketStart)));
       }
     var linkText = text.substring(bracketStart + 1, closeBracket);
     var linkUrl = uriPart;
     var a = document.createElement('a');
     a.className = 'file-link user-file-link';
     a.textContent = linkText;
     a.setAttribute('href', linkUrl);
     a.setAttribute('data-href', linkUrl);
     (function(url) {
       a.addEventListener('click', function(e) {
         e.preventDefault();
          // Parse file:// URL for line number and symbol
          var parsedLine = undefined;
          var parsedSymbol = undefined;
          try {
            var u = new URL(url);
            parsedSymbol = u.searchParams.get('symbol') || undefined;
            if (u.hash) {
              var frag = u.hash.replace(/^#/, '').replace(/^L/i, '');
              var dashIdx = frag.indexOf('-');
              var lineStr = dashIdx > 0 ? frag.slice(0, dashIdx).split(':')[0] : frag.split(':')[0];
              if (lineStr && lineStr.split('').every(function(c) { return c >= '0' && c <= '9'; })) {
                parsedLine = parseInt(lineStr, 10);
              }
            }
          } catch (err) { /* not a valid URL, pass as-is */ }
          if (parsedSymbol) {
            vscode.postMessage({ type: 'openSymbol', symbolName: parsedSymbol });
          } else {
            vscode.postMessage({ type: 'openFile', filePath: url, lineNumber: parsedLine, linkText: linkText });
          }
        });
     })(linkUrl);
      el.appendChild(a);
       hasLink = true;
       pos = closeParen + 1;
     }
     if (!hasLink) {
       el.textContent = text;
       return;
     }
     // Remaining text after last link
     if (pos < text.length) {
       el.appendChild(document.createTextNode(text.substring(pos)));
     }
   }

   function addMessageDOM(role, text) {
     hideEmpty();
     const el = document.createElement('div');
     el.className = 'message ' + role;
     if (role === 'user' && typeof text === 'string') {
       renderUserMessageContent(el, text);
     } else {
       el.textContent = text;
     }
     messagesEl.appendChild(el);
     scrollToBottom();
     return el;
   }

   function hideEmpty() {
     if (emptyState) {
       emptyState.style.display = 'none';
       if (emptyState.parentNode) emptyState.parentNode.removeChild(emptyState);
     }
   }

   // --- Smart auto-scroll ---
   // Track whether the user has scrolled away from the bottom.  When they
   // have, streaming chunks should NOT yank them back down.  The flag resets
   // when the user scrolls back to the bottom manually, or when a new
   // user/assistant turn starts.
   var userScrolledUp = false;
   // Show "Jump to latest" when streaming and scrolled this far from bottom.
   var JUMP_LATEST_THRESHOLD_PX = 180;
   var jumpLatestBtn = document.getElementById('jumpLatestBtn');

   function distanceFromBottom() {
     return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
   }

   function updateJumpLatestBtn() {
     if (!jumpLatestBtn) return;
     var show = isProcessing && distanceFromBottom() > JUMP_LATEST_THRESHOLD_PX;
     jumpLatestBtn.classList.toggle('visible', show);
   }

   messagesEl.addEventListener('scroll', function () {
     // Consider "at bottom" if within 50px of the bottom edge.
     var atBottom = distanceFromBottom() < 50;
     userScrolledUp = !atBottom;
     updateJumpLatestBtn();
     // Hide any visible tool-call tooltip so it doesn't float at a stale
     // position while the underlying element scrolls away.
     hideTcTooltip();
   });

   if (jumpLatestBtn) {
     jumpLatestBtn.addEventListener('click', function () {
       scrollToBottom();
     });
   }

   function scrollToBottom() {
     userScrolledUp = false;
     messagesEl.scrollTop = messagesEl.scrollHeight;
     updateJumpLatestBtn();
   }

   /** Auto-scroll only if the user hasn't scrolled away. */
   function autoScrollIfAtBottom() {
     if (!userScrolledUp) {
       messagesEl.scrollTop = messagesEl.scrollHeight;
     }
     updateJumpLatestBtn();
   }

 function getStatusIcon(status) {
    switch (status) {
       case 'running':
       case 'in_progress':
       // Cursor / Kiro emit "pending" for in-flight tools; Codex uses
       // "in_progress". Same glyph so every live tool shows a spinner.
       case 'pending': return '⟳';
      case 'completed': return '✓';
      case 'failed':
      case 'error': return '✗';
      default: return '…';
    }
  }

  /**
   * Cursor toolCallIds contain a literal newline before "fc_*". That breaks
   * HTML id attributes and getElementById — sanitize for DOM, keep the
   * original id as the toolCalls{} map key.
   */
  function toolCallElementId(toolCallId) {
    return 'tc-' + String(toolCallId || '').replace(/[\\n\\r]/g, '__');
  }

  /**
   * Cursor wire IDs are "call-…\\nfc_…"; store.db / some updates use the
   * escaped "call-…\\\\nfc_…" form. Build lookup aliases so tool_call and
   * tool_call_update still resolve to the same DOM row.
   */
  function toolCallIdLookupKeys(toolCallId) {
    var id = String(toolCallId || '');
    var keys = [];
    function addKey(k) {
      if (k && keys.indexOf(k) < 0) keys.push(k);
    }
    addKey(id);
    // Real newline ↔ escaped \\n
    if (id.indexOf('\\n') >= 0) addKey(id.replace(/\\n/g, '\\\\n'));
    if (id.indexOf('\\\\n') >= 0) addKey(id.replace(/\\\\n/g, '\\n'));
    var parts = id.split(/\\n|\\\\n/);
    if (parts.length > 1) {
      addKey(parts[0]);
      addKey(parts[parts.length - 1]);
    }
    return keys;
  }

  function toolCallIdsMatch(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    var ka = toolCallIdLookupKeys(a);
    var kb = toolCallIdLookupKeys(b);
    for (var i = 0; i < ka.length; i++) {
      if (kb.indexOf(ka[i]) >= 0) return true;
    }
    var fa = String(a).match(/fc_[A-Za-z0-9_-]+/);
    var fb = String(b).match(/fc_[A-Za-z0-9_-]+/);
    // Require exact fc_* token match (including _N). A shared batch UUID
    // stem without the suffix would collide across parallel tools.
    if (fa && fb && fa[0] === fb[0]) return true;
    return false;
  }

  /** Cursor ACP stub titles that need store.db enrichment. */
  function isCursorStubToolTitle(title) {
    var t = String(title || '').trim().toLowerCase();
    if (!t) return true;
    if (t === 'read file' || t === 'edit file' || t === 'write file' || t === 'delete file') return true;
    if (t === 'read' || t === 'write' || t === 'edit' || t === 'delete') return true;
    if (t === 'grep' || t === 'find' || t === 'search' || t === 'glob') return true;
    if (t === 'shell' || t === 'bash' || t === 'terminal' || t === 'run') return true;
    if (t === 'list directory' || t.indexOf('mcp:') === 0) return true;
    return false;
  }

  function hasCursorStubToolsInHistory() {
    for (var i = 0; i < chatHistory.length; i++) {
      var item = chatHistory[i];
      if (item && item.kind === 'toolCall' && isCursorStubToolTitle(item.title)) return true;
    }
    return false;
  }

  function requestCursorToolEnrichIfNeeded(reason) {
    if (!isCursorAgentSession()) return;
    if (!hasCursorStubToolsInHistory()) return;
    vscode.postMessage({
      type: 'cursorRequestToolEnrich',
      sessionId: (sessionState && sessionState.sessionId) || null,
      reason: reason || 'stub-tools',
    });
  }

  var cursorStubEnrichRetryTimer = null;
  var cursorStubEnrichRetryCount = 0;
  var cursorStubEnrichLastApplied = 0;
  function scheduleCursorStubEnrichRetry() {
    if (!hasCursorStubToolsInHistory()) {
      cursorStubEnrichRetryCount = 0;
      cursorStubEnrichLastApplied = 0;
      return;
    }
    // Batch already ran but could not match every stub — a few retries only.
    if (cursorStubEnrichRetryCount >= 5) return;
    if (cursorStubEnrichRetryTimer) return;
    var delayMs = cursorStubEnrichRetryCount === 0 ? 400 : 800;
    cursorStubEnrichRetryTimer = setTimeout(function() {
      cursorStubEnrichRetryTimer = null;
      if (!hasCursorStubToolsInHistory()) {
        cursorStubEnrichRetryCount = 0;
        cursorStubEnrichLastApplied = 0;
        return;
      }
      cursorStubEnrichRetryCount++;
      requestCursorToolEnrichIfNeeded('stub-retry');
      scheduleCursorStubEnrichRetry();
    }, delayMs);
  }

  /** Rebuild fold summary titles from live .tc-title after store.db enrich. */
  function refreshAllTurnToolSummaries() {
    messagesEl.querySelectorAll('.turn').forEach(function(turn) {
      var summary = getTurnSummaryEl(turn);
      var lists = turn.querySelectorAll('.turn-tools-list');
      if (!summary || !lists.length) return;
      var titles = [];
      var kinds = [];
      var rawInputs = [];
      lists.forEach(function(list) {
        var meta = collectToolMetaFromList(list);
        titles = titles.concat(meta.titles);
        kinds = kinds.concat(meta.kinds);
        rawInputs = rawInputs.concat(meta.rawInputs);
      });
      summary._titles = titles;
      summary._kinds = kinds;
      summary._rawInputs = rawInputs;
      summary.dataset.count = String(titles.length);
      updateToolGroupSummary(summary, titles.length, titles, kinds, rawInputs);
    });
  }

  /** Keep compact-mode fold summary in sync when a tool title is enriched. */
  function syncToolTitleToTurnSummaries(toolCallId, title, rawInput) {
    if (!title) return;
    var el = lookupToolCallEl(toolCallId);
    if (!el) return;
    var turn = el.closest ? el.closest('.turn') : null;
    if (!turn) return;
    var toolIndex = -1;
    var counted = 0;
    var lists = turn.querySelectorAll('.turn-tools-list');
    for (var li = 0; li < lists.length; li++) {
      var rows = lists[li].querySelectorAll('.tool-call-inline');
      for (var ri = 0; ri < rows.length; ri++) {
        if (rows[ri].getAttribute('data-parent-tool')) continue;
        if (rows[ri] === el) {
          toolIndex = counted;
          break;
        }
        counted++;
      }
      if (toolIndex >= 0) break;
    }
    if (toolIndex < 0) return;
    var summary = getTurnSummaryEl(turn);
    if (!summary) return;
    if (!summary._titles) summary._titles = [];
    if (!summary._kinds) summary._kinds = [];
    if (!summary._rawInputs) summary._rawInputs = [];
    while (summary._titles.length <= toolIndex) summary._titles.push('');
    while (summary._rawInputs.length <= toolIndex) summary._rawInputs.push(null);
    summary._titles[toolIndex] = title;
    if (rawInput) summary._rawInputs[toolIndex] = rawInput;
    updateToolGroupSummary(
      summary,
      parseInt(summary.dataset.count || String(counted), 10) || counted,
      summary._titles,
      summary._kinds,
      summary._rawInputs
    );
    if (currentTurnEl === turn && currentToolsCountEl === summary) {
      currentToolsCountEl._titles = summary._titles;
      currentToolsCountEl._rawInputs = summary._rawInputs;
    }
  }

  function cursorEnrichKind(toolName, title, toolKind) {
    var n = String(toolName || '').trim().toLowerCase();
    var t = String(title || '').trim().toLowerCase();
    var k = String(toolKind || '').trim().toLowerCase();
    if (n === 'read' || n === 'read_file' || n === 'readfile' || t === 'read file' || t.indexOf('read ') === 0 || k === 'read') return 'read';
    if (n === 'grep' || n === 'rg' || n === 'ripgrep' ||
        t === 'grep' || t === 'search' || t.indexOf('grep ') === 0 || k === 'fetch') return 'grep';
    if (n === 'glob' || n === 'find' || n === 'listdir' || n === 'list_dir' ||
        t === 'find' || t === 'glob' || t.indexOf('find ') === 0) return 'glob';
    if (n === 'write' || n === 'write_file' || n === 'writefile') return 'write';
    if (n === 'delete' || n === 'delete_file' || n === 'deletefile' || k === 'delete') return 'delete';
    if (n === 'streplace' || n === 'strreplace' || n === 'str_replace' || n === 'edit' || n === 'applypatch' ||
        t === 'edit file' || t.indexOf('edit ') === 0 || t.indexOf('strreplace ') === 0 || k === 'edit') return 'edit';
    if (t === 'write file' || t.indexOf('write ') === 0) return 'write';
    if (t === 'delete file' || t.indexOf('delete ') === 0) return 'delete';
    if (n === 'shell' || n === 'bash' || n === 'run' || k === 'execute') return 'shell';
    if (k === 'search') {
      if (t.indexOf('find ') === 0) return 'glob';
      if (t.indexOf('grep ') === 0) return 'grep';
      return 'grep';
    }
    return 'other';
  }

  /**
   * Apply store.db-enriched titles after session/load. Wire replay-* ids never
   * match store keys, so fall back to kind-ordered matching for stub rows.
   * Every history row (stub or already enriched) consumes the next same-kind
   * store entry so ordinal alignment stays correct across mixed titles.
   */
  function handleCursorToolEnrichBatch(tools) {
    if (!tools || !tools.length) return;
    var byId = {};
    var queues = { read: [], grep: [], glob: [], edit: [], write: [], delete: [], shell: [], other: [] };
    var applied = 0;
    // Preserve store.db rowid order from listEnrichedTools — do NOT sort by
    // the trailing -N suffix alone (each turn resets to -0 and scrambles grep).
    for (var i = 0; i < tools.length; i++) {
      var t = tools[i];
      if (!t || !t.title) continue;
      var id = String(t.toolCallId || '');
      if (id) {
        byId[id] = t;
        var keys = toolCallIdLookupKeys(id);
        for (var ki = 0; ki < keys.length; ki++) byId[keys[ki]] = t;
      }
      var kind = cursorEnrichKind(t.toolName, t.title, null);
      if (!queues[kind]) queues[kind] = [];
      queues[kind].push(t);
    }

    function takeById(toolCallId) {
      var keys = toolCallIdLookupKeys(toolCallId);
      for (var i = 0; i < keys.length; i++) {
        if (byId[keys[i]]) {
          var hit = byId[keys[i]];
          for (var ak in byId) {
            if (byId[ak] === hit) delete byId[ak];
          }
          var qk = cursorEnrichKind(hit.toolName, hit.title, null);
          var q = queues[qk] || [];
          var qi = q.indexOf(hit);
          if (qi >= 0) q.splice(qi, 1);
          return hit;
        }
      }
      return null;
    }

    function takeFromQueue(kind) {
      var queue = queues[kind] || [];
      if (!queue.length) return null;
      var ordinal = queue.shift();
      for (var bk in byId) {
        if (byId[bk] === ordinal) delete byId[bk];
      }
      return ordinal;
    }

    function takeByKind(kind) {
      var tryKinds = kind === 'glob' ? ['glob', 'grep'] :
        kind === 'grep' ? ['grep', 'glob'] :
        kind === 'edit' ? ['edit', 'write', 'delete'] :
        kind === 'write' ? ['write', 'edit', 'delete'] :
        kind === 'delete' ? ['delete', 'edit', 'write'] : [kind];
      for (var ti = 0; ti < tryKinds.length; ti++) {
        var hit = takeFromQueue(tryKinds[ti]);
        if (hit) return hit;
      }
      return null;
    }

    function applyCursorEnrichedToolToDom(toolCallId, resolvedTitle, rawInput, locations) {
      var el = lookupToolCallEl(toolCallId || '');
      if (!el) return false;
      if (rawInput) el._rawInput = rawInput;
      if (locations) el._locations = locations;
      var titleEl = el.querySelector('.tc-title');
      if (titleEl) {
        titleEl.textContent = resolvedTitle;
        el._toolTitle = resolvedTitle;
      }
      syncToolTitleToTurnSummaries(toolCallId, resolvedTitle, rawInput);
      return true;
    }

    for (var hi = 0; hi < chatHistory.length; hi++) {
      var item = chatHistory[hi];
      if (!item || item.kind !== 'toolCall') continue;
      var isStub = isCursorStubToolTitle(item.title);
      var histKind = cursorEnrichKind(
        (item.rawInput && (item.rawInput._toolName || item.rawInput.toolName)) || '',
        item.title,
        item.toolKind || null
      );
      var histHit = takeById(item.toolCallId || '');
      if (!histHit) {
        histHit = takeByKind(histKind);
      }
      if (!histHit) continue;
      if (!isStub) continue;
      var hitRaw = histHit.rawInput || null;
      if (histHit.toolName) {
        hitRaw = hitRaw && typeof hitRaw === 'object' ? Object.assign({}, hitRaw) : {};
        if (!hitRaw._toolName) hitRaw._toolName = histHit.toolName;
      }
      var resolvedTitle = resolveToolCallDisplayTitle(
        histHit.title,
        hitRaw,
        histHit.locations,
        item.toolKind || null
      );
      if (isCursorStubToolTitle(resolvedTitle) && histHit.title && !isCursorStubToolTitle(histHit.title)) {
        resolvedTitle = histHit.title;
      }
      item.title = resolvedTitle;
      if (hitRaw) item.rawInput = hitRaw;
      if (histHit.locations) item.locations = histHit.locations;
      updateToolCall(
        item.toolCallId || histHit.toolCallId,
        undefined,
        resolvedTitle,
        undefined,
        hitRaw
      );
      applyCursorEnrichedToolToDom(item.toolCallId || histHit.toolCallId, resolvedTitle, hitRaw, histHit.locations);
      applied++;
    }
    refreshAllTurnToolSummaries();
    saveState();
    cursorStubEnrichLastApplied = applied;
    var remainingStubs = 0;
    for (var ri = 0; ri < chatHistory.length; ri++) {
      var ritem = chatHistory[ri];
      if (ritem && ritem.kind === 'toolCall' && isCursorStubToolTitle(ritem.title)) remainingStubs++;
    }
    if (remainingStubs > 0) {
      vscode.postMessage({
        type: 'debugLog',
        message: '[WV-DIAG] Cursor batch enrich: applied=' + applied + ' remainingStubs=' + remainingStubs,
      });
    }
    if (hasCursorStubToolsInHistory()) {
      if (applied > 0) {
        scheduleCursorStubEnrichRetry();
      } else if (cursorStubEnrichRetryCount < 5) {
        scheduleCursorStubEnrichRetry();
      }
    } else {
      cursorStubEnrichRetryCount = 0;
      cursorStubEnrichLastApplied = 0;
    }
  }

  /**
   * Close the current turn's tool registry so the next turn cannot adopt it.
   *
   * Moves live rows into retiredToolCalls, renames their DOM ids (a duplicate id
   * would make getElementById return the OLDER element) and drops the live
   * data-tool-call-id attribute so stage selectors cannot match across turns.
   * Returns the number of rows retired, for the test and the trace.
   */
  function retireToolCallRegistry() {
    var moved = 0;
    var k;
    for (k in toolCalls) {
      if (!Object.prototype.hasOwnProperty.call(toolCalls, k)) continue;
      var el = toolCalls[k];
      retiredToolCalls[k] = el;
      if (el && el.id && String(el.id).indexOf('retired-') !== 0) {
        el.setAttribute('data-live-tool-el-id', el.id);
        el.id = 'retired-' + toolIdRetireGen + '-' + el.id;
      }
      moved++;
    }
    var stages = document.querySelectorAll('[data-tool-call-id]');
    for (var i = 0; i < stages.length; i++) {
      var v = stages[i].getAttribute('data-tool-call-id');
      if (!v) continue;
      stages[i].setAttribute('data-retired-tool-call-id', v);
      stages[i].removeAttribute('data-tool-call-id');
    }
    toolCalls = {};
    toolIdRetireGen++;
    return moved;
  }

  function lookupToolCallEl(toolCallId) {
    var keys = toolCallIdLookupKeys(toolCallId);
    var i;
    for (i = 0; i < keys.length; i++) {
      if (toolCalls[keys[i]]) return toolCalls[keys[i]];
    }
    for (i = 0; i < keys.length; i++) {
      var byDom = document.getElementById(toolCallElementId(keys[i]));
      if (byDom) return byDom;
    }
    // Fuzzy: map key contains the same fc_* or call-* prefix.
    var want = String(toolCallId || '');
    var wantFcMatch = want.match(/fc_[A-Za-z0-9_-]+/);
    var wantFc = wantFcMatch ? wantFcMatch[0] : '';
    var wantCall = want.split(/\\n|\\\\n/)[0];
    for (var k in toolCalls) {
      if (!Object.prototype.hasOwnProperty.call(toolCalls, k)) continue;
      if (wantFc && k.indexOf(wantFc) >= 0) return toolCalls[k];
      if (wantCall && k.indexOf(wantCall) === 0) return toolCalls[k];
    }
    // Last resort: a row from a turn that has already ended. A cancelled turn
    // keeps emitting for a moment — the agent started a tool 750ms AFTER the
    // cancel and reported it later — and that update belongs to its ORIGINAL
    // row, not to whatever turn happens to be open now.
    for (i = 0; i < keys.length; i++) {
      if (retiredToolCalls[keys[i]]) return retiredToolCalls[keys[i]];
    }
    return null;
  }

  /**
   * Normalize ACP tool status for the live UI.
   * Codex sends "in_progress" (mapped to "running" → spinning icon).
   * Cursor / Kiro often send "pending" first — without remapping, the icon
   * stays a static ellipsis with no CSS spin. While the turn is in flight,
   * treat pending like running so every tool call matches Codex behavior.
   */
  function normalizeLiveToolStatus(status) {
    var s = status === 'in_progress' ? 'running' : (status || 'pending');
    if (s === 'pending' && isProcessing && !isLoadingSession) {
      return 'running';
    }
    return s;
  }

  function isCursorAgentSession() {
    return /cursor/i.test(currentAgentLabel());
  }

  /** Enable acp.debugResume to trace Cursor session/update (compaction diagnostics). */
  function cursorCompactionTraceEnabled() {
    return DEBUG || DEBUG_RESUME;
  }

  function summarizeCursorSessionUpdate(update) {
    var kind = update && update.sessionUpdate ? String(update.sessionUpdate) : '(missing)';
    var parts = ['kind=' + kind];
    if (kind === 'compaction_update') {
      parts.push('status=' + (update.status || ''));
      if (update.error) parts.push('error=' + String(update.error).slice(0, 80));
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      parts.push('title="' + String(update.title || '').slice(0, 60) + '"');
      parts.push('status=' + (update.status || ''));
      if (update._meta && update._meta.contextCompaction != null) {
        parts.push('contextCompaction=' + JSON.stringify(update._meta.contextCompaction));
      }
      if (update._meta) {
        parts.push('_metaKeys=' + Object.keys(update._meta).join(','));
      }
    }
    if ((kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') &&
        update.content && update.content.type === 'text') {
      var t = String(update.content.text || '').trim();
      parts.push('textLen=' + t.length);
      if (/compact/i.test(t) || t.length < 200) {
        parts.push('preview="' + t.replace(/\\s+/g, ' ').slice(0, 100) + '"');
      }
    }
    return parts.join(' ');
  }

  function logCursorHandleUpdate(update) {
    if (!cursorCompactionTraceEnabled() || !isCursorAgentSession()) return;
    resumeDiag('[CURSOR-ACP-WV] ' + summarizeCursorSessionUpdate(update) +
      ' isCompacting=' + isCompacting + ' manual=' + manualCompacting);
  }

  /**
   * Cursor ACP rarely/never sends status:"completed" on tool_call_update —
   * tools stay pending/running and keep spinning. When the model moves on
   * (next tool / thought / message), mark prior plain tools completed so
   * the spinner stops. Skips subagent crew parents (their stages own status).
   */
  function completeInFlightToolCalls(exceptId) {
    if (isLoadingSession) return;
    var changed = false;
    for (var tid in toolCalls) {
      if (!Object.prototype.hasOwnProperty.call(toolCalls, tid)) continue;
      if (exceptId && toolCallIdsMatch(tid, exceptId)) continue;
      var el = toolCalls[tid];
      if (!el) continue;
      if (el.getAttribute('data-subagent-crew') || el.getAttribute('data-claude-crew') ||
          el.querySelector(':scope > .tc-stages')) {
        continue;
      }
      var iconEl = el.querySelector(':scope > .tc-icon') || el.querySelector('.tc-icon');
      if (!iconEl) continue;
      if (iconEl.classList.contains('running') || iconEl.classList.contains('pending') ||
          iconEl.classList.contains('in_progress')) {
        iconEl.className = 'tc-icon completed';
        iconEl.textContent = getStatusIcon('completed');
        changed = true;
      }
    }
    for (var hi = 0; hi < chatHistory.length; hi++) {
      var item = chatHistory[hi];
      if (!item || item.kind !== 'toolCall') continue;
      if (exceptId && toolCallIdsMatch(item.toolCallId, exceptId)) continue;
      if (item.status !== 'in_progress' && item.status !== 'running' && item.status !== 'pending') {
        continue;
      }
      var raw = item.rawInput;
      if (raw && typeof raw === 'object' && Array.isArray(raw.stages) && raw.stages.length > 0) {
        continue;
      }
      item.status = 'completed';
      changed = true;
    }
    if (changed) saveState();
  }

    function setFoldExpanded(body, expanded) {
      if (!body) return;
      if (expanded) {
        body.classList.add('expanded');
        body.classList.remove('collapsed');
      } else {
        body.classList.remove('expanded');
        body.classList.add('collapsed');
      }
    }

    function attachTurnSummaryClick(summary) {
      if (summary._foldClickBound) return;
      summary._foldClickBound = true;
      summary.addEventListener('click', function() {
        var turn = summary.closest('.turn');
        // Prefer the real fold body — nextElementSibling can be an assistant
        // summary bubble, which made the caret lie and toggled the wrong node.
        var body = (turn && getTurnFoldBody(turn)) || summary.nextElementSibling;
        if (!body) return;
        // Compact-mode CSS uses .expanded as the open flag; otherwise .collapsed.
        var willExpand = (messagesEl && messagesEl.classList.contains('compact-mode'))
          ? !body.classList.contains('expanded')
          : body.classList.contains('collapsed');
       setFoldExpanded(body, willExpand);
       // Sticky expand records the user's INTENT. It is deliberately not
       // gated on isProcessing: ensureCurrentTurnFold() runs on every
       // mid-stream tool call and thought, and agents can emit updates while
       // isProcessing reads false (see "Claude ACP may keep streaming between
       // turns" below) — clearing the flag then snapped a fold the user had
       // just opened right back shut. Completed turns are still shut by
       // promptEnd (_endBody._userExpanded = false) and by
       // forceCollapseTurnFolds() on history restore, so this cannot leak open.
       body._userExpanded = !isLoadingSession && willExpand;
       // When expanding a fold during streaming, the content grows via CSS
       // (no scroll event fires), so userScrolledUp stays false. The next
       // streaming chunk's autoScrollIfAtBottom() then yanks the user back
       // to the bottom, away from the expanded content they wanted to read.
       // Treat a manual expand as "user wants to read above" — disable
       // auto-scroll until the user scrolls back to the bottom themselves.
       if (willExpand && isProcessing && !isLoadingSession) {
         userScrolledUp = true;
         updateJumpLatestBtn();
       }
       // Collapsing mid-stream:
        // - Tools still running / pre-tools chatter → keep live bubble in fold
        //   (Codex/Claude mid-turn leak fix).
        // - Tools idle → this is the end-turn summary: lift it outside so it
        //   stays visible in the main chat while it finishes streaming (Kiro).
        if (!willExpand && isProcessing && currentAssistantEl && turn &&
            turn.contains(currentAssistantEl) &&
            !currentAssistantEl.classList.contains('md-committed')) {
         if (isLikelyFinalSummaryStreaming(turn)) {
           placeSummaryAssistant(currentAssistantEl);
         } else {
           moveAssistantIntoFold(currentAssistantEl);
         }
       }
       // When expanding a completed turn, move the assistant-summary (which
       // sits outside the fold for collapsed display) back INTO the fold body
       // as an interim segment, then re-sort by history index so it appears at
       // its correct chronological position (e.g. thought → tools → assistant
       // → tools → assistant) instead of floating at the top or bottom.
       // When collapsing, promote the last assistant back outside as the
       // visible summary.
       // Gate: only skip for the LIVE streaming turn (currentTurnEl === turn
       // with in-flight tools or uncommitted assistant). Completed turns —
       // even earlier ones expanded while the current turn is streaming —
       // always get the full interleave treatment.
       var _isLiveTurn = isProcessing && !isLoadingSession &&
         currentTurnEl && turn === currentTurnEl &&
         (turnElHasRunningTools(turn) ||
          (currentAssistantEl && turn.contains(currentAssistantEl) &&
           !currentAssistantEl.classList.contains('md-committed')));
       if (!_isLiveTurn) {
         if (willExpand) {
           var _outsideAsst = turn.querySelectorAll(':scope > .message.assistant.assistant-summary');
           if (_outsideAsst.length && body) {
             // Resume merge can stamp the turn's LAST tool with a history index
             // ABOVE the final reply's (e.g. tool#318 vs summary#317). Folding
             // the summary back in as an interim segment then lets the index
             // sort drop that tool BELOW the reply — the "last tool call shows
             // after the summary when expanded" bug. Pin the demoted summary
             // behind every completed tool of the turn via the fold-order
             // override (data-history-index stays untouched — snapshot merging
             // keys off it). Running/pending tools are ignored: a tool still in
             // flight after the reply is a genuine interruption and keeps its
             // real position.
             var _maxDoneToolIdx = -1;
             Array.prototype.forEach.call(
               turn.querySelectorAll('.turn-tools'),
               function(tc) {
                 if (turnElHasRunningTools(tc)) return;
                 var _ti = assistantHistoryIndex(tc);
                 if (_ti > _maxDoneToolIdx) _maxDoneToolIdx = _ti;
               }
             );
             _outsideAsst.forEach(function(a) {
               a.classList.add('assistant-interim');
               a.classList.remove('assistant-summary');
               var _ai = assistantHistoryIndex(a);
               if (_ai >= 0 && _maxDoneToolIdx > _ai) {
                 a.setAttribute('data-fold-sort-key', String(_maxDoneToolIdx + 0.5));
               } else {
                 a.removeAttribute('data-fold-sort-key');
               }
               body.appendChild(a);
             });
             orderCompactFoldContents(body);
             // [WV-DIAG] Order the user actually sees after expanding. Gated on
             // acp.debugResume — no-op in normal operation.
             if (typeof resumeDiag === 'function') {
               resumeDiag(
                 '[WV-DIAG] fold-expand-order: maxDoneToolIdx=' + _maxDoneToolIdx +
                 ' body=[' + Array.prototype.map.call(body.children, function(c) {
                   var _i = c.getAttribute ? (c.getAttribute('data-fold-sort-key') || c.getAttribute('data-history-index')) : null;
                   return String(c.className || c.tagName).split(' ')[0] + (_i != null ? '#' + _i : '');
                 }).join(' | ') + ']'
               );
             }
           }
         } else {
           // Collapse: re-promote the last assistant outside the fold.
           promoteFinalAssistantForTurn(turn);
         }
       }
       hideTcTooltip();
       var count = parseInt(summary.dataset.count || '0', 10);
       updateToolGroupSummary(summary, count, summary._titles || [], summary._kinds || [], summary._rawInputs || []);
      });
    }

    function getTurnSummaryEl(turn) {
      if (!turn) return null;
      return turn.querySelector(':scope > .turn-tools-summary')
        || turn.querySelector(':scope > .turn-tools > .turn-tools-summary');
    }

    function getTurnFoldBody(turn) {
      if (!turn) return null;
      return turn.querySelector(':scope > .turn-fold-body')
        || turn.querySelector(':scope > .turn-tools > .turn-fold-body');
    }

    /**
     * Track user scroll position inside a thought-content element. When the
     * user scrolls up to read earlier reasoning, streaming chunks must NOT
     * yank them back to the top (or bottom). The _userScrolledUp flag is
     * checked by the agent_message_chunk (thought) handler before forcing
     * scrollTop. It resets when the user scrolls back near the bottom.
     */
    function attachThoughtContentScrollTracker(el) {
      if (!el || el._scrollTrackerBound) return;
      el._scrollTrackerBound = true;
      el._userScrolledUp = false;
     el.addEventListener('scroll', function() {
       var atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
       el._userScrolledUp = !atBottom;
     });
   }

    /**
     * Track user-initiated expand/collapse of a thought <details> block.
     * When the user manually opens a thought to read the streaming reasoning,
     * _userExpanded is set to true so commitOrDiscardCurrentThought does NOT
     * force it shut when a tool call / assistant text / promptEnd commits it.
     * Without this, every agent_message_chunk snapped the thought shut
     * instantly — the "expand collapsed → collapses again during streaming" bug.
     */
    function attachThoughtExpandTracker(detailsEl) {
      if (!detailsEl || detailsEl._expandTrackerBound) return;
      detailsEl._expandTrackerBound = true;
      detailsEl._userExpanded = false;
      detailsEl.addEventListener('toggle', function() {
        detailsEl._userExpanded = detailsEl.open;
      });
    }

   function isMeaningfulThought(el) {
      if (!el) return false;
      if (el === currentThoughtEl) return true;
      if (el.classList.contains('streaming')) return true;
      var content = el.querySelector('.thought-content');
      if (content && content.textContent && content.textContent.trim()) return true;
      // Keep finalized cards even if content was briefly empty.
      var sum = el.querySelector('summary');
      var sumText = (sum && sum.textContent) || '';
      return /Thought\\b/i.test(sumText);
    }

    /** Full thought text from DOM + in-progress buffers (never drop mid-turn). */
    function getAccumulatedThoughtText() {
      var fromDom = '';
      if (currentThoughtTextEl && typeof currentThoughtTextEl.textContent === 'string') {
        fromDom = currentThoughtTextEl.textContent;
      }
      var fromBuf = ((thoughtDomBase || '') + (currentThoughtText || ''));
      var best = fromDom.trim() ? fromDom : fromBuf;
      return (best || '').replace(/^\\s+/, '').replace(/\\n{3,}/g, '\\n\\n').trim();
    }

    function commitOrDiscardCurrentThought() {
     if (!currentThoughtEl && !(currentThoughtText || thoughtDomBase)) return;
     if (currentThoughtEl) {
       finalizeThought();
       // Preserve user-expanded thought blocks: if the user manually opened
       // the <details> to read the streaming reasoning, don't force it shut
       // when a tool call / assistant text / promptEnd commits the thought.
       // This was the root cause of "expand collapsed in kiro → collapses
       // again during streaming" — commitOrDiscardCurrentThought ran on
       // every agent_message_chunk, snapping the thought shut instantly.
       if (!currentThoughtEl._userExpanded) {
         currentThoughtEl.open = false;
       }
     }
     var historyText = getAccumulatedThoughtText();
     if (historyText) {
        // Ensure DOM still shows the committed text (reuse paths can desync).
        if (currentThoughtEl && currentThoughtTextEl && !currentThoughtTextEl.textContent.trim()) {
          currentThoughtTextEl.textContent = historyText;
        }
       // Avoid duplicate history entries when assistant-start already finalized
       // and tools/promptEnd commit the same block again.
       if (!currentThoughtEl || !currentThoughtEl._thoughtCommitted) {
         // If this thought was resumed from a previously committed block,
         // update the existing chatHistory entry instead of pushing a duplicate.
         if (currentThoughtEl && typeof currentThoughtEl._historyIndex === 'number' &&
             currentThoughtEl._historyIndex >= 0 && currentThoughtEl._historyIndex < chatHistory.length &&
             chatHistory[currentThoughtEl._historyIndex] &&
             chatHistory[currentThoughtEl._historyIndex].kind === 'thought') {
          chatHistory[currentThoughtEl._historyIndex].text = historyText;
          chatHistory[currentThoughtEl._historyIndex].durationSec =
            thoughtStartTime ? Math.round(((thoughtEndTime || Date.now()) - thoughtStartTime) / 1000) : 0;
          saveState();
          if (currentThoughtEl) {
            currentThoughtEl._thoughtCommitted = true;
            // Ensure DOM attribute matches the JS property (may have been
            // set on a prior commit — but if the element was re-created via
            // resume-from-streaming, only _historyIndex was restored).
            currentThoughtEl.setAttribute('data-history-index', String(currentThoughtEl._historyIndex));
          }
           } else {
             chatHistory.push({
               kind: 'thought',
               text: historyText,
               durationSec: thoughtStartTime ? Math.round(((thoughtEndTime || Date.now()) - thoughtStartTime) / 1000) : 0,
             });
             saveState();
             if (currentThoughtEl) {
               currentThoughtEl._thoughtCommitted = true;
               currentThoughtEl._historyIndex = chatHistory.length - 1;
               // Stamp the DOM attribute so orderCompactFoldContents sorts
               // this thought relative to tool groups by history index.
               // Without it, historyOrder() returns MAX_SAFE_INTEGER and the
               // thought sinks below stamped tool groups in the fold.
               currentThoughtEl.setAttribute('data-history-index', String(chatHistory.length - 1));
             }
           }
       }
        if (currentTurnEl) {
          var sumEl = getTurnSummaryEl(currentTurnEl);
          if (sumEl) sumEl._hasThought = true;
        }
      } else if (currentThoughtEl && currentThoughtEl.parentNode) {
        // Only drop never-filled placeholders (no text ever arrived).
        currentThoughtEl.parentNode.removeChild(currentThoughtEl);
      }
      currentThoughtEl = null;
      currentThoughtTextEl = null;
      currentThoughtText = '';
      thoughtDomBase = '';
      thoughtEndTime = null;
      thoughtStartTime = null;
    }

    /**
     * Compact layout:
     *   .turn
     *     > .turn-tools-summary          (tool summary / fold chrome)
     *     > .turn-fold-body              (collapsed when Collapse is on)
     *         > .thought-block*
     *         > .turn-tools > list
     *         > .message.assistant.assistant-interim*   (mid-turn text)
     *     > .message.assistant.assistant-summary        (final reply — always visible)
     * @param force  when true, create the fold shell even before any content
     *                exists (needed so the first thought lands inside the fold).
     */
    function ensureTurnFoldStructure(turn, collapsed, force) {
      if (!turn) return null;

      // Collect pieces from any prior layout (turn-level or nested under .turn-tools).
      // Multiple .turn-tools groups are intentional (thought/tools interleaved).
      var summary = getTurnSummaryEl(turn);
      var body = getTurnFoldBody(turn);
      var allLists = Array.prototype.slice.call(turn.querySelectorAll('.turn-tools-list'));
      var thoughts = Array.prototype.slice.call(turn.querySelectorAll('.thought-block'));
      var allAssistants = Array.prototype.slice.call(turn.querySelectorAll('.message.assistant'));
      // Mid-turn assistant segments go in the fold; the last/summary stays outside.
     var interimAssistants = [];
     var summaryAssistants = [];
     allAssistants.forEach(function(a) {
       // While the turn is still streaming, keep live/uncommitted assistants
       // inside the fold. ensureTurnFoldStructure used to treat unmarked
       // nodes as summary and park them outside; expand → rebuild → collapse
       // then left Codex mid-turn text visible in the panel.
       // Exception: placeSummaryAssistant on promptEnd (md-committed) or when
       // the user manually collapses during end-turn summary.
       if (isProcessing && !isLoadingSession &&
           !(a.classList.contains('assistant-summary') && a.classList.contains('md-committed'))) {
         a.classList.add('assistant-interim');
         a.classList.remove('assistant-summary');
         interimAssistants.push(a);
         return;
       }
       if (a.classList.contains('assistant-interim')) interimAssistants.push(a);
        else summaryAssistants.push(a);
      });
      // If nothing is classified yet, treat all but the last as interim.
      if (interimAssistants.length === 0 && summaryAssistants.length > 1) {
        interimAssistants = summaryAssistants.slice(0, -1);
        summaryAssistants = summaryAssistants.slice(-1);
        interimAssistants.forEach(function(a) {
          a.classList.add('assistant-interim');
          a.classList.remove('assistant-summary');
        });
      }
     // Do NOT auto-promote the last interim to summary here. Mid-turn commits
     // clear currentAssistantEl; promoting then made each segment flash in the
     // panel until the next one arrived and demoted it. Only placeSummaryAssistant
     // (promptEnd) may lift a reply out.
     // During renderChatHistory (suppressFoldOrdering), skip promotion —
     // promoteFinalAssistantForTurn at the end of renderChatHistory handles it.
     if (!suppressFoldOrdering && !keepAssistantsInFold) {
       summaryAssistants.forEach(function(a) {
         a.classList.add('assistant-summary');
         a.classList.remove('assistant-interim');
       });
     }

      // Count meaningful thoughts for the summary flag. Never delete thought
      // nodes here — removing "empty" blocks during fold rebuild made later
      // thoughts flash then vanish, and left only the first thought after unwrap.
      var meaningfulThoughts = thoughts.filter(isMeaningfulThought);

      if (!force && !summary && meaningfulThoughts.length === 0 && allAssistants.length === 0 && allLists.length === 0) {
        return null;
      }

      if (!summary) {
        summary = document.createElement('div');
        summary.className = 'turn-tools-summary';
        summary.dataset.count = '0';
        summary.style.display = 'none';
      }
      // Only one summary header per turn — leftovers from older nested layouts
      // stack as a second line and look like the detail was concatenated.
      Array.prototype.slice.call(turn.querySelectorAll('.turn-tools-summary')).forEach(function(extra) {
        if (extra !== summary) extra.remove();
      });
      if (meaningfulThoughts.length) summary._hasThought = true;
      // Restore tool meta from wraps / lists when re-enabling Collapse.
      if ((!summary._titles || !summary._titles.length)) {
        var aggTitles = [];
        var aggKinds = [];
        var aggRaw = [];
        var aggSub = false;
        Array.prototype.forEach.call(turn.querySelectorAll('.turn-tools'), function(wrap) {
          if (wrap._titles && wrap._titles.length) {
            aggTitles = aggTitles.concat(wrap._titles);
            aggKinds = aggKinds.concat(wrap._kinds || []);
            aggRaw = aggRaw.concat(wrap._rawInputs || []);
            if (wrap._hasSubagent) aggSub = true;
          }
        });
        if (!aggTitles.length) {
          allLists.forEach(function(list) {
            var collected = collectToolMetaFromList(list);
            aggTitles = aggTitles.concat(collected.titles);
            aggKinds = aggKinds.concat(collected.kinds);
            aggRaw = aggRaw.concat(collected.rawInputs);
            if (collected.hasSubagent) aggSub = true;
          });
        }
        if (aggTitles.length) {
          summary._titles = aggTitles;
          summary._kinds = aggKinds;
          summary._rawInputs = aggRaw;
          summary._hasSubagent = aggSub;
          summary.dataset.count = String(aggTitles.length);
        }
      }
      attachTurnSummaryClick(summary);

     if (!body) {
       // Create already-collapsed so a missing class never flashes open content.
       // Preserve _userExpanded from any legacy nested body (under .turn-tools)
       // so a fold the user opened during streaming stays open across rebuilds.
       var _legacyBody = turn.querySelector(':scope > .turn-tools > .turn-fold-body');
       var _legacyExpanded = !!(_legacyBody && (_legacyBody._userExpanded ||
                        _legacyBody.classList.contains('expanded')));
       body = document.createElement('div');
       body.className = collapsed ? 'turn-fold-body collapsed' : 'turn-fold-body';
       if (_legacyExpanded) body._userExpanded = true;
     }

     // Rebuild into the canonical turn-level structure.
      // Always pin summary as the first child so nothing (e.g. an early thought)
      // can sit above the collapse control outside the fold.
      turn.insertBefore(summary, turn.firstChild);
      if (summary.nextSibling !== body) {
        if (summary.nextSibling) turn.insertBefore(body, summary.nextSibling);
        else turn.appendChild(body);
      }

      // Each tools list keeps its own wrap (left rail) — never merge groups.
      allLists.forEach(function(list) {
        var wrap = list.closest('.turn-tools');
        if (!wrap) {
          wrap = document.createElement('div');
          wrap.className = 'turn-tools';
          if (list.parentNode) list.parentNode.insertBefore(wrap, list);
          wrap.appendChild(list);
        }
      });

      // Keep fold contents in document/turn order (do not regroup all thoughts
      // before all tools — that made newer blocks look like they overwrote older ones).
      // Skip during renderChatHistory — items are already in append order.
      if (!suppressFoldOrdering)
      orderCompactFoldContents(body);

     // Final summary assistant(s) always sit after the fold (visible while collapsed).
     // During renderChatHistory (suppressFoldOrdering), skip — leave all
     // assistants inside the fold. promoteFinalAssistantForTurn at the end
     // of renderChatHistory will handle promotion correctly.
    if (!suppressFoldOrdering && !keepAssistantsInFold) {
      summaryAssistants.forEach(function(a) {
        if (body.nextSibling) turn.insertBefore(a, body.nextSibling);
        turn.appendChild(a);
      });
    } else if (keepAssistantsInFold && body) {
      summaryAssistants.forEach(function(a) {
        a.classList.add('assistant-interim');
        a.classList.remove('assistant-summary');
        // Only move if outside the body — preserve interleaved order
        // when already inside (rendering loop places items in order).
        if (!body.contains(a)) body.appendChild(a);
      });
    }

      // Live streaming bubble stays inside the fold while processing.
      // Manual collapse during end-turn summary may have lifted it; only
      // re-fold when tools are still clearly mid-turn.
      if (isProcessing && !isLoadingSession && currentAssistantEl &&
          turn.contains(currentAssistantEl) &&
          !currentAssistantEl.classList.contains('md-committed') &&
          !currentAssistantEl.classList.contains('assistant-summary')) {
        currentAssistantEl.classList.add('assistant-interim');
        currentAssistantEl.classList.remove('assistant-summary');
        body.appendChild(currentAssistantEl);
      }

      // Default shut. Honor sticky expand whenever the user opened this fold —
      // never during session/load. NOT gated on isProcessing: this runs on every
      // mid-stream tool call, and a false reading between turns used to clear
      // the flag and re-collapse a fold the user had just expanded. promptEnd
      // and forceCollapseTurnFolds() still shut completed turns.
      var allowSticky = collapsed && body._userExpanded && !isLoadingSession;
      if (collapsed && !allowSticky) {
        body._userExpanded = false;
        setFoldExpanded(body, false);
      } else if (allowSticky) {
        setFoldExpanded(body, true);
      } else if (!collapsed) {
        body.classList.remove('collapsed');
        body.classList.add('expanded');
      }

      var count = parseInt(summary.dataset.count || '0', 10);
      updateToolGroupSummary(summary, count, summary._titles || [], summary._kinds || [], summary._rawInputs || []);
      return body;
    }

    /** Every turn fold must be shut in Collapse mode (history + promptEnd). */
    function forceCollapseTurnFolds() {
      if (!compactMode) return;
      messagesEl.querySelectorAll('.turn').forEach(function(turn) {
        // Scoop any stray thoughts/tools that escaped the fold, then shut it.
        ensureTurnFoldStructure(turn, true);
        var body = getTurnFoldBody(turn);
        if (!body) return;
        body._userExpanded = false;
        setFoldExpanded(body, false);
        var summary = getTurnSummaryEl(turn);
        if (summary) {
          updateToolGroupSummary(
            summary,
            parseInt(summary.dataset.count || '0', 10),
            summary._titles || [],
            summary._kinds || [],
            summary._rawInputs || []
          );
        }
      });
    }

    /**
     * Durable diagnostic: after a resume render (restore or session/load),
     * snapshot the promotion decision for every turn so we can see WHY a
     * completed summary stayed folded / an assistant strayed. Writes to a
     * host-persisted file (not the rotating output channel) so it survives
     * the session.
     */

    /**
     * Scoop foldable nodes into the fold body preserving document order:
     * thought / tools / interim assistant segments as they occurred in the turn.
     */
function orderCompactFoldContents(body) {
  if (!body) return;
    var turn = body.parentElement;
    if (!turn || !turn.classList.contains('turn')) return;


    var foldables = [];
     function consider(el) {
       if (!el || foldables.indexOf(el) >= 0) return;
       if (el.classList.contains('thought-block')) { foldables.push(el); return; }
       if (el.classList.contains('turn-tools')) { foldables.push(el); return; }
       if (el.classList.contains('message') && el.classList.contains('assistant') &&
           el.classList.contains('assistant-interim')) {
         foldables.push(el);
       }
     }
     // Prefer current body order, then any strays still on the turn.
     Array.prototype.forEach.call(body.children, consider);
     Array.prototype.forEach.call(turn.children, function(child) {
       if (child === body || child.classList.contains('turn-tools-summary')) return;
       consider(child);
       if (child.classList.contains('turn-fold-body') && child !== body) {
         Array.prototype.forEach.call(child.children, consider);
       }
     });
    // Stable order by original history index. Each foldable was rendered from
    // chatHistory[i] and stamped with data-history-index; using it (instead of
    // compareDocumentPosition on not-yet-inserted .turn-tools wrappers)
    // preserves the true interleaved order:
    // thought → tools → interim assistant → tools → assistant.
    // Node.compareDocumentPosition returns 0 for nodes not yet in the DOM,
    // which collapsed all later-created .turn-tools groups into one block.
    function historyOrder(el) {
      // Explicit fold-order override. data-history-index is the snapshot key
      // (merge/dedup rely on it and must never be rewritten), so callers that
      // KNOW the chronology — e.g. the fold expander, which knows the demoted
      // element was the turn's final reply — pin the position here instead.
      var ov = el && el.getAttribute ? el.getAttribute('data-fold-sort-key') : null;
      if (ov !== null && ov !== undefined && String(ov).trim() !== '') {
        var on = Number(ov);
        if (Number.isFinite(on)) return on;
      }
      var v = el && el.getAttribute ? el.getAttribute('data-history-index') : null;
      if (v !== null && v !== undefined && String(v).trim() !== '') {
        var n = Number(v);
        return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
      }
      if (el && el._historyIndex != null) {
        var legacy = Number(el._historyIndex);
        if (Number.isFinite(legacy)) return legacy;
      }
      if (el && el.querySelector) {
        // .turn-tools wrappers may carry a min index directly; otherwise use
        // the first descendant stamped with one (tool row or nested item).
        if (el.classList && el.classList.contains('turn-tools')) {
          var wrapIdx = el.getAttribute('data-history-index');
          if (wrapIdx !== null && wrapIdx !== undefined && String(wrapIdx).trim() !== '') {
            var wn = Number(wrapIdx);
            if (Number.isFinite(wn)) return wn;
          }
        }
        var first = el.querySelector('[data-history-index]');
        if (first && first.getAttribute) {
          var fv = first.getAttribute('data-history-index');
          if (fv !== null && fv !== undefined && String(fv).trim() !== '') {
            var fn = Number(fv);
            return Number.isFinite(fn) ? fn : Number.MAX_SAFE_INTEGER;
          }
        }
      }
      return Number.MAX_SAFE_INTEGER;
    }
    // Nodes with no stamp (legacy groups, subagent crew rows, anything created
    // before it lands in chatHistory) must keep the position they were appended
    // at. Scoring them MAX_SAFE_INTEGER made every unstamped tool group sink to
    // the bottom of the fold, so an expanded turn showed all thoughts, then all
    // tools, instead of thought → tools → text → tools. Inherit the preceding
    // key + 0.5 so an unstamped node stays adjacent to its predecessor.
    var _keys = foldables.map(historyOrder);
    var _lastKnown = -1;
    for (var _ki = 0; _ki < _keys.length; _ki++) {
      if (_keys[_ki] === Number.MAX_SAFE_INTEGER) {
        _keys[_ki] = _lastKnown + 0.5;
      } else {
        _lastKnown = _keys[_ki];
      }
    }
    // Decorate-sort-undecorate: explicit tie-break on the original position so
    // equal keys never reorder, independent of engine sort stability.
    var _decorated = foldables.map(function(el, i) { return { el: el, key: _keys[i], i: i }; });
    _decorated.sort(function(a, b) { return (a.key - b.key) || (a.i - b.i); });
    foldables = _decorated.map(function(d) { return d.el; });
    // Append sorted (stable) — preserves interleaved order.
    foldables.forEach(function(el) { body.appendChild(el); });
  }

    /** Place the visible final assistant summary after the fold (after commit). */
    function placeSummaryAssistant(assistantEl) {
      if (!currentTurnEl) return;
      assistantEl.classList.add('assistant-summary');
      assistantEl.classList.remove('assistant-interim');
      if (compactMode) {
        ensureCurrentTurnFold();
        var body = getTurnFoldBody(currentTurnEl);
        if (body) {
          // Demote any prior summary so only the true final reply sits outside.
          Array.prototype.forEach.call(
            currentTurnEl.querySelectorAll('.message.assistant.assistant-summary'),
            function(prev) {
              if (prev === assistantEl) return;
              prev.classList.add('assistant-interim');
              prev.classList.remove('assistant-summary');
              body.appendChild(prev);
            }
          );
          // Also fold any unmarked live assistants that slipped outside.
          Array.prototype.forEach.call(
            currentTurnEl.querySelectorAll(':scope > .message.assistant'),
            function(prev) {
              if (prev === assistantEl || prev.classList.contains('assistant-summary')) return;
              prev.classList.add('assistant-interim');
              prev.classList.remove('assistant-summary');
              body.appendChild(prev);
            }
          );
          if (body.nextSibling) currentTurnEl.insertBefore(assistantEl, body.nextSibling);
          currentTurnEl.appendChild(assistantEl);
          return;
        }
      }
      currentTurnEl.appendChild(assistantEl);
    }

    /**
     * Mid-turn Codex/Claude chatter must stay inside the fold while Collapse
     * is on. Only promote a live bubble outside after tools go idle for a
     * short debounce (likely the end-turn summary), or on promptEnd.
     */
    var provisionalSummaryTimer = null;

    function cancelProvisionalSummaryPromote() {
      if (provisionalSummaryTimer) {
        clearTimeout(provisionalSummaryTimer);
        provisionalSummaryTimer = null;
      }
    }

    function turnHasRunningTools() {
      if (!currentTurnEl) return false;
      return turnElHasRunningTools(currentTurnEl);
    }

    function turnElHasRunningTools(turn) {
      if (!turn) return false;
      return !!turn.querySelector(
        '.tc-icon.running, .tc-icon.in_progress, .tc-icon.pending, ' +
        '.tc-stage-icon.running, .tc-stage-icon.in_progress, .tc-stage-icon.pending'
      );
    }

    function turnHasAnyTools() {
      if (currentToolCount > 0) return true;
      if (!currentTurnEl) return false;
      return turnElHasAnyTools(currentTurnEl);
    }

    function turnElHasAnyTools(turn) {
      if (!turn) return false;
      if (turn.querySelector('.tool-call-inline, .tool-call')) return true;
      var sum = getTurnSummaryEl(turn);
      return !!(sum && parseInt(sum.dataset.count || '0', 10) > 0);
    }

    /**
     * True when the live bubble is likely the end-turn summary (tools exist,
     * parent tool rows idle). Used only for manual collapse-promote — auto
     * streaming always stays folded until promptEnd.
     */
    function isLikelyFinalSummaryStreaming(turn) {
      var t = turn || currentTurnEl;
      if (!isProcessing || isLoadingSession || !currentAssistantEl) return false;
      if (!t) return false;
      if (!turnElHasAnyTools(t)) return false;
      if (t.querySelector(
        '.tool-call-inline > .tc-icon.running, .tool-call-inline > .tc-icon.in_progress, .tool-call-inline > .tc-icon.pending'
      )) {
        return false;
      }
      return true;
    }

    function scheduleProvisionalSummaryPromote() {
      // Disabled for auto streaming — promoting when parent tools go idle
      // leaked Kiro replies into the main chat while stages still ran.
      // Manual collapse still lifts via attachTurnSummaryClick; promptEnd
      // lifts via placeSummaryAssistant.
      cancelProvisionalSummaryPromote();
    }

    /** After history restore: lift the last assistant out of the fold as the reply. */
    function assistantHistoryIndex(el) {
      if (!el || !el.getAttribute) return -1;
      var v = el.getAttribute('data-history-index');
      if (v === null || v === undefined || String(v).trim() === '') return -1;
      var n = Number(v);
      return Number.isFinite(n) ? n : -1;
    }

    function getLastAssistantByHistoryIndex(assistants) {
      if (!assistants || !assistants.length) return null;
      var best = assistants[0];
      var bestIdx = assistantHistoryIndex(best);
      for (var ai = 1; ai < assistants.length; ai++) {
        var idx = assistantHistoryIndex(assistants[ai]);
        if (idx > bestIdx) {
          bestIdx = idx;
          best = assistants[ai];
        }
      }
      return best;
    }

    function promoteFinalAssistantForTurn(turn) {
      if (!turn || !compactMode) return;
      if (keepAssistantsInFold) return;
      var assistants = Array.prototype.slice.call(turn.querySelectorAll('.message.assistant'));
      if (!assistants.length) return;
      var body = getTurnFoldBody(turn) || ensureTurnFoldStructure(turn, true, true);
      var summaryEl = getLastAssistantByHistoryIndex(assistants);
      // Interrupted turns: keep every assistant inside the fold (thoughts +
      // tools + partial reply together). Otherwise Codex resume promoted the
      // last bubble to the main chat while expand still grouped the rest.
      // Finished turns must still promote the summary outside — never wrap a
      // completed reply just because the session was interrupted earlier.
      var isLastTurn = !turn.nextElementSibling || !turn.parentElement ||
        turn === turn.parentElement.querySelector('.turn:last-of-type');
      var turnFinished = turnLooksFinished(turn) ||
        (isLastTurn && historyLastTurnLooksFinished());
      // An interrupted turn whose last assistant is NOT the final item (a
      // thought/tool was still emitted after it when the reload/cancel hit)
      // must also force-fold: promoting that mid-sentence reply to the main
      // chat leaves the trailing thought stranded above the summary. The
      // !turnFinished clause covers the usual case; the trailingContent check
      // covers the reload-while-active case where the turn still "looks
      // finished" (all tools completed) but the last bubble was cut mid-way.
      var lastAsstIdx = assistantHistoryIndex(summaryEl);
      // Only an IN-FLIGHT (running/pending) thought or tool after the last
      // assistant indicates a genuinely interrupted turn that must force-fold
      // (the reload/cancel cut it mid-tool). A COMPLETED tool/thought with an
      // index above the last assistant is almost always a resume-merge
      // history-index mis-ordering — the tool belongs *before* the final
      // reply but got a higher index on replay. Force-folding on that hides a
      // finished assistant reply inside the collapsed title (the "assistant
      // msg is in the collapsed title" symptom). So only count trailing
      // content that is still running/pending.
      var trailingContentAfterLastAsst = turnLooksInterrupted(turn) &&
        Array.prototype.some.call(
          turn.querySelectorAll('.thought-block, .turn-tools'),
          function(el) {
            var v = el && el.getAttribute ? el.getAttribute('data-history-index') : null;
            if (v === null || v === undefined || String(v).trim() === '') return false;
            var n = Number(v);
            if (!(Number.isFinite(n) && n > lastAsstIdx)) return false;
            // In-flight only: a running/pending tool or a thought block that
            // is still being streamed. Completed tools are not interruption.
            if (el.classList && el.classList.contains('turn-tools')) {
              return !!el.querySelector(
                '.tc-icon.running, .tc-icon.in_progress, .tc-icon.pending, ' +
                '.tc-stage-icon.running, .tc-stage-icon.in_progress, .tc-stage-icon.pending'
              );
            }
            // .thought-block — treat as trailing only if still streaming
            // (not yet committed to a finished assistant).
            return el.classList && el.classList.contains('streaming');
          }
        );
      var forceFold = foldInterruptedAssistantsOnPromote &&
        turnLooksInterrupted(turn) &&
        (!turnFinished || trailingContentAfterLastAsst);
      // [WV-DIAG] Trace WHY a turn's assistant ends up folded into the
      // collapsed title on resume (the "assistant msg is in the collapsed
      // title" symptom). Reports every input to the forceFold decision so we
      // can see whether an interrupted flag, a trailing thought/tool, or a
      // stale history-index is wrongly collapsing a finished turn. Gated on
      // acp.debugResume — no-op in normal operation.
      resumeDiag(
        '[WV-DIAG] promoteFinalAssistantForTurn: turn=' +
        (turn && turn.dataset ? (turn.dataset.historyIndex ?? '?') : '?') +
        ' assistants=' + assistants.length +
        ' compactMode=' + compactMode +
        ' keepAssistantsInFold=' + keepAssistantsInFold +
        ' foldInterruptedAssistantsOnPromote=' + foldInterruptedAssistantsOnPromote +
        ' turnLooksInterrupted=' + turnLooksInterrupted(turn) +
        ' turnFinished=' + turnFinished +
        ' trailingContentAfterLastAsst=' + trailingContentAfterLastAsst +
        ' forceFold=' + forceFold +
        ' lastAsstIdx=' + lastAsstIdx,
      );
      if (forceFold) {
        assistants.forEach(function(a) {
          a.classList.add('assistant-interim');
          a.classList.remove('assistant-summary');
          a.setAttribute('data-interrupted', '1');
        });
       // Do NOT body.appendChild here — that dumps every assistant at the
       // fold bottom and breaks thought → tools → reply order on Kiro
       // interrupted resume. Mark interim, then scoop strays in document order.
       if (body && !suppressFoldOrdering) orderCompactFoldContents(body);
       if (turn) turn.setAttribute('data-turn-interrupted', '1');
        // Ensure the ▸ header is visible — interrupted turns often have only
        // thoughts / interim reply (Claude after cancel + VS Code restart).
        var foldSummary = getTurnSummaryEl(turn);
        if (foldSummary) {
          if (turn.querySelector('.thought-block')) foldSummary._hasThought = true;
          updateToolGroupSummary(
            foldSummary,
            parseInt(foldSummary.dataset.count || '0', 10),
            foldSummary._titles || [],
            foldSummary._kinds || [],
            foldSummary._rawInputs || []
          );
        }
        return;
      }
    assistants.forEach(function(a) {
      if (a === summaryEl) {
         a.classList.add('assistant-summary');
         a.classList.remove('assistant-interim');
         a.removeAttribute('data-interrupted');
         turn.appendChild(a);
        } else {
          a.classList.add('assistant-interim');
          a.classList.remove('assistant-summary');
        }
      });
     // Re-home interim segments in document order (avoid append-to-bottom).
     if (body && !suppressFoldOrdering) orderCompactFoldContents(body);
     // [WV-DIAG] Trailing-tool-after-summary probe: reports any completed tool
     // call whose history index is ABOVE the promoted summary's index, plus the
     // summary's own DOM position relative to the fold body. This isolates the
     // "tool shows after summary when expanded" case — a resume-merge
     // history-index mis-ordering where the last tool sorts after the promoted
     // summary inside the fold. Gated on acp.debugResume — no-op in normal
     // operation.
     if (typeof resumeDiag === 'function') {
       var _sIdx = assistantHistoryIndex(summaryEl);
       var _trail = Array.prototype.slice.call(
         turn.querySelectorAll('.turn-tools')
       ).map(function(tc) {
         var _ti = assistantHistoryIndex(tc);
         var _running = !!tc.querySelector(
           '.tc-icon.running, .tc-icon.in_progress, .tc-icon.pending, ' +
           '.tc-stage-icon.running, .tc-stage-icon.in_progress, .tc-stage-icon.pending'
         );
         var _parent = tc.parentNode && tc.parentNode.className ? tc.parentNode.className.split(' ')[0] : (tc.parentNode ? tc.parentNode.tagName : '?');
         return 'tool#' + _ti + (tc === summaryEl ? '(=summary?)' : '') + (_running ? '[running]' : '[done]') + '@' + _parent;
       }).filter(function(s) { return s.indexOf('tool#') === 0; });
       var _turnKids = Array.prototype.map.call(turn.children, function(c) {
         var _idx = c.getAttribute ? c.getAttribute('data-history-index') : null;
         var _cls = c.className || c.tagName;
         return _cls.split(' ')[0] + (_idx != null ? '#' + _idx : '');
       }).join(' | ');
       resumeDiag(
         '[WV-DIAG] promote-trailing-probe: summaryIdx=' + _sIdx +
         ' summaryParent=' + (summaryEl.parentNode ? (summaryEl.parentNode.className || summaryEl.parentNode.tagName) : '?') +
         ' turnKids=[' + _turnKids + '] trailingTools=[' + _trail.join(', ') + ']'
       );
     }
     // [WV-DIAG] Dump the fold body children order AFTER the interleave sort so
     // we can see whether tools and assistants are truly interleaved by
     // data-history-index, or grouped (all tools, then all assistants). Gated on
     // acp.debugResume — no-op in normal operation.
     if (typeof resumeDiag === 'function' && body) {
       var _foldOrder = Array.prototype.map.call(body.children, function(c) {
         var _idx = c.getAttribute ? c.getAttribute('data-history-index') : null;
         var _cls = c.className || c.tagName;
         return _cls.split(' ')[0] + (_idx != null ? '#' + _idx : '');
       }).join(' | ');
       resumeDiag('[WV-DIAG] fold-body-after-sort: ' + _foldOrder);
     }
   }

    function sessionMarkedInterrupted() {
      var sid = sessionState && sessionState.sessionId;
      return !!(sid && interruptedSessionIds[sid]);
    }

    function markSessionInterrupted() {
      var sid = sessionState && sessionState.sessionId;
      if (!sid) return;
      interruptedSessionIds[sid] = true;
      saveState();
    }

    function clearSessionInterrupted() {
      var sid = sessionState && sessionState.sessionId;
      if (!sid || !interruptedSessionIds[sid]) return;
      delete interruptedSessionIds[sid];
      saveState();
    }

    /** Claude (and some adapters) record cancel as a user history line. */
    function isSessionInterruptNotice(text) {
      var t = String(text || '').trim();
      if (!t) return false;
      if (/^\\[Request interrupted by user\\]/i.test(t)) return true;
      if (/^Request interrupted by user\\.?$/i.test(t)) return true;
      if (/^—?\\s*Conversation interrupted\\s*—?$/i.test(t)) return true;
      return false;
    }

    /**
     * Return the TRAILING run of real user prompts in a chatHistory snapshot —
     * the messages that sit after the last assistant / tool / thought entry,
     * which is what makes them provably unanswered.
     *
     * Used when session/load comes back empty (the agent created a fresh
     * session) and the snapshot is therefore discarded: the old transcript goes
     * away, but a prompt the user just sent is not part of that transcript and
     * must survive. Interrupt notices and blank rows are not real prompts.
     */
    function collectUnansweredTrailingPrompts(snapshot) {
      var out = [];
      if (!snapshot) return out;
      for (var i = snapshot.length - 1; i >= 0; i--) {
        var item = snapshot[i];
        if (!item) continue;
        if (item.kind === 'message' && item.role === 'user') {
          if (String(item.text || '').trim() && !isSessionInterruptNotice(item.text)) {
            out.unshift(item);
          }
          continue;
        }
        break;
      }
      return out;
    }

    /** Scan chatHistory for Claude interrupt notices; mark session + prior assistant. */
    function applyInterruptNoticesFromHistory() {
      var lastInterrupt = -1;
      var lastRealUser = -1;
      for (var i = 0; i < chatHistory.length; i++) {
        var item = chatHistory[i];
        if (!item || item.kind !== 'message' || item.role !== 'user') continue;
        if (isSessionInterruptNotice(item.text)) lastInterrupt = i;
        else lastRealUser = i;
      }
      if (lastInterrupt < 0) return false;
      // Only mark the session interrupted when the interrupt notice is NOT
      // followed by a completed (non-interrupted) assistant reply. If the user
      // said "go on" after an interrupt and the model produced a final answer,
      // the turn is finished — stale interrupt notices from earlier turns must
      // not brand it as interrupted.
      var hasCompletedAssistantAfter = false;
      for (var ci = lastInterrupt + 1; ci < chatHistory.length; ci++) {
        var afterItem = chatHistory[ci];
        if (afterItem && afterItem.kind === 'message' && afterItem.role === 'assistant' && !afterItem.interrupted) {
          hasCompletedAssistantAfter = true;
          break;
        }
        if (afterItem && afterItem.kind === 'message' && afterItem.role === 'user' && !isSessionInterruptNotice(afterItem.text)) {
          break;
        }
      }
      for (var j = lastInterrupt - 1; j >= 0; j--) {
        var prev = chatHistory[j];
        if (!prev) continue;
        if (prev.kind === 'message' && prev.role === 'assistant') {
          prev.interrupted = true;
          break;
        }
        if (prev.kind === 'message' && prev.role === 'user' && !isSessionInterruptNotice(prev.text)) {
          break;
        }
      }
      // Only mark the session interrupted when the interrupt is the latest
      // end (no later real user prompt AND no completed assistant after it).
      // Otherwise "go on" after interrupt would keep wrapping finished
      // summaries inside the fold.
      if (lastInterrupt > lastRealUser && !hasCompletedAssistantAfter) {
        markSessionInterrupted();
        return true;
      }
      return false;
    }

    /**
     * True when chatHistory's last user turn completed successfully (assistant
     * present, no failed/in-flight tools, not ended on an interrupt notice).
     */
    function historyLastTurnLooksFinished() {
      var lastUser = -1;
      for (var i = chatHistory.length - 1; i >= 0; i--) {
        var it = chatHistory[i];
        if (it && it.kind === 'message' && it.role === 'user' && !isSessionInterruptNotice(it.text)) {
          lastUser = i;
          break;
        }
      }
      if (lastUser < 0) return false;
      // An interrupt notice after the last real user does NOT mean the turn
      // was interrupted — the user may have said "go on" after the interrupt
      // and the model completed. Only treat the turn as unfinished when the
      // interrupt notice is the actual last item (no completed assistant
      // reply follows it).
      var hasCompletedAssistantAfterUser = false;
      for (var j = lastUser + 1; j < chatHistory.length; j++) {
        var x = chatHistory[j];
        if (x && x.kind === 'message' && x.role === 'assistant' && !x.interrupted) {
          hasCompletedAssistantAfterUser = true;
          break;
        }
      }
      if (!hasCompletedAssistantAfterUser) {
        // No completed assistant after the last real user — check if there's
        // a trailing interrupt notice (which would indicate the turn was
        // actually interrupted, not just empty).
        for (var j2 = chatHistory.length - 1; j2 > lastUser; j2--) {
          var x2 = chatHistory[j2];
          if (x2 && x2.kind === 'message' && x2.role === 'user' && isSessionInterruptNotice(x2.text)) {
            return false;
          }
        }
      }
     var hasCompletedTool = false;
     var lastAssistant = null;
     for (var k = lastUser + 1; k < chatHistory.length; k++) {
       var item = chatHistory[k];
       if (!item) continue;
       if (item.kind === 'message' && item.role === 'assistant') {
         lastAssistant = item;
       }
       if (item.kind === 'toolCall') {
         var st = item.status;
         // Failed tools do NOT prevent a turn from looking finished —
         // the agent completed its turn (end_turn) even if some tools failed.
         // Only in-flight tools indicate the turn was interrupted.
         if (st === 'pending' || st === 'running' || st === 'in_progress') {
           return false;
         }
         if (st === 'completed') hasCompletedTool = true;
       }
     }
     // Only the final assistant segment matters — earlier interim segments
     // may carry interrupted=true from a prior cancel without blocking end_turn.
     if (lastAssistant && lastAssistant.interrupted) return false;
     // A turn is finished when the agent either replied with text
     // (lastAssistant) OR completed all tool calls without any in-flight
     // ones. Codex's session/load replay may omit the final
     // agent_message_chunk when the assistant content was empty (the
     // model only called tools and produced no summary text). In that
     // case, a completed spawn_parallel tool_call IS the turn's result —
     // treating it as interrupted would mark all subagent stages as failed.
     return !!(lastAssistant || hasCompletedTool);
   }

    /** Clear stale interrupted flag when the loaded history ended successfully. */
    function reconcileInterruptedSessionFlag(failedAnyTool) {
      applyInterruptNoticesFromHistory();
      if (historyLastTurnLooksFinished()) {
        clearSessionInterrupted();
        return;
      }
      if (failedAnyTool) markSessionInterrupted();
    }
    function turnLooksInterrupted(turn) {
      if (!turn) return false;
      if (turn.getAttribute('data-turn-interrupted') === '1') return true;
      if (turn.querySelector('.message.assistant[data-interrupted="1"]')) return true;
      // If the turn has a non-interrupted assistant reply, failed tools alone
      // do NOT make it look interrupted — the agent finished its turn despite
      // some tool failures. Only running/in-flight tools indicate interruption.
      if (turn.querySelector('.message.assistant:not([data-interrupted="1"])')) {
        return !!(
          turn.querySelector(
            '.tc-icon.running, .tc-icon.in_progress, .tc-icon.pending, ' +
            '.tc-stage-icon.running, .tc-stage-icon.in_progress, .tc-stage-icon.pending'
          )
        );
      }
      return !!(
        turn.querySelector(
          '.tc-icon.failed, .tc-icon.error, .tc-stage-icon.error, .tc-stage-icon.failed'
        ) ||
        turn.querySelector(
          '.tc-icon.running, .tc-icon.in_progress, .tc-icon.pending, ' +
          '.tc-stage-icon.running, .tc-stage-icon.in_progress, .tc-stage-icon.pending'
        )
      );
    }

    /** True when a turn has a final reply and no in-flight tools.
     *  Failed tool calls do NOT prevent a turn from looking finished —
     *  the agent completed its turn (end_turn) even if some tools failed. */
    function turnLooksFinished(turn) {
      if (!turn) return false;
      if (!turn.querySelector('.message.assistant')) return false;
      if (turnElHasRunningTools(turn)) return false;
      // A non-interrupted assistant means the agent produced a final reply.
      if (turn.querySelector('.message.assistant:not([data-interrupted="1"])')) return true;
      // Fall back to chatHistory when DOM flags are stale after resume merge.
      if (historyLastTurnLooksFinished()) return true;
      return false;
    }

    /** Mark a crew so later Kiro list_update cannot revive its stages. */
    function markSubagentCrewStale(crewEl) {
      if (!crewEl) return;
      crewEl.setAttribute('data-crew-stale', '1');
    }

    function markFailedCrewsStale(root) {
      var scope = root || document;
      var crews = scope.querySelectorAll
        ? scope.querySelectorAll('.tool-call-inline.tc-subagent')
        : [];
      for (var i = 0; i < crews.length; i++) {
        var crew = crews[i];
        var parentBad = crew.querySelector(':scope > .tc-icon.failed, :scope > .tc-icon.error');
        var stageBad = crew.querySelector('.tc-stage-icon.error, .tc-stage-icon.failed');
        if (parentBad || stageBad) markSubagentCrewStale(crew);
      }
    }

    function isStaleOrTerminalStage(stageEl) {
      if (!stageEl) return true;
      var crew = stageEl.closest('.tool-call-inline');
      if (crew && crew.getAttribute('data-crew-stale') === '1') return true;
      var icon = stageEl.querySelector('.tc-stage-icon');
      if (!icon) return false;
      return icon.classList.contains('error') ||
        icon.classList.contains('failed') ||
        icon.classList.contains('completed');
    }

    /** Move a committed mid-turn assistant segment into the collapsed fold. */
   function moveAssistantIntoFold(assistantEl) {
     if (!assistantEl || !currentTurnEl || !compactMode) return;
     assistantEl.classList.add('assistant-interim');
     assistantEl.classList.remove('assistant-summary');
     var body = ensureCurrentTurnFold();
     if (body) {
       // Append after existing fold contents so multiple interim msgs stay in order.
       body.appendChild(assistantEl);
     }
   }

    /** Prefer the original protocol title over the rewritten .tc-title display. */
    function getToolCallOriginalTitle(tc) {
      if (!tc) return '';
      if (typeof tc._toolTitle === 'string' && tc._toolTitle) return tc._toolTitle;
      var titleEl = tc.querySelector('.tc-title');
      return titleEl ? (titleEl.textContent || '') : '';
    }

    /** Collect tool title/kind metadata from inline rows (for re-folding). */
    function collectToolMetaFromList(list) {
      var titles = [];
      var kinds = [];
      var rawInputs = [];
      var hasSubagent = false;
      if (!list) return { titles: titles, kinds: kinds, rawInputs: rawInputs, hasSubagent: hasSubagent, count: 0 };
      list.querySelectorAll('.tool-call-inline').forEach(function(tc) {
        // Nested subagent tools live under a parent card — exclude from summary.
        if (tc.getAttribute('data-parent-tool')) return;
        var tcTitle = getToolCallOriginalTitle(tc);
        var tcKind = tc.dataset.toolKind || null;
        titles.push(tcTitle);
        kinds.push(tcKind);
        rawInputs.push(tc._rawInput || null);
        if (isSubagentToolCall(tcTitle, tcKind, tc._rawInput || null)) hasSubagent = true;
      });
      return { titles: titles, kinds: kinds, rawInputs: rawInputs, hasSubagent: hasSubagent, count: titles.length };
    }

    /**
     * Restore the normal (non-compact) turn layout.
     * Lifts fold children in place — preserves turn order (do not move
     * thoughts to the front).
     */
    function unwrapTurnFold(turn) {
      if (!turn) return;
      var foldBody = getTurnFoldBody(turn);
      var list = turn.querySelector('.turn-tools-list');
      var toolsWrap = list ? list.closest('.turn-tools') : null;
      var summary = getTurnSummaryEl(turn);
      var meta = summary && summary._titles && summary._titles.length
        ? {
            titles: summary._titles || [],
            kinds: summary._kinds || [],
            rawInputs: summary._rawInputs || [],
            hasSubagent: !!summary._hasSubagent,
            count: parseInt(summary.dataset.count || '0', 10) || 0,
          }
        : collectToolMetaFromList(list);

      // Lift fold children onto the turn in the same relative order, then
      // drop the fold shell. insertBefore(foldBody) keeps turn chronology
      // (thought → tools → thought → …), including every thinking block.
      if (foldBody) {
        while (foldBody.firstChild) {
          turn.insertBefore(foldBody.firstChild, foldBody);
        }
        foldBody.remove();
      }

      // Remove every summary / expand control.
      Array.prototype.slice.call(turn.querySelectorAll('.turn-tools-summary')).forEach(function(el) {
        el.remove();
      });

      // Keep each tools group that still has rows; drop empty shells only.
      Array.prototype.slice.call(turn.querySelectorAll('.turn-tools')).forEach(function(wrap) {
        var wrapList = wrap.querySelector('.turn-tools-list');
        if (wrap.querySelector('.tool-call-inline')) {
          if (wrapList) wrapList.classList.remove('collapsed');
          if (!wrap._titles && meta.titles && meta.titles.length && wrap === toolsWrap) {
            wrap._titles = meta.titles;
            wrap._kinds = meta.kinds;
            wrap._rawInputs = meta.rawInputs;
            wrap._hasSubagent = meta.hasSubagent;
            wrap.dataset.count = String(meta.count || meta.titles.length);
          }
        } else if (!wrapList || !wrapList.children.length) {
          wrap.remove();
        }
      });

      // Clear interim/summary markers — everything is visible when unwrapped.
      Array.prototype.forEach.call(turn.querySelectorAll('.message.assistant'), function(a) {
        a.classList.remove('assistant-interim');
        a.classList.remove('assistant-summary');
      });
      var foldBody = getTurnFoldBody(turn);
      if (foldBody) {
        foldBody.classList.remove('collapsed');
        foldBody.classList.remove('expanded');
        foldBody._userExpanded = false;
      }
    }

   function applyCompactModeToAllTurns(collapsed) {
     if (messagesEl) messagesEl.classList.toggle('compact-mode', !!collapsed);
     messagesEl.querySelectorAll('.turn').forEach(function(turn) {
       if (collapsed) {
         // Capture per-turn expand state BEFORE rebuilding the fold.
         // ensureTurnFoldStructure creates a fresh body, so _userExpanded
         // on the old body is lost. We read it here and re-apply after.
         var prevBody = getTurnFoldBody(turn);
         var wasExpanded = !!(prevBody && (prevBody._userExpanded ||
                       prevBody.classList.contains('expanded')));
         var body = getTurnFoldBody(turn);
         ensureTurnFoldStructure(turn, true);
         body = getTurnFoldBody(turn);
         if (body) {
           // Preserve user-expanded state: turns the user manually opened
           // stay open when re-enabling compact mode (OFF → ON toggle).
           if (wasExpanded) {
             body._userExpanded = true;
             setFoldExpanded(body, true);
           } else {
             body._userExpanded = false;
             setFoldExpanded(body, false);
           }
         }
       } else {
         unwrapTurnFold(turn);
       }
     });
   }

    /** Compact-mode fold for the live turn; returns .turn-fold-body. */
    function ensureCurrentTurnFold() {
      if (!currentTurnEl) {
        currentTurnEl = document.createElement('div');
        currentTurnEl.className = 'turn';
        messagesEl.appendChild(currentTurnEl);
        hideEmpty();
      }
      // Fold (thought/tools/interim) stays collapsed when Collapse is on.
      // The final assistant summary sits outside and streams in the panel.
      return ensureTurnFoldStructure(currentTurnEl, !!compactMode, true);
    }

    function refreshCurrentTurnSummary() {
      if (!currentTurnEl) return;
      if (!currentToolsCountEl || !currentToolsCountEl.classList.contains('turn-tools-summary')) {
        currentToolsCountEl = getTurnSummaryEl(currentTurnEl);
      }
      if (!currentToolsCountEl || !currentToolsCountEl.classList.contains('turn-tools-summary')) return;
      updateToolGroupSummary(
        currentToolsCountEl,
        parseInt(currentToolsCountEl.dataset.count || '0', 10),
        currentToolsCountEl._titles || [],
        currentToolsCountEl._kinds || [],
        currentToolsCountEl._rawInputs || []
      );
    }

    /**
     * Stamp a tool row (and its .turn-tools wrapper) with the chatHistory index
     * it was rendered from. orderCompactFoldContents() sorts fold children by
     * this attribute; without it a tool group scores MAX_SAFE_INTEGER and sinks
     * below every thought / interim assistant, which destroyed the interleaved
     * order as soon as the user expanded a fold mid-turn.
     * The wrapper keeps the MIN index of its rows so the whole group sorts to
     * the position of its first tool.
     */
    function stampToolHistoryIndex(toolCallId, historyIndex) {
      if (!Number.isFinite(historyIndex) || historyIndex < 0) return;
      var el = lookupToolCallEl(toolCallId);
      if (!el || !el.setAttribute) return;
      el.setAttribute('data-history-index', String(historyIndex));
      var wrap = el.closest ? el.closest('.turn-tools') : null;
      if (!wrap || !wrap.setAttribute) return;
      var wrapIdx = wrap.getAttribute('data-history-index');
      if (wrapIdx === null || wrapIdx === undefined || String(wrapIdx).trim() === '' ||
          Number(wrapIdx) > historyIndex) {
        wrap.setAttribute('data-history-index', String(historyIndex));
      }
    }

    function placeThoughtInTurn(thoughtEl) {
      // Close the open tools group so later tools start a new group after this
      // thought. Compact mode used to reuse one list, which shoved every later
      // thought to the end of the fold after all tool rows.
      if (currentToolsListEl) {
        currentToolsListEl = null;
        if (!compactMode) {
          currentToolsCountEl = null;
          currentToolCount = 0;
        }
      }
      if (compactMode) {
        var body = ensureCurrentTurnFold();
        if (!body) {
          currentTurnEl.appendChild(thoughtEl);
          return;
        }
        // Append in turn order (after prior thoughts/tools/interim already in the fold).
        body.appendChild(thoughtEl);
        refreshCurrentTurnSummary();
      } else {
        // Non-compact: keep chronological append order within the turn.
        currentTurnEl.appendChild(thoughtEl);
      }
    }

    function placeAssistantInTurn(assistantEl) {
      // Compact: keep the live bubble inside the fold while streaming.
      // promptEnd / manual collapse during end-turn summary lift it outside.
      if (compactMode) {
        moveAssistantIntoFold(assistantEl);
        refreshCurrentTurnSummary();
        return;
      }
      if (currentTurnEl) currentTurnEl.appendChild(assistantEl);
    }

    // Ensure the current turn has a tools container.
    // Non-compact: creates a new tools group after text was emitted,
    // preserving interleaved text/tool ordering.
    // Compact: reuses the turn's single fold so thoughts, tools, and replies
    // collapse into one summary instead of splitting around mid-turn content.
    function ensureTurnTools() {
     cancelProvisionalSummaryPromote();
     if (!currentTurnEl) {
       currentTurnEl = document.createElement('div');
       currentTurnEl.className = 'turn';
       messagesEl.appendChild(currentTurnEl);
     }
     // Finalize any in-progress thought before tools render. Use DOM+buffers so
     // a whitespace-only latest chunk cannot delete an earlier real thought.
     if (currentThoughtEl) {
       commitOrDiscardCurrentThought();
     }
     // Mid-turn assistant text (before more tools) goes into the fold.
     if (currentAssistantEl && currentAssistantText) {
       commitCurrentTextSegment({ interim: true });
       // Start a NEW tools group after the assistant text. Without this the
       // next tool reuses the OLD wrapper, which sits BEFORE the text we just
       // committed — collapsing every tool of the turn into one group and
       // breaking the interleaved order (thought → tools → assistant → tools).
       // The replay path in renderChatHistory already does this; the live
       // streaming path did not.
       currentToolsListEl = null;
     }
     // Cap the size of a single tools group. A run of tool calls with no
     // assistant text between them would otherwise grow one unbounded
     // .turn-tools-list — an agent that replays (or streams) hundreds of
     // consecutive tool calls produced a single enormous group that is
     // unreadable and slow to lay out. Splitting keeps each group navigable
     // and bounds the DOM work per group; in compact mode the per-turn
     // summary count is carried over below, so the visible total is unchanged.
     if (currentToolsListEl &&
         currentToolsListEl.children.length >= TOOL_GROUP_MAX_ROWS) {
       currentToolsListEl = null;
     }
     if (!currentToolsListEl) {
       // Always start a fresh tools group. Compact still uses one fold/summary
       // per turn, but multiple .turn-tools sections preserve chronology:
       // thought → tools → thought → tools (instead of all tools then thoughts).
       var preservedCount = 0;
       if (compactMode) {
         var existingSummary = getTurnSummaryEl(currentTurnEl);
         if (existingSummary) {
           preservedCount = parseInt(existingSummary.dataset.count || '0', 10) || 0;
         } else {
           preservedCount = currentToolCount || 0;
         }
       }

       currentToolCount = compactMode ? preservedCount : 0;
       const list = document.createElement('div');
       list.className = 'turn-tools-list';
       currentToolsListEl = list;

       if (compactMode) {
         var body = ensureTurnFoldStructure(currentTurnEl, true, true);
         var toolsWrap = document.createElement('div');
         toolsWrap.className = 'turn-tools';
         toolsWrap.appendChild(list);
         // Append to the END of the fold body so the tool group sorts after
         // the last committed assistant (data-history-index ordering). When
         // ensureTurnFoldStructure just moved the summary assistant outside
         // the body (appendChild to turn), the body's last child is the prior
         // interim content — appending to the body end keeps the tool group
         // chronologically after the assistant text.
         if (body) body.appendChild(toolsWrap);
         currentToolsCountEl = getTurnSummaryEl(currentTurnEl);
       } else {
         // Non-compact: no summary/expand chrome — just the tool rows.
         const toolsWrap = document.createElement('div');
         toolsWrap.className = 'turn-tools';
         toolsWrap.appendChild(list);
         currentTurnEl.appendChild(toolsWrap);
         currentToolsCountEl = toolsWrap; // meta host only (not a visible summary)
       }
     }
   }
 
   /**
    * Generate a descriptive summary of a group of tool calls based on
    * their titles (e.g., "3 reads, 2 edits, 1 command").
    * Inspired by happy's generateGroupSummary.
    */
  function generateToolGroupSummary(titles, kinds, rawInputs) {
    var counts = {};
    var total = 0;
    var spawnCount = 0;
    var agentOpCount = 0;
    // Track unique skill names loaded during this turn — file reads of
    // SKILL.md, references/*.md, and manage_skills(read) all fold into
    // a single "loaded N skill(s)" summary.
    var loadedSkills = {};
    for (var i = 0; i < titles.length; i++) {
      var cat;
      var kind = kinds && kinds[i];
      var ri = rawInputs && rawInputs[i];
      // Skill loading detection — checked BEFORE kind/title heuristics so
      // that file reads of SKILL.md / references within skill directories
      // are counted as skill loads, not generic reads or commands.
      var _skillName = detectSkillLoad(titles[i], kind, ri);
      if (_skillName) {
        loadedSkills[_skillName] = true;
        total++;
        continue;
      }
      // Prefer concrete ACP kinds (read/edit/…) over title heuristics. A read of
      // a file named close_agent must not become "1 subagent op".
      // kind=think is excluded: Claude Agent spawns misuse think + description
      // titles on resume — detect those via rawInput/toolName first.
      if (isSubagentToolCall(titles[i], kind, ri)) {
        cat = 'agent';
        // Distinguish spawn (creates agents) from other agent ops (wait/close/etc)
        if (isSubagentSpawnTitle(titles[i], ri)) {
          // For Kiro's "Spawning agent crew", count stages array
          spawnCount += getSubagentSpawnCount(titles[i], ri);
        } else {
          agentOpCount++;
        }
      } else if (isWebSearchToolCall(titles[i], ri)) {
        cat = 'web_search';
      } else {
        var tn = ri && (ri._toolName || ri.toolName);
        var inferred = cursorEnrichKind(tn, titles[i], kind);
        if (inferred === 'write') cat = 'write';
        else if (inferred === 'delete') cat = 'delete';
        else if (inferred === 'edit') cat = 'edit';
        else if (inferred === 'read') cat = 'read';
        else if (kind && kind !== 'other' && kind !== 'think') cat = acpKindToCategory(kind);
        else if (kind) cat = acpKindToCategory(kind);
        else cat = categorizeToolCall((titles[i] || '').toLowerCase());
      }
      counts[cat] = (counts[cat] || 0) + 1;
      total++;
    }
    var parts = [];
    // Show spawn as "spawned N subagent(s)" and other agent ops as "N subagent op(s)"
    if (spawnCount > 0) parts.push('spawned ' + spawnCount + ' subagent' + (spawnCount > 1 ? 's' : ''));
    if (agentOpCount > 0) parts.push(agentOpCount + ' subagent op' + (agentOpCount > 1 ? 's' : ''));
    if (counts.read) parts.push(counts.read + ' read' + (counts.read > 1 ? 's' : ''));
    if (counts.write) parts.push(counts.write + ' write' + (counts.write > 1 ? 's' : ''));
    if (counts.edit) parts.push(counts.edit + ' edit' + (counts.edit > 1 ? 's' : ''));
    if (counts.delete) parts.push(counts.delete + ' delete' + (counts.delete > 1 ? 's' : ''));
    if (counts.web_search) parts.push(counts.web_search + ' web search' + (counts.web_search > 1 ? 'es' : ''));
    if (counts.search) parts.push(counts.search + ' search' + (counts.search > 1 ? 'es' : ''));
    if (counts.command) parts.push(counts.command + ' command' + (counts.command > 1 ? 's' : ''));
    if (counts.plan) parts.push(counts.plan + ' plan update' + (counts.plan > 1 ? 's' : ''));
    if (counts.todo) parts.push(counts.todo + ' todo' + (counts.todo > 1 ? 's' : ''));
    // Skill loading — unified count of unique skills loaded (manage_skills read +
    // file reads of SKILL.md / references within skill directories).
    var _skillCount = Object.keys(loadedSkills).length;
    if (_skillCount > 0) parts.push('loaded ' + _skillCount + ' skill' + (_skillCount > 1 ? 's' : ''));
    // Non-loading skill operations (search, create, update, delete) — still
    // shown separately since they are distinct actions, not file reads.
    if (counts.skill_search) parts.push('search ' + counts.skill_search + ' skill' + (counts.skill_search > 1 ? 's' : ''));
    if (counts.skill_create) parts.push('create ' + counts.skill_create + ' skill' + (counts.skill_create > 1 ? 's' : ''));
    if (counts.skill_update) parts.push('update ' + counts.skill_update + ' skill' + (counts.skill_update > 1 ? 's' : ''));
    if (counts.skill_delete) parts.push('delete ' + counts.skill_delete + ' skill' + (counts.skill_delete > 1 ? 's' : ''));
    if (counts.skill_other) parts.push(counts.skill_other + ' skill op' + (counts.skill_other > 1 ? 's' : ''));
    if (counts.other) parts.push(counts.other + ' other');
    if (parts.length === 0) return total + ' tool call' + (total !== 1 ? 's' : '');
    return parts.join(', ');
  }
 
  // Web-search tool names across agents (codex, Codex, Claude, Kiro, MCP).
  // These are detected before the generic kind/title heuristics so that
  // collapsed summaries show "N web search(es)" instead of "N other".
  var webSearchToolNames = new Set([
    'web_search',
    'brave_web_search',
    'brave_local_search',
    'tavily_search',
    'exa_search',
    'google_search',
    'serper_search',
    'serpapi_search',
    'perplexity_search',
    'duckduckgo_search',
    'bing_search',
  ]);

  // Detect web-search tool calls by title or rawInput.toolName.
  // codex sends 'web_search' as the tool title (mapToolKind returns undefined,
  // so no ACP kind is set). Other agents / MCP servers use variants like
  // 'brave_web_search', 'tavily_search', etc. Matching the raw tool name is
  // more reliable than title heuristics because titles can be human-readable.
  function isWebSearchToolCall(title, rawInput) {
    var t = String(title || '').trim().toLowerCase();
    if (webSearchToolNames.has(t)) return true;
    if (rawInput && typeof rawInput === 'object') {
      var tn = String(rawInput._toolName || rawInput.toolName || '').trim().toLowerCase();
      if (webSearchToolNames.has(tn)) return true;
    }
    // Human-readable title fallback for agents that send descriptive titles.
    if (t.indexOf('web search') >= 0 || t.indexOf('web_search') >= 0) return true;
    return false;
  }

  // Skill-loading detection for collapsed-mode summary.
  // Detects tool calls that load skill content (read SKILL.md, read references
  // within skill directories, codex manage_skills read action) and returns the
  // skill name so the summary can show "loaded N skill(s)" instead of counting
  // each file read separately.
  //
  // Supports all three agents:
  //  - Codex: manage_skills tool with action=read, name=<skill-name>
  //    + read_file of skill dirs under the agent's skills root (references/*.md)
  //  - Codex: read_file of ~/.codex/skills/<name>/SKILL.md and references/*.md
  //    (rawInput.locations[].path or rawInput.path)
  //  - Claude Code: Read tool with file_path=~/.claude/skills/<name>/SKILL.md
  //    (rawInput.file_path)
  //  - Kiro: read of ~/.kiro/skills/<name>/SKILL.md
  //    (rawInput.path or locations[].path)
  // Returns the skill name (e.g. "jira-skill") or '' if not a skill load.
  function detectSkillLoad(title, kind, rawInput) {
    var t = String(title || '').trim().toLowerCase();
    // Parse rawInput — may be a JSON string from persisted state.
    var ri = rawInput;
    if (typeof ri === 'string') {
      try { ri = JSON.parse(ri); } catch (e) { ri = null; }
    }
    if (!ri || typeof ri !== 'object') ri = {};

    // --- Codex: manage_skills tool ---
    // Title: "Read skill: jira-skill"  OR  rawInput: { action: "read", name: "jira-skill" }
    var _toolName = String(ri._toolName || ri.toolName || '').trim().toLowerCase();
    if (_toolName === 'manage_skills' || t === 'manage_skills' ||
        t.indexOf('read skill:') === 0 || t.indexOf('read skill ') === 0) {
      var _skillName = ri.name || ri.skill || ri.skill_name || '';
      if (typeof _skillName === 'string' && _skillName.trim()) {
        return _skillName.trim();
      }
      // Extract from title "Read skill: jira-skill"
      var _titleMatch = t.match(/read skill\\s*:?\\s*(.+)/);
      if (_titleMatch && _titleMatch[1].trim()) return _titleMatch[1].trim();
      return 'unknown-skill';
    }

    // --- File reads of skill content ---
    // Collect all possible path fields from rawInput.
    var paths = [];
    if (typeof ri.path === 'string') paths.push(ri.path);
    if (typeof ri.file_path === 'string') paths.push(ri.file_path);
    if (typeof ri.filePath === 'string') paths.push(ri.filePath);
    // Codex format: locations: [{ path: "..." }]
    if (Array.isArray(ri.locations)) {
      for (var li = 0; li < ri.locations.length; li++) {
        if (ri.locations[li] && typeof ri.locations[li].path === 'string') {
          paths.push(ri.locations[li].path);
        }
      }
    }
    // Claude Code: Read tool with file_path, also check rawInput directly
    if (typeof ri.file_path === 'string') paths.push(ri.file_path);

    // Check each path against skill directory patterns.
    // Skill dirs: ~/.codex/skills/, ~/.kiro/skills/, ~/.claude/skills/,
    // ~/.cursor/skills-cursor/, .agents/skills/
    for (var pi = 0; pi < paths.length; pi++) {
      var p = String(paths[pi] || '');
      // Match /skills/<skill-name>/SKILL.md or /skills/<skill-name>/references/...
      var m = p.match(/\\/skills\\/([^\\/]+)\\/(?:SKILL\\.md|references\\/|scripts\\/|assets\\/|.*)/i);
      if (!m) {
        // Also match .agents/skills/<name>/...
        m = p.match(/\\.agents\\/skills\\/([^\\/]+)\\//i);
      }
      if (!m) {
        // Direct SKILL.md match: .../<skill-name>/SKILL.md (without /skills/ prefix)
        m = p.match(/\\/([^\\/]+)\\/SKILL\\.md$/i);
      }
      if (m && m[1]) {
        // Don't match if the "skill name" is a common directory (src, lib, etc.)
        var candidate = m[1].toLowerCase();
        if (candidate !== 'src' && candidate !== 'lib' && candidate !== 'test' &&
            candidate !== 'tests' && candidate !== 'docs' && candidate !== 'config') {
          return m[1];
        }
      }
    }

    // --- Title-based fallback ---
    // "Reading SKILL.md:1" (Kiro) or "Read file '.../SKILL.md'" (Codex)
    if (t.indexOf('skill.md') >= 0 || t.indexOf('reading skill') >= 0) {
      // Try to extract skill name from title
      var _tm = t.match(/skills\\/([^\\/]+)/);
      if (_tm && _tm[1]) return _tm[1];
      // Check if rawInput has a path we can extract from
      if (paths.length > 0) {
        var _pm = paths[0].match(/\\/skills\\/([^\\/]+)/);
        if (_pm && _pm[1]) return _pm[1];
      }
      return 'skill';
    }

    return '';
  }

   function categorizeToolCall(title) {
     var t = (title || '').toLowerCase().trim();
     // Extract the first word (command name) for matching, since full titles
     // may contain file paths that accidentally match keywords (e.g. "thread_reader" matches "read").
    var firstWord = t.split(/\\s+/)[0];
     // Also check the full title for keywords like "read file" or "search for"
     // but only match word-boundary keywords, not substrings inside paths.
     var kw = ' ' + t + ' ';
    // Skill management — skill_load / skill_read are handled by detectSkillLoad
    // (which runs before categorizeToolCall), so only non-loading skill ops
    // (search, create, update, delete, validate, info) are categorized here.
    if (t.indexOf('search skills:') === 0 || t.indexOf('search skills ') === 0) return 'skill_search';
    if (t.indexOf('create skill:') === 0 || t.indexOf('create skill ') === 0) return 'skill_create';
    if (t.indexOf('update skill:') === 0 || t.indexOf('update skill ') === 0) return 'skill_update';
    if (t.indexOf('delete skill:') === 0 || t.indexOf('delete skill ') === 0) return 'skill_delete';
    if (firstWord === 'manage_skills' || kw.indexOf(' validate skill ') >= 0 ||
        kw.indexOf(' skill info:') >= 0 || kw.indexOf(' skill info ') >= 0) return 'skill_other';
     if (firstWord === 'read' || firstWord === 'read_file' || firstWord === 'fs_read' ||
         firstWord.indexOf('read_') === 0 || firstWord === 'cat' || firstWord === 'view' ||
         kw.indexOf(' read ') >= 0 || kw.indexOf(' view ') >= 0 || kw.indexOf(' read_file ') >= 0) {
       return 'read';
     }
     if (firstWord === 'write' || firstWord === 'write_file' ||
         kw.indexOf(' write ') >= 0) {
       return 'write';
     }
     if (firstWord === 'edit' ||
         firstWord === 'patch' || firstWord === 'apply' || firstWord.indexOf('edit_') === 0 ||
         kw.indexOf(' edit ') >= 0 || kw.indexOf(' patch ') >= 0) {
       return 'edit';
     }
     if (firstWord === 'delete' || firstWord === 'delete_file' || firstWord.indexOf('delete_') === 0 ||
         kw.indexOf(' delete ') >= 0 || kw.indexOf(' delete_file ') >= 0) {
       return 'delete';
     }
     if (firstWord === 'search' || firstWord === 'grep' || firstWord === 'find' || firstWord === 'glob' || firstWord === 'rg' || kw.indexOf(' search ') >= 0 || kw.indexOf(' grep ') >= 0 || kw.indexOf(' find ') >= 0) return 'search';
     if (firstWord === 'ls' || firstWord === 'command' || firstWord === 'exec' || firstWord === 'shell' || firstWord === 'run' || firstWord === 'cd' || kw.indexOf(' command ') >= 0 || kw.indexOf(' exec ') >= 0 || kw.indexOf(' run ') >= 0) return 'command';
     if (firstWord === 'plan' || firstWord === 'todo' || kw.indexOf(' plan ') >= 0 || kw.indexOf(' todo ') >= 0) return 'plan';
     // Task tracking tools (codex task_create/task_update/task_list)
     // Only task_create counts as a 'todo' in the collapsed summary —
     // task_update and task_list are operations on existing todos, not
     // new todos. Showing "8 todos" when 3 were created and 5 were updated
     // is misleading.
     if (firstWord === 'task_create' ||
         kw.indexOf(' task_create ') >= 0 || kw.indexOf(' create task ') >= 0) return 'todo';
     if (firstWord === 'task_update' || firstWord === 'task_list' ||
         firstWord === 'create:' || firstWord === 'update' && kw.indexOf(' → ') >= 0 ||
         kw.indexOf(' task_update ') >= 0 || kw.indexOf(' task_list ') >= 0 ||
         kw.indexOf(' update task ') >= 0 || kw.indexOf(' list tasks ') >= 0) return 'other';
     return 'other';
   }

  // Map ACP protocol ToolKind to our summary category
  function acpKindToCategory(kind) {
    switch (kind) {
      case 'read': return 'read';
      case 'edit':
      case 'move': return 'edit';
      case 'delete': return 'delete';
      case 'search':
      case 'fetch': return 'search';
      case 'execute': return 'command';
      case 'think': return 'plan';
      case 'switch_mode':
      case 'other': return 'other';
      default: return 'other';
    }
  }

  // Kiro "Summarizing" / toolName summary — redundant with agent_message summary.
  function isKiroSummaryToolTitle(title, toolName) {
    var t = String(title || '').trim().toLowerCase();
    var n = String(toolName || '').trim().toLowerCase();
    return n === 'summary' || t === 'summary' || t === 'summarizing';
  }

  // Check if a tool call title indicates a subagent/agent-control event.
  // Codex sends these as collabAgentToolCall with tool names:
  // spawnAgent, sendInput, resumeAgent, wait, closeAgent.
  // Kiro may send similar agent-spawning tool calls.
  var subagentToolNames = new Set([
    'spawnagent', 'spawn_agent', 'spawn_agents_on_csv',
    'sendinput', 'send_input',
    'resumeagent', 'resume_agent',
    'waitagent', 'wait_agent', 'wait',
    'closeagent', 'close_agent',
    'listagents', 'list_agents',
    'followuptask', 'followup_task',
    'interruptagent', 'interrupt_agent',
    'reportagentjobresult', 'report_agent_job_result',
  ]);
  /**
   * Claude Agent spawn shape. Live turns use title "Task"; session/load resume
   * often replaces the title with the task description and keeps
   * kind=think + rawInput.subagent_type / _meta.claudeCode.toolName=Agent.
   * Without this, resume summaries become "N plan updates" instead of
   * "spawned N subagents".
   */
  function looksLikeClaudeAgentSpawn(title, rawInput, toolName) {
    var tn = String(toolName || '').trim().toLowerCase();
    if (tn === 'agent') return true;
    if (rawInput && typeof rawInput === 'object') {
      if (typeof rawInput.subagent_type === 'string' && rawInput.subagent_type.trim()) {
        return true;
      }
      // Persist/restore may stash the protocol tool name on rawInput.
      if (String(rawInput._toolName || '').trim().toLowerCase() === 'agent') {
        return true;
      }
    }
    var lower = String(title || '').trim().toLowerCase();
    return lower === 'task' || lower === 'agent';
  }

  function isSubagentToolCall(title, toolKind, rawInput, toolName) {
    // Concrete ACP file/command kinds are never collab-agent controls — even
    // when the title/path is literally "close_agent" / "wait" / etc.
    // EXCEPTION: Claude Code's "Agent" tool sends kind=execute with
    // subagent_type in rawInput — check for that first before rejecting.
    if (looksLikeClaudeAgentSpawn(title, rawInput, toolName)) return true;
    if (toolKind === 'read' || toolKind === 'edit' || toolKind === 'delete' ||
        toolKind === 'move' || toolKind === 'search' || toolKind === 'fetch' ||
        toolKind === 'execute') {
      return false;
    }
    var t = (title || '').trim();
    if (!t) return false;
    // Paths / filenames (e.g. reading src/close_agent.rs) are not agent ops.
    if (/[\\/]/.test(t) || /\\.[a-zA-Z0-9]{1,8}$/.test(t)) return false;
    var lower = t.toLowerCase();
    if (subagentToolNames.has(lower)) return true;
    // Also check common patterns (human-readable titles, not bare filenames)
    if (lower.startsWith('spawn') && lower.includes('agent')) return true;
    if (lower.startsWith('subagent') || lower.startsWith('sub_agent')) return true;
    if (lower.startsWith('start subagent') || lower.startsWith('close subagent')) return true;
    // Kiro CLI sends subagent tool calls with human-readable titles:
    // "Spawning agent crew" (toolName: subagent), "Summarizing" (toolName: summary)
    // These have _meta.kiro.toolName on the wire, but by the time we get here
    // we only have the title. Match known Kiro patterns.
    if (lower === 'subagent') return true;
    if (lower === 'summary') return true;
    if (lower === 'summarizing') return true;
    if (lower.includes('spawning') && lower.includes('agent')) return true;
    if (lower.includes('agent crew')) return true;
    return false;
  }

  function isSubagentSpawnTitle(title, rawInput, toolName) {
    if (looksLikeClaudeAgentSpawn(title, rawInput, toolName)) return true;
    var tn = (title || '').trim();
    var tnLower = tn.toLowerCase();
    return tn === 'spawnAgent' || tn === 'spawn_agent' || tn === 'spawn_agents_on_csv' ||
      (tnLower.startsWith('spawn') && tnLower.includes('agent')) ||
      tnLower === 'subagent' ||
      (tnLower.includes('spawning') && tnLower.includes('agent')) ||
      tnLower.includes('agent crew');
  }

  // Count how many subagents a tool call spawns.
  // Codex: each spawnAgent call = 1 subagent.
  // Kiro: "Spawning agent crew" with rawInput.stages array = N subagents.
  function getSubagentSpawnCount(title, rawInput) {
    var input = rawInput;
    // Persisted state may store a JSON string (or truncated JSON) for large rawInput.
    if (typeof input === 'string') {
      try { input = JSON.parse(input); } catch (e) { input = null; }
    }
    // Kiro: count stages array
    if (input && typeof input === 'object' && Array.isArray(input.stages)) {
      return input.stages.length || 1;
    }
    // Codex: each spawnAgent call = 1
    return 1;
  }
 
   function updateToolGroupSummary(summaryEl, count, titles, kinds, rawInputs) {
     var turn = summaryEl.closest && summaryEl.closest('.turn');
     var toolCount = count || (titles && titles.length) || 0;
     if (!toolCount && turn) {
       toolCount = turn.querySelectorAll('.tool-call-inline:not([data-parent-tool])').length;
     }
     var isInterruptedFold = !!(turn && (
       turn.getAttribute('data-turn-interrupted') === '1' ||
       turn.querySelector('.message.assistant[data-interrupted="1"]')
     ));
     var hasInterim = !!(turn && turn.querySelector('.message.assistant.assistant-interim'));
     // Show the ▸ header for tools, thoughts, or interrupted interim-only folds.
     // Do NOT show a placeholder like "Details"/"Thought" while thinking —
     // that flashes mid-turn before the first tool arrives.
     var hasThoughts = !!(turn && turn.querySelector('.thought-block'));
     var hasInterimAsst = !!(turn && turn.querySelector('.message.assistant.assistant-interim'));
     if (toolCount === 0 && !hasThoughts && !hasInterimAsst && !(isInterruptedFold && hasInterim)) {
       summaryEl.style.display = 'none';
       summaryEl.innerHTML = '';
       return;
     }
   // Pi and some agents stream assistant text before tool_call. Hide the fold
   // header until tools/thoughts arrive — avoids flashing "Reply" then retitling
   // to "N reads, M commands" mid-turn (same rationale as the Thought guard above).
   // Also hide when only thoughts exist (no tools, no assistant text yet) —
   // avoids flashing "Thought" as the collapsed title before tools arrive.
   // Also hide when the only interim assistant message has no text content
   // (empty "Reply" placeholder) — this happens after end_turn with no
   // assistant text, or during replay of an empty assistant turn.
   var _interimHasText = false;
   if (hasInterimAsst && turn) {
     var _im = turn.querySelector('.message.assistant.assistant-interim');
     _interimHasText = _im && String(_im.textContent || '').replace(/\\s+/g, '').length > 0;
   }
   if (toolCount === 0 && (hasThoughts || hasInterimAsst) && isProcessing && !isLoadingSession) {
     summaryEl.style.display = 'none';
     summaryEl.innerHTML = '';
     return;
   }
   // After processing ends: hide header if the only content is an empty
   // interim assistant message (no text, no tools, no thoughts).
   if (toolCount === 0 && hasInterimAsst && !_interimHasText && !isProcessing && !isLoadingSession) {
     summaryEl.style.display = 'none';
     summaryEl.innerHTML = '';
     return;
   }
    summaryEl.style.display = '';
     var body = (turn && getTurnFoldBody(turn)) || summaryEl.nextElementSibling;
     var isOpen = !!(body && (
       body.classList.contains('expanded') ||
       (body.classList.contains('collapsed') === false && !(messagesEl && messagesEl.classList.contains('compact-mode')))
     ));
     // Prefer live DOM titles when the summary meta was never populated
     // (common after interrupted Claude restore with only a crew card).
     var useTitles = titles || [];
     var useKinds = kinds || [];
     var useRaw = rawInputs || [];
     if (toolCount > 0 && (!useTitles.length) && turn) {
       var collected = { titles: [], kinds: [], rawInputs: [] };
       Array.prototype.forEach.call(turn.querySelectorAll('.turn-tools-list'), function(list) {
         var meta = collectToolMetaFromList(list);
         collected.titles = collected.titles.concat(meta.titles);
         collected.kinds = collected.kinds.concat(meta.kinds);
         collected.rawInputs = collected.rawInputs.concat(meta.rawInputs);
       });
       if (collected.titles.length) {
         useTitles = collected.titles;
         useKinds = collected.kinds;
         useRaw = collected.rawInputs;
         summaryEl._titles = useTitles;
         summaryEl._kinds = useKinds;
         summaryEl._rawInputs = useRaw;
         summaryEl.dataset.count = String(useTitles.length);
         toolCount = useTitles.length;
       }
     }
     var detail = '';
     if (toolCount > 0) {
       if (useTitles.length) {
         detail = generateToolGroupSummary(useTitles, useKinds, useRaw);
       }
       if (!detail) {
         detail = toolCount + ' tool call' + (toolCount === 1 ? '' : 's');
       }
     } else if (hasThoughts) {
       detail = 'Thought';
     } else if (hasInterimAsst) {
       var interimMsg = turn.querySelector('.message.assistant.assistant-interim');
       var interimPreview = interimMsg ? String(interimMsg.textContent || '').replace(/\\s+/g, ' ').trim() : '';
       if (interimPreview) {
         detail = interimPreview.length > 72 ? interimPreview.substring(0, 69) + '...' : interimPreview;
       } else {
         detail = 'Reply';
       }
     } else {
       detail = 'Interrupted';
     }
     summaryEl.innerHTML = (isOpen ? '▾ ' : '▸ ') + '<span class="tc-summary-detail">' + escapeHtml(detail) + '</span>';
   }

    /**
     * Commit the current text segment to history and request its markdown render.
     * @param opts.interim  when true (mid-turn, before more tools), tuck the
     *   segment into the collapse fold so only the final summary stays visible.
     */
function hasOpenFence(text) {
  // True if text ends inside an unclosed triple-backtick fenced code block.
  // Used by commitCurrentTextSegment to DEFER an interim commit when the
  // model has opened a fence whose closing fence will arrive in a later
  // segment — committing now would trap trailing prose inside a pre/code
  // block (the dark "shadow" box, with in-fence content wrapping across
  // lines). Mirrors src/utils/markdownBalance.ts hasOpenFence, inlined here
  // because the webview script runs in its own JS context (no module import).
  // NOTE: the backtick char is built via String.fromCharCode(96) because a
  // literal backtick anywhere in this body would terminate the template
  // literal that wraps the entire webview script.
  var bt = String.fromCharCode(96);
  var fenceRe = new RegExp(bt + '{3,}', 'g');
  var m = text.match(fenceRe);
  if (!m) return false;
  var openLen = 0;
  for (var i = 0; i < m.length; i++) {
    var f = m[i];
    if (f.length >= 3) {
      if (openLen === f.length) { openLen = 0; }
      else if (openLen === 0) { openLen = f.length; }
    }
  }
  return openLen > 0;
}
function commitCurrentTextSegment(opts) {
   // Skip whitespace-only text — DeepSeek-V4-Flash emits whitespace
   // between tool calls (empty streams), which would create empty
   // bubbles in the chat. Treat whitespace-only like empty text.
   if (!currentAssistantText || !currentAssistantText.trim()) {
     // Empty assistant text: still clean up the interim element so it
     // doesn't linger as an empty "Reply" placeholder in collapsed mode.
     // Without this, the assistant-interim element stays in the DOM with
     // no text, and updateToolGroupSummary renders "Reply" as the fold title.
     if (currentAssistantEl) {
       currentAssistantEl.remove();
       currentAssistantEl = null;
     }
     currentMessageId = null;
     reactivatedHistoryIndex = -1;
     return;
   }
   cancelProvisionalSummaryPromote();
    var asInterim = !!(opts && opts.interim);
    var asInterrupted = !!(opts && opts.interrupted);
    // Interrupted-commit empty-fence strip: when a CANCELLED turn is cut off
    // right after the model opened a triple-backtick fence (nothing but
    // whitespace after the opener), drop the lone empty fence instead of
    // committing it.
    // Otherwise the balanced final render (balanceMarkdownForPartialRender
    // closes the open fence) produces a PERMANENT empty <pre><code> box — the
    // "empty code fence started block" artifact. The normal streaming path
    // self-heals because the next chunk triggers a fresh render; an
    // interrupted commit has no next chunk, so the empty fence must be
    // removed here. Fences that DO have real content after the opener
    // (unterminated but non-empty code) are left intact so the partial reply
    // is preserved as code.
    if (asInterrupted && hasOpenFence(currentAssistantText)) {
      var btStrip = String.fromCharCode(96);
      // Matches a trailing fence run followed only by whitespace to EOL
      // (note: backslash-s is double-escaped because this script lives inside
      // the webview template literal — a single backslash-s would be eaten by
      // the template literal and corrupt the regex).
      var loneFenceRe = new RegExp(btStrip + '{3,}[\\s]*$');
      if (loneFenceRe.test(currentAssistantText)) {
        var fencedStripped = currentAssistantText.replace(loneFenceRe, '').replace(/\\s+$/, '');
        if (!fencedStripped.trim()) {
          // The whole segment was just the empty fence — behave like the
          // whitespace-only early return above so no empty bubble lingers.
          if (currentAssistantEl) {
            currentAssistantEl.remove();
            currentAssistantEl = null;
          }
          currentMessageId = null;
          reactivatedHistoryIndex = -1;
          return;
        }
        currentAssistantText = fencedStripped;
        vscode.postMessage({ type: 'debugLog', message: '[WV-COMMIT] interrupted commit: stripped lone empty trailing fence (textLen=' + currentAssistantText.length + ')' });
      }
    }
    // Fence-swallow guard: if this is an INTERIM commit (a tool/message
    // boundary split the assistant message) and the text ends inside an
    // unclosed triple-backtick fence, DON'T commit yet. The model opened a
    // code block and the closing fence will arrive in a LATER segment —
    // committing now would trap trailing prose inside a pre/code block (the
    // dark "shadow" box, with in-fence content wrapping across lines). Keep
    // the text buffered: the streaming render still shows it (balanced), and
    // it commits at the next boundary — or at promptEnd, where the full text
    // is available and the fence is either genuinely closed or balanced.
    // Interrupted commits (cancelled turn) must still go through so the
    // partial reply is preserved.
    if (asInterim && !asInterrupted && hasOpenFence(currentAssistantText)) {
      vscode.postMessage({ type: 'debugLog', message: '[WV-COMMIT] deferring interim commit: text ends inside an open fence (textLen=' + currentAssistantText.length + ')' });
      return;
    }
    var _commitPreview = currentAssistantText.replace(/\\s+/g, ' ').slice(0, 80);
    vscode.postMessage({ type: 'debugLog', message: '[WV-COMMIT] commitCurrentTextSegment: textLen=' + currentAssistantText.length + ' hasEl=' + !!currentAssistantEl + ' interim=' + asInterim + ' chatHistoryLen BEFORE=' + chatHistory.length + ' preview="' + _commitPreview + '"' });
    streamingRenderGen++; // invalidate any in-flight streaming renders
    var committedText = currentAssistantText;
    var histEntry = { kind: 'message', role: 'assistant', text: committedText };
    if (asInterrupted) histEntry.interrupted = true;
    // The chatHistory index this commit writes to. For a reactivated bubble
    // (same-messageId chunk resumed after a tool-call split), update the
    // existing entry in place; otherwise push a new one.
    var committedIndex;
    if (reactivatedHistoryIndex >= 0 &&
        reactivatedHistoryIndex < chatHistory.length &&
        chatHistory[reactivatedHistoryIndex] &&
        chatHistory[reactivatedHistoryIndex].kind === 'message' &&
        chatHistory[reactivatedHistoryIndex].role === 'assistant') {
      chatHistory[reactivatedHistoryIndex].text = committedText;
      if (asInterrupted) chatHistory[reactivatedHistoryIndex].interrupted = true;
      else delete chatHistory[reactivatedHistoryIndex].interrupted;
      saveState();
      committedIndex = reactivatedHistoryIndex;
      vscode.postMessage({ type: 'debugLog', message: '[WV-COMMIT] updated reactivated entry in place: index=' + reactivatedHistoryIndex + ' textLen=' + committedText.length });
    } else {
      chatHistory.push(histEntry);
      saveState();
      committedIndex = chatHistory.length - 1;
      vscode.postMessage({ type: 'debugLog', message: '[WV-COMMIT] AFTER push chatHistoryLen=' + chatHistory.length + ' index=' + committedIndex });
    }
    reactivatedHistoryIndex = -1; // consumed
   if (currentAssistantEl) {
       // Keep the existing rendered HTML in place while we request a fresh
       // render. Previously this removed md-rendered and set textContent to
       // the raw markdown, which caused a flash of unrendered markdown at
       // promptEnd (the "intermediate raw markdown when finish" bug). The
       // markdownRendered handler will replace innerHTML when the new render
       // arrives; until then, the already-rendered HTML is the best display.
       // Don't remove md-rendered — the handler checks data-render-hash to
       // decide whether to update.
       //
       // Exception: the bubble was NEVER rendered (a tool_call landed inside
       // the pre-first-render window, so this commit's streamingRenderGen++
       // just invalidated the only in-flight streaming render). There is no
       // rendered HTML to preserve, so leaving it untouched means an EMPTY
       // bubble sits above the tool row until the index=committedIndex render
       // round-trips back — the user sees "empty bubble → tool title → text
       // pops in". Paint the raw committed text now; the CSS rule
       // ".message.assistant:not(.md-rendered)" already styles this
       // loading state (pre-wrap, dimmed). This cannot regress the
       // "flash of raw markdown at promptEnd" bug, which only affects bubbles
       // that DO have rendered HTML.
       if (!currentAssistantEl.classList.contains('md-rendered') && !currentAssistantEl.textContent) {
         currentAssistantEl.textContent = committedText;
       }
       var renderIndex = committedIndex;
       vscode.postMessage({ type: 'debugLog', message: 'commitCurrentTextSegment: sending renderMarkdown index=' + renderIndex + ' textLen=' + committedText.length });
      vscode.postMessage({
        type: 'renderMarkdown',
        items: [{ index: renderIndex, text: committedText, hgen: historyRenderGen }]
      });
    }
    if (!currentAssistantEl) {
       vscode.postMessage({ type: 'debugLog', message: 'commitCurrentTextSegment: WARNING currentAssistantEl is null, not sending renderMarkdown!' });
     }
    // Mark the element as committed so promptStart can distinguish it
    // from orphaned slash-command responses.
    if (currentAssistantEl) {
      currentAssistantEl.classList.add('md-committed');
      // Stable target for markdownRendered — index into querySelectorAll can
      // drift when a live (uncommitted) assistant bubble exists beside interim ones.
      currentAssistantEl.setAttribute('data-history-index', String(committedIndex));
      if (asInterim && compactMode) {
        moveAssistantIntoFold(currentAssistantEl);
        if (asInterrupted) {
          currentAssistantEl.setAttribute('data-interrupted', '1');
          if (currentTurnEl) currentTurnEl.setAttribute('data-turn-interrupted', '1');
        }
        // Next tools must open a new group after this interim segment.
        currentToolsListEl = null;
      } else {
        // Final segment: lift out of the fold (e.g. text-only turn that was
        // provisionally folded, or summary that already streams outside).
        placeSummaryAssistant(currentAssistantEl);
      }
    }
    // Record the committed segment so a later agent_message_chunk with the SAME
    // messageId can reattach to this bubble (text→tool→text = one message).
    // Only meaningful when the segment carried a messageId; null otherwise so
    // legacy agents (no messageId) never match → old split-on-tool behavior.
    lastCommittedAssistantEl = currentMessageId ? currentAssistantEl : null;
    lastCommittedMessageId = currentMessageId;
    lastCommittedText = currentMessageId ? committedText : '';
    currentAssistantEl = null;
    currentAssistantText = '';
    currentMessageId = null;
    if (streamingRenderTimer) { clearTimeout(streamingRenderTimer); streamingRenderTimer = null; }
   }

    function addToolCall(toolCallId, title, status, content, rawInput, toolKind, locations, parentToolUseId) {
      dismissPsPanel(false);
      // Cursor stub tool_call ({_toolName:"task"}) — rich UI comes from cursor/task.
      if (isCursorTaskPlaceholder(title, rawInput)) {
        return;
      }
      // Cursor Update TODOs stub — board comes from cursor/update_todos.
      if (isCursorUpdateTodosPlaceholder(title, rawInput)) {
        return;
      }
      // Kiro Summarizing/summary — never land in history/DOM.
      if (isKiroSummaryToolTitle(title)) {
        return;
      }
      // Claude nested child tools (parentToolUseId): Kiro never surfaces subagent
      // tool calls in the main turn — only stage rows. Drop them from history/DOM.
      if (parentToolUseId) {
        vscode.postMessage({
          type: 'debugLog',
          message: '[WV-ADDTC] suppress nested child id=' + (toolCallId || '').slice(0, 12) + ' parent=' + String(parentToolUseId).slice(0, 12),
        });
        return;
      }
      // Cursor never emits status:"completed"; prior tools would spin forever.
      // When the next tool starts, mark earlier plain tools done.
      if (isCursorAgentSession() && !isLoadingSession) {
        completeInFlightToolCalls(toolCallId);
      }
      vscode.postMessage({ type: 'debugLog', message: '[WV-ADDTC] title="' + String(title || '').replace(/\\s+/g, ' ').slice(0, 60) + '" id=' + (toolCallId || '').slice(0, 12) + ' chatHistoryLen BEFORE=' + chatHistory.length + ' currentAssistantTextLen=' + currentAssistantText.length + ' hasCurrentAssistantEl=' + !!currentAssistantEl });
      // Commit any in-progress thought BEFORE assistant text and tool call
      // so chatHistory order stays thought → text → tools. Without this,
      // commitOrDiscardCurrentThought runs later in ensureTurnTools (called
      // from addToolCallInline) — AFTER the tool call is already pushed to
      // chatHistory, giving the thought a higher index than the tools it
      // precedes. This was the root cause of thinking blocks appearing at
      // the bottom of collapsed turns in codex.
      if (currentThoughtEl || currentThoughtText || thoughtDomBase) {
        commitOrDiscardCurrentThought();
      }
      // Top-level tools must commit any in-flight assistant text so history
      // order stays text → tools.
      if (currentAssistantText) {
        commitCurrentTextSegment({ interim: true });
      }
      // A tool call splits the assistant message. Clear reattach state so
      // post-tool text starts a FRESH bubble instead of concatenating back
      // into the pre-tool bubble. Without this, agents that use a turn-scoped
      // messageId (e.g. Codex sends the same messageId for all chunks in a
      // turn) would reattach every post-tool segment to the first bubble,
      // grouping all assistant text at the top before all tool calls.
      lastCommittedAssistantEl = null;
      lastCommittedMessageId = null;
      lastCommittedText = '';
      reactivatedHistoryIndex = -1;
      // Next post-tool text (no real messageId) gets a new synthetic segment
      // so it cannot reattach to the pre-tool bubble.
      messageSegmentCounter++;
      chatHistory.push({
        kind: 'toolCall',
        toolCallId: toolCallId,
        title: title,
        status: status,
        rawInput: rawInput,
        toolKind: toolKind,
        locations: locations || null,
        parentToolUseId: null,
      });
      saveState();
    var _tcHistoryIndex = chatHistory.length - 1;
     storeDiffContent(toolCallId, content, title);
     // For edit tool calls with a generic title (e.g. "Editing files"),
     // extract the file path from diff content to show in the title.
     var _editPath = null;
     if (content && Array.isArray(content)) {
       for (var _ci = 0; _ci < content.length; _ci++) {
        var _c = content[_ci];
        if (_c && (_c.type === 'diff' || _c.type === 'text')) {
          _editPath = _c.path || extractPathFromTitle(title) || '';
          if (_editPath) break;
        }
      }
    }
     // If the title is a Cursor file stub and we found a path from diff content, enrich it.
     if (_editPath && isAmbiguousFileStubTitle(title)) {
       title = fileStubTitleWithPath(title, _editPath, (rawInput && (rawInput._toolName || rawInput.toolName)) || '', toolKind);
       rawInput = Object.assign({}, rawInput || {}, { path: _editPath });
     }
     addToolCallInline(toolCallId, title, status, rawInput, toolKind, locations, null);
     // Live path must stamp the same way renderChatHistory does — otherwise the
     // group has no sort key and expanding the fold regroups all tools below
     // the thoughts / assistant segments instead of interleaving them.
     stampToolHistoryIndex(toolCallId, _tcHistoryIndex);
      vscode.postMessage({ type: 'debugLog', message: '[WV-ADDTC] AFTER push chatHistoryLen=' + chatHistory.length });
    }

    function storeDiffContent(toolCallId, content, title) {
      if (!content || !Array.isArray(content)) return;
      // Codex apply_patch sends {"type":"diff","oldText":"...","newText":"..."}
      // without a "path" field. Extract the path from the tool call title
      // (e.g. "Edit 'ChatWebviewProvider.ts'" → "ChatWebviewProvider.ts")
      // so the tooltip and diff viewer still work.
      var tcEl = toolCalls[toolCallId];
      if (tcEl && tcEl._toolTitle) title = title || tcEl._toolTitle;
      var titlePath = extractPathFromTitle(title);
      const diffs = content
        .filter(c => c.type === 'diff')
        .map(c => c.path ? c : Object.assign({}, c, { path: titlePath || c.path || '' }))
        .filter(c => c.path);
      if (diffs.length > 0) {
        toolCallDiffs[toolCallId] = diffs;
        var paths = diffs.map(function(d) { return d.path; });
        // The tool-call element may not exist yet on the LIVE path:
        // storeDiffContent(...) is invoked from addToolCall() BEFORE
        // addToolCallInline() creates the element and assigns
        // toolCalls[toolCallId]. In that case just stash the paths here —
        // applyStoredDiffContent() runs at every element-creation site and
        // applies them as soon as the element exists. (This was the bug:
        // _diffPaths / markClickable were silently skipped on the live path,
        // so hovering "Edit 3 files" showed no file list in the tooltip.)
        if (tcEl) {
          tcEl._diffPaths = paths;
          markClickable(tcEl, toolCallId);
        }
        // Persist diffPaths on the chatHistory entry so it survives
        // saveState/restoreState (VS Code restart without session/load).
        for (var i = chatHistory.length - 1; i >= 0; i--) {
          if (chatHistory[i] && chatHistory[i].kind === 'toolCall' &&
              chatHistory[i].toolCallId === toolCallId) {
            chatHistory[i].diffPaths = paths;
            break;
          }
        }
      }
    }

    /**
     * Apply stashed diff paths to a tool-call element once it exists.
     * storeDiffContent() may stash toolCallDiffs[toolCallId] before the
     * element is created (live addToolCall() path); every site that creates
     * the element and assigns toolCalls[toolCallId] = el must call this so
     * _diffPaths + markClickable (diff icon + click-to-open) are attached.
     * Idempotent: markClickable early-returns when has-diff is already set.
     */
    function applyStoredDiffContent(el, toolCallId) {
      if (!el) return;
      var stored = toolCallDiffs[toolCallId];
      if (stored && stored.length > 0) {
        el._diffPaths = stored.map(function(d) { return d.path; });
        markClickable(el, toolCallId);
      }
    }

    function markClickable(el, toolCallId) {
      if (el.classList.contains('has-diff')) return;
      el.classList.add('has-diff');
      const icon = document.createElement('span');
      icon.className = 'tc-diff-icon';
      icon.textContent = '⇔';
      el.appendChild(icon);
      el.addEventListener('click', () => {
       vscode.postMessage({ type: 'openDiff', toolCallId });
     });
   }

   /**
   * Format a tool call's rawInput into a human-readable string for the
   * hover tooltip. Handles common shapes: command strings, command
   * arrays, parsed_cmd arrays, and generic JSON.
   */
  // Strip taskResult from rawInput to prevent raw markdown from being
  // persisted in saveState / chatHistory and potentially rendered on
  // restore. The main agent delivers its own summary via agent_message_chunk.
  function stripTaskResult(rawInput) {
    if (!rawInput || typeof rawInput !== 'object') return rawInput;
    var copy = Object.assign({}, rawInput);
    delete copy.taskResult;
    return copy;
  }

  /**
   * Persist enough of a Kiro subagent crew rawInput for restore: stage count
   * and short labels. Drop huge prompt_template bodies that blow past the
   * 10KB state cap and used to leave the summary as "1 other".
   */
  function slimSubagentRawInput(rawInput) {
    var slim = {};
    if (typeof rawInput.task === 'string') slim.task = rawInput.task.slice(0, 200);
    if (typeof rawInput.prompt === 'string') slim.prompt = rawInput.prompt.slice(0, 2000);
    if (typeof rawInput.description === 'string') slim.description = rawInput.description.slice(0, 200);
    if (typeof rawInput.subagent_type === 'string') slim.subagent_type = rawInput.subagent_type.slice(0, 80);
    if (typeof rawInput.name === 'string') slim.name = rawInput.name.slice(0, 80);
    if (typeof rawInput._toolName === 'string') slim._toolName = rawInput._toolName.slice(0, 40);
    if (Array.isArray(rawInput.stages)) {
      slim.stages = rawInput.stages.map(function(stage) {
        if (!stage || typeof stage !== 'object') return { name: 'stage' };
        var prompt = stage.prompt_template || stage.prompt || '';
        return {
          name: stage.name || '',
          role: stage.role || '',
          depends_on: Array.isArray(stage.depends_on) ? stage.depends_on : undefined,
          // Keep enough of the prompt for restore hover (Kiro-style detail).
          prompt_template: typeof prompt === 'string' ? prompt.slice(0, 2000) : '',
          status: stage.status || undefined,
        };
      });
    }
    return slim;
  }

 function isEmptyRawInput(rawInput) {
   if (rawInput == null) return true;
   if (typeof rawInput === 'string') return !rawInput.trim();
   if (typeof rawInput !== 'object' || Array.isArray(rawInput)) return false;
   try {
     if (pathFromToolRawInput(rawInput)) return false;
     var pattern = rawInput.pattern || rawInput.query || rawInput.regex;
     if (typeof pattern === 'string' && pattern.trim()) return false;
     if (rawInput.command) return false;
     var glob = rawInput.glob || rawInput.glob_pattern || rawInput.globPattern || rawInput.target_directory;
     if (typeof glob === 'string' && glob.trim()) return false;
     return true;
   } catch (e) { return true; }
 }

 /** Pull a file/directory path out of common ACP / Cursor tool arg shapes. */
 function pathFromToolRawInput(rawInput) {
   if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) return '';
   var keys = ['path', 'file_path', 'filePath', 'target_file', 'targetFile', 'file', 'relative_path', 'relativePath', 'directory', 'target_directory'];
   for (var ki = 0; ki < keys.length; ki++) {
     var v = rawInput[keys[ki]];
     if (typeof v === 'string' && v.trim()) return v.trim();
   }
   return '';
 }

 function searchScopeFromToolRawInput(rawInput) {
   var pathArg = pathFromToolRawInput(rawInput);
   if (pathArg) return pathArg;
   if (!rawInput || typeof rawInput !== 'object') return '';
   if (typeof rawInput.glob === 'string' && rawInput.glob.trim()) return rawInput.glob.trim();
   if (typeof rawInput.glob_pattern === 'string' && rawInput.glob_pattern.trim()) return rawInput.glob_pattern.trim();
   if (typeof rawInput.globPattern === 'string' && rawInput.globPattern.trim()) return rawInput.globPattern.trim();
   if (typeof rawInput.target_directory === 'string' && rawInput.target_directory.trim()) return rawInput.target_directory.trim();
   return '';
 }

 function isFindSearchKind(toolName, title) {
   var n = String(toolName || '').trim().toLowerCase();
   var t = String(title || '').trim().toLowerCase();
   if (n === 'glob' || n === 'find' || n === 'listdir' || n === 'list_dir') return true;
   if (t === 'find' || t === 'glob' || t.indexOf('find ') === 0) return true;
   return false;
 }

 function formatSearchStubTitle(toolName, title, rawInput, locations) {
   var path = pathFromToolRawInput(rawInput);
   if (!path && locations && locations.length && locations[0] && locations[0].path) {
     path = String(locations[0].path);
   }
   var pattern = (rawInput && rawInput.pattern) || (rawInput && rawInput.query) || (rawInput && rawInput.regex) || '';
   if (typeof pattern !== 'string') pattern = String(pattern || '');
   var globPat = pattern ||
     (rawInput && rawInput.glob_pattern) ||
     (rawInput && rawInput.globPattern) ||
     (rawInput && rawInput.glob) || '';
   if (typeof globPat !== 'string') globPat = String(globPat || '');
   if (isFindSearchKind(toolName, title)) {
     if (globPat && path) return 'Find ' + JSON.stringify(globPat) + ' in ' + path;
     if (globPat) return 'Find ' + JSON.stringify(globPat);
     if (path) return 'Find ' + path;
     return '';
   }
   var scope = searchScopeFromToolRawInput(rawInput);
   if (pattern && scope) return 'grep ' + JSON.stringify(pattern) + ' ' + scope;
   if (pattern) return 'grep ' + JSON.stringify(pattern);
   if (scope) return 'grep ' + scope;
   return '';
 }

 function isGenericEditTitle(title) {
   var s = String(title || '').trim().toLowerCase();
   return !s || s === 'edit' || s === 'edit file' || s === 'edit files' ||
     s === 'editing files' || s === 'editing file' || s === 'strreplace' ||
     s === 'apply patch' || s === 'applypatch';
 }

 function isAmbiguousFileStubTitle(title) {
   var s = String(title || '').trim().toLowerCase();
   return isGenericEditTitle(title) || s === 'write file' || s === 'write' ||
     s === 'delete file' || s === 'delete';
 }

 /** Interim label while store.db enrichment is pending — keep the verb, not bare "File". */
 function fileStubInterimTitle(title) {
   var s = String(title || '').trim().toLowerCase();
   if (s === 'write file' || s === 'write') return 'Write File';
   if (s === 'delete file' || s === 'delete') return 'Delete File';
   if (isGenericEditTitle(title)) return 'Edit File';
   return 'File';
 }

 /** Prefix a recovered path with Write/Edit/Delete when the stub title hints the verb. */
 function fileStubTitleWithPath(title, path, toolName, toolKind) {
   if (!path) return fileStubInterimTitle(title);
   var confirmed = fileMutationKindConfirmed(toolName, title, toolKind);
   if (confirmed === 'write') return 'Write ' + path;
   if (confirmed === 'delete') return 'Delete ' + path;
   if (confirmed === 'edit') return 'Edit ' + path;
   var s = String(title || '').trim().toLowerCase();
   if (s === 'write file' || s === 'write' || s.indexOf('write ') === 0) return 'Write ' + path;
   if (s === 'delete file' || s === 'delete' || s.indexOf('delete ') === 0) return 'Delete ' + path;
   if (isGenericEditTitle(title) || s.indexOf('edit ') === 0) return 'Edit ' + path;
   return path;
 }

 /** Cursor stubs share "Edit File" — only trust verb when toolName/title confirms it. */
 function fileMutationKindConfirmed(toolName, title, toolKind) {
   var n = String(toolName || '').trim().toLowerCase();
   if (n === 'write' || n === 'write_file' || n === 'writefile') return 'write';
   if (n === 'delete' || n === 'delete_file' || n === 'deletefile') return 'delete';
   if (n === 'streplace' || n === 'strreplace' || n === 'str_replace' || n === 'edit' || n === 'applypatch') return 'edit';
   var tl = String(title || '').trim().toLowerCase();
   if (tl.indexOf('write ') === 0 && tl !== 'write file' && tl !== 'write') return 'write';
   if (tl.indexOf('delete ') === 0 && tl !== 'delete file' && tl !== 'delete') return 'delete';
   if ((tl.indexOf('edit ') === 0 || tl.indexOf('strreplace ') === 0) &&
       tl !== 'edit file' && tl !== 'edit' && tl !== 'edit files') return 'edit';
   if (String(toolKind || '').trim().toLowerCase() === 'delete') return 'delete';
   return null;
 }

 function syncToolKindDataset(el, rawInput, title, toolKind) {
   if (!el) return;
   var toolName = (rawInput && (rawInput._toolName || rawInput.toolName)) || '';
   var confirmed = fileMutationKindConfirmed(toolName, title, toolKind);
   if (confirmed) {
     el.dataset.toolKind = confirmed;
   } else if (toolKind && !isAmbiguousFileStubTitle(title)) {
     el.dataset.toolKind = toolKind;
   }
 }

 /**
  * Row title for tool calls: prefer enriched/protocol title, but when Cursor
  * sends stub "Edit file" + path in rawInput, show "Edit /full/path.ts".
  * No manual char cap — CSS ellipsis clips only when the panel is narrow;
  * hover tooltip shows the full text when clipped or when rawInput has more.
  */
 function resolveToolCallDisplayTitle(title, rawInput, locations, toolKind) {
   var t = cleanMultiLineTitle(title || '');
   var tl = t.toLowerCase().trim();
   var path = pathFromToolRawInput(rawInput);
   var pattern = (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput))
     ? (rawInput.pattern || rawInput.query || rawInput.regex || '') : '';
   if (typeof pattern !== 'string') pattern = String(pattern || '');
   var toolName = (rawInput && rawInput._toolName) || (rawInput && rawInput.toolName) || '';
   var confirmed = fileMutationKindConfirmed(toolName, t, toolKind);
   var kind = confirmed || cursorEnrichKind(toolName, title, toolKind);

   if (!path && locations && locations.length && locations[0] && locations[0].path) {
     path = String(locations[0].path);
   }

   // Cursor "Edit File" stubs cover write/edit/delete — never guess "Edit" early.
   if (isAmbiguousFileStubTitle(t) && !confirmed) {
     if (path) return fileStubTitleWithPath(t, path, toolName, toolKind);
     if (isEmptyRawInput(rawInput)) return fileStubInterimTitle(t);
   }

   if (isCursorStubToolTitle(t) || isGenericEditTitle(t)) {
     if (kind === 'read' && path) return 'Read ' + path;
     if (kind === 'edit' && path) return 'Edit ' + path;
     if (kind === 'write' && path) return 'Write ' + path;
     if (kind === 'delete' && path) return 'Delete ' + path;
     if (kind === 'grep' || kind === 'glob') {
       var searchTitle = formatSearchStubTitle(toolName, title, rawInput, locations);
       if (searchTitle) return searchTitle;
     }
     if (kind === 'shell') {
       var cmd = commandFromToolRawInput(rawInput);
       if (cmd) return cmd.replace(/\\s+/g, ' ').trim();
     }
   }

   if (path && isGenericEditTitle(t)) {
     if (kind === 'write') return 'Write ' + path;
     if (kind === 'delete') return 'Delete ' + path;
     if (confirmed === 'edit' || kind === 'edit') return 'Edit ' + path;
     return path;
   }
   if (path && (tl === 'delete file' || tl.indexOf('delete ') === 0 || kind === 'delete') &&
       tl.indexOf(path.toLowerCase()) < 0) {
     return 'Delete ' + path;
   }
   if (path && (kind === 'read' || tl === 'read file' || tl.indexOf('read ') === 0) &&
       tl.indexOf(path.toLowerCase()) < 0) {
     var base = path.split('/').pop() || path;
     if (tl.indexOf(String(base).toLowerCase()) >= 0) return 'Read ' + path;
   }
   if (path && (kind === 'edit' || tl.indexOf('edit ') === 0) && tl.indexOf(path.toLowerCase()) < 0) {
     var baseEdit = path.split('/').pop() || path;
     if (tl.indexOf(String(baseEdit).toLowerCase()) >= 0) return 'Edit ' + path;
   }

   // Bare shell tool names (e.g. legacy Codex "shell_command") add no display
   // text on their own — substitute the command from rawInput so replayed /
   // resumed history from ANY adapter shows the real command instead of a stub.
   if (isBareShellToolTitle(t)) {
     var cmdBare = commandFromToolRawInput(rawInput);
     if (cmdBare) return cmdBare.replace(/\\s+/g, ' ').trim();
   }

   if (!isCursorStubToolTitle(t) && t) return t;

   if (isAmbiguousFileStubTitle(t) && !path && isEmptyRawInput(rawInput)) {
     return fileStubInterimTitle(t);
   }

   if (!isEmptyRawInput(rawInput)) {
     var hint = formatRawInput(rawInput);
     if (hint) {
       var firstLine = hint.split('\\n')[0].trim();
       if (firstLine && firstLine.charAt(0) !== '{' && firstLine.charAt(0) !== '[') return firstLine;
     }
   }
   return t || 'Tool Call';
 }

  /** Extract a shell command from tool rawInput, including the legacy
   *  { name, arguments: { cmd|command } } shape from raw-rollout fallback. */
  function commandFromToolRawInput(rawInput) {
    if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) return '';
    if (typeof rawInput.command === 'string' && rawInput.command.trim()) return rawInput.command.trim();
    if (Array.isArray(rawInput.command)) return rawInput.command.join(' ').trim();
    var args = rawInput.arguments;
    if (args && typeof args === 'object' && !Array.isArray(args)) {
      var cmd = (typeof args.cmd === 'string' && args.cmd.trim()) ? args.cmd.trim() : '';
      if (!cmd && typeof args.command === 'string' && args.command.trim()) cmd = args.command.trim();
      if (cmd) return cmd;
    }
    return '';
  }

  /** Bare shell tool names that have no display value on their own. */
  function isBareShellToolTitle(title) {
    var t = String(title || '').trim().toLowerCase();
    return t === 'shell_command' || t === 'exec_command';
  }

  /**
   * Extract a file path from a tool call title.
   * Handles patterns like:
   *   Edit 'ChatWebviewProvider.ts'  -> ChatWebviewProvider.ts
   *   Edit "main.rs"                 -> main.rs
   *   Editing src/foo.ts             -> src/foo.ts
   *   Write 'config.yaml'            -> config.yaml
   * Returns '' if no path can be extracted.
   */
  function extractPathFromTitle(title) {
    if (!title || typeof title !== 'string') return '';
    // Match quoted path: Edit 'file.ext' or Edit "file.ext"
    var quoted = title.match(/'([^']+)'|"([^"]+)"/);
    if (quoted) return quoted[1] || quoted[2] || '';
    // Match unquoted path after edit/write keywords: Editing src/foo.ts
    var unquoted = title.match(/(?:Edit|Write|Editing|Writing)\\s+(.+)/i);
    if (unquoted) {
      var p = unquoted[1].trim();
      // Only accept if it looks like a path (has a file extension)
      if (p && /\\.[a-z]{1,10}$/i.test(p)) return p;
    }
    return '';
  }

  /**
   * Cursor ACP emits a stub tool_call (title "Task: Subagent task",
   * rawInput {_toolName:"task"}) before the real cursor/task request.
   * Those stubs must not create UI rows — cursor/task owns the crew stage.
   */
  function isCursorTaskPlaceholder(title, rawInput) {
    if (rawInput && typeof rawInput === 'object' && rawInput._toolName === 'task') {
      var keys = Object.keys(rawInput);
      if (keys.length === 1) return true;
      // Only meta fields, no real prompt/description yet.
      if (!rawInput.prompt && !rawInput.description && !rawInput.task && !Array.isArray(rawInput.stages)) {
        return true;
      }
    }
    var t = (title || '').trim().toLowerCase();
    return t === 'task: subagent task';
  }

  /**
   * Cursor ACP emits tool_call "Update TODOs" (+ rawInput._toolName updateTodos)
   * and then the real board via cursor/update_todos. Suppress the inline row so
   * we only show one Todos UI (the plan bar).
   */
  function isCursorUpdateTodosPlaceholder(title, rawInput) {
    if (rawInput && typeof rawInput === 'object') {
      var tn = String(rawInput._toolName || rawInput.toolName || '').toLowerCase();
      if (tn === 'updatetodos' || tn === 'update_todos' || tn === 'todowrite') return true;
      if (Array.isArray(rawInput.todos) && /^update\\s+todos\\b/i.test(String(title || ''))) return true;
    }
    return /^update\\s+todos\\b/i.test(String(title || '').trim());
  }

  function formatLocations(locations) {
    if (!locations || !locations.length) return '';
    var lines = [];
    for (var i = 0; i < locations.length; i++) {
      var loc = locations[i];
      if (!loc || !loc.path) continue;
      lines.push(loc.line != null ? (loc.path + ':' + loc.line) : loc.path);
    }
    return lines.join('\\n');
  }

  function formatRawInput(rawInput) {
    // Cursor Agent often sends rawInput: {} on live tool_call; treat that as
    // empty so tooltips don't show a useless "{}".
    if (isEmptyRawInput(rawInput)) return '';
    var result = '';
    if (typeof rawInput === 'string') { result = rawInput; }
    // Kiro subagent result: rawInput contains taskResult with the subagent's
    // markdown output. Don't dump the full JSON (which can be thousands of chars
    // of raw markdown); show the task description instead. The main agent will
    // deliver its own rendered summary via agent_message_chunk.
   else if (rawInput.taskResult) {
     result = rawInput.taskDescription || rawInput.task || rawInput.__tool_use_purpose || 'Subagent result delivered';
   }
    // Kiro / unified crew: stages[] with prompt_template — show the same
    // Name/Role/Prompt detail as hovering a child stage (parent summary).
    else if (Array.isArray(rawInput.stages) && rawInput.stages.length > 0) {
      result = formatStagesTooltipText(rawInput.stages, rawInput.task || rawInput.description || '');
    }
    // Codex collab agent tool call (spawnAgent, sendInput, etc.):
   // rawInput = { prompt, senderThreadId, receiverThreadIds, agentsStates, status }
   // Show the prompt text (the task given to the subagent) instead of
   // raw JSON with thread IDs and status objects.
   else if (typeof rawInput.prompt === 'string' && rawInput.prompt.length > 0) {
     result = rawInput.prompt;
   }
   // Codex collab agent tool call without a prompt (wait, sendInput,
   // closeAgent): show a human-readable summary of the target threads
   // instead of raw JSON with thread IDs.
   else if (Array.isArray(rawInput.receiverThreadIds) && rawInput.receiverThreadIds.length > 0) {
     var _collabAction = rawInput.status || 'collaboration';
     var _targets = rawInput.receiverThreadIds.length + ' agent' +
       (rawInput.receiverThreadIds.length > 1 ? 's' : '');
     result = 'Action: ' + _collabAction + '\\nWaiting on: ' + _targets;
   }
   // Command as string
   else if (typeof rawInput.command === 'string') { result = rawInput.command; }
    // Command as array (Codex format: ["gh", "issue", "view", "3715"])
    else if (Array.isArray(rawInput.command)) { result = rawInput.command.join(' '); }
    // Parsed command fallback
    else if (Array.isArray(rawInput.parsed_cmd)) {
      var cmds = rawInput.parsed_cmd
        .map(function(p) { return typeof p === 'object' ? (p.cmd || p.command || '') : String(p); })
        .filter(function(s) { return s.length > 0; });
      if (cmds.length > 0) { result = cmds.join(' && '); }
    }
    // Common file/search tool fields (Cursor / Codex ACP)
    else if (typeof rawInput.path === 'string' && rawInput.path) {
      var pathLine = rawInput.path;
      if (rawInput.line != null) pathLine += ':' + rawInput.line;
      if (typeof rawInput.pattern === 'string' && rawInput.pattern) {
        result = pathLine + '\\npattern: ' + rawInput.pattern;
      } else if (typeof rawInput.query === 'string' && rawInput.query) {
        result = pathLine + '\\nquery: ' + rawInput.query;
      } else {
        result = pathLine;
      }
    }
    else if (typeof rawInput.directory === 'string' && rawInput.directory) {
      var dirLine = rawInput.directory;
      if (typeof rawInput.pattern === 'string' && rawInput.pattern) {
        result = dirLine + '\\npattern: ' + rawInput.pattern;
      } else if (typeof rawInput.query === 'string' && rawInput.query) {
        result = dirLine + '\\nquery: ' + rawInput.query;
      } else {
        result = dirLine;
      }
    }
    else if (typeof rawInput.pattern === 'string' && rawInput.pattern) {
      result = rawInput.pattern;
    }
    else if (typeof rawInput.query === 'string' && rawInput.query) {
      result = rawInput.query;
    }
    else if (typeof rawInput.target_directory === 'string' && rawInput.target_directory) {
      result = rawInput.target_directory;
    }
    else if (typeof rawInput.file_path === 'string' && rawInput.file_path) {
      result = rawInput.file_path;
    }
    // Kiro "operation" payloads — never dump the whole JSON into the title.
    else if (typeof rawInput.operation === 'string' && rawInput.operation) {
      result = rawInput.operation;
    }
    else if (rawInput.operation && typeof rawInput.operation === 'object') {
      result = rawInput.operation.type || rawInput.operation.name ||
        rawInput.operation.kind || 'operation';
    }
    // codex spawn_parallel: rawInput = { tasks: [{ type, task, skills }] }
    // Show each sub-agent's type and prompt (mirrors the stages format above).
    else if (Array.isArray(rawInput.tasks) && rawInput.tasks.length > 0) {
      var taskLines = [];
      for (var ti = 0; ti < rawInput.tasks.length; ti++) {
        var tk = rawInput.tasks[ti] || {};
        if (ti > 0) taskLines.push('');
        taskLines.push('Name: ' + (tk.type || ('Subagent ' + (ti + 1))) + '-' + (ti + 1));
        taskLines.push('Role: ' + (tk.type || 'agent'));
        if (tk.skills) taskLines.push('Skills: ' + (Array.isArray(tk.skills) ? tk.skills.join(', ') : tk.skills));
        if (tk.task) { taskLines.push(''); taskLines.push('Prompt:'); taskLines.push(tk.task); }
      }
      result = taskLines.join('\\n');
    }
    // Generic: pretty-print as JSON (skip empty-object case already handled)
    else {
      try { result = JSON.stringify(rawInput, null, 2); } catch { result = String(rawInput); }
      if (result === '{}' || result === '[]') result = '';
    }
    return result;
  }

  /** Kiro-style multi-stage tooltip body (parent crew + child stages). */
  function formatStagesTooltipText(stages, crewTask) {
    var lines = [];
    if (crewTask && String(crewTask).trim()) {
      lines.push('Task: ' + String(crewTask).trim());
      lines.push('');
    }
    for (var i = 0; i < stages.length; i++) {
      var stage = stages[i] || {};
      if (i > 0) lines.push('');
      lines.push('Name: ' + (stage.name || ('Subagent ' + (i + 1))));
      if (stage.role) lines.push('Role: ' + stage.role);
      if (stage.mode) lines.push('Mode: ' + stage.mode);
      if (stage.depends_on && stage.depends_on.length > 0) {
        lines.push('Depends on: ' + stage.depends_on.join(', '));
      }
      if (stage.loop_to) lines.push('Loops to: ' + stage.loop_to);
      if (stage.trigger) lines.push('Trigger: ' + stage.trigger);
      if (stage.max_iterations) lines.push('Max iterations: ' + stage.max_iterations);
      var prompt = stage.prompt_template || stage.prompt || '';
      if (prompt) {
        lines.push('');
        lines.push('Prompt:');
        lines.push(prompt);
      }
    }
    return lines.join('\\n');
  }

  /** Full task text for a spawn tool (prefer prompt over short description). */
  function crewStageFullPrompt(rawInput) {
    if (!rawInput || typeof rawInput !== 'object') return '';
    var full = rawInput.prompt_template || rawInput.prompt || rawInput.message || rawInput.task || '';
    return typeof full === 'string' ? full : '';
  }

  /** Best-effort tooltip text: rawInput, then locations, then title. */
  function formatToolCallTooltipText(title, rawInput, locations, diffPaths) {
    var parts = [];
    var formatted = formatRawInput(rawInput);
    if (formatted) parts.push(formatted);
    // For Codex file edits (apply_patch), rawInput is empty but diff content
    // carries the file paths. Show them so hovering "Edit 6 files" reveals
    // which files were touched (instead of showing nothing).
    if (!formatted && diffPaths && diffPaths.length > 0) {
      var fileList = diffPaths.map(function(p) {
        var base = p.split(/[\\/]/).pop() || p;
        return base;
      });
      parts.push(fileList.length === 1
        ? 'File: ' + fileList[0]
        : 'Files (' + fileList.length + '):\\n' + fileList.map(function(f) { return '  • ' + f; }).join('\\n'));
    }
    var locText = formatLocations(locations);
    if (locText && parts.indexOf(locText) < 0) parts.push(locText);
    if (parts.length === 0 && title) parts.push(title);
    return parts.join('\\n\\n');
  }

   /**
    * Attach a hover tooltip to a tool call element showing the full
    * command/input. Uses a shared popover element that follows the mouse.
    */
  var tcTooltipEl = null;
  var TC_TOOLTIP_MAX_CHARS = 2000;

  // Global fallback: hide tooltip on window blur or visibility change
  // (e.g. Alt-Tab, clicking outside the webview). The per-element
  // pointerleave handler covers normal mouse-out, but these events
  // catch focus-stealing scenarios where pointerleave never fires.
  window.addEventListener('blur', hideTcTooltip);
  document.addEventListener('visibilitychange', function() {
    if (document.hidden) hideTcTooltip();
  });

  function ensureTcTooltipEl() {
    if (!tcTooltipEl) {
      tcTooltipEl = document.createElement('div');
      tcTooltipEl.className = 'tc-tooltip';
      document.documentElement.appendChild(tcTooltipEl);
    }
    return tcTooltipEl;
  }

  function positionTcTooltip(e) {
    if (!tcTooltipEl) return;
    var x = e.clientX + 12;
    var y = e.clientY + 12;
    var rect = tcTooltipEl.getBoundingClientRect();
    if (x + rect.width > window.innerWidth) { x = window.innerWidth - rect.width - 8; }
    if (y + rect.height > window.innerHeight) { y = window.innerHeight - rect.height - 8; }
    if (x < 8) x = 8;
    if (y < 8) y = 8;
    tcTooltipEl.style.left = x + 'px';
    tcTooltipEl.style.top = y + 'px';
  }

  function hideTcTooltip() {
    if (!tcTooltipEl) return;
    tcTooltipEl.style.display = 'none';
    if (tcTooltipEl._keydownHandler) {
      document.removeEventListener('keydown', tcTooltipEl._keydownHandler, true);
      tcTooltipEl._keydownHandler = null;
    }
  }

  /**
   * Attach a hover tooltip to a subagent stage element showing the full
   * stage details (name, role, prompt, depends_on). Uses the same shared
   * popover as tool call tooltips.
   */
 function attachStageTooltip(stageEl, stage) {
   if (!stageEl) return;
   // Resolve at hover time from stageEl._stageData so tool_call_update can
   // fill in the full prompt after an empty initial tool_call.
   if (stage && typeof stage === 'object') {
     stageEl._stageData = Object.assign({}, stageEl._stageData || {}, stage);
   }
   if (stageEl.dataset.stageTooltip) return;
   stageEl.dataset.stageTooltip = '1';
   stageEl.addEventListener('pointerenter', function(e) {
    e.stopPropagation();
     ensureTcTooltipEl();
     var data = stageEl._stageData || {};
     // [STAGE-DBG] capture what _stageData holds at hover time — the smoking gun
     // for "role not shown on hover". If role is absent here but was present at
     // createStageElement, something between creation and hover wiped it.
     try {
       vscode.postMessage({ type: 'debugLog', message: '[STAGE-DBG] hover name="' + String(data.name || stageEl.getAttribute('data-stage-name') || '').slice(0, 60) + '" role="' + String(data.role) + '" hasRoleKey=' + ('role' in data) + ' dataKeys=[' + Object.keys(data).join(',') + ']' });
     } catch (e2) {}
     var formatted = formatStagesTooltipText([data], '');
     if (!formatted) {
       formatted = 'Name: ' + (data.name || stageEl.getAttribute('data-stage-name') || '(unnamed)');
     }
      var truncated = formatted.length > TC_TOOLTIP_MAX_CHARS;
      var displayText = truncated ? formatted.slice(0, TC_TOOLTIP_MAX_CHARS) : formatted;
      tcTooltipEl.innerHTML = '<pre>' + escapeHtml(displayText) + '</pre>';
      if (truncated) {
        tcTooltipEl.innerHTML += '<div class="tc-tooltip-trunc">… truncated (' + formatted.length + ' chars total, showing first ' + TC_TOOLTIP_MAX_CHARS + ')</div>';
      }
     tcTooltipEl.style.display = 'block';
     tcTooltipEl._isStageTooltip = true;
     positionTcTooltip(e);
   });
  stageEl.addEventListener('pointermove', function(e) {
    e.stopPropagation();
    if (tcTooltipEl && tcTooltipEl.style.display !== 'none') {
      positionTcTooltip(e);
    }
  });
 stageEl.addEventListener('pointerleave', function() {
   hideTcTooltip();
 });
}

 function attachToolCallTooltip(el) {
   // Resolve text at hover time from el._rawInput / el._locations / title —
   // Cursor Agent often sends rawInput:{} first and fills path/locations later.
  if (el.dataset.tcTooltip) return;
  el.dataset.tcTooltip = '1';
  el.style.cursor = 'pointer';

  // Attach hover to the truncated title text only — hovering over the icon
  // or other parts of the tool row should NOT show the tooltip.
  var hoverTarget = el.querySelector('.tc-title') || el;

  hoverTarget.addEventListener('pointerenter', function(e) {
   // Show tooltips on expanded tool rows AND on the fold summary bar.
   // The fold summary shows abbreviated titles — the tooltip reveals the
   // full command/input. Previously this was blocked when collapsed, which
   // meant long commands in the summary had no way to show their full text.
   var parentList = el.closest('.turn-tools-list');
   if (parentList && parentList.classList.contains('collapsed')) return;
   var foldBody = el.closest('.turn-fold-body');
   if (foldBody && foldBody.classList.contains('collapsed')) {
     // The tool row itself is hidden; the user is hovering the fold summary
     // bar. Find the matching summary element and show the tooltip there.
     return;
   }

  var title = (el._toolTitle || hoverTarget.textContent) || '';
  var formatted = formatToolCallTooltipText(title, el._rawInput, el._locations, el._diffPaths);
  if (!formatted) return;

   // Show the tooltip when the row text is CLIPPED, or when the tooltip
   // carries detail the row does not already show.
   //
   // The original rule was "only when clipped", on the assumption that a title
   // which fits reveals everything. That no longer holds: agents may send a
   // short summarising title with the full input in rawInput — claude-code-acp
   // puts a multi-line command's first line in the title and keeps the
   // remaining lines, the cwd and the description in rawInput. The row then
   // fits, yet there IS more to reveal. Comparing the tooltip text against the
   // displayed title keeps the original intent (no redundant tooltip when the
   // two say the same thing) while restoring the hint when they differ.
   // textContent preserves the original characters, so a plain trim is enough
   // to tell "the row already says exactly this" from "there is more".
   var _tcNorm = function(s) { return String(s || '').trim(); };
   var _titleNorm = _tcNorm(title);
   var _clipped = hoverTarget.scrollWidth > hoverTarget.clientWidth + 2;
   // Always show the tooltip when the title is visually truncated — the
   // user cannot see the full command. Skip only when the title fits AND
   // the tooltip adds no new detail beyond what's already displayed.
   if (!_clipped && _tcNorm(formatted) === _titleNorm) return;

     // If a stage tooltip is currently visible (from a child element), hide it
     // so the parent tooltip can take over.
     if (tcTooltipEl && tcTooltipEl.style.display !== 'none' && tcTooltipEl._isStageTooltip) {
       tcTooltipEl.style.display = 'none';
       tcTooltipEl._isStageTooltip = false;
     }
     ensureTcTooltipEl();
     tcTooltipEl._isStageTooltip = false;
     var truncated = formatted.length > TC_TOOLTIP_MAX_CHARS;
      var displayText = truncated ? formatted.slice(0, TC_TOOLTIP_MAX_CHARS) : formatted;
      var html = '<pre>' + escapeHtml(displayText) + '</pre>';
      if (truncated) {
      html += '<div class="tc-tooltip-trunc">… truncated (' + formatted.length + ' chars total, showing first ' + TC_TOOLTIP_MAX_CHARS + ')</div>';
    }
    tcTooltipEl.innerHTML = html;
     tcTooltipEl.style.display = 'block';
     // Ctrl+C / Cmd+C copies tooltip content when tooltip is visible
     tcTooltipEl._keydownHandler = function(e) {
       if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
         // Only intercept if the user hasn't selected text manually
         var sel = window.getSelection();
         if (!sel || sel.toString().length === 0) {
           e.preventDefault();
           e.stopPropagation();
           copyTooltipToClipboard();
         }
       }
     };
     document.addEventListener('keydown', tcTooltipEl._keydownHandler, true);

     function copyTooltipToClipboard() {
     var pre = tcTooltipEl.querySelector('pre');
     var text = pre ? pre.textContent : '';
     // Synchronous copy via hidden textarea + execCommand('copy').
     // This writes to the system clipboard immediately, so pasting
     // in the terminal works even right after pressing Ctrl+C.
     var ta = document.createElement('textarea');
     ta.value = text;
     ta.style.position = 'fixed';
     ta.style.left = '-9999px';
     ta.style.top = '0';
     document.body.appendChild(ta);
     ta.focus();
     ta.select();
     try { document.execCommand('copy'); } catch(e) {}
     document.body.removeChild(ta);
     // Also send to extension host as a fallback for environments
     // where execCommand is not available.
     vscode.postMessage({ type: 'copyToClipboard', text: text });
    }

      positionTcTooltip(e);
      // If the tooltip content overflows, add a scroll hint.
      if (tcTooltipEl.scrollHeight > tcTooltipEl.clientHeight) {
        var hint = document.createElement('div');
        hint.className = 'tc-tooltip-scroll-hint';
        hint.textContent = '↓ scroll for more';
        tcTooltipEl.appendChild(hint);
      }
    });

    hoverTarget.addEventListener('pointermove', function(e) {
      if (tcTooltipEl && tcTooltipEl.style.display !== 'none') {
        positionTcTooltip(e);
      }
    });

    hoverTarget.addEventListener('pointerleave', function() {
      hideTcTooltip();
    });

    // Tooltip has pointer-events:none (so it can't steal hover). Forward
    // wheel events from the tool row so long tooltips remain scrollable.
    el.addEventListener('wheel', function(e) {
      if (!tcTooltipEl || tcTooltipEl.style.display === 'none') return;
      if (tcTooltipEl.scrollHeight <= tcTooltipEl.clientHeight) return;
      tcTooltipEl.scrollTop += e.deltaY;
      e.preventDefault();
      var hint = tcTooltipEl.querySelector('.tc-tooltip-scroll-hint');
      if (hint) {
        var atBottom = tcTooltipEl.scrollHeight - tcTooltipEl.scrollTop - tcTooltipEl.clientHeight < 20;
        if (atBottom) hint.remove();
      }
    }, { passive: false });
   }

   // Nested child tools buffered before parent mount (legacy Claude parentToolUseId).
   var pendingNestedByParent = {};
   // Spawn tools (Claude Task, Codex spawnAgent, Cursor task, …) in the current
   // turn aggregate into one Kiro-style crew card with .tc-stages rows.
   var subagentCrewPrimaryId = null;

   function resetSubagentCrewState() {
     subagentCrewPrimaryId = null;
     pendingNestedByParent = {};
   }
   function resetClaudeCrewState() { resetSubagentCrewState(); }

   function isClaudeAgentTaskTitle(title) {
     // Kept for older call sites; prefer isSubagentSpawnTitle for new code.
     var t = (title || '').trim().toLowerCase();
     return t === 'task' || t === 'agent';
   }

   function crewStageLabel(rawInput, title, index) {
     // Prefer the subagent's identity fields over the spawn task text. For Codex
     // spawnAgent / Claude Agent Task, rawInput.prompt holds the PARENT's task
     // sent to the subagent, NOT the subagent's own name — using it made the
     // first stage show the parent's prompt and then flip to "parent" once the
     // spawnAgent completion update landed. Only fall back to task/description
     // text for NON-spawn tools (where the label is genuinely descriptive).
     var desc = rawInput && (
       rawInput.agentPath || rawInput.agent_path || rawInput.subagent_type ||
       rawInput.name || rawInput.agent_name || rawInput.role
     );
    if (typeof desc === 'string' && desc.trim()) {
      var sd = desc.trim();
      // agentPath/agent_path carry a full filesystem path; basename it so the
      // stage shows the subagent's directory name instead of the whole path
      // (mirrors codex-acp's agentPath.split('/').filter(Boolean).at(-1)).
      if (rawInput.agentPath === sd || rawInput.agent_path === sd) {
        var base = sd.split('\\\\').join('/').split('/').filter(Boolean).pop();
        if (base) sd = String(base);
      }
      return sd.length > 60 ? sd.substring(0, 57) + '...' : sd;
    }
     if (!isSubagentSpawnTitle(title, rawInput)) {
       var taskDesc = rawInput && (
         rawInput.description || rawInput.task || rawInput.prompt
       );
       if (typeof taskDesc === 'string' && taskDesc.trim()) {
         var ts = taskDesc.trim();
         return ts.length > 60 ? ts.substring(0, 57) + '...' : ts;
       }
     }
     var t = (title || '').trim();
     if (t && !isSubagentSpawnTitle(t)) {
       return t.length > 60 ? t.substring(0, 57) + '...' : t;
     }
     return 'Subagent ' + (index || 1);
   }
   function claudeStageLabel(rawInput, index) {
     return crewStageLabel(rawInput, null, index);
   }

   function findCurrentTurnSubagentCrew() {
     if (subagentCrewPrimaryId && toolCalls[subagentCrewPrimaryId] &&
         (!currentTurnEl || currentTurnEl.contains(toolCalls[subagentCrewPrimaryId]))) {
       return toolCalls[subagentCrewPrimaryId];
     }
     if (!currentTurnEl) return null;
     var crews = currentTurnEl.querySelectorAll(
       '.tool-call-inline.tc-subagent[data-subagent-crew], .tool-call-inline.tc-subagent[data-claude-crew]'
     );
     if (crews.length) return crews[crews.length - 1];
     var all = currentTurnEl.querySelectorAll('.tool-call-inline.tc-subagent');
     for (var i = all.length - 1; i >= 0; i--) {
       if (all[i].querySelector(':scope > .tc-stages')) return all[i];
     }
     return null;
   }
   function findCurrentTurnClaudeCrew() { return findCurrentTurnSubagentCrew(); }

   function ensureNestedContainer(parentEl) {
     if (!parentEl) return null;
     var nest = parentEl.querySelector(':scope > .tc-nested');
     if (!nest) {
       nest = document.createElement('div');
       nest.className = 'tc-nested';
       parentEl.appendChild(nest);
     }
     return nest;
   }

   function flushPendingNestedTools(parentToolUseId) {
     var pending = pendingNestedByParent[parentToolUseId];
     if (!pending || !pending.length) return;
     var parentEl = lookupToolCallEl(parentToolUseId);
     if (!parentEl) return;
     var nest = ensureNestedContainer(parentEl);
     delete pendingNestedByParent[parentToolUseId];
     for (var i = 0; i < pending.length; i++) {
       if (pending[i] && pending[i].parentNode !== nest) {
         nest.appendChild(pending[i]);
       }
     }
   }

   function createStageElement(stageName, toolCallId, stagePrompt, stageMeta) {
     var stage = document.createElement('div');
     stage.className = 'tc-stage';
     stage.setAttribute('data-stage-name', stageName);
     if (toolCallId) stage.setAttribute('data-tool-call-id', String(toolCallId));
     var desc = (!compactMode && stagePrompt)
       ? (stagePrompt.length > 100 ? stagePrompt.substring(0, 97) + '...' : stagePrompt)
       : '';
     // Short label under the name: prefer description; full prompt stays in tooltip.
     var shortDesc = '';
     if (!compactMode && stageMeta && typeof stageMeta.description === 'string' && stageMeta.description.trim()) {
       shortDesc = stageMeta.description.trim();
       if (shortDesc.length > 100) shortDesc = shortDesc.substring(0, 97) + '...';
     } else if (desc && stagePrompt && stagePrompt.length > 120) {
       shortDesc = ''; // avoid dumping long prompt into the row; tooltip has it
     } else {
       shortDesc = desc;
     }
     var initStatus = (stageMeta && stageMeta.status) ? stageMeta.status : 'running';
     var iconStatus = stageIconStatus(initStatus);
     stage.innerHTML =
       '<span class="tc-stage-icon ' + iconStatus + '">' + getStatusIcon(iconStatus === 'error' ? 'error' : iconStatus) + '</span>' +
       '<span class="tc-stage-name">' + escapeHtml(stageName) + '</span>' +
       (shortDesc ? '<div class="tc-stage-desc">' + escapeHtml(shortDesc) + '</div>' : '');
     var stageData = Object.assign({
       name: stageName,
       role: (stageMeta && stageMeta.role) || 'agent',
       prompt_template: stagePrompt || '',
       status: iconStatus === 'error' ? 'failed' : iconStatus,
     }, stageMeta && typeof stageMeta === 'object' ? stageMeta : {});
     if (!stageData.prompt_template) stageData.prompt_template = stagePrompt || '';
     stageData.name = stageName;
     stageData.status = iconStatus === 'error' ? 'failed' : iconStatus;
     // [STAGE-DBG] capture exactly what role each stage is created with, so a
     // future reproduce of "last N subagents' role missing on hover" reveals
     // whether role was absent at creation (data) or lost later (merge/update).
     try {
       vscode.postMessage({ type: 'debugLog', message: '[STAGE-DBG] createStageElement name="' + String(stageName).slice(0, 60) + '" tcId="' + String(toolCallId).slice(0, 24) + '" role="' + String(stageData.role) + '" metaRole="' + String(stageMeta && stageMeta.role) + '" metaKeys=[' + (stageMeta ? Object.keys(stageMeta).join(',') : '') + ']' });
     } catch (e) {}
     attachStageTooltip(stage, stageData);
     return stage;
   }

   function syncCrewParentRawInput(crewEl) {
     if (!crewEl) return;
     var stages = crewEl.querySelectorAll(':scope > .tc-stages > .tc-stage');
     var rebuilt = [];
     for (var s = 0; s < stages.length; s++) {
       var data = stages[s]._stageData || {};
       var iconEl = stages[s].querySelector('.tc-stage-icon');
       var iconStatus = 'running';
       if (iconEl) {
         if (iconEl.classList.contains('completed')) iconStatus = 'completed';
         else if (iconEl.classList.contains('error') || iconEl.classList.contains('failed')) iconStatus = 'failed';
       }
       rebuilt.push({
         name: data.name || stages[s].getAttribute('data-stage-name') || ('Subagent ' + (s + 1)),
         role: data.role || 'agent',
         mode: data.mode,
         depends_on: data.depends_on,
         prompt_template: data.prompt_template || data.prompt || '',
         prompt: data.prompt || '',
         description: data.description || '',
         // Persist so reload can restore check/fail instead of infinite spinners.
         status: data.status || iconStatus,
       });
     }
     var prev = (crewEl._rawInput && typeof crewEl._rawInput === 'object') ? crewEl._rawInput : {};
     crewEl._rawInput = Object.assign({}, prev, { stages: rebuilt });
     if (currentToolsCountEl && currentToolsCountEl._rawInputs && currentToolsCountEl._titles) {
       for (var i = 0; i < currentToolsCountEl._titles.length; i++) {
         if (!isSubagentSpawnTitle(currentToolsCountEl._titles[i])) continue;
         currentToolsCountEl._rawInputs[i] = crewEl._rawInput;
         break;
       }
     }
     // Keep chatHistory.rawInput.stages[].status in sync for vscode.setState().
     var crewId = (crewEl.id || '').replace(/^tc-/, '');
     if (crewId) {
       for (var hi = chatHistory.length - 1; hi >= 0; hi--) {
         if (chatHistory[hi].kind === 'toolCall' && chatHistory[hi].toolCallId === crewId) {
           chatHistory[hi].rawInput = crewEl._rawInput;
           break;
         }
       }
     }
   }

   /** Map protocol/DOM stage status → icon class (running | completed | error). */
   function stageIconStatus(status) {
     if (status === 'completed' || status === 'done' || status === 'success' || status === 'terminated') {
       return 'completed';
     }
     if (status === 'failed' || status === 'error') return 'error';
     return 'running';
   }

   function applyStageIcon(stageEl, status) {
     if (!stageEl) return;
     var iconStatus = stageIconStatus(status);
     var iconEl = stageEl.querySelector('.tc-stage-icon');
     if (iconEl) {
       iconEl.className = 'tc-stage-icon ' + iconStatus;
       iconEl.textContent = getStatusIcon(iconStatus === 'error' ? 'error' : iconStatus);
     }
     if (!stageEl._stageData) stageEl._stageData = {};
     stageEl._stageData.status = iconStatus === 'error' ? 'failed' : iconStatus;
     var crew = stageEl.closest('.tool-call-inline.tc-subagent');
     if (crew) syncCrewParentRawInput(crew);
   }

   /**
    * After session/load: fail stages that never finished.
    * When the session was interrupted, also rewrite completed spawn stages —
    * Codex/Claude mark spawnAgent/Agent as completed once launched even though
    * the subagent work was cut off (would otherwise show a green check).
   */
  function failInterruptedSubagentStagesInHistory() {
    // Only process tool calls that belong to the LAST user turn — a session
    // interrupted on a later turn should not retroactively fail subagent
    // stages from earlier, completed turns (the parent tool_call succeeded,
    // the assistant replied, and the user moved on). Without this guard,
    // resuming a session where the last turn was interrupted would mark
    // ALL prior spawn_parallel stages as failed (red ❌) even though those
    // subagents completed successfully.
    var lastUserIdx = -1;
    for (var lu = chatHistory.length - 1; lu >= 0; lu--) {
      var luItem = chatHistory[lu];
      if (luItem && luItem.kind === 'message' && luItem.role === 'user' && !isSessionInterruptNotice(luItem.text)) {
        lastUserIdx = lu;
        break;
      }
    }
    var sessionInterrupted = sessionMarkedInterrupted();
    for (var i = (lastUserIdx >= 0 ? lastUserIdx + 1 : 0); i < chatHistory.length; i++) {
      var item = chatHistory[i];
      if (!item || item.kind !== 'toolCall' || !item.rawInput || typeof item.rawInput !== 'object') {
        continue;
      }
      if (!Array.isArray(item.rawInput.stages) || item.rawInput.stages.length === 0) continue;
      var stages = item.rawInput.stages.slice();
      var anyFailed = false;
      var parentDone = item.status === 'completed';
      // A completed parent tool_call means the spawn_parallel returned
      // successfully — the subagents finished. Even when the session is
      // marked interrupted (because a LATER turn was interrupted), these
      // stages must remain completed. Only fail stages when the parent
      // itself didn't complete (interrupted mid-execution).
      if (parentDone) {
        // Parent completed — stages should be completed too. Only fix up
        // stages that are in a running/pending state (interrupted children
        // that didn't get a final status update before the parent finished).
        for (var s = 0; s < stages.length; s++) {
          var stage = stages[s];
          if (!stage || typeof stage !== 'object') continue;
          var st = stage.status;
          if (st === 'running' || st === 'in_progress' || st === 'pending' || st === 'working') {
            stages[s] = Object.assign({}, stage, { status: 'failed' });
            anyFailed = true;
          }
        }
        if (anyFailed) {
          item.rawInput = Object.assign({}, item.rawInput, { stages: stages });
        }
        continue;
      }
      for (var s = 0; s < stages.length; s++) {
        var stage = stages[s];
        if (!stage || typeof stage !== 'object') continue;
        var st = stage.status;
        if (sessionInterrupted &&
            (st === 'completed' || st === 'done' || st === 'success' || st === 'terminated')) {
          stages[s] = Object.assign({}, stage, { status: 'failed' });
          anyFailed = true;
          continue;
        }
        if (st === 'completed' || st === 'done' || st === 'success' || st === 'terminated') continue;
        if (st === 'failed' || st === 'error') { anyFailed = true; continue; }
        if (st === 'running' || st === 'in_progress' || st === 'pending' || st === 'working') {
          stages[s] = Object.assign({}, stage, { status: 'failed' });
          anyFailed = true;
          continue;
        }
        // Missing status: interrupted or incomplete parent → failed;
        // completed parent on a finished session → completed.
        if (sessionInterrupted || !parentDone) {
          stages[s] = Object.assign({}, stage, { status: 'failed' });
          anyFailed = true;
        } else {
          stages[s] = Object.assign({}, stage, { status: 'completed' });
        }
      }
      if (anyFailed || sessionInterrupted) {
        item.rawInput = Object.assign({}, item.rawInput, { stages: stages });
        // Only override to failed when the parent tool was NOT already
        // marked completed by the restoreState/handleLoadSessionEnd fix
        // (which checked for a following assistant message). A completed
        // parent means the turn finished normally — don't re-fail it.
        if (item.status !== 'completed') {
          item.status = 'failed';
        }
      } else {
         item.rawInput = Object.assign({}, item.rawInput, { stages: stages });
       }
     }
   }

   /**
    * Fail spawn/crew toolCalls that belong to the last user turn when the
    * session was interrupted — including spawnAgent rows that arrived as
    * status=completed (launch ack only).
    */
   function failInterruptedSpawnToolsInHistory() {
     if (!sessionMarkedInterrupted()) return;
     if (historyLastTurnLooksFinished()) return;
     var lastUser = -1;
     for (var i = chatHistory.length - 1; i >= 0; i--) {
       var it = chatHistory[i];
       if (it && it.kind === 'message' && it.role === 'user' && !isSessionInterruptNotice(it.text)) {
         lastUser = i;
         break;
       }
     }
     for (var k = lastUser + 1; k < chatHistory.length; k++) {
       var item = chatHistory[k];
       if (!item || item.kind !== 'toolCall') continue;
       var isCrew = (item.rawInput && Array.isArray(item.rawInput.stages) && item.rawInput.stages.length > 0) ||
         isSubagentSpawnTitle(item.title, item.rawInput);
      if (!isCrew) continue;
      // Don't re-fail tools already marked completed by the restoreState
      // fix (they had a following assistant message — the turn finished).
      if (item.status === 'completed') continue;
      item.status = 'failed';
      if (item.rawInput && Array.isArray(item.rawInput.stages)) {
         item.rawInput = Object.assign({}, item.rawInput, {
           stages: item.rawInput.stages.map(function(st) {
             if (!st || typeof st !== 'object') return st;
             return Object.assign({}, st, { status: 'failed' });
           }),
         });
       }
     }
   }

   /** Flip checked/completed crew icons to failed in an interrupted last turn. */
   function failCompletedCrewsInInterruptedTurn() {
     if (!messagesEl) return;
     var turns = messagesEl.querySelectorAll('.turn');
     if (!turns.length) return;
     var lastTurn = turns[turns.length - 1];
     // Never rewrite a finished turn's green checks — that wraps the summary.
     if (turnLooksFinished(lastTurn) || historyLastTurnLooksFinished()) return;
     var force = sessionMarkedInterrupted() ||
       lastTurn.getAttribute('data-turn-interrupted') === '1' ||
       turnLooksInterrupted(lastTurn);
     if (!force) return;
     var crews = lastTurn.querySelectorAll('.tool-call-inline.tc-subagent');
     for (var c = 0; c < crews.length; c++) {
      var crew = crews[c];
      var parentIcon = crew.querySelector(':scope > .tc-icon');
      // Skip crews already marked completed — the restoreState fix verified
      // the turn finished (following assistant message exists).
      if (parentIcon && parentIcon.classList.contains('completed')) continue;
      if (parentIcon && (parentIcon.classList.contains('completed') ||
          parentIcon.classList.contains('running') ||
          parentIcon.classList.contains('in_progress') ||
          parentIcon.classList.contains('pending'))) {
         parentIcon.className = 'tc-icon failed';
         parentIcon.textContent = getStatusIcon('failed');
       }
       var stageIcons = crew.querySelectorAll('.tc-stage-icon');
       for (var s = 0; s < stageIcons.length; s++) {
         var stageEl = stageIcons[s].closest('.tc-stage');
         if (stageEl) applyStageIcon(stageEl, 'failed');
       }
       markSubagentCrewStale(crew);
     }
   }

   /** Fail every still-spinning stage/crew icon in the DOM (e.g. on promptStart). */
   function failRunningSubagentStagesInDom() {
     var icons = document.querySelectorAll(
       '.tc-stage-icon.running, .tc-stage-icon.in_progress, .tc-stage-icon.pending'
     );
     for (var i = 0; i < icons.length; i++) {
       var stageEl = icons[i].closest('.tc-stage');
       if (stageEl) applyStageIcon(stageEl, 'failed');
     }
     // Also force-fail spinning stages under already-failed parents, and mark
     // those crews stale so go-on list_update cannot revive them by name.
     var failedParents = document.querySelectorAll(
       '.tool-call-inline.tc-subagent > .tc-icon.failed, ' +
       '.tool-call-inline.tc-subagent > .tc-icon.error'
     );
     for (var fp = 0; fp < failedParents.length; fp++) {
       var failedCrew = failedParents[fp].parentElement;
       if (!failedCrew) continue;
       var spinKids = failedCrew.querySelectorAll(
         '.tc-stage-icon.running, .tc-stage-icon.in_progress, .tc-stage-icon.pending'
       );
       for (var ci = 0; ci < spinKids.length; ci++) {
         var st = spinKids[ci].closest('.tc-stage');
         if (st) applyStageIcon(st, 'failed');
       }
       markSubagentCrewStale(failedCrew);
     }
     var parents = document.querySelectorAll(
       '.tool-call-inline.tc-subagent > .tc-icon.running, ' +
       '.tool-call-inline.tc-subagent > .tc-icon.in_progress, ' +
       '.tool-call-inline.tc-subagent > .tc-icon.pending'
     );
     for (var p = 0; p < parents.length; p++) {
       var crew = parents[p].parentElement;
       // Always fail spinning parents on resume — Codex/Claude leave both the
       // parent and last stage spinning after an interrupted session load.
       var spinKids2 = crew ? crew.querySelectorAll(
         '.tc-stage-icon.running, .tc-stage-icon.in_progress, .tc-stage-icon.pending'
       ) : [];
       for (var ck = 0; ck < spinKids2.length; ck++) {
         var st2 = spinKids2[ck].closest('.tc-stage');
         if (st2) applyStageIcon(st2, 'failed');
       }
       parents[p].className = 'tc-icon failed';
       parents[p].textContent = getStatusIcon('failed');
       if (crew) markSubagentCrewStale(crew);
     }
     markFailedCrewsStale(document);
     for (var h = 0; h < chatHistory.length; h++) {
       var it = chatHistory[h];
       if (!it || it.kind !== 'toolCall') continue;
       if (it.status === 'in_progress' || it.status === 'running' || it.status === 'pending') {
         it.status = 'failed';
       }
       if (it.rawInput && Array.isArray(it.rawInput.stages)) {
         var stgs = it.rawInput.stages;
         var failed = false;
         for (var si = 0; si < stgs.length; si++) {
           var stg = stgs[si];
           if (!stg || typeof stg !== 'object') continue;
           var ss = stg.status;
           if (ss === 'completed' || ss === 'failed' || ss === 'error' ||
               ss === 'done' || ss === 'success' || ss === 'terminated') {
             continue;
           }
           stgs[si] = Object.assign({}, stg, { status: 'failed' });
           failed = true;
         }
         if (failed) {
           it.rawInput = Object.assign({}, it.rawInput, { stages: stgs });
           it.status = 'failed';
         }
       }
     }
     saveState();
   }

   function updateStageFromRawInput(stageEl, rawInput, title, opts) {
     if (!stageEl || !rawInput || typeof rawInput !== 'object') return;
     var keepName = !!(opts && opts.keepName);
     var fullPrompt = crewStageFullPrompt(rawInput);
     var label = keepName
       ? (stageEl.getAttribute('data-stage-name') || (stageEl._stageData && stageEl._stageData.name) || 'Subagent')
       : crewStageLabel(rawInput, title, 0);
     var patch = {
       name: label || stageEl.getAttribute('data-stage-name') || 'Subagent',
       role: rawInput.subagent_type || rawInput.role || (stageEl._stageData && stageEl._stageData.role) || 'agent',
       description: typeof rawInput.description === 'string' ? rawInput.description : '',
       prompt_template: fullPrompt || (stageEl._stageData && stageEl._stageData.prompt_template) || '',
       prompt: typeof rawInput.prompt === 'string' ? rawInput.prompt : '',
       mode: rawInput.mode,
       depends_on: rawInput.depends_on,
     };
     if (!keepName && label) {
       stageEl.setAttribute('data-stage-name', label);
       var nameEl = stageEl.querySelector('.tc-stage-name');
       if (nameEl) nameEl.textContent = label;
     }
     // [STAGE-DBG] tool_call_update / restore path. The patch.role has an
     // 'agent' fallback so it should never be falsy — but Object.assign in
     // attachStageTooltip copies undefined-valued keys, so if rawInput carries
     // role: undefined explicitly it could clobber a prior truthy role. Log
     // before/after to catch that.
     try {
       var _prevRole = stageEl._stageData && stageEl._stageData.role;
       vscode.postMessage({ type: 'debugLog', message: '[STAGE-DBG] updateStageFromRawInput name="' + String(label).slice(0, 60) + '" prevRole="' + String(_prevRole) + '" patchRole="' + String(patch.role) + '" riSubagentType="' + String(rawInput.subagent_type) + '" riRole="' + String(rawInput.role) + '"' });
     } catch (e) {}
     attachStageTooltip(stageEl, patch);
     var crew = stageEl.closest('.tool-call-inline.tc-subagent');
     if (crew) syncCrewParentRawInput(crew);
   }

   function refreshSubagentCrewTitle(crewEl) {
     if (!crewEl) return;
     var stages = crewEl.querySelectorAll(':scope > .tc-stages > .tc-stage');
     var n = stages.length || 1;
     var titleEl = crewEl.querySelector(':scope > .tc-title');
     if (titleEl) {
       titleEl.textContent = 'spawned ' + n + ' subagent' + (n > 1 ? 's' : '');
     }
     syncCrewParentRawInput(crewEl);
     if (currentToolsCountEl && currentToolsCountEl.classList.contains('turn-tools-summary')) {
       updateToolGroupSummary(
         currentToolsCountEl,
         currentToolCount,
         currentToolsCountEl._titles,
         currentToolsCountEl._kinds,
         currentToolsCountEl._rawInputs || [],
       );
     }
   }
   function refreshClaudeCrewTitle(crewEl) { refreshSubagentCrewTitle(crewEl); }

   function setSubagentStageStatus(toolCallId, status) {
     if (!toolCallId) return;
     var stage = document.querySelector('.tc-stage[data-tool-call-id="' + String(toolCallId).replace(/"/g, '') + '"]');
     if (!stage) return;
     applyStageIcon(stage, status);
     var crew = stage.closest('.tool-call-inline.tc-subagent');
     if (!crew) return;
     var iconStatus = stageIconStatus(status);
     if (iconStatus === 'running') return;
     var running = crew.querySelectorAll('.tc-stage-icon.running, .tc-stage-icon.in_progress, .tc-stage-icon.pending');
     if (running.length === 0) {
       var parentIcon = crew.querySelector(':scope > .tc-icon');
       if (parentIcon) {
         var parentDone = iconStatus === 'error' ? 'failed' : 'completed';
         // If any stage failed, prefer failed on the parent.
         if (crew.querySelector('.tc-stage-icon.error, .tc-stage-icon.failed')) parentDone = 'failed';
         parentIcon.className = 'tc-icon ' + parentDone;
         parentIcon.textContent = getStatusIcon(parentDone);
       }
     }
   }
   function setClaudeStageStatus(toolCallId, status) { setSubagentStageStatus(toolCallId, status); }

   /**
    * Unify Claude Task / Codex spawnAgent / Cursor task / etc. into the same
    * Kiro crew UI: one parent "spawned N subagents" card + stage rows.
    * Extra spawns in the same turn append stages. Nested child tools stay suppressed.
    */
   function addOrExtendSubagentCrew(toolCallId, title, status, rawInput, toolKind, locations) {
     hideEmpty();
     // codex spawn_parallel: rawInput = { tasks: [{ type, task, skills }] }.
     // Expand each task into its own stage upfront so tooltips show the correct
     // per-subagent prompt from the start, before any tool_call_update arrives.
     // Without this, all stages inherit the parent's title ("Spawn N subagents")
     // and empty prompt until per-subagent updates fill them in.
     var spawnParallelTasks = (rawInput && typeof rawInput === 'object' && Array.isArray(rawInput.tasks))
       ? rawInput.tasks : null;
     var stagePrompt = spawnParallelTasks ? '' : crewStageFullPrompt(rawInput);
     // On resume/load, interrupted Claude/Codex Agent tools often arrive as
     // status=completed (spawn succeeded) even though subagents never finished.
     // Default new stages to failed when the session was interrupted; only keep
     // completed for truly finished historical crews.
     var liveStream = isProcessing && !isLoadingSession;
     var stageInitStatus = 'running';
     if (status === 'failed' || status === 'error') stageInitStatus = 'failed';
     else if (!liveStream && sessionMarkedInterrupted()) stageInitStatus = 'failed';
     else if (status === 'completed' && !liveStream) stageInitStatus = 'completed';
     else if (!liveStream && (status === 'pending' || status === 'in_progress' || status === 'running' || !status)) {
       stageInitStatus = 'failed';
     }
     var stageMeta = (rawInput && typeof rawInput === 'object') ? {
       description: rawInput.description || '',
       role: rawInput.subagent_type || rawInput.role || 'agent',
       mode: rawInput.mode,
       depends_on: rawInput.depends_on,
       prompt: typeof rawInput.prompt === 'string' ? rawInput.prompt : '',
       status: stageInitStatus,
     } : { role: 'agent', status: stageInitStatus };
     var existing = findCurrentTurnSubagentCrew();
     if (existing) {
       var stagesWrap = existing.querySelector(':scope > .tc-stages');
       if (!stagesWrap) {
         stagesWrap = document.createElement('div');
         stagesWrap.className = 'tc-stages';
         existing.appendChild(stagesWrap);
       }
       var idx = stagesWrap.querySelectorAll('.tc-stage').length + 1;
       var stageName = crewStageLabel(rawInput, title, idx);
       // [STAGE-DBG] Claude/Codex extend path: each subagent spawn after the
       // first appends a stage here. Logs what subagent_type/role the spawn
       // carried so we can see if the last N spawns arrive without a role.
       try {
         vscode.postMessage({ type: 'debugLog', message: '[STAGE-DBG] extend-crew idx=' + idx + ' tcId="' + String(toolCallId).slice(0, 24) + '" subagent_type="' + String(rawInput && rawInput.subagent_type) + '" rawRole="' + String(rawInput && rawInput.role) + '" resolvedRole="' + String(stageMeta.role) + '" title="' + String(title).slice(0, 40) + '"' });
       } catch (e) {}
       stagesWrap.appendChild(createStageElement(stageName, toolCallId, String(stagePrompt || ''), stageMeta));
       toolCalls[toolCallId] = existing;
       syncCrewParentRawInput(existing);
       var parentIcon = existing.querySelector(':scope > .tc-icon');
       if (parentIcon) {
         if (liveStream && stageInitStatus === 'running') {
           parentIcon.className = 'tc-icon running';
           parentIcon.textContent = getStatusIcon('running');
         } else if (stageInitStatus === 'failed' || stageInitStatus === 'error' ||
                    existing.querySelector('.tc-stage-icon.error, .tc-stage-icon.failed')) {
           parentIcon.className = 'tc-icon failed';
           parentIcon.textContent = getStatusIcon('failed');
           markSubagentCrewStale(existing);
         } else if (!liveStream) {
           parentIcon.className = 'tc-icon completed';
           parentIcon.textContent = getStatusIcon('completed');
         }
       }
       refreshSubagentCrewTitle(existing);
       autoScrollIfAtBottom();
       return;
     }

    // codex spawn_parallel: expand tasks[] into individual stages so each
    // subagent gets its own name, role, and prompt from the start.
    var stagesArray;
    if (spawnParallelTasks && spawnParallelTasks.length > 0) {
      stagesArray = spawnParallelTasks.map(function(tk, i) {
        var taskPrompt = (typeof tk.task === 'string') ? tk.task : '';
        var taskRole = (typeof tk.type === 'string') ? tk.type : 'agent';
        // Use a truncated first line of the task description as the visible
        // name — "explore-1" is uninformative. Fall back to type-index only
        // when the task is empty.
        var _firstLine = taskPrompt ? taskPrompt.split('\\n')[0].trim() : '';
        var taskName = _firstLine
          ? (_firstLine.length > 60 ? _firstLine.substring(0, 57) + '...' : _firstLine)
          : (taskRole + '-' + (i + 1));
        return {
          name: taskName,
          role: taskRole,
          prompt_template: taskPrompt,
          prompt: taskPrompt,
          description: '',
          status: stageInitStatus,
        };
      });
     } else {
       var stageName = crewStageLabel(rawInput, title, 1);
       stagesArray = [{
         name: stageName,
         role: stageMeta.role || 'agent',
         prompt_template: String(stagePrompt || ''),
         prompt: stageMeta.prompt || '',
         description: stageMeta.description || '',
         status: stageInitStatus,
       }];
     }
     var synthRaw = Object.assign({}, (rawInput && typeof rawInput === 'object') ? rawInput : {}, {
       stages: stagesArray,
     });
     // Mark crew as codex spawn_parallel so completion overrides don't apply.
     if (spawnParallelTasks) synthRaw._isSpawnParallel = true;
     var spawnTitle = 'Task';
     // Keep Codex/Kiro protocol spawn titles; Claude description titles → Task.
     if (isSubagentSpawnTitle(title) && !looksLikeClaudeAgentSpawn(title, null)) {
       spawnTitle = title;
     }
     // Live spawn ack often arrives completed while stages still run → parent
     // stays running. Resume/interrupted → use failed/completed, never spin.
     var parentStatus = 'running';
     if (status === 'failed' || status === 'error' || stageInitStatus === 'failed') parentStatus = 'failed';
     else if (!liveStream && status === 'completed') parentStatus = 'completed';
     else if (!liveStream) parentStatus = 'failed';
     ensureTurnTools();
     currentToolCount++;
     if (currentToolsCountEl) {
       currentToolsCountEl.dataset.count = String(currentToolCount);
       if (!currentToolsCountEl._titles) currentToolsCountEl._titles = [];
       if (!currentToolsCountEl._kinds) currentToolsCountEl._kinds = [];
       if (!currentToolsCountEl._rawInputs) currentToolsCountEl._rawInputs = [];
       if (!currentToolsCountEl._locations) currentToolsCountEl._locations = [];
       currentToolsCountEl._titles.push(spawnTitle);
       currentToolsCountEl._kinds.push(toolKind || null);
       currentToolsCountEl._rawInputs.push(synthRaw);
       currentToolsCountEl._locations.push(locations || null);
       currentToolsCountEl._hasSubagent = true;
       currentToolsCountEl._hasSpawnAgent = true;
       if (currentToolsCountEl.classList.contains('turn-tools-summary')) {
         updateToolGroupSummary(currentToolsCountEl, currentToolCount, currentToolsCountEl._titles, currentToolsCountEl._kinds, currentToolsCountEl._rawInputs || []);
       }
     }

     const el = document.createElement('div');
     el.className = 'tool-call-inline tc-subagent';
     el.id = toolCallElementId(toolCallId);
     el.setAttribute('data-subagent-crew', '1');
     el.setAttribute('data-claude-crew', '1');
     if (toolKind) el.dataset.toolKind = toolKind;
     el._rawInput = synthRaw;
     el._locations = locations || null;
     el._toolTitle = spawnTitle;
     el.innerHTML =
       '<span class="tc-icon ' + parentStatus + '">' + getStatusIcon(parentStatus) + '</span>' +
       '<span class="tc-title">spawned ' + (spawnParallelTasks ? spawnParallelTasks.length : 1) + ' subagent' + ((spawnParallelTasks ? spawnParallelTasks.length : 1) > 1 ? 's' : '') + '</span>' +
       '<div class="tc-stages"></div>';
     var stagesEl = el.querySelector('.tc-stages');
     // codex spawn_parallel: append all expanded stages.
     if (spawnParallelTasks && stagesArray.length > 0) {
       for (var si = 0; si < stagesArray.length; si++) {
         var s = stagesArray[si];
         stagesEl.appendChild(createStageElement(s.name, toolCallId + '-' + si, s.prompt_template, s));
       }
     } else {
       stagesEl.appendChild(createStageElement(stagesArray[0].name, toolCallId, String(stagesArray[0].prompt_template || ''), stagesArray[0]));
     }
     syncCrewParentRawInput(el);
     if (parentStatus === 'failed' || parentStatus === 'error') markSubagentCrewStale(el);
     attachToolCallTooltip(el);
     if (currentToolsListEl) currentToolsListEl.appendChild(el);
     toolCalls[toolCallId] = el;
     applyStoredDiffContent(el, toolCallId);
     subagentCrewPrimaryId = toolCallId;
     if (compactMode && currentTurnEl) {
       ensureTurnFoldStructure(currentTurnEl, true);
       refreshCurrentTurnSummary();
     }
     autoScrollIfAtBottom();
   }
   function addOrExtendClaudeCrew(toolCallId, title, status, rawInput, toolKind, locations) {
     addOrExtendSubagentCrew(toolCallId, title, status, rawInput, toolKind, locations);
   }

   function addNestedToolCallInline(toolCallId, title, status, rawInput, toolKind, locations, parentToolUseId) {
     // Legacy no-op: nested Claude tools are suppressed (Kiro-style).
     return;
   }

   // Clean up multi-line tool-call titles. A shell command arrives as a
   // single title string that may contain newlines (e.g. "cd <dir>\\n<cmd>"
   // or a "# comment\\n<cmd>" preamble). Show the WHOLE command chain by
   // joining every non-comment, non-empty line with ' && ' — not just the
   // bare first line (which hid the real command behind a bare "cd"). Capped
   // at 120 chars with '...'; we deliberately do NOT fall back to the first
   // line when the join is long (that re-hides the real command).
   // NOTE: webview JS lives in a TS template literal, so newline escapes are
   // doubled ('\\n').
   function cleanMultiLineTitle(title) {
     var displayTitle = title || 'Tool Call';
     var _dt = String(displayTitle);
     if (_dt.indexOf('\\n') >= 0) {
       var _dtLines = _dt.split('\\n');
       var _meaningful = [];
       for (var _li = 0; _li < _dtLines.length; _li++) {
         var _line = _dtLines[_li].trim();
         if (_line && !_line.startsWith('#') && !_line.startsWith('//')) {
           _meaningful.push(_line);
         }
       }
       var _joined = _meaningful.join(' && ');
       if (_joined) {
         displayTitle = _joined.length > 120 ? _joined.substring(0, 117) + '...' : _joined;
       }
     }
     return displayTitle;
   }

   function addToolCallInline(toolCallId, title, status, rawInput, toolKind, locations, parentToolUseId) {
      hideEmpty();
     if (parentToolUseId) {
       addNestedToolCallInline(toolCallId, title, status, rawInput, toolKind, locations, parentToolUseId);
       return;
     }
     // Any spawn (Claude Task, Codex spawnAgent, Cursor Task, …) without native
     // Kiro stages[] → aggregate into one Kiro-style crew card.
     var hasKiroStages = rawInput && typeof rawInput === 'object' &&
       Array.isArray(rawInput.stages) && rawInput.stages.length > 0;
     // Trace every crew routing decision so a FALSE "spawned N subagent(s)" card
     // can be traced to the predicate + payload that produced it. Gated on
     // acp.debugResume; silent when nothing matches.
     var _crewReason = subagentSpawnReason(title, rawInput);
     if (_crewReason !== 'none') {
       resumeDiag('[WV-CREW] route: reason=' + _crewReason +
         ' title="' + String(title || '').replace(/\\s+/g, ' ').slice(0, 60) + '"' +
         ' kind=' + String(toolKind) +
         ' hasKiroStages=' + !!hasKiroStages +
         ' loading=' + isLoadingSession + ' processing=' + isProcessing +
         ' id=' + String(toolCallId || '').slice(0, 12) +
         ' riKeys=' + (rawInput && typeof rawInput === 'object'
           ? Object.keys(rawInput).join(',') : typeof rawInput));
     }
     if (isSubagentSpawnTitle(title, rawInput) && !hasKiroStages) {
       addOrExtendSubagentCrew(toolCallId, title, status, rawInput, toolKind, locations);
       return;
     }
     // Restored synthetic crew (single stage) — append to existing crew card.
     // Native Kiro multi-stage crews take the normal stages-render path below.
     if (isSubagentSpawnTitle(title, rawInput) && hasKiroStages && rawInput.stages.length === 1) {
       var existingCrew = findCurrentTurnSubagentCrew();
       if (existingCrew) {
         addOrExtendSubagentCrew(toolCallId, title, status, rawInput, toolKind, locations);
         return;
       }
     }
     ensureTurnTools();
     currentToolCount++;
     if (currentToolsCountEl) {
       currentToolsCountEl.dataset.count = String(currentToolCount);
       if (!currentToolsCountEl._titles) currentToolsCountEl._titles = [];
       if (!currentToolsCountEl._kinds) currentToolsCountEl._kinds = [];
       if (!currentToolsCountEl._rawInputs) currentToolsCountEl._rawInputs = [];
       if (!currentToolsCountEl._locations) currentToolsCountEl._locations = [];
       currentToolsCountEl._titles.push(title || 'Tool Call');
       currentToolsCountEl._kinds.push(toolKind || null);
       currentToolsCountEl._rawInputs.push(rawInput || null);
       currentToolsCountEl._locations.push(locations || null);
       if (hasKiroStages || isSubagentToolCall(title, toolKind, rawInput)) {
         currentToolsCountEl._hasSubagent = true;
         currentToolsCountEl._hasSpawnAgent = true;
       }
       if (currentToolsCountEl.classList.contains('turn-tools-summary')) {
         updateToolGroupSummary(currentToolsCountEl, currentToolCount, currentToolsCountEl._titles, currentToolsCountEl._kinds, currentToolsCountEl._rawInputs || []);
       }
     }

     const el = document.createElement('div');
     el.className = 'tool-call-inline';
     if (hasKiroStages || isSubagentToolCall(title, toolKind, rawInput)) {
       el.className += ' tc-subagent';
     }
     el.id = toolCallElementId(toolCallId);
     el._rawInput = rawInput || null;
     el._locations = locations || null;
     el._toolTitle = title || 'Tool Call';
      var displayTitle = resolveToolCallDisplayTitle(title, rawInput, locations, toolKind);
      syncToolKindDataset(el, rawInput, displayTitle, toolKind);
     // Title itself may be a JSON operation blob from Kiro.
     var titleTrim = String(displayTitle).trim();
      if (titleTrim.charAt(0) === '{' || titleTrim.charAt(0) === '[') {
        displayTitle = hasKiroStages ? 'spawned subagents' : 'operation';
      }
      // Any tool with stages[] is a crew card — even if the title is an opaque
      // Kiro "operation" blob rather than "Spawning agent crew".
      if (hasKiroStages || isSubagentToolCall(title, toolKind, rawInput)) {
        var spawnN = getSubagentSpawnCount(title, rawInput);
        if ((hasKiroStages || isSubagentSpawnTitle(title, rawInput)) && spawnN > 0) {
          var taskDesc = (rawInput && (rawInput.task || rawInput.prompt || rawInput.description)) || '';
          if (hasKiroStages) {
            displayTitle = 'spawned ' + spawnN + ' subagent' + (spawnN > 1 ? 's' : '');
          } else if (typeof taskDesc === 'string' && taskDesc.length > 0) {
            displayTitle = taskDesc.length > 80 ? taskDesc.substring(0, 77) + '...' : taskDesc;
          } else {
            displayTitle = 'spawned ' + spawnN + ' subagent' + (spawnN > 1 ? 's' : '');
          }
        }
      }
      el._toolTitle = displayTitle;
      if (currentToolsCountEl && currentToolsCountEl._titles && currentToolsCountEl._titles.length) {
        currentToolsCountEl._titles[currentToolsCountEl._titles.length - 1] = displayTitle;
        if (currentToolsCountEl.classList.contains('turn-tools-summary')) {
          updateToolGroupSummary(currentToolsCountEl, currentToolCount, currentToolsCountEl._titles, currentToolsCountEl._kinds, currentToolsCountEl._rawInputs || []);
        }
      }
      el.innerHTML =
        '<span class="tc-icon ' + status + '">' + getStatusIcon(status) + '</span>' +
        '<span class="tc-title">' + escapeHtml(displayTitle) + '</span>';
     // Render subagent stages as sub-items if present (Kiro crew / Claude synth).
     // In Collapse mode, omit long stage prompts from the DOM — they stay in
     // the hover tooltip only, so they cannot leak outside a closed fold.
     if (rawInput && Array.isArray(rawInput.stages) && rawInput.stages.length > 0) {
       var stagesHtml = '<div class="tc-stages">';
       for (var si = 0; si < rawInput.stages.length; si++) {
         var stage = rawInput.stages[si];
         var stageName = stage.name || ('stage-' + (si + 1));
         var stagePrompt = stage.prompt_template || '';
         var stageDesc = (!compactMode && stagePrompt.length > 0)
           ? (stagePrompt.length > 100 ? stagePrompt.substring(0, 97) + '...' : stagePrompt)
           : '';
         var stageRole = stage.role || '';
         var depends = stage.depends_on && stage.depends_on.length > 0 ? ' (depends: ' + stage.depends_on.join(', ') + ')' : '';
         var stageToolIdAttr = (isSubagentSpawnTitle(title, rawInput) && si === 0)
           ? ' data-tool-call-id="' + escapeHtml(String(toolCallId)) + '"'
           : '';
         // Prefer persisted stage.status. Live mid-turn keeps spinning even when
         // the parent spawn tool already flipped to completed.
         var rowStageStatus = stage.status;
         if (!rowStageStatus) {
           if (status === 'failed' || status === 'error') rowStageStatus = 'failed';
           else if (isProcessing && !isLoadingSession) rowStageStatus = 'running';
           else if (status === 'completed') rowStageStatus = 'completed';
           // Resume/history: missing status means the stage never finished.
           else rowStageStatus = 'failed';
         }
         // codex spawn_parallel crews: the agent replays the parent spawn tool
         // with status=completed (the spawn itself succeeded) but NO per-stage
         // status — the subagents' results arrive as separate messages, not as
         // tool_call_update stage patches. So on a completed, non-live parent
         // the stages did finish; default them to completed instead of failed.
         // (Live mid-turn keeps 'running' via the isProcessing branch above.)
         if (!stage.status && isSubagentSpawnTitle(title, rawInput) &&
             !isProcessing && status === 'completed') {
           rowStageStatus = 'completed';
         }
         var stageIcon = stageIconStatus(rowStageStatus);
         stagesHtml += '<div class="tc-stage" data-stage-name="' + escapeHtml(stageName) + '"' + stageToolIdAttr + '><span class="tc-stage-icon ' + stageIcon + '">' + getStatusIcon(stageIcon === 'error' ? 'error' : stageIcon) + '</span><span class="tc-stage-name">' + escapeHtml(stageName) + '</span>' +
           (stageRole ? '<span class="tc-stage-role">' + escapeHtml(stageRole) + '</span>' : '') +
           (depends ? '<span class="tc-stage-depends">' + escapeHtml(depends) + '</span>' : '') +
           (stageDesc ? '<div class="tc-stage-desc">' + escapeHtml(stageDesc) + '</div>' : '') +
           '</div>';
       }
      stagesHtml += '</div>';
      el.innerHTML += stagesHtml;
      if (rawInput && Array.isArray(rawInput.stages)) {
        var stageDivs = el.querySelectorAll('.tc-stage[data-stage-name]');
        for (var sti = 0; sti < stageDivs.length && sti < rawInput.stages.length; sti++) {
          var st = rawInput.stages[sti] || {};
          var tipStatus = stageIconStatus(st.status || (
            (isProcessing && !isLoadingSession) ? 'running'
              : ((status === 'failed' || status === 'error') ? 'failed'
                : (status === 'completed' ? 'completed' : 'failed'))
          ));
          // [STAGE-DBG] Kiro multi-stage initial render: logs each stage's
          // role as it comes off the wire in rawInput.stages[]. If a stage's
          // role is absent here, the tooltip will omit "Role:" by design
          // (formatStagesTooltipText: if (stage.role)).
          try {
            vscode.postMessage({ type: 'debugLog', message: '[STAGE-DBG] kiro-stages init idx=' + sti + ' name="' + String(st.name || '').slice(0, 60) + '" role="' + String(st.role) + '" hasRoleKey=' + ('role' in st) + ' stageKeys=[' + Object.keys(st).join(',') + ']' });
          } catch (e) {}
          attachStageTooltip(stageDivs[sti], Object.assign({}, st, {
            status: tipStatus === 'error' ? 'failed' : tipStatus,
          }));
        }
        syncCrewParentRawInput(el);
      }
     if (isSubagentSpawnTitle(title, rawInput)) {
       el.classList.add('tc-subagent');
       el.setAttribute('data-subagent-crew', '1');
       el.setAttribute('data-claude-crew', '1');
      // Mark codex spawn_parallel crews so per-subagent completion updates
      // (tool_call_update with aggregate stages[]) are not treated as a
      // single-stage prompt overwrite on stage 0.
      if (rawInput && typeof rawInput === 'object' &&
          Array.isArray(rawInput.stages) && rawInput.stages.length > 1 &&
          typeof rawInput.task === 'string' && /^spawn\\s/i.test(rawInput.task)) {
        if (el._rawInput && typeof el._rawInput === 'object') {
          el._rawInput._isSpawnParallel = true;
        } else {
          el._rawInput = Object.assign({}, rawInput, { _isSpawnParallel: true });
        }
      }
      subagentCrewPrimaryId = toolCallId;
    }
    }
     attachToolCallTooltip(el);
     if (currentToolsListEl) {
       currentToolsListEl.appendChild(el);
     }
     toolCalls[toolCallId] = el;
     applyStoredDiffContent(el, toolCallId);
     flushPendingNestedTools(toolCallId);
     // Keep fold structure updated but honor sticky user expand while streaming.
     if (compactMode && currentTurnEl) {
       ensureTurnFoldStructure(currentTurnEl, true);
       refreshCurrentTurnSummary();
     }
     autoScrollIfAtBottom();
   }

  // Fallback DOM builder for history restore (standalone card)
    function addToolCallDOM(toolCallId, title, status, rawInput) {
      hideEmpty();
      const el = document.createElement('div');
      el.className = 'tool-call';
      el.id = toolCallElementId(toolCallId);
      el._rawInput = rawInput || null;
      el._toolTitle = title || 'Tool Call';
      el.innerHTML = '<span class="title">' + escapeHtml(title || 'Tool Call') + '</span>'
        + '<span class="status-badge ' + status + '">' + status + '</span>';
      attachToolCallTooltip(el);
     messagesEl.appendChild(el);
     toolCalls[toolCallId] = el;
     applyStoredDiffContent(el, toolCallId);
     autoScrollIfAtBottom();
   }

  /**
   * Render chatHistory into the messages DOM using the same turn-based
   * inline layout as live streaming.  Groups consecutive tool calls into
   * collapsible "Tool calls" containers within .turn wrappers, so the
   * restored history is compact instead of one-card-per-tool-call.
   * Returns the list of assistant message indices that need markdown rendering.
   */
function renderChatHistory() {
 trace('renderChatHistory START: chatHistory.length=' + chatHistory.length);
 traceHistorySnapshot();
 // Clean up duplicate assistant entries from older sessions (before the
 // dedup guard was added). If two consecutive assistant messages have the
 // exact same text, remove the second one. This fixes persisted state that
 // already contains duplicates.
 var _deduped = false;
 for (var _di = chatHistory.length - 1; _di > 0; _di--) {
   var _cur = chatHistory[_di];
   var _prev = chatHistory[_di - 1];
   if (_cur && _prev &&
       _cur.kind === 'message' && _cur.role === 'assistant' &&
       _prev.kind === 'message' && _prev.role === 'assistant' &&
       _cur.text === _prev.text && _cur.text) {
     chatHistory.splice(_di, 1);
     _deduped = true;
   }
 }
if (_deduped) {
  vscode.postMessage({ type: 'debugLog', message: '[WV-DEDUP] renderChatHistory: removed duplicate assistant entries' });
  saveState();
}
 // Strip persisted compaction notices from older builds that saved them to
 // chatHistory. These are transient DOM-only notices now — they must not
 // survive resume or appear after tool calls and assistant messages.
 var _strippedCompact = false;
 for (var _sci = chatHistory.length - 1; _sci >= 0; _sci--) {
   var _scItem = chatHistory[_sci];
   if (_scItem && _scItem.kind === 'message' && _scItem.role === 'system' && (
       String(_scItem.text || '').trim() === 'Conversation compacted.' ||
       String(_scItem.text || '').trim().indexOf('*Context compacted') === 0 ||
       /conversation compacted/i.test(String(_scItem.text || '').trim())
   )) {
     chatHistory.splice(_sci, 1);
     _strippedCompact = true;
   }
 }
 if (_strippedCompact) {
   saveState();
   vscode.postMessage({ type: 'debugLog', message: '[WV-COMPACT] renderChatHistory: stripped persisted compaction notices' });
 }
// Increment generation counter to invalidate any in-flight markdownRendered
  // responses from a previous DOM build. Stale responses would update the
  // wrong elements or skip needed updates after a DOM rebuild.
 historyRenderGen++;
 messagesEl.innerHTML = '';
 toolCalls = {};
 toolCallDiffs = {};
 resetClaudeCrewState();
 currentPlanEl = null;
 if (planBar) { planBar.innerHTML = ''; }
 if (typeof clearCursorTodosPlan === 'function') clearCursorTodosPlan();
 currentTurnEl = null;
 currentToolsListEl = null;
 currentToolsCountEl = null;
 currentToolCount = 0;
 // Suppress intermediate fold re-ordering during renderChatHistory.
 // Each addThoughtDOM / ensureTurnTools call internally triggers
 // ensureTurnFoldStructure → orderCompactFoldContents, which sorts by
 // current document position. During rendering, not all items are in the
 // DOM yet, so intermediate sorts scramble the interleaved order.
 // The final ensureTurnFoldStructure at the end of this function will
 // order correctly once all items are in place.
 suppressFoldOrdering = true;
 keepAssistantsInFold = true;
 var assistantItems = [];
  // Buffer thoughts only until we can attach them to a turn; each thought
  // renders as its own block (in history order) — never merge/overwrite.
  var turnThoughts = [];
  function flushTurnThought() {
    if (turnThoughts.length === 0) return;
    var pending = turnThoughts.slice();
    turnThoughts = [];
    if (!currentTurnEl) {
      currentTurnEl = document.createElement('div');
      currentTurnEl.className = 'turn';
      messagesEl.appendChild(currentTurnEl);
      hideEmpty();
    }
   pending.forEach(function (t) {
     if (!t.text || !String(t.text).trim()) return;
      addThoughtDOM(t.text, t.durationSec || 0, t.historyIndex);
   });
    trace('flushTurnThought: rendered ' + pending.length + ' separate thought block(s)');
  }
  for (var i = 0; i < chatHistory.length; i++) {
    var item = chatHistory[i];
   if (!item) continue;
   // Skip persisted Kiro Summarizing rows (redundant with assistant summary).
   if (item.kind === 'toolCall' && isKiroSummaryToolTitle(item.title)) continue;
   // Skip Cursor Update TODOs tool rows — board lives in the plan bar.
   if (item.kind === 'toolCall' && isCursorUpdateTodosPlaceholder(item.title, item.rawInput)) continue;
   // Keep the outer index for DOM stamping — thoughts were pushed via the
   // addThoughtDOM historyIndex arg, tool rows stamped explicitly below.
   var _historyIndex = i;
   // Debug: log each item
    if (item.kind === 'toolCall') {
      vscode.postMessage({ type: 'debugLog', message: '[WV-RENDER] renderChatHistory item[' + i + '] kind=toolCall title="' + (item.title || '') + '" id=' + (item.toolCallId || '').slice(0, 12) });
    }
   if (item.kind === 'message') {
      var _dbgText = typeof item.text === 'string' ? (item.text.length > 100 ? item.text.substring(0, 100) + '...' : item.text) : '(non-string)';
      vscode.postMessage({ type: 'debugLog', message: 'renderChatHistory item[' + i + '] kind=' + item.kind + ' role=' + item.role + ' textLen=' + (typeof item.text === 'string' ? item.text.length : -1) + ' text="' + _dbgText + '"' });
    }
    trace('item[' + i + ']: kind=' + item.kind + (item.kind === 'message' ? ' role=' + item.role : '') + ' | turn exists before=' + !!currentTurnEl + ', turn children=' + (currentTurnEl ? currentTurnEl.children.length : '-'));
    switch (item.kind) {
      case 'message':
        // Start a new turn for user/system/error messages.
        // Assistant messages continue the current turn (or start one)
        // so that tool calls are grouped under the assistant text.
       if (item.role === 'user' || item.role === 'error' || item.role === 'system') {
         // Belongs to the turn that just ended: flush its buffered thought(s)
         // to the top of that turn before resetting for the user message.
         flushTurnThought();
         currentTurnEl = null;
         currentToolsListEl = null;
         currentToolsCountEl = null;
         // Interrupt notices stay in chatHistory for fold/interrupt heuristics.
         // Prefer not showing them as user bubbles — but if Claude omitted the
         // real prompt and we have nothing else to show, surface a system line.
         if (item.role === 'user' && isSessionInterruptNotice(item.text)) {
           if (!messagesEl.querySelector('.message.user')) {
             addMessageDOM('system', '— Conversation interrupted —');
           }
           break;
         }
         trace('  -> user/error/system: reset turn, append directly to messages');
         // Safety net: clean user messages again in case raw context
         // links were stored in chatHistory before the fix.
         var displayText = item.role === 'user' ? cleanUserMessage(item.text) : item.text;
         // If cleaning stripped context-only wrappers, fall back to raw text so
         // session/load prompts are not silently dropped from the panel. A user
         // row that carries BOTH real typed text and an injected memory/skills
         // blob (fork memory-carry, @memory injection) must still be shown with
         // the real text — judge machine-context-only on the CLEANED text, not
         // the raw blob, otherwise isMachineContextOnly() sees the <agent-memory>
         // tag and wrongly hides a real prompt.
         if (item.role === 'user' && !String(displayText || '').trim()) {
           var rawFallback = String(item.text || '').trim();
           if (rawFallback && !isSessionInterruptNotice(rawFallback)) {
             var cleanedFallback = cleanUserMessage(rawFallback);
             if (String(cleanedFallback || '').trim()) {
               displayText = cleanedFallback;
             } else if (!isMachineContextOnly(rawFallback)) {
               displayText = rawFallback;
             }
           }
         }
         if (item.role === 'user' && !String(displayText || '').trim()) {
           break;
         }
         vscode.postMessage({ type: 'debugLog', message: '[WV-USER] render item[' + i + '] len=' + displayText.length + ' text="' + (displayText.length > 80 ? displayText.substring(0, 80) + '...' : displayText) + '"' });
         var _sysEl = addMessageDOM(item.role, displayText);
         if (item.role === 'system' && _sysEl &&
             String(item.text || '').trim() === 'Conversation compacted.') {
           _sysEl.classList.add('compact-notice');
         }
        } else {
           // Assistant message. Same turn when tools already ran (mid-turn
           // interim text + final summary). New turn only for back-to-back
           // assistants with no tools between them.
           // Skip whitespace-only assistant text — session/load replay and
           // the snapshot merge can carry an empty assistant row (e.g. a turn
           // interrupted before any text was emitted). Rendering it would
           // create an empty assistant bubble in the panel.
           if (!item.text || !String(item.text).trim()) {
             trace('  -> assistant: skipping empty/whitespace text');
             break;
           }
           var turnHasAssistant = currentTurnEl && currentTurnEl.querySelector('.message.assistant');
           var turnHasTools = currentTurnEl && currentTurnEl.querySelector('.tool-call-inline');
           if (turnHasAssistant && !turnHasTools) {
             // Back-to-back assistants with no tools between them: keep in
             // the SAME turn and mark prior assistants as interim (folded).
             // Previously this started a NEW turn for each assistant, which
             // left every turn with exactly 1 assistant → promoteFinalAssistant
             // lifted it out as a visible summary → nothing was folded.
             Array.prototype.forEach.call(
               currentTurnEl.querySelectorAll('.message.assistant'),
               function(a) {
                 a.classList.add('assistant-interim');
                 a.classList.remove('assistant-summary');
               }
             );
             trace('  -> assistant: prior assistant without tools -> same turn, mark interim');
          } else if (turnHasAssistant && turnHasTools) {
            // Prior assistant segments in this turn become interim (folded).
            Array.prototype.forEach.call(
              currentTurnEl.querySelectorAll('.message.assistant'),
              function(a) {
                a.classList.add('assistant-interim');
                a.classList.remove('assistant-summary');
              }
            );
            // Reset the tools list so the NEXT tool call creates a NEW
            // turn-tools wrapper (appended after this assistant in the fold
            // body). Without this, the next tool reuses the OLD wrapper
            // which sits BEFORE the assistant — grouping all tools together
            // and breaking the interleaved order: thought → tools → assistant
            // → tools → assistant.
            currentToolsListEl = null;
            trace('  -> assistant: same turn after tools, prior assistants marked interim');
          }
           if (!currentTurnEl) {
             currentTurnEl = document.createElement('div');
             currentTurnEl.className = 'turn';
             messagesEl.appendChild(currentTurnEl);
             currentToolsListEl = null;
             currentToolsCountEl = null;
             currentToolCount = 0;
             trace('  -> assistant: created turn, append message');
           } else {
             trace('  -> assistant: reuse turn, append message');
           }
           hideEmpty();
           var msgEl = document.createElement('div');
           msgEl.className = 'message ' + item.role;
           msgEl.textContent = item.text;
           msgEl.setAttribute('data-history-index', String(i));
           if (item.interrupted) {
             msgEl.setAttribute('data-interrupted', '1');
             if (currentTurnEl) currentTurnEl.setAttribute('data-turn-interrupted', '1');
           }
           placeAssistantInTurn(msgEl);
         }
         if (item.role === 'assistant') {
          assistantItems.push({ index: i, text: item.text });
          // Tag with current historyRenderGen so markdownRendered handler
          // can discard stale responses after a DOM rebuild.
          assistantItems[assistantItems.length - 1].hgen = historyRenderGen;
         }
         break;
       case 'thought':
         // Render each thought as its own block in history order (do not merge).
         if (item.text && String(item.text).trim()) {
           if (!currentTurnEl) {
             currentTurnEl = document.createElement('div');
             currentTurnEl.className = 'turn';
             messagesEl.appendChild(currentTurnEl);
             hideEmpty();
           }
            addThoughtDOM(item.text, item.durationSec || 0, i);
           trace('  -> thought: rendered block (textLen=' + item.text.length + ',dur=' + (item.durationSec || 0) + 's)');
         }
         break;
     case 'toolCall': {
       addToolCallInline(item.toolCallId, item.title, item.status,
         item.rawInput && item.rawInput.taskResult
           ? stripTaskResult(item.rawInput)
           : item.rawInput,
         item.toolKind,
         item.locations,
         item.parentToolUseId || null);
       var _toolEl = lookupToolCallEl(item.toolCallId);
       // Restore diffPaths from persisted history so tooltips work after
       // VS Code restart (without session/load replay).
       if (_toolEl && item.diffPaths && item.diffPaths.length > 0) {
         _toolEl._diffPaths = item.diffPaths;
       }
       if (_toolEl && _toolEl.setAttribute) {
         stampToolHistoryIndex(item.toolCallId, _historyIndex);
       }
       break;
     }
        case 'plan':
          updatePlanDOM(item.plan);
          break;
      }
    }
   // Flush any thought(s) still buffered for the final turn.
   flushTurnThought();
   currentTurnEl = null;
  currentToolsListEl = null;
  currentToolsCountEl = null;
  currentToolCount = 0;
 // Re-enable assistant promotion and fold ordering BEFORE the post-render
 // loop. The keepAssistantsInFold flag was needed DURING the rendering loop
 // to prevent ensureTurnFoldStructure from yanking assistants out of their
 // interleaved positions mid-render. By the time we reach here, all items
 // are in the DOM in correct order, so it's safe to turn off. This allows:
 // 1. promoteFinalAssistantForTurn (in the loop below) to actually promote
 //    the last assistant outside the fold (it returns early if
 //    keepAssistantsInFold is true — that was hiding the summary).
 // 2. ensureTurnFoldStructure (in the loop + forceCollapseTurnFolds) to use
 //    the normal path instead of the keepAssistantsInFold branch that dumps
 //    ALL assistants at the end of the fold body (breaking interleaved order
 //    and creating duplicate summaries on expand).
 keepAssistantsInFold = false;
 suppressFoldOrdering = false;
 // Collect tool titles from every tools group, then (in compact mode) fold.
 messagesEl.querySelectorAll('.turn').forEach(function(turn) {
   var lists = turn.querySelectorAll('.turn-tools-list');
   var summary = getTurnSummaryEl(turn);
   if (lists.length && summary) {
     var titles = [];
     var kinds = [];
     var rawInputs = [];
     var hasSubagent = false;
     lists.forEach(function(list) {
       list.querySelectorAll('.tool-call-inline').forEach(function(tc) {
         if (tc.getAttribute('data-parent-tool')) return;
         var tcTitle = getToolCallOriginalTitle(tc);
         var tcKind = tc.dataset.toolKind || null;
         var tcRaw = tc._rawInput || null;
         titles.push(tcTitle);
         kinds.push(tcKind);
         rawInputs.push(tcRaw);
         if (isSubagentToolCall(tcTitle, tcKind, tcRaw)) hasSubagent = true;
       });
     });
     summary._titles = titles;
     summary._kinds = kinds;
     summary._rawInputs = rawInputs;
     summary._hasSubagent = hasSubagent;
     summary.dataset.count = String(titles.length);
   }
 if (compactMode) {
    // Items are already in correct append order from the rendering loop.
    // ensureTurnFoldStructure sets up the fold shell + summary, and
    // orderCompactFoldContents runs a stable sort by document position
    // (preserves interleaved order, just scoops strays into the body).
    // promoteFinalAssistantForTurn lifts the last assistant outside the
    // fold as the visible summary.
    ensureTurnFoldStructure(turn, true);
    promoteFinalAssistantForTurn(turn);
    // Assistant-less turn that still has a stray thought / tool group (e.g.
    // an interrupted turn cancelled before the agent produced any reply):
    // promoteFinalAssistantForTurn bails out early when the turn has no
    // assistants, so its fold path never scoops the stray .thought-block /
    // .turn-tools into the fold body. After a resume render that stray thought
    // rendered as its own collapsed "Thought" card floating BELOW the previous
    // turn's promoted summary. NOTE: this turn may carry a .message.user
    // bubble (the user's own prompt that started the cancelled turn), so we
    // gate ONLY on the absence of an assistant + the presence of foldable
    // content (a stray thought or tool) - never on the absence of a user
    // bubble. Live streaming is already guarded by !isProcessing (a live turn
    // is always in-processing); this pass only runs on resume/load renders.
    // Requiring a .thought-block/.turn-tools also avoids creating an empty
    // fold header for a turn that has nothing but a user bubble.
    if (!turn.querySelector('.message.assistant') &&
        turn.querySelector('.thought-block, .turn-tools') &&
        !isProcessing && !isLoadingSession) {
      ensureTurnFoldStructure(turn, true, true);
      var _body = getTurnFoldBody(turn);
      if (_body) {
        orderCompactFoldContents(_body);
        var _sum = getTurnSummaryEl(turn);
        if (_sum) {
          if (turn.querySelector('.thought-block')) _sum._hasThought = true;
          updateToolGroupSummary(
            _sum,
            parseInt(_sum.dataset.count || '0', 10),
            _sum._titles || [],
            _sum._kinds || [],
            _sum._rawInputs || []
          );
        }
      }
    }
  } else if (lists.length && summary) {
    updateToolGroupSummary(summary, parseInt(summary.dataset.count || '0', 10), summary._titles || [], summary._kinds || [], summary._rawInputs || []);
  }
});
 // ORPHAN TURN MERGE (interrupted-resume bug):
 // When a turn is interrupted, the interrupt-notice handling in the render
 // loop nulls currentTurnEl; a trailing thought/tool that still belongs to
 // the interrupted turn then lands in a brand-new .turn with NO user bubble
 // and NO assistant. promoteFinalAssistantForTurn cannot promote (no
 // assistant) and the per-turn stray-thought fold only targets turns that
 // already have fold structure, so the orphan renders as a stray collapsed
 // "Thinking" card. It can appear at the very bottom OR mid-conversation
 // (an interrupted earlier turn that the session/load replay re-surfaced),
 // so we must scan EVERY turn, not just the last. Merge the orphan's
 // foldable content into the previous turn's fold body so it displays inside
 // the collapsed group. Walk forward; after removing an orphan the next
 // sibling's "previous turn" is already the correct merge target.
 if (compactMode && !isProcessing && !isLoadingSession) {
   var _orphanMerged = 0;
   var _turns = Array.prototype.slice.call(messagesEl.querySelectorAll('.turn'));
   for (var _ti = 0; _ti < _turns.length; _ti++) {
     var _turn = _turns[_ti];
     if (_ti === 0) continue; // no previous turn to merge into
     if (_turn.querySelector('.message.user')) continue;
     if (_turn.querySelector('.message.assistant')) continue;
     // The per-turn stray-thought fold (above) may already have wrapped the
     // orphan's thought in its own .turn-fold-body, so match descendant
     // .thought-block / .turn-tools anywhere in the orphan turn (not just
     // direct children of .turn).
     var _foldables = Array.prototype.slice.call(_turn.querySelectorAll('.thought-block, .turn-tools'));
     if (_foldables.length === 0) continue;
     // Use the live previousElementSibling (not the stale _turns[_ti - 1])
     // because a prior iteration may have removed a turn, shifting siblings.
     var _prev = _turn.previousElementSibling;
     if (!_prev || !_prev.classList.contains('turn')) continue;
     ensureTurnFoldStructure(_prev, true, true);
     var _body = getTurnFoldBody(_prev);
     if (_body) {
       _foldables.forEach(function(node) { _body.appendChild(node); });
       _turn.remove();
       orderCompactFoldContents(_body);
       var _sum = getTurnSummaryEl(_prev);
       if (_sum && _body.querySelector('.thought-block')) {
         _sum._hasThought = true;
         updateToolGroupSummary(
           _sum,
           parseInt(_sum.dataset.count || '0', 10),
           _sum._titles || [],
           _sum._kinds || [],
           _sum._rawInputs || []
         );
       }
       _orphanMerged++;
     }
   }
   if (_orphanMerged > 0) {
     resumeDiag('[WV-DIAG] orphan merge: merged ' + _orphanMerged + ' stray turn(s) into previous fold');
   }
 }
 // promoteFinalAssistant / structure rebuild can leave folds open after
 // session/load — force Collapse mode shut once the DOM is final.
forceCollapseTurnFolds();
// Codex/Claude interrupted crews often still have running icons after rebuild.
 failRunningSubagentStagesInDom();
 failCompletedCrewsInInterruptedTurn();
  // Interrupted crews stay failed — ignore later list_update by name.
  markFailedCrewsStale(messagesEl);
   return assistantItems;
 }

   function updateToolCall(toolCallId, status, title, content, rawInput) {
     var _wasTerminal = false;
     for (let i = chatHistory.length - 1; i >= 0; i--) {
       if (chatHistory[i].kind === 'toolCall' && toolCallIdsMatch(chatHistory[i].toolCallId, toolCallId)) {
         var _prevStatus = chatHistory[i].status;
         if (status) {
           var _prevTerminal = _prevStatus === 'completed' || _prevStatus === 'failed' || _prevStatus === 'error';
           var _nextRunning = status === 'pending' || status === 'running' || status === 'in_progress';
           // Don't let Cursor's late pending updates undo a completed row.
           if (!(_prevTerminal && _nextRunning)) {
             chatHistory[i].status = status;
           }
         }
         if (title) chatHistory[i].title = title;
         if (rawInput) chatHistory[i].rawInput = rawInput;
         var _resolvedTitle = resolveToolCallDisplayTitle(
           chatHistory[i].title,
           chatHistory[i].rawInput,
           chatHistory[i].locations,
           chatHistory[i].toolKind
         );
         if (_resolvedTitle) chatHistory[i].title = _resolvedTitle;
         // Detect a transition INTO a terminal status (completed/failed/error)
         // from a running one — used to live-refresh the /ps panel so a tool
         // that ends mid-turn disappears from the running list immediately,
         // without waiting for the next turn's drainQueue.
         var _appliedStatus = chatHistory[i].status;
         if (_appliedStatus && _appliedStatus !== _prevStatus &&
             (_appliedStatus === 'completed' || _appliedStatus === 'failed' || _appliedStatus === 'error') &&
             (_prevStatus === 'in_progress' || _prevStatus === 'running' || _prevStatus === 'pending')) {
           _wasTerminal = true;
         }
         break;
       }
     }
    saveState();
     storeDiffContent(toolCallId, content, title);
     if (_wasTerminal) refreshPsPanelIfVisible();

    // Crew stage: update spinner + fill tooltip from late rawInput (Claude/Codex
    // often send empty rawInput first, then prompt/description on update).
    // codex spawn_parallel: the per-subagent progress update carries the
    // AGGREGATE rawInput.stages[] (with per-stage .status). It must NOT be
    // handled by the single-stage stageForId path below (which would
    // overwrite stage 0's prompt with the parent's "Spawn N subagents" task
    // and short-circuit before the multi-stage iteration runs). Route it to
    // the crew-level stages[] handler instead.
    var crewElForAggregate = lookupToolCallEl(toolCallId);
    var isAggregateParallelUpdate = rawInput && typeof rawInput === 'object' &&
      Array.isArray(rawInput.stages) && rawInput.stages.length > 1 &&
      crewElForAggregate && (crewElForAggregate.getAttribute('data-subagent-crew') === '1' || crewElForAggregate.getAttribute('data-claude-crew') === '1') &&
      (crewElForAggregate._rawInput && crewElForAggregate._rawInput._isSpawnParallel);
    if (isAggregateParallelUpdate) {
      // Fall through to the crew-level el handler below — it iterates all
      // stages and applies per-stage icons. Skip the single-stage block.
    } else {
    var stageForId = document.querySelector('.tc-stage[data-tool-call-id="' + String(toolCallId).replace(/"/g, '') + '"]');
    if (stageForId) {
      // When the tool_call_update is for the parent crew's toolCallId (assigned
      // to the first stage at render time), pass keepName=true so the stage's
      // original name (e.g. "explore-1") isn't overwritten with the parent's
      // task description (e.g. "Spawn 2 subagents").
      //
      // For codex spawn_parallel: the parent crew's rawInput contains
      // { tasks: [...] } — the aggregate spawn request. We must NOT let it
      // overwrite the per-subagent prompt that was already set from the
      // individual task at render time. Only apply the update if the
      // rawInput looks like a per-subagent update (has a single task/prompt,
      // not a tasks[] array).
      var crewElForUpdate = stageForId.closest('.tool-call-inline.tc-subagent');
      var isSpawnParallelForUpdate = crewElForUpdate && crewElForUpdate._rawInput && crewElForUpdate._rawInput._isSpawnParallel;
      // buildToolRawInput transforms tasks[] → stages[], so check stages[]
      // (length > 1 = aggregate, not per-subagent) instead of tasks[].
      var isAggregateSpawnInput2 = rawInput && Array.isArray(rawInput.stages) && rawInput.stages.length > 1;
      if (rawInput && !(isSpawnParallelForUpdate && isAggregateSpawnInput2)) {
        updateStageFromRawInput(stageForId, rawInput, title, { keepName: true });
      }
     // Claude Agent Task / Codex spawn often flip tool_call to "completed"
     // when the subagent is only *started* (nested child tools still run).
     // Keep the stage spinning until promptEnd (or a real failure).
     // BUT: codex spawn_parallel sends per-subagent completion as a REAL
     // signal — that subagent is done. Don't override to 'running'.
    // ALSO: codex subAgentActivity item/completed is a REAL completion
    // signal (the subagent finished), not a "started" signal. The
    // _meta.codex.subagent field distinguishes it from Claude Agent Task
    // spawn-acknowledgements. Don't override those to 'running' either.
    // ALSO: codex collabAgentToolCall (spawnAgent/waitAgent) completions
    // are REAL signals too — the tool call finished. The _meta.codex.collaboration
    // field or rawInput.receiverThreadIds distinguishes them from Claude.
    var _isCodexSubagentCompletion = !!(rawInput && typeof rawInput === 'object' &&
      rawInput.activityKind) || !!(crewElForUpdate && crewElForUpdate._rawInput &&
      crewElForUpdate._rawInput.activityKind) ||
      !!(rawInput && typeof rawInput === 'object' && rawInput.receiverThreadIds) ||
      !!(crewElForUpdate && crewElForUpdate._rawInput &&
      crewElForUpdate._rawInput.receiverThreadIds);
     var crewEl = stageForId.closest('.tool-call-inline.tc-subagent');
     var isSpawnParallelCrew = crewEl && crewEl._rawInput && crewEl._rawInput._isSpawnParallel;
     var stageStatus = status || 'running';
     if (stageStatus === 'completed' && isProcessing && !isLoadingSession && !isSpawnParallelCrew && !_isCodexSubagentCompletion) {
       stageStatus = 'running';
     }
      // spawn_parallel: a subagent that completed with "No output"
      // (empty summary) still sent a real completion signal. Mark it as
      // a terminal state so the spinner stops — don't keep it spinning
      // just because the summary is empty.
      if (isSpawnParallelCrew && stageStatus === 'completed') {
        // Check if the stage already has a 'completed' or 'failed' icon —
        // if so, it was already finalized by a per-subagent completion
        // event and we don't need to re-set it.
        var existingIcon = stageForId.querySelector('.tc-stage-icon');
        if (existingIcon && (existingIcon.classList.contains('completed') || existingIcon.classList.contains('failed') || existingIcon.classList.contains('error'))) {
          return;
        }
      }
      setSubagentStageStatus(toolCallId, stageStatus);
      return;
    }
    } // end else (not aggregate parallel update)

     const el = lookupToolCallEl(toolCallId);
     if (!el) return;

     // Attach tooltip if rawInput arrived in an update (not present on
     // the initial tool_call event).
    if (rawInput) {
      if (el.getAttribute('data-subagent-crew') || el.getAttribute('data-claude-crew') ||
          el.querySelector(':scope > .tc-stages')) {
        // codex spawn_parallel: the tool_call_update carries updated
        // rawInput.stages[] with per-stage status fields. Iterate through
        // all stages and update their icons individually so the UI shows
        // ✓/✗ per subagent as they complete, instead of spinning until
        // the entire spawn_parallel returns.
        var incomingStages = Array.isArray(rawInput.stages) ? rawInput.stages : null;
        if (incomingStages && incomingStages.length > 0) {
          // Merge the rawInput into the crew's _rawInput first.
          el._rawInput = Object.assign({}, el._rawInput || {}, { stages: incomingStages });
          var stageEls = el.querySelectorAll(':scope > .tc-stages > .tc-stage');
          for (var se = 0; se < stageEls.length && se < incomingStages.length; se++) {
            var stg = incomingStages[se];
            if (stg && typeof stg === 'object' && stg.status) {
              applyStageIcon(stageEls[se], stg.status);
            }
          }
          // Update parent icon: if all stages are terminal, flip parent.
          var allDone = true;
          for (var si = 0; si < stageEls.length; si++) {
            var icn = stageEls[si].querySelector('.tc-stage-icon');
            if (icn && !icn.classList.contains('completed') && !icn.classList.contains('failed') && !icn.classList.contains('error')) {
              allDone = false;
              break;
            }
          }
          if (allDone) {
            var parentIc = el.querySelector(':scope > .tc-icon');
            if (parentIc) {
              var anyFailed = el.querySelector('.tc-stage-icon.failed, .tc-stage-icon.error');
              var pStatus = anyFailed ? 'failed' : 'completed';
              parentIc.className = 'tc-icon ' + pStatus;
              parentIc.textContent = getStatusIcon(pStatus);
            }
          }
        } else {
          // No per-stage status: merge late rawInput into the matching stage.
          var stageOnCrew = el.querySelector('.tc-stage[data-tool-call-id="' + String(toolCallId).replace(/"/g, '') + '"]') ||
            el.querySelector(':scope > .tc-stages > .tc-stage');
          if (stageOnCrew) updateStageFromRawInput(stageOnCrew, rawInput, title, { keepName: true });
          else {
            el._rawInput = Object.assign({}, el._rawInput || {}, rawInput);
          }
        }
       } else {
         el._rawInput = rawInput;
         if (!el.dataset.tcTooltip) attachToolCallTooltip(el);
       }
     }

     // Inline style (turn-based)
      const iconEl = el.querySelector(':scope > .tc-icon') || el.querySelector('.tc-icon');
      if (iconEl) {
        // Crew parent: keep "spawned N subagents" title; only flip icon when
        // the turn is done (or a real failure). Mid-turn "completed" from
        // Claude Agent Task means spawned, not finished.
        if (el.getAttribute('data-subagent-crew') || el.getAttribute('data-claude-crew') || el.querySelector(':scope > .tc-stages')) {
          if (status === 'failed' || status === 'error') {
            setSubagentStageStatus(toolCallId, status);
          } else if (status === 'completed' && !(isProcessing && !isLoadingSession)) {
            setSubagentStageStatus(toolCallId, status);
          }
          return;
        }
        if (status) {
          // Cursor keeps emitting status:"pending" on late tool_call_update
          // after we've already marked the row completed — don't re-spin.
          var _iconTerminal = iconEl.classList.contains('completed') ||
            iconEl.classList.contains('failed') || iconEl.classList.contains('error');
          var _statusRunning = status === 'pending' || status === 'running' || status === 'in_progress';
          if (!(_iconTerminal && _statusRunning)) {
            iconEl.className = 'tc-icon ' + status;
            iconEl.textContent = getStatusIcon(status);
          }
        }
        var titleEl = el.querySelector('.tc-title');
        if (titleEl && (title || rawInput)) {
          var elRawInput = rawInput || el._rawInput;
          var dt = resolveToolCallDisplayTitle(title || el._toolTitle, elRawInput, el._locations, el.dataset.toolKind || null);
          syncToolKindDataset(el, elRawInput, dt, el.dataset.toolKind || null);
          if (isSubagentToolCall(title || el._toolTitle, el.dataset.toolKind || null, elRawInput)) {
            var sn = getSubagentSpawnCount(title || el._toolTitle, elRawInput);
            if (isSubagentSpawnTitle(title || el._toolTitle, elRawInput) && sn > 0) {
              var taskDesc2 = (elRawInput && (elRawInput.task || elRawInput.prompt || elRawInput.description)) || '';
              if (Array.isArray(elRawInput && elRawInput.stages) && elRawInput.stages.length > 0) {
                dt = 'spawned ' + sn + ' subagent' + (sn > 1 ? 's' : '');
              } else if (typeof taskDesc2 === 'string' && taskDesc2.length > 0) {
                dt = taskDesc2.length > 80 ? taskDesc2.substring(0, 77) + '...' : taskDesc2;
              } else {
                dt = 'spawned ' + sn + ' subagent' + (sn > 1 ? 's' : '');
              }
            }
          }
          titleEl.textContent = dt;
          el._toolTitle = dt;
          syncToolTitleToTurnSummaries(toolCallId, dt, elRawInput);
        } else if (title || rawInput) {
          syncToolTitleToTurnSummaries(
            toolCallId,
            resolveToolCallDisplayTitle(title || el._toolTitle, rawInput || el._rawInput, el._locations, el.dataset.toolKind || null),
            rawInput || el._rawInput
          );
        }
        return;
      }
      // Legacy card style fallback
      const badge = el.querySelector('.status-badge');
      if (badge && status) {
        badge.className = 'status-badge ' + status;
        badge.textContent = status;
      }
      if (title) {
        const titleEl = el.querySelector('.title');
        if (titleEl) titleEl.textContent = cleanMultiLineTitle(title);
      }
    }

    function addPlan(plan) {
      // Update the last plan in history if it exists, otherwise add new
      const lastPlanIdx = chatHistory.length - 1 >= 0 ? chatHistory.findLastIndex(i => i.kind === 'plan') : -1;
      if (lastPlanIdx >= 0) {
        chatHistory[lastPlanIdx].plan = plan;
      } else {
        chatHistory.push({ kind: 'plan', plan: plan });
      }
      saveState();
      updatePlanDOM(plan);
    }

   let currentPlanEl = null;
   function updatePlanDOM(plan) {
     hideEmpty();
     if (!currentPlanEl) {
       currentPlanEl = document.createElement('div');
       currentPlanEl.className = 'plan';
       planBar.appendChild(currentPlanEl);
     }
      let html = '<div class="plan-title">Plan</div>';
      if (plan.entries) {
        for (const entry of plan.entries) {
          const icon = entry.status === 'completed' ? '✅'
            : entry.status === 'in_progress' ? '🔄' : '⬜';
          const cls = entry.status === 'completed' ? ' completed' : '';
          html += '<div class="plan-entry' + cls + '">'
            + icon + ' ' + escapeHtml(entry.title || entry.description || entry.content || '')
            + '</div>';
        }
      }
     currentPlanEl.innerHTML = html;
     autoScrollIfAtBottom();
   }

   function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

   function finalizeThought() {
     if (!currentThoughtEl) return;
     if (thoughtEndTime) return; // already finalized
     thoughtEndTime = Date.now();
     currentThoughtEl.classList.remove('streaming');
     const elapsed = thoughtStartTime ? Math.round((thoughtEndTime - thoughtStartTime) / 1000) : 0;
      vscode.postMessage({ type: 'debugLog', message: '[WV-THOUGHT] finalizeThought: thoughtStartTime=' + thoughtStartTime + ' thoughtEndTime=' + thoughtEndTime + ' elapsed=' + elapsed + ' textLen=' + currentThoughtText.length });
     const summary = currentThoughtEl.querySelector('summary');
     if (summary) {
        // Always show the duration — even sub-second thinking shows "Thought for <1s"
        // rather than just "Thought" which looks like the block was never finalized.
        if (thoughtStartTime) {
          summary.innerHTML = elapsed > 0
            ? 'Thought for ' + elapsed + 's'
            : 'Thought for &lt;1s';
        } else {
          summary.innerHTML = 'Thought';
        }
     }
   }

    /**
     * Commit the in-progress assistant turn to chatHistory (without firing
     * the live promptEnd markdown-render request — replay does that
     * batched at loadSessionEnd). Resets all per-turn DOM/state pointers so
     * the next turn starts fresh.
     */
    /**
     * Adopt a reply chunk that arrived just after the replay ended.
     *
     * renderChatHistory clears currentTurnEl, so an accepted straggler would
     * start a brand-new turn at the bottom of the panel. Point it at the turn
     * the replay just finished instead, then commit + re-promote on a short
     * debounce (there is no promptEnd coming to do either).
     */
    function adoptLoadTailChunk(len) {
      if (!currentTurnEl) {
        var _turns = messagesEl.querySelectorAll('.turn');
        if (_turns.length) currentTurnEl = _turns[_turns.length - 1];
      }
      vscode.postMessage({ type: 'debugLog', message:
        '[WV-LOAD-TAIL] adopted straggler reply chunk after replay (len=' + len +
        ', turn=' + (currentTurnEl && currentTurnEl.dataset ? (currentTurnEl.dataset.historyIndex ?? '?') : 'none') + ')' });
      if (_loadTailCommitTimer) clearTimeout(_loadTailCommitTimer);
      _loadTailCommitTimer = setTimeout(function() {
        _loadTailCommitTimer = null;
        var _turn = currentTurnEl;
        finalizeCurrentAssistantTurn();
        if (_turn && compactMode) {
          ensureTurnFoldStructure(_turn, true);
          promoteFinalAssistantForTurn(_turn);
        }
        saveState();
        vscode.postMessage({ type: 'debugLog', message:
          '[WV-LOAD-TAIL] committed straggler reply, chatHistoryLen=' + chatHistory.length });
      }, 300);
    }

    function finalizeCurrentAssistantTurn() {
      if (currentThoughtEl || currentThoughtText || thoughtDomBase) {
        commitOrDiscardCurrentThought();
      }
    if (currentAssistantText) {
      // Dedup guard: skip pushing a duplicate assistant message. After a
      // full-snapshot merge (handleLoadSessionEnd), currentAssistantText
      // holds text that was replayed via agent_message_chunk during
      // session/load — but that text is ALREADY present in the snapshot that
      // became chatHistory. Check the last few assistant entries (not just
      // the very last history item, which may be a tool_call after a merge).
      var _last = chatHistory[chatHistory.length - 1];
      var _alreadyExists = false;
      if (_last && _last.kind === 'message' && _last.role === 'assistant' && _last.text === currentAssistantText) {
        _alreadyExists = true;
      }
      if (!_alreadyExists) {
        // Scan backward through the most recent assistant messages for a match.
        // The full-snapshot merge can leave trailing tool_calls between the
        // last assistant and the finalize call, so a single-entry check misses.
        var _scanLimit = Math.min(chatHistory.length, 15);
        for (var _si = chatHistory.length - 1; _si >= chatHistory.length - _scanLimit; _si--) {
          var _se = chatHistory[_si];
          if (!_se) continue;
          if (_se.kind === 'message' && _se.role === 'assistant' && _se.text === currentAssistantText) {
            _alreadyExists = true;
            break;
          }
        }
      }
      if (_alreadyExists) {
        vscode.postMessage({ type: 'debugLog', message: '[WV-DEDUP] finalizeCurrentAssistantTurn: skipping duplicate assistant push (textLen=' + currentAssistantText.length + ')' });
      } else {
      chatHistory.push({ kind: 'message', role: 'assistant', text: currentAssistantText });
       saveState();
       }
     }
      currentAssistantEl = null;
      currentAssistantText = '';
      currentTurnEl = null;
      currentToolsListEl = null;
      currentToolsCountEl = null;
      currentToolCount = 0;
      currentThoughtEl = null;
      currentThoughtTextEl = null;
      currentThoughtText = '';
      thoughtDomBase = '';
      thoughtStartTime = null;
      thoughtEndTime = null;
    }

  function addThoughtDOM(text, durationSec, historyIndex) {
    hideEmpty();
    const el = document.createElement('details');
    el.className = 'thought-block';
    if (typeof historyIndex === 'number') {
      el._historyIndex = historyIndex;
      el.setAttribute('data-history-index', String(historyIndex));
    }
    el._thoughtCommitted = true;
   el.innerHTML =
       '<summary>' + (durationSec > 0 ? 'Thought for ' + durationSec + 's' : (durationSec === 0 ? 'Thought for &lt;1s' : 'Thought')) + '</summary>' +
      '<div class="thought-content">' + escapeHtml(text.trim().replace(/\\n{3,}/g, '\\n\\n')) + '</div>';
   attachThoughtExpandTracker(el);
   // Attach into the current turn so the thought groups with its assistant
   // response (matching the live-streaming layout). During replay the chatHistory
   // order is user -> thought -> assistant, so the turn may not exist yet when
    // the thought is rendered; create it here and prepend the thought to the top.
    if (!currentTurnEl) {
      currentTurnEl = document.createElement('div');
      currentTurnEl.className = 'turn';
      messagesEl.appendChild(currentTurnEl);
      hideEmpty();
      trace('    addThoughtDOM: created new turn, prepended thought');
    } else {
      trace('    addThoughtDOM: reusing existing turn (children=' + currentTurnEl.children.length + '), prepended thought to top');
    }
    placeThoughtInTurn(el);
    scrollToBottom();
  }

  function showSessionConnected(session) {
   if (!isLoadingSession) {
     resetResumeConnectUi();
   }
   // If a load overlay is still visible (e.g. stale session was
   // replaced by a new session), dismiss it now as a safety net.
   if (isLoadingSession) {
     isLoadingSession = false;
     if (loadOverlay) loadOverlay.classList.remove('visible');
     if (inputArea) inputArea.classList.remove('disabled');
   }
  hasActiveSession = true;
  hasSentPrompt = false;
  hasSteeredThisTurn = false;
  isSendingPrompt = false;
  // Capture the session ID that was active BEFORE this switch so
   // handleLoadSessionStart can label its chatHistory snapshot correctly.
   // sessionState is overwritten below, so we must grab the old value first.
   previousSessionId = (sessionState && sessionState.sessionId) || null;
   // If this is a brand-new session (e.g. temp session from connectToAgent),
   // the chatHistory hasn't changed — it still belongs to the previous
   // chatHistoryOriginSessionId (likely from restoreState). Don't overwrite
   // chatHistoryOriginSessionId here; it's only updated when chatHistory is
   // actually cleared/rebuilt (in handleLoadSessionEnd or clearChat).
sessionState = {
  sessionId: session.sessionId,
  agentName: session.agentName,
  agentConfigKey: session.agentConfigKey,
 cwd: session.cwd,
   gitBranch: session.gitBranch || null,
   title: cleanUserMessage(session.title || '') || undefined,
   promptCapabilities: session.promptCapabilities,
    currentModelImageSupport: session.currentModelImageSupport,
    modelImageMap: session.modelImageMap || {},
  };
  lastConnectedAgent = session.agentConfigKey || session.agentName;
  lastConnectedAgentDisplay = session.agentName;
  if (!isLoadingSession && !resumeConnectInFlight) {
    lastConnectedSessionId = session.sessionId || null;
  }
  if (resumeBar) resumeBar.style.display = 'none';
  updateWelcomeButton();
  saveState();
     showSessionConnectedFromState(sessionState);
      // Don't show the token usage ring with size:0 — it displays "0%"
      // which is meaningless. Wait for real usage data from the agent
      // (usage_update for Codex, _kiro.dev/metadata for Kiro CLI).

     // Prefer ACP "Session Config Options" when provided. Spec: clients
      // that support configOptions MUST use them exclusively and ignore
      // the legacy modes field.
      const cfg = session.configOptions;
      if (Array.isArray(cfg) && cfg.length > 0) {
        setConfigOptionsState(cfg);
      } else {
        setConfigOptionsState([]);
        if (session.modes) updateModePicker(session.modes);
        if (session.models) updateModelPicker(session.models);
      }
     // Restore available commands
     if (session.availableCommands) {
       availableCommands = session.availableCommands;
     }
    // Show/hide image attach button based on agent's promptCapabilities.image
    updateAttachButtonVisibility(session.promptCapabilities, session.currentModelImageSupport);
    updatePlaceholder();
    wvProbe('showSessionConnected END', 'sessionId=' + session.sessionId + ' agent=' + session.agentName);
  }

  function showSessionConnectedFromState(ss) {
 hasActiveSession = true;
 hideEmpty();
 if (resumeBar) resumeBar.style.display = 'none';
  if (bannerAgent) {
    var _ssTitle = cleanUserMessage(ss.title || '') || ss.agentName || 'Agent';
    bannerAgent.textContent = truncateForBanner(_ssTitle);
    bannerAgent.title = _ssTitle;
 }
   if (bannerCwd) {
     var _cwdText = ss.cwd || '';
     if (ss.gitBranch) {
       bannerCwd.innerHTML = escapeHtml(_cwdText) + ' <span class="git-branch">⎇ ' + escapeHtml(ss.gitBranch) + '</span>';
     } else {
       bannerCwd.textContent = _cwdText;
     }
   }
     if (sessionBanner) sessionBanner.classList.add('visible');
      if (inputArea) inputArea.classList.remove('disabled');
      promptInput.disabled = false;
      updateSendButton();
    }

  function updateResumeBar() {
   if (!resumeBar) return;
   if (chatHistory.length > 0 && !hasActiveSession && lastConnectedAgent) {
     resumeBar.innerHTML = '';
     resumeBar.style.display = 'flex';
     var resumeBtn = document.createElement('button');
     resumeBtn.className = 'resume-btn';
     resumeBtn.innerHTML = '<span class="resume-icon">⟳</span> Resume ' + escapeHtml(lastConnectedAgentDisplay || lastConnectedAgent);
     resumeBtn.addEventListener('click', function() {
       requestResumeConnect();
     });
     resumeBar.appendChild(resumeBtn);
   } else {
     resumeBar.style.display = 'none';
   }
 }


   function showNoSession() {
     resetResumeConnectUi();
     if (isLoadingSession) return;
    hasActiveSession = false;
    hasSentPrompt = false;
    hasSteeredThisTurn = false;
    isSendingPrompt = false;
    sessionState = null;
     saveState();
      tokenUsage = null;
      if (tokenUsageRing) tokenUsageRing.classList.remove('visible');
      if (sessionBanner) sessionBanner.classList.remove('visible');
    if (emptyState) { emptyState.style.display = (chatHistory.length > 0) ? 'none' : ''; if (emptyState.style.display !== 'none' && !emptyState.parentNode) messagesEl.appendChild(emptyState); }
    if (inputArea) inputArea.classList.add('disabled');
    updateWelcomeButton();
    updateResumeBar();
      // Keep textarea editable so user can type; Send is disabled via .disabled CSS
      promptInput.disabled = false;
     // Hide pickers when disconnected
     modePickerWrap.classList.add('hidden');
     modelPickerWrap.classList.add('hidden');
     setConfigOptionsState([]);
    // Hide image attach button when no active session
    if (attachBtn) attachBtn.style.display = 'none';
  }

  /**
   * Show/hide the image attach button based on:
   * 1. Agent-level promptCapabilities.image (must be true)
   * 2. Per-model capability from ~/.codex catalogs (input_modalities):
   *    - explicitly includes "image" → show
   *    - text-only / missing / unknown model → hide
   * 3. Kiro CLI: Claude model names only
   */

function updateAttachButtonVisibility(promptCaps, modelImageSupport) {
   if (!attachBtn) { return; }
   const caps = promptCaps || (sessionState && sessionState.promptCapabilities) || null;
   // [WV-DIAG] Trace the attach-button decision inputs so we can see why a
   // non-vision model (e.g. deepseek-v4-flash) still shows the image button.
   // Logs agentName, currentModelId, caps.image, and the effective modelImageSupport.
   if (typeof vscode !== 'undefined' && typeof vscode.postMessage === 'function') {
     var _diagAgent = sessionState && sessionState.agentName ? sessionState.agentName : '';
     var _diagCaps = caps ? (caps.image ? 'image=true' : 'image=false') : 'caps=null';
     var _diagMIS = (modelImageSupport === undefined || modelImageSupport === null)
       ? (sessionState && sessionState.currentModelImageSupport !== undefined ? String(sessionState.currentModelImageSupport) : 'undef')
       : String(modelImageSupport);
     vscode.postMessage({ type: 'debugLog', message: '[WV-DIAG] attachBtn: agent="' + _diagAgent + '" model="' + (currentModelId || 'null') + '" ' + _diagCaps + ' mis=' + _diagMIS });
   }
   if (!caps || !caps.image) {
     attachBtn.style.display = 'none';
     return;
   }
   // For Kiro CLI, determine image support from model name — no catalog.
   var agentName = sessionState && sessionState.agentName ? sessionState.agentName : '';
   if (agentName && /kiro/i.test(agentName)) {
     // If no model is set yet (e.g. during a session switch, before the model
     // picker is populated), default to HIDDEN — never fall through to a stale
     // sessionState.currentModelImageSupport from a previous agent (a switch
     // from a Claude/Opus Kiro session would otherwise keep the image button
     // visible on a text-only model).
     var kiroBase = (currentModelId || '').replace(/\\[(?:low|medium|high|xhigh|max|none)\\]$/, '');
     attachBtn.style.display = kiroBase && /claude/i.test(kiroBase) ? '' : 'none';
     return;
   }
   // Codex / catalog-backed: only show when the catalog explicitly allows image.
   if (modelImageSupport === true || modelImageSupport === false) {
     attachBtn.style.display = modelImageSupport ? '' : 'none';
     return;
   }
   if (sessionState && (sessionState.currentModelImageSupport === true || sessionState.currentModelImageSupport === false)) {
     attachBtn.style.display = sessionState.currentModelImageSupport ? '' : 'none';
     return;
   }
   if (currentModelId && sessionState && sessionState.modelImageMap) {
    var modelBase = currentModelId.replace(/\\[(?:low|medium|high|xhigh|max|none)\\]$/, '');
     if (Object.prototype.hasOwnProperty.call(sessionState.modelImageMap, modelBase)) {
       attachBtn.style.display = sessionState.modelImageMap[modelBase] ? '' : 'none';
       return;
     }
   }
   // Not clarified in catalog → do not show upload.
   attachBtn.style.display = 'none';
 }

   // Handle messages from the extension
   window.addEventListener('message', (event) => {
      const msg = event.data;
      // TEMP-DEBUG: trace EVERY inbound message (type + key fields) so the
      // frame-by-frame order is visible in the repro (state / promptStart /
      // promptEnd / sessionUpdate ordering around the latch). Forwarded to the
      // ACP Client log only while DEBUG_LIVE is on (host-side hub gate).
      var _wvMsgType = msg && msg.type ? String(msg.type) : '(none)';
      var _wvMsgBrief = '';
      if (msg && typeof msg === 'object') {
        if (_wvMsgType === 'state') {
          _wvMsgBrief = ' isPromptInFlight=' + !!msg.isPromptInFlight + ' activeSessionId=' + (msg.activeSessionId || '') +
            ' sessionId=' + (msg.session && msg.session.sessionId ? msg.session.sessionId : '') +
            ' agent=' + (msg.session && msg.session.agentName ? msg.session.agentName : '');
        } else if (_wvMsgType === 'promptStart') {
          _wvMsgBrief = ' sessionId=' + (msg.sessionId || '');
        } else if (_wvMsgType === 'promptEnd') {
          _wvMsgBrief = ' sessionId=' + (msg.sessionId || '') + ' stopReason=' + (msg.stopReason || '');
        } else if (_wvMsgType === 'sessionUpdate') {
          var _wvU = msg.update || {};
          _wvMsgBrief = ' sessId=' + (msg.sessionId || '') + ' type=' + (_wvU.sessionUpdate || '') +
            ' preview=' + (_wvU.content && _wvU.content.text ? String(_wvU.content.text).replace(/\\s+/g, ' ').slice(0, 40) : '');
        } else if (_wvMsgType === 'loadSessionEnd') {
          _wvMsgBrief = ' ok=' + !!msg.ok;
        } else if (_wvMsgType === 'loadSessionStart') {
          _wvMsgBrief = '';
        } else if (_wvMsgType === 'kiroMetadata') {
          _wvMsgBrief = ' effort=' + (msg.params && msg.params.effort) + ' ctx=' + (msg.params && msg.params.contextUsagePercentage);
        } else if (_wvMsgType === 'kiroCompactionStatus' || _wvMsgType === 'kiroClearStatus') {
          _wvMsgBrief = ' msg=' + ((msg.params && msg.params.message) || '') + ' type=' + ((msg.params && msg.params.type) || '');
        } else if (_wvMsgType === 'state' || _wvMsgType === 'sendPrompt' || _wvMsgType === 'cancelTurn') {
          // no extra
        }
      }
      vscode.postMessage({ type: 'debugLog', message: '[WV-MSG] type=' + _wvMsgType + _wvMsgBrief + ' | isProcessing=' + isProcessing + ' isSendingPrompt=' + isSendingPrompt + ' isLoadingSession=' + isLoadingSession });
      // Liveness for the turn indicator: any agent-originated frame resets the
      // idle figure. Client-side chatter (debug logs, state echoes) must not, or
      // a silent model call would look busy.
      if (typeof noteAgentActivity === 'function' &&
          _wvMsgType !== 'debugLog' && _wvMsgType !== 'state' && _wvMsgType !== 'debugResume') {
        noteAgentActivity();
      }
      switch (msg.type) {
       case 'debugResume':
         DEBUG_RESUME = !!msg.enabled;
         break;
       case 'state':
         if (typeof msg.autoSteerQueued === 'boolean') autoSteerQueuedEnabled = msg.autoSteerQueued;
         // Update last-connected agent from extension host (workspaceState
         // persists across restarts, unlike webview getState).
        if (msg.lastAgent) {
          lastConnectedAgent = msg.lastAgent;
          lastConnectedAgentDisplay = msg.lastAgentDisplay || msg.lastAgent;
          if (!isLoadingSession && !resumeConnectInFlight) {
            lastConnectedSessionId = msg.lastSessionId || null;
          }
        } else {
          // Extension host cleared the last-connected agent (e.g. after
          // deleting the active session). Clear webview-side state too so
          // the welcome button reverts to "Connect to Agent".
          lastConnectedAgent = null;
          lastConnectedAgentDisplay = null;
          lastConnectedSessionId = null;
        }
       if (msg.session) {
         showSessionConnected(msg.session);
         // Restore goal snapshot from session state (if any)
         goalSnapshot = msg.session.goalSnapshot || null;
         renderGoalChip();
       } else {
         showNoSession();
         goalSnapshot = null;
         renderGoalChip();
       }
        updateWelcomeButton();
         setFollowingUI(!!msg.isFollowing);
         // Restore processing state if the agent is mid-turn. The webview's
         // module-level isProcessing resets to false on dispose/recreate
         // (e.g. switching to Copilot Chat and back), so we must re-establish
         // it here to keep the Stop button active while streaming continues.
         if (msg.isPromptInFlight) {
           setProcessing(true, 'state-msg-isPromptInFlight');
           vscode.postMessage({ type: 'debugLog', message: '[WV-STATE] isPromptInFlight=true → setProcessing(true) from state msg' });
           // Possible stale flag: if nothing is actually in flight from the
           // webview's perspective (no send pending, no user prompt sent in
           // this session, nothing streaming), this latch may come from a
           // transient host-side in-flight hold (Kiro resume restoreConfig /
           // slash). Arm a short watchdog: clear it unless a real turn shows
           // up. Genuine mid-turn resumes keep producing agent chunks or an
           // early promptStart, so they clear the watchdog naturally.
           if (!isSendingPrompt && !hasSentPrompt && !isLoadingSession && !messageQueue.length &&
               !currentAssistantText && !currentThoughtText) {
             if (_pendingStaleInFlightWatchdogTimer) { clearTimeout(_pendingStaleInFlightWatchdogTimer); }
             var _watchStart = Date.now();
             _pendingStaleInFlightWatchdogTimer = setTimeout(function() {
               _pendingStaleInFlightWatchdogTimer = null;
               vscode.postMessage({ type: 'debugLog', message: '[WV-STALE-WATCHDOG] no turn activity within ' + (Date.now() - _watchStart) + 'ms after state.isPromptInFlight latch — clearing stale isProcessing' });
               setProcessing(false, 'stale-inflight-watchdog');
             }, STALE_INFLIGHT_WATCHDOG_MS);
           }
         } else {
           vscode.postMessage({ type: 'debugLog', message: '[WV-STATE] isPromptInFlight=false (no setProcessing)' });
         }
         break;

        case 'followStateChanged':
          setFollowingUI(!!msg.isFollowing);
          break;

        case 'voiceState':
          setVoiceState(msg.state);
          break;

        case 'voiceTranscript':
          insertVoiceTranscript(typeof msg.text === 'string' ? msg.text : '', msg.autoSend === true);
          break;

        case 'voiceError':
          setVoiceState('idle');
          addMessage('system', '⚠️ ' + (typeof msg.message === 'string' ? msg.message : 'Voice input failed'));
          break;

        case 'voiceEnabled':
          // acp.voice.enabled toggled in Settings — show/hide the mic live.
          if (micBtn) micBtn.style.display = msg.enabled === false ? 'none' : '';
          break;

      // Host-initiated prompt (fork-to-agent). dispatchPrompt() posts the
      // exported conversation text here; before this case existed the
      // inbound switch had no 'sendPrompt' handler, so the entire fork
      // export was silently dropped (no user bubble, no session/prompt) —
      // every forkToAgent appeared to do nothing. Route through the same
      // path a typed+Enter send uses: drop the text into the input and let
      // handleSend() post it to the host (preserving queueing, compaction
      // guards, and the user bubble).
      case 'sendPrompt':
        if (typeof msg.text === 'string' && msg.text.length > 0) {
          // Host-dispatched prompt (fork-to-agent). The host tells us whether a
          // session exists, because handleSend() bails on !hasActiveSession
          // without consuming the input — which left the forked summary in the
          // composer awaiting a manual Send. The webview's own flag comes from a
          // state message that races this dispatch.
          if (msg.hasActiveSession === true) {
            hasActiveSession = true;
          }
          // Trace the guard inputs: if a dispatched prompt still does not send,
          // this names which handleSend() guard swallowed it.
          resumeDiag('[WV-DIAG] dispatchPrompt: len=' + msg.text.length +
            ' hideBubble=' + (msg.hideBubble === true) +
            ' hasActiveSession=' + hasActiveSession +
            ' isProcessing=' + isProcessing +
            ' isSendingPrompt=' + isSendingPrompt +
            ' isLoadingSession=' + isLoadingSession +
            ' isCompacting=' + isCompacting +
            ' isClearing=' + isClearing);
          promptInput.value = msg.text;
          // Fork-to-agent can ask to hide the summary bubble (the summary is
          // still sent to the agent for context, just not rendered in the
          // panel). handleSend() checks suppressNextUserBubble and skips the
          // visible bubble for this one send.
          suppressNextUserBubble = msg.hideBubble === true;
          handleSend();
        }
        break;

      // Host-initiated user bubble render. The extension host posts this
      // after it sends a prompt to the agent, so the user message ALWAYS
      // appears in the panel even when the webview-side send path skipped it
      // (e.g. a prompt sent while isLoadingSession is true — resume still
      // replaying — where handleSend() did not run and no bubble was added).
      // Dedup: skip if the last chatHistory user message already matches, so
      // a normal handleSend() path (which already added the bubble) does not
      // get a duplicate.
      case 'userBubble':
        if (typeof msg.text === 'string') {
          var _ubText = msg.text || '(image)';
          // Skip whitespace-only text — the extension host sends ' ' for
          // image-only prompts (webview handleSend posts text || ' '), which
          // would render an empty user bubble. Treat whitespace-only like
          // empty.
          if (!_ubText || !_ubText.trim()) break;
          // Dedup against the MOST RECENT USER message, not just the last
          // chatHistory item. After a normal turn completes the last item is
          // the assistant reply, so checking chatHistory[last] would never
          // match and would re-add the user bubble for EVERY prompt sent via
          // the extension-host path (the "prompt replayed after end_turn"
          // bug). Search backward past assistant/tool rows for the most
          // recent user message and skip if it already matches.
          var _ubDup = false;
          for (var _ubi = chatHistory.length - 1; _ubi >= 0; _ubi--) {
            var _ubItem = chatHistory[_ubi];
            if (!_ubItem || _ubItem.kind !== 'message') continue;
            if (_ubItem.role === 'user') {
              _ubDup = String(_ubItem.text || '') === String(_ubText);
              break;
            }
            // Skip assistant / system / error rows — keep scanning for the
            // user message that started this turn.
          }
          if (!_ubDup) {
            addMessage('user', _ubText);
          }
        }
        break;

      case 'promptStart':
       // The turn has actually started — the drain/Send-Now sendPrompt is now
       // in-flight and new input may proceed normally (will be queued because
       // isProcessing=true, or sent once the turn finishes).
       if (_pendingStaleInFlightWatchdogTimer) { clearTimeout(_pendingStaleInFlightWatchdogTimer); _pendingStaleInFlightWatchdogTimer = null; }
       isSendingPrompt = false;
       setProcessing(true, 'promptStart');
       isForceCancelled = false;
       suppressInterruptNotice = false;
       // New turn — remove any lingering "— Conversation interrupted —"
       // notice from the previous cancelled turn (DOM + chatHistory) so it
       // doesn't persist once the user sends a follow-up.
       if (interruptedNoticeEl && interruptedNoticeEl.parentNode) {
         interruptedNoticeEl.parentNode.removeChild(interruptedNoticeEl);
       }
       interruptedNoticeEl = null;
       // Also scan chatHistory for BOTH the user-role "[Request interrupted by
       // user]" (Claude/adapters) AND the system-role "— Conversation
       // interrupted —" (this extension's addMessage('system', ...)) notices.
       // The system-role one was previously missed, so it lingered until the
       // next promptStart.
       for (var _intI = chatHistory.length - 1; _intI >= 0; _intI--) {
         var _intItem = chatHistory[_intI];
         if (_intItem && _intItem.kind === 'message' &&
             (_intItem.role === 'user' || _intItem.role === 'system') &&
             isSessionInterruptNotice(_intItem.text)) {
           chatHistory.splice(_intI, 1);
         }
       }
       interruptedNoticeHistoryIdx = -1;
       // Chat history is being built for the current session.
       chatHistoryOriginSessionId = (sessionState && sessionState.sessionId) || null;
       cancelProvisionalSummaryPromote();
        // Previous turn's Kiro/Claude stages may still be spinning after a
        // reload or missed terminate — mark them failed before new spawns.
        failRunningSubagentStagesInDom();
        resetClaudeCrewState();
        // Remove orphaned assistant elements from slash command responses
        // (e.g. /effort, /model) that were streamed to DOM but never committed
        // to chatHistory. Without this, allAssistant.length > chatHistory
        // assistant count, causing markdownRendered to target the wrong element.
        if (currentAssistantEl && currentAssistantText && !currentAssistantEl.classList.contains('md-committed')) {
          if (currentAssistantEl.parentNode) {
            currentAssistantEl.parentNode.removeChild(currentAssistantEl);
          }
          if (currentTurnEl && currentTurnEl.children.length === 0) {
            if (currentTurnEl.parentNode) {
              currentTurnEl.parentNode.removeChild(currentTurnEl);
            }
          }
        }
        currentAssistantEl = null;
         currentAssistantText = '';
       // New turn — clear messageId grouping state so a chunk from THIS turn
       // never reattaches to a bubble committed in the PRIOR turn.
       // Also close the turn-tail grace window: a new promptStart means the
       // agent began a fresh turn, so late chunks from the previous turn must
       // no longer be accepted.
       turnTailGraceUntil = 0;
       // A new turn: the plan handoff offer belongs to the turn that produced the
       // plan, so drop both the flag and any row still on screen.
       sawPlanThisTurn = false;
       clearImplementPlanRow();
       // Same for the replay-tail window: a fresh turn means anything still
       // arriving belongs to THIS turn, not to the resumed transcript.
       loadTailGraceUntil = 0;
       if (_loadTailCommitTimer) { clearTimeout(_loadTailCommitTimer); _loadTailCommitTimer = null; }
       currentMessageId = null;
         lastCommittedAssistantEl = null;
         lastCommittedMessageId = null;
         lastCommittedText = '';
         reactivatedHistoryIndex = -1;
         // Fresh synthetic id per turn for agents without real messageIds.
        fallbackMessageId = 'turn-' + (Date.now().toString(36)) + '-' + (Math.random().toString(36).slice(2, 8));
        sawRealMessageIdThisTurn = false;
        messageSegmentCounter = 0;
        currentTurnEl = null;
        currentThoughtText = '';
        thoughtDomBase = '';
        thoughtStartTime = null;
        thoughtEndTime = null;
        lastRenderTime = 0;
        currentPlanEl = null;
        if (planBar) { planBar.innerHTML = ''; }
        if (typeof clearCursorTodosPlan === 'function') clearCursorTodosPlan();
        break;

     case 'promptEnd':
     if (_pendingStaleInFlightWatchdogTimer) { clearTimeout(_pendingStaleInFlightWatchdogTimer); _pendingStaleInFlightWatchdogTimer = null; }
     // Stale promptEnd guard: the extension host can resolve a torn-down
     // session's in-flight prompt AFTER the user started a new conversation
     // (disconnectAgent cancels the prompt, but the continuation races the
     // teardown). If promptEnd carries a sessionId that no longer matches the
     // currently displayed session (or the session was cleared), ignore it —
     // otherwise the "— Conversation interrupted —" notice leaks into the
     // NEW session's panel.
     if (msg.sessionId && (!sessionState || msg.sessionId !== sessionState.sessionId)) {
       vscode.postMessage({ type: 'debugLog', message: '[WV-PROMPTEND] stale promptEnd for session ' + msg.sessionId + ' (current=' + (sessionState ? sessionState.sessionId : 'none') + '), ignoring' });
       break;
     }
     if (cursorCompactionTraceEnabled() && isCursorAgentSession()) {
       resumeDiag('[CURSOR-ACP-WV] kind=promptEnd stopReason=' + (msg.stopReason || '') +
         ' isCompacting=' + isCompacting + ' manual=' + manualCompacting);
     }
     vscode.postMessage({ type: 'debugLog', message: '[WV-PROMPTEND] promptEnd received. chatHistoryLen=' + chatHistory.length + ' currentAssistantTextLen=' + currentAssistantText.length + ' hasCurrentAssistantEl=' + !!currentAssistantEl });
      if (msg.goalSnapshot !== undefined) {
        goalSnapshot = msg.goalSnapshot;
        renderGoalChip();
      }
      // Capture whether this promptEnd is for a compaction cycle — if so,
      // the turn is NOT actually finished (auto-compact resumes the same
      // turn) and we must NOT drain the message queue.
     var _wasCompacting = isCompacting;
     vscode.postMessage({ type: 'debugLog', message: '[DRAIN-DBG] promptEnd: stopReason=' + msg.stopReason + ' isCompacting=' + isCompacting + ' isProcessing=' + isProcessing + ' isLoadingSession=' + isLoadingSession + ' messageQueue.length=' + messageQueue.length + ' pendingSendAfterCancel=' + !!pendingSendAfterCancel + ' hasSteeredThisTurn=' + hasSteeredThisTurn });
     cancelProvisionalSummaryPromote();
      // Compaction: clear when we already buffered a completion notice.
       // Claude ACP often finishes /compact with only usage_update + end_turn
       // (no "Compacting completed." text) — treat that silent promptEnd as success.
       // Codex/Kiro: keep waiting for contextCompaction / status / notice.
       if (isCompacting) {
         if (compactedWarningText || compactedNoticeText) {
           flushCompactionMessages();
         } else if (isClaudeAgent() || isPiAgent()) {
           compactedNoticeText = 'Compacting completed.';
           flushCompactionMessages();
         }
       }
          // Finalize thought block if present (DOM+buffers — don't drop on whitespace chunk)
          if (currentThoughtEl || currentThoughtText || thoughtDomBase) {
            commitOrDiscardCurrentThought();
          }
       // Interrupted turns: keep the partial reply inside the fold so resume
       // / restore do not promote it into the main chat.
       var _wasCancelled = msg.stopReason === 'cancelled';
       // ── Premature end_turn detection ──────────────────────────────────
       // When an agent sends end_turn but there are still in-flight (running/
       // pending/in_progress) tool calls, the turn likely ended prematurely
       // (observed with GLM/local backends — subagent results lost, empty
       // post-tool replies). Log a warning so the user knows work may be
       // incomplete, and keep the tool spinners visible (not auto-completed)
       // so the user can see which tools never finished.
       if (!_wasCancelled && !isLoadingSession && msg.stopReason === 'end_turn') {
         var _prematureCount = 0;
         for (var _pid in toolCalls) {
           var _pEl = toolCalls[_pid];
           if (_pEl) {
             var _pIcon = _pEl.querySelector(':scope > .tc-icon') || _pEl.querySelector('.tc-icon');
             if (_pIcon && (_pIcon.className.indexOf('running') >= 0 || _pIcon.className.indexOf('pending') >= 0 ||
                 _pIcon.className.indexOf('in_progress') >= 0)) {
               _prematureCount++;
             }
           }
         }
         if (_prematureCount > 0) {
           vscode.postMessage({ type: 'debugLog', message: '[WV-PREMATURE] end_turn received with ' + _prematureCount + ' tool(s) still in-flight — possible premature turn termination' });
         }
       }
       // During session/load replay, don't commit here — finalizeCurrentAssistantTurn
       // at loadSessionEnd handles the final push. Committing here AND there
       // creates duplicate chatHistory entries (same text pushed twice).
       if (!isLoadingSession) {
         commitCurrentTextSegment(_wasCancelled ? { interim: true, interrupted: true } : undefined);
       }
       // On cancel: mark in-flight tools failed (not completed). Codex was
        // marking them completed which made turnLooksInterrupted false and
        // promoted the partial assistant into the main chat on resume.
        // On normal end_turn: complete remaining spinners (Kiro crew, etc.).
        for (var _tcId in toolCalls) {
          var _tcEl = toolCalls[_tcId];
          if (_tcEl) {
            var _iconEl = _tcEl.querySelector(':scope > .tc-icon') || _tcEl.querySelector('.tc-icon');
            if (_iconEl && (_iconEl.className.indexOf('running') >= 0 || _iconEl.className.indexOf('pending') >= 0 ||
                _iconEl.className.indexOf('in_progress') >= 0)) {
              if (_wasCancelled) {
                _iconEl.className = 'tc-icon failed';
                _iconEl.textContent = getStatusIcon('failed');
              } else {
                _iconEl.className = 'tc-icon completed';
                _iconEl.textContent = getStatusIcon('completed');
              }
            }
            var _stages = _tcEl.querySelectorAll('.tc-stage');
            for (var _si = 0; _si < _stages.length; _si++) {
              var _stIcon = _stages[_si].querySelector('.tc-stage-icon');
              if (_stIcon && (_stIcon.classList.contains('running') ||
                  _stIcon.classList.contains('in_progress') ||
                  _stIcon.classList.contains('pending'))) {
                applyStageIcon(_stages[_si], _wasCancelled ? 'failed' : 'completed');
              }
            }
          }
        }
        if (_wasCancelled) {
         markSessionInterrupted();
         // Mirror failed status into chatHistory so restore/load heuristics match.
         for (var _hi = 0; _hi < chatHistory.length; _hi++) {
           var _hItem = chatHistory[_hi];
           if (_hItem && _hItem.kind === 'toolCall' &&
               (_hItem.status === 'in_progress' || _hItem.status === 'running' || _hItem.status === 'pending')) {
             _hItem.status = 'failed';
           }
         }
         saveState();
         if (currentTurnEl) currentTurnEl.setAttribute('data-turn-interrupted', '1');
         // Cancelled turn: in-flight tools are now failed — refresh /ps so it
         // doesn't keep showing them as running.
         refreshPsPanelIfVisible();
       } else if (!isLoadingSession) {
         clearSessionInterrupted();
         // Mirror completed status into chatHistory so that re-renders
         // (auto-collapse, session switch, webview reload) don't bring back
         // spinning icons for tools that finished during the turn. Codex
         // never sends status:"completed" for individual tool calls — it
         // only sends "in_progress" then moves on, so without this sync
         // chatHistory retains "running" forever.
        for (var _hi2 = 0; _hi2 < chatHistory.length; _hi2++) {
          var _hItem2 = chatHistory[_hi2];
          if (_hItem2 && _hItem2.kind === 'toolCall' &&
              (_hItem2.status === 'in_progress' || _hItem2.status === 'running' || _hItem2.status === 'pending')) {
            _hItem2.status = 'completed';
          }
        }
        saveState();
      }
      // /ps panel is a snapshot — refresh it now that in-flight tools have
      // been resolved to completed/failed, so it doesn't show stale "running"
      // processes until the next turn. No-op if the panel is hidden.
      refreshPsPanelIfVisible();
      // Arm the turn-tail grace window BEFORE dropping isProcessing. Agents
      // (Codex, Codex, Claude Code, Kiro) can emit the final text chunk a
      // few ms after the session/prompt response carrying end_turn resolves —
      // if this turn just ended normally and the tail chunk is still in
      // transit, keep accepting it for a short window and append to the last
      // committed assistant bubble instead of dropping it (premature
      // end_turn / "nothing happened" symptom).
      if (!_wasCancelled && !isLoadingSession && !_wasCompacting) {
        turnTailGraceUntil = Date.now() + TURN_TAIL_GRACE_MS;
      }
      // Plan-mode handoff: the turn produced a plan and the agent will not edit
      // anything while collaboration_mode is 'plan'. Offer the switch instead of
      // leaving the user to find the picker.
      if (!_wasCancelled && !isLoadingSession) {
        offerImplementPlan();
      }
      setProcessing(false, 'promptEnd');
      vscode.postMessage({ type: 'debugLog', message: '[DRAIN-DBG] after setProcessing(false): isProcessing=' + isProcessing + ' isCompacting=' + isCompacting + ' messageQueue.length=' + messageQueue.length + ' pendingSendAfterCancel=' + !!pendingSendAfterCancel });
       // Interrupted: keep partial reply folded and refresh the ▸ header
        // (thought-only / Claude cancel often had toolCount 0 → header hidden).
        if (_wasCancelled && currentTurnEl && compactMode) {
          foldInterruptedAssistantsOnPromote = true;
          promoteFinalAssistantForTurn(currentTurnEl);
          foldInterruptedAssistantsOnPromote = false;
        }
       // Kiro /compact can still be running after execute's promptEnd — keep
       // the Stop/spinner state until we get a true compacted notice.
       if (isCompacting) {
         setProcessing(true, 'promptEnd-keepwaiting-compacting');
         if (statusEl && !statusEl.innerHTML) {
           showCompactionProgress('Compacting conversation...', null);
         }
       } else if (isClearing) {
         setProcessing(true, 'promptEnd-keepwaiting-clearing');
         if (statusEl && !statusEl.innerHTML) {
           showStatusBanner('clear', 'Clearing conversation...', null);
         }
       }
     // Show interrupted notice in status bar (right upper of input box)
    // when the turn was cancelled. Don't add duplicate system message to chat.
   if (msg.stopReason === 'cancelled') {
     // During session/load replay, don't show the interrupted notice —
     // it's a historical event, not a live cancellation.
     // When pendingSendAfterCancel is set, the cancel was intentional
     // (user clicked "Send Now" on a queued message). Suppress the
     // "Conversation interrupted" notice — it's not a real interruption.
     if (!isLoadingSession) {
       isForceCancelled = true; // drop further chunks from the unresponsive agent
     }
     if (!isLoadingSession && !pendingSendAfterCancel && !suppressInterruptNotice) {
       // Show "Conversation interrupted" in the main chat (outside the
       // collapsed turn fold), not just in the status bar. In compact /
       // collapsed mode the partial reply is folded away, so the only
       // visible indication of the interruption should not be hidden
       // inside the fold or limited to the transient status bar text.
       var _noticeEl = addMessage('system', '— Conversation interrupted —');
       // Track the notice so a new turn (promptStart) can remove it from both
       // the DOM and chatHistory — it should not linger after a follow-up.
       interruptedNoticeEl = _noticeEl;
       interruptedNoticeHistoryIdx = chatHistory.length - 1;
     }
     if (!isLoadingSession && !pendingSendAfterCancel && !suppressInterruptNotice && statusEl) {
         statusEl.textContent = '— Conversation interrupted —';
         setTimeout(() => { if (statusEl.textContent === '— Conversation interrupted —') { statusEl.textContent = ''; } }, 5000);
     }
   }
  // Auto-collapse completed turns (respect compact mode): hide thought +
  // tools behind the summary line. Clear sticky expand — turn is done.
  if (currentTurnEl) {
      if (currentToolsCountEl) currentToolsCountEl.dataset.count = String(currentToolCount);
      var _hasSubagent = currentToolsCountEl && currentToolsCountEl._hasSubagent;
      var _shouldCollapse = compactMode || _hasSubagent || currentToolCount > 3;
      if (_shouldCollapse) {
        var _endBody = getTurnFoldBody(currentTurnEl);
        // Respect user's manual expand: if the user opened this fold during
        // streaming to read thoughts/tools, don't snap it shut at promptEnd.
        // The fold will still collapse on the next renderChatHistory /
        // forceCollapseTurnFolds (session switch, reload) if needed.
        var _userOpened = _endBody && _endBody._userExpanded && !isLoadingSession;
        ensureTurnFoldStructure(currentTurnEl, true);
        // Re-sort fold contents by data-history-index so the last tool group
        // (which was appended after the summary assistant was lifted outside
        // by placeSummaryAssistant) ends up in the correct chronological
        // position relative to the interim assistant segments.
        _endBody = getTurnFoldBody(currentTurnEl);
        if (_endBody && !suppressFoldOrdering) orderCompactFoldContents(_endBody);
        if (_endBody) {
          if (_userOpened) {
            // Keep expanded — preserve _userExpanded so sticky logic in
            // ensureTurnFoldStructure continues to honor it.
            _endBody._userExpanded = true;
            setFoldExpanded(_endBody, true);
          } else {
            _endBody._userExpanded = false;
            setFoldExpanded(_endBody, false);
          }
        }
      } else if (currentToolsCountEl && currentToolsCountEl.classList.contains('turn-tools-summary')) {
        updateToolGroupSummary(currentToolsCountEl, currentToolCount, currentToolsCountEl._titles || [], currentToolsCountEl._kinds || [], currentToolsCountEl._rawInputs || []);
      }
        }
          currentToolsListEl = null;
          currentToolsCountEl = null;
          currentToolCount = 0;
          resetClaudeCrewState();
          currentThoughtEl = null;
         currentThoughtTextEl = null;
         currentThoughtText = '';
         thoughtDomBase = '';
         thoughtStartTime = null;
         thoughtEndTime = null;
        // Close the turn so the next prompt (or Claude between-turn noise)
        // cannot append into this fold via placeSummaryAssistant.
        currentTurnEl = null;
        currentAssistantEl = null;
        currentAssistantText = '';
       // The turn has fully finished — clear the transition-tick guard so a
       // message typed in the drain(s) below sends normally, and so the next
       // user input after the queue drains is not spuriously queued.
       isSendingPrompt = false;
       // Auto-send next queued message (if any) after the turn completes.
       // Uses a microtask delay so the UI fully settles before the next
       // turn starts.
       // Skip drain when this promptEnd was a compaction cycle — the turn
       // is still running (auto-compact resumes in the same turn).
      if (pendingSendAfterCancel) {
       // A "Send Now" was requested while processing — send that
       // message immediately after the cancel completes.
      var entry = pendingSendAfterCancel;
      pendingSendAfterCancel = null;
      setTimeout(() => {
        if (!isProcessing) {
          // Route slash commands through handleLocalSlashCommand so local UI
          // is triggered. The bubble is added HERE, after the cancelled turn
          // has closed, so the message lands below the prior turn's content.
          // entry.bubbleShown stays as a guard for any future path that shows
          // the bubble earlier — sendQueuedMessageNow deliberately does not.
          if (entry.text && entry.text.startsWith('/') && handleLocalSlashCommand(entry.text)) {
            // Local slash command handled it.
          } else {
            if (!entry.bubbleShown) {
              addUserBubbleForQueuedEntry(entry);
            }
            hasSentPrompt = true;
            vscode.postMessage({ type: 'sendPrompt', text: entry.text || ' ', images: entry.images });
          }
        }
      }, 0);
       } else if (!isCompacting && messageQueue.length > 0) {
        // Use current isCompacting (not _wasCompacting) — flushCompactionMessages
        // may have already cleared it during this promptEnd, meaning compaction
        // truly finished and queued messages should be drained now.
        vscode.postMessage({ type: 'debugLog', message: '[DRAIN-DBG] scheduling drain: _wasCompacting=' + _wasCompacting + ' isCompacting=' + isCompacting + ' messageQueue.length=' + messageQueue.length + ' isProcessing=' + isProcessing });
        setTimeout(() => {
          vscode.postMessage({ type: 'debugLog', message: '[DRAIN-DBG] drain setTimeout fired: isProcessing=' + isProcessing + ' messageQueue.length=' + messageQueue.length });
          if (!isProcessing && messageQueue.length > 0) {
            vscode.postMessage({ type: 'debugLog', message: '[DRAIN-DBG] calling drainQueue()' });
            drainQueue();
          }
        }, 0);
      }
      if (isCompacting && messageQueue.length > 0) {
        vscode.postMessage({ type: 'debugLog', message: '[DRAIN-DBG] SKIPPED drain because isCompacting=true, messageQueue.length=' + messageQueue.length });
      }
      if (!isCompacting && messageQueue.length === 0 && !pendingSendAfterCancel) {
        vscode.postMessage({ type: 'debugLog', message: '[DRAIN-DBG] no drain needed: queue empty' });
      }
      // Catch any stub titles whose per-tool enrich raced the store.db write.
      if (!_wasCompacting && !isLoadingSession) {
        requestCursorToolEnrichIfNeeded();
      }
       break;

     case 'clearChat':
             isCompacting = false;
             isClearing = false;
             hideCompactionProgress();
             // Cancel any pending render retries — DOM is being wiped.
             for (var _crk in pendingRenderRetries) { delete pendingRenderRetries[_crk]; }
             dismissPsPanel(true);
        chatHistory = [];
       sessionState = null;
      chatHistoryOriginSessionId = null;
       hasSentPrompt = false;
      hasSteeredThisTurn = false;
       saveState();
         currentAssistantEl = null;
         currentAssistantText = '';
         toolCalls = {};
         toolCallDiffs = {};
         currentTurnEl = null;
         currentToolsListEl = null;
         currentToolsCountEl = null;
         currentToolCount = 0;
         currentThoughtEl = null;
         currentThoughtTextEl = null;
        currentThoughtText = '';
        thoughtDomBase = '';
        thoughtStartTime = null;
        thoughtEndTime = null;
        currentPlanEl = null;
        if (planBar) { planBar.innerHTML = ''; }
        if (typeof clearCursorTodosPlan === 'function') clearCursorTodosPlan();
        tokenUsage = null;
         if (tokenUsageRing) tokenUsageRing.classList.remove('visible');
         availableCommands = [];
         slashPopup.classList.remove('open');
         messagesEl.innerHTML = '';
         messagesEl.appendChild(emptyState);
         if (emptyState) emptyState.style.display = '';
         // Hide welcome button when starting a new conversation to avoid
         // flashing "Resume <agent>" before the new session is ready.
         var welcomeActions = emptyState ? emptyState.querySelector('.actions') : null;
         var welcomeHint = emptyState ? emptyState.querySelector('.hint') : null;
         if (msg.showWelcome === false) {
           if (welcomeActions) welcomeActions.style.display = 'none';
           if (welcomeHint) welcomeHint.style.display = 'none';
         } else {
           if (welcomeActions) welcomeActions.style.display = '';
           if (welcomeHint) welcomeHint.style.display = '';
           updateWelcomeButton();
         }
         if (sessionBanner) sessionBanner.classList.remove('visible');
        if (inputArea) inputArea.classList.add('disabled');
        modePickerWrap.classList.add('hidden');
        modelPickerWrap.classList.add('hidden');
       setConfigOptionsState([]);
        setProcessing(false, 'newConversation');
        // Hide resume bar immediately — new conversation means no session
        // to resume. Without this, the resume button from startup/previous
        // session lingers until the new agent connects.
       hasActiveSession = false;
       updateResumeBar();
       break;

       case 'setSuppressInterruptNotice':
         suppressInterruptNotice = true;
         break;

       case 'processesStopped': {
         // /stop completed on the agent side. The agent clears its internal
         // background-process map but does NOT emit tool_call_update
         // notifications for the killed processes. Mark ALL currently-running
         // tool calls as 'failed' locally so /ps no longer shows stale
         // processes and the tool icons reflect the kill.
         //
         // The agent ALSO emits a "🛑 Killed N running process(es)."
         // agent_message_chunk — that lands as a PERSISTENT assistant bubble,
         // which would stick in the chat forever. We suppress that bubble
         // (isStopNoticeChunk, checked in the agent_message_chunk path) and
         // instead show our OWN transient notice here, which auto-vanishes
         // after a few seconds (like before) — so the user gets feedback
         // without a permanent "Killed" line cluttering the history.
         var _killed = 0;
         for (var _ki = 0; _ki < chatHistory.length; _ki++) {
           var _kItem = chatHistory[_ki];
           if (_kItem && _kItem.kind === 'toolCall' &&
               (_kItem.status === 'in_progress' || _kItem.status === 'running' || _kItem.status === 'pending')) {
             _kItem.status = 'failed';
             _killed++;
             var _kEl = lookupToolCallEl(_kItem.toolCallId);
             if (_kEl) {
               var _kIcon = _kEl.querySelector('.tc-icon');
               if (_kIcon) { _kIcon.className = 'tc-icon failed'; _kIcon.textContent = getStatusIcon('failed'); }
               var _kBadge = _kEl.querySelector('.status-badge');
               if (_kBadge) { _kBadge.className = 'status-badge failed'; _kBadge.textContent = 'failed'; }
             }
           }
         }
         if (_killed > 0) saveState();
         // Force-dismiss the /ps panel (bypass the 3s min-display window).
         // If /ps is re-run it will now show "No background terminals running".
         dismissPsPanel(true);
         // Transient confirmation — auto-vanishes after a few seconds so the
         // "Killed" feedback doesn't persist in the chat history. (The agent's
         // own "🛑 Killed N..." bubble is suppressed via isStopNoticeChunk so
         // this is the ONLY "Killed" text the user sees.)
         //
         // Suppressed when the kill was a side effect of "Send Now" (which
         // interrupts the turn and kills processes to stop background work) —
         // the user did not run /stop, so the "Killed" notice is noise.
         if (!msg.suppressNotice && _killed > 0) {
           showTransientNotice('Killed ' + _killed + ' running process' + (_killed === 1 ? '' : 'es') + '.');
         }
         break;
       }

       case 'error':
          // Claude ACP may surface "AbortError: Compaction canceled." as an
          // error after a successful /compact — do not paint it.
          if (isCompacting || Date.now() < suppressPostCompactNoiseUntil) {
            var _errMsg = String(msg.message || '');
            if (/AbortError:\\s*Compaction cancel/i.test(_errMsg) ||
                /Compaction cancel(l)?ed/i.test(_errMsg)) {
              if (isCompacting && (compactedWarningText || compactedNoticeText || isClaudeAgent() || isPiAgent())) {
                if (!compactedNoticeText) compactedNoticeText = 'Compacting completed.';
                flushCompactionMessages();
              }
              break;
            }
            // Real compact failure (e.g. Pi "Nothing to compact") — drop the
            // "Compacting conversation..." spinner. Leaving isCompacting true
            // after the error message would block handleSend forever.
            if (isCompacting) {
              if (kiroCompactWatchdog) { clearTimeout(kiroCompactWatchdog); kiroCompactWatchdog = null; }
              if (compactionFlushTimer) { clearTimeout(compactionFlushTimer); compactionFlushTimer = null; }
              isCompacting = false;
              manualCompacting = false;
              compactedWarningText = '';
              compactedNoticeText = '';
              pendingPostCompactChunks = [];
              hideCompactionProgress();
              if (statusEl) statusEl.innerHTML = '';
              setProcessing(false, 'error-compact-failure');
            }
          }
         addMessage('error', msg.message || 'An error occurred');
         // Reset processing state in case the error prevents promptEnd from firing
         // (e.g. early return in handleSendPrompt before slash command path).
         if (isProcessing && !isCompacting && !isClearing) {
           setProcessing(false, 'error-reset');
         }
         break;

       case 'showSystemMessage':
         addMessage('system', msg.text || '');
         break;
       case 'contextPicked':
         if (msg.contextType === 'session') {
           // Session summary context — handle loading, error, and result states
           if (msg.loading) {
             // Show loading indicator in the prompt input area
             promptInput.placeholder = 'Summarizing session…';
             promptInput.disabled = true;
           } else if (msg.error) {
             promptInput.placeholder = '';
             promptInput.disabled = false;
             // Show error briefly in status
             statusEl.textContent = msg.error;
             setTimeout(() => { if (statusEl.textContent === msg.error) { statusEl.textContent = ''; } }, 5000);
           } else if (msg.summary) {
             // Insert the session summary as a context block in the prompt
             promptInput.placeholder = '';
             promptInput.disabled = false;
             var sessionTitle = msg.sessionTitle || 'session';
             var summaryText = msg.summary;
             // Insert as a context block — the agent will see this as context
           var contextBlock = '<context ref="session:' + escapeHtml(sessionTitle) + '">\\n' +
             'Summary of session "' + sessionTitle + '" (generated by ' + (msg.model || 'AI') + '):\\n\\n' +
              summaryText + '\\n</context>';
            if (promptInput.value.trim()) {
              promptInput.value = promptInput.value.trim() + '\\n\\n' + contextBlock + '\\n';
            } else {
              promptInput.value = contextBlock + '\\n';
            }
             promptInput.focus();
             updateSendButton();
           }
         } else {
           promptInput.value += '@' + msg.contextType + ':' + msg.path + ' ';
           promptInput.focus();
         }
        break;

    case 'sessionNames':
      // Extension sent back the list of renamed session names for autocomplete
      sessionNames = msg.names || [];
      // If the user is currently in /session autocomplete mode, re-render
      if (isSessionAutocomplete && promptInput.value.startsWith('/session ')) {
        var curText = promptInput.value;
        var curAfter = curText.substring(curText.indexOf(' ') + 1);
        var curSecondSpace = curAfter.indexOf(' ');
        var curPartial = curSecondSpace >= 0 ? curAfter.substring(0, curSecondSpace) : curAfter;
        sessionAutocompleteFiltered = sessionNames.filter(function(n) {
          return n.toLowerCase().indexOf(curPartial.toLowerCase()) >= 0;
        });
        if (sessionAutocompleteFiltered.length > 0 && curSecondSpace < 0) {
          renderSessionAutocomplete(sessionAutocompleteFiltered);
          slashPopup.classList.add('open');
          sessionAutocompleteSelectedIdx = 0;
        }
      }
      break;

   case 'sessionSummary':
      // Result from /session slash command — the summary is ready.
      // The user message was already shown immediately when /session was sent.
      if (msg.error) {
        // Clear loading indicator
        if (statusEl) { statusEl.textContent = ''; }
        // Remove the user message that was added optimistically
        var lastMsg = chatHistory[chatHistory.length - 1];
        if (lastMsg && lastMsg.kind === 'message' && lastMsg.role === 'user') {
          chatHistory.pop();
          var allUserEls = messagesEl.querySelectorAll('.message.user');
          if (allUserEls.length > 0) { allUserEls[allUserEls.length - 1].remove(); }
          saveState();
        }
        // Show error in status bar
        if (statusEl) {
          statusEl.textContent = msg.error;
          setTimeout(function() { if (statusEl && statusEl.textContent === msg.error) { statusEl.textContent = ''; } }, 5000);
        }
        if (msg.queryText) {
          promptInput.value = msg.queryText;
          promptInput.focus();
          updateSendButton();
        }
     } else if (msg.summary) {
       // Clear loading indicator
       if (statusEl) { statusEl.textContent = ''; }
       var sessionTitle = msg.sessionTitle || 'session';
       var summaryText = msg.summary;
       var nl = String.fromCharCode(10);
       var contextBlock = '<context ref="session:' + escapeHtml(sessionTitle) + '">' + nl +
         'Summary of session "' + sessionTitle + '" (generated by ' + (msg.model || 'AI') + '):' + nl + nl +
         summaryText + nl + '</context>';
       var userMsg = contextBlock;
       if (msg.queryText) {
         userMsg += nl + nl + msg.queryText;
       }
       // The user message was already shown — just send the prompt to the agent.
       vscode.postMessage({ type: 'sendPrompt', text: userMsg, images: [] });
      }
      break;

        case 'sessionUpdate':
          // Sync isLoadingSession from the extension-side flag. The
          // extension's loadingSessionIds set is the source of truth —
          // the async loadSessionStart postMessage may arrive AFTER the
          // first replay chunk if the SDK dispatches notifications before
          // the webview processes the loadSessionStart message. This
          // ensures the notProcessing gate accepts replay chunks even when
          // isLoadingSession hasn't been set yet by loadSessionStart.
          if (msg.isLoading !== undefined) {
            isLoadingSession = !!msg.isLoading;
          }
          handleUpdate(msg.update);
          break;

        case 'modesUpdate':
          updateModePicker(msg.modes);
          break;

        case 'modelsUpdate':
          updateModelPicker(msg.models);
          if (sessionState && msg.currentModelImageSupport !== undefined) {
            sessionState.currentModelImageSupport = msg.currentModelImageSupport;
            updateAttachButtonVisibility(undefined, msg.currentModelImageSupport);
          }
          break;

       case 'configOptionsUpdate':
         setConfigOptionsState(msg.configOptions || []);
         break;

      case 'kiroMetadata':
        handleKiroMetadata(msg.params);
        break;

      case 'kiroSubagentListUpdate':
        handleKiroSubagentListUpdate(msg.params);
        break;

      case 'kiroCompactionStatus':
        handleKiroCompactionStatus(msg.params);
        break;

      case 'kiroClearStatus':
        handleKiroClearStatus(msg.params);
        break;

      case 'requestConversationExport': {
        // Fork of a session that is NOT the one on screen (clicked in the tree,
        // or refused by its owning process) has no rendered history to export.
        // Fall back to this window's archive of that session, which holds the
        // items from when it was last loaded here.
        //
        // There is no other local source for some agents: kiro keeps no
        // transcript on disk — its CLI session JSON and IDE session.json carry
        // only metadata, and the conversation itself lives in the kiro process
        // and its backend — so once session/load is refused ("active in another
        // process"), the archive is all we have.
        var _exportItems = chatHistory;
        var _wantSessionId = msg.sessionId || null;
        if (_wantSessionId && _wantSessionId !== chatHistoryOriginSessionId) {
          var _archived = sessionHistoryArchive[_wantSessionId];
          _exportItems = _archived && _archived.length ? _archived : [];
        }
        // Extension host wants the conversation text for fork-to-agent.
        // Collect user + assistant messages, tool calls, and reasoning
        // blocks from chatHistory so the target agent gets structured
        // context (not just a flat prose dump). Tool calls carry the
        // action taken and its result; thoughts carry the reasoning trail.
        //
        // If the session was compacted at some point, only the post-compaction
        // history (from the first compaction boundary onward) is exported.
        // Carrying the full pre-compaction transcript into the fork inflates
        // the target's token usage far beyond its context window (a compacted
        // 200k session can become 700k+ when re-embedded as one text block).
        // Each adapter signals compaction differently (tool_call titled
        // "Context compacting" + _meta.contextCompaction for kiro/pi/
        // claude-code, an assistant "*Context compacted ...*" line for codex,
        // a system notice, or the future compaction_update RFD), so we accept
        // all of them. Mirrors findCompactionBoundary in core/conversationExport.ts.
        var _exportStart = 0;
        for (var _cei = 0; _cei < _exportItems.length; _cei++) {
          var _ceItem = _exportItems[_cei];
          if (!_ceItem) continue;
          var _ceMeta = _ceItem._meta;
          var _isBoundary = false;
          if (_ceMeta && _ceMeta.contextCompaction === true) {
            _isBoundary = true;
          } else if (_ceItem.kind === 'compaction_update') {
            var _ceStatus = typeof _ceItem.status === 'string' ? _ceItem.status.toLowerCase() : '';
            if (_ceStatus === 'completed' || _ceStatus === '' || _ceStatus === 'in_progress') {
              _isBoundary = true;
            }
          } else if (_ceItem.kind === 'toolCall') {
            var _ceTitle = typeof _ceItem.title === 'string' ? _ceItem.title.toLowerCase() : '';
            if (_ceTitle.includes('compact') && _ceTitle.includes('context')) {
              _isBoundary = true;
            }
          } else if (_ceItem.kind === 'message') {
            var _ceText = typeof _ceItem.text === 'string' ? _ceItem.text.toLowerCase() : '';
            if (_ceText.includes('compacted') || _ceText.includes('compacting')) {
              _isBoundary = true;
            }
          }
          if (_isBoundary) {
            // Start AFTER the boundary marker: the marker itself (a "Context
            // compacting" tool call, a "*Context compacted*" line, or a
            // compaction_update) is protocol noise, not content the forked
            // agent needs. Post-compaction turns begin after it.
            //
            // Keep scanning to the END: the LAST boundary is the live one.
            // Each compaction replaces everything before it with a summary, so
            // after N compactions only the turns following the Nth are still
            // live. Stopping at the first boundary re-sent every turn that
            // compactions 2..N had already replaced, so the fork carried raw
            // history AND the summaries that superseded it.
            _exportStart = _cei + 1;
          }
        }
        var _exportParts = [];
        // Parallel { role, content } list for the summarizer (the fork sends a
        // summary, and the summarizer caps per-message length — so it needs
        // discrete messages, not one giant blob).
        var _exportMsgs = [];
        for (var _ei = _exportStart; _ei < _exportItems.length; _ei++) {
          var _item = _exportItems[_ei];
          if (!_item) continue;
          // Never carry a compaction boundary marker itself (a "Context
          // compacting" tool call, a "*Context compacted*" line, a system
          // notice, or a compaction_update) into a fork — protocol noise.
          var _itemMeta = _item._meta;
          var _isBoundaryMarker = false;
          if (_itemMeta && _itemMeta.contextCompaction === true) {
            _isBoundaryMarker = true;
          } else if (_item.kind === 'compaction_update') {
            _isBoundaryMarker = true;
          } else if (_item.kind === 'toolCall') {
            var _itemTitle = typeof _item.title === 'string' ? _item.title.toLowerCase() : '';
            if (_itemTitle.includes('compact') && _itemTitle.includes('context')) {
              _isBoundaryMarker = true;
            }
          } else if (_item.kind === 'message') {
            var _itemText = typeof _item.text === 'string' ? _item.text.toLowerCase() : '';
            if (_itemText.includes('compacted') || _itemText.includes('compacting')) {
              _isBoundaryMarker = true;
            }
          }
          if (_isBoundaryMarker) continue;
          if (_item.kind === 'message') {
            if (_item.role === 'user') {
              var _utext = typeof _item.text === 'string' ? _item.text : '';
              if (!_utext.trim()) continue;
              if (_utext.startsWith('[Subagent result]')) continue;
              // Never carry replayed resource_link JSON into a fork. History
              // written by an earlier build can hold rows whose whole body is
              // {"name":...,"uri":...,"type":"resource_link"}; exporting them
              // put the raw JSON into the NEW conversation as a User: line,
              // and the fork's own resume then replayed it again.
              if (!stripLeadingResourceLinkJson(_utext).trim()) continue;
              _exportParts.push('User: ' + _utext);
              _exportMsgs.push({ role: 'user', content: 'User: ' + _utext });
            } else if (_item.role === 'assistant') {
              var _atext = typeof _item.text === 'string' ? _item.text : '';
              if (!_atext.trim()) continue;
              if (!stripLeadingResourceLinkJson(_atext).trim()) continue;
              _exportParts.push('Assistant: ' + _atext);
              _exportMsgs.push({ role: 'assistant', content: 'Assistant: ' + _atext });
            }
          } else if (_item.kind === 'thought') {
            var _ttext = typeof _item.text === 'string' ? _item.text : '';
            if (_ttext.trim()) {
              _exportParts.push('(reasoning) ' + _ttext);
              _exportMsgs.push({ role: 'assistant', content: '(reasoning) ' + _ttext });
            }
          } else if (_item.kind === 'toolCall') {
            var _tname = _item.title || _item.toolCallId || 'tool';
            var _tstatus = _item.status || '';
            var _tinput = '';
            if (typeof _item.rawInput === 'string') {
              _tinput = _item.rawInput;
            } else if (_item.rawInput && typeof _item.rawInput === 'object') {
              try { _tinput = JSON.stringify(_item.rawInput); } catch (e) { _tinput = ''; }
            }
            var _tline = 'Tool: ' + _tname;
            if (_tstatus) _tline += ' [' + _tstatus + ']';
            if (_tinput && _tinput.trim()) _tline += '\\n' + _tinput;
            _exportParts.push(_tline);
            _exportMsgs.push({ role: 'assistant', content: _tline });
          }
        }
        // Report whether the export starts at a compaction boundary (i.e. the
        // content is ALREADY the post-compaction summary) and whether a
        // compaction is currently in progress. forkToAgent (extension host)
        // uses these to (a) refuse to fork mid-compaction — forking while
        // isCompacting=true both kills the source agent mid-summarize and
        // yields a near-empty export — and (b) skip the SECOND summarization
        // when the export is already the compaction summary, which collapsed
        // 427K chars of context to 27 chars in a real fork.
        vscode.postMessage({
          type: 'conversationExported',
          text: _exportParts.join('\\n\\n'),
          messages: _exportMsgs,
          exportStartsAtCompactionBoundary: _exportStart > 0,
          compactionInProgress: !!isCompacting,
        });
        break;
      }
      case 'kiroGoalStatus':
        // Kiro CLI / Codex _meta.codex.goal — update goal chip.
        // null clears the chip; do not treat it as missing.
        if (msg.goalSnapshot !== undefined) {
          goalSnapshot = msg.goalSnapshot;
          renderGoalChip();
        }
        break;

      case 'sessionTerminate':
        handleSessionTerminate(msg.params);
        break;

      case 'cursorTask':
        handleCursorTask(msg.params);
        break;

      case 'cursorUpdateTodos':
        handleCursorUpdateTodos(msg.params);
        break;

      case 'cursorGenerateImage':
        handleCursorGenerateImage(msg.params);
        break;

      case 'cursorCreatePlan':
        handleCursorCreatePlan(msg.params);
        break;

      case 'kiroCompactDone':
        handleKiroCompactDone(msg);
        break;

      case 'kiroClearDone':
        handleKiroClearDone(msg);
        break;

      case 'loadSessionStart':
         handleLoadSessionStart();
         break;

        case 'loadSessionEnd':
          handleLoadSessionEnd(!!msg.ok);
          break;

        case 'cursorToolEnrichBatch':
          handleCursorToolEnrichBatch(msg.tools || []);
          break;

        case 'sessionInfoUpdate':
          handleSessionInfoUpdate(msg.title);
          break;

      case 'markdownRendered': {
        // Extension sent back rendered HTML for messages
        const rendered = msg.items || [];
        // Clear all pending render retries — the extension host responded
        for (var _rk in pendingRenderRetries) { delete pendingRenderRetries[_rk]; }
        vscode.postMessage({ type: 'debugLog', message: 'markdownRendered: ' + rendered.length + ' items' });
        for (const item of rendered) {
           // index === -1 means streaming render for the live assistant element
           if (item.index === -1) {
             // Discard stale renders from a previous text segment
             if (item.gen !== undefined && item.gen !== streamingRenderGen) continue;
             // Never paint streaming HTML onto an already-committed bubble
             // (can happen if currentAssistantEl briefly lags a commit).
             if (currentAssistantEl && currentAssistantEl.classList.contains('md-committed')) continue;
             vscode.postMessage({ type: 'debugLog', message: 'markdownRendered[-1]: gen=' + item.gen + ' currentGen=' + streamingRenderGen + ' hasEl=' + !!currentAssistantEl + ' htmlLen=' + (item.html ? item.html.length : 0) });
           if (currentAssistantEl) { currentAssistantEl.innerHTML = item.html; currentAssistantEl.classList.add('md-rendered'); wireFileLinks(currentAssistantEl); }
            if (currentAssistantEl) renderMermaidBlocks(currentAssistantEl);
            continue;
            }
            // Find the DOM element for this history item
            // For the just-completed streaming message, update the last assistant el
          const historyItem = chatHistory[item.index];
          if (!historyItem || historyItem.role !== 'assistant') continue;

          // Discard stale history renders from a previous DOM build.
          // hgen is set when the renderMarkdown request was created;
          // if it doesn't match the current historyRenderGen, the DOM
          // has been rebuilt since then and this response is stale.
          if (item.hgen !== undefined && item.hgen !== historyRenderGen) {
            vscode.postMessage({ type: 'debugLog', message: 'markdownRendered[' + item.index + ']: SKIPPED (stale hgen=' + item.hgen + ' current=' + historyRenderGen + ')' });
            continue;
          }

          // Prefer the element tagged at commit time. Falling back to ordinal
          // index is unsafe while a live (uncommitted) assistant exists — a
          // late render for section 1 can overwrite section 2's bubble and
          // then the next stream paint concatenates both into one block.
          var el = messagesEl.querySelector('.message.assistant[data-history-index="' + item.index + '"]');
          if (!el) {
            const allAssistant = messagesEl.querySelectorAll('.message.assistant');
            let assistantIdx = 0;
            for (let i = 0; i < chatHistory.length; i++) {
              if (i === item.index) break;
              if (chatHistory[i].kind === 'message' && chatHistory[i].role === 'assistant') assistantIdx++;
            }
            el = allAssistant[assistantIdx] || null;
          }
          // Never clobber the in-progress streaming bubble with a history paint.
          if (el && el === currentAssistantEl) {
            vscode.postMessage({ type: 'debugLog', message: 'markdownRendered[' + item.index + ']: SKIPPED (targets live streaming el)' });
            continue;
          }
           vscode.postMessage({ type: 'debugLog', message: 'markdownRendered[' + item.index + ']: foundEl=' + !!el + ' htmlLen=' + (item.html ? item.html.length : 0) });
           if (el) {
             // Skip if already rendered with the same HTML (prevents
             // copy-button blinking from duplicate renderMarkdown responses)
             var renderHash = (function(h){for(var i=0;i<item.html.length;i++){h=((h<<5)-h+item.html.charCodeAt(i))|0;}return h;})(5381) + ':' + item.index;
             if (el.classList.contains('md-rendered') && el.getAttribute('data-render-hash') === renderHash) {
               vscode.postMessage({ type: 'debugLog', message: 'markdownRendered[' + item.index + ']: SKIPPED (same hash)' });
               continue;
             }
              el.classList.add('md-rendered');
              el.setAttribute('data-render-hash', renderHash);
              el.setAttribute('data-history-index', String(item.index));
             el.innerHTML = item.html;
            wireFileLinks(el);
            renderMermaidBlocks(el);
          }
        }
        autoScrollIfAtBottom();
         break;
       }
      }
    });

   // --- Wire up file-link click handlers after markdown render ---
   // Handles three types of clickable links in rendered markdown:
   //   1. Auto-linkified paths: <a class="file-link" data-file="..." data-line="...">
   //   2. Markdown file links: <a href="path/to/file.ext:69">SymbolName</a>
   //      Supports :line and :line-end ranges, and file:// protocol
   //   3. Symbol links: <a href="@symbol:SymbolName">SymbolName</a>
   //      Triggers VS Code Go to Symbol in Workspace
   function renderMermaidBlocks(root) {
     const pres = root.querySelectorAll('pre code.language-mermaid, pre code[class*="language-mermaid"]');
     if (pres.length === 0 && root.querySelectorAll('.mermaid').length === 0) return;
     pres.forEach(code => {
       const pre = code.parentElement;
       if (!pre || pre.dataset.mermaidProcessed) return;
       pre.dataset.mermaidProcessed = '1';
       const div = document.createElement('div');
       div.className = 'mermaid';
       div.textContent = code.textContent;
       pre.parentElement.replaceChild(div, pre);
     });
     const nodes = root.querySelectorAll('.mermaid');
     if (nodes.length === 0) return;
     ensureMermaidLoaded(function() {
       try { mermaid.run({ nodes: root.querySelectorAll('.mermaid') }); }
       catch (e) { console.log('[ACP] mermaid error:', e); }
     });
   }

   // Lazy-loader for mermaid.min.js (~3.5 MB). The script tag is only
   // injected once, the first time a mermaid block is rendered. Subsequent
   // calls reuse the same load promise.
   function ensureMermaidLoaded(then) {
     if (typeof mermaid !== 'undefined') { then(); return; }
     if (window.__acpMermaidLoading) {
       window.__acpMermaidLoading.then(then);
       return;
     }
     const uri = window.__acpMermaidUri;
     if (!uri) { return; }
     window.__acpMermaidLoading = new Promise(function(resolve) {
       const s = document.createElement('script');
       if (window.__acpNonce) { s.nonce = window.__acpNonce; }
       s.src = uri;
       s.onload = function() {
         try {
           if (typeof mermaid !== 'undefined') {
             mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'loose' });
           }
         } catch (e) { console.log('[ACP] mermaid init error:', e); }
         resolve();
       };
       s.onerror = function() { console.log('[ACP] mermaid script load failed'); resolve(); };
       document.head.appendChild(s);
     });
     window.__acpMermaidLoading.then(then);
   }
   function wireFileLinks(root) {
     // Wire up copy buttons on code fences
     const codeBlocks = root.querySelectorAll('pre');
      codeBlocks.forEach(pre => {
        if (pre.querySelector('.copy-btn')) return;
        // Wrap <pre> in a relative container so the button stays fixed
        // to the top-right corner of the visible area during horizontal scroll
        const wrapper = document.createElement('div');
        wrapper.className = 'code-fence-wrapper';
        wrapper.style.position = 'relative';
        pre.parentNode.insertBefore(wrapper, pre);
        wrapper.appendChild(pre);

        const btn = document.createElement('button');
        btn.className = 'copy-btn';
        btn.textContent = 'Copy';
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const code = pre.querySelector('code');
          const text = code ? code.textContent : pre.textContent;
          navigator.clipboard.writeText(text).then(() => {
            btn.textContent = '✓ Copied';
            btn.classList.add('copied');
            setTimeout(() => {
              btn.textContent = 'Copy';
              btn.classList.remove('copied');
            }, 1500);
          });
        });
        wrapper.appendChild(btn);
      });

      const selectors = 'a.file-link[data-file], a[href]';
      const links = root.querySelectorAll(selectors);
      links.forEach(link => {
        if (link.dataset.wired) return;
        link.dataset.wired = '1';
        link.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();

          if (link.classList.contains('file-link') && link.hasAttribute('data-file')) {
            // Auto-linkified path (from renderMarkdown regex)
            const filePath = link.getAttribute('data-file');
            const line = link.getAttribute('data-line');
            const lineEndAttr = link.getAttribute('data-line-end');
            const lineNumber = line ? parseInt(line, 10) : undefined;
            const lineEnd = lineEndAttr ? parseInt(lineEndAttr, 10) : undefined;
          vscode.postMessage({
              type: 'openFile',
              filePath: filePath,
              lineNumber: lineNumber,
              lineEnd: lineEnd,
              linkText: (link.textContent || '').trim(),
            });
            return;
          }

          // Markdown link — parse href
          const href = link.getAttribute('href') || '';
          if (!href || href === '#') return;

         // Symbol lookup: href starts with @symbol:
         if (href.startsWith('@symbol:')) {
           const symbolName = href.slice(8);
           if (symbolName) {
             vscode.postMessage({
               type: 'openSymbol',
               symbolName: symbolName,
             });
           }
           return;
         }

          // External URL: http(s):// — open in browser
          if (href.startsWith('http://') || href.startsWith('https://')) {
            vscode.postMessage({
              type: 'openExternalUrl',
              url: href,
            });
            return;
          }

        // Absolute file:// URL with optional #L fragment (Zed-compatible format)
        // e.g. file:///absolute/path/to/file.rs#L142 or file:///path/file.rs#L10-L20
        if (href.startsWith('file://')) {
          const url = new URL(href);
          const filePath = url.pathname; // already decoded
          let lineNumber = undefined;
          let lineEnd = undefined;
          // Extract ?symbol= query param for symbol-based line correction
          // This matches Zed's MentionUri::Symbol format: file:///path#L123?symbol=name
          const symbolName = url.searchParams.get('symbol') || undefined;
          if (url.hash) {
             // Parse #L142 or #L10-L20 or #L10:5 (line:col)
             const frag = url.hash.replace(/^#/, '').replace(/^L/i, '');
             const dashIdx = frag.indexOf('-');
             let lineStr, endStr;
             if (dashIdx > 0) {
               lineStr = frag.slice(0, dashIdx).split(':')[0];
               endStr = frag.slice(dashIdx + 1).split(':')[0];
             } else {
               lineStr = frag.split(':')[0];
               endStr = '';
             }
             const isLineValid = lineStr.length > 0 && lineStr.split('').every(function(c) { return c >= '0' && c <= '9'; });
              const isEndValid = !endStr || (endStr.length > 0 && endStr.split('').every(function(c) { return c >= '0' && c <= '9'; }));
             if (isLineValid && isEndValid) {
               lineNumber = parseInt(lineStr, 10);
               if (endStr) {
                 lineEnd = parseInt(endStr, 10);
               }
             }
           }
            // Also handle file:///path/to/file.rs:130 format (colon-line suffix without #L)
            if (lineNumber === undefined) {
              const lastColon = filePath.lastIndexOf(':');
              if (lastColon > 0) {
                const afterColon = filePath.slice(lastColon + 1);
                const dashIdx = afterColon.indexOf('-');
                let lineStr, endStr;
                if (dashIdx > 0) {
                  lineStr = afterColon.slice(0, dashIdx);
                  endStr = afterColon.slice(dashIdx + 1);
                } else {
                  lineStr = afterColon;
                  endStr = '';
                }
                const isLineValid = lineStr.length > 0 && lineStr.split('').every(function(c) { return c >= '0' && c <= '9'; });
                const isEndValid = !endStr || (endStr.length > 0 && endStr.split('').every(function(c) { return c >= '0' && c <= '9'; }));
                if (isLineValid && isEndValid) {
                  lineNumber = parseInt(lineStr, 10);
                  if (endStr) {
                    lineEnd = parseInt(endStr, 10);
                  }
                }
              }
            }
            // Strip :line suffix from filePath if present
            let cleanFilePath = filePath;
            if (lineNumber !== undefined) {
              const lastColon = filePath.lastIndexOf(':');
              if (lastColon > 0) {
                cleanFilePath = filePath.slice(0, lastColon);
              }
            }
          vscode.postMessage({
            type: 'openFile',
             filePath: cleanFilePath,
            lineNumber: lineNumber,
            lineEnd: lineEnd,
            // Use ?symbol= name if present — handleOpenFile uses linkText for
            // symbol-based line correction (searches nearby lines for the symbol)
            linkText: symbolName || (link.textContent || '').trim(),
          });
          return;
        }

         // File path link — strip file:// protocol
         let cleanHref = href;
         if (cleanHref.startsWith('file://')) {
           // Let the extension handle file:// URI parsing
         }

          // Parse path:line or path:line-end format
          // e.g. src/main.rs:69  or  src/main.rs:69-72
          const lastColon = cleanHref.lastIndexOf(':');
          let filePath = cleanHref;
          let lineNumber = undefined;
          let lineEnd = undefined;

          if (lastColon > 0) {
            const afterColon = cleanHref.slice(lastColon + 1);
            // Check for line or line-range (digits or digits-digits)
            // Parse line or line-range (digits or digits-digits) without regex
            // to avoid \d escaping issues in webview HTML
            const dashIdx = afterColon.indexOf('-');
            let lineStr, endStr;
            if (dashIdx > 0) {
              lineStr = afterColon.slice(0, dashIdx);
              endStr = afterColon.slice(dashIdx + 1);
            } else {
              lineStr = afterColon;
              endStr = '';
            }
            const isLineValid = lineStr.length > 0 && lineStr.split('').every(function(c) { return c >= '0' && c <= '9'; });
            const isEndValid = !endStr || (endStr.length > 0 && endStr.split('').every(function(c) { return c >= '0' && c <= '9'; }));
            if (isLineValid && isEndValid) {
              filePath = cleanHref.slice(0, lastColon);
              lineNumber = parseInt(lineStr, 10);
              if (endStr) {
                lineEnd = parseInt(endStr, 10);
              }
            }
          }

          // If href had no line number, try parsing from link text
          // (LLM sometimes puts path:line in text but only path in href)
          if (lineNumber === undefined) {
            const textContent = link.textContent || '';
            const textColon = textContent.lastIndexOf(':');
            if (textColon > 0) {
              const textAfter = textContent.slice(textColon + 1);
              const textDash = textAfter.indexOf('-');
              let tLine, tEnd;
              if (textDash > 0) {
                tLine = textAfter.slice(0, textDash);
                tEnd = textAfter.slice(textDash + 1);
              } else {
                tLine = textAfter;
                tEnd = '';
              }
              const tLineValid = tLine.length > 0 && tLine.split('').every(function(c) { return c >= '0' && c <= '9'; });
              const tEndValid = !tEnd || (tEnd.length > 0 && tEnd.split('').every(function(c) { return c >= '0' && c <= '9'; }));
              if (tLineValid && tEndValid) {
                lineNumber = parseInt(tLine, 10);
                if (tEnd) { lineEnd = parseInt(tEnd, 10); }
              }
            }
          }
          
          // Validate it looks like a file path (must contain a dot for extension,
          // or be a file:// URI)
          if (!filePath.includes('.') && !filePath.startsWith('file://')) return;
          // Skip http(s) URLs
         if (filePath.startsWith('http://') || filePath.startsWith('https://')) return;

        vscode.postMessage({
          type: 'openFile',
          filePath: filePath,
          lineNumber: lineNumber,
          lineEnd: lineEnd,
           linkText: (link.textContent || '').trim(),
         });
        });
      });
    }

    // --- Streaming markdown rendering ---
    // Throttle (leading + trailing) so the first chunk renders immediately
    // and subsequent fast chunks don't flash raw markdown.
    let streamingRenderTimer = null;
    let streamingRenderPending = false;
    let lastRenderTime = 0;
   let streamingRenderGen = 0; // generation counter to discard stale renders

    // Token usage state
   let tokenUsage = null;
   let goalSnapshot = null; // {objective, status, tokenBudget, timeUsedSeconds, createdAt, controlMethod}
    const tokenUsageRing = document.getElementById('tokenUsageRing');
    const tokenUsageRingFg = document.getElementById('tokenUsageRingFg');
    const tokenUsageRingLabel = document.getElementById('tokenUsageRingLabel');
    const tokenUsageTooltip = document.getElementById('tokenUsageTooltip');

    const STREAMING_RENDER_INTERVAL = 80; // ms

    /**
     * Clear the chat after compaction. Agent-emitted boilerplate (Codex Heads-up,
     * Claude "Compacting completed.", AbortError) is not re-painted — status
     * spinner already covered progress. Show a short client-owned note instead.
     */
    function flushCompactionMessages() {
      if (compactionFlushTimer) { clearTimeout(compactionFlushTimer); compactionFlushTimer = null; }
      if (kiroCompactWatchdog) { clearTimeout(kiroCompactWatchdog); kiroCompactWatchdog = null; }
      hideCompactionProgress();
      var warning = compactedWarningText;
      var notice = compactedNoticeText;
      var wasManual = manualCompacting;
      compactedWarningText = '';
      compactedNoticeText = '';
      if (!warning && !notice) {
        isCompacting = false;
        manualCompacting = false;
        restoreProcessingStatusSpinner();
        return;
      }
     // Preserve queued user messages — handleQueue adds them to chatHistory
     // as user bubbles so the user sees them immediately. Compaction must
     // wipe prior conversation context but NOT destroy messages the user
     // queued during compaction (they are still pending in messageQueue).
     //
     // IMPORTANT: only messages STILL in messageQueue are truly queued
     // (not yet sent to the agent). The user message that triggered the
     // current turn has already been sent — it is part of the compacted
     // conversation and must be cleared, just like assistant messages.
     // Previously we preserved ALL user messages, which left the original
     // prompt floating with no assistant response below it after codex
     // auto-compact replaced the conversation with a summary.
     var _queuedTexts = {};
     for (var _mqi = 0; _mqi < messageQueue.length; _mqi++) {
       if (messageQueue[_mqi].text) _queuedTexts[messageQueue[_mqi].text] = true;
     }
     // Preserve IN-FLIGHT tool calls for the same reason we preserve queued
     // user messages: a tool call that is still running is live state, not
     // compacted-away history. Dropping it broke per-subagent tracking — a
     // spawn_parallel / Agent-Task crew card that was still executing had its
     // DOM destroyed and its entry removed from the toolCalls map, so every
     // later tool_call_update carrying the per-stage status found nothing to
     // update (lookupToolCallEl checks the map, then getElementById, then a
     // fuzzy map scan — all three fail once the card is gone) and the stage
     // rows froze mid-run. Re-rendering them below rebuilds the crew card
     // (with its stages[]) and repopulates toolCalls, so the subagents keep
     // reporting after an auto-compaction.
     function _isLiveToolStatus(s) {
       return s === 'pending' || s === 'running' || s === 'in_progress';
     }
     var _preservedQueue = [];
     var _preserved = [];
     for (var _qi = 0; _qi < chatHistory.length; _qi++) {
       var _qItem = chatHistory[_qi];
       if (!_qItem) continue;
       if (_qItem.kind === 'message' && _qItem.role === 'user') {
         // Only preserve if still queued (not yet sent to the agent).
         var _qText = typeof _qItem.text === 'string' ? _qItem.text : '';
         if (!_queuedTexts[_qText]) continue;
         _preservedQueue.push(_qItem);
         _preserved.push(_qItem);
       } else if (_qItem.kind === 'toolCall' && _isLiveToolStatus(_qItem.status)) {
         _preserved.push(_qItem);
       }
     }
     chatHistory = _preserved;
     messagesEl.innerHTML = '';
     historyRenderGen++;
     for (var _cmpRk in pendingRenderRetries) { delete pendingRenderRetries[_cmpRk]; }
     currentTurnEl = null;
     currentAssistantEl = null;
     currentAssistantText = '';
     currentToolsListEl = null;
     currentToolsCountEl = null;
     currentToolCount = 0;
     toolCalls = {};
     // Reset the in-flight THOUGHT state too. Without this, currentThoughtEl
     // still points at the detached pre-compaction thought block while
     // chatHistory has been replaced. The next tool call runs
     // ensureTurnTools() -> commitOrDiscardCurrentThought(), which reads the
     // stale accumulated reasoning text and — because _historyIndex no longer
     // addresses a 'thought' entry in the new (short) array — PUSHES it into
     // the fresh chatHistory. The pre-compaction reasoning then reappears in
     // the new turn's collapsed fold body and survives resume/reload.
     // clearChat (new conversation) already reset all of this; the compaction
     // wipe did not.
     currentThoughtEl = null;
     currentThoughtTextEl = null;
     currentThoughtText = '';
     thoughtDomBase = '';
     thoughtStartTime = null;
     thoughtEndTime = null;
     // Plan/todo state belongs to the compacted-away conversation as well —
     // leaving currentPlanEl attached to a detached node kept the stale plan
     // chip visible after compaction.
     currentPlanEl = null;
     if (planBar) { planBar.innerHTML = ''; }
     if (typeof clearCursorTodosPlan === 'function') clearCursorTodosPlan();
     // Crew bookkeeping points at the destroyed card; clear it so the
     // re-render below builds a fresh crew (and later spawns extend THAT one
     // instead of a stale id). renderChatHistory does the same on rebuild.
     resetClaudeCrewState();
     // After compaction clear, chatHistory (now empty) belongs to current session.
     chatHistoryOriginSessionId = (sessionState && sessionState.sessionId) || null;
     // Persist the cleared history NOW. Without this, the pre-compaction
     // chatHistory (with its old turn-fold titles) stays in vscode.getState()
     // and is restored on the next webview reload / session resume — the
     // "old chat collapsed title kept in the new session and in resume" bug.
     // The agent has already compacted its own session state, so persisting
     // the (now empty) history is correct here.
     saveState();
     // Re-render preserved items (queued user bubbles + in-flight tool calls)
     // so they are visible after the compaction wipe and, for tool calls, so
     // toolCalls is repopulated and later tool_call_update / per-stage
     // subagent progress can still resolve its element. drainQueue sends the
     // queued messages to the agent without re-adding the bubble (it checks
     // for existing user messages). addToolCallInline does NOT push to
     // chatHistory, so re-rendering cannot duplicate the preserved entries.
     for (var _pri = 0; _pri < _preserved.length; _pri++) {
       var _pItem = _preserved[_pri];
       if (_pItem.kind === 'toolCall') {
         addToolCallInline(
           _pItem.toolCallId,
           _pItem.title,
           _pItem.status,
           _pItem.rawInput && _pItem.rawInput.taskResult
             ? stripTaskResult(_pItem.rawInput)
             : _pItem.rawInput,
           _pItem.toolKind,
           _pItem.locations,
           _pItem.parentToolUseId || null,
         );
       } else {
         addMessageDOM('user', _pItem.text || '(image)');
       }
     }
      toolCallDiffs = {};
      isCompacting = false;
      manualCompacting = false;
      hideEmpty();
      // Swallow late agent boilerplate (Codex Heads-up, Claude AbortError, …).
      suppressPostCompactNoiseUntil = Date.now() + 2500;
     // Manual /compact only — auto-compact continues streaming in the same
     // turn, so a banner would sit on top of the resumed reply.
     if (wasManual) {
       showCompactNotice();
     } else {
       // Auto-compact: the agent often resumes the same turn immediately.
       // Show a brief transient hint ("Context compacted") so the user knows
       // the history was cleared, but do NOT leave a banner in statusEl —
       // the agent's next activity (tool call, message chunk) will restore
       // the plain processing spinner via restoreProcessingStatusSpinner().
       // The hint auto-vanishes after 3s, so it never sits on top of the
       // resumed reply.
       clearCompactNotices();
       if (notice) {
         showTransientHint('Context compacted', 3000);
       }
       restoreProcessingStatusSpinner();
     }
    // For auto-compact, also surface a compact notice in the chat so the
    // user can see that compaction happened (history was cleared). Without
    // this, the chat just continues with tool calls and the user has no
    // indication that earlier context was compacted away.
   if (!wasManual && notice) {
     // Show the actual compaction notice text (e.g. "*Context compacted to
     // fit the model's context window.*") as a DOM-only system message.
     // Do NOT persist to chatHistory — otherwise it survives resume and
     // re-appears as a stale notice after tool calls and assistant messages
     // have already been rendered. The notice is transient: it shows once
     // after compaction and is cleared when the next user message arrives.
     clearCompactNotices();
     var _autoNoticeEl = addMessageDOM('system', notice);
     if (_autoNoticeEl) _autoNoticeEl.classList.add('compact-notice');
   }
    // After manual compaction finishes, drain any messages the user queued
    // during compaction. The compaction's promptEnd has _wasCompacting=true
    // so the normal drain path is skipped — there is no subsequent promptEnd
    // to trigger it. For auto-compact, the turn is still running so
    // isProcessing is true and drainQueue will be a no-op until the turn
    // ends (at which point the normal promptEnd drain handles it).
    if (wasManual && messageQueue.length > 0 && !isProcessing) {
      vscode.postMessage({ type: 'debugLog', message: '[DRAIN-DBG] flushCompactionMessages: draining after manual compact, queue=' + messageQueue.length });
      setTimeout(function() {
        if (!isProcessing && messageQueue.length > 0) {
          drainQueue();
        }
      }, 0);
    }
    // Drain chunks buffered during the post-completed/pre-flush window. These
    // are the first tokens of the resumed reply that arrived while the 400ms
    // flush timer was armed; we held them back so the wipe above wouldn't
    // drop them. currentAssistantText was just reset to '' by the wipe, so
    // appending here renders them cleanly in the fresh panel.
    drainPendingPostCompactChunks();

    // Compaction wiped the conversation, which also removed the previously
    // injected memory/profile block (persona + scenes + <available_skills>)
    // from the model context. Tell the extension host to reset the memory-
    // inject gates for this session so the next real prompt does a full
    // re-inject instead of being gated to l1-only by stale session state.
    // Carry the summary text along. The host cannot recover it from the
    // per-turn capture path (that path skips slash commands, and manual
    // compaction is /compact), so this is the only place the summarized content
    // is available for the memory system.
    vscode.postMessage({
      type: 'compactionCompleted',
      sessionId: (sessionState && sessionState.sessionId) || undefined,
      summaryText: notice || warning || '',
    });
  }

    /** Bare spinner while the turn is still running (no "Compacting…" label). */
    function restoreProcessingStatusSpinner() {
      if (!statusEl) return;
      if (isProcessing) {
        // Don't clobber intentional labeled statuses.
        if (isCompacting || isClearing) return;
        var txt = (statusEl.textContent || '').trim();
        if (/compact|clearing|summarizing/i.test(txt)) return;
        var hasSpinner = !!statusEl.querySelector('.spinner');
        // Bare spinner must be the only content. A flash like
        // "<spinner>3 todos updated" still has .spinner, so the old
        // heal path left the sticky label for the rest of the turn.
        if (!hasSpinner || txt) {
          statusEl.innerHTML = '<span class="spinner"></span>';
        }
      } else {
        statusEl.innerHTML = '';
      }
    }

    /**
     * Agent resumed streaming (message / thought / tool) after or during
     * compact. Flush buffered notices if any; for auto-compact, drop compact
     * UI so "Compacting…" does not sit on top of the live reply. Manual
     * /compact keeps waiting until a real completion notice arrives.
     */
    function endCompactingOnAgentResume() {
      clearCompactNotices();
      if (!isCompacting) {
        // Compact UI may have been left in statusEl after a prior soft exit.
        if (statusEl && /compact/i.test(statusEl.textContent || '')) {
          hideCompactionProgress();
        }
        // Also heal sticky statuses (e.g. "N todos updated" without spinner)
        // whenever the agent resumes streaming mid-turn.
        restoreProcessingStatusSpinner();
        return;
      }
      if (compactedWarningText || compactedNoticeText) {
        flushCompactionMessages();
        return;
      }
      // A flush is already scheduled (a 'tool_call_update completed' with
      // _meta.contextCompaction landed and armed the 400ms timer). A resume
      // signal arriving inside that window - e.g. an agent_message_chunk
      // from the post-compact reply, common when claude-code-acp runs
      // auto-compact AFTER promptEnd - must NOT tear down compaction state,
      // or the pending flush is lost and chat history is never purged. Let
      // the timer fire (it re-checks isCompacting + notice text).
      if (compactionFlushTimer) {
        return;
      }
      // Manual /compact: keep spinner until completion notice / promptEnd.
      if (manualCompacting) {
        return;
      }
      if (compactionFlushTimer) { clearTimeout(compactionFlushTimer); compactionFlushTimer = null; }
      isCompacting = false;
      manualCompacting = false;
      hideCompactionProgress();
      restoreProcessingStatusSpinner();
    }

    function currentAgentLabel() {
      return (sessionState && (sessionState.agentName || sessionState.agentConfigKey || '')) || '';
    }

    function isClaudeAgent() {
      return /claude/i.test(currentAgentLabel());
    }

    /** Pi (pi-acp) signals /compact completion via agent_message_chunk + end_turn,
     *  same pattern as Claude — no _meta.contextCompaction meta. */
    function isPiAgent() {
      return /pi(\\s*agent|-acp)?$/i.test(currentAgentLabel());
    }

    /** Agent post-compact noise that must not land in the chat panel. */
    function isPostCompactBoilerplate(text) {
      var t = String(text || '').trim();
      if (!t) return false;
      if (t.indexOf('*Context compacted') === 0) return true;
      if (/^Warning:\\s*Heads up/i.test(t)) return true;
      if (/conversation compacted/i.test(t) && t.length < 200) return true;
      // In-progress only — "Compacting completed/failed" drives state separately.
      if (/^Compacting\\.\\.\\./i.test(t)) return true;
      // Claude ACP often emits this after a successful /compact as the turn aborts.
      if (/AbortError:\\s*Compaction cancel/i.test(t)) return true;
      if (/Compaction cancel(l)?ed/i.test(t) && t.length < 120) return true;
      return false;
    }

    /**
     * True when a codex-acp agent_message_chunk is the one-line "retrying"
     * notice emitted at the START of an internal retry attempt after a
     * transient failure (upstream 503 "model at capacity" or a transport-level
     * stream disconnect). codex-acp retries silently inside prompt() — the
     * extension host and the webview see NO second promptStart — so without
     * this hook the notice text and the abandoned partial reply from the failed
     * attempt would fuse into the current bubble, and attempt #2's fresh reply
     * would land as a SECOND assistant message after what looked like an
     * end_turn. Matching the exact prefix keeps false positives impossible
     * (the notice is emitted verbatim by CodexEventHandler.createErrorEvent).
     */
    function isRetryBoundaryNotice(text) {
      var t = String(text || '').trim();
      if (!t) return false;
      if (t.indexOf('retrying with backoff') === -1) return false;
      // codex-acp emits exactly one of these two prefixes before the
      // "— retrying with backoff" suffix. Match only those, so no normal
      // assistant reply (which may plausibly quote the phrase) is swallowed.
      return /^The (model is at capacity|connection dropped mid-stream)[^.]*[-—]\\s*retrying with backoff/i.test(t);
    }

    /**
     * Discard the abandoned partial assistant reply from the FAILED attempt of
     * a transient-failure retry, before attempt #2 streams. codex-acp re-sends
     * the prompt after backoff without a fresh promptStart, so the webview
     * would otherwise keep the dead attempt's text and attempt #2 would append
     * to it — the "two assistant messages after end_turn" symptom. This mirrors
     * the promptStart cleanup: kill the in-flight bubble (DOM + buffer +
     * messageId grouping) so the retried turn starts from a clean slate.
     */
    function discardInFlightRetryText() {
      if (currentAssistantEl && currentAssistantText && !currentAssistantEl.classList.contains('md-committed')) {
        if (currentAssistantEl.parentNode) {
          currentAssistantEl.parentNode.removeChild(currentAssistantEl);
        }
        if (currentTurnEl && currentTurnEl.children.length === 0) {
          if (currentTurnEl.parentNode) {
            currentTurnEl.parentNode.removeChild(currentTurnEl);
          }
        }
      }
      // Commit any in-flight reasoning block so it survives the retry (it
      // belongs to the turn, not the failed attempt); then clear the
      // transient streaming state so attempt #2 starts clean.
      commitOrDiscardCurrentThought();
      currentThoughtText = '';
      thoughtDomBase = '';
      thoughtStartTime = null;
      thoughtEndTime = null;
      currentAssistantEl = null;
      currentAssistantText = '';
      currentMessageId = null;
      lastCommittedAssistantEl = null;
      lastCommittedMessageId = null;
      lastCommittedText = '';
      reactivatedHistoryIndex = -1;
      fallbackMessageId = 'turn-' + (Date.now().toString(36)) + '-' + (Math.random().toString(36).slice(2, 8));
      sawRealMessageIdThisTurn = false;
      messageSegmentCounter = 0;
      if (currentTurnEl && currentTurnEl.children.length === 0) {
        if (currentTurnEl.parentNode) {
          currentTurnEl.parentNode.removeChild(currentTurnEl);
        }
      }
      currentTurnEl = null;
      turnTailGraceUntil = 0;
      streamingRenderGen++;
    }

    function compactionNoticeFromSummary(summary) {
      if (!Array.isArray(summary) || !summary.length) return '';
      var parts = [];
      for (var si = 0; si < summary.length; si++) {
        var block = summary[si];
        if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          parts.push(block.text.trim());
        }
      }
      return parts.join('\\n\\n');
    }

    /**
     * Shared compaction lifecycle for Codex _meta.contextCompaction and ACP
     * compaction_update (session-compaction RFD).
     */
    function applyCompactionLifecycleStatus(status, opts) {
      opts = opts || {};
      var loadingReplay = !!opts.loadingReplay;
      var st = String(status || '').toLowerCase();
      if (loadingReplay) {
        if (st === 'completed' || st === 'in_progress') {
          if (!isCompacting) {
            addMessage('system', 'Earlier conversation was compacted — history before this point is unavailable.');
          }
        }
        return;
      }
      if (st === 'in_progress') {
        if (!isCompacting) {
          isCompacting = true;
          manualCompacting = false;
          compactedWarningText = '';
          compactedNoticeText = '';
          if (compactionFlushTimer) { clearTimeout(compactionFlushTimer); compactionFlushTimer = null; }
          pendingPostCompactChunks = [];
          showCompactionProgress('Compacting conversation...', null);
          setProcessing(true, 'contextCompaction-in_progress');
        }
        return;
      }
      if (st === 'failed') {
        isCompacting = false;
        manualCompacting = false;
        compactedWarningText = '';
        compactedNoticeText = '';
        if (compactionFlushTimer) { clearTimeout(compactionFlushTimer); compactionFlushTimer = null; }
        pendingPostCompactChunks = [];
        hideCompactionProgress();
        if (statusEl) statusEl.innerHTML = '';
        setProcessing(false, 'contextCompaction-failed');
        var failMsg = opts.error ? String(opts.error) : '';
        addMessage('error', failMsg || 'Compaction failed');
        return;
      }
      if (st === 'cancelled') {
        isCompacting = false;
        manualCompacting = false;
        compactedWarningText = '';
        compactedNoticeText = '';
        if (compactionFlushTimer) { clearTimeout(compactionFlushTimer); compactionFlushTimer = null; }
        pendingPostCompactChunks = [];
        hideCompactionProgress();
        if (statusEl) statusEl.innerHTML = '';
        setProcessing(false, 'contextCompaction-cancelled');
        return;
      }
      if (st === 'completed') {
        if (!isCompacting) {
          isCompacting = true;
          manualCompacting = false;
          compactedWarningText = '';
          compactedNoticeText = '';
          showCompactionProgress('Compacting conversation...', null);
          setProcessing(true, 'contextCompaction-completed');
        }
        if (!compactedNoticeText) {
          var fromSummary = compactionNoticeFromSummary(opts.summary);
          compactedNoticeText = fromSummary || "*Context compacted to fit the model's context window.*";
        }
        scheduleCompactionFlush();
      }
    }

    function scheduleCompactionFlush() {
      if (compactionFlushTimer) clearTimeout(compactionFlushTimer);
      // Codex sends Warning right after thread/compacted; wait briefly so
      // both land before we paint (Warning → notice).
      compactionFlushTimer = setTimeout(function() {
        compactionFlushTimer = null;
        if (isCompacting && (compactedWarningText || compactedNoticeText)) {
          flushCompactionMessages();
        }
      }, 400);
    }

    function doStreamingRender() {
      streamingRenderPending = false;
      lastRenderTime = Date.now();
      if (currentAssistantEl && currentAssistantText) {
        var _srPreview = currentAssistantText.replace(/\\s+/g, ' ').slice(0, 80);
        vscode.postMessage({ type: 'debugLog', message: '[WV-SRENDER] doStreamingRender: textLen=' + currentAssistantText.length + ' preview="' + _srPreview + '"' });
        vscode.postMessage({ type: 'renderMarkdown', items: [{ index: -1, text: currentAssistantText, gen: streamingRenderGen }] });
      }
    }

    function scheduleStreamingRender() {
      const now = Date.now();
      const elapsed = now - lastRenderTime;
      if (elapsed >= STREAMING_RENDER_INTERVAL) {
        // Enough time passed — render immediately (leading edge)
        if (streamingRenderTimer) { clearTimeout(streamingRenderTimer); streamingRenderTimer = null; }
        doStreamingRender();
      } else if (!streamingRenderTimer) {
        // Schedule trailing edge
        streamingRenderPending = true;
        streamingRenderTimer = setTimeout(() => {
          streamingRenderTimer = null;
          doStreamingRender();
        }, STREAMING_RENDER_INTERVAL - elapsed);
      } else {
        streamingRenderPending = true;
      }
    }

  function handleUpdate(update) {
    if (!update) return;
    logCursorHandleUpdate(update);
    // After a force-cancel (agent didn't acknowledge session/cancel within
    // the fallback window), drop all further session/update notifications
    // so stale chunks from the unresponsive agent don't pollute the chat.
    if (isForceCancelled && !isLoadingSession) {
      return;
    }
    const type = update.sessionUpdate;

    // Replay ORDER trace (see RESUME_DIAG_MARKERS). Logs the order updates
    // ARRIVE at the webview during session/load, plus the state that decides
    // whether the next tool call commits the pending assistant text. If
    // pendTxt=0 when a tool_call arrives even though its text was posted
    // first, the interleave was lost between host post and webview arrival.
    if (isLoadingSession) {
      // Keep the replay-tail window alive for as long as the replay runs, so a
      // chunk that lands right after the response is still adopted.
      loadTailGraceUntil = Date.now() + LOAD_TAIL_GRACE_MS;
      var _ordTxt = update.content && update.content.type === 'text' && update.content.text
        ? String(update.content.text).length : 0;
      resumeDiag('[WV-ORDER] wv-recv #' + (++replayRecvSeq) + ' ' + type +
        ' id=' + (update.messageId || '-') +
        ' len=' + _ordTxt +
        ' pendTxt=' + currentAssistantText.length +
        ' hasAsstEl=' + !!currentAssistantEl +
        ' hist=' + chatHistory.length);
    }

    // [DEBUG-SUBAGENT] Log every update type received by webview
    if (DEBUG && (type === 'agent_message_chunk' || type === 'tool_call' || type === 'agent_thought_chunk')) {
      var _dbgPreview = '';
      if (type === 'agent_message_chunk' || type === 'agent_thought_chunk') {
        _dbgPreview = update.content && update.content.text
          ? update.content.text.replace(/\\s+/g, ' ').slice(0, 60) : '';
      } else if (type === 'tool_call') {
        _dbgPreview = (update.title || '') + ' (toolCallId=' + (update.toolCallId || '').slice(0, 12) + ')';
      }
      vscode.postMessage({ type: 'debugLog', message: '[WV-UPDATE] type=' + type + ' preview="' + _dbgPreview + '" hasCurrentAssistantEl=' + !!currentAssistantEl + ' currentAssistantTextLen=' + currentAssistantText.length + ' hasToolsList=' + !!currentToolsListEl + ' chatHistoryLen=' + chatHistory.length });
    }

     switch (type) {
    case 'agent_message_chunk': {
      const content = update.content;
      // Cursor tools stay pending forever on the wire — when the model
      // resumes with a message, prior plain tools are done.
      if (isCursorAgentSession() && !isLoadingSession && content && content.type === 'text' &&
          String(content.text || '').trim()) {
        completeInFlightToolCalls(null);
      }
      // Suppress "Effort configuration is currently not available on <model>"
      // messages from Kiro CLI when switching to a model that doesn't support
      // effort. These are slash-command responses, not part of the conversation.
      if (content && content.type === 'text' &&
          content.text.trim().startsWith('Effort configuration is currently not available')) {
        break;
      }
      // Suppress Kiro CLI slash-command echo output (e.g. "/effort xhigh"
      // → "Effort set to xhigh"). These are streamed as agent_message_chunk
      // AFTER the host's slash session/prompt already resolved with end_turn
      // (sendSlashCommand posts no promptStart/promptEnd), and when they land
      // right after a state.isPromptInFlight latch they keep the panel stuck
      // on "■ Stop" (Send disabled forever). They are not conversation
      // content — drop them so they never render and never count as turn
      // activity. The single-line form is "Effort set to <level>".
      if (content && content.type === 'text' &&
          /^Effort set to (none|low|medium|high|xhigh|max)\\.?$/.test(content.text.trim())) {
        vscode.postMessage({ type: 'debugLog', message: '[WV-SLASH-ECHO] suppressed Kiro slash echo: "' + content.text.trim() + '"' });
        break;
      }
      // codex-acp internal retry boundary: a "retrying with backoff" notice
      // follows a transient failure (503 model at capacity / stream
      // disconnect). The failed attempt's partial reply is abandoned; discard
      // it and show the notice as a transient system row so the retry is
      // visible, then let attempt #2 stream as a fresh assistant bubble.
      // Without this, the partial text fuses with attempt #2's reply and the
      // retried turn renders as a SECOND assistant message after an end_turn.
      if (!isLoadingSession && content && content.type === 'text' &&
          isRetryBoundaryNotice(content.text)) {
        var _retryTrim = content.text.trim();
        vscode.postMessage({ type: 'debugLog', message: '[WV-RETRY] retry boundary notice: "' + _retryTrim.slice(0, 80) + '" discarding partial from failed attempt (currentAssistantTextLen=' + currentAssistantText.length + ')' });
        discardInFlightRetryText();
        showTransientNotice('Retrying after a transient failure (upstream overload or dropped stream)…');
        break;
      }
      // Drop late post-compact boilerplate so it never lands in the panel.
      if (!isLoadingSession && content && content.type === 'text' &&
          isPostCompactBoilerplate(content.text) &&
          (isCompacting || Date.now() < suppressPostCompactNoiseUntil)) {
        // Still drive Claude progress from "Compacting..." while mid-flight.
        var _noiseTrim = content.text.trim();
        if (isCompacting && /^Compacting\\.\\.\\./i.test(_noiseTrim)) {
          showCompactionProgress('Compacting...', null);
        }
        break;
      }
      // After promptEnd the turn is closed. Claude ACP may keep streaming
      // between turns — ignore so assistants stay per-user-turn.
      // BUT: within the turn-tail grace window (end_turn response landed but
      // the agent's FINAL text chunk is still in transit — Codex, Codex,
      // Claude Code and Kiro all do this), accept the chunk and append it to
      // the last committed assistant bubble. Without this the final answer is
      // silently dropped → premature end_turn / "nothing happened".
      var _inTailGrace = Date.now() <= turnTailGraceUntil;
      // Straggler from the replay we just finished (see loadTailGraceUntil).
      var _inLoadTailGrace = !isLoadingSession && Date.now() <= loadTailGraceUntil;
      if (content && content.type === 'text' && String(content.text || '').trim()) {
        vscode.postMessage({ type: 'debugLog', message: '[WV-CHUNK] text="' + String(content.text).replace(/\\s+/g, ' ').slice(0, 60) + '" len=' + String(content.text).length + ' isLoadingSession=' + isLoadingSession + ' isProcessing=' + isProcessing + ' isCompacting=' + isCompacting + ' inTailGrace=' + _inTailGrace + ' tailGraceUntil=' + turnTailGraceUntil + ' now=' + Date.now() + ' messageId=' + (update.messageId || '') });
      }
      if (!isLoadingSession && !isProcessing && !isCompacting && !_inTailGrace && !_inLoadTailGrace) {
        vscode.postMessage({ type: 'debugLog', message: '[WV-CHUNK-DROP] dropped: text="' + (content && content.text ? String(content.text).replace(/\\s+/g, ' ').slice(0, 60) : '') + '" isLoadingSession=' + isLoadingSession + ' isProcessing=' + isProcessing + ' isCompacting=' + isCompacting + ' inTailGrace=' + _inTailGrace + ' loadTailGrace=' + _inLoadTailGrace });
        break;
      }
      // A replay straggler has no promptEnd behind it, so nothing would ever
      // commit it to chatHistory or re-run the promote that decides which reply
      // is the visible summary. Attach it to the turn the replay just rendered
      // and schedule that commit + promote ourselves.
      if (_inLoadTailGrace && content && content.type === 'text' && String(content.text || '').trim()) {
        adoptLoadTailChunk(String(content.text).length);
      }
      // A proposed_plan block is the other way a plan arrives (codex and codex
      // ask the model to wrap the finished plan in one), so it also arms the
      // implement-plan handoff offered at promptEnd.
      if (content && content.type === 'text' && String(content.text || '').indexOf('<proposed_plan') >= 0) {
        sawPlanThisTurn = true;
      }
      // Real agent activity — the state.isPromptInFlight latch was genuine.
      if (_pendingStaleInFlightWatchdogTimer) { clearTimeout(_pendingStaleInFlightWatchdogTimer); _pendingStaleInFlightWatchdogTimer = null; }
      // Detect auto-compaction: if the agent sends "*Context compacted*" text
      // without a preceding contextCompaction tool_call, treat it as compaction.
      // Also recognize Kiro CLI "Conversation compacted" notices and Claude's
      // "Compacting..." / "Compacting completed." progress text.
      // Skip during session/load — that text is historical, not a live /compact.
      if (!isLoadingSession && content && content.type === 'text') {
        var _autoTrim = content.text.trim();
        // CRITICAL: only treat agent_message_chunk text as a compaction
        // notice when it is a SHORT STANDALONE message (not part of a
        // longer assistant reply). When the LLM writes ABOUT compaction
        // (e.g. commit messages mentioning "Conversation compacted."),
        // the streaming text accumulates into currentAssistantText and
        // must NOT trigger compaction — otherwise flushCompactionMessages()
        // wipes the entire chatHistory, destroying the conversation.
        var _isStandaloneNotice = currentAssistantText.trim().length === 0 &&
          _autoTrim.length < 200;
        // Claude ACP: AbortError after compact must not clear or pollute chat.
        if (/AbortError:\\s*Compaction cancel/i.test(_autoTrim) ||
            (/Compaction cancel(l)?ed/i.test(_autoTrim) && _autoTrim.length < 120)) {
          if (isCompacting && (compactedWarningText || compactedNoticeText)) {
            flushCompactionMessages();
          } else if (isCompacting) {
            // Spurious cancel with no success notice yet — drop compacting state.
            isCompacting = false;
            if (kiroCompactWatchdog) { clearTimeout(kiroCompactWatchdog); kiroCompactWatchdog = null; }
            hideCompactionProgress();
            if (statusEl) statusEl.innerHTML = '';
            setProcessing(false, 'chunk-compaction-cancel');
          }
          break;
        }
        if (!isCompacting && _isStandaloneNotice && (
            _autoTrim.indexOf('*Context compacted') === 0 ||
            /conversation compacted/i.test(_autoTrim) ||
            /^Compacting\\.\\.\\./i.test(_autoTrim))) {
           isCompacting = true;
           manualCompacting = false;
           compactedWarningText = '';
           compactedNoticeText = '';
           showCompactionProgress(
             /^Compacting/i.test(_autoTrim) ? 'Compacting...' : 'Compacting conversation...',
             null,
           );
           setProcessing(true, 'chunk-auto-compact-notice');
         }
         // Claude ACP adapter: "Compacting completed." / "Compacting failed..."
         if (isCompacting && /^Compacting (completed|failed)/i.test(_autoTrim)) {
           if (/failed/i.test(_autoTrim)) {
             isCompacting = false;
             if (kiroCompactWatchdog) { clearTimeout(kiroCompactWatchdog); kiroCompactWatchdog = null; }
             hideCompactionProgress();
             if (statusEl) statusEl.innerHTML = '';
             setProcessing(false, 'chunk-compaction-failed');
             addMessage('error', 'Compaction failed.');
             break;
           }
           finalizeKiroCompact(_autoTrim);
           break;
         }
       }
       // During compaction: Codex emits "*Context compacted*" then
       // "Warning: Heads up…". Kiro emits "Conversation compacted…".
       // Buffer notices and flush Warning-first when present.
      if (isCompacting) {
         var chunkText = content && content.type === 'text' ? content.text : '';
         var trimmedChunk = chunkText.trim();
         // Only buffer short standalone chunks as compaction notices.
         // When currentAssistantText already has content, the LLM is
         // streaming a normal reply that merely mentions compaction.
         var _bufferIsStandalone = currentAssistantText.trim().length === 0 &&
           trimmedChunk.length < 200;
         // Don't buffer Claude's in-progress "Compacting..." as a notice.
         if (/^Compacting\\.\\.\\./i.test(trimmedChunk)) {
           showCompactionProgress(trimmedChunk, null);
           break;
         }
         var isWarning = trimmedChunk.indexOf('Warning:') === 0;
         var isCompactNotice = _bufferIsStandalone && (
           trimmedChunk.indexOf('*Context compacted') === 0 ||
           /conversation compacted/i.test(trimmedChunk) ||
           /^Compacting completed/i.test(trimmedChunk)
         );
         if (isWarning) {
            compactedWarningText += chunkText;
            // Notice usually arrived first — flush now that we have both.
            if (compactedNoticeText) {
              flushCompactionMessages();
            } else {
              scheduleCompactionFlush();
            }
            break;
          }
          if (isCompactNotice) {
            compactedNoticeText += chunkText;
            scheduleCompactionFlush();
            break;
          }
          // Real post-compaction content — flush buffered notices, then stream.
          // Auto-compact may resume with no notice — drop compact UI and stream.
          // Manual /compact keeps waiting for a completion signal.
          if (compactedWarningText || compactedNoticeText) {
            flushCompactionMessages();
          } else if (manualCompacting) {
            break;
          } else {
            endCompactingOnAgentResume();
          }
       }
        if (content && content.type === 'text' && content.text) {
          // Agent resumed after compact — drop banner / compact status.
          // BUT if a compaction flush is already scheduled (a 'tool_call_update
          // completed' with _meta.contextCompaction landed and armed the 400ms
          // timer), do NOT tear down compaction state or start rendering the
          // resumed reply yet: the pending flush will wipe the chat history,
          // so rendering these chars now would render-then-wipe-then-rerender.
          // Buffer them instead and let the flush drain them into the fresh
          // panel. This is the claude-code-acp auto-compact case where the
          // resumed reply streams inside the post-completed flush window.
          // Also buffer when isCompacting is true but no flush timer is armed
          // yet - claude-code-acp reorders auto-compact to emit "completed"
          // AFTER the continuation, so continuation text arrives while
          // isCompacting=true but compactionFlushTimer is null. Without this,
          // endCompactingOnAgentResume tears down isCompacting and the
          // later "completed" lifecycle finds isCompacting=false -> no wipe.
          if (compactionFlushTimer || isCompacting) {
            pendingPostCompactChunks.push(content.text);
            break;
          }
          // The flush timer is not armed. If the buffer still holds chunks, the
          // timer was cleared by a failed/superseded compaction (or the session
          // was reset) while the resumed reply was streaming — those tokens
          // would otherwise be stranded. Drain them into currentAssistantText
          // (preserving order: buffered first, then this chunk appended below)
          // before continuing.
          drainPendingPostCompactChunks();
          endCompactingOnAgentResume();
          // ACP messageId grouping: if this chunk carries the SAME messageId as
          // the segment a tool call just split off (currentAssistantEl is null
          // but lastCommittedMessageId matches), REATTACH to that bubble instead
          // of starting a new one. This is what makes text→tool→text render as
          // one continuous assistant message. Without messageId (legacy agents),
          // lastCommittedMessageId is null and this never matches → old behavior.
          var _incomingMessageId = typeof update.messageId === 'string' ? update.messageId : null;
          if (_incomingMessageId) {
            sawRealMessageIdThisTurn = true;
         } else if (!sawRealMessageIdThisTurn) {
           // The agent never sent a real messageId yet in this turn (legacy
           // kiro-cli / old codex / pi-acp). Use a stable synthetic id for
           // bubble grouping within a single text segment. Do NOT increment
           // here — ++ on every chunk made each token a new messageId, so
           // the mid-stream "id changed" branch committed one word per bubble
           // (Pi "hi" rendered as one word per line). Bump the counter only
           // when a tool call splits the turn (addToolCall).
           _incomingMessageId = fallbackMessageId + '-seg-' + messageSegmentCounter;
         }
          if (
            !currentAssistantEl &&
            _incomingMessageId &&
            _incomingMessageId === lastCommittedMessageId &&
            lastCommittedAssistantEl
          ) {
            // Reattach to the bubble a tool call just split off. Strip
            // md-committed so doStreamingRender's index:-1 path will paint the
            // appended text (markdownRendered skips md-committed bubbles — see
            // the index===-1 guard). md-committed is re-added at the next commit.
            currentAssistantEl = lastCommittedAssistantEl;
            currentAssistantText = lastCommittedText;
            currentMessageId = lastCommittedMessageId;
            currentAssistantEl.classList.remove('md-committed');
            // Remember the chatHistory entry created at the prior commit so the
            // next commitCurrentTextSegment UPDATES it in place (full text)
            // instead of pushing a duplicate. Avoids splicing (which would
            // shift the data-history-index of every later tool entry).
            reactivatedHistoryIndex = parseInt(
              currentAssistantEl.getAttribute('data-history-index') || '-1', 10);
          } else if (
            currentAssistantEl &&
            _incomingMessageId &&
            currentMessageId &&
            _incomingMessageId !== currentMessageId
          ) {
            // messageId changed mid-stream (new message) — commit the current
            // bubble so the new message starts fresh.
            commitCurrentTextSegment({ interim: true });
            currentMessageId = _incomingMessageId;
         } else if (!currentMessageId && _incomingMessageId) {
           // First chunk of a messageId-carrying message.
           currentMessageId = _incomingMessageId;
         } else if (
           !currentAssistantEl &&
           _incomingMessageId &&
           _incomingMessageId !== lastCommittedMessageId
         ) {
           // After a tool-call split, currentAssistantEl is null and
           // currentMessageId was cleared. If the incoming messageId is
           // DIFFERENT from the last committed one (a new message, not a
           // reattach), start a fresh bubble with the new messageId.
           currentMessageId = _incomingMessageId;
         }
          currentAssistantText += content.text;
                    // Flush /ps panel — assistant is producing content
                    dismissPsPanel(false);
          // Don't create visible element until there's non-whitespace content
          if (!currentAssistantEl && !currentAssistantText.trim()) {
            break;
          }
          // Commit the in-progress thought when assistant text starts so it
          // stays in the turn (and history) and the next thought gets a new block.
          if (currentThoughtEl || currentThoughtText || thoughtDomBase) {
             commitOrDiscardCurrentThought();
           }
           // Non-compact: close the tools group so new text appears below it
           // (interleaved text/tool ordering). Compact mode keeps one group per
           // turn — ensureTurnTools() will reuse it when more tools arrive.
           if (!compactMode && currentToolsListEl && !currentAssistantEl) {
             currentToolsListEl = null;
             currentToolsCountEl = null;
             currentToolCount = 0;
           }
           if (!currentAssistantEl) {
             // Create a turn container, assistant text goes inside it
             if (!currentTurnEl) {
               currentTurnEl = document.createElement('div');
               currentTurnEl.className = 'turn';
               messagesEl.appendChild(currentTurnEl);
               hideEmpty();
             }
            currentAssistantEl = document.createElement('div');
            currentAssistantEl.className = 'message assistant';
            placeAssistantInTurn(currentAssistantEl);
            // Don't set textContent here — leave the element empty until the
            // first streaming markdown render completes. Setting raw text
            // immediately causes a flash of unrendered markdown (e.g. a stray
            // "I" from the first chunk) that disappears once the async render
            // round-trips through the extension host. An empty bubble for a
            // few ms is preferable to flashing raw markdown.
          } else if (!currentAssistantEl.classList.contains('md-rendered')) {
            // Still waiting for first render — keep empty to avoid raw flash
          } else {
            // Already md-rendered: update the raw text content as a data
            // attribute so the next streaming render picks up the full text.
            // We don't update textContent here to avoid flashing raw markdown.
          }
          // Once md-rendered, new chunks still trigger scheduleStreamingRender()
          // which sends the FULL currentAssistantText for re-rendering.
          // During session replay, skip per-chunk streaming renders —
          // the text will be batch-rendered at loadSessionEnd after the
          // DOM is rebuilt from chatHistory.
         if (!isLoadingSession) {
           scheduleStreamingRender();
           scheduleProvisionalSummaryPromote();
         }
         // Turn-tail chunk: accepted during the post-end_turn grace window.
         // isProcessing is already false, so there is no streaming turn to
         // keep this text alive in — commit it to chatHistory immediately so
         // the final answer renders (and survives the next promptStart's
         // orphaned-element cleanup). Otherwise the appended text would live
         // only in the live (uncommitted) assistant element and be removed as
         // an orphaned slash-command bubble on the next turn.
         if (_inTailGrace && currentAssistantEl && currentAssistantText) {
           commitCurrentTextSegment();
         }
         autoScrollIfAtBottom();
       }
       break;
      }

      case 'user_message_chunk': {
        // Session/load replay uses UMC to reconstruct user turns.
        // Live Claude ACP also emits UMC (prompt echo + <task-notification>
        // subagent results). Those must NOT finalize the live turn or coalesce
        // into the user bubble — the webview already added the user message
        // locally, and task-notifications would mash all assistants into one fold.
        const content = update.content;
        if (content && content.type === 'text' && typeof content.text === 'string') {
          // A steered message coming back from the agent is its only delivery
          // receipt: drop the queued copy so it is neither shown twice nor
          // re-sent at promptEnd.
          if (!isLoadingSession && typeof ackSteeredQueueEntry === 'function') {
            ackSteeredQueueEntry(content.text);
          }
          var _dbgChunk = content.text.length > 150 ? content.text.substring(0, 150) + '...' : content.text;
          resumeDiag('UMC chunk: len=' + content.text.length + ' isLoading=' + isLoadingSession + ' text="' + _dbgChunk + '"');
        }
        if (!isLoadingSession) {
          break;
        }
        if (content && content.type === 'text' && typeof content.text === 'string') {
          // Subagent task-notification blobs are not user turns.
          //
          // ANCHORED on purpose. This used to test the whole body, so any user
          // message that merely MENTIONED "<task-notification>" anywhere was
          // discarded during replay. A fork handoff carrying a transcript that
          // discussed the tag lost its first user message: the turn's thought,
          // summary and tool calls stayed at the top of chatHistory with no
          // prompt above them (an orphaned thinking block), and the next user
          // message rendered after them, so the turn looked reversed.
          if (/^\\s*<task-notification[\\s>]/i.test(content.text)) {
            break;
          }
          // Claude interrupt notice — keep in history for fold heuristics, but
          // never coalesce onto the real user prompt and never show as a bubble.
          if (isSessionInterruptNotice(content.text)) {
            finalizeCurrentAssistantTurn();
            var _lastHist = chatHistory[chatHistory.length - 1];
            if (!(_lastHist && _lastHist.kind === 'message' && _lastHist.role === 'user' &&
                  isSessionInterruptNotice(_lastHist.text))) {
              chatHistory.push({ kind: 'message', role: 'user', text: String(content.text).trim() });
            }
            markSessionInterrupted();
            break;
          }
          // Strip injected context blocks from replayed user messages.
          // Uses the shared cleanUserMessage helper defined above.
         var _umcBeforeUsers = countRealUserMessages(chatHistory);
         var _umcBeforeTurns = messagesEl.querySelectorAll('.turn').length;
         var _umcBeforeLen = chatHistory.length;
         resumeDiag(
           '[WV-DIAG] UMC pre-finalize: users=' + _umcBeforeUsers +
           ' turns=' + _umcBeforeTurns +
           ' chatLen=' + _umcBeforeLen +
           ' chunkLen=' + content.text.length
         );
         finalizeCurrentAssistantTurn();
         // session/load emits one complete user turn per chunk (not streaming
         // deltas). Never coalesce onto the previous user — Codex often replays
         // back-to-back user_message_chunk rows with no tool_call between them
         // (e.g. "passed?" then "commit code"), which must stay separate turns.
         var cleanedNew = cleanUserMessage(content.text);
         if (!String(cleanedNew || '').trim()) {
           var rawFallback = String(content.text || '').trim();
           if (rawFallback && !isSessionInterruptNotice(rawFallback) && !isMachineContextOnly(rawFallback)) {
             cleanedNew = rawFallback;
           }
         }
         resumeDiag(
           'UMC load-turn: len=' + (cleanedNew ? cleanedNew.length : 0) +
           ' text="' + (cleanedNew && cleanedNew.length > 150 ? cleanedNew.substring(0, 150) + '...' : (cleanedNew || '')) + '"'
         );
         if (!String(cleanedNew || '').trim()) break;
         addMessage('user', cleanedNew);
         resumeDiag(
           '[WV-DIAG] UMC post-add: users=' + countRealUserMessages(chatHistory) +
           ' turns=' + messagesEl.querySelectorAll('.turn').length +
           ' chatLen=' + chatHistory.length +
           ' (each UMC finalizeCurrentAssistantTurn → new turn boundary)'
         );
          } else if (content && (content.type === 'resource' || content.type === 'resource_link')) {
            // ACP "resource"/"resource_link" blocks attached to a user
            // message — editor selections, file/directory mentions,
            // terminal output and diagnostics all flow through here.
            // Render each as a compact pill via formatResourcePill.
            var uri = content.type === 'resource'
              ? (content.resource && content.resource.uri) || ''
              : content.uri || '';
            var pillText = formatResourcePill(uri, content.type === 'resource_link' ? content.name : null);
            if (pillText) {
              finalizeCurrentAssistantTurn();
              var lastBlock = chatHistory[chatHistory.length - 1];
              if (lastBlock && lastBlock.kind === 'message' && lastBlock.role === 'user') {
                lastBlock.text += pillText;
                var allUserBlocks = messagesEl.querySelectorAll('.message.user');
                var elBlock = allUserBlocks[allUserBlocks.length - 1];
                if (elBlock) { elBlock.textContent = lastBlock.text; }
              } else {
                addMessage('user', pillText);
              }
            }
          }
          break;
        }

       case 'agent_thought_chunk': {
         const content = update.content;
         if (content && content.type === 'text') {
           endCompactingOnAgentResume();
           // Stale replay tail: a thought with no turn to attach to would be
           // appended after the whole conversation. See
           // shouldDropIdleThoughtChunk for why (and the measured case).
           var _thoughtTailGrace = Date.now() <= turnTailGraceUntil;
           if (shouldDropIdleThoughtChunk(isLoadingSession, isProcessing, isCompacting, _thoughtTailGrace)) {
             resumeDiag('[WV-DIAG] thought-drop: idle chunk, no active turn (len=' +
               String(content.text || '').length + ')');
             break;
           }
           // Cursor: model thinking again means prior tools finished.
           if (isCursorAgentSession() && !isLoadingSession && String(content.text || '').trim()) {
             completeInFlightToolCalls(null);
           }
           currentThoughtText += content.text;
           // Don't mount an empty Thinking… card — it flashes then vanishes when
           // tools arrive before any real text (same idea as assistant bubbles).
           if (!currentThoughtEl && !(thoughtDomBase + currentThoughtText).trim()) {
             if (!thoughtStartTime) thoughtStartTime = Date.now();
             break;
           }
           if (!currentThoughtEl) {
              // If there is accumulated assistant text from a previous turn
              // (e.g. codex replay: agent_message_chunk from turn 1 is
              // coalesced and flushed together with turn 2's
              // agent_thought_chunk), commit it to chatHistory NOW so it
              // gets the correct history index -- before the new thought
              // block is created and committed. Without this, the assistant
              // text is only committed at finalizeCurrentAssistantTurn() at
              // the very end of session/load, giving it a much higher index
              // than the thoughts and tools that actually came after it.
              // This was the root cause of thinking block always showing at
              // the bottom in codex collapsed mode.
              // Gate on isLoadingSession to avoid disrupting live streaming
              // where a second thought phase in the same turn should NOT
              // reset the turn or commit mid-stream text prematurely.
              if (isLoadingSession && currentAssistantText && currentAssistantEl) {
                finalizeCurrentAssistantTurn();
              }
              // Close the tools group so this thought (and later tools) stay in
              // chronological order. placeThoughtInTurn also clears the list.
              if (currentToolsListEl) {
                currentToolsListEl = null;
                if (!compactMode) {
                  currentToolsCountEl = null;
                  currentToolCount = 0;
                }
              }
              if (!currentTurnEl) {
                currentTurnEl = document.createElement('div');
                currentTurnEl.className = 'turn';
                messagesEl.appendChild(currentTurnEl);
                hideEmpty();
              }
              // Each LLM thinking phase gets its own separate block.
              // Only resume a thought block if it is still actively streaming
              // (safety net for split chunks arriving with no gap). When tools
              // or assistant text arrived between thinking phases, create a NEW
              // block so the interleaved order (thought → tools → thought) is
              // preserved visually — each reasoning phase is distinct.
              var streamingThoughts = currentTurnEl.querySelectorAll('.thought-block.streaming');
              var existingThought = streamingThoughts.length
                ? streamingThoughts[streamingThoughts.length - 1]
                : null;
           if (existingThought) {
             currentThoughtEl = existingThought;
             currentThoughtTextEl = existingThought.querySelector('.thought-content');
             attachThoughtContentScrollTracker(currentThoughtTextEl);
             attachThoughtExpandTracker(existingThought);
             thoughtDomBase = (currentThoughtTextEl && currentThoughtTextEl.textContent) || '';
             if (thoughtDomBase && !/\\n$/.test(thoughtDomBase)) thoughtDomBase += '\\n\\n';
              // Keep the just-received chunk in currentThoughtText; don't wipe it.
              thoughtEndTime = null;
              currentThoughtEl.classList.add('streaming');
              currentThoughtEl._thoughtCommitted = false;
              // _historyIndex is preserved from the prior commit so that
              // commitOrDiscardCurrentThought updates the existing entry
              // instead of pushing a duplicate thought to chatHistory.
              var existingSummary = currentThoughtEl.querySelector('summary');
               if (existingSummary) {
                 existingSummary.innerHTML = '<span class="thought-indicator"></span> Thinking\u2026';
               }
               if (!thoughtStartTime) thoughtStartTime = Date.now();
             } else {
                currentThoughtEl = document.createElement('details');
                currentThoughtEl.className = 'thought-block streaming';
                currentThoughtEl.open = false;
                currentThoughtEl.innerHTML =
                   '<summary><span class="thought-indicator"></span> Thinking\u2026</summary>' +
                   '<div class="thought-content"></div>';
                currentThoughtTextEl = currentThoughtEl.querySelector('.thought-content');
                // Track user scroll within the thought content so streaming
                // chunks don't yank the user back to the top when they've
                // scrolled down to read.
               attachThoughtContentScrollTracker(currentThoughtTextEl);
               attachThoughtExpandTracker(currentThoughtEl);
               // Append in turn order inside the fold (do not replace prior thoughts).
               placeThoughtInTurn(currentThoughtEl);
               if (!thoughtStartTime) thoughtStartTime = Date.now();
               thoughtDomBase = '';
              }
            }
           var displayThought = (thoughtDomBase + currentThoughtText).replace(/^\\s+/, '').replace(/\\n{3,}/g, '\\n\\n');
           if (currentThoughtTextEl) currentThoughtTextEl.textContent = displayThought;
           // Auto-scroll the thought content to bottom when expanded, so the
           // streaming text stays visible. BUT only if the user hasn't scrolled
           // up to read earlier content — respect their scroll position.
          if (currentThoughtEl && currentThoughtEl.open && currentThoughtTextEl) {
            // _userScrolledUp is set by the thought-content scroll listener
            // (attached when the block is created). If the user scrolled up,
            // don't yank them back down — let them read in peace.
            if (!currentThoughtTextEl._userScrolledUp) {
              currentThoughtTextEl.scrollTop = currentThoughtTextEl.scrollHeight;
            }
          }
          autoScrollIfAtBottom();
         }
         break;
        }

    case 'tool_call': {
      // Codex contextCompaction tool cards are suppressed; completion still
      // clears history (some paths emit completed as tool_call, not update).
      if (update._meta && update._meta.contextCompaction) {
        applyCompactionLifecycleStatus(update.status, { loadingReplay: isLoadingSession });
        break;
      }
      // Kiro "Summarizing"/"summary" tool calls are redundant with the main
      // agent's agent_message_chunk summary — always suppress (with or without
      // taskResult), otherwise they reappear as a wrapped tool block on resume.
      var _tcTitle = (update.title || '').toLowerCase();
      var _tcToolName = update._meta && update._meta.kiro && update._meta.kiro.toolName
        ? update._meta.kiro.toolName.toLowerCase() : '';
      if (isKiroSummaryToolTitle(update.title, _tcToolName)) {
        break;
      }
      // Cursor stub tool_call before cursor/task — drop; rich UI comes from cursor/task.
      if (isCursorTaskPlaceholder(update.title, update.rawInput)) {
        break;
      }
      // Cursor Update TODOs stub — drop; board comes from cursor/update_todos.
      if (isCursorUpdateTodosPlaceholder(update.title, update.rawInput)) {
        break;
      }
      // Non-compaction tool — agent is working again; clear compact status.
      // Keep the banner spinner alive on every tool call (Codex keeps it
      // spinning for the whole turn; Cursor/Kiro status flashes must not
      // leave a dead status slot).
      if (!isCompacting) {
        endCompactingOnAgentResume();
        restoreProcessingStatusSpinner();
      }
      const tc = update;
      var _parentId = update._meta && update._meta.claudeCode && update._meta.claudeCode.parentToolUseId;
      var _claudeToolName = update._meta && update._meta.claudeCode && update._meta.claudeCode.toolName;
      // Claude Agent: live title is usually "Task"; session/load resume often
      // uses the task description as title with kind=think. Normalize to Task
      // for spawn/crew heuristics and keep the description on rawInput.
      var _tcTitleForUi = tc.title || 'Tool Call';
      var _tcRawInput = tc.rawInput && tc.rawInput.taskResult
        ? stripTaskResult(tc.rawInput)
        : tc.rawInput;
      if (_claudeToolName === 'Agent' || looksLikeClaudeAgentSpawn(_tcTitleForUi, _tcRawInput, _claudeToolName)) {
        if (_tcRawInput && typeof _tcRawInput === 'object') {
          _tcRawInput = Object.assign({}, _tcRawInput);
          if (!_tcRawInput._toolName) _tcRawInput._toolName = 'Agent';
          if (!_tcRawInput.description && _tcTitleForUi &&
              _tcTitleForUi !== 'Task' && _tcTitleForUi !== 'Tool Call' && _tcTitleForUi !== 'Agent') {
            _tcRawInput.description = _tcTitleForUi;
          }
        } else if (_tcTitleForUi && _tcTitleForUi !== 'Task' && _tcTitleForUi !== 'Tool Call') {
          _tcRawInput = { description: _tcTitleForUi, _toolName: 'Agent' };
        } else {
          _tcRawInput = Object.assign({}, (_tcRawInput && typeof _tcRawInput === 'object') ? _tcRawInput : {}, {
            _toolName: 'Agent',
          });
        }
        _tcTitleForUi = 'Task';
      }
      addToolCall(
        tc.toolCallId || 'unknown',
        _tcTitleForUi,
         normalizeLiveToolStatus(tc.status),
        tc.content,
        _tcRawInput,
        tc.kind,
        tc.locations,
        _parentId || null,
      );
      // Live stub enrich: extension host polls store.db by toolCallId and sends
      // tool_call_update — do not trigger full batch enrich from the webview.
      break;
     }

    case 'tool_call_update': {
      // Codex contextCompaction lifecycle — never push codex-core titles into
      // the status bar. On completed, clear chat history (manual /compact and
      // auto-compact both rely on this; the text notice may arrive after
      // promptEnd or not at all).
      if (update._meta && update._meta.contextCompaction) {
        applyCompactionLifecycleStatus(update.status, { loadingReplay: isLoadingSession });
        break;
      }
      // Strip taskResult from tool_call_update rawInput too (Kiro may
      // send an update with the full taskResult markdown).
      var _tcuTitle = update.title || '';
      var _tcuToolName = update._meta && update._meta.kiro && update._meta.kiro.toolName
        ? update._meta.kiro.toolName : '';
      if (isKiroSummaryToolTitle(_tcuTitle, _tcuToolName)) {
        break;
      }
      var _tcuRawInput = update.rawInput && update.rawInput.taskResult
        ? stripTaskResult(update.rawInput)
        : update.rawInput;
      // status may be omitted (e.g. Cursor store.db enrich patch that only
      // fills title/rawInput) — pass undefined so updateToolCall keeps the
      // current icon/status instead of forcing "running".
      var _tcuStatus = update.status == null
        ? undefined
        : normalizeLiveToolStatus(update.status);
      var _tcuContent = update.content;
      // Cursor keeps status "pending" on tool_call_update even after results
      // arrive. If content is present, the tool finished — stop the spinner.
      if (_tcuStatus &&
          (_tcuStatus === 'pending' || _tcuStatus === 'running' || _tcuStatus === 'in_progress') &&
          Array.isArray(_tcuContent) && _tcuContent.length > 0) {
        _tcuStatus = 'completed';
      }
      if (!isCompacting && (_tcuStatus || update.title || update.content || _tcuRawInput)) {
        restoreProcessingStatusSpinner();
      }
      updateToolCall(
        update.toolCallId || 'unknown',
        _tcuStatus,
         update.title,
         _tcuContent,
          _tcuRawInput,
       );
       break;
     }

        case 'plan': {
          addPlan(update);
          if ((update.entries || []).length > 0) sawPlanThisTurn = true;
          break;
        }

        case 'plan_update': {
         // Incremental plan update — merge into the current plan.
         // PlanUpdateContent can be "items", "file", or "markdown".
         const planUpdate = update.plan;
         if (planUpdate) {
           if (planUpdate.type === 'items' && planUpdate.items) {
             // Replace entries in the current plan
             addPlan({ entries: planUpdate.items });
           } else if (planUpdate.type === 'markdown' && planUpdate.markdown) {
             // Show as text — fall back to addPlan with a synthetic entry
             addPlan({ entries: [{ content: planUpdate.markdown, priority: 'high', status: 'in_progress' }] });
           } else if (planUpdate.type === 'file' && planUpdate.uri) {
             // File-type plans are normally resolved to markdown by the
             // extension host before reaching the webview. This is a fallback
             // that shows the URI as a clickable link.
             addPlan({ entries: [{ content: '[Plan file: ' + planUpdate.uri + '](' + planUpdate.uri + ')', priority: 'high', status: 'in_progress' }] });
           }
         }
         break;
       }

        case 'plan_removed': {
          // Agent cleared the plan — remove it from the UI.
          const planId = update.id;
          const idx = chatHistory.findIndex(i => i.kind === 'plan');
          if (idx >= 0) {
            chatHistory.splice(idx, 1);
            saveState();
            if (currentPlanEl) {
              currentPlanEl.remove();
              currentPlanEl = null;
            }
          }
          break;
        }

        case 'current_mode_update': {
          // Server pushed a mode change
          currentModeId = update.currentModeId || update.modeId || null;
          const current = availableModes.find(m => m.id === currentModeId);
          if (current) {
            modePickerLabel.textContent = current.name;
            renderModeDropdown();
          }
          // Also update configOptions if they're being used (Pi uses configOptions)
          if (configOptions.length > 0) {
            const modeOpt = configOptions.find(o => o.category === 'mode' || o.category === 'thought_level');
            if (modeOpt) {
              modeOpt.selected = update.currentModeId || update.modeId;
              renderConfigPickers(configOptions);
            }
          }
          break;
        }

        case 'config_option_update': {
          // Server pushed a full configOptions replacement
          setConfigOptionsState(update.configOptions || []);
          break;
        }

       case 'available_commands_update':
         availableCommands = update.availableCommands || [];
         updatePlaceholder();
         break;

      case 'usage_update':
        updateTokenUsage(update);
        break;

      case 'compaction_update':
        applyCompactionLifecycleStatus(update.status, {
          summary: update.summary,
          error: update.error,
          loadingReplay: isLoadingSession,
        });
        break;

      case 'session_info_update': {
        // Extract goal snapshot from _meta.codex.goal (codex-acp extension).
        var _goalMeta = update._meta && update._meta.codex && update._meta.codex.goal;
        if (_goalMeta !== undefined) {
          goalSnapshot = _goalMeta;
          renderGoalChip();
        }
        break;
      }
      }
    }

  // Debounce token usage updates: during multi-iteration tool loops
  // (especially after compaction), the agent sends multiple usage_update
  // events in rapid succession. Without debouncing, the ring flickers
  // between values faster than the 0.3s CSS transition can animate.
  var _tokenUsageDebounce = null;
  function updateTokenUsage(update) {
    tokenUsage = { used: update.used, size: update.size, cost: update.cost };
    if (!tokenUsageRing) return;
    if (_tokenUsageDebounce) clearTimeout(_tokenUsageDebounce);
    _tokenUsageDebounce = setTimeout(function() {
      _tokenUsageDebounce = null;
      updateTokenUsageDOM();
    }, 400);
  }

  // ── Goal chip rendering ──────────────────────────────────────────
  // Renders the current goal snapshot (from _meta.codex.goal in
  // session_info_update) as a chip in the session banner.
  // Supports pause/clear buttons that send goalControl messages.
  var goalChipEl = document.getElementById('goalChip');
  var goalTextEl = document.getElementById('goalText');
 var goalStatusEl = document.getElementById('goalStatus');
 var goalProgressEl = document.getElementById('goalProgress');
 var goalPauseBtn = document.getElementById('goalPauseBtn');
 var goalClearBtn = document.getElementById('goalClearBtn');

 // Tick the goal chip elapsed time every second while active.
 var goalTickInterval = null;
 function startGoalTick() {
   if (goalTickInterval) return;
   goalTickInterval = setInterval(function() {
     if (goalSnapshot && goalSnapshot.status === 'active') {
       renderGoalChip();
     }
   }, 1000);
 }
 function stopGoalTick() {
   if (goalTickInterval) { clearInterval(goalTickInterval); goalTickInterval = null; }
 }

 if (goalPauseBtn) {
    goalPauseBtn.addEventListener('click', function() {
      vscode.postMessage({ type: 'goalControl', action: 'pause' });
    });
  }
  if (goalClearBtn) {
    goalClearBtn.addEventListener('click', function() {
      vscode.postMessage({ type: 'goalControl', action: 'clear' });
    });
  }

 function renderGoalChip() {
   if (!goalChipEl) return;
   if (!goalSnapshot) {
     goalChipEl.classList.remove('visible');
     stopGoalTick();
     return;
   }
   goalChipEl.classList.add('visible');
   // Start live elapsed-time tick while goal is active
   if (goalSnapshot.status === 'active') startGoalTick();
   else stopGoalTick();
   // Remove all status-* classes
    goalChipEl.className = 'goal-chip visible status-' + (goalSnapshot.status || 'active');
    if (goalTextEl) {
      var text = goalSnapshot.objective || '';
      if (text.length > 80) text = text.substring(0, 77) + '...';
      goalTextEl.textContent = text;
      goalTextEl.title = goalSnapshot.objective || '';
    }
   if (goalStatusEl) {
     var statusLabels = {
       active: '',
       paused: '(paused)',
       blocked: '(blocked)',
       complete: '(done)',
       budgetLimited: '(budget)',
       usageLimited: '(usage)'
     };
     goalStatusEl.textContent = statusLabels[goalSnapshot.status] || '';
   }
   // Show real-time progress info (iteration, elapsed time, token budget)
   if (goalProgressEl) {
     var parts = [];
     // Kiro: iteration / maxIterations
     if (typeof goalSnapshot.iteration === 'number' && typeof goalSnapshot.maxIterations === 'number') {
       parts.push('iter ' + goalSnapshot.iteration + '/' + goalSnapshot.maxIterations);
     }
     // Elapsed time -- use live tick for active goals
     var secs = goalSnapshot.timeUsedSeconds || goalSnapshot.elapsedSecs || 0;
     if (goalSnapshot.status === 'active' && goalSnapshot.createdAt) {
       secs = Math.max(secs, Math.floor((Date.now() / 1000) - goalSnapshot.createdAt));
     }
     if (secs > 0) {
       if (secs < 60) parts.push(secs + 's');
       else parts.push(Math.floor(secs / 60) + 'm' + String(secs % 60).padStart(2, '0') + 's');
     }
     // Codex: token budget usage
     if (typeof goalSnapshot.tokenBudget === 'number' && goalSnapshot.tokenBudget > 0) {
       var used = goalSnapshot.tokensUsed || 0;
       var pct = Math.round((used / goalSnapshot.tokenBudget) * 100);
       parts.push(pct + '% budget');
     }
     goalProgressEl.textContent = parts.length ? '\\u00b7 ' + parts.join(' \\u00b7 ') : '';
   }
   // Show/hide pause button based on status
    if (goalPauseBtn) {
      goalPauseBtn.style.display = (goalSnapshot.status === 'active') ? '' : 'none';
    }
  }

  // Handle _kiro.dev/metadata notification (Kiro CLI specific).
   // params.contextUsagePercentage is a float (0-100), params.effort is a string like "high".
  function handleKiroMetadata(params) {
    if (!params) return;
    // Update context usage ring from contextUsagePercentage
    // Only show the ring after the user has sent at least one prompt —
    // Kiro sends _kiro.dev/metadata at session creation with a small
    // contextUsagePercentage, which would misleadingly show "2%" before
    // any LLM interaction.
    if (typeof params.contextUsagePercentage === 'number' && tokenUsageRing && hasSentPrompt) {
      var pct = params.contextUsagePercentage;
       // Kiro sends percentage (0-100). Synthesize used/size for the ring.
       // Estimate the context window from the model name so the tooltip can
       // show human-readable K/M token counts alongside the percentage.
       var ctxWindow = estimateContextWindow(currentModelId);
       var estUsed = Math.round(pct / 100 * ctxWindow);
       tokenUsage = { used: estUsed, size: ctxWindow, cost: null };
       updateTokenUsageDOM();
       // Update tooltip
       if (tokenUsageTooltip) {
         tokenUsageTooltip.textContent = 'Context: ' + Math.round(pct) + '% \u2022 ' + humanizeTokens(estUsed) + ' / ' + humanizeTokens(ctxWindow);
       }
     }
     // Update effort display if present
     if (typeof params.effort === 'string') {
       // If we have a reasoning_effort config option, sync its currentValue
       var effortOpt = configOptions.find(function(o) { return o && o.id === 'reasoning_effort'; });
       if (effortOpt && effortOpt.currentValue !== params.effort) {
         effortOpt.currentValue = params.effort;
         if (useConfigOptions) renderConfigPickers(configOptions);
       }
    }
  }

  /**
   * Extract 0–100 progress from Kiro status params when present
   * (numeric fields or a "NN%" substring in message).
   */
  function extractStatusPercent(params) {
    if (!params || typeof params !== 'object') return null;
    var keys = ['progress', 'percent', 'percentage', 'fraction', 'progressPercent'];
    for (var i = 0; i < keys.length; i++) {
      var v = params[keys[i]];
      if (typeof v !== 'number' || !isFinite(v)) continue;
      if (v >= 0 && v <= 1) return Math.round(v * 100);
      if (v >= 0 && v <= 100) return Math.round(v);
    }
    var msg = typeof params.message === 'string' ? params.message : '';
    var m = msg.match(/(\\d{1,3})\\s*%/);
    if (m) {
      var p = parseInt(m[1], 10);
      if (p >= 0 && p <= 100) return p;
    }
    return null;
  }

  /**
   * Show compact/clear progress in the session-banner status only
   * (title spinner). Do not add a second banner in the chat panel.
   */
  var transientHintTimer = null;

  /**
   * Show a brief notice that disappears on its own.
   *
   * Kept out of statusEl on purpose: that element carries the spinner and the
   * turn's elapsed figure, and overwriting it would trade one piece of feedback
   * for another. Also deliberately not a chat message — this is commentary on the
   * UI's own state, not conversation content.
   */
  function showTransientHint(text, ms) {
    var el = document.getElementById('transientHint');
    if (!el) return;
    el.textContent = String(text || '');
    el.classList.add('visible');
    if (transientHintTimer) clearTimeout(transientHintTimer);
    transientHintTimer = setTimeout(function () {
      transientHintTimer = null;
      el.classList.remove('visible');
      el.textContent = '';
    }, typeof ms === 'number' ? ms : 6000);
  }

  function showStatusBanner(kind, message, percent) {
    var isClear = kind === 'clear';
    var fallback = isClear ? 'Clearing conversation...' : 'Compacting conversation...';
    var label = (message && String(message).trim()) || fallback;
    if (typeof percent === 'number') {
      label = label + ' (' + percent + '%)';
    }
    if (statusEl) {
      statusEl.innerHTML = '<span class="spinner"></span><span>' + escapeHtml(label) + '</span>';
    }
  }

  function showCompactionProgress(message, percent) {
    showStatusBanner('compact', message, percent);
  }

  function hideCompactionProgress() {
    if (statusEl) statusEl.innerHTML = '';
  }

  /**
   * Wipe local chat history after a successful Kiro /clear (mirrors
   * flushCompactionMessages without adding a notice).
   */
  function finalizeKiroClear(notice) {
    if (!isClearing && !notice) return;
    isClearing = false;
    hideCompactionProgress();
    chatHistory = [];
    messagesEl.innerHTML = '';
    historyRenderGen++;
    for (var _clrDoneRk in pendingRenderRetries) { delete pendingRenderRetries[_clrDoneRk]; }
    currentTurnEl = null;
    currentAssistantEl = null;
    currentAssistantText = '';
    currentToolsListEl = null;
    currentToolsCountEl = null;
    currentToolCount = 0;
    toolCalls = {};
   toolCallDiffs = {};
   if (statusEl) statusEl.innerHTML = '';
   setProcessing(false, 'finalizeKiroClear');
   saveState();
   // After Kiro clear, chatHistory belongs to current session.
   chatHistoryOriginSessionId = (sessionState && sessionState.sessionId) || null;
   hideEmpty();
   if (notice && String(notice).trim()) {
     addMessage('system', String(notice).trim());
   }
 }

  /**
   * Handle _kiro.dev/clear/status — show progress banner; clear UI when done.
   */
  function handleKiroClearStatus(params) {
    if (isLoadingSession) return;
    var msg = params && typeof params.message === 'string' ? params.message : '';
    wvProbe('kiroClearStatus', 'msg="' + msg + '" isClearing=' + isClearing);
    if (!isClearing) {
      isClearing = true;
      setProcessing(true, 'handleLocalSlashCommand-clear');
    }
    var looksDone = !!msg && /cleared/i.test(msg) && !/clearing/i.test(msg);
    if (looksDone) {
      wvProbe('kiroClearStatus DONE', 'msg="' + msg + '"');
      finalizeKiroClear(msg);
      return;
    }
    showStatusBanner('clear', msg || 'Clearing conversation...', extractStatusPercent(params));
  }

  /**
   * _kiro.dev/commands/execute for clear returned.
   */
  function handleKiroClearDone(msg) {
    wvProbe('kiroClearDone', 'error=' + !!(msg && msg.error) + ' msg="' + ((msg && typeof msg.message === 'string') ? msg.message : '') + '" isClearing=' + isClearing);
    if (msg && msg.error) {
      isClearing = false;
      hideCompactionProgress();
      if (statusEl) statusEl.innerHTML = '';
      setProcessing(false, 'kiroClearDone-error');
      if (msg.message) addMessage('error', String(msg.message));
      return;
    }
    if (!isClearing) return;
    var fromRpc = (msg && typeof msg.message === 'string') ? msg.message.trim() : '';
    // Clear is complete once execute resolves (agent history already wiped).
    finalizeKiroClear(fromRpc || 'Conversation cleared.');
  }

  /**
   * Handle _kiro.dev/compaction/status — show progress bar and enter compacting
   * mode (covers auto-compaction as well as explicit /compact).
   *
   * Kiro protocol shape (current):
   *   { status: { type: "started"|"completed"|"failed" }, summary: string|null }
   * Older builds may send a plain message string instead.
   */
  function handleKiroCompactionStatus(params) {
    if (isLoadingSession) return;
    var msg = params && typeof params.message === 'string' ? params.message : '';
    var statusObj = params && params.status;
    var statusType = '';
    if (typeof statusObj === 'string') {
      statusType = statusObj;
    } else if (statusObj && typeof statusObj === 'object' && statusObj.type) {
      statusType = String(statusObj.type);
    }
    var summary = params && typeof params.summary === 'string' ? params.summary : '';
    wvProbe('kiroCompactionStatus', 'statusType=' + statusType + ' msg="' + msg + '" isCompacting=' + isCompacting);

    if (!isCompacting) {
      isCompacting = true;
      // Status RPC covers auto-compaction too — not a user /compact.
      manualCompacting = false;
      compactedWarningText = '';
      compactedNoticeText = '';
      if (compactionFlushTimer) { clearTimeout(compactionFlushTimer); compactionFlushTimer = null; }
      pendingPostCompactChunks = []; // new compaction supersedes any buffered resume tokens
      setProcessing(true, 'kiroCompactionStatus-in_progress');
    }

    if (statusType === 'failed') {
      wvProbe('kiroCompactionStatus FAILED', '');
      if (kiroCompactWatchdog) { clearTimeout(kiroCompactWatchdog); kiroCompactWatchdog = null; }
      isCompacting = false;
      manualCompacting = false;
      compactedWarningText = '';
      compactedNoticeText = '';
      if (compactionFlushTimer) { clearTimeout(compactionFlushTimer); compactionFlushTimer = null; }
      pendingPostCompactChunks = []; // compaction failed — discard any buffered resume tokens
      hideCompactionProgress();
      if (statusEl) statusEl.innerHTML = '';
      setProcessing(false, 'kiroCompactionStatus-failed');
      addMessage('error', msg || summary || 'Compaction failed.');
      return;
    }

    // Completion: status.type === "completed" (primary) or legacy message text.
    var looksDone = statusType === 'completed' ||
      (!!msg && /compacted/i.test(msg) && !/compacting/i.test(msg));
    if (looksDone) {
      // Do not paint Kiro's summary markdown into the panel — client note only.
      wvProbe('kiroCompactionStatus COMPLETED', 'isCompacting=' + isCompacting);
      finalizeKiroCompact(msg || 'Conversation compacted.');
      return;
    }

    showCompactionProgress(msg || 'Compacting conversation...', extractStatusPercent(params));
  }

  /**
   * True completion for Kiro compact — clear history only here (or from
   * agent_message "Conversation compacted"), never on a bare execute ack.
   */
  function finalizeKiroCompact(notice) {
    if (!isCompacting) return;
    if (kiroCompactWatchdog) { clearTimeout(kiroCompactWatchdog); kiroCompactWatchdog = null; }
    hideCompactionProgress();
    compactedNoticeText = String(notice || '').trim() || '*Conversation compacted.*';
    if (!compactedWarningText) {
      flushCompactionMessages();
    } else {
      scheduleCompactionFlush();
    }
    setProcessing(false, 'finalizeKiroCompact');
  }

  /**
   * _kiro.dev/commands/execute returned. An empty/early ack must NOT clear
   * the conversation — wait for compaction/status or agent message.
   */
  function handleKiroCompactDone(msg) {
    wvProbe('kiroCompactDone', 'error=' + !!(msg && msg.error) + ' msg="' + ((msg && typeof msg.message === 'string') ? msg.message : '') + '" isCompacting=' + isCompacting);
    if (msg && msg.error) {
      if (kiroCompactWatchdog) { clearTimeout(kiroCompactWatchdog); kiroCompactWatchdog = null; }
      isCompacting = false;
      compactedWarningText = '';
      compactedNoticeText = '';
      if (compactionFlushTimer) { clearTimeout(compactionFlushTimer); compactionFlushTimer = null; }
      pendingPostCompactChunks = []; // compaction failed — discard any buffered resume tokens
      hideCompactionProgress();
      if (statusEl) statusEl.innerHTML = '';
      setProcessing(false, 'kiroCompactDone-error');
      if (msg.message) {
        addMessage('error', String(msg.message));
      }
      return;
    }
    if (!isCompacting) {
      return;
    }
    var fromRpc = (msg && typeof msg.message === 'string') ? msg.message.trim() : '';
    var looksDone = !!fromRpc && /compacted/i.test(fromRpc) && !/compacting/i.test(fromRpc);
    if (looksDone) {
      finalizeKiroCompact(fromRpc);
      return;
    }
    // Already got a done notice via status/agent chunk while RPC was pending.
    if (compactedNoticeText && /compacted/i.test(compactedNoticeText) && !/compacting/i.test(compactedNoticeText)) {
      finalizeKiroCompact(compactedNoticeText);
      return;
    }
    // Keep conversation; show waiting status until true completion.
    showCompactionProgress('Compacting conversation...', null);
    setProcessing(true, 'kiroCompactDone-keepwaiting');
  }

  // Handle _kiro.dev/subagent/list_update notification (Kiro CLI specific).
  // params.subagents is an array of { sessionId, sessionName, status: { type, message } }.
  // We match each subagent to a stage element by sessionName and update its spinner.
  function handleKiroSubagentListUpdate(params) {
    if (!params || !Array.isArray(params.subagents)) return;
    // Prefer the live turn's stages only. Never fall back to the whole
    // document while a turn is active — same stage names on a stale crew
    // would re-spin after "go on".
    var stageEls;
    if (currentTurnEl) {
      stageEls = currentTurnEl.querySelectorAll('.tc-stage[data-stage-name]');
    } else {
      stageEls = document.querySelectorAll('.tc-stage[data-stage-name]');
    }
    if (!stageEls || stageEls.length === 0) return;
    for (var i = 0; i < params.subagents.length; i++) {
      var sa = params.subagents[i];
      var saName = sa.sessionName || '';
      if (!saName) continue;
     var statusType = sa.status && sa.status.type ? sa.status.type : 'working';
     // Map Kiro status types to our icon states
     var iconStatus;
     if (statusType === 'done' || statusType === 'completed' || statusType === 'success' || statusType === 'terminated') {
       iconStatus = 'completed';
     } else if (statusType === 'error' || statusType === 'failed') {
       iconStatus = 'error';
     } else {
       iconStatus = 'running';
     }
      // Find matching stage element(s) by sessionName
      for (var j = 0; j < stageEls.length; j++) {
        var stageEl = stageEls[j];
        if (stageEl.getAttribute('data-stage-name') !== saName) continue;
        // Stale interrupted crews / already-terminal stages: do not revive.
        if (iconStatus === 'running' && isStaleOrTerminalStage(stageEl)) continue;
        if (stageEl.closest('.tool-call-inline[data-crew-stale="1"]')) continue;
        if (sa.sessionId) {
          stageEl.setAttribute('data-session-id', String(sa.sessionId));
        }
        applyStageIcon(stageEl, iconStatus === 'error' ? 'failed' : iconStatus);
      }
   }
 // If all subagents are done/empty, also mark the parent crew tool call as completed
 // Consider both subagents AND pendingStages. If there are pending stages
 // (stages that haven't started yet), the crew is NOT all done.
 var pendingStages = Array.isArray(params.pendingStages) ? params.pendingStages : [];
 // Mark pending stages as "running" (waiting to start) so they show a spinner
 for (var p = 0; p < pendingStages.length; p++) {
   var pName = pendingStages[p].name || '';
   if (!pName) continue;
   for (var q = 0; q < stageEls.length; q++) {
     if (stageEls[q].getAttribute('data-stage-name') !== pName) continue;
     if (isStaleOrTerminalStage(stageEls[q])) continue;
     if (stageEls[q].closest('.tool-call-inline[data-crew-stale="1"]')) continue;
     applyStageIcon(stageEls[q], 'running');
   }
 }
 var allDone = pendingStages.length === 0 && params.subagents.length > 0;
  if (allDone) {
    for (var d = 0; d < params.subagents.length; d++) {
      var dType = params.subagents[d].status && params.subagents[d].status.type;
      if (dType !== 'terminated' && dType !== 'done' && dType !== 'completed' && dType !== 'success') {
        allDone = false;
        break;
      }
    }
  }
  if (allDone) {
     // All subagents have finished — mark any running crew tool call as completed
      // (skip stale interrupted crews from a prior turn).
      var crewEls = document.querySelectorAll(
        '.tool-call-inline.tc-subagent:not([data-crew-stale="1"]) > .tc-icon.running, ' +
        '.tool-call-inline.tc-subagent:not([data-crew-stale="1"]) > .tc-icon.pending'
      );
      for (var k = 0; k < crewEls.length; k++) {
        crewEls[k].className = 'tc-icon completed';
        crewEls[k].textContent = getStatusIcon('completed');
      }
    }
  }

  /**
   * Handle _session/terminate — mark the matching subagent stage as done.
   * Params typically include sessionId and optionally sessionName.
   */
  function handleSessionTerminate(params) {
    if (!params || typeof params !== 'object') return;
    var sid = params.sessionId || params.session_id || '';
    var sname = params.sessionName || params.session_name || params.name || '';
    var stageEls = document.querySelectorAll('.tc-stage');
    var matched = false;
    for (var i = 0; i < stageEls.length; i++) {
      var el = stageEls[i];
      var idMatch = sid && el.getAttribute('data-session-id') === String(sid);
      var nameMatch = sname && el.getAttribute('data-stage-name') === String(sname);
      if (!idMatch && !nameMatch) continue;
      matched = true;
      if (sid) el.setAttribute('data-session-id', String(sid));
      var iconEl = el.querySelector('.tc-stage-icon');
      if (iconEl) {
        applyStageIcon(el, 'completed');
      }
    }
    if (!matched && sid) {
      // No stage yet — still record id so a later list_update can pick it up.
      vscode.postMessage({
        type: 'debugLog',
        message: '[WV] _session/terminate for unknown subagent sessionId=' + sid + ' name=' + sname,
      });
    }
    // If every visible stage is completed, collapse the parent crew spinner.
    var runningStages = document.querySelectorAll('.tc-stage-icon.running, .tc-stage-icon.in_progress, .tc-stage-icon.pending');
    if (runningStages.length === 0) {
      var crewEls = document.querySelectorAll('.tool-call-inline.tc-subagent .tc-icon.running, .tool-call-inline.tc-subagent .tc-icon.pending');
      for (var k = 0; k < crewEls.length; k++) {
        crewEls[k].className = 'tc-icon completed';
        crewEls[k].textContent = getStatusIcon('completed');
      }
    }
  }

  /**
   * Cursor often spawns N explore agents, then N more with NEW agentIds whose
   * only job is "Get … findings" / "provide your complete summary". Treat those
   * as updates to the existing crew stages, not extra subagents.
   */
  function isCursorTaskFollowUp(params) {
    var d = String((params && params.description) || '').toLowerCase();
    var p = String((params && params.prompt) || '').toLowerCase();
    if (/provide your complete/.test(p)) return true;
    if (/complete final summary/.test(p) || /final summary now/.test(p)) return true;
    if (/\\bget\\b/.test(d) && /finding/.test(d)) return true;
    if (/^get\\s/.test(d)) return true;
    return false;
  }

  function scoreCursorStageMatch(stageName, text) {
    var name = String(stageName || '').toLowerCase();
    var t = String(text || '').toLowerCase();
    var score = 0;
    var keywords = ['architecture', 'flow', 'build', 'test', 'module', 'config', 'deploy', 'session', 'runtime', 'protocol'];
    for (var i = 0; i < keywords.length; i++) {
      var kw = keywords[i];
      if (t.indexOf(kw) >= 0 && name.indexOf(kw) >= 0) score += 2;
    }
    var words = name.split(/[^a-z0-9]+/);
    for (var j = 0; j < words.length; j++) {
      if (words[j].length > 3 && t.indexOf(words[j]) >= 0) score += 1;
    }
    return score;
  }

  function findCursorFollowUpStage(params) {
    var crew = findCurrentTurnSubagentCrew();
    if (!crew) return null;
    var stages = crew.querySelectorAll(':scope > .tc-stages > .tc-stage');
    if (!stages.length) return null;
    var text = String((params && params.description) || '') + ' ' + String((params && params.prompt) || '');
    var best = null;
    var bestScore = 0;
    for (var i = 0; i < stages.length; i++) {
      var sc = scoreCursorStageMatch(stages[i].getAttribute('data-stage-name') || '', text);
      if (sc > bestScore) {
        bestScore = sc;
        best = stages[i];
      }
    }
    if (best && bestScore > 0) return best;
    var idx = typeof crew._cursorFollowUpIdx === 'number' ? crew._cursorFollowUpIdx : 0;
    crew._cursorFollowUpIdx = idx + 1;
    return stages[idx % stages.length];
  }

  /**
   * Cursor cursor/task — same Kiro-style crew UI as Claude Task / Codex spawnAgent.
   * Dedupes by toolCallId / agentId, and maps "Get findings" follow-ups onto
   * existing explore stages (Cursor often uses new agentIds for those).
   */
  function handleCursorTask(params) {
    if (!params || typeof params !== 'object') return;
    var id = params.toolCallId || ('cursor-task-' + Date.now());
    var typeLabel = typeof params.subagentType === 'string'
      ? params.subagentType
      : (params.subagentType && params.subagentType.custom) || 'subagent';
    if (typeLabel && typeof typeLabel === 'object') typeLabel = 'subagent';
    var status = 'running';
    // durationMs on the first cursor/task is often just spawn latency, not
    // "subagent finished". Only mark completed when the turn is already done.
    if (typeof params.durationMs === 'number' && !isProcessing) {
      status = 'completed';
    }
    var raw = {
      prompt: params.prompt || '',
      description: params.description || ('Subagent: ' + typeLabel),
      subagent_type: typeLabel,
      agentId: params.agentId || '',
      model: params.model || '',
      durationMs: params.durationMs,
    };
    var idAttr = String(id).replace(/"/g, '');

    function bindStage(stage, keepName) {
      if (!stage) return;
      stage.setAttribute('data-tool-call-id', idAttr);
      if (params.agentId) stage.setAttribute('data-agent-id', String(params.agentId));
      var crew = stage.closest('.tool-call-inline.tc-subagent');
      if (crew) toolCalls[id] = crew;
      updateStageFromRawInput(stage, raw, 'Task', keepName ? { keepName: true } : null);
      setSubagentStageStatus(id, status);
    }

    var stageByTc = document.querySelector('.tc-stage[data-tool-call-id="' + idAttr + '"]');
    if (stageByTc) {
      bindStage(stageByTc, false);
      return;
    }
    if (params.agentId && currentTurnEl) {
      var agentAttr = String(params.agentId).replace(/"/g, '');
      var stageByAgent = currentTurnEl.querySelector('.tc-stage[data-agent-id="' + agentAttr + '"]');
      if (stageByAgent) {
        bindStage(stageByAgent, true);
        return;
      }
    }
    // Follow-up "Get findings" with a fresh agentId → update matched explore stage.
    if (isCursorTaskFollowUp(params) && findCurrentTurnSubagentCrew()) {
      var stageFu = findCursorFollowUpStage(params);
      if (stageFu) {
        bindStage(stageFu, true);
        return;
      }
    }
    addToolCall(id, 'Task', status, null, raw, 'other');
    var stage = document.querySelector('.tc-stage[data-tool-call-id="' + idAttr + '"]');
    if (stage && params.agentId) stage.setAttribute('data-agent-id', String(params.agentId));
    var el = toolCalls[id];
    if (el && params.agentId) el.setAttribute('data-session-id', String(params.agentId));
    if (compactMode && currentTurnEl) {
      ensureTurnFoldStructure(currentTurnEl, true);
      refreshCurrentTurnSummary();
    }
  }

  /** Cursor cursor/update_todos — single plan-bar board (not inline tool rows). */
  var cursorTodosById = Object.create(null);

  function normalizeCursorTodoStatus(st) {
    var s = String(st || 'pending').toLowerCase();
    if (s.indexOf('complet') >= 0) return 'completed';
    if (s.indexOf('progress') >= 0 || s === 'in_progress') return 'in_progress';
    if (s.indexOf('cancel') >= 0) return 'cancelled';
    return 'pending';
  }

  function clearCursorTodosPlan() {
    cursorTodosById = Object.create(null);
    if (!planBar) return;
    var root = planBar.querySelector('.cursor-todos-plan');
    if (root) root.remove();
    planBar.classList.remove('cursor-todos-outside');
  }

  function renderCursorTodosPlanBar() {
    if (!planBar) return;
    var ids = Object.keys(cursorTodosById);
    var root = planBar.querySelector('.cursor-todos-plan');
    if (!ids.length) {
      if (root) root.remove();
      planBar.classList.remove('cursor-todos-outside');
      return;
    }
    ids.sort(function (a, b) {
      var na = Number(a); var nb = Number(b);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return String(a).localeCompare(String(b));
    });
    var html = '<div class="plan"><div class="plan-title">Todos</div>';
    for (var i = 0; i < ids.length; i++) {
      var t = cursorTodosById[ids[i]];
      var st = normalizeCursorTodoStatus(t && t.status);
      var cls = st === 'completed' ? 'plan-entry completed' : 'plan-entry';
      html += '<div class="' + cls + '">' +
        '<span>' + (st === 'completed' ? '✓' : st === 'in_progress' ? '…' : '○') + '</span>' +
        '<span>' + escapeHtml((t && t.content) || '') + '</span></div>';
    }
    html += '</div>';
    if (!root) {
      root = document.createElement('div');
      root.className = 'cursor-todos-plan';
      planBar.insertBefore(root, planBar.firstChild);
    }
    planBar.classList.add('cursor-todos-outside');
    root.innerHTML = html;
  }

  function handleCursorUpdateTodos(params) {
    if (!params || !Array.isArray(params.todos) || !planBar) return;
    // Render todos in the plan bar above the chat input in all modes.
    // In compact mode the plan bar is still visible (it sits outside the
    // message list fold), so the user always sees the current task board.
    if (compactMode && statusEl && params.todos.length) {
      var todoMsg = params.todos.length + ' todo' + (params.todos.length > 1 ? 's' : '') + ' updated';
      if (statusEl._todoStatusTimer) {
        clearTimeout(statusEl._todoStatusTimer);
        statusEl._todoStatusTimer = null;
      }
      if (isProcessing) {
        // Never replace the live spinner with "N todos updated" — that label
        // stuck for the rest of the turn (heal only ran when .spinner was
        // missing). Todos already show in the plan bar; keep status = spinner.
        restoreProcessingStatusSpinner();
      } else {
        statusEl.textContent = todoMsg;
        statusEl._todoStatusTimer = setTimeout(function () {
          statusEl._todoStatusTimer = null;
          if (statusEl && statusEl.textContent === todoMsg) {
            statusEl.textContent = '';
          }
        }, 3000);
      }
    }
    var todos = params.todos;
    if (!params.merge) {
      cursorTodosById = Object.create(null);
    }
    if (!todos.length) {
      if (!params.merge) clearCursorTodosPlan();
      else renderCursorTodosPlanBar();
      return;
    }
    for (var i = 0; i < todos.length; i++) {
      var t = todos[i];
      if (!t || typeof t !== 'object') continue;
      var id = t.id != null ? String(t.id) : ('anon-' + i);
      var prev = cursorTodosById[id] || {};
      cursorTodosById[id] = {
        id: id,
        content: t.content != null ? t.content : prev.content,
        status: normalizeCursorTodoStatus(t.status != null ? t.status : prev.status),
      };
    }
    renderCursorTodosPlanBar();
  }

  function handleCursorGenerateImage(params) {
    if (!params) return;
    var desc = params.description || 'Generated image';
    var path = params.filePath ? (' (' + params.filePath + ')') : '';
    // Keep as system notice (outside fold) — short; path only when expanded.
    if (compactMode) {
      addMessage('system', 'Image: ' + desc);
    } else {
      addMessage('system', 'Image: ' + desc + path);
    }
  }

  function handleCursorCreatePlan(params) {
    if (!params) return;
    var name = params.name || 'Plan';
    var overview = params.overview || '';
    // Collapse: short system line only — don't paste the full plan outside the fold.
    if (compactMode) {
      addMessage('system', 'Plan accepted: ' + name);
      return;
    }
    addMessage('system', '**Plan accepted: ' + name + '**' + (overview ? '\\n\\n' + overview : ''));
    if (Array.isArray(params.todos) && params.todos.length) {
      handleCursorUpdateTodos({ todos: params.todos, merge: false });
    }
  }

  function updateTokenUsageDOM() {
     if (!tokenUsage) {
       tokenUsageRing.classList.remove('visible');
       return;
     }
     // Don't show the ring when size is 0 (no real usage data yet)
     if (!tokenUsage.size) {
       tokenUsageRing.classList.remove('visible');
       return;
     }
     tokenUsageRing.classList.add('visible');
      var used = tokenUsage.used;
      var size = tokenUsage.size;
      var ratio = size > 0 ? used / size : 0;
      // Cap the displayed percentage at 100%. A used > size ratio happens
      // when a model switch mid-turn leaves the ring's size stale (e.g. the
      // agent reports 784K used against a 256K window after a fork, or the
      // final usage_update carries the 1M model's used but a 256K size).
      // The ring fill is already clamped by Math.min(ratio, 1); without this
      // cap the LABEL would read 299% / 372% which is misleading.
      var pct = Math.round(Math.min(ratio, 1) * 100);
      // circumference = 2 * PI * r = 2 * 3.14159 * 6 = 37.7
      var circumference = 37.7;
      var offset = circumference * (1 - Math.min(ratio, 1));
      tokenUsageRingFg.style.strokeDashoffset = offset;
      tokenUsageRingFg.setAttribute('class', 'ring-fg ' + (ratio >= 0.85 ? 'danger' : ratio >= 0.7 ? 'warning' : 'normal'));
      tokenUsageRingLabel.textContent = pct + '%';
    }

    function humanizeTokens(n) {
      if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
      if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
      return String(n);
    }

    // Estimate context window from model name (mirrors codex model-capabilities.ts).
    // Used by Kiro CLI which only sends a percentage, not raw token counts.
    function estimateContextWindow(modelId) {
      if (!modelId) return 200000;
      var m = modelId.toLowerCase().replace(/\\[(?:low|medium|high|xhigh|max|none)\\]$/, '');
      if (m.includes('1m') || m.includes('instruct-1m')) return 1000000;
      if (m.includes('kimi')) return 256000;
      if (m.includes('qwen') && (m.includes('235b') || m.includes('next'))) return 262144;
      if (m.includes('qwen3-coder') || (m.includes('qwen') && m.includes('480b'))) return 262144;
      if (m.includes('qwen3.8') || m.includes('qwen-3.8')) return 262144;
      if (m.includes('gemma-4')) return 262144;
      if (m.includes('glm-5')) return 196608;
      if (m.includes('gpt-oss')) return 131072;
      if (m.includes('qwen3.5') || m.includes('qwen3.6')) return 131072;
      if (m.includes('glm-4') || m.includes('glm')) return 131072;
      if (m.includes('llama-3.3') || m.includes('llama-3.2')) return 131072;
      if (m.includes('gemma-3')) return 90000;
      if (m.includes('mixtral-8x22b')) return 65536;
      if (m.includes('deepseek')) return 262144;
      // Claude (Kiro CLI uses Bedrock). claude-opus-5 has a
      // 1M-token window (verified from kiro session metadata:
      // rts_model_state.model_info.context_window_tokens = 1000000) — must be
      // matched BEFORE the generic claude/opus 200K fallback below, otherwise
      // the ring under-reports kiro usage by ~5x (it would show pct/100*200K
      // instead of pct/100*1M). Matched specifically to opus-5 (not the generic
      // claude-opus) so other claude-opus variants whose window is unknown keep
      // the 200K fallback.
      if (m.includes('claude-opus-5') || m.includes('opus-5')) return 1000000;
      if (m.includes('claude') || m.includes('opus')) return 200000;
      if (m.includes('qwen')) return 32768;
      return 200000;
    }

    // --- Token usage ring hover tooltip (like Zed) ---
    if (tokenUsageRing && tokenUsageTooltip) {
      tokenUsageRing.addEventListener('mouseenter', function () {
        if (!tokenUsage) return;
        var used = tokenUsage.used;
        var size = tokenUsage.size;
        var ratio = size > 0 ? used / size : 0;
        // Cap tooltip percentage at 100% too — matches the ring label cap so
        // hover doesn't show 299% when a stale size makes used > size.
        var pct = Math.round(Math.min(ratio, 1) * 100);
        var html = '<div class="tooltip-header">Context</div>';
        if (size > 0 && size !== 100) {
          html += pct + '% \u2022 ' + humanizeTokens(used) + ' / ' + humanizeTokens(size);
        } else if (size > 0) {
          // Kiro CLI (or any pct-only agent): percentage only, no raw token counts
          html += Math.round(used) + '% used';
        } else {
          html += humanizeTokens(used) + ' tokens';
        }
        if (tokenUsage.cost && tokenUsage.cost.amount !== undefined) {
          var amount = tokenUsage.cost.amount;
          var prec = (amount > 0 && amount < 0.01) ? 4 : 2;
          html += '<div class="tooltip-cost">Cost $' + amount.toFixed(prec) + '</div>';
        }
        tokenUsageTooltip.innerHTML = html;
        tokenUsageTooltip.classList.add('visible');
        // Position above the ring
        var rect = tokenUsageRing.getBoundingClientRect();
        var tipRect = tokenUsageTooltip.getBoundingClientRect();
        var left = rect.left + rect.width / 2 - tipRect.width / 2;
        var top = rect.top - tipRect.height - 6;
        if (left < 4) left = 4;
        if (left + tipRect.width > window.innerWidth - 4) left = window.innerWidth - tipRect.width - 4;
        if (top < 4) top = rect.bottom + 6;
        tokenUsageTooltip.style.left = left + 'px';
        tokenUsageTooltip.style.top = top + 'px';
      });
      tokenUsageRing.addEventListener('mouseleave', function () {
        tokenUsageTooltip.classList.remove('visible');
      });
    }

    // Restore previous state before telling extension we're ready
    restoreState();
    // Tell extension we're ready
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }

  /**
   * Attach a file URI — notify the webview to include it in the next prompt.
   */
  attachFile(uri: vscode.Uri): void {
    if (this.view) {
      this.view.webview.postMessage({
        type: 'file-attached',
        path: uri.fsPath,
        name: uri.fsPath.split(/[\\/]/).pop() || uri.fsPath,
      });
      this.view.show?.(true);
    }
  }

  dispose(): void {
    this.dropAllStreamBuffers();
    this.followCoalescer.reset();
    this.sessionUpdateHandler.removeListener(this.updateListener);
  }

  /**
   * Cancel pending flush timers and clear all stream coalescing buffers.
   * Buffered text is intentionally dropped (callers invoke this when the
   * downstream state is being reset — clearChat / active-session-changed /
   * dispose).
   */
  private dropAllStreamBuffers(): void {
    this.streamCoalescer.dropAll();
  }

  /**
   * Return whether the panel is currently following the agent. Mirrors
   * Zed's `is_following`.
   */
  get isFollowing(): boolean {
    return this._isFollowing;
  }

  /**
   * Toggle the "Follow Agent" state. When turning OFF, the pending
   * follow-target burst is dropped. When turning ON, the next tool_call
   * with a `locations` array will open in the editor.
   *
   * The webview is notified so the toolbar button reflects the new state.
   */
  toggleFollow(): void {
    this._isFollowing = !this._isFollowing;
    if (!this._isFollowing) {
      this.followCoalescer.reset();
    }
    this.postMessage({ type: 'followStateChanged', isFollowing: this._isFollowing });
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

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
import { StreamCoalescer } from '../core/StreamCoalescer';
import { FollowCoalescer, pickFollowTarget, type ToolCallLocationLike } from '../core/FollowAgent';
import { log, logError, getOutputChannel } from '../utils/Logger';
import { sendEvent } from '../utils/TelemetryManager';
import { cleanSessionTitle } from '../utils/TitleCleaner';

const execFileAsync = promisify(execFile);

// Set to true to enable verbose [DEBUG-WV] / [DEBUG-MD] / [DEBUG-SUBAGENT] logs
// in the ACP Client output channel. Keep false in normal use — the per-chunk
// logging floods the channel during streaming.
const DEBUG = false;

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
  /** When true, suppress webview notifications (used during background session capture). */
  /** When true, suppress webview notifications (used during background session capture or reconnect). */
  suppressWebviewUpdates = false;
  private _hasChatContent = false;
  private toolCallDiffs = new Map<string, Array<{ path: string; oldText?: string; newText: string }>>();
  private terminalContext = new TerminalContextProvider();
  /**
   * Coalesces per-token streaming chunks. See `StreamCoalescer` for details.
   * Codex emits `agent_message_chunk` / `agent_thought_chunk` per LLM delta,
   * so forwarding each one to the webview costs an IPC roundtrip + a traffic
   * log entry. Buffering for 8 ms and flushing one combined chunk per kind
   * cuts both by roughly 6× at typical OpenAI token rates.
   */
  private streamCoalescer: StreamCoalescer;

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
  ) {
    // Configure marked for safe rendering
    marked.setOptions({
      breaks: true,
      gfm: true,
    });

    this.streamCoalescer = new StreamCoalescer({
      flushIntervalMs: 8,
      onFlush: (sessionId, kind, text) => {
        this.postMessage({
          type: 'sessionUpdate',
          sessionId,
          update: {
            sessionUpdate: kind === 'message' ? 'agent_message_chunk' : 'agent_thought_chunk',
            content: { type: 'text', text },
          },
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
  }

  // Language keywords (C/C++/Go/Rust/TS/JS/Python) that should never be linkified as project symbols
  // Language keywords (C/C++/Go/Rust/TS/JS/Python) — never linkify as project symbols
  // Sources: en.cppreference.com, go.dev/ref/spec, doc.rust-lang.org, typescriptlang.org, docs.python.org
  private static readonly langKeywords = new Set([
    // === C keywords (en.cppreference.com/w/c/keyword) ===
    'auto',
    'break',
    'case',
    'char',
    'const',
    'continue',
    'default',
    'do',
    'double',
    'else',
    'enum',
    'extern',
    'float',
    'for',
    'goto',
    'if',
    'inline',
    'int',
    'long',
    'register',
    'restrict',
    'return',
    'short',
    'signed',
    'sizeof',
    'static',
    'struct',
    'switch',
    'typedef',
    'union',
    'unsigned',
    'void',
    'volatile',
    'while',
    'bool',
    'nullptr',
    'constexpr',
    'alignas',
    'alignof',
    'thread_local',
    'static_assert',
    'typeof',
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
    'alignas',
    'alignof',
    'and',
    'and_eq',
    'asm',
    'atomic_cancel',
    'atomic_commit',
    'atomic_noexcept',
    'auto',
    'bitand',
    'bitor',
    'bool',
    'break',
    'case',
    'catch',
    'char',
    'char8_t',
    'char16_t',
    'char32_t',
    'class',
    'compl',
    'concept',
    'const',
    'consteval',
    'constexpr',
    'constinit',
    'const_cast',
    'continue',
    'contract_assert',
    'co_await',
    'co_return',
    'co_yield',
    'decltype',
    'default',
    'delete',
    'do',
    'double',
    'dynamic_cast',
    'else',
    'enum',
    'explicit',
    'export',
    'extern',
    'false',
    'float',
    'for',
    'friend',
    'goto',
    'if',
    'inline',
    'int',
    'long',
    'mutable',
    'namespace',
    'new',
    'noexcept',
    'not',
    'not_eq',
    'nullptr',
    'operator',
    'or',
    'or_eq',
    'override',
    'private',
    'protected',
    'public',
    'register',
    'reinterpret_cast',
    'requires',
    'return',
    'short',
    'signed',
    'sizeof',
    'static',
    'static_assert',
    'static_cast',
    'struct',
    'switch',
    'template',
    'this',
    'thread_local',
    'throw',
    'true',
    'try',
    'typedef',
    'typeid',
    'typename',
    'union',
    'unsigned',
    'using',
    'virtual',
    'void',
    'volatile',
    'wchar_t',
    'while',
    'xor',
    'xor_eq',
    'reflexpr',
    'synchronized',
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
    'break',
    'case',
    'chan',
    'const',
    'continue',
    'default',
    'defer',
    'else',
    'fallthrough',
    'for',
    'func',
    'go',
    'goto',
    'if',
    'import',
    'interface',
    'map',
    'package',
    'range',
    'return',
    'select',
    'struct',
    'switch',
    'type',
    'var',
    // === Go builtin functions and types ===
    'append',
    'cap',
    'close',
    'complex',
    'copy',
    'delete',
    'imag',
    'len',
    'make',
    'new',
    'panic',
    'print',
    'println',
    'real',
    'recover',
    'bool',
    'byte',
    'complex64',
    'complex128',
    'error',
    'float32',
    'float64',
    'int',
    'int8',
    'int16',
    'int32',
    'int64',
    'rune',
    'string',
    'uint',
    'uint8',
    'uint16',
    'uint32',
    'uint64',
    'uintptr',
    'true',
    'false',
    'iota',
    'nil',
    'any',
    // === Rust keywords (doc.rust-lang.org/reference/keywords.html) ===
    'as',
    'async',
    'await',
    'break',
    'const',
    'continue',
    'crate',
    'dyn',
    'else',
    'enum',
    'extern',
    'false',
    'fn',
    'for',
    'if',
    'impl',
    'in',
    'let',
    'loop',
    'match',
    'mod',
    'move',
    'mut',
    'pub',
    'ref',
    'return',
    'self',
    'Self',
    'static',
    'struct',
    'super',
    'trait',
    'true',
    'type',
    'unsafe',
    'use',
    'where',
    'while',
    'union',
    // === Rust reserved keywords ===
    'abstract',
    'become',
    'box',
    'do',
    'final',
    'gen',
    'macro',
    'override',
    'priv',
    'try',
    'typeof',
    'unsized',
    'virtual',
    'yield',
    'macro_rules',
    'raw',
    'safe',
    // === Rust std types and functions ===
    'println',
    'print',
    'eprintln',
    'eprint',
    'dbg',
    'vec',
    'format',
    'String',
    'Vec',
    'Option',
    'Some',
    'None',
    'Result',
    'Ok',
    'Err',
    'Box',
    'Rc',
    'Arc',
    'RefCell',
    'Cell',
    'Mutex',
    'RwLock',
    'HashMap',
    'HashSet',
    'BTreeMap',
    'BTreeSet',
    // === TypeScript/JavaScript keywords ===
    'abstract',
    'any',
    'as',
    'asserts',
    'async',
    'await',
    'break',
    'case',
    'catch',
    'class',
    'const',
    'continue',
    'debugger',
    'default',
    'delete',
    'do',
    'else',
    'enum',
    'export',
    'extends',
    'false',
    'finally',
    'for',
    'from',
    'function',
    'get',
    'if',
    'implements',
    'import',
    'in',
    'infer',
    'instanceof',
    'interface',
    'is',
    'keyof',
    'let',
    'namespace',
    'never',
    'new',
    'null',
    'number',
    'object',
    'of',
    'package',
    'private',
    'protected',
    'public',
    'readonly',
    'require',
    'return',
    'satisfies',
    'set',
    'static',
    'string',
    'super',
    'switch',
    'symbol',
    'this',
    'throw',
    'true',
    'try',
    'type',
    'typeof',
    'undefined',
    'unknown',
    'var',
    'void',
    'while',
    'with',
    'yield',
    'module',
    'boolean',
    'bigint',
    // === Python keywords (docs.python.org/3/library/keyword.html) ===
    'False',
    'None',
    'True',
    'and',
    'as',
    'assert',
    'async',
    'await',
    'break',
    'class',
    'continue',
    'def',
    'del',
    'elif',
    'else',
    'except',
    'finally',
    'for',
    'from',
    'global',
    'if',
    'import',
    'in',
    'is',
    'lambda',
    'nonlocal',
    'not',
    'or',
    'pass',
    'raise',
    'return',
    'try',
    'while',
    'with',
    'yield',
    // === Python builtins (docs.python.org/3/library/builtins.html) ===
    'abs',
    'aiter',
    'all',
    'anext',
    'any',
    'ascii',
    'bin',
    'bool',
    'breakpoint',
    'bytearray',
    'bytes',
    'callable',
    'chr',
    'classmethod',
    'compile',
    'complex',
    'delattr',
    'dict',
    'dir',
    'divmod',
    'enumerate',
    'eval',
    'exec',
    'exit',
    'filter',
    'float',
    'format',
    'frozenset',
    'getattr',
    'globals',
    'hasattr',
    'hash',
    'help',
    'hex',
    'id',
    'input',
    'int',
    'isinstance',
    'issubclass',
    'iter',
    'len',
    'license',
    'list',
    'locals',
    'map',
    'max',
    'memoryview',
    'min',
    'next',
    'object',
    'oct',
    'open',
    'ord',
    'pow',
    'print',
    'property',
    'quit',
    'range',
    'repr',
    'reversed',
    'round',
    'set',
    'setattr',
    'slice',
    'sorted',
    'staticmethod',
    'str',
    'sum',
    'super',
    'tuple',
    'type',
    'vars',
    'zip',
    'self',
    'cls',
    // === Codex/agent tool names — must NOT be linkified as symbols ===
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
      let html = marked.parse(text) as string;
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
          '(?:\\.?\\/?[\\w.-]+\\/)+' + // at least one dir separator (path with /)
          '[\\w.-]+\\.' +
          codeExt +
          '(?::\\d+(?:-\\d+)?)?' + //   + filename.ext[:line[:-end]]
          '(?=$|[\\s,;:\\)\\]\\}\\<|])' + //   word boundary after extension
          '|' +
          '[\\w.-]+\\.' +
          codeExt +
          '(?::\\d+(?:-\\d+)?)' + // bare filename.ext:line[:-end]
          '|' +
          '[\\w.-]+\\.' +
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
        'The',
        'This',
        'That',
        'These',
        'Those',
        'Note',
        'Notes',
        'Step',
        'Steps',
        'When',
        'Where',
        'Why',
        'How',
        'What',
        'For',
        'But',
        'And',
        'Or',
        'Not',
        'Yes',
        'No',
        'True',
        'False',
        'None',
        'Null',
        'Let',
        'Var',
        'Const',
        'Class',
        'Struct',
        'Enum',
        'Func',
        'Def',
        'Import',
        'From',
        'With',
        'While',
        'Return',
        'Async',
        'Await',
        'Yield',
        'Super',
        'Self',
        'Type',
        'Error',
        'Warning',
        'Info',
        'Debug',
        'Trace',
        'You',
        'Your',
        'We',
        'Our',
        'They',
        'Their',
        'Its',
        'It',
        'Is',
        'Are',
        'Was',
        'Were',
        'Be',
        'Been',
        'Being',
        'Have',
        'Has',
        'Had',
        'Do',
        'Does',
        'Did',
        'Will',
        'Would',
        'Could',
        'Should',
        'May',
        'Might',
        'Can',
        'About',
        'Above',
        'Below',
        'Over',
        'Under',
        'Again',
        'First',
        'Last',
        'Next',
        'Prev',
        'Each',
        'Some',
        'Many',
        'Most',
        'Other',
        'Such',
        'Only',
        'Own',
        'Same',
        'So',
        'Than',
        'Too',
        'Very',
        'Just',
        'Now',
        'Here',
        'There',
        'All',
        'Any',
        'Both',
        'Few',
        'More',
        'Much',
        'Little',
        'Enough',
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
        'Python',
        'Linux',
        'Windows',
        'MacOS',
        'Docker',
        'Kubernetes',
        'Rust',
        'Golang',
        'Java',
        'Swift',
        'Kotlin',
        'NodeJS',
        'Nodejs',
        'Nginx',
        'Apache',
        'CMake',
        'Cargo',
        'Webpack',
        'Babel',
        'ESLint',
        'Prettier',
        // Product/tool names that look like PascalCase but aren't code symbols
        'EricAi',
        'EricAI',
        'Ericsson',
        'ChatGPT',
        'ClaudeCode',
        'GeminiCLI',
        'OpenCode',
        'TeraScript',
        'Synadia',
        'GoLang',
        'WSO2',
        'NATS',
        'Redis',
        'MongoDB',
        'MySQL',
        'PostgreSQL',
        'SQLite',
        'ElasticSearch',
        'Kibana',
        'Grafana',
        'Prometheus',
        'Jenkins',
        'GitLab',
        'Bitbucket',
        'Jira',
        'Confluence',
        'Nexus',
        'SonarQube',
        'ReactJS',
        'VueJS',
        'AngularJS',
        'NextJS',
        'NuxtJS',
        'ExpressJS',
        'Fastify',
        'SpringBoot',
        'Quarkus',
        'Micronaut',
        'DotNet',
        'AspNet',
        'MonoDevelop',
        'VisualStudio',
        'VSCode',
        'IntelliJ',
        'EclipseIDE',
        'NetBeans',
        'Xcode',
        'CLion',
        'PyCharm',
        'GoLand',
        'RustRover',
        'DataGrip',
        'AppCode',
        'RubyMine',
        'InnoDB',
        'MyISAM',
        'Memcached',
        'RabbitMQ',
        'KafkaMQ',
        'ActiveMQ',
        'Pulsar',
        'ZeroMQ',
        'Kafka',
        'FreeRTOS',
        'Zephyr',
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
        'Firebird',
        'HiveMQ',
        'Ignite',
        'Hazelcast',
        'Infinispan',
        'Keycloak',
        'Liquibase',
        'Flyway',
        'Cypress',
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
        'Flask',
        'Django',
        'Bottle',
        'Tornado',
        'Pyramid',
        'Sanic',
        'Starlette',
        'Pytest',
        'Tox',
        'Sphinx',
        'ActixWeb',
        'Axum',
        'Rocket',
        'Warp',
        'Tide',
        'Salvo',
        'GinGonic',
        'EchoGo',
        'FiberGo',
        'ChiGo',
        'BuffaloGo',
        'SpringBoot',
        'Quarkus',
        'Micronaut',
        'Dropwizard',
        'Vertx',
        'PlayFramework',
        'Lagom',
        'Akka',
        'Spark',
        'Flink',
        'Storm',
        'Hadoop',
        'HBase',
        'Cassandra',
        'Aerospike',
        'Riak',
        'Neo4j',
        'ArangoDB',
        'OrientDB',
        'JanusGraph',
        'TigerGraph',
        'Dgraph',
        'Jenkins',
        'Bamboo',
        'TeamCity',
        'CircleCI',
        'TravisCI',
        'DroneCI',
        'ConcourseCI',
        'Buildkite',
        'Tekton',
        'ArgoCD',
        'FluxCD',
        'Spinnaker',
        'CodeDeploy',
        'Octopus',
        'Helm',
        'Kustomize',
        'Istio',
        'Linkerd',
        'Consul',
        'Vault',
        'Nomad',
        'Terraform',
        'Pulumi',
        'Ansible',
        'Chef',
        'Puppet',
        'SaltStack',
        'Vagrant',
        'Packer',
        'CloudInit',
        'Jinja',
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
        'Dropwizard',
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
      const splitRegex =
        /(<pre>.*?<\/pre>|<span class="nolink">.*?<\/span>|<a\s[^>]*>.*?<\/a>|https?:\/\/[^\s<]+|www\.[^\s<]+|file:\/\/\/[^\s<"]+|(?:github|gitlab|bitbucket|stackoverflow|developer\.mozilla|en\.wikipedia|docs\.python|docs\.rust-lang|crates\.io|pypi\.org|npmjs\.com|docs\.oracle|learn\.microsoft|developer\.android|kubernetes\.io|docker\.com|nodejs\.org|python\.org|go\.dev|rust-lang\.org|swift\.org|jetbrains\.com|visualstudio\.com|atlassian\.com|confluence\.atlassian|jira\.atlassian|gerrit\.googlesource|gerrit-review\.googlesource)\.[a-z]+\/[^\s<]+)/gs;
      const splitRegexWithFileRef =
        /(<pre>.*?<\/pre>|<code>.*?<\/code>|<span class="nolink">.*?<\/span>|<span class="file-ref">.*?<\/span>|<a\s[^>]*>.*?<\/a>|https?:\/\/[^\s<]+|www\.[^\s<]+|file:\/\/\/[^\s<"]+|(?:github|gitlab|bitbucket|stackoverflow|developer\.mozilla|en\.wikipedia|docs\.python|docs\.rust-lang|crates\.io|pypi\.org|npmjs\.com|docs\.oracle|learn\.microsoft|developer\.android|kubernetes\.io|docker\.com|nodejs\.org|python\.org|go\.dev|rust-lang\.org|swift\.org|jetbrains\.com|visualstudio\.com|atlassian\.com|confluence\.atlassian|jira\.atlassian|gerrit\.googlesource|gerrit-review\.googlesource)\.[a-z]+\/[^\s<]+)/gs;

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
        case 'renameSessionInput':
          await this.handleRenameSessionInput();
          break;
        case 'cancelTurn':
          await this.handleCancelTurn();
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
        case 'executeCommand':
          if (message.command) {
            await vscode.commands.executeCommand(message.command, ...(message.args || []));
          }
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
        case 'debugLog':
          // Forward webview debug logs to the ACP Client output channel
          if (DEBUG) {
            log('[DEBUG-WV] ' + (message.message || '(empty)'));
          }
          break;
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
    const updateData = update.update as any;

    // Debug: log user_message_chunk updates to trace raw context link issue
    if (DEBUG && updateData?.sessionUpdate === 'user_message_chunk') {
      const content = updateData.content;
      if (content?.type === 'text' && typeof content.text === 'string') {
        const preview = content.text.length > 200 ? content.text.substring(0, 200) + '...' : content.text;
        log(
          '[DEBUG-UMC] user_message_chunk received on ext host: len=' + content.text.length + ' text="' + preview + '"',
        );
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
      this.streamCoalescer.append(
        activeId,
        updateKind === 'agent_message_chunk' ? 'message' : 'thought',
        updateData.content.text,
      );
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
        const diffs = content.filter((c: any) => c.type === 'diff' && c.path);
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
        });
      });
      return;
    }

    this.postMessage({
      type: 'sessionUpdate',
      update: update.update,
      sessionId: update.sessionId,
    });
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
    const activeId = this.sessionManager.getActiveSessionId();
    if (!activeId) {
      this.postMessage({
        type: 'error',
        message: 'No active session. Create a session first.',
      });
      return;
    }

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
      try {
        // Kiro does not intercept `/compact` as a prompt — it requires
        // `_kiro.dev/commands/execute` (see kiro.dev ACP extensions).
        const session = this.sessionManager.getSession(activeId);
        const compactName = text.match(/^\/(compact|summarize|compress)(?:\s|$)/i)?.[1];
        if (compactName && this.sessionManager.isKiroAgentName(session?.agentName)) {
          await this.handleExecuteKiroCommand('compact');
        } else {
          await this.sessionManager.sendPrompt(activeId, text);
        }
      } catch (e: any) {
        logError('Slash command failed', e);
        this.postMessage({ type: 'error', message: e.message || 'Command failed' });
      } finally {
        // Flush any buffered streaming text before sending promptEnd.
        // Without this, the coalescer's 8ms timer may still be holding
        // the last agent_message_chunk(s) (e.g. the "Context compacted"
        // summary or the "Heads up" warning), causing promptEnd to arrive
        // at the webview first and queued messages to be drained before
        // the compacted text is rendered.
        this.streamCoalescer.flush(activeId);
        this.postMessage({ type: 'promptEnd', stopReason: 'end_turn' });
      }
      return;
    }

    // Tell webview we're processing
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
        const block = buildTerminalBlock(termOutput, supportsEmbedded);
        if (block) {
          contextBlocks.push(block);
        } else {
          text = `<terminal name="${name || 'active'}">\n${termOutput}\n</terminal>\n\n${text}`;
        }
      } else {
        // No terminal output available — shell integration may be inactive
        // (vscode-server/SSH) or the buffer is empty. Warn instead of silently
        // sending a bare "@terminal" keyword to the agent.
        const hint = this.terminalContext.isCaptureAvailable
          ? 'Run a command in the terminal first, then retry @terminal.'
          : 'Shell integration is unavailable (common on vscode-server / SSH). ' +
            'Enable "terminal.integrated.shellIntegration.enabled" in settings ' +
            'and use a supported shell.';
        vscode.window.showWarningMessage(`@terminal: no terminal output captured. ${hint}`);
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
      // Flush any buffered streaming text before sending promptEnd.  The
      // coalescer's 8 ms timer may still be holding the last agent_message_chunk(s);
      // without flushing, promptEnd arrives at the webview first and
      // commitCurrentTextSegment commits incomplete text.
      this.streamCoalescer.flush(activeId);
      // Agent acknowledged — cancel the fallback timer and clear pending session.
      if (this._cancelFallbackTimer) {
        clearTimeout(this._cancelFallbackTimer);
        this._cancelFallbackTimer = null;
      }
      this._pendingPromptSessionId = null;
      // Render the accumulated assistant text as markdown
      // The webview will have sent us the raw text via promptEnd handling
      this.postMessage({
        type: 'promptEnd',
        stopReason: response.stopReason,
        usage: (response as any).usage,
      });
      this.sessionManager.touchHistory(activeId);
    } catch (e: any) {
      // Clear fallback timer and pending session on error too.
      if (this._cancelFallbackTimer) {
        clearTimeout(this._cancelFallbackTimer);
        this._cancelFallbackTimer = null;
      }
      this._pendingPromptSessionId = null;
      logError('Prompt failed', e);
      const errMsg = e.data ? `${e.message}: ${e.data}` : e.message || 'Prompt failed';
      // Detect context length errors and provide actionable guidance
      this.postMessage({
        type: 'error',
        message: errMsg,
      });
      this.streamCoalescer.flush(activeId);
      this.postMessage({ type: 'promptEnd', stopReason: 'error' });
    }
  }

  /**
   * Handle cancel request from webview.
   */
  private async handleCancelTurn(): Promise<void> {
    const activeId = this.sessionManager.getActiveSessionId();
    if (activeId) {
      try {
        await this.sessionManager.cancelTurn(activeId);
      } catch (e) {
        logError('Cancel failed', e);
      }
      // Fallback: if the agent doesn't acknowledge the cancel within 10s
      // (some agents ignore session/cancel or don't respond to the prompt
      // with stopReason=cancelled), force the webview out of processing
      // mode so the Stop button becomes a Send button again.
      if (this._cancelFallbackTimer) {
        clearTimeout(this._cancelFallbackTimer);
      }
      this._cancelFallbackTimer = setTimeout(() => {
        if (this._pendingPromptSessionId === activeId) {
          log('Cancel fallback: agent did not acknowledge within 5s, forcing promptEnd');
          this.streamCoalescer.flush(activeId);
          this.sessionManager.forceAbortPrompt(activeId);
          this.postMessage({ type: 'promptEnd', stopReason: 'cancelled' });
          this._pendingPromptSessionId = null;
        }
        this._cancelFallbackTimer = null;
      }, 5_000);
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
      this.postMessage({ type: 'error', message: e.message || 'Command failed' });
    } finally {
      this.streamCoalescer.flush(activeId);
      this.postMessage({ type: 'promptEnd', stopReason: 'end_turn' });
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

  /** Handle @rename — show VS Code input box for the new session title. */
  private async handleRenameSessionInput(): Promise<void> {
    const activeId = this.sessionManager.getActiveSessionId();
    if (!activeId) {
      return;
    }
    const session = this.sessionManager.getActiveSession();
    const currentTitle = session?.title || '';
    const title = await vscode.window.showInputBox({
      prompt: 'Enter a new name for this conversation',
      value: currentTitle,
      placeHolder: 'Session name...',
    });
    if (title === undefined) {
      return;
    } // user cancelled
    const trimmed = title.trim();
    if (!trimmed) {
      return;
    }
    this.sessionManager.renameSession(activeId, trimmed);
    this.notifySessionInfoUpdate(trimmed);
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
        message: `Failed to set mode: ${e.data ? e.message + ': ' + e.data : e.message}`,
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
        message: `Failed to set model: ${e.data ? e.message + ': ' + e.data : e.message}`,
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
        message: `Failed to set ${configId}: ${e.data ? e.message + ': ' + e.data : e.message}`,
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
        const symFallback = linkText?.match(/^([a-zA-Z_][a-zA-Z0-9_]*(?:::[a-zA-Z_][a-zA-Z0-9_]*)*)/)?.[1];
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
        // Extract symbol name from linkText (e.g. "fen_shutdown()" → "fen_shutdown")
        const symMatch = linkText?.match(/^([a-zA-Z_][a-zA-Z0-9_]*(?:::[a-zA-Z_][a-zA-Z0-9_]*)*)/);
        const fullSym = symMatch?.[1];
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
      const symFallback = linkText?.match(/^([a-zA-Z_][a-zA-Z0-9_]*(?:::[a-zA-Z_][a-zA-Z0-9_]*)*)/)?.[1];
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
   * summarizes the best match via the ericai-proxy /v1/summarize-session
   * endpoint, and posts the summary back to the webview to display as a
   * context block in the chat.
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
    const originalActiveAgent = this.sessionManager.getActiveAgentName();

    try {
      // Capture messages from the selected session
      const messages = await this.captureSessionMessages(picked.sessionId, picked.agentName);

      // Ensure the original agent/session is active again after capture
      const currentActiveId = this.sessionManager.getActiveSessionId();
      if (!currentActiveId) {
        // The capture/restore lost the active session — reconnect
        this.suppressWebviewUpdates = true;
        try {
          const activeAgent = this.sessionManager.getActiveAgentName();
          if (activeAgent) {
            await this.sessionManager.connectToAgent(activeAgent);
          } else if (originalActiveAgent) {
            await this.sessionManager.connectToAgent(originalActiveAgent);
          }
        } finally {
          this.suppressWebviewUpdates = false;
        }
        this.sendCurrentState();
      }

      if (messages.length === 0) {
        this.postMessage({ type: 'sessionSummary', error: 'No messages found in that session.', queryText });
        return;
      }

      // Call the ericai-proxy summarize endpoint
      const proxyPort = 8317;
      const summaryResponse = await fetch('http://localhost:' + proxyPort + '/v1/summarize-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: picked.title,
          messages,
        }),
      });

      if (!summaryResponse.ok) {
        const errText = await summaryResponse.text();
        this.postMessage({
          type: 'sessionSummary',
          error: 'Summary failed: ' + summaryResponse.status + ' ' + errText.slice(0, 200),
          queryText,
        });
        return;
      }

      const result = (await summaryResponse.json()) as { summary: string; model: string };
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
      this.suppressWebviewUpdates = false;
    }

    // Restore the original session if it was different
    if (originalSessionId && originalSessionId !== sessionId) {
      // Reload the original session to restore the webview state
      this.suppressWebviewUpdates = true;
      try {
        await this.sessionManager.loadSession(activeAgent, originalSessionId);
      } catch {
        // If restore fails, the user is left on the summarized session
        // — not ideal but not fatal.
      } finally {
        this.suppressWebviewUpdates = false;
      }
    }

    return messages;
  }

  /**
   * Send current session state to the webview on load.
   */
  private sendCurrentState(): void {
    const activeId = this.sessionManager.getActiveSessionId();
    const session = activeId ? this.sessionManager.getSession(activeId) : null;
    // Read the last connected agent from workspaceState (persists across restarts).
    const lastAgent = this.workspaceState.get<string>('acp.lastConnectedAgent');
    const lastAgentDisplay = this.workspaceState.get<string>('acp.lastConnectedAgentDisplay');
    const lastSessionId = this.workspaceState.get<string>('acp.lastConnectedSessionId');
    this.postMessage({
      type: 'state',
      activeSessionId: activeId,
      session: session
        ? {
            sessionId: session.sessionId,
            agentName: session.agentDisplayName,
            agentConfigKey: session.agentName,
            title: cleanSessionTitle(session.title) || session.title,
            cwd: session.cwd,
            modes: session.modes,
            models: session.models,
            configOptions: session.configOptions,
            availableCommands: session.availableCommands,
            promptCapabilities: activeId ? this.sessionManager.getPromptCapabilities(activeId) : undefined,
            currentModelImageSupport: session.models?.currentModelId
              ? this.modelSupportsImage(session.models.currentModelId, session.agentName)
              : undefined,
            modelImageMap: this.getModelImageMap(),
          }
        : null,
      lastAgent: lastAgent || undefined,
      lastAgentDisplay: lastAgentDisplay || undefined,
      lastSessionId: lastSessionId || undefined,
      isFollowing: this._isFollowing,
    });
  }

  /**
   * Post a message to the webview if it exists and is ready.
   * Queues messages while the webview hasn't sent 'ready' yet.
   */
  private postMessage(message: any): void {
    if (this.webviewReady) {
      this.view?.webview.postMessage(message);
    } else {
      this.pendingMessages.push(message);
    }
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
    this.sendCurrentState();
  }

  /**
   * Notify webview of mode state changes.
   */
  notifyModesUpdate(modes: any): void {
    this.postMessage({ type: 'modesUpdate', modes });
  }

  /**
   * Notify webview of model state changes.
   */
  notifyModelsUpdate(models: any): void {
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
   */
  notifyConfigOptionsUpdate(configOptions: any): void {
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
    this.postMessage({ type: 'loadSessionEnd', ok });
  }

  /** Notify webview that session title / metadata changed. */
  notifySessionInfoUpdate(title: string | undefined | null): void {
    this.postMessage({ type: 'sessionInfoUpdate', title: title ?? null });
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
    const buildStamp = Date.now();

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};">
  <title>ACP Chat</title>
  <!-- BUILD-STAMP: ${buildStamp} -->
  <style>
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
    .session-banner .info { flex: 1; }
    .session-banner .agent { font-weight: 600; }
    .session-banner .cwd {
      font-size: 0.85em;
      opacity: 0.6;
      margin-top: 1px;
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
      gap: 8px;
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
      gap: 4px;
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
      margin: 2px 0;
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
   /* Cursor/ACP todos belong with turn details; hide plan-bar dump while Collapse is on. */
   .messages.compact-mode ~ .plan-bar.cursor-todos-outside {
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
    }
   .tool-call-inline .tc-icon.pending { color: var(--vscode-badge-foreground); }
   .tool-call-inline .tc-icon.running { color: var(--vscode-progressBar-background); animation: tc-spin 1s linear infinite; }
   .tool-call-inline .tc-icon.in_progress { color: var(--vscode-progressBar-background); animation: tc-spin 1s linear infinite; }
   .tool-call-inline .tc-icon.completed { color: var(--vscode-testing-iconPassed); }
    .tool-call-inline .tc-icon.failed { color: var(--vscode-testing-iconFailed); }
    @keyframes tc-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    .tool-call-inline .tc-title {
      flex: 1;
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
     margin: 2px 0 2px 10px;
     padding-left: 8px;
     border-left: 1px solid var(--vscode-widget-border);
     display: flex;
     flex-direction: column;
     gap: 1px;
   }
   /* Subagent stages (Kiro crew) */
   .tool-call-inline .tc-stages { margin-top: 4px; margin-left: 20px; }
   .tool-call-inline .tc-stage { padding: 2px 0; font-size: 0.9em; opacity: 0.85; }
  .tool-call-inline .tc-stage-icon { color: var(--vscode-symbolIcon-iconForeground); margin-right: 4px; display: inline-block; }
  .tool-call-inline .tc-stage-name { font-weight: 500; }
   .tool-call-inline .tc-stage-role { margin-left: 6px; font-size: 0.85em; opacity: 0.7; }
   .tool-call-inline .tc-stage-depends { margin-left: 6px; font-size: 0.85em; opacity: 0.6; }
  .tool-call-inline .tc-stage-desc { margin-left: 18px; font-size: 0.85em; opacity: 0.6; }
 .tool-call-inline .tc-stage-icon.running,
 .tool-call-inline .tc-stage-icon.in_progress { color: var(--vscode-progressBar-background); animation: tc-spin 1s linear infinite; }
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
   // extension host). The host's DEBUG flag is not visible here, so without
   // this the replay trace (trace()) would stay silent.
   const DEBUG = true;
  const messagesEl = document.getElementById('messages');
  const psPanel = document.getElementById('psPanel');
  const resumeBar = document.getElementById('resumeBar');
  const planBar = document.getElementById('planBar');
   const emptyState = document.getElementById('emptyState');
    const promptInput = document.getElementById('promptInput');
    const sendStopBtn = document.getElementById('sendStopBtn');
    const attachBtn = document.getElementById('attachBtn');
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
 let isProcessing = false;
let isForceCancelled = false; // true after cancel fallback forces promptEnd
let hasSentPrompt = false;
var pendingRenderRetries = {}; // keys of pending renderMarkdown retries
var historyRenderGen = 0; // generation counter for history renders (invalidated on DOM rebuild)
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
        return;
      }
      msgQueueLabelEl.style.display = 'block';
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
       chip.appendChild(sendNowBtn);
       msgQueueEl.appendChild(chip);
     });
   }

   function queueMessage(text, images) {
     messageQueue.push({ text, images: images || [] });
     renderQueue();
   }

   // Remove a message from the queue by index
   function removeQueuedMessage(index) {
     messageQueue.splice(index, 1);
     renderQueue();
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
   function sendQueuedMessageNow(index) {
     if (index < 0 || index >= messageQueue.length) return;
     const entry = messageQueue[index];
     // Remove from queue immediately
     messageQueue.splice(index, 1);
     renderQueue();

     if (isProcessing) {
       // Set the pending message; it will be sent once promptEnd fires
       // after the cancel completes.
       pendingSendAfterCancel = entry;
       vscode.postMessage({ type: 'cancelTurn' });
     } else {
       // Not processing — send directly
       addMessage('user', entry.text || '(image)');
       hasSentPrompt = true;
       vscode.postMessage({ type: 'sendPrompt', text: entry.text || ' ', images: entry.images });
     }
   }

   function drainQueue() {
     if (messageQueue.length === 0) return false;
     const entry = messageQueue.shift();
     renderQueue();
     // Send the queued message as if the user typed it
     addMessage('user', entry.text || '(image)');
     hasSentPrompt = true;
     vscode.postMessage({ type: 'sendPrompt', text: entry.text || ' ', images: entry.images });
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

  /** Built-in client-side slash commands (always available). */
const builtinCommands = [
  { name: 'rename', description: 'Rename the current conversation' },
  { name: 'session', description: 'Add a past session summary as context' },
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
     * Clean a user message by stripping all injected context blocks
     * (<open_files>, <selection>, <terminal>, <problems>, <file>, <folder>).
     * Falls back to the original if the result is empty.
     */
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
   while (true) {
     var jsonStart = 0;
     while (jsonStart < displayText.length) {
       var jc = displayText.charCodeAt(jsonStart);
       if (jc === 32 || jc === 10 || jc === 13 || jc === 9) { jsonStart++; } else break;
     }
     if (displayText.charCodeAt(jsonStart) !== 123 /* '{' */) break;
     var jsonEnd = displayText.indexOf('}', jsonStart);
     if (jsonEnd < 0) break;
     var jsonStr = displayText.substring(jsonStart, jsonEnd + 1);
     try {
       var parsed = JSON.parse(jsonStr);
       if (parsed && parsed.type === 'resource_link' && typeof parsed.uri === 'string') {
         displayText = displayText.substring(jsonEnd + 1);
         continue;
       }
     } catch (e) { /* not valid JSON, stop */ }
     break;
   }
 // Strip leading <context ref="...">...</context> blocks
 displayText = stripTag(displayText, 'context', null);
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
  vscode.setState({ chatHistory: capped, sessionState, hasActiveSession, lastConnectedAgent, lastConnectedAgentDisplay, lastConnectedSessionId });
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
    lastConnectedAgent = saved.lastConnectedAgent || null;
    lastConnectedAgentDisplay = saved.lastConnectedAgentDisplay || null;
    lastConnectedSessionId = saved.lastConnectedSessionId || null;
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
       // Clean user messages so restored state does not show raw
        // <open_files>/<selection>/etc. blocks from before the fix.
        if (riItem && riItem.kind === 'message' && riItem.role === 'user' && typeof riItem.text === 'string') {
          riItem = { kind: 'message', role: 'user', text: cleanUserMessage(riItem.text) };
        }
       // Force any interrupted tool calls to 'failed' status.
       // When a session is closed abruptly, in_progress/running tool calls
       // will never complete — they should show as failed, not spinning forever.
       if (riItem && riItem.kind === 'toolCall' && (riItem.status === 'in_progress' || riItem.status === 'running' || riItem.status === 'pending')) {
         riItem = { ...riItem, status: 'failed' };
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

    // Render chat history using compact turn-based inline layout
    // (groups tool calls into collapsible containers instead of standalone cards)
    var assistantItems = renderChatHistory();
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

  // If there's chat history but no active session, show a prominent
    // resume button in the fixed resume bar (always visible, no scroll needed).
    updateResumeBar();

   // Start with input disabled
   }

   // Start with input disabled
   if (inputArea) inputArea.classList.add('disabled');
    let currentAssistantEl = null;
    let currentAssistantText = '';
    let currentTurnEl = null;       // .turn container for current response
    let currentToolsListEl = null;  // .turn-tools-list inside current turn
    let currentToolsCountEl = null; // .turn-tools-summary counter
    let currentToolCount = 0;
    currentPsEl = null;
    if (psPanel) psPanel.style.display = 'none';
    let toolCalls = {};
    let toolCallDiffs = {};

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
    function updateSendButton() {
      if (isProcessing) return; // Stop button is always enabled
      const hasText = promptInput.value.trim().length > 0;
      sendStopBtn.disabled = !hasText;
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
         { name: 'rename', description: 'Rename the current conversation' },
         { name: 'session', description: 'Add a past session summary as context' },
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
      } else {
        slashPopup.classList.remove('open');
        isSessionAutocomplete = false;
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
      slashPopup.classList.remove('open');
      isSessionAutocomplete = false;
      if (!text.startsWith('/')) {
        promptInput.placeholder = savedPlaceholder;
      }
    }
    });

   // Send on Enter (Shift+Enter for newline)
   promptInput.addEventListener('keydown', (e) => {
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

   if (e.key === 'Enter' && !e.shiftKey) {
     e.preventDefault();
     // While a turn is streaming, Enter queues the message instead of
     // blocking. Queued messages auto-send when the current turn finishes.
     // Fast-track: if the editor is empty and there are queued messages,
     // pressing Enter sends the first queued message immediately (like Zed).
     var fastTrackText = promptInput.value.trim();
     if (!fastTrackText && pendingImages.length === 0 && messageQueue.length > 0) {
       sendQueuedMessageNow(0);
       return;
     }
     if (isProcessing) {
       // /rename works even during streaming (like Claude Code's immediate commands)
       if (handleLocalSlashCommand()) { return; }
       // Allow slash commands through during streaming — the agent
       // handles read-only commands (e.g. /ps, /status) without
       // interrupting the in-progress LLM turn.
       var slashText = promptInput.value.trim();
       if (slashText.startsWith('/')) { handleSend(); return; }
       handleQueue();
       return;
     }
     handleSend();
   }
 });

    function handleQueue() {
      const text = promptInput.value.trim();
      if (!text && pendingImages.length === 0) return;
      const images = pendingImages.splice(0);
      imagePreviewStrip.innerHTML = '';
      promptInput.value = '';
      updateSendButton();
      queueMessage(text, images);
    }

  /**
   * Handle client-side slash commands that should execute immediately,
   * even during streaming (like Claude Code's immediate:true commands).
   * Returns true if the command was handled (caller should stop).
   */
 function handleLocalSlashCommand() {
   var text = promptInput.value.trim();
   if (!text.startsWith('/')) { return false; }
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
    // Try to match the longest known session name at the start of args.
    // Session names can contain spaces (e.g. "ue session route path").
    var sessionArgs = sessionMatch[1].trim();
    var sessionName = '';
    var remainingQuery = '';
    var bestMatchLen = 0;
    for (var si = 0; si < sessionNames.length; si++) {
      var sn = sessionNames[si];
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
}
  // /compact|/summarize|/compress — context compaction where the agent
  // supports it. Kiro: _kiro.dev/commands/execute. Codex/Claude: session/prompt.
  // Cursor Agent has no compact slash command (its available_commands_update
  // never advertises one) — do not fake /summarize or send a dead prompt.
  var compactMatch = text.match(/^\\/(compact|summarize|compress)\\b(.*)$/i);
  if (compactMatch) {
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
    if (kiroCompactWatchdog) { clearTimeout(kiroCompactWatchdog); kiroCompactWatchdog = null; }
    setProcessing(true);
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
        hideCompactionProgress();
        if (statusEl) statusEl.innerHTML = '';
        setProcessing(false);
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
    if (isClearing || isCompacting) { return true; }
    promptInput.value = '';
    updateSendButton();
    pendingImages.splice(0);
    imagePreviewStrip.innerHTML = '';
    var isKiroClear = sessionState && /kiro/i.test(sessionState.agentName || sessionState.agentConfigKey || '');
    if (isKiroClear) {
      isClearing = true;
      setProcessing(true);
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
      currentToolsListEl = null;
      currentToolsCountEl = null;
      currentToolCount = 0;
      toolCalls = {};
      toolCallDiffs = {};
      saveState();
      vscode.postMessage({ type: 'sendPrompt', text: '/clear' });
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
    // Auto-scroll messages to bottom so latest streamed content stays visible
    // even when the ps panel takes vertical space on small chat panels.
    scrollToBottom();
    return true;
  }
  
  
  
  return false;
}

 function handleSend() {
   const text = promptInput.value.trim();
   if (!text && pendingImages.length === 0) return;
   // Block input during /compact — compaction is an atomic operation
   // (like codex TUI's set_task_running(true) during compact).
   // BUT allow local slash commands (e.g. /ps, /rename) that don't
   // interact with the agent.
   if (isCompacting || isClearing) {
     if (text.startsWith('/')) {
       if (handleLocalSlashCommand()) { return; }
     }
     return;
   }
   // /rename works immediately, even during streaming
   if (handleLocalSlashCommand()) { return; }
// Allow slash commands through during streaming — the agent
   // handles read-only commands (e.g. /ps, /status) without
   // interrupting the in-progress LLM turn.
   if (isProcessing && !text.startsWith('/')) return;

   addMessage('user', text || '(image)');
    promptInput.value = '';
    const images = pendingImages.splice(0);
    imagePreviewStrip.innerHTML = '';
    updateSendButton();
    hasSentPrompt = true;
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

  // Compact mode toggle — collapse/expand all turn folds (thought + tools + reply)
 var compactMode = true; // default: compact (collapsed)
 const compactToggleBtn = document.getElementById('compactToggle');
 if (messagesEl) messagesEl.classList.add('compact-mode');
 if (compactToggleBtn) {
   compactToggleBtn.addEventListener('click', function() {
     compactMode = !compactMode;
     compactToggleBtn.classList.toggle('active', compactMode);
      compactToggleBtn.setAttribute('aria-pressed', compactMode ? 'true' : 'false');
     if (messagesEl) messagesEl.classList.toggle('compact-mode', compactMode);
     applyCompactModeToAllTurns(compactMode);
     // Collapse hides outside dumps (Cursor todos plan-bar). Clear when turning on.
     if (compactMode && planBar && planBar.classList.contains('cursor-todos-outside')) {
       planBar.classList.remove('cursor-todos-outside');
       planBar.innerHTML = '';
     }
   });
  }

   // Wire up buttons
    sendStopBtn.addEventListener('click', () => {
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
    vscode.postMessage({ type: 'executeCommand', command: 'acp.connectAgent', args: [{ agentName: lastConnectedAgent, sessionId: lastConnectedSessionId }] });
  } else {
    execCmd('acp.connectAgent');
  }

 });
 updateWelcomeButton();

   // --- Send/Stop toggle ---
    function setProcessing(processing) {
      isProcessing = processing;
      if (processing) {
        sendStopBtn.className = 'send-stop-btn stop';
        sendStopBtn.textContent = '■ Stop';
        sendStopBtn.disabled = false;
        // Keep textarea enabled so user can type next message while processing.
        // The Send button is replaced by Stop, so sending is blocked via isProcessing.
        promptInput.disabled = false;
        statusEl.innerHTML = '<span class="spinner"></span>';
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
    // Lightweight trace: only posts to the extension host when DEBUG is true.
    function trace(msg) {
      if (DEBUG) vscode.postMessage({ type: 'debugLog', message: '[REPLAY-TRACE] ' + msg });
    }

 function handleLoadSessionStart() {
   vscode.postMessage({ type: 'debugLog', message: 'handleLoadSessionStart' });
   // Cancel all pending render retries from restoreState — the DOM is
   // about to be wiped and rebuilt, so stale renderMarkdown requests
   // would target wrong elements.
   for (var _rk in pendingRenderRetries) { delete pendingRenderRetries[_rk]; }
   currentPsEl = null;
    if (psPanel) psPanel.style.display = 'none';
    isLoadingSession = true;
    // A historical "Context compacted" tool_call during session/load must NOT
    // leave isCompacting stuck true — that silently blocks handleSend().
    isCompacting = false;
    manualCompacting = false;
    isClearing = false;
    compactedWarningText = '';
    compactedNoticeText = '';
    if (compactionFlushTimer) { clearTimeout(compactionFlushTimer); compactionFlushTimer = null; }
    hideCompactionProgress();
    tokenUsage = null;
     hasSentPrompt = false;
     if (tokenUsageRing) tokenUsageRing.classList.remove('visible');
      // Reset all chat state; behaves like clearChat but keeps the session
      // banner / input area structure intact.
      chatHistory = [];
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
      messagesEl.innerHTML = '';
      if (emptyState) {
        messagesEl.appendChild(emptyState);
        emptyState.style.display = 'none';
      }
      if (loadOverlay) loadOverlay.classList.add('visible');
      if (inputArea) inputArea.classList.add('disabled');
      promptInput.disabled = false; // keep textarea editable during load
      setProcessing(false);
    }

  function handleLoadSessionEnd(ok) {
    hideEmpty();
    isLoadingSession = false;
    // Safety: never leave compact-mode latched after a history replay.
    isCompacting = false;
    manualCompacting = false;
    isClearing = false;
    compactedWarningText = '';
    compactedNoticeText = '';
    if (compactionFlushTimer) { clearTimeout(compactionFlushTimer); compactionFlushTimer = null; }
    hideCompactionProgress();
    // If history was replayed, there were prior prompts — mark as sent
    // so the context usage ring can appear when metadata arrives.
    if (chatHistory.length > 0) hasSentPrompt = true;
    // Force any interrupted tool calls to 'failed' status.
     // After session replay, any tool calls still in 'in_progress'/'running'/'pending'
     // state will never receive a completion update — they were interrupted.
     for (let i = 0; i < chatHistory.length; i++) {
       const item = chatHistory[i];
       if (item && item.kind === 'toolCall' &&
           (item.status === 'in_progress' || item.status === 'running' || item.status === 'pending')) {
         item.status = 'failed';
         const el = toolCalls[item.toolCallId] || document.getElementById('tc-' + item.toolCallId);
         if (el) {
           const iconEl = el.querySelector('.tc-icon');
           if (iconEl) { iconEl.className = 'tc-icon failed'; iconEl.textContent = getStatusIcon('failed'); }
           const badge = el.querySelector('.status-badge');
           if (badge) { badge.className = 'status-badge failed'; badge.textContent = 'failed'; }
         }
       }
     }
     saveState();
     // Commit any trailing assistant turn captured during the replay.
     finalizeCurrentAssistantTurn();
     // Rebuild the entire messages DOM from chatHistory.  During replay,
     // the agent_message_chunk / tool_call handlers build DOM piecemeal,
     // but race conditions (coalescer delays, interleaved user_message_chunk
     // calls to finalizeCurrentAssistantTurn) can leave the DOM out of sync
     // with chatHistory — particularly assistant text elements that were
     // committed to history without a corresponding DOM node.  Rebuilding
     // from scratch (same pattern as restoreState) guarantees every
     // chatHistory entry has a DOM element before we batch-render markdown.
    var assistantItems = renderChatHistory();
    // renderChatHistory clears isLoadingSession's DOM rebuild while the flag
    // is already false — force folds shut again after promote.
    forceCollapseTurnFolds();
    if (loadOverlay) loadOverlay.classList.remove('visible');
    if (inputArea) inputArea.classList.remove('disabled');
    updateSendButton();
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
     bannerAgent.textContent = sessionState.title || sessionState.agentName || 'Agent';
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
       if (cmd.name === 'rename') {
         // @rename — ask extension to show an input box for the new title
         promptInput.value = promptInput.value.slice(0, -atMatch[0].length);
         vscode.postMessage({ type: 'renameSessionInput' });
         promptInput.focus();
         return;
       }
      if (cmd.name === 'file' || cmd.name === 'folder') {
         // Ask extension to pick a file/folder and return the path
         promptInput.value = promptInput.value.slice(0, -atMatch[0].length);
         vscode.postMessage({ type: 'pickContext', contextType: cmd.name });
       } else if (cmd.name === 'session') {
         // Ask extension to pick a session to summarize as context
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
     // If configOptions are active, don't show the legacy model picker.
     if (useConfigOptions) { modelPickerWrap.classList.add('hidden'); return; }
     if (!models || !models.availableModels || models.availableModels.length === 0) {
        modelPickerWrap.classList.add('hidden');
        availableModels = [];
        currentModelId = null;
        return;
      }
      availableModels = models.availableModels;
      currentModelId = models.currentModelId || null;
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
        // Hide OpenAI-specific fast-mode toggle (1.5x speed) — not supported by EricAI/vLLM
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
      if (v.description) item.title = v.description;
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

    function setConfigOptionsState(opts) {
      configOptions = Array.isArray(opts) ? opts : [];
      useConfigOptions = configOptions.length > 0;

      if (useConfigOptions) {
        // Hide legacy pickers — spec requires configOptions to be used exclusively
        modePickerWrap.classList.add('hidden');
        modelPickerWrap.classList.add('hidden');
        renderConfigPickers(configOptions);
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
       if (it && it.kind === 'message' && it.role === 'system' &&
           String(it.text || '').trim() === 'Conversation compacted.') {
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
       case 'in_progress': return '⟳';
      case 'completed': return '✓';
      case 'failed':
      case 'error': return '✗';
      default: return '…';
    }
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
        // Sticky expand only while the turn is still streaming — completed
        // turns must not stay open across promptEnd / history restore.
        body._userExpanded = !isLoadingSession && isProcessing && willExpand;
        // Collapsing mid-stream: tuck the live bubble back into the fold in
        // case a sticky rebuild had parked it outside as assistant-summary.
        if (!willExpand && isProcessing && currentAssistantEl && turn &&
            turn.contains(currentAssistantEl) &&
            !currentAssistantEl.classList.contains('md-committed')) {
          moveAssistantIntoFold(currentAssistantEl);
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

    function isMeaningfulThought(el) {
      if (!el) return false;
      if (el === currentThoughtEl) return true;
      if (el.classList.contains('streaming')) return true;
      var content = el.querySelector('.thought-content');
      if (content && content.textContent && content.textContent.trim()) return true;
      // Keep finalized cards even if content was briefly empty.
      var sum = el.querySelector('summary');
      var sumText = (sum && sum.textContent) || '';
      return /Thought\b/i.test(sumText);
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
        currentThoughtEl.open = false;
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
          chatHistory.push({
            kind: 'thought',
            text: historyText,
            durationSec: thoughtStartTime ? Math.round(((thoughtEndTime || Date.now()) - thoughtStartTime) / 1000) : 0,
          });
          saveState();
          if (currentThoughtEl) currentThoughtEl._thoughtCommitted = true;
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
     *     > .turn-tools-summary          (Thought · tools)
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
        // Exception: placeSummaryAssistant runs on promptEnd before
        // setProcessing(false), so a just-promoted md-committed summary must
        // stay outside even while isProcessing is briefly still true.
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
      summaryAssistants.forEach(function(a) {
        a.classList.add('assistant-summary');
        a.classList.remove('assistant-interim');
      });

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
        body = document.createElement('div');
        body.className = collapsed ? 'turn-fold-body collapsed' : 'turn-fold-body';
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
      orderCompactFoldContents(body);

      // Final summary assistant(s) always sit after the fold (visible while collapsed).
      summaryAssistants.forEach(function(a) {
        if (body.nextSibling) turn.insertBefore(a, body.nextSibling);
        turn.appendChild(a);
      });

      // Belt-and-suspenders: live streaming bubble must stay inside the fold
      // even if a prior rebuild parked it outside as assistant-summary.
      // Skip md-committed summaries already lifted by placeSummaryAssistant.
      if (isProcessing && !isLoadingSession && currentAssistantEl &&
          turn.contains(currentAssistantEl) &&
          !currentAssistantEl.classList.contains('md-committed')) {
        currentAssistantEl.classList.add('assistant-interim');
        currentAssistantEl.classList.remove('assistant-summary');
        body.appendChild(currentAssistantEl);
      }

      // Default shut. Honor sticky expand only while a live turn is streaming
      // (isProcessing) — never during session/load or after promptEnd.
      var allowSticky = collapsed && body._userExpanded && isProcessing && !isLoadingSession;
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
      // Stable document order
      foldables.sort(function(a, b) {
        if (a === b) return 0;
        var pos = a.compareDocumentPosition(b);
        if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
        return 0;
      });
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
      return !!currentTurnEl.querySelector(
        '.tc-icon.running, .tc-icon.in_progress, .tc-icon.pending, ' +
        '.tc-stage-icon.running, .tc-stage-icon.in_progress, .tc-stage-icon.pending'
      );
    }

    function turnHasAnyTools() {
      if (currentToolCount > 0) return true;
      if (!currentTurnEl) return false;
      if (currentTurnEl.querySelector('.tool-call-inline, .tool-call')) return true;
      var sum = getTurnSummaryEl(currentTurnEl);
      return !!(sum && parseInt(sum.dataset.count || '0', 10) > 0);
    }

    function scheduleProvisionalSummaryPromote() {
      // Disabled. Promoting on an idle timer leaked Claude/Codex mid-turn
      // lines ("I'll spawn…", status chatter) into the main chat while
      // Collapse is on. The final reply is lifted only on promptEnd via
      // commitCurrentTextSegment → placeSummaryAssistant.
      cancelProvisionalSummaryPromote();
    }

    /** After history restore: lift the last assistant out of the fold as the reply. */
    function promoteFinalAssistantForTurn(turn) {
      if (!turn || !compactMode) return;
      var assistants = Array.prototype.slice.call(turn.querySelectorAll('.message.assistant'));
      if (!assistants.length) return;
      var body = getTurnFoldBody(turn) || ensureTurnFoldStructure(turn, true, true);
      assistants.forEach(function(a, idx) {
        if (idx === assistants.length - 1) {
          a.classList.add('assistant-summary');
          a.classList.remove('assistant-interim');
          turn.appendChild(a);
        } else {
          a.classList.add('assistant-interim');
          a.classList.remove('assistant-summary');
          if (body) body.appendChild(a);
        }
      });
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
        if (isSubagentToolCall(tcTitle, tcKind)) hasSubagent = true;
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
          var body = getTurnFoldBody(turn);
          if (body) body._userExpanded = false;
          ensureTurnFoldStructure(turn, true);
          body = getTurnFoldBody(turn);
          if (body) setFoldExpanded(body, false);
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
      // Compact: keep the live bubble inside the fold for the whole turn.
      // Mid-turn Claude/Codex lines must not appear in the main chat.
      // promptEnd → commitCurrentTextSegment → placeSummaryAssistant lifts
      // the final reply outside.
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
    for (var i = 0; i < titles.length; i++) {
      var cat;
      var kind = kinds && kinds[i];
      // Prefer concrete ACP kinds (read/edit/…) over title heuristics. A read of
      // a file named close_agent must not become "1 subagent op".
      if (kind && kind !== 'other' && kind !== 'think') {
        cat = acpKindToCategory(kind);
      } else if (isSubagentToolCall(titles[i], kind)) {
        cat = 'agent';
        // Distinguish spawn (creates agents) from other agent ops (wait/close/etc)
        if (isSubagentSpawnTitle(titles[i])) {
          // For Kiro's "Spawning agent crew", count stages array
          var ri = rawInputs && rawInputs[i];
          spawnCount += getSubagentSpawnCount(titles[i], ri);
        } else {
          agentOpCount++;
        }
      } else if (kind) {
        cat = acpKindToCategory(kind);
      } else {
        cat = categorizeToolCall((titles[i] || '').toLowerCase());
      }
      counts[cat] = (counts[cat] || 0) + 1;
      total++;
    }
    var parts = [];
    // Show spawn as "spawned N subagent(s)" and other agent ops as "N subagent op(s)"
    if (spawnCount > 0) parts.push('spawned ' + spawnCount + ' subagent' + (spawnCount > 1 ? 's' : ''));
    if (agentOpCount > 0) parts.push(agentOpCount + ' subagent op' + (agentOpCount > 1 ? 's' : ''));
    if (counts.read) parts.push(counts.read + ' read' + (counts.read > 1 ? 's' : ''));
    if (counts.edit) parts.push(counts.edit + ' edit' + (counts.edit > 1 ? 's' : ''));
    if (counts.search) parts.push(counts.search + ' search' + (counts.search > 1 ? 'es' : ''));
    if (counts.command) parts.push(counts.command + ' command' + (counts.command > 1 ? 's' : ''));
    if (counts.plan) parts.push(counts.plan + ' plan update' + (counts.plan > 1 ? 's' : ''));
    if (counts.other) parts.push(counts.other + ' other');
    if (parts.length === 0) return total + ' tool call' + (total !== 1 ? 's' : '');
    return parts.join(', ');
  }
 
   function categorizeToolCall(title) {
     var t = (title || '').toLowerCase().trim();
     // Extract the first word (command name) for matching, since full titles
     // may contain file paths that accidentally match keywords (e.g. "thread_reader" matches "read").
    var firstWord = t.split(/\\s+/)[0];
     // Also check the full title for keywords like "read file" or "search for"
     // but only match word-boundary keywords, not substrings inside paths.
     var kw = ' ' + t + ' ';
     if (firstWord === 'read' || firstWord === 'read_file' || firstWord === 'fs_read' ||
         firstWord.indexOf('read_') === 0 || firstWord === 'cat' || firstWord === 'view' ||
         kw.indexOf(' read ') >= 0 || kw.indexOf(' view ') >= 0 || kw.indexOf(' read_file ') >= 0) {
       return 'read';
     }
     if (firstWord === 'edit' || firstWord === 'write' || firstWord === 'write_file' ||
         firstWord === 'patch' || firstWord === 'apply' || firstWord.indexOf('edit_') === 0 ||
         kw.indexOf(' edit ') >= 0 || kw.indexOf(' write ') >= 0 || kw.indexOf(' patch ') >= 0) {
       return 'edit';
     }
     if (firstWord === 'search' || firstWord === 'grep' || firstWord === 'find' || firstWord === 'glob' || firstWord === 'rg' || kw.indexOf(' search ') >= 0 || kw.indexOf(' grep ') >= 0 || kw.indexOf(' find ') >= 0) return 'search';
     if (firstWord === 'ls' || firstWord === 'command' || firstWord === 'exec' || firstWord === 'shell' || firstWord === 'run' || firstWord === 'cd' || kw.indexOf(' command ') >= 0 || kw.indexOf(' exec ') >= 0 || kw.indexOf(' run ') >= 0) return 'command';
     if (firstWord === 'plan' || firstWord === 'todo' || kw.indexOf(' plan ') >= 0 || kw.indexOf(' todo ') >= 0) return 'plan';
     return 'other';
   }

  // Map ACP protocol ToolKind to our summary category
  function acpKindToCategory(kind) {
    switch (kind) {
      case 'read': return 'read';
      case 'edit':
      case 'delete':
      case 'move': return 'edit';
      case 'search':
      case 'fetch': return 'search';
      case 'execute': return 'command';
      case 'think': return 'plan';
      case 'switch_mode':
      case 'other': return 'other';
      default: return 'other';
    }
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
  function isSubagentToolCall(title, toolKind) {
    // Concrete ACP file/command kinds are never collab-agent controls — even
    // when the title/path is literally "close_agent" / "wait" / etc.
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
    // Claude ACP Agent tool: title is usually "Task", toolName "Agent" in _meta.
    if (lower === 'task' || lower === 'agent') return true;
    return false;
  }

  function isSubagentSpawnTitle(title) {
    var tn = (title || '').trim();
    var tnLower = tn.toLowerCase();
    return tn === 'spawnAgent' || tn === 'spawn_agent' || tn === 'spawn_agents_on_csv' ||
      (tnLower.startsWith('spawn') && tnLower.includes('agent')) ||
      tnLower === 'subagent' ||
      (tnLower.includes('spawning') && tnLower.includes('agent')) ||
      tnLower.includes('agent crew') ||
      tnLower === 'task' ||
      tnLower === 'agent';
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
     var toolCount = count || (titles && titles.length) || 0;
     if (!toolCount) {
       var turn = summaryEl.closest && summaryEl.closest('.turn');
       if (turn) {
         toolCount = turn.querySelectorAll('.tool-call-inline:not([data-parent-tool])').length;
       }
     }
     // Hide the collapse header until there is at least one tool call —
     // no "0 tool calls" / empty label during intermediate thought/reply.
     if (toolCount === 0) {
       summaryEl.style.display = 'none';
       summaryEl.innerHTML = '';
       return;
     }
     summaryEl.style.display = '';
     var turnForFold = summaryEl.closest && summaryEl.closest('.turn');
     var body = (turnForFold && getTurnFoldBody(turnForFold)) || summaryEl.nextElementSibling;
     var isOpen = !!(body && (
       body.classList.contains('expanded') ||
       (body.classList.contains('collapsed') === false && !(messagesEl && messagesEl.classList.contains('compact-mode')))
     ));
     var detail = generateToolGroupSummary(titles, kinds, rawInputs);
     if (!detail) detail = toolCount + ' tool call' + (toolCount === 1 ? '' : 's');
     summaryEl.innerHTML = (isOpen ? '▾ ' : '▸ ') + '<span class="tc-summary-detail">' + escapeHtml(detail) + '</span>';
   }

    /**
     * Commit the current text segment to history and request its markdown render.
     * @param opts.interim  when true (mid-turn, before more tools), tuck the
     *   segment into the collapse fold so only the final summary stays visible.
     */
  function commitCurrentTextSegment(opts) {
    if (!currentAssistantText) return;
    cancelProvisionalSummaryPromote();
    var asInterim = !!(opts && opts.interim);
    var _commitPreview = currentAssistantText.replace(/\\s+/g, ' ').slice(0, 80);
    vscode.postMessage({ type: 'debugLog', message: '[WV-COMMIT] commitCurrentTextSegment: textLen=' + currentAssistantText.length + ' hasEl=' + !!currentAssistantEl + ' interim=' + asInterim + ' chatHistoryLen BEFORE=' + chatHistory.length + ' preview="' + _commitPreview + '"' });
    streamingRenderGen++; // invalidate any in-flight streaming renders
    var committedText = currentAssistantText;
    chatHistory.push({ kind: 'message', role: 'assistant', text: committedText });
    saveState();
    vscode.postMessage({ type: 'debugLog', message: '[WV-COMMIT] AFTER push chatHistoryLen=' + chatHistory.length + ' index=' + (chatHistory.length - 1) });
   if (currentAssistantEl) {
       // Keep the existing rendered HTML in place while we request a fresh
       // render. Previously this removed md-rendered and set textContent to
       // the raw markdown, which caused a flash of unrendered markdown at
       // promptEnd (the "intermediate raw markdown when finish" bug). The
       // markdownRendered handler will replace innerHTML when the new render
       // arrives; until then, the already-rendered HTML is the best display.
       // Don't remove md-rendered — the handler checks data-render-hash to
       // decide whether to update.
       var renderIndex = chatHistory.length - 1;
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
      currentAssistantEl.setAttribute('data-history-index', String(chatHistory.length - 1));
      if (asInterim && compactMode) {
        moveAssistantIntoFold(currentAssistantEl);
        // Next tools must open a new group after this interim segment.
        currentToolsListEl = null;
      } else {
        // Final segment: lift out of the fold (e.g. text-only turn that was
        // provisionally folded, or summary that already streams outside).
        placeSummaryAssistant(currentAssistantEl);
      }
    }
    currentAssistantEl = null;
    currentAssistantText = '';
    if (streamingRenderTimer) { clearTimeout(streamingRenderTimer); streamingRenderTimer = null; }
   }

    function addToolCall(toolCallId, title, status, content, rawInput, toolKind, locations, parentToolUseId) {
      if (currentPsEl) { currentPsEl = null; if (psPanel) psPanel.style.display = 'none'; }
      // Cursor stub tool_call ({_toolName:"task"}) — rich UI comes from cursor/task.
      if (isCursorTaskPlaceholder(title, rawInput)) {
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
      vscode.postMessage({ type: 'debugLog', message: '[WV-ADDTC] title="' + title + '" id=' + (toolCallId || '').slice(0, 12) + ' chatHistoryLen BEFORE=' + chatHistory.length + ' currentAssistantTextLen=' + currentAssistantText.length + ' hasCurrentAssistantEl=' + !!currentAssistantEl });
      // Top-level tools must commit any in-flight assistant text so history
      // order stays text → tools.
      if (currentAssistantText) {
        commitCurrentTextSegment({ interim: true });
      }
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
      storeDiffContent(toolCallId, content);
      addToolCallInline(toolCallId, title, status, rawInput, toolKind, locations, null);
      vscode.postMessage({ type: 'debugLog', message: '[WV-ADDTC] AFTER push chatHistoryLen=' + chatHistory.length });
    }

    function storeDiffContent(toolCallId, content) {
      if (!content || !Array.isArray(content)) return;
      const diffs = content.filter(c => c.type === 'diff' && c.path);
      if (diffs.length > 0) {
        toolCallDiffs[toolCallId] = diffs;
        const el = toolCalls[toolCallId];
        if (el) markClickable(el, toolCallId);
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
        };
      });
    }
    return slim;
  }

  function isEmptyRawInput(rawInput) {
    if (rawInput == null) return true;
    if (typeof rawInput === 'string') return !rawInput.trim();
    if (typeof rawInput !== 'object') return false;
    try {
      var keys = Object.keys(rawInput);
      if (keys.length === 0) return true;
      // Cursor placeholder task tool_call: { _toolName: "task" } only.
      if (keys.length === 1 && keys[0] === '_toolName') return true;
      return false;
    } catch (e) { return true; }
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
  function formatToolCallTooltipText(title, rawInput, locations) {
    var parts = [];
    var formatted = formatRawInput(rawInput);
    if (formatted) parts.push(formatted);
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

   el.addEventListener('pointerenter', function(e) {
     // Only show tooltips on expanded tool rows — never on the collapsed summary.
     var parentList = el.closest('.turn-tools-list');
     if (parentList && parentList.classList.contains('collapsed')) return;
     var foldBody = el.closest('.turn-fold-body');
     if (foldBody && foldBody.classList.contains('collapsed')) return;

     var titleEl = el.querySelector('.tc-title');
     var title = (titleEl && titleEl.textContent) || el._toolTitle || '';
     var formatted = formatToolCallTooltipText(title, el._rawInput, el._locations);
     if (!formatted) return;

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

    el.addEventListener('pointermove', function(e) {
      if (tcTooltipEl && tcTooltipEl.style.display !== 'none') {
        positionTcTooltip(e);
      }
    });

    el.addEventListener('pointerleave', function() {
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
     var desc = rawInput && (
       rawInput.description || rawInput.task || rawInput.prompt ||
       rawInput.subagent_type || rawInput.name || rawInput.agent_name
     );
     if (typeof desc === 'string' && desc.trim()) {
       var s = desc.trim();
       return s.length > 60 ? s.substring(0, 57) + '...' : s;
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
     var parentEl = toolCalls[parentToolUseId] || document.getElementById('tc-' + parentToolUseId);
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
     stage.innerHTML =
       '<span class="tc-stage-icon running">' + getStatusIcon('running') + '</span>' +
       '<span class="tc-stage-name">' + escapeHtml(stageName) + '</span>' +
       (shortDesc ? '<div class="tc-stage-desc">' + escapeHtml(shortDesc) + '</div>' : '');
     var stageData = Object.assign({
       name: stageName,
       role: (stageMeta && stageMeta.role) || 'agent',
       prompt_template: stagePrompt || '',
     }, stageMeta && typeof stageMeta === 'object' ? stageMeta : {});
     if (!stageData.prompt_template) stageData.prompt_template = stagePrompt || '';
     stageData.name = stageName;
     attachStageTooltip(stage, stageData);
     return stage;
   }

   function syncCrewParentRawInput(crewEl) {
     if (!crewEl) return;
     var stages = crewEl.querySelectorAll(':scope > .tc-stages > .tc-stage');
     var rebuilt = [];
     for (var s = 0; s < stages.length; s++) {
       var data = stages[s]._stageData || {};
       rebuilt.push({
         name: data.name || stages[s].getAttribute('data-stage-name') || ('Subagent ' + (s + 1)),
         role: data.role || 'agent',
         mode: data.mode,
         depends_on: data.depends_on,
         prompt_template: data.prompt_template || data.prompt || '',
         prompt: data.prompt || '',
         description: data.description || '',
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
     var iconStatus = (status === 'completed' || status === 'failed' || status === 'error')
       ? (status === 'completed' ? 'completed' : 'error')
       : 'running';
     var iconEl = stage.querySelector('.tc-stage-icon');
     if (iconEl) {
       iconEl.className = 'tc-stage-icon ' + iconStatus;
       iconEl.textContent = getStatusIcon(iconStatus === 'running' ? 'running' : iconStatus);
     }
     var crew = stage.closest('.tool-call-inline.tc-subagent');
     if (!crew || iconStatus === 'running') return;
     var running = crew.querySelectorAll('.tc-stage-icon.running, .tc-stage-icon.in_progress, .tc-stage-icon.pending');
     if (running.length === 0) {
       var parentIcon = crew.querySelector(':scope > .tc-icon');
       if (parentIcon) {
         parentIcon.className = 'tc-icon completed';
         parentIcon.textContent = getStatusIcon('completed');
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
     var stagePrompt = crewStageFullPrompt(rawInput);
     var stageMeta = (rawInput && typeof rawInput === 'object') ? {
       description: rawInput.description || '',
       role: rawInput.subagent_type || rawInput.role || 'agent',
       mode: rawInput.mode,
       depends_on: rawInput.depends_on,
       prompt: typeof rawInput.prompt === 'string' ? rawInput.prompt : '',
     } : { role: 'agent' };
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
       stagesWrap.appendChild(createStageElement(stageName, toolCallId, String(stagePrompt || ''), stageMeta));
       toolCalls[toolCallId] = existing;
       // New stage is running — ensure parent spinner is not left checked.
       var parentIcon = existing.querySelector(':scope > .tc-icon');
       if (parentIcon) {
         parentIcon.className = 'tc-icon running';
         parentIcon.textContent = getStatusIcon('running');
       }
       refreshSubagentCrewTitle(existing);
       autoScrollIfAtBottom();
       return;
     }

     var stageName = crewStageLabel(rawInput, title, 1);
     var synthRaw = Object.assign({}, (rawInput && typeof rawInput === 'object') ? rawInput : {}, {
       stages: [{
         name: stageName,
         role: stageMeta.role || 'agent',
         prompt_template: String(stagePrompt || ''),
         prompt: stageMeta.prompt || '',
         description: stageMeta.description || '',
       }],
     });
     var spawnTitle = isSubagentSpawnTitle(title) ? title : 'Task';
     // Spawn ack often arrives as completed; stages stay spinning until promptEnd.
     var parentStatus = (status === 'failed' || status === 'error') ? status : 'running';
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
     el.id = 'tc-' + toolCallId;
     el.setAttribute('data-subagent-crew', '1');
     el.setAttribute('data-claude-crew', '1');
     if (toolKind) el.dataset.toolKind = toolKind;
     el._rawInput = synthRaw;
     el._locations = locations || null;
     el._toolTitle = spawnTitle;
     el.innerHTML =
       '<span class="tc-icon ' + parentStatus + '">' + getStatusIcon(parentStatus) + '</span>' +
       '<span class="tc-title">spawned 1 subagent</span>' +
       '<div class="tc-stages"></div>';
     var stagesEl = el.querySelector('.tc-stages');
     stagesEl.appendChild(createStageElement(stageName, toolCallId, String(stagePrompt || ''), stageMeta));
     attachToolCallTooltip(el);
     if (currentToolsListEl) currentToolsListEl.appendChild(el);
     toolCalls[toolCallId] = el;
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
     if (isSubagentSpawnTitle(title) && !hasKiroStages) {
       addOrExtendSubagentCrew(toolCallId, title, status, rawInput, toolKind, locations);
       return;
     }
     // Restored synthetic crew (single stage) — append to existing crew card.
     // Native Kiro multi-stage crews take the normal stages-render path below.
     if (isSubagentSpawnTitle(title) && hasKiroStages && rawInput.stages.length === 1) {
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
       if (isSubagentToolCall(title, toolKind)) {
         currentToolsCountEl._hasSubagent = true;
         currentToolsCountEl._hasSpawnAgent = true;
       }
       if (currentToolsCountEl.classList.contains('turn-tools-summary')) {
         updateToolGroupSummary(currentToolsCountEl, currentToolCount, currentToolsCountEl._titles, currentToolsCountEl._kinds, currentToolsCountEl._rawInputs || []);
       }
     }

     const el = document.createElement('div');
     el.className = 'tool-call-inline';
     if (isSubagentToolCall(title, toolKind)) {
       el.className += ' tc-subagent';
     }
     el.id = 'tc-' + toolCallId;
     if (toolKind) el.dataset.toolKind = toolKind;
     el._rawInput = rawInput || null;
     el._locations = locations || null;
     el._toolTitle = title || 'Tool Call';
      var displayTitle = title || 'Tool Call';
      if (isSubagentToolCall(title, toolKind)) {
        var spawnN = getSubagentSpawnCount(title, rawInput);
        if (isSubagentSpawnTitle(title) && spawnN > 0) {
          var taskDesc = (rawInput && (rawInput.task || rawInput.prompt || rawInput.description)) || '';
          // Prefer Kiro-style "spawned N subagents" when stages define the crew.
          if (hasKiroStages) {
            displayTitle = 'spawned ' + spawnN + ' subagent' + (spawnN > 1 ? 's' : '');
          } else if (typeof taskDesc === 'string' && taskDesc.length > 0) {
            displayTitle = taskDesc.length > 80 ? taskDesc.substring(0, 77) + '...' : taskDesc;
          } else {
            displayTitle = 'spawned ' + spawnN + ' subagent' + (spawnN > 1 ? 's' : '');
          }
        }
      } else {
        var detailHint = formatRawInput(rawInput) || formatLocations(locations);
        if (detailHint) {
          var firstLine = detailHint.split('\\n')[0];
          if (firstLine && firstLine !== displayTitle) {
            displayTitle = firstLine.length > 80 ? firstLine.substring(0, 77) + '...' : firstLine;
          }
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
         var stageToolIdAttr = (isSubagentSpawnTitle(title) && si === 0)
           ? ' data-tool-call-id="' + escapeHtml(String(toolCallId)) + '"'
           : '';
         stagesHtml += '<div class="tc-stage" data-stage-name="' + escapeHtml(stageName) + '"' + stageToolIdAttr + '><span class="tc-stage-icon running">' + getStatusIcon('running') + '</span><span class="tc-stage-name">' + escapeHtml(stageName) + '</span>' +
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
          attachStageTooltip(stageDivs[sti], rawInput.stages[sti]);
        }
      }
      if (isSubagentSpawnTitle(title)) {
        el.classList.add('tc-subagent');
        el.setAttribute('data-subagent-crew', '1');
        el.setAttribute('data-claude-crew', '1');
        subagentCrewPrimaryId = toolCallId;
      }
    }
     attachToolCallTooltip(el);
     if (currentToolsListEl) {
       currentToolsListEl.appendChild(el);
     }
     toolCalls[toolCallId] = el;
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
      el.id = 'tc-' + toolCallId;
      el._rawInput = rawInput || null;
      el._toolTitle = title || 'Tool Call';
      el.innerHTML = '<span class="title">' + escapeHtml(title || 'Tool Call') + '</span>'
        + '<span class="status-badge ' + status + '">' + status + '</span>';
      attachToolCallTooltip(el);
     messagesEl.appendChild(el);
     toolCalls[toolCallId] = el;
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
  currentTurnEl = null;
  currentToolsListEl = null;
  currentToolsCountEl = null;
  currentToolCount = 0;
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
      addThoughtDOM(t.text, t.durationSec || 0);
    });
    trace('flushTurnThought: rendered ' + pending.length + ' separate thought block(s)');
  }
  for (var i = 0; i < chatHistory.length; i++) {
    var item = chatHistory[i];
   if (!item) continue;
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
         trace('  -> user/error/system: reset turn, append directly to messages');
         // Safety net: clean user messages again in case raw context
         // links were stored in chatHistory before the fix.
         var displayText = item.role === 'user' ? cleanUserMessage(item.text) : item.text;
         // Debug: log cleaned displayText
         vscode.postMessage({ type: 'debugLog', message: 'renderChatHistory displayText for item[' + i + ']: len=' + displayText.length + ' text="' + (displayText.length > 100 ? displayText.substring(0, 100) + '...' : displayText) + '"' });
         var _sysEl = addMessageDOM(item.role, displayText);
         if (item.role === 'system' && _sysEl &&
             String(item.text || '').trim() === 'Conversation compacted.') {
           _sysEl.classList.add('compact-notice');
         }
        } else {
           // Assistant message. Same turn when tools already ran (mid-turn
           // interim text + final summary). New turn only for back-to-back
           // assistants with no tools between them.
           var turnHasAssistant = currentTurnEl && currentTurnEl.querySelector('.message.assistant');
           var turnHasTools = currentTurnEl && currentTurnEl.querySelector('.tool-call-inline');
           if (turnHasAssistant && !turnHasTools) {
             flushTurnThought();
             trace('  -> assistant: prior assistant without tools -> start NEW turn');
             currentTurnEl = null;
             currentToolsListEl = null;
             currentToolsCountEl = null;
             currentToolCount = 0;
           } else if (turnHasAssistant && turnHasTools) {
             // Prior assistant segments in this turn become interim (folded).
             Array.prototype.forEach.call(
               currentTurnEl.querySelectorAll('.message.assistant'),
               function(a) {
                 a.classList.add('assistant-interim');
                 a.classList.remove('assistant-summary');
               }
             );
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
            addThoughtDOM(item.text, item.durationSec || 0);
            trace('  -> thought: rendered block (textLen=' + item.text.length + ',dur=' + (item.durationSec || 0) + 's)');
          }
          break;
       case 'toolCall':
         addToolCallInline(item.toolCallId, item.title, item.status,
           item.rawInput && item.rawInput.taskResult
             ? stripTaskResult(item.rawInput)
             : item.rawInput,
           item.toolKind,
           item.locations,
           item.parentToolUseId || null);
         break;
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
          if (isSubagentToolCall(tcTitle, tcKind)) hasSubagent = true;
        });
      });
      summary._titles = titles;
      summary._kinds = kinds;
      summary._rawInputs = rawInputs;
      summary._hasSubagent = hasSubagent;
      summary.dataset.count = String(titles.length);
    }
    if (compactMode) {
      ensureTurnFoldStructure(turn, true);
      promoteFinalAssistantForTurn(turn);
    } else if (lists.length && summary) {
      updateToolGroupSummary(summary, parseInt(summary.dataset.count || '0', 10), summary._titles || [], summary._kinds || [], summary._rawInputs || []);
    }
  });
  // promoteFinalAssistant / structure rebuild can leave folds open after
  // session/load — force Collapse mode shut once the DOM is final.
  forceCollapseTurnFolds();
   return assistantItems;
 }

   function updateToolCall(toolCallId, status, title, content, rawInput) {
     for (let i = chatHistory.length - 1; i >= 0; i--) {
       if (chatHistory[i].kind === 'toolCall' && chatHistory[i].toolCallId === toolCallId) {
         chatHistory[i].status = status;
         if (title) chatHistory[i].title = title;
         if (rawInput) chatHistory[i].rawInput = rawInput;
         break;
       }
     }
     saveState();
     storeDiffContent(toolCallId, content);

     // Crew stage: update spinner + fill tooltip from late rawInput (Claude/Codex
     // often send empty rawInput first, then prompt/description on update).
     var stageForId = document.querySelector('.tc-stage[data-tool-call-id="' + String(toolCallId).replace(/"/g, '') + '"]');
     if (stageForId) {
       if (rawInput) updateStageFromRawInput(stageForId, rawInput, title);
       // Claude Agent Task / Codex spawn often flip tool_call to "completed"
       // when the subagent is only *started* (nested child tools still run).
       // Keep the stage spinning until promptEnd (or a real failure).
       var stageStatus = status || 'running';
       if (stageStatus === 'completed' && isProcessing && !isLoadingSession) {
         stageStatus = 'running';
       }
       setSubagentStageStatus(toolCallId, stageStatus);
       return;
     }

     const el = toolCalls[toolCallId] || document.getElementById('tc-' + toolCallId);
     if (!el) return;

     // Attach tooltip if rawInput arrived in an update (not present on
     // the initial tool_call event).
     if (rawInput) {
       if (el.getAttribute('data-subagent-crew') || el.getAttribute('data-claude-crew') ||
           el.querySelector(':scope > .tc-stages')) {
         // Parent crew card: merge late rawInput into the matching stage.
         var stageOnCrew = el.querySelector('.tc-stage[data-tool-call-id="' + String(toolCallId).replace(/"/g, '') + '"]') ||
           el.querySelector(':scope > .tc-stages > .tc-stage');
         if (stageOnCrew) updateStageFromRawInput(stageOnCrew, rawInput, title);
         else {
           el._rawInput = Object.assign({}, el._rawInput || {}, rawInput);
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
        iconEl.className = 'tc-icon ' + status;
        iconEl.textContent = getStatusIcon(status);
        if (title) {
          const titleEl = el.querySelector('.tc-title');
          if (titleEl) {
            // Apply friendly title for subagent spawn calls
            var dt = title;
            var elRawInput = el._rawInput || rawInput;
            if (isSubagentToolCall(title, el.dataset.toolKind || null)) {
              var sn = getSubagentSpawnCount(title, elRawInput);
              if (isSubagentSpawnTitle(title) && sn > 0) {
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
          }
        }
        return;
      }
      // Legacy card style fallback
      const badge = el.querySelector('.status-badge');
      if (badge) {
        badge.className = 'status-badge ' + status;
        badge.textContent = status;
      }
      if (title) {
        const titleEl = el.querySelector('.title');
        if (titleEl) titleEl.textContent = title;
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
    function finalizeCurrentAssistantTurn() {
      if (currentThoughtEl || currentThoughtText || thoughtDomBase) {
        commitOrDiscardCurrentThought();
      }
      if (currentAssistantText) {
        chatHistory.push({ kind: 'message', role: 'assistant', text: currentAssistantText });
        saveState();
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

  function addThoughtDOM(text, durationSec) {
    hideEmpty();
    const el = document.createElement('details');
    el.className = 'thought-block';
     el.innerHTML =
        '<summary>' + (durationSec > 0 ? 'Thought for ' + durationSec + 's' : (durationSec === 0 ? 'Thought for &lt;1s' : 'Thought')) + '</summary>' +
       '<div class="thought-content">' + escapeHtml(text.trim().replace(/\\n{3,}/g, '\\n\\n')) + '</div>';
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
     // If a load overlay is still visible (e.g. stale session was
     // replaced by a new session), dismiss it now as a safety net.
     if (isLoadingSession) {
       isLoadingSession = false;
       if (loadOverlay) loadOverlay.classList.remove('visible');
       if (inputArea) inputArea.classList.remove('disabled');
     }
    hasActiveSession = true;
    hasSentPrompt = false;
sessionState = {
  sessionId: session.sessionId,
  agentName: session.agentName,
  agentConfigKey: session.agentConfigKey,
  cwd: session.cwd,
    title: cleanUserMessage(session.title || '') || undefined,
   promptCapabilities: session.promptCapabilities,
    currentModelImageSupport: session.currentModelImageSupport,
    modelImageMap: session.modelImageMap || {},
  };
  lastConnectedAgent = session.agentConfigKey || session.agentName;
  lastConnectedAgentDisplay = session.agentName;
  lastConnectedSessionId = session.sessionId || null;
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
  }

  function showSessionConnectedFromState(ss) {
 hasActiveSession = true;
 hideEmpty();
 if (resumeBar) resumeBar.style.display = 'none';
  if (bannerAgent) bannerAgent.textContent = cleanUserMessage(ss.title || '') || ss.agentName || 'Agent';
   if (bannerCwd) bannerCwd.textContent = ss.cwd || '';
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
       vscode.postMessage({ type: 'executeCommand', command: 'acp.connectAgent', args: [{ agentName: lastConnectedAgent, sessionId: lastConnectedSessionId }] });
     });
     resumeBar.appendChild(resumeBtn);
   } else {
     resumeBar.style.display = 'none';
   }
 }


   function showNoSession() {
     if (isLoadingSession) return;
     hasActiveSession = false;
     hasSentPrompt = false;
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
   if (!caps || !caps.image) {
     attachBtn.style.display = 'none';
     return;
   }
   // For Kiro CLI, determine image support from model name — no catalog.
   var agentName = sessionState && sessionState.agentName ? sessionState.agentName : '';
   if (agentName && /kiro/i.test(agentName) && currentModelId) {
    var kiroBase = currentModelId.replace(/\\[(?:low|medium|high|xhigh|max|none)\\]$/, '');
     attachBtn.style.display = /claude/i.test(kiroBase) ? '' : 'none';
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
      switch (msg.type) {
       case 'state':
         // Update last-connected agent from extension host (workspaceState
         // persists across restarts, unlike webview getState).
        if (msg.lastAgent) {
          lastConnectedAgent = msg.lastAgent;
          lastConnectedAgentDisplay = msg.lastAgentDisplay || msg.lastAgent;
          lastConnectedSessionId = msg.lastSessionId || null;
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
        } else {
          showNoSession();
        }
        updateWelcomeButton();
         setFollowingUI(!!msg.isFollowing);
         break;

        case 'followStateChanged':
          setFollowingUI(!!msg.isFollowing);
          break;

      case 'promptStart':
        setProcessing(true);
        isForceCancelled = false;
        cancelProvisionalSummaryPromote();
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
        lastRenderTime = 0;
        currentPlanEl = null;
        if (planBar) { planBar.innerHTML = ''; }
        break;

      case 'promptEnd':
      vscode.postMessage({ type: 'debugLog', message: '[WV-PROMPTEND] promptEnd received. chatHistoryLen=' + chatHistory.length + ' currentAssistantTextLen=' + currentAssistantText.length + ' hasCurrentAssistantEl=' + !!currentAssistantEl });
       cancelProvisionalSummaryPromote();
       // Compaction: clear when we already buffered a completion notice.
       // Claude ACP often finishes /compact with only usage_update + end_turn
       // (no "Compacting completed." text) — treat that silent promptEnd as success.
       // Codex/Kiro: keep waiting for contextCompaction / status / notice.
       if (isCompacting) {
         if (compactedWarningText || compactedNoticeText) {
           flushCompactionMessages();
         } else if (isClaudeAgent()) {
           compactedNoticeText = 'Compacting completed.';
           flushCompactionMessages();
         }
       }
          // Finalize thought block if present (DOM+buffers — don't drop on whitespace chunk)
          if (currentThoughtEl || currentThoughtText || thoughtDomBase) {
            commitOrDiscardCurrentThought();
          }
        commitCurrentTextSegment();
        // Mark all in-progress tool calls as completed. Some agents (e.g. Kiro CLI)
        // don't send a tool_call_update with status=completed for subagent crew
        // tool calls — the turn just ends with end_turn. Without this, the spinner
        // stays forever on those tool calls.
        for (var _tcId in toolCalls) {
          var _tcEl = toolCalls[_tcId];
          if (_tcEl) {
            var _iconEl = _tcEl.querySelector(':scope > .tc-icon') || _tcEl.querySelector('.tc-icon');
            if (_iconEl && (_iconEl.className.indexOf('running') >= 0 || _iconEl.className.indexOf('pending') >= 0)) {
              _iconEl.className = 'tc-icon completed';
              _iconEl.textContent = getStatusIcon('completed');
            }
            // Crew stages: Claude/Codex kept these spinning during the turn
            // (tool_call "completed" only meant spawned). Flip them now.
            var _stages = _tcEl.querySelectorAll('.tc-stage-icon.running, .tc-stage-icon.in_progress, .tc-stage-icon.pending');
            for (var _si = 0; _si < _stages.length; _si++) {
              _stages[_si].className = 'tc-stage-icon completed';
              _stages[_si].textContent = getStatusIcon('completed');
            }
          }
        }
        setProcessing(false);
       // Kiro /compact can still be running after execute's promptEnd — keep
       // the Stop/spinner state until we get a true compacted notice.
       if (isCompacting) {
         setProcessing(true);
         if (statusEl && !statusEl.innerHTML) {
           showCompactionProgress('Compacting conversation...', null);
         }
       } else if (isClearing) {
         setProcessing(true);
         if (statusEl && !statusEl.innerHTML) {
           showStatusBanner('clear', 'Clearing conversation...', null);
         }
       }
       // Show interrupted notice in status bar (right upper of input box)
       // when the turn was cancelled. Don't add duplicate system message to chat.
     if (msg.stopReason === 'cancelled') {
       // During session/load replay, don't show the interrupted notice —
       // it's a historical event, not a live cancellation.
       if (!isLoadingSession) {
         isForceCancelled = true; // drop further chunks from the unresponsive agent
       }
      if (!isLoadingSession && statusEl) {
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
          if (_endBody) _endBody._userExpanded = false;
          ensureTurnFoldStructure(currentTurnEl, true);
          _endBody = getTurnFoldBody(currentTurnEl);
          if (_endBody) setFoldExpanded(_endBody, false);
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
        // Auto-send next queued message (if any) after the turn completes.
        // Uses a microtask delay so the UI fully settles before the next
        // turn starts.
        if (pendingSendAfterCancel) {
          // A "Send Now" was requested while processing — send that
          // message immediately after the cancel completes.
          var entry = pendingSendAfterCancel;
          pendingSendAfterCancel = null;
          setTimeout(() => {
            if (!isProcessing) {
              addMessage('user', entry.text || '(image)');
              hasSentPrompt = true;
              vscode.postMessage({ type: 'sendPrompt', text: entry.text || ' ', images: entry.images });
            }
          }, 0);
        } else if (messageQueue.length > 0) {
          setTimeout(() => {
            if (!isProcessing && messageQueue.length > 0) {
              drainQueue();
            }
          }, 0);
        }
        break;

     case 'clearChat':
             isCompacting = false;
             isClearing = false;
             hideCompactionProgress();
             // Cancel any pending render retries — DOM is being wiped.
             for (var _crk in pendingRenderRetries) { delete pendingRenderRetries[_crk]; }
             currentPsEl = null;
              if (psPanel) psPanel.style.display = 'none';
        chatHistory = [];
        sessionState = null;
        hasSentPrompt = false;
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
         setProcessing(false);
         break;

        case 'error':
          // Claude ACP may surface "AbortError: Compaction canceled." as an
          // error after a successful /compact — do not paint it.
          if (isCompacting || Date.now() < suppressPostCompactNoiseUntil) {
            var _errMsg = String(msg.message || '');
            if (/AbortError:\\s*Compaction cancel/i.test(_errMsg) ||
                /Compaction cancel(l)?ed/i.test(_errMsg)) {
              if (isCompacting && (compactedWarningText || compactedNoticeText || isClaudeAgent())) {
                if (!compactedNoticeText) compactedNoticeText = 'Compacting completed.';
                flushCompactionMessages();
              }
              break;
            }
          }
          addMessage('error', msg.message || 'An error occurred');
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
      chatHistory = [];
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
        // Auto-compact: agent often resumes the same turn immediately —
        // drop any leftover banner and restore the plain processing spinner.
        clearCompactNotices();
        restoreProcessingStatusSpinner();
      }
    }

    /** Bare spinner while the turn is still running (no "Compacting…" label). */
    function restoreProcessingStatusSpinner() {
      if (isProcessing && statusEl && !statusEl.innerHTML) {
        statusEl.innerHTML = '<span class="spinner"></span>';
      } else if (!isProcessing && statusEl) {
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
          restoreProcessingStatusSpinner();
        }
        return;
      }
      if (compactedWarningText || compactedNoticeText) {
        flushCompactionMessages();
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
    // After a force-cancel (agent didn't acknowledge session/cancel within
    // the fallback window), drop all further session/update notifications
    // so stale chunks from the unresponsive agent don't pollute the chat.
    if (isForceCancelled && !isLoadingSession) {
      return;
    }
    const type = update.sessionUpdate;

    // [DEBUG-SUBAGENT] Log every update type received by webview
    if (type === 'agent_message_chunk' || type === 'tool_call' || type === 'agent_thought_chunk') {
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
      // Suppress "Effort configuration is currently not available on <model>"
      // messages from Kiro CLI when switching to a model that doesn't support
      // effort. These are slash-command responses, not part of the conversation.
      if (content && content.type === 'text' &&
          content.text.trim().startsWith('Effort configuration is currently not available')) {
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
      if (!isLoadingSession && !isProcessing && !isCompacting) {
        break;
      }
      // Detect auto-compaction: if the agent sends "*Context compacted*" text
      // without a preceding contextCompaction tool_call, treat it as compaction.
      // Also recognize Kiro CLI "Conversation compacted" notices and Claude's
      // "Compacting..." / "Compacting completed." progress text.
      // Skip during session/load — that text is historical, not a live /compact.
       if (!isLoadingSession && content && content.type === 'text') {
         var _autoTrim = content.text.trim();
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
             setProcessing(false);
           }
           break;
         }
         if (!isCompacting && (
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
           setProcessing(true);
         }
         // Claude ACP adapter: "Compacting completed." / "Compacting failed..."
         if (isCompacting && /^Compacting (completed|failed)/i.test(_autoTrim)) {
           if (/failed/i.test(_autoTrim)) {
             isCompacting = false;
             if (kiroCompactWatchdog) { clearTimeout(kiroCompactWatchdog); kiroCompactWatchdog = null; }
             hideCompactionProgress();
             if (statusEl) statusEl.innerHTML = '';
             setProcessing(false);
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
          // Don't buffer Claude's in-progress "Compacting..." as a notice.
          if (/^Compacting\\.\\.\\./i.test(trimmedChunk)) {
            showCompactionProgress(trimmedChunk, null);
            break;
          }
          var isWarning = trimmedChunk.indexOf('Warning:') === 0;
          var isCompactNotice = trimmedChunk.indexOf('*Context compacted') === 0 ||
            /conversation compacted/i.test(trimmedChunk) ||
            /^Compacting completed/i.test(trimmedChunk);
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
          endCompactingOnAgentResume();
          currentAssistantText += content.text;
                    // Flush /ps panel — assistant is producing content
                    if (currentPsEl) { currentPsEl = null; if (psPanel) psPanel.style.display = 'none'; }
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
          var _dbgChunk = content.text.length > 150 ? content.text.substring(0, 150) + '...' : content.text;
          vscode.postMessage({ type: 'debugLog', message: 'UMC chunk: len=' + content.text.length + ' isLoading=' + isLoadingSession + ' text="' + _dbgChunk + '"' });
        }
        if (!isLoadingSession) {
          break;
        }
        if (content && content.type === 'text' && typeof content.text === 'string') {
          // Subagent task-notification blobs are not user turns.
          if (/<task-notification[\\s>]/i.test(content.text)) {
            break;
          }
          // Strip injected context blocks from replayed user messages.
          // Uses the shared cleanUserMessage helper defined above.
         finalizeCurrentAssistantTurn();
         // Coalesce consecutive user chunks into one message.
         const last = chatHistory[chatHistory.length - 1];
         if (last && last.kind === 'message' && last.role === 'user') {
          // Debug: log coalescing
          vscode.postMessage({ type: 'debugLog', message: 'UMC coalesce: existing last.text len=' + last.text.length + ' new chunk len=' + content.text.length });
          // Accumulate raw text, then clean the full concatenation.
          // This avoids stripping leading whitespace from individual
          // chunks (e.g. " in up/epg" -> "in up/epg") which would
          // concatenate words incorrectly across chunk boundaries.
          last.text += content.text;
          var cleaned = cleanUserMessage(last.text);
          // Debug: log cleaned result
          vscode.postMessage({ type: 'debugLog', message: 'UMC coalesce cleaned: len=' + cleaned.length + ' text="' + (cleaned.length > 150 ? cleaned.substring(0, 150) + '...' : cleaned) + '"' });
          if (cleaned === '') break; // still all context links
          // Update chatHistory with cleaned text so renderChatHistory()
          // at loadSessionEnd doesn't re-render raw context links.
          last.text = cleaned;
          const allUser = messagesEl.querySelectorAll('.message.user');
          const el = allUser[allUser.length - 1];
          if (el) { el.textContent = ''; renderUserMessageContent(el, cleaned); }
         } else {
           var cleanedNew = cleanUserMessage(content.text);
           // Debug: log new message cleaned
           vscode.postMessage({ type: 'debugLog', message: 'UMC new-msg cleaned: len=' + cleanedNew.length + ' text="' + (cleanedNew.length > 150 ? cleanedNew.substring(0, 150) + '...' : cleanedNew) + '"' });
           if (cleanedNew === '') break; // chunk was only context links
           addMessage('user', cleanedNew);
          }
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
           currentThoughtText += content.text;
           // Don't mount an empty Thinking… card — it flashes then vanishes when
           // tools arrive before any real text (same idea as assistant bubbles).
           if (!currentThoughtEl && !(thoughtDomBase + currentThoughtText).trim()) {
             if (!thoughtStartTime) thoughtStartTime = Date.now();
             break;
           }
           if (!currentThoughtEl) {
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
              // Only resume a still-streaming thought block. After a thought is
              // finalized (tools arrived), the next thought segment must become
              // a NEW block so older thoughts are not overwritten.
              var streamingThoughts = currentTurnEl.querySelectorAll('.thought-block.streaming');
              var existingThought = streamingThoughts.length
                ? streamingThoughts[streamingThoughts.length - 1]
                : null;
              if (existingThought) {
                currentThoughtEl = existingThought;
                currentThoughtTextEl = existingThought.querySelector('.thought-content');
                thoughtDomBase = (currentThoughtTextEl && currentThoughtTextEl.textContent) || '';
                if (thoughtDomBase && !/\\n$/.test(thoughtDomBase)) thoughtDomBase += '\\n\\n';
                // Keep the just-received chunk in currentThoughtText; don't wipe it.
                thoughtEndTime = null;
                currentThoughtEl.classList.add('streaming');
                currentThoughtEl._thoughtCommitted = false;
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
                // Append in turn order inside the fold (do not replace prior thoughts).
                placeThoughtInTurn(currentThoughtEl);
                if (!thoughtStartTime) thoughtStartTime = Date.now();
                thoughtDomBase = '';
              }
            }
           var displayThought = (thoughtDomBase + currentThoughtText).replace(/^\\s+/, '').replace(/\\n{3,}/g, '\\n\\n');
           if (currentThoughtTextEl) currentThoughtTextEl.textContent = displayThought;
           // Auto-scroll the thought content to top when expanded, so the
           // streaming text stays aligned to the top of the block.
          if (currentThoughtEl && currentThoughtEl.open && currentThoughtTextEl) {
            currentThoughtTextEl.scrollTop = 0;
          }
          autoScrollIfAtBottom();
         }
         break;
        }

    case 'tool_call': {
      // Codex contextCompaction tool cards are suppressed; completion still
      // clears history (some paths emit completed as tool_call, not update).
      if (update._meta && update._meta.contextCompaction) {
        if (isLoadingSession) {
          if (!isCompacting) {
            addMessage('system', 'Earlier conversation was compacted — history before this point is unavailable.');
          }
          break;
        }
        if (!isCompacting) {
          isCompacting = true;
          manualCompacting = false;
          compactedWarningText = '';
          compactedNoticeText = '';
          if (compactionFlushTimer) { clearTimeout(compactionFlushTimer); compactionFlushTimer = null; }
          showCompactionProgress('Compacting conversation...', null);
          setProcessing(true);
        }
        var _tcCcStatus = update.status || '';
        if (_tcCcStatus === 'failed') {
          isCompacting = false;
          manualCompacting = false;
          compactedWarningText = '';
          compactedNoticeText = '';
          if (compactionFlushTimer) { clearTimeout(compactionFlushTimer); compactionFlushTimer = null; }
          hideCompactionProgress();
          if (statusEl) statusEl.innerHTML = '';
          setProcessing(false);
          addMessage('error', 'Compaction failed');
          break;
        }
        if (_tcCcStatus === 'completed') {
          if (!compactedNoticeText) {
            compactedNoticeText = "*Context compacted to fit the model's context window.*";
          }
          scheduleCompactionFlush();
        }
        break;
      }
      // Kiro "Summarizing"/"summary" tool calls carry the subagent's full
      // taskResult (raw markdown) in rawInput. This is redundant — the main
      // agent will deliver its own rendered summary via agent_message_chunk.
      // Suppress these tool calls entirely so the user doesn't see the raw
      // markdown duplicated below the subagent call.
      var _tcTitle = (update.title || '').toLowerCase();
      var _tcToolName = update._meta && update._meta.kiro && update._meta.kiro.toolName
        ? update._meta.kiro.toolName.toLowerCase() : '';
      if (_tcToolName === 'summary' || _tcTitle === 'summarizing' || _tcTitle === 'summary') {
        if (update.rawInput && update.rawInput.taskResult) {
          break; // Suppress — taskResult is redundant with main agent's summary
        }
      }
      // Cursor stub tool_call before cursor/task — drop; rich UI comes from cursor/task.
      if (isCursorTaskPlaceholder(update.title, update.rawInput)) {
        break;
      }
      // Non-compaction tool — agent is working again; clear compact status.
      endCompactingOnAgentResume();
      const tc = update;
      var _parentId = update._meta && update._meta.claudeCode && update._meta.claudeCode.parentToolUseId;
      var _claudeToolName = update._meta && update._meta.claudeCode && update._meta.claudeCode.toolName;
      // Claude Agent tool often arrives as title "Task" + toolName "Agent".
      var _tcTitleForUi = tc.title || 'Tool Call';
      if (_claudeToolName === 'Agent' && (!_tcTitleForUi || _tcTitleForUi === 'Tool Call')) {
        _tcTitleForUi = 'Task';
      }
      addToolCall(
        tc.toolCallId || 'unknown',
        _tcTitleForUi,
         (tc.status === 'in_progress' ? 'running' : tc.status) || 'pending',
        tc.content,
         tc.rawInput && tc.rawInput.taskResult
           ? stripTaskResult(tc.rawInput)
           : tc.rawInput,
        tc.kind,
        tc.locations,
        _parentId || null,
      );
      break;
     }

    case 'tool_call_update': {
      // Codex contextCompaction lifecycle — never push codex-core titles into
      // the status bar. On completed, clear chat history (manual /compact and
      // auto-compact both rely on this; the text notice may arrive after
      // promptEnd or not at all).
      if (update._meta && update._meta.contextCompaction) {
        if (isLoadingSession) {
          break;
        }
        if (!isCompacting) {
          isCompacting = true;
          manualCompacting = false;
          compactedWarningText = '';
          compactedNoticeText = '';
          if (compactionFlushTimer) { clearTimeout(compactionFlushTimer); compactionFlushTimer = null; }
          showCompactionProgress('Compacting conversation...', null);
          setProcessing(true);
        }
        var _ccStatus = update.status || '';
        if (_ccStatus === 'failed') {
          isCompacting = false;
          manualCompacting = false;
          compactedWarningText = '';
          compactedNoticeText = '';
          if (compactionFlushTimer) { clearTimeout(compactionFlushTimer); compactionFlushTimer = null; }
          hideCompactionProgress();
          if (statusEl) statusEl.innerHTML = '';
          setProcessing(false);
          addMessage('error', 'Compaction failed');
          break;
        }
        if (_ccStatus === 'completed') {
          if (!compactedNoticeText) {
            compactedNoticeText = "*Context compacted to fit the model's context window.*";
          }
          scheduleCompactionFlush();
        }
        break;
      }
      // Strip taskResult from tool_call_update rawInput too (Kiro may
      // send an update with the full taskResult markdown).
      var _tcuRawInput = update.rawInput && update.rawInput.taskResult
        ? stripTaskResult(update.rawInput)
        : update.rawInput;
      updateToolCall(
        update.toolCallId || 'unknown',
         (update.status === 'in_progress' ? 'running' : update.status) || 'running',
         update.title,
         update.content,
          _tcuRawInput,
       );
       break;
     }

        case 'plan': {
          addPlan(update);
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
      }
    }

   function updateTokenUsage(update) {
     tokenUsage = { used: update.used, size: update.size, cost: update.cost };
     if (!tokenUsageRing) return;
     updateTokenUsageDOM();
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
       tokenUsage = { used: pct, size: 100, cost: null };
       updateTokenUsageDOM();
       // Update tooltip
       if (tokenUsageTooltip) {
         tokenUsageTooltip.textContent = 'Context: ' + pct.toFixed(1) + '% used';
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
    setProcessing(false);
    saveState();
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
    if (!isClearing) {
      isClearing = true;
      setProcessing(true);
    }
    var looksDone = !!msg && /cleared/i.test(msg) && !/clearing/i.test(msg);
    if (looksDone) {
      finalizeKiroClear(msg);
      return;
    }
    showStatusBanner('clear', msg || 'Clearing conversation...', extractStatusPercent(params));
  }

  /**
   * _kiro.dev/commands/execute for clear returned.
   */
  function handleKiroClearDone(msg) {
    if (msg && msg.error) {
      isClearing = false;
      hideCompactionProgress();
      if (statusEl) statusEl.innerHTML = '';
      setProcessing(false);
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

    if (!isCompacting) {
      isCompacting = true;
      // Status RPC covers auto-compaction too — not a user /compact.
      manualCompacting = false;
      compactedWarningText = '';
      compactedNoticeText = '';
      if (compactionFlushTimer) { clearTimeout(compactionFlushTimer); compactionFlushTimer = null; }
      setProcessing(true);
    }

    if (statusType === 'failed') {
      if (kiroCompactWatchdog) { clearTimeout(kiroCompactWatchdog); kiroCompactWatchdog = null; }
      isCompacting = false;
      manualCompacting = false;
      compactedWarningText = '';
      compactedNoticeText = '';
      if (compactionFlushTimer) { clearTimeout(compactionFlushTimer); compactionFlushTimer = null; }
      hideCompactionProgress();
      if (statusEl) statusEl.innerHTML = '';
      setProcessing(false);
      addMessage('error', msg || summary || 'Compaction failed.');
      return;
    }

    // Completion: status.type === "completed" (primary) or legacy message text.
    var looksDone = statusType === 'completed' ||
      (!!msg && /compacted/i.test(msg) && !/compacting/i.test(msg));
    if (looksDone) {
      // Do not paint Kiro's summary markdown into the panel — client note only.
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
    setProcessing(false);
  }

  /**
   * _kiro.dev/commands/execute returned. An empty/early ack must NOT clear
   * the conversation — wait for compaction/status or agent message.
   */
  function handleKiroCompactDone(msg) {
    if (msg && msg.error) {
      if (kiroCompactWatchdog) { clearTimeout(kiroCompactWatchdog); kiroCompactWatchdog = null; }
      isCompacting = false;
      compactedWarningText = '';
      compactedNoticeText = '';
      if (compactionFlushTimer) { clearTimeout(compactionFlushTimer); compactionFlushTimer = null; }
      hideCompactionProgress();
      if (statusEl) statusEl.innerHTML = '';
      setProcessing(false);
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
    setProcessing(true);
  }

  // Handle _kiro.dev/subagent/list_update notification (Kiro CLI specific).
  // params.subagents is an array of { sessionId, sessionName, status: { type, message } }.
  // We match each subagent to a stage element by sessionName and update its spinner.
  function handleKiroSubagentListUpdate(params) {
    if (!params || !Array.isArray(params.subagents)) return;
    // Find all tc-stage elements in the current turn's tool calls
    var stageEls = document.querySelectorAll('.tc-stage[data-stage-name]');
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
        if (stageEl.getAttribute('data-stage-name') === saName) {
          if (sa.sessionId) {
            stageEl.setAttribute('data-session-id', String(sa.sessionId));
          }
          var iconEl = stageEl.querySelector('.tc-stage-icon');
          if (iconEl) {
            iconEl.className = 'tc-stage-icon ' + iconStatus;
            iconEl.textContent = getStatusIcon(iconStatus === 'running' ? 'running' : iconStatus === 'completed' ? 'completed' : 'error');
          }
        }
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
     if (stageEls[q].getAttribute('data-stage-name') === pName) {
       var pIconEl = stageEls[q].querySelector('.tc-stage-icon');
       if (pIconEl && !pIconEl.classList.contains('completed')) {
         pIconEl.className = 'tc-stage-icon running';
         pIconEl.textContent = getStatusIcon('running');
       }
     }
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
      var crewEls = document.querySelectorAll('.tool-call-inline.tc-subagent .tc-icon.running, .tool-call-inline.tc-subagent .tc-icon.pending');
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
        iconEl.className = 'tc-stage-icon completed';
        iconEl.textContent = getStatusIcon('completed');
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
    if (/\bget\b/.test(d) && /finding/.test(d)) return true;
    if (/^get\s/.test(d)) return true;
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

  /** Cursor cursor/update_todos — only surface outside when Collapse is off. */
  function handleCursorUpdateTodos(params) {
    if (!params || !Array.isArray(params.todos) || !planBar) return;
    // Collapse mode: do not dump todos into the always-visible plan bar
    // (that sits outside the turn fold). Keep a one-line status hint instead.
    if (compactMode) {
      planBar.classList.remove('cursor-todos-outside');
      planBar.innerHTML = '';
      if (statusEl && params.todos.length) {
        statusEl.textContent = params.todos.length + ' todo' + (params.todos.length > 1 ? 's' : '') + ' updated';
      }
      return;
    }
    var todos = params.todos;
    if (!todos.length) {
      if (!params.merge) planBar.innerHTML = '';
      return;
    }
    planBar.classList.add('cursor-todos-outside');
    if (!params.merge) planBar.innerHTML = '';
    var html = '<div class="plan"><div class="plan-title">Todos</div>';
    for (var i = 0; i < todos.length; i++) {
      var t = todos[i];
      var st = (t && t.status) || 'pending';
      var cls = st === 'completed' ? 'plan-entry completed' : 'plan-entry';
      html += '<div class="' + cls + '">' +
        '<span>' + (st === 'completed' ? '✓' : st === 'in_progress' ? '…' : '○') + '</span>' +
        '<span>' + escapeHtml((t && t.content) || '') + '</span></div>';
    }
    html += '</div>';
    if (params.merge && planBar.innerHTML) {
      planBar.innerHTML += html;
    } else {
      planBar.innerHTML = html;
    }
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
      var pct = Math.round(ratio * 100);
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

    // --- Token usage ring hover tooltip (like Zed) ---
    if (tokenUsageRing && tokenUsageTooltip) {
      tokenUsageRing.addEventListener('mouseenter', function () {
        if (!tokenUsage) return;
        var used = tokenUsage.used;
        var size = tokenUsage.size;
        var ratio = size > 0 ? used / size : 0;
        var pct = Math.round(ratio * 100);
        var html = '<div class="tooltip-header">Context</div>';
        if (size > 0) {
          html += pct + '% \u2022 ' + humanizeTokens(used) + ' / ' + humanizeTokens(size);
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

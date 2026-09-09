/**
 * Helpers for building ACP `ContentBlock`s from VS Code context (open files,
 * `@file:`/`@folder:` mentions, terminal output, workspace diagnostics).
 *
 * Mirrors how Zed's ACP client serialises mentions (see
 * `zed-industries/zed::crates/acp_thread/src/mention.rs::MentionUri::to_uri`
 * and `crates/agent_ui/src/message_editor.rs::mention_to_content_block`):
 *
 *  - File mention   → `file:///abs/path`                       (no fragment)
 *  - Directory      → `file:///abs/path/`                      (trailing `/`)
 *  - Terminal sel.  → `zed:///agent/terminal-selection?lines=N`
 *  - Diagnostics    → `zed:///agent/diagnostics`
 *
 * Each builder returns the strongest block the agent can consume:
 *  - When the agent advertises `promptCapabilities.embeddedContext`, file /
 *    folder / terminal / diagnostics that carry payload text become
 *    `EmbeddedResource` (`type: "resource"`) blocks so the text is delivered
 *    inline alongside a stable URI.
 *  - Otherwise we emit a `ResourceLink` (`type: "resource_link"`) when the
 *    URI is one the agent can actually dereference (i.e. plain `file://`
 *    paths).  For `zed:///agent/...` URIs without embedded support, the
 *    caller must fall back to inline text in the prompt — there is no
 *    spec-compliant way for the agent to retrieve that content otherwise.
 */
import * as vscode from 'vscode';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import { TerminalOutputStore } from './TerminalOutputStore';

/**
 * A piece of editor-selection context to attach to the next prompt.
 *
 * Mirrors how Zed's ACP client serialises editor selections (see
 * `crates/agent_ui/src/mention_set.rs::confirm_mention_for_selection` and
 * `crates/agent_ui/src/message_editor.rs::mention_to_content_block` in
 * `zed-industries/zed`). The agent receives either an `EmbeddedResource`
 * (when it advertises `promptCapabilities.embeddedContext`) or a
 * `ResourceLink` otherwise, with a URI of the form
 * `file:///abs/path#L<start>:<end>` (1-based, inclusive).
 */
export interface SelectionContext {
  /** Absolute file path, or `null` for an untitled/unsaved buffer. */
  absPath: string | null;
  /** Optional pre-computed URI for the buffer (e.g. `untitled:Untitled-1`). */
  uri?: string;
  /** 1-based start line of the selection (inclusive). */
  startLine: number;
  /** 1-based end line of the selection (inclusive). */
  endLine: number;
  /** Selected text. */
  text: string;
  /** Optional MIME type, e.g. `text/x-typescript` or `text/plain`. */
  mimeType?: string;
  /** Optional VS Code `languageId` for diagnostics/logging. */
  languageId?: string;
}

/** Convert an absolute path to its canonical `file:///…` URI. */
export function fileUri(absPath: string): string {
  return vscode.Uri.file(absPath).toString();
}

/** Convert an absolute directory path to its canonical `file:///…/` URI. */
export function directoryUri(absPath: string): string {
  const uri = vscode.Uri.file(absPath).toString();
  return uri.endsWith('/') ? uri : `${uri}/`;
}

/**
 * Build a `resource` / `resource_link` block for an editor selection. The
 * URI is `<buffer-uri>#L<startLine>:<endLine>` (1-based, inclusive) and the
 * shape matches Zed's `MentionUri::Selection::to_uri()`.
 */
export function buildSelectionBlock(sel: SelectionContext, supportsEmbedded: boolean): ContentBlock {
  const baseUri = sel.uri ?? (sel.absPath ? vscode.Uri.file(sel.absPath).toString() : 'untitled:Untitled');
  const uri = `${baseUri}#L${sel.startLine}:${sel.endLine}`;
  if (supportsEmbedded) {
    return {
      type: 'resource',
      resource: {
        uri,
        text: sel.text,
        ...(sel.mimeType ? { mimeType: sel.mimeType } : {}),
      },
    } as ContentBlock;
  }
  const baseName = sel.absPath ? sel.absPath.split(/[\\/]/).pop() || 'Selection' : 'Untitled';
  const name = `${baseName} (${sel.startLine}:${sel.endLine})`;
  return {
    type: 'resource_link',
    name,
    uri,
    ...(sel.mimeType ? { mimeType: sel.mimeType } : {}),
  } as ContentBlock;
}

/**
 * Build a block referencing a whole file.
 *
 * - With `content`: emits `resource` (embedded) when supported, otherwise
 *   `resource_link` (the agent can read the file from disk via the URI).
 * - Without `content`: always emits `resource_link`.
 */
export function buildFileBlock(
  absPath: string,
  supportsEmbedded: boolean,
  content?: string,
  mimeType?: string,
): ContentBlock {
  const uri = fileUri(absPath);
  const name = absPath.split(/[\\/]/).pop() || absPath;
  if (content !== undefined && supportsEmbedded) {
    return {
      type: 'resource',
      resource: {
        uri,
        text: content,
        ...(mimeType ? { mimeType } : {}),
      },
    } as ContentBlock;
  }
  return {
    type: 'resource_link',
    name,
    uri,
    ...(mimeType ? { mimeType } : {}),
  } as ContentBlock;
}

/**
 * Build a `resource_link` block referencing a directory. Zed uses a trailing
 * slash to disambiguate from a file. Directories never carry inline text —
 * the agent dereferences the URI to list entries itself.
 */
export function buildDirectoryBlock(absPath: string): ContentBlock {
  const uri = directoryUri(absPath);
  const name = (absPath.split(/[\\/]/).filter(Boolean).pop() || absPath) + '/';
  return {
    type: 'resource_link',
    name,
    uri,
  } as ContentBlock;
}

/**
 * Build a block carrying terminal output.
 *
 * Returns `null` when the agent does not support `embeddedContext`: a
 * `resource_link` to `zed:///agent/terminal-selection` is useless because the
 * agent cannot dereference it. The caller is expected to keep the legacy
 * `<terminal>` inline-text fallback in that case.
 *
 * Large output: when `store` is provided and the output exceeds the inline
 * threshold, the full output is persisted to a file and the block's `text`
 * carries a truncated head+tail preview plus a pointer to the file (a plain
 * `file://` URI the agent can `read_file`). This keeps oversized terminal logs
 * (build output, `git log`, …) from blowing out the model's context window
 * and slowing prefill on thinking models. When `store` is omitted, the full
 * output is inlined verbatim (legacy behaviour).
 */
export function buildTerminalBlock(
  output: string,
  supportsEmbedded: boolean,
  store?: TerminalOutputStore,
  lineCount?: number,
): ContentBlock | null {
  if (!supportsEmbedded) {
    return null;
  }
  const text = store ? store.persist(output).text : output;
  const lines = lineCount ?? output.split('\n').length;
  const uri = `zed:///agent/terminal-selection?lines=${lines}`;
  return {
    type: 'resource',
    resource: {
      uri,
      text,
      mimeType: 'text/plain',
    },
  } as ContentBlock;
}

/**
 * Build a block carrying workspace diagnostics. Same fallback rule as
 * {@link buildTerminalBlock}: returns `null` without `embeddedContext`.
 */
export function buildDiagnosticsBlock(text: string, supportsEmbedded: boolean): ContentBlock | null {
  if (!supportsEmbedded) {
    return null;
  }
  const uri = `zed:///agent/diagnostics`;
  return {
    type: 'resource',
    resource: {
      uri,
      text,
      mimeType: 'text/plain',
    },
  } as ContentBlock;
}

/**
 * Build a block carrying clipboard text.
 *
 * The clipboard is the only route to content VS Code will not otherwise expose: a
 * selection inside a Markdown PREVIEW lives in another extension's webview, and no
 * API can read a DOM selection there. Ctrl+C in the preview works, and
 * env.clipboard is readable, so "copy, then ask with @clipboard" carries rendered
 * content the selection path cannot.
 *
 * - With `embeddedContext`: `resource` at `zed:///agent/clipboard`.
 * - Without: returns `null` so the caller prepends the text inline (the URI is not
 *   dereferenceable by the agent).
 */
export function buildClipboardBlock(text: string, supportsEmbedded: boolean): ContentBlock | null {
  if (!supportsEmbedded) {
    return null;
  }
  return {
    type: 'resource',
    resource: {
      uri: 'zed:///agent/clipboard',
      text,
      mimeType: 'text/plain',
    },
  } as ContentBlock;
}

/**
 * Build a block carrying TencentDB Agent Memory recall text.
 *
 * - With `embeddedContext`: `resource` at `vscode-acp:///memory/<agentId>`.
 * - Without: returns `null` so the caller can prepend the text inline
 *   (the URI is not dereferenceable by the agent).
 */
export function buildMemoryBlock(text: string, supportsEmbedded: boolean, memoryAgentId: string): ContentBlock | null {
  if (!text.trim()) {
    return null;
  }
  if (!supportsEmbedded) {
    return null;
  }
  const id = encodeURIComponent(memoryAgentId || 'agent');
  return {
    type: 'resource',
    resource: {
      uri: `vscode-acp:///memory/${id}`,
      text,
      mimeType: 'text/plain',
    },
  } as ContentBlock;
}

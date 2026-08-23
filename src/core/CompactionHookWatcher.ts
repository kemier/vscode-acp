import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { SessionInfo } from './SessionManager';
import { isCursorAgentName } from './CursorToolEnricher';

export interface CompactionHookEvent {
  ts?: string;
  hook?: string;
  conversation_id?: string | null;
  generation_id?: string | null;
  trigger?: string | null;
  context_usage_percent?: number | null;
  messages_to_compact?: number | null;
  workspace_roots?: string[] | null;
}

export function compactionEventsLogPath(): string {
  return path.join(os.homedir(), '.cursor', 'acp-debug', 'compaction-events.jsonl');
}

/** Normalize paths for cross-platform cwd / workspace_roots matching. */
export function normalizePathForMatch(p: string): string {
  return path.normalize(p).replace(/\\/g, '/').toLowerCase();
}

/**
 * Map a preCompact hook log line to an open ACP session id.
 * conversation_id is usually the same as the ACP session id for Cursor.
 */
export function resolveCompactionHookSession(
  event: CompactionHookEvent,
  sessions: SessionInfo[],
  activeSessionId: string | null,
): string | null {
  const conversationId = event.conversation_id?.trim();
  if (conversationId) {
    const direct = sessions.find((s) => s.sessionId === conversationId);
    if (direct && isCursorAgentName(direct.agentName)) {
      return direct.sessionId;
    }
  }

  const roots = (event.workspace_roots ?? [])
    .filter((r): r is string => typeof r === 'string' && r.length > 0)
    .map(normalizePathForMatch);
  if (roots.length > 0) {
    const cwdMatches = sessions.filter(
      (s) => isCursorAgentName(s.agentName) && roots.includes(normalizePathForMatch(s.cwd)),
    );
    if (cwdMatches.length === 1) {
      return cwdMatches[0].sessionId;
    }
    if (activeSessionId) {
      const active = sessions.find((s) => s.sessionId === activeSessionId);
      if (active && isCursorAgentName(active.agentName) && roots.includes(normalizePathForMatch(active.cwd))) {
        return active.sessionId;
      }
    }
  }

  if (activeSessionId) {
    const active = sessions.find((s) => s.sessionId === activeSessionId);
    if (active && isCursorAgentName(active.agentName)) {
      return active.sessionId;
    }
  }

  const cursorSessions = sessions.filter((s) => isCursorAgentName(s.agentName));
  if (cursorSessions.length === 1) {
    return cursorSessions[0].sessionId;
  }

  return null;
}

export function compactionEventDedupKey(event: CompactionHookEvent): string {
  return [
    event.conversation_id ?? '',
    event.generation_id ?? '',
    event.ts ?? '',
    String(event.messages_to_compact ?? ''),
  ].join('\0');
}

export type CompactionHookHandler = (sessionId: string, event: CompactionHookEvent) => void;
export type CompactionHookUnmatchedHandler = (event: CompactionHookEvent) => void;

/**
 * Tails ~/.cursor/acp-debug/compaction-events.jsonl (written by preCompact hook)
 * and invokes onCompaction when a new event maps to an open Cursor session.
 */
export class CompactionHookWatcher {
  private offset = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly seen = new Set<string>();
  private partialLine = '';

  constructor(
    private readonly getSessions: () => SessionInfo[],
    private readonly getActiveSessionId: () => string | null,
    private readonly onCompaction: CompactionHookHandler,
    private readonly onUnmatched?: CompactionHookUnmatchedHandler,
    private readonly pollMs = 1500,
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }
    this.syncOffsetToFileEnd();
    this.timer = setInterval(() => this.poll(), this.pollMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private syncOffsetToFileEnd(): void {
    const file = compactionEventsLogPath();
    try {
      if (fs.existsSync(file)) {
        this.offset = fs.statSync(file).size;
      }
    } catch {
      this.offset = 0;
    }
  }

  private poll(): void {
    const file = compactionEventsLogPath();
    let buf: Buffer;
    try {
      if (!fs.existsSync(file)) {
        return;
      }
      const stat = fs.statSync(file);
      if (stat.size < this.offset) {
        this.offset = 0;
        this.partialLine = '';
      }
      if (stat.size === this.offset) {
        return;
      }
      const len = stat.size - this.offset;
      const fd = fs.openSync(file, 'r');
      try {
        buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, this.offset);
      } finally {
        fs.closeSync(fd);
      }
      this.offset = stat.size;
    } catch {
      return;
    }

    const text = this.partialLine + buf.toString('utf8');
    const lines = text.split('\n');
    this.partialLine = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let event: CompactionHookEvent;
      try {
        event = JSON.parse(trimmed) as CompactionHookEvent;
      } catch {
        continue;
      }
      if (event.hook && event.hook !== 'preCompact') {
        continue;
      }
      const key = compactionEventDedupKey(event);
      if (this.seen.has(key)) {
        continue;
      }
      this.seen.add(key);
      if (this.seen.size > 500) {
        this.seen.clear();
        this.seen.add(key);
      }

      const sessionId = resolveCompactionHookSession(
        event,
        this.getSessions(),
        this.getActiveSessionId(),
      );
      if (!sessionId) {
        this.onUnmatched?.(event);
        continue;
      }
      this.onCompaction(sessionId, event);
    }
  }
}

#!/usr/bin/env node
/**
 * Cursor preCompact hook — logs compaction events for vscode-acp.
 *
 * Install: scripts/install-precompact-hook.ps1 (Windows) or .sh (Mac/Linux)
 * Log:     ~/.cursor/acp-debug/compaction-events.jsonl
 *
 * Observational only (Cursor cannot block compaction). Optional stdout:
 *   { "user_message": "..." }  — set ACP_PRECOMPACT_NOTIFY=1 to show a toast.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { _parseError: true, _raw: raw.slice(0, 500) };
  }
}

function logPath() {
  return path.join(os.homedir(), '.cursor', 'acp-debug', 'compaction-events.jsonl');
}

function main() {
  readStdin()
    .then((input) => {
      const dir = path.dirname(logPath());
      fs.mkdirSync(dir, { recursive: true });
      const record = {
        ts: new Date().toISOString(),
        hook: 'preCompact',
        conversation_id: input.conversation_id ?? input.conversationId ?? null,
        generation_id: input.generation_id ?? input.generationId ?? null,
        hook_event_name: input.hook_event_name ?? 'preCompact',
        trigger: input.trigger ?? null,
        context_usage_percent: input.context_usage_percent ?? null,
        context_tokens: input.context_tokens ?? null,
        context_window_size: input.context_window_size ?? null,
        message_count: input.message_count ?? null,
        messages_to_compact: input.messages_to_compact ?? input.messagesToCompact ?? null,
        is_first_compaction: input.is_first_compaction ?? input.isFirstCompaction ?? null,
        model: input.model ?? null,
        workspace_roots: input.workspace_roots ?? null,
        transcript_path: input.transcript_path ?? null,
      };
      fs.appendFileSync(logPath(), `${JSON.stringify(record)}\n`, 'utf8');

      if (process.env.ACP_PRECOMPACT_NOTIFY === '1') {
        const pct = record.context_usage_percent;
        const msg =
          typeof pct === 'number'
            ? `Context compacting (${pct}% full) — memory will re-inject on next prompt.`
            : 'Context compacting — memory will re-inject on next prompt.';
        process.stdout.write(`${JSON.stringify({ user_message: msg })}\n`);
      }
    })
    .catch((err) => {
      try {
        const dir = path.dirname(logPath());
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(
          logPath(),
          `${JSON.stringify({ ts: new Date().toISOString(), hook: 'preCompact', error: String(err) })}\n`,
          'utf8',
        );
      } catch {
        // fail open
      }
    });
}

main();

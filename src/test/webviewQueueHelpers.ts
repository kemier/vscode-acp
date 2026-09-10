import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { decodeTemplate } from './templateDecode';

/**
 * The REAL clipboard/queue-entry helpers from the webview template literal, as
 * source text, for harnesses that eval a fragment of the webview script.
 *
 * Every queue send path calls queueEntryPromptText (it expands a clipboard
 * snapshot that display paths keep as a pill), so a harness that evals
 * sendQueuedMessageNow / drainQueue must have them in scope. Injecting the real
 * source rather than a stub keeps those harnesses honest: if the expansion
 * changes shape, the harness sees the change instead of a fake.
 */
const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

export function webviewSlice(from: string, to: string): string {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const start = src.indexOf(from);
  assert.ok(start >= 0, `not found in webview source: ${from}`);
  const end = src.indexOf(to, start);
  assert.ok(end > start, `end marker not found after ${from}: ${to}`);
  return decodeTemplate(src.slice(start, end));
}

export const QUEUE_ENTRY_HELPERS_SRC: string =
  webviewSlice('function clipboardPillLabel(clip) {', '/**\n     * The text a queued entry SENDS') +
  '\n' +
  webviewSlice('function queueEntryPromptText(entry) {', 'function renderQueue() {');

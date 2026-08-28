import * as assert from 'assert';

/**
 * Regression test: duplicate permission prompts for parallel tool calls on the
 * same file.
 *
 * kiro-cli sends one `session/request_permission` per tool call. When the model
 * emits two edits to the same file in one parallel batch, both requests arrive
 * milliseconds apart:
 *
 *   03:06:16.336  session/request_permission  toolCallId=…01Svez…  "Editing ChatWebviewProvider.ts"
 *   03:06:16.338  session/request_permission  toolCallId=…01TLq8…  "Editing ChatWebviewProvider.ts"
 *
 * Both are queued while `isToolApproved()` is still false, because the
 * auto-approve fast paths were only evaluated at ENQUEUE time. Approving the
 * first saved the fingerprint, yet the second — already sitting in the queue —
 * still prompted:
 *
 *   03:06:19.994  Saved tool fingerprint "tool:editing chatwebviewprovider.ts|other"
 *   03:06:19.995  requestPermission: Editing ChatWebviewProvider.ts  (asks again)
 *
 * The fix re-evaluates the fast paths on dequeue, so the second request is
 * auto-approved from the fingerprint the first one just saved.
 *
 * PermissionHandler transitively imports `vscode`; the `test:unit` mocha
 * invocation preloads `src/test/vscode-shim.cjs` to serve a minimal fake.
 */

import { PermissionHandler } from '../handlers/PermissionHandler';

/** Two edits to the same file — identical title, distinct toolCallIds. */
function editRequest(toolCallId: string): any {
  return {
    sessionId: 'sess-1',
    toolCall: { toolCallId, title: 'Editing ChatWebviewProvider.ts' },
    options: [
      { optionId: 'allow_once', name: 'Yes', kind: 'allow_once' },
      { optionId: 'allow_always', name: 'Always', kind: 'allow_always' },
      { optionId: 'reject_once', name: 'No', kind: 'reject_once' },
    ],
  };
}

/** Yield to the event loop, modelling the real QuickPick round-trip. */
const tick = () => new Promise((r) => setTimeout(r, 5));

/**
 * Build a handler whose approved-tool store is in memory (never touches
 * ~/.cursor/acp-permissions.json) and whose interactive prompt is counted
 * instead of shown. The stubbed prompt mimics the real flow: it awaits (a real
 * QuickPick takes seconds, so sibling requests pile up in the queue meanwhile),
 * the user allows, and the fingerprint is persisted.
 */
function makeHandler() {
  const handler = new PermissionHandler() as any;
  const approved = new Set<string>();
  const promptedTitles: string[] = [];

  handler.loadApprovedTools = () => Array.from(approved);
  handler.persistApprovedTools = () => {};
  handler.saveApprovedTool = (fp: string) => {
    if (fp) {
      approved.add(fp);
    }
  };
  handler.handleManualPermission = async (params: any) => {
    promptedTitles.push(params.toolCall.title);
    await tick();
    // The real handler persists the fingerprint on allow (allow_always, or any
    // allow in remember mode).
    handler.saveApprovedTool(handler.extractToolFingerprint(params));
    return { outcome: { outcome: 'selected', optionId: 'allow_always' } };
  };

  return { handler, approved, promptedTitles };
}

suite('permissionQueueAutoApprove', () => {
  test('parallel edits to the same file prompt only once', async () => {
    const { handler, promptedTitles } = makeHandler();

    // Both requests are issued before either is answered — exactly what the
    // traffic log shows (2ms apart).
    const [first, second] = await Promise.all([
      handler.requestPermission(editRequest('toolu_1')),
      handler.requestPermission(editRequest('toolu_2')),
    ]);

    assert.strictEqual(promptedTitles.length, 1, `expected a single prompt, got ${promptedTitles.length}`);
    assert.strictEqual(first.outcome.outcome, 'selected');
    assert.strictEqual(second.outcome.outcome, 'selected');
  });

  test('three parallel edits to the same file still prompt only once', async () => {
    const { handler, promptedTitles } = makeHandler();
    const results = await Promise.all([
      handler.requestPermission(editRequest('toolu_1')),
      handler.requestPermission(editRequest('toolu_2')),
      handler.requestPermission(editRequest('toolu_3')),
    ]);
    assert.strictEqual(promptedTitles.length, 1);
    for (const r of results) {
      assert.strictEqual(r.outcome.outcome, 'selected');
    }
  });

  test('parallel edits to DIFFERENT files each prompt', async () => {
    const { handler, promptedTitles } = makeHandler();
    const other = editRequest('toolu_2');
    other.toolCall.title = 'Editing PermissionHandler.ts';

    await Promise.all([handler.requestPermission(editRequest('toolu_1')), handler.requestPermission(other)]);

    assert.deepStrictEqual(promptedTitles, ['Editing ChatWebviewProvider.ts', 'Editing PermissionHandler.ts']);
  });

  test('a rejected first request does not auto-approve the queued sibling', async () => {
    const { handler, promptedTitles } = makeHandler();
    // Reject: the real handler does NOT persist the fingerprint on reject.
    handler.handleManualPermission = async (params: any) => {
      promptedTitles.push(params.toolCall.title);
      await tick();
      return { outcome: { outcome: 'selected', optionId: 'reject_once' } };
    };

    await Promise.all([
      handler.requestPermission(editRequest('toolu_1')),
      handler.requestPermission(editRequest('toolu_2')),
    ]);

    assert.strictEqual(promptedTitles.length, 2, 'a rejection must not silently approve the sibling request');
  });
});

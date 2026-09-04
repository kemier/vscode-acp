import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Compaction replaces the conversation with a summary. The skill buffer is
 * force-archived (flushSkillBuffer), but the summarized CONTENT was lost:
 * capture is per-turn and `beginTurn` skips slash commands — manual compaction
 * IS `/compact` — so `endTurn` -> addConversation never ran for that turn. The
 * next conversation then recalled pre-compaction fragments instead of the
 * summary that replaced them.
 *
 * The summary now travels from the webview (the only place that holds it) to
 * the host, which captures it through the same endpoints endTurn uses.
 */
const PROVIDER = path.resolve(__dirname, '../../src/core/memory/SharedMemoryProvider.ts');
const SESSION_MANAGER = path.resolve(__dirname, '../../src/core/SessionManager.ts');
const WEBVIEW = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

suite('compaction summary capture', () => {
  const provider = fs.readFileSync(PROVIDER, 'utf8');
  const manager = fs.readFileSync(SESSION_MANAGER, 'utf8');
  const webview = fs.readFileSync(WEBVIEW, 'utf8');

  test('the provider captures the summary through the endTurn endpoints', () => {
    const idx = provider.indexOf('async captureCompactionSummary(');
    assert.ok(idx > 0, 'captureCompactionSummary missing');
    const body = provider.slice(idx, idx + 2600);
    // Same normalization as endTurn, or L0 fills with markup and code.
    for (const step of ['sanitizeMemoryText', 'stripCodeBlocks', 'truncateForCapture', 'shouldCaptureL0']) {
      assert.ok(body.indexOf(step) > 0, `missing ${step}`);
    }
    // Memory AND skill input — the feature is "memories and skills".
    assert.ok(body.indexOf('client.addConversation(') > 0, 'summary not captured as memory');
    assert.ok(body.indexOf('client.skillConversationAdd(') > 0, 'summary not fed to skill extraction');
    // Must never break compaction.
    assert.ok(body.indexOf('catch') > 0, 'capture is not best-effort');
  });

  test('onContextCompacted captures the summary before flushing the skill buffer', () => {
    const idx = manager.indexOf('onContextCompacted(sessionId: string, summaryText?: string)');
    assert.ok(idx > 0, 'onContextCompacted does not accept the summary');
    const body = manager.slice(idx, idx + 2200);
    const capture = body.indexOf('captureCompactionSummary(');
    const flush = body.indexOf("flushSkillBuffer(sessionId, agentName, 'compaction')");
    assert.ok(capture > 0 && flush > 0, 'both steps must run');
    assert.ok(capture < flush, 'capture must precede the flush so the summary is part of what is archived');
    // The pre-existing behaviour must survive.
    assert.ok(body.indexOf('resetMemoryInjectGates(') > 0, 'inject gates no longer reset');
    assert.ok(body.indexOf('resetL1Dedup(') > 0, 'L1 dedup no longer reset');
  });

  test('the webview forwards the summary text it holds', () => {
    const idx = webview.indexOf("type: 'compactionCompleted'");
    assert.ok(idx > 0, 'compactionCompleted post site missing');
    const body = webview.slice(idx, idx + 320);
    assert.ok(body.indexOf('summaryText: notice || warning') > 0, 'summary text not forwarded');
    assert.ok(
      webview.indexOf("typeof message.summaryText === 'string' ? message.summaryText : undefined") > 0,
      'host does not read the forwarded summary',
    );
  });

  test('the slash-command exemption is still in place (no memory injected into /compact)', () => {
    // The reported bug: 5.8 KB of memory appended after "/compact" defeated
    // codex's command match. Capturing the summary must not reintroduce it.
    const stability = fs.readFileSync(path.resolve(__dirname, '../../src/core/MemoryCacheStability.ts'), 'utf8');
    assert.ok(stability.indexOf('if (opts.isSlashCommand) {') > 0, 'slash exemption lost');
    assert.ok(manager.indexOf('isSlashCommand,') > 0, 'slash flag no longer passed');
  });
});

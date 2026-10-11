import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * /clear and a cleared-session resume must wipe the plan bar.
 *
 * The plan bar is a sibling DOM channel (id="planBar", outside messagesEl) that
 * the webview rebuilds from chatHistory kind:'plan' entries. /clear wiped chatHistory
 * and messagesEl but left planBar untouched, so the pre-clear todo list stayed
 * rendered — the reported "todos show before the clear point" symptom. A cleared
 * session's resume is worse: the agent now replays nothing, so handleLoadSessionEnd
 * takes the empty-replay branch that RETURNS before renderChatHistory() rebuilds
 * the bar, leaving the previous session's stale plan on screen.
 *
 * Both sites must null currentPlanEl and clear planBar.innerHTML, matching the
 * wipe every other history rebuild already performs (renderChatHistory, the
 * compact flushes).
 */

const ROOT = path.resolve(__dirname, '../..');
const provider = fs.readFileSync(path.join(ROOT, 'src/ui/ChatWebviewProvider.ts'), 'utf8');

const WIPE = 'currentPlanEl = null;';
const BAR = "if (planBar) { planBar.innerHTML = ''; }";

/** The window of source after `anchor`, used to assert a wipe follows it. */
function windowAfter(anchor: string, span: number): string {
  const at = provider.indexOf(anchor);
  assert.ok(at > 0, `anchor not found: ${JSON.stringify(anchor)}`);
  return provider.slice(at, at + span);
}

suite('/clear and cleared-session resume wipe the plan bar', () => {
  test('the non-Kiro /clear block nulls currentPlanEl and clears planBar', () => {
    // Anchor on the local-clear comment so we land in the branch that wipes the
    // UI immediately, not the Kiro branch that delegates to the agent.
    const clearBlock = windowAfter('// Local clear for non-Kiro', 900);
    assert.ok(clearBlock.includes(WIPE), '/clear must null currentPlanEl');
    assert.ok(clearBlock.includes(BAR), '/clear must clear planBar.innerHTML');
  });

  test('handleLoadSessionStart wipes planBar alongside the cursor/kiro boards', () => {
    // The empty-replay branch returns before renderChatHistory() rebuilds the bar,
    // so the wipe has to happen at load start. Anchor on the unique snapshot line
    // that follows the board resets and check the wipe precedes it.
    const snapAt = provider.indexOf('preLoadChatHistorySnapshot = chatHistory.slice();');
    assert.ok(snapAt > 0, 'load-start snapshot line not found');
    const loadBlock = provider.slice(snapAt - 700, snapAt);
    assert.ok(loadBlock.includes(WIPE), 'load start must null currentPlanEl');
    assert.ok(loadBlock.includes(BAR), 'load start must clear planBar.innerHTML');
  });

  test('the wipe matches the established renderChatHistory idiom', () => {
    // renderChatHistory already does the exact pair; the new sites must use the
    // same two statements so a future reader sees one consistent wipe.
    const renderAt = provider.indexOf('function renderChatHistory() {');
    assert.ok(renderAt > 0, 'renderChatHistory not found');
    const renderBody = provider.slice(renderAt, renderAt + 3200);
    assert.ok(renderBody.includes(WIPE) && renderBody.includes(BAR), 'renderChatHistory is the reference wipe');
  });
});

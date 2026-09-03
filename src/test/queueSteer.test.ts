import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Why a queued message waits for promptEnd instead of landing between tool calls.
 *
 * c397673 ("queue every mid-turn message — one per turn, no concurrent sends")
 * removed mid-turn steering outright: ericli drained only at tool-iteration
 * boundaries, codex-acp dropped the notification at the turn tail, and claude-code
 * deferred to sequential --resume turns, so steered text could disappear with no
 * response. Queue-and-drain replaced it, which is correct but means a message
 * typed mid-turn is delivered only once the turn ends.
 *
 * Steering is now offered back as an explicit action for the two agents whose
 * path is dependable. The default is unchanged.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

function extractFn(name: string): string {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' not found');
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(start, i + 1);
}

function loadGate(): (label: string) => boolean {
  const body = extractFn('agentSupportsMidTurnSteer');
  return new Function(`${body}; return agentSupportsMidTurnSteer;`)() as (l: string) => boolean;
}

suite('mid-turn steering of a queued message', () => {
  test('offered for the agents that implement it dependably', () => {
    const supports = loadGate();
    assert.strictEqual(supports('EricCLI'), true);
    assert.strictEqual(supports('ericli'), true);
    assert.strictEqual(supports('Claude Code'), true);
    assert.strictEqual(supports('claude-agent-acp'), true);
  });

  test('withheld where steer was unreliable, and when no agent is known', () => {
    const supports = loadGate();
    // codex-acp dropped the notification at the turn tail (c397673).
    assert.strictEqual(supports('Codex CLI'), false);
    assert.strictEqual(supports('Kiro CLI'), false);
    assert.strictEqual(supports('pi-acp'), false);
    assert.strictEqual(supports(''), false);
    assert.strictEqual(supports(undefined as any), false);
  });

  test('the action removes from the queue, shows the bubble, and notifies the host', () => {
    const fn = extractFn('steerQueuedMessage');
    // The bubble appears now because the message really is on its way — that is
    // the difference from queueing, where it waits for drain time.
    assert.ok(fn.includes('messageQueue.splice(index, 1)'), fn);
    assert.ok(fn.includes('addUserBubbleForQueuedEntry(entry)'), fn);
    assert.ok(fn.includes("type: 'steerPrompt'"), fn);
    // Never steer into a turn that is not running, nor to an agent without it.
    assert.ok(fn.includes('if (!isProcessing || !agentSupportsMidTurnSteer(currentAgentLabel())) return;'), fn);
    // Unlike Send Now this must NOT cancel the turn.
    assert.ok(!fn.includes('cancelTurn'), 'steering must not interrupt the turn');
  });

  test('the button only appears while a turn is running', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    assert.ok(src.includes('if (isProcessing && agentSupportsMidTurnSteer(currentAgentLabel()))'));
    assert.ok(src.includes("steerBtn.textContent = 'Steer'"));
    // Queue-and-drain stays the default: Send Now (interrupt) and drain (wait) both remain.
    assert.ok(src.includes('sendQueuedMessageNow(index)'));
    assert.ok(src.includes('function drainQueue()'));
  });

  test('the host forwards it as the session/steer notification', () => {
    const provider = fs.readFileSync(SOURCE, 'utf8');
    assert.ok(provider.includes("case 'steerPrompt':"));
    const sm = fs.readFileSync(path.resolve(__dirname, '../../src/core/SessionManager.ts'), 'utf8');
    assert.ok(sm.includes("connInfo.connection.notify('session/steer', { sessionId, text })"));
  });
});

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
    // codex-acp now calls Codex's native turn/steer with a currentTurnId guard,
    // so the text is delivered or refused — never silently dropped as in c397673.
    assert.strictEqual(supports('Codex CLI'), true);
    // Kiro CLI is adapted in this repo (vscode-acp) and receives session/steer.
    assert.strictEqual(supports('Kiro CLI'), true);
  });

  test('withheld from agents with no steer path, and when no agent is known', () => {
    const supports = loadGate();
    // cursor is an external binary with no adapter in this repo.
    assert.strictEqual(supports('Cursor'), false);
    // pi-acp queues whole prompts internally and implements no session/steer.
    assert.strictEqual(supports('pi-acp'), false);
    assert.strictEqual(supports('pi'), false);
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
    // Also skipped for an already-steered entry, which would otherwise send twice.
    assert.ok(src.includes('if (isProcessing && !entry.steered && agentSupportsMidTurnSteer(currentAgentLabel()))'));
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

suite('automatic steering of a mid-turn message', () => {
  function loadFn(name: string) {
    const body = extractFn(name);
    return new Function(`${body}; return ${name};`)();
  }

  test('auto-steers only where the agent confirms receipt by echoing', () => {
    const auto = loadFn('agentAutoSteersQueuedMessages') as (l: string) => boolean;
    // Both echo the steered text back as a user_message_chunk.
    assert.strictEqual(auto('EricCLI'), true);
    assert.strictEqual(auto('Claude Code'), true);
    // codex-acp joined once it echoed an accepted steer (codex-acp 881decb).
    assert.strictEqual(auto('Codex CLI'), true);
    // Kiro CLI is adapted in this repo and receives session/steer.
    assert.strictEqual(auto('Kiro CLI'), true);
    assert.strictEqual(auto('pi-acp'), false);
    assert.strictEqual(auto(''), false);
  });

  test('the echo matcher tolerates context appended after the text', () => {
    // The matcher delegates whitespace collapsing, so both helpers must be loaded.
    const body = extractFn('collapseWhitespaceChars') + '\n' + extractFn('steerEchoMatchesEntry');
    const matches = new Function(`${body}; return steerEchoMatchesEntry;`)() as (
      a: string,
      b: string,
    ) => boolean;
    assert.strictEqual(matches('check the logs', 'check the logs'), true);
    // Agents append memory blocks after the user text.
    assert.strictEqual(matches('check the logs', 'check the logs\nvscode-acp:///memory/ericli'), true);
    // Whitespace differences must not defeat it.
    assert.strictEqual(matches(' check   the logs ', 'check the logs'), true);
    // A different message must never be treated as the receipt.
    assert.strictEqual(matches('check the logs', 'deploy the build'), false);
    assert.strictEqual(matches('', 'anything'), false);
  });

  test('images and slash commands are never auto-steered', () => {
    const pick = new Function(`${extractFn('nextAutoSteerIndex')}; return nextAutoSteerIndex;`)() as (
      q: any[],
    ) => number;
    // An image cannot ride session/steer (text only), and a slash command must
    // start its own turn rather than being folded into the running one.
    assert.strictEqual(pick([{ text: 'look', images: [{}] }]), -1);
    assert.strictEqual(pick([{ text: '/compact' }]), -1);
    // The first eligible entry wins, skipping the ineligible ones before it.
    assert.strictEqual(pick([{ text: '/ps' }, { text: 'do it' }]), 1);
    const fn = extractFn('maybeAutoSteerNext');
    // Never during compaction / clearing, which own the turn.
    assert.ok(fn.includes('!isProcessing || isCompacting || isClearing'), fn);
    assert.ok(fn.includes('entry.steered = true;'), fn);
  });

  test('only one steer is in flight; the next waits for the ack', () => {
    const pick = new Function(`${extractFn('nextAutoSteerIndex')}; return nextAutoSteerIndex;`)() as (
      q: any[],
    ) => number;
    // Steering the whole queue at once buried the earlier messages, and an echo
    // cannot be attributed when several unacked steers share the channel.
    assert.strictEqual(pick([{ text: 'a', steered: true }, { text: 'b' }]), -1);
    assert.strictEqual(pick([{ text: 'a' }, { text: 'b' }]), 0);
    assert.strictEqual(pick([]), -1);
    assert.strictEqual(pick(null as any), -1);
  });

  test('an ack releases the next queued message', () => {
    const ack = extractFn('ackSteeredQueueEntry');
    assert.ok(ack.includes('maybeAutoSteerNext()'), ack);
    const bubble = ack.indexOf('addUserBubbleForQueuedEntry(e)');
    const next = ack.indexOf('maybeAutoSteerNext()');
    assert.ok(bubble > 0 && next > bubble, 'promote the confirmed one before releasing the next');
  });

  test('a turn ending clears an unacked steer flag so later turns are not blocked', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    assert.ok(src.includes('delete messageQueue[_qi].steered;'));
    // The entry itself must survive — drainQueue still has to send it.
    const idx = src.indexOf('delete messageQueue[_qi].steered;');
    assert.ok(!src.slice(idx - 300, idx).includes('messageQueue.splice'));
  });

  test('a steered entry stays queued until acked, so nothing is lost', () => {
    const fn = extractFn('queueMessage');
    // The entry is pushed BEFORE the steer and never removed there — drainQueue
    // still sends it at promptEnd if the echo never arrives.
    const push = fn.indexOf('messageQueue.push(entry)');
    const steer = fn.indexOf('maybeAutoSteerNext()');
    assert.ok(push > 0 && steer > push, 'the entry must be queued before steering');
    assert.ok(!fn.includes('messageQueue.splice'), 'queueMessage must not remove the entry');
    // Removal happens only on the agent's echo.
    const ack = extractFn('ackSteeredQueueEntry');
    assert.ok(ack.includes('e.steered && steerEchoMatchesEntry(e.text, echoText)'), ack);
    assert.ok(ack.includes('messageQueue.splice(i, 1)'), ack);
  });

  test('the confirmed message becomes a chat bubble, not a silent disappearance', () => {
    // The live user_message_chunk path returns early (the webview adds user bubbles
    // locally), so the echo renders nothing by itself. Acking by deletion alone
    // left the message nowhere: chip gone, nothing in the transcript.
    const ack = extractFn('ackSteeredQueueEntry');
    assert.ok(ack.includes('addUserBubbleForQueuedEntry(e)'), ack);
    const splice = ack.indexOf('messageQueue.splice(i, 1)');
    const bubble = ack.indexOf('addUserBubbleForQueuedEntry(e)');
    assert.ok(splice > 0 && bubble > splice, 'remove the chip, then render the bubble');
  });

  test('a steered entry is visibly marked and loses its now-pointless Steer button', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    assert.ok(src.includes("chip.classList.add('queue-steered')"));
    assert.ok(src.includes("sentTag.textContent = 'in turn'"));
    assert.ok(src.includes('.msg-queue-item .queue-sent-tag {'), 'the tag needs a style');
    // Steering an already-steered entry would send it twice.
    assert.ok(src.includes("if (isProcessing && !entry.steered && agentSupportsMidTurnSteer(currentAgentLabel()))"));
  });

  test('the ack runs on live chunks only, not during replay', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    assert.ok(src.includes("if (!isLoadingSession && typeof ackSteeredQueueEntry === 'function')"));
  });
});

suite('auto-steer is settable, and ordered by delivery', () => {
  /**
   * Two messages typed during one ericli turn were both pushed in as interjections
   * (steers at 07:11:45 and 07:12:07, each echoed and each dropped from the queue on
   * its echo) and the agent answered only the second. The first was gone — acked, so
   * no longer queued, and never addressed.
   *
   * Queue-and-drain has neither failure: strict order, one message per turn, and a
   * real answer for each. Steering stays available as an explicit action.
   */
  test('the setting exists and defaults to on, with the ordering contract stated', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'),
    );
    const prop = pkg.contributes.configuration.properties['acp.autoSteerQueuedMessages'];
    assert.ok(prop, 'acp.autoSteerQueuedMessages must be contributed');
    assert.strictEqual(prop.default, true);
    // The description must state both the one-at-a-time rule and that this is an
    // extension, since ACP has no steering method at all.
    assert.match(prop.description, /One message is in flight at a time/);
    assert.match(prop.description, /Not part of ACP/);
  });

  test('nothing is auto-steered unless the setting is on', () => {
    const fn = extractFn('maybeAutoSteerNext');
    assert.ok(fn.includes('if (!autoSteerQueuedEnabled) return false;'), fn);
    // The flag must be checked BEFORE the in-flight and agent checks, so the default
    // path costs nothing and cannot steer by accident.
    const gate = fn.indexOf('autoSteerQueuedEnabled');
    const processing = fn.indexOf('!isProcessing');
    assert.ok(gate > 0 && gate < processing);
  });

  test('the host sends the setting and the webview stores it', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    assert.ok(src.includes("get<boolean>('autoSteerQueuedMessages') !== false"));
    assert.ok(src.includes('if (typeof msg.autoSteerQueued === \'boolean\') autoSteerQueuedEnabled = msg.autoSteerQueued;'));
    // Webview default matches the setting default, so behaviour is the same before
    // the first state message arrives.
    assert.ok(src.includes('let autoSteerQueuedEnabled = true;'));
    assert.ok(src.includes("get<boolean>('autoSteerQueuedMessages') !== false"));
  });

  test('the manual Steer button is untouched by the setting', () => {
    const fn = extractFn('steerQueuedMessage');
    assert.ok(!fn.includes('autoSteerQueuedEnabled'), 'an explicit Steer must always work');
    assert.ok(fn.includes("type: 'steerPrompt'"), fn);
  });
});

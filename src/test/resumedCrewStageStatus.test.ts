/**
 * A finished crew card must not start spinning again because a NEW turn is live.
 *
 * Field capture — resuming ericli session 41e95918, switching to GLM-5.2, then
 * sending a prompt. The replayed crew card arrives complete:
 *
 *   traffic:  tool_call tc-1918 "Spawn 3 subagents" status="completed"
 *   client:   [WV-CREW] route: … loading=true processing=false id=tc-1918
 *   client:   [STAGE-DBG] kiro-stages init idx=0 name="batch1-concepts"
 *                          stageKeys=[name,role,prompt]          ← no status
 *
 * The stages carry no status of their own, so the fallback chain decides what is
 * drawn. It used to consult the GLOBAL isProcessing flag before the parent's own
 * terminal status, so any running turn repainted that old card's three stages as
 * running — "waiting subagent" on a session whose subagents finished a day
 * earlier, with subagentsInFlight: 0 persisted and subagent_wait unable to block
 * (its loop needs totalPendingSubagents > 0, which is 0 in a fresh process).
 *
 * The one case where a completed parent really does have running children is a
 * DETACHED spawn, which completes on its launch ack. That is marked by
 * _meta.subagentsDetached and persisted onto the history entry, so it is what the
 * live-turn branch keys off now.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

suite('resumed crew stages do not spin during a later turn', () => {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const at = src.indexOf('var rowStageStatus = stage.status;');
  const block = src.slice(at, src.indexOf('var stageIcon = stageIconStatus(rowStageStatus);', at));
  const declarations = block.replace(/\/\/[^\n]*/g, '');

  test('a terminal parent settles its stages before the live-turn guess', () => {
    assert.ok(at > 0, 'stage status fallback not found');
    const completedIdx = declarations.indexOf("status === 'completed'");
    const runningIdx = declarations.indexOf("rowStageStatus = 'running'");
    assert.ok(completedIdx > 0 && runningIdx > 0, `both branches must exist: ${declarations}`);
    assert.ok(
      completedIdx < runningIdx,
      'the completed branch must come FIRST — ordering it after isProcessing is what repainted old cards',
    );
  });

  test('the live-turn guess is reachable only for a detached crew', () => {
    assert.ok(
      /status === 'completed' && !_liveDetachedCrew/.test(declarations),
      `the completed branch must yield only to a live detached crew: ${declarations}`,
    );
  });

  test('detachment is read from the history entry, not guessed', () => {
    const scope = src.slice(src.indexOf('var _liveDetachedCrew = false;'), at);
    assert.ok(scope.includes('toolCallIdsMatch(_hd.toolCallId, toolCallId)'), 'must match the card by id');
    assert.ok(scope.includes('_hd.subagentsDetached'), 'must read the persisted detached marker');
    assert.ok(
      scope.includes('if (isProcessing && !isLoadingSession) {'),
      'the lookup only matters while a turn is live — skip the scan otherwise',
    );
  });

  test('the ericli completed-parent correction no longer keys on isProcessing', () => {
    const fix = src.slice(src.indexOf('if (!stage.status && isSubagentSpawnTitle('), at + 4000);
    const head = fix.slice(0, fix.indexOf('}'));
    assert.ok(head.includes('!_liveDetachedCrew'), `must use the live-detached test: ${head}`);
    assert.ok(!/!isProcessing/.test(head), 'a new turn must not disable the correction for an old card');
  });

  test('a live detached spawn still shows its stages running', () => {
    // The launch ack completes the parent while the subagents work — those stages
    // must keep spinning, which is the whole reason the flag exists.
    assert.ok(
      /_liveDetachedCrew\s*=\s*!!_hd\.subagentsDetached/.test(src),
      'the flag must come from the marker ericli sets on a detached spawn',
    );
    assert.ok(
      /else if \(isProcessing && !isLoadingSession\) rowStageStatus = 'running';/.test(src),
      'the running branch must remain for the live detached case',
    );
  });
});

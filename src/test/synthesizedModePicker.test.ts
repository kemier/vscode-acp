import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The agent picker must not disappear when an agent publishes only SOME pickers.
 *
 * Reported: the composer showed a model picker and a thinking picker, and no way to
 * choose kiro's agent — so Plan mode (kiro_planner) was unreachable from the UI even
 * though kiro advertises it.
 *
 * Kiro sends its three agents in the LEGACY `modes` field of session/load:
 *
 *   currentModeId: "kiro_default"
 *   availableModes: [ kiro_default, kiro_planner, kiro_guide ]
 *
 * while model and effort come from configOptions the extension SYNTHESISES for it
 * (kiro has no set_config_option). And the webview hides the legacy pickers the
 * moment any configOption exists — "spec requires configOptions to be used
 * exclusively". The synthesiser built model and thinking only, so the mode picker
 * was hidden with nothing to replace it.
 *
 * Fixed at the source: synthesise the mode option too, keeping ONE rule
 * (configOptions are the whole truth) rather than teaching the webview to hide
 * pickers individually, which would be a second rule able to disagree with the first.
 */

const ROOT = path.resolve(__dirname, '../..');
const sm = fs.readFileSync(path.join(ROOT, 'src/core/SessionManager.ts'), 'utf8');

/**
 * The slice of a method body from a branch to the END of that body.
 *
 * Not a character count: the mode branch's state update sits ~730 chars in, and a
 * 700-char window silently checked a fragment — the fixed-slice trap this repo keeps
 * re-learning, hit five times in one day.
 */
function branchToEnd(body: string, marker: string): string {
  const at = body.indexOf(marker);
  assert.ok(at > 0, `marker not found: ${marker}`);
  return body.slice(at);
}

/** Brace-matched body of a method. */
function bodyOf(signature: string): string {
  const at = sm.indexOf(signature);
  assert.ok(at > 0, `not found: ${signature}`);
  const open = sm.indexOf('{', sm.indexOf(')', at));
  let depth = 0;
  for (let i = open; i < sm.length; i++) {
    if (sm[i] === '{') {
      depth++;
    } else if (sm[i] === '}') {
      depth--;
      if (depth === 0) {
        return sm.slice(at, i + 1);
      }
    }
  }
  throw new Error(`unbalanced braces after ${signature}`);
}

suite('synthesized config options include the agent picker', () => {
  const body = bodyOf('private synthesizeConfigOptions(');

  test('a mode option is synthesized from legacy modes', () => {
    assert.ok(body.includes('session.modes?.availableModes'), 'legacy modes not read');
    assert.ok(/id: 'mode'/.test(body), 'no mode option id');
    assert.ok(/category: 'mode'/.test(body), 'no mode category');
  });

  test('it uses the same category codex already routes on', () => {
    // setMode looks for category === 'mode' in configOptions; using a different
    // name would build a picker that no set path recognises.
    assert.ok(sm.includes("configOptions.find((o) => o.category === 'mode')"), 'router changed');
  });

  test('currentModeId becomes the current value', () => {
    assert.ok(body.includes('session.modes.currentModeId'), 'current mode not carried');
  });

  test('every advertised mode becomes an option', () => {
    assert.ok(body.includes('session.modes.availableModes.map'), 'modes not mapped');
    assert.ok(/value: m\.id/.test(body), 'mode id not used as the value');
  });

  test('a single mode does NOT add a picker', () => {
    // One choice is not a choice; it would only take space in the composer.
    assert.ok(body.includes('availableModes.length > 1'), 'no single-mode guard');
  });

  test('model and thinking options are still synthesized', () => {
    assert.ok(/id: 'model'/.test(body), 'model option lost');
    assert.ok(/id: 'reasoning_effort'/.test(body), 'effort option lost');
  });

  test('agents with REAL configOptions are untouched', () => {
    // The early return is what keeps this from affecting codex/cursor, which
    // publish their own configOptions (including a mode one).
    const at = body.indexOf('if (session.configOptions && session.configOptions.length > 0)');
    assert.ok(at > 0, 'early return for agent-provided configOptions is gone');
    assert.ok(at < body.indexOf("id: 'mode'"), 'the guard must precede synthesis');
  });
});

suite('choosing an agent reaches the agent', () => {
  const body = bodyOf('async setConfigOption(');

  test('a synthesized mode routes to the legacy set_mode RPC', () => {
    // Without this the picker would render and silently do nothing, which is
    // worse than not offering it.
    assert.ok(body.includes("configId === 'mode'"), 'no mode branch in the fallback');
    const branch = branchToEnd(body, "configId === 'mode'");
    assert.ok(branch.includes("'session/set_mode'"), 'does not call session/set_mode');
    assert.ok(branch.includes('modeId: value'), 'does not pass the chosen mode');
  });

  test('the local state follows, so the picker shows the new agent', () => {
    const branch = branchToEnd(body, "configId === 'mode'");
    assert.ok(branch.includes('session.modes.currentModeId = value'), 'current mode not updated');
  });

  test('a failing set_mode does not throw out of the fallback', () => {
    // The whole branch exists because the agent lacks set_config_option; a second
    // failure must not break the picker.
    const branch = branchToEnd(body, "configId === 'mode'");
    assert.ok(/catch \(e2: any\)/.test(branch), 'set_mode failure is unguarded');
  });

  test('model and effort fallbacks are unchanged', () => {
    assert.ok(body.includes("configId === 'model'"), 'model fallback lost');
    assert.ok(body.includes("configId === 'reasoning_effort'"), 'effort fallback lost');
    assert.ok(body.includes("'session/set_model'"), 'legacy set_model lost');
  });
});

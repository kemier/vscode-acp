import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * A subagent stage hover must survive a DOM rebuild.
 *
 * The stage tooltip is built by formatStagesTooltipText, which emits one line per
 * known field:
 *
 *   Name: <name>
 *   Role: <role>          <- only when stage.role is truthy
 *   Mode: <mode>          <- only when stage.mode is truthy
 *   Prompt: …
 *
 * Every field except the name lived ONLY on the stage element's `_stageData` JS
 * property. A JS property does not survive a DOM rebuild (session restore /
 * re-render), so after one the tooltip collapsed to a bare "Name: <x>" and the
 * role looked missing — the symptom the [STAGE-DBG] probe was chasing ("role not
 * shown on hover ... something between creation and hover wiped it").
 *
 * The name survived only because it also had a data attribute, which is exactly
 * why the hover already fell back to getAttribute('data-stage-name'). These tests
 * pin the same durability for the other fields.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

suite('subagent stage hover survives a DOM rebuild', () => {
  const src = fs.readFileSync(SOURCE, 'utf8');

  test('persistStageAttrs writes every field the tooltip reads', () => {
    const at = src.indexOf('function persistStageAttrs(');
    assert.ok(at > 0, 'persistStageAttrs not found');
    const body = src.slice(at, at + 900);
    assert.ok(body.includes("setAttribute('data-stage-role'"), 'role must be persisted');
    assert.ok(body.includes("setAttribute('data-stage-mode'"), 'mode must be persisted');
    assert.ok(body.includes("setAttribute('data-stage-prompt'"), 'prompt must be persisted');
  });

  test('only truthy values are written, so a later empty patch cannot erase a role', () => {
    const at = src.indexOf('function persistStageAttrs(');
    const body = src.slice(at, at + 900);
    assert.ok(body.includes('if (m.role) '), 'role write must be guarded');
    assert.ok(body.includes('if (m.mode) '), 'mode write must be guarded');
    assert.ok(body.includes('if (p) '), 'prompt write must be guarded');
  });

  test('BOTH the creation and the late-arrival paths persist', () => {
    // Creation alone is not enough: Cursor ACP sends rawInput:{} first and fills
    // it later, so its stages only learn their role in updateStageFromRawInput.
    const create = src.indexOf('function createStageElement(');
    const update = src.indexOf('function updateStageFromRawInput(');
    assert.ok(create > 0 && update > 0, 'stage functions not found');
    assert.ok(
      src.slice(create, create + 2600).includes('persistStageAttrs('),
      'createStageElement must persist',
    );
    assert.ok(
      src.slice(update, update + 2600).includes('persistStageAttrs('),
      'updateStageFromRawInput must persist — this is the path Cursor relies on',
    );
  });

  test('the late-arrival path still refreshes the name too', () => {
    const update = src.indexOf('function updateStageFromRawInput(');
    const body = src.slice(update, update + 2600);
    assert.ok(body.includes("setAttribute('data-stage-name'"), 'pre-existing name refresh preserved');
  });

  test('the persisted prompt is capped so a large crew does not bloat the DOM', () => {
    const at = src.indexOf("setAttribute('data-stage-prompt'");
    assert.ok(at > 0);
    const line = src.slice(at, at + 160);
    assert.ok(line.includes('TC_TOOLTIP_MAX_CHARS'), 'cap at the tooltip limit it would be truncated to anyway');
  });

  test('the hover falls back to the attributes for every tooltip field', () => {
    // Without these fallbacks the attributes would be written but never read.
    const at = src.indexOf('var data = stageEl._stageData || {};');
    assert.ok(at > 0, 'stage hover data resolution not found');
    const block = src.slice(at, at + 1200);
    for (const attr of ['data-stage-role', 'data-stage-mode', 'data-stage-prompt']) {
      assert.ok(block.includes(attr), `hover must recover ${attr}`);
    }
    assert.ok(block.includes('data-stage-name'), 'name fallback must be preserved');
  });

  test('role is preferred from live data over the attribute', () => {
    // A tool_call_update can refine the role mid-turn; the attribute is only the
    // restore-time floor, so live data must win.
    const at = src.indexOf('var data = stageEl._stageData || {};');
    const block = src.slice(at, at + 1200);
    const roleLine = block.split('\n').find((l) => l.includes('data-stage-role')) || '';
    assert.ok(
      roleLine.indexOf('data.role') >= 0 &&
        roleLine.indexOf('data.role') < roleLine.indexOf('data-stage-role'),
      'live data.role must be consulted before the attribute',
    );
  });

  test('the tooltip still only prints Role when one is known', () => {
    // Guards against "Role: " with an empty value after the fallback chain.
    const at = src.indexOf('function formatStagesTooltipText(');
    assert.ok(at > 0);
    const body = src.slice(at, at + 1400);
    assert.ok(body.includes('if (stage.role) lines.push('), 'Role line stays conditional');
    assert.ok(body.includes('if (stage.mode) lines.push('), 'Mode line stays conditional');
  });
});

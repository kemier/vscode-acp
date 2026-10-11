import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * A fold the user opened mid-stream must stay open when the first assistant
 * message (or a thought) arrives.
 *
 * The tool-call handler keeps a user-opened fold open while streaming via an
 * explicit setFoldExpanded(true) fallback. The assistant/thought path funnels
 * through ensureCurrentTurnFold(), which calls ensureTurnFoldStructure(currentTurnEl,
 * collapsed=!!compactMode=true, force=true) and had NO such fallback — so the fold
 * the user expanded snapped shut the moment the first reply chunk arrived
 * (the reported "expand during streaming, first assistant message auto-collapses"
 * symptom). The fix mirrors the tool handler: while streaming, keep the fold open
 * unless the user explicitly collapsed it (body._userExpanded === false), gated on
 * isProcessing so promptEnd keeps its own collapse decision.
 */

const ROOT = path.resolve(__dirname, '../..');
const provider = fs.readFileSync(path.join(ROOT, 'src/ui/ChatWebviewProvider.ts'), 'utf8');

suite('ensureCurrentTurnFold honors a manual expand while streaming', () => {
  test('the funnel captures the body and force-opens it while streaming', () => {
    const at = provider.indexOf('function ensureCurrentTurnFold() {');
    assert.ok(at > 0, 'ensureCurrentTurnFold not found');
    const body = provider.slice(at, at + 1600);

    // It must rebuild the fold (collapsed=!!compactMode) AND keep a user-opened
    // fold open during streaming — the two halves of the fix.
    assert.ok(
      body.includes('ensureTurnFoldStructure(currentTurnEl, !!compactMode, true)'),
      'funnel still rebuilds the fold in compact mode',
    );
    assert.ok(
      body.includes('_foldBody._userExpanded !== false'),
      'funnel force-opens a fold the user did not explicitly collapse',
    );
    assert.ok(
      body.includes('setFoldExpanded(_foldBody, true)'),
      'funnel re-opens via setFoldExpanded, mirroring the tool handler',
    );
  });

  test('the force-open is gated on streaming, not promptEnd', () => {
    const at = provider.indexOf('function ensureCurrentTurnFold() {');
    const body = provider.slice(at, at + 1600);
    // The guard must require isProcessing (streaming) and exclude session/load,
    // so promptEnd (isProcessing false) and a replay keep their own collapse.
    assert.ok(
      /if \(_foldBody && isProcessing && !isLoadingSession && _foldBody\._userExpanded !== false\)/.test(body),
      'force-open gated on isProcessing && !isLoadingSession',
    );
  });

  test('the tool handler keeps its own (pre-existing) force-open — no regression', () => {
    // The fix must not have removed the tool-call handler's fallback, which is
    // what kept tool-first turns open. Anchor on its distinct guard order.
    assert.ok(
      provider.includes('if (isProcessing && _foldBody && _foldBody._userExpanded !== false)'),
      'tool handler still force-opens mid-stream',
    );
  });
});

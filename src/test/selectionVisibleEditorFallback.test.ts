import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * A selection must still reach the agent when the active tab is not a text editor.
 *
 * Reported: select text in a rendered Markdown preview, ask ericli about it, and the
 * content never arrives — the send logs `selections=0`.
 *
 * Selections were collected only from `vscode.window.activeTextEditor`, which is
 * undefined whenever the active tab is not a text editor. A Markdown preview is a
 * webview tab, so focusing it dropped the selection even though the source document
 * was still open beside it.
 *
 * The chat itself is a sidebar view (registerWebviewViewProvider), which is why a
 * normal editor selection works: focusing the sidebar leaves the main-area editor
 * active. Only a webview occupying the EDITOR area — the preview — breaks it.
 *
 * The fallback reads visible editors, not a remembered one: the selection is live in a
 * pane on screen, so in the usual source-beside-preview layout it is exactly what the
 * user means.
 *
 * What this cannot do: recover a selection made INSIDE the preview. That is another
 * extension's webview and VS Code exposes no API to read a DOM selection within it.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

suite('selection capture survives a non-editor active tab', () => {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const at = src.indexOf('const collectFrom = (ed: vscode.TextEditor): void =>');
  const block = src.slice(at, at + 2600);

  test('collection is factored out so both sources share it', () => {
    assert.ok(at > 0, 'collectFrom helper not found');
    assert.ok(block.includes('ed.document.getText(sel)'), 'reads the selected text');
    assert.ok(block.includes('sel.isEmpty'), 'still skips empty selections');
  });

  test('the active editor is still preferred', () => {
    const activeIdx = block.indexOf('vscode.window.activeTextEditor');
    const visibleIdx = block.indexOf('vscode.window.visibleTextEditors');
    assert.ok(activeIdx > 0 && visibleIdx > 0, 'both sources present');
    assert.ok(activeIdx < visibleIdx, 'active editor must be consulted first');
  });

  test('visible editors are used only when nothing was collected', () => {
    // Guards against duplicating the active editor's selection.
    const guard = block.slice(block.indexOf('if (selections.length === 0)'), block.indexOf('visibleTextEditors'));
    assert.ok(guard.length > 0, 'the visible-editor scan must be guarded');
    assert.ok(block.includes('if (selections.length === 0) {'), 'guarded on an empty result');
  });

  test('the limitation is recorded rather than implied', () => {
    // A future reader must not assume preview-internal selections were forgotten.
    assert.ok(
      block.includes('cannot recover a selection made INSIDE the preview'),
      'the API limitation must be stated',
    );
  });

  test('both paths feed the same selections array', () => {
    // The declaration is `collectFrom = (`, so count the two invocations only.
    assert.ok(block.includes('collectFrom(editor);'), 'active-editor call site');
    assert.ok(block.includes('collectFrom(ed);'), 'visible-editor call site');
  });
});

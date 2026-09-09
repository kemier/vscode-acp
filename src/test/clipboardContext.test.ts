import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { buildClipboardBlock } from '../core/ContextBlockBuilder';

/**
 * @clipboard: the only route to a selection made inside a Markdown preview.
 *
 * Measured: selecting in a rendered preview and asking about it sends selections=0,
 * on every attempt, including after the visible-editor fallback shipped. The reason is
 * not a missing fallback — the source document genuinely has no selection. The
 * selection lives in the DOM of another extension's webview, and per the VS Code API
 * there is no way to read it:
 *
 *   - the Markdown Extension guide documents markdown.previewStyles,
 *     markdown.previewScripts and extendMarkdownIt as the preview's extension points,
 *     and mentions selection nowhere;
 *   - activeTextEditor is undefined while a webview tab is active.
 *
 * Ctrl+C inside the preview DOES work, and vscode.env.clipboard is readable, so
 * "select, copy, ask with @clipboard" carries rendered content the selection path
 * cannot reach. Mirrors the existing @terminal / @problems mentions.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

suite('@clipboard context mention', () => {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const at = src.indexOf('if (/@clipboard\\b/i.test(text)) {');
  const block = src.slice(at, at + 1800);

  test('the mention is detected', () => {
    assert.ok(at > 0, '@clipboard branch not found');
  });

  test('it reads the real clipboard and strips the mention from the prompt', () => {
    assert.ok(block.includes('vscode.env.clipboard.readText()'), 'must read the clipboard');
    assert.ok(block.includes("text.replace(/@clipboard\\b/gi, '')"), 'mention must not reach the agent');
  });

  test('a clipboard read failure cannot break the send', () => {
    const guard = block.slice(0, block.indexOf('text = text.replace'));
    assert.ok(guard.includes('try {') && guard.includes('catch'), 'readText must be guarded');
  });

  test('an empty clipboard tells the user what to do', () => {
    assert.ok(block.includes('the clipboard is empty'), 'explains the state');
    assert.ok(block.includes('Ctrl+C'), 'gives the actual gesture');
    assert.ok(block.includes('Markdown preview works'), 'names the case it solves');
  });

  test('it follows the embedded-or-inline convention of the other mentions', () => {
    assert.ok(block.includes('buildClipboardBlock(clip, supportsEmbedded)'), 'uses the builder');
    assert.ok(block.includes('<clipboard>'), 'inline fallback when embedded context is unsupported');
  });
});

suite('buildClipboardBlock', () => {
  test('emits an embedded resource when the agent supports it', () => {
    const b = buildClipboardBlock('hello', true) as { type: string; resource: { uri: string; text: string } };
    assert.strictEqual(b.type, 'resource');
    assert.strictEqual(b.resource.uri, 'zed:///agent/clipboard');
    assert.strictEqual(b.resource.text, 'hello');
  });

  test('returns null without embedded context so the caller inlines it', () => {
    // The URI is not dereferenceable, so a resource_link would be useless.
    assert.strictEqual(buildClipboardBlock('hello', false), null);
  });
});

suite('@clipboard is discoverable and does not leak into the bubble', () => {
  const src = fs.readFileSync(SOURCE, 'utf8');

  test('typing "@" offers clipboard', () => {
    // It shipped without this: the handler worked but nothing advertised it, so "@"
    // never listed clipboard and the feature was effectively invisible.
    const at = src.indexOf('const mentions = [');
    assert.ok(at > 0, 'mention list not found');
    const list = src.slice(at, src.indexOf('];', at));
    assert.ok(list.includes("name: 'clipboard'"), 'clipboard must be in the mention list');
    assert.ok(list.includes('Markdown preview'), 'the hint should say where it helps');
  });

  test('it sits alongside the other context mentions', () => {
    const at = src.indexOf('const mentions = [');
    const list = src.slice(at, src.indexOf('];', at));
    for (const n of ['terminal', 'file', 'folder', 'problems', 'clipboard']) {
      assert.ok(list.includes(`name: '${n}'`), `${n} missing from the mention list`);
    }
  });

  test('the inline <clipboard> tag is stripped from the user bubble', () => {
    // Only the embedded-resource path hides the payload; without embeddedContext the
    // text is prepended inline and the raw tag would otherwise be displayed.
    const at = src.indexOf('function cleanUserMessage(');
    const body = src.slice(at, at + 2000);
    assert.ok(body.includes("stripTag(displayText, 'clipboard', null)"), 'clipboard tag must be stripped');
  });
});

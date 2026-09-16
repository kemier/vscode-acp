import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  isBareContextMention,
  BARE_CONTEXT_MENTION_SOURCE,
} from '../core/MentionScan';

/**
 * A paste whose text is nothing but a context mention became a contentless
 * attachment.
 *
 * Observed live (session/prompt id=7, 2026-09-16T09:58:28Z): a message arrived as
 *
 *   <clipboard>
 *   @clipboard
 *   </clipboard>
 *
 *   <clipboard>
 *   @clipboard
 *   </clipboard>
 *
 *   also fix this
 *
 * Two blocks, each carrying only the mention name. Nothing was lost in transport:
 * the OS clipboard really did hold the text "@clipboard", and the composer
 * faithfully recorded it as the payload for each of the two pastes. The paste
 * handler then inserted "@clipboard " — byte-identical to the pasted text — so
 * the result is self-amplifying: copy the composer, paste again, and the same
 * empty block reappears. That is how one clipboard value produced two identical
 * blocks.
 *
 * This is the degenerate case of the hazard documented at the top of
 * MentionScan.ts, where the clipboard held text that BEGAN with a mention and the
 * scan ate the word out of the payload. Ignoring payload interiors fixed that,
 * but not a payload that is ONLY the mention.
 *
 * Note what is NOT broken: a wrapped payload cannot trigger further mention
 * resolution, because "clipboard" is in OPAQUE_TAGS and hasMentionOutsideContext
 * scans proseRanges only. That is asserted below so the guarantee stays.
 */

const WEBVIEW = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

suite('bare context mention is not a clipboard payload', () => {
  test('recognises a mention with no content of its own', () => {
    for (const bare of [
      '@clipboard',
      '@clipboard ',
      ' @clipboard',
      '@clipboard\n',
      '@CLIPBOARD',
      '@clipboard:',
      '@terminal',
      '@problems ',
      '@selection',
      '@open_files',
    ]) {
      assert.strictEqual(isBareContextMention(bare), true, `should be bare: ${JSON.stringify(bare)}`);
    }
  });

  test('leaves real pasted content alone', () => {
    for (const real of [
      'const x = 1;',
      // A mention plus actual content is content — the user quoted something.
      '@clipboard is the mention I mean',
      'see @clipboard',
      // Path-bearing mentions always carry content after the colon.
      '@file:/tmp/a.ts',
      '@folder:/tmp',
      // Multi-line payloads that merely start with the word.
      '@clipboard\nsecond line',
    ]) {
      assert.strictEqual(isBareContextMention(real), false, `should be content: ${JSON.stringify(real)}`);
    }
  });

  test('empty text is not classified as a bare mention', () => {
    // Empty is a different condition with its own warning; conflating them would
    // change which message the user sees.
    for (const empty of ['', '   ', '\n', null as unknown as string, undefined as unknown as string]) {
      assert.strictEqual(isBareContextMention(empty), false, `empty must not be bare: ${JSON.stringify(empty)}`);
    }
  });
});

suite('bareContextMentionParity', () => {
  test('the webview builds the identical regex from the shared source', () => {
    const src = fs.readFileSync(WEBVIEW, 'utf8');
    // The webview realm cannot import MentionScan, so it interpolates the shared
    // pattern. Assert it interpolates rather than hardcoding a copy that can drift.
    const sig = 'function isBarePastedMention(text) {';
    const at = src.indexOf(sig);
    assert.ok(at > 0, 'webview helper isBarePastedMention missing');
    // Brace-match the body. A fixed slice would cut at the closing brace of the
    // ${...} interpolation, which is exactly the token being asserted on.
    const open = src.indexOf('{', at);
    let depth = 0;
    let end = -1;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') {
        depth++;
      } else if (src[i] === '}' && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    assert.ok(end > 0, 'could not brace-match isBarePastedMention');
    const body = src.slice(at, end);
    assert.ok(
      body.includes('JSON.stringify(BARE_CONTEXT_MENTION_SOURCE)'),
      `webview must derive the pattern from the shared constant, got: ${body}`,
    );
    assert.ok(body.includes("'i'"), `webview regex must be case-insensitive like the host, got: ${body}`);
  });

  test('the emitted webview pattern behaves like the host predicate', () => {
    // Reproduce the emission exactly: JSON.stringify produces the JS string
    // literal that lands in the generated script.
    const emitted = JSON.parse(JSON.stringify(BARE_CONTEXT_MENTION_SOURCE)) as string;
    const webviewRe = new RegExp(emitted, 'i');
    for (const sample of ['@clipboard', '@clipboard ', '@terminal', 'const x = 1;', 'see @clipboard']) {
      const hostSays = isBareContextMention(sample);
      const webviewSays = sample.trim() ? webviewRe.test(sample) : false;
      assert.strictEqual(
        webviewSays,
        hostSays,
        `realms disagree on ${JSON.stringify(sample)}: webview=${webviewSays} host=${hostSays}`,
      );
    }
  });
});

suite('the send path drops contentless clipboard payloads', () => {
  const src = fs.readFileSync(WEBVIEW, 'utf8');

  test('the per-paste payload list filters bare mentions', () => {
    const at = src.indexOf('const pasted: string[] = Array.isArray(clipboardPastedTexts)');
    assert.ok(at > 0, 'per-paste payload construction not found');
    const body = src.slice(at, src.indexOf('let clips', at));
    assert.ok(body.includes('isBareContextMention'), 'per-paste payloads are not filtered');
  });

  test('the OS-clipboard fallback filters bare mentions too', () => {
    // The fallback serves a TYPED @clipboard. If the clipboard itself holds
    // "@clipboard", the same contentless block would be produced.
    assert.ok(
      src.includes("clips = clip.trim() && !isBareContextMention(clip) ? [clip] : [];"),
      'fallback path does not filter a bare-mention clipboard value',
    );
  });

  test('the paste handler declines to attach a bare mention', () => {
    const at = src.indexOf("const text = e.clipboardData && e.clipboardData.getData('text/plain');");
    assert.ok(at > 0, 'paste handler text branch not found');
    const body = src.slice(at, at + 400);
    assert.ok(
      body.includes('!isBarePastedMention(text)'),
      'paste handler still converts a bare mention into an attachment',
    );
    // Declining must fall through to the browser default (no preventDefault),
    // so the word actually lands in the composer as the user intended.
    const guardAt = body.indexOf('!isBarePastedMention(text)');
    const preventAt = body.indexOf('e.preventDefault()');
    assert.ok(preventAt > guardAt, 'preventDefault must sit inside the guarded branch');
  });

  test('the empty-clipboard warning does not misdiagnose a bare mention', () => {
    // "the clipboard is empty" when it actually held "@clipboard" sends the user
    // off to re-copy text they already copied.
    const at = src.indexOf('the clipboard is empty');
    assert.ok(at > 0, 'empty-clipboard warning not found');
    const around = src.slice(Math.max(0, at - 900), at + 300);
    assert.ok(
      around.includes('isBareContextMention'),
      'the warning does not distinguish an empty clipboard from a bare-mention one',
    );
    assert.ok(
      around.includes('nothing to attach'),
      'no distinct message for the bare-mention case',
    );
  });
});

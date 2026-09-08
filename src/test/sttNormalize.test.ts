import * as assert from 'assert';
import { normalizeTranscriptWhitespace } from '../voice/SttClient';

suite('normalizeTranscriptWhitespace', () => {
  test('collapses blank lines and joins CJK without spaces', () => {
    const raw = '然后也可以\n\n粘贴图片\n下面是两个功能';
    assert.strictEqual(normalizeTranscriptWhitespace(raw), '然后也可以粘贴图片下面是两个功能');
  });

  test('keeps a single space between English words', () => {
    assert.strictEqual(normalizeTranscriptWhitespace('hello\n\nworld'), 'hello world');
  });

  test('trims edges and drops whitespace-only lines', () => {
    assert.strictEqual(normalizeTranscriptWhitespace('  \nfoo  \n  \n  bar  \n'), 'foo bar');
  });

  test('empty input stays empty', () => {
    assert.strictEqual(normalizeTranscriptWhitespace(''), '');
    assert.strictEqual(normalizeTranscriptWhitespace('   \n\n  '), '');
  });
});

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyCorrections, VoiceMemoryStore, DEFAULT_MEMORY } from '../voice/VoiceMemory';

suite('VoiceMemory applyCorrections', () => {
  test('returns input unchanged for empty dictionary', () => {
    assert.strictEqual(applyCorrections('hello 世界', {}), 'hello 世界');
  });

  test('CJK keys use plain substring replace', () => {
    const out = applyCorrections('这个有机翼功能吗', { 机翼: '记忆' });
    assert.strictEqual(out, '这个有记忆功能吗');
  });

  test('ASCII keys match on word boundaries only', () => {
    const corrections = { SAP: 'ACP' };
    assert.strictEqual(applyCorrections('check the SAP log', corrections), 'check the ACP log');
    // "ASAP" must not be mangled by the "SAP" rule
    assert.strictEqual(applyCorrections('do it ASAP', corrections), 'do it ASAP');
  });

  test('longest key wins for overlapping entries', () => {
    const corrections = { SAP: 'ACP', 'SAP log': 'ACP Traffic log' };
    assert.strictEqual(applyCorrections('see SAP log', corrections), 'see ACP Traffic log');
  });

  test('empty keys are ignored', () => {
    assert.strictEqual(applyCorrections('abc', { '': 'x' }), 'abc');
  });

  test('multiple corrections apply in one pass', () => {
    const out = applyCorrections('机翼记忆和转动出来', { 机翼: '记忆', 转动: '转写' });
    assert.strictEqual(out, '记忆记忆和转写出来');
  });
});

suite('VoiceMemoryStore', () => {
  test('defaults live under ~/.vscode-acp', () => {
    const store = new VoiceMemoryStore('');
    assert.strictEqual(store.memoryPath, path.join(os.homedir(), '.vscode-acp', 'voice-memory.md'));
    assert.strictEqual(
      store.feedbackPath,
      path.join(os.homedir(), '.vscode-acp', 'voice-feedback.jsonl'),
    );
  });

  test('loadMemory seeds the default file on first use', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'voice-mem-'));
    const store = new VoiceMemoryStore(path.join(dir, 'memory.md'));
    const mem = await store.loadMemory();
    assert.strictEqual(mem, DEFAULT_MEMORY);
    // Second load reads the seeded file from disk.
    const again = await store.loadMemory();
    assert.strictEqual(again, DEFAULT_MEMORY);
  });

  test('feedback roundtrip: append, read, clear', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'voice-mem-'));
    const store = new VoiceMemoryStore(path.join(dir, 'memory.md'));
    assert.deepStrictEqual(await store.readFeedback(), []);
    await store.appendFeedback({
      ts: 1,
      sessionId: 's1',
      stt: '这个有机翼功能吗',
      inserted: '这个有机翼功能吗',
      final: '这个有记忆功能吗',
      kind: 'edited',
    });
    await store.appendFeedback({
      ts: 2,
      sessionId: 's1',
      stt: 'looks good',
      inserted: 'looks good',
      kind: 'accept',
    });
    const entries = await store.readFeedback();
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0].kind, 'edited');
    assert.strictEqual(entries[0].final, '这个有记忆功能吗');
    assert.strictEqual(entries[1].kind, 'accept');
    await store.clearFeedback();
    assert.deepStrictEqual(await store.readFeedback(), []);
  });

  test('readFeedback skips corrupt lines', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'voice-mem-'));
    const store = new VoiceMemoryStore(path.join(dir, 'memory.md'));
    await fs.promises.writeFile(
      store.feedbackPath,
      '{"ts":1,"sessionId":null,"stt":"a","inserted":"a","kind":"accept"}\nnot-json\n\n',
      'utf8',
    );
    const entries = await store.readFeedback();
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].stt, 'a');
  });
});

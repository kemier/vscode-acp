import * as assert from 'assert';
import { l1DedupKey, skillDedupKey } from '../core/memory/MemoryDedup';

suite('MemoryDedup', () => {
  suite('l1DedupKey', () => {
    test('prefers stable id when present', () => {
      assert.strictEqual(l1DedupKey({ id: 'mem-1', content: 'hello' }), 'mem-1');
    });

    test('falls back to content hash when id missing', () => {
      const a = l1DedupKey({ content: 'same text' });
      const b = l1DedupKey({ content: 'same text' });
      const c = l1DedupKey({ content: 'different' });
      assert.ok(a?.startsWith('h:'));
      assert.strictEqual(a, b);
      assert.notStrictEqual(a, c);
    });

    test('trims whitespace before hashing', () => {
      assert.strictEqual(l1DedupKey({ content: '  hello  ' }), l1DedupKey({ content: 'hello' }));
    });
  });

  suite('skillDedupKey', () => {
    test('prefers skill_id when present', () => {
      assert.strictEqual(
        skillDedupKey({ skill_id: 's1', name: 'a', description: 'd', version: 1 }),
        's1',
      );
    });

    test('falls back to name+description hash when skill_id missing', () => {
      const a = skillDedupKey({ skill_id: '', name: 'deploy', description: 'Deploy app', version: 1 });
      const b = skillDedupKey({ skill_id: '', name: 'deploy', description: 'Deploy app', version: 2 });
      assert.ok(a?.startsWith('h:'));
      assert.strictEqual(a, b);
    });
  });
});

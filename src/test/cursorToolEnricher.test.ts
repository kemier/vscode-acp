import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  formatCursorEnrichedTitle,
  indexToolCallsFromBlobTexts,
  isCursorAgentName,
  isCursorStubToolTitle,
  hasActionableToolArgs,
  isEmptyRawInput,
  needsCursorToolEnrichment,
  parseCursorToolArgs,
  findCursorSessionStorePath,
  CursorSessionToolEnricher,
  lookupEnriched,
  MAX_LIVE_ENRICH_FULL_SCAN_BYTES,
  cursorToolMatchKind,
  cursorSearchKindFallback,
  cursorFileMutateKindFallback,
  confirmedFileMutationKind,
  indexToolCallsFromBlobTextsOrdered,
  SQL_JSON_BLOB_PREFIX,
  isLargeCursorStore,
  loadEnrichedToolCallsByPrefix,
  toolCallIdPrefix,
} from '../core/CursorToolEnricher';

suite('CursorToolEnricher', () => {
  test('detects cursor agent names', () => {
    assert.strictEqual(isCursorAgentName('cursor-agent'), true);
    assert.strictEqual(isCursorAgentName('Cursor Agent'), true);
    assert.strictEqual(isCursorAgentName('claude'), false);
    assert.strictEqual(isCursorAgentName(undefined), false);
  });

  test('detects empty rawInput and stub titles', () => {
    assert.strictEqual(isEmptyRawInput({}), true);
    assert.strictEqual(isEmptyRawInput(null), true);
    assert.strictEqual(isEmptyRawInput({ path: '/x' }), false);
    assert.strictEqual(isEmptyRawInput({ _toolName: 'read' }), true);
    assert.strictEqual(isEmptyRawInput({ toolName: 'Grep' }), true);
    assert.strictEqual(hasActionableToolArgs({ _toolName: 'read' }), false);
    assert.strictEqual(hasActionableToolArgs({ pattern: 'foo' }), true);
    assert.strictEqual(isCursorStubToolTitle('Read File'), true);
    assert.strictEqual(isCursorStubToolTitle('grep'), true);
    assert.strictEqual(isCursorStubToolTitle('Find'), true);
    assert.strictEqual(isCursorStubToolTitle('Read /tmp/a.ts'), false);
  });

  test('needsCursorToolEnrichment only for stub+empty', () => {
    assert.strictEqual(
      needsCursorToolEnrichment({
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Read File',
        rawInput: {},
      }),
      true,
    );
    assert.strictEqual(
      needsCursorToolEnrichment({
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Read File',
        rawInput: { _toolName: 'read' },
      }),
      true,
    );
    assert.strictEqual(
      needsCursorToolEnrichment({
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Read File',
        rawInput: { path: '/a' },
      }),
      false,
    );
    assert.strictEqual(
      needsCursorToolEnrichment({
        sessionUpdate: 'agent_message_chunk',
        toolCallId: 't1',
      }),
      false,
    );
    assert.strictEqual(
      needsCursorToolEnrichment({
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
      }),
      false,
      'status-only tool_call_update must not poll store.db',
    );
    assert.strictEqual(
      needsCursorToolEnrichment({
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: '`cmd /c dir`',
        rawInput: { command: 'cmd /c dir' },
      }),
      false,
      'wire already has command',
    );
    assert.strictEqual(
      needsCursorToolEnrichment({
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        title: 'Read File',
        rawInput: {},
      }),
      true,
      'explicit stub patch still enriches',
    );
  });

  test('isLargeCursorStore detects multi-100MB store.db', () => {
    const tmp = path.join(os.tmpdir(), `acp-store-size-${Date.now()}.db`);
    try {
      fs.writeFileSync(tmp, Buffer.alloc(121 * 1024 * 1024));
      assert.strictEqual(isLargeCursorStore(tmp), true);
      fs.truncateSync(tmp, 1024);
      assert.strictEqual(isLargeCursorStore(tmp), false);
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // ignore
      }
    }
  });

  test('SQL_JSON_BLOB_PREFIX matches BLOB rows (TEXT { compare does not)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (path: string) => {
        exec: (sql: string) => void;
        prepare: (sql: string) => {
          run: (...params: unknown[]) => void;
          get: (...params: unknown[]) => { c?: number } | undefined;
        };
        close: () => void;
      };
    };
    const tmp = path.join(os.tmpdir(), `acp-json-blob-prefix-${Date.now()}.db`);
    const db = new DatabaseSync(tmp);
    try {
      db.exec('CREATE TABLE blobs (id TEXT, data BLOB)');
      const payload = Buffer.from(
        JSON.stringify({
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call-1\\nfc_x',
              toolName: 'Read',
              args: { path: '/tmp/a.ts' },
            },
          ],
        }),
        'utf8',
      );
      db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run('h1', payload);
      const broken = db
        .prepare(`SELECT COUNT(*) AS c FROM blobs WHERE substr(data, 1, 1) = '{'`)
        .get()?.c;
      const fixed = db.prepare(`SELECT COUNT(*) AS c FROM blobs WHERE ${SQL_JSON_BLOB_PREFIX}`).get()
        ?.c;
      assert.strictEqual(broken, 0, 'TEXT compare against BLOB substr must not match');
      assert.strictEqual(fixed, 1, 'X\'7B\'/X\'5B\' BLOB compare must match JSON blobs');
    } finally {
      try {
        db.close();
      } catch {
        // ignore
      }
      try {
        fs.unlinkSync(tmp);
      } catch {
        // ignore
      }
    }
  });

  test('parseCursorToolArgs handles object and JSON string', () => {
    assert.deepStrictEqual(parseCursorToolArgs({ path: '/a', limit: 20 }), {
      path: '/a',
      limit: 20,
    });
    assert.deepStrictEqual(parseCursorToolArgs('{"path":"/b","pattern":"x"}'), {
      path: '/b',
      pattern: 'x',
    });
  });

  test('cursorToolMatchKind splits grep vs glob for ordinal batch matching', () => {
    assert.strictEqual(cursorToolMatchKind('Glob', 'Find'), 'glob');
    assert.strictEqual(cursorToolMatchKind('', 'find'), 'glob');
    assert.strictEqual(cursorToolMatchKind('Grep', 'grep'), 'grep');
    assert.strictEqual(cursorToolMatchKind('', 'grep'), 'grep');
    assert.strictEqual(cursorToolMatchKind('Read', 'Read File'), 'read');
    assert.strictEqual(cursorToolMatchKind('', 'Find **/*.ts" in /tmp'), 'glob');
    assert.strictEqual(cursorToolMatchKind('', 'grep "foo"'), 'grep');
    assert.strictEqual(cursorToolMatchKind('grep', 'Find'), 'grep');
    assert.strictEqual(cursorToolMatchKind('Grep', 'Find'), 'grep');
    assert.strictEqual(cursorToolMatchKind('Write', 'Edit File'), 'write');
    assert.strictEqual(cursorToolMatchKind('write', 'Edit File'), 'write');
    assert.strictEqual(cursorToolMatchKind('', 'Edit File'), 'edit');
  });

  test('cursorFileMutateKindFallback tries alternate edit/write/delete queue', () => {
    assert.deepStrictEqual(cursorFileMutateKindFallback('edit'), ['edit', 'write', 'delete']);
    assert.deepStrictEqual(cursorFileMutateKindFallback('write'), ['write', 'edit', 'delete']);
    assert.deepStrictEqual(cursorFileMutateKindFallback('delete'), ['delete', 'edit', 'write']);
    assert.deepStrictEqual(cursorFileMutateKindFallback('read'), ['read']);
  });

  test('confirmedFileMutationKind avoids inferring edit from stub title alone', () => {
    assert.strictEqual(confirmedFileMutationKind('', 'Edit File', 'edit'), null);
    assert.strictEqual(confirmedFileMutationKind('Write', 'Edit File', 'edit'), 'write');
    assert.strictEqual(confirmedFileMutationKind('', 'Write src/foo.ts', 'edit'), 'write');
    assert.strictEqual(confirmedFileMutationKind('StrReplace', 'Edit File', 'edit'), 'edit');
  });

  test('cursorToolMatchKind recognizes delete separately from edit', () => {
    assert.strictEqual(cursorToolMatchKind('Delete', 'Delete File'), 'delete');
    assert.strictEqual(cursorToolMatchKind('delete', 'Edit File'), 'delete');
    assert.strictEqual(cursorToolMatchKind('', 'Delete e:/tmp/a.py'), 'delete');
    assert.strictEqual(formatCursorEnrichedTitle('delete', { path: '/tmp/x.ts' }), 'Delete /tmp/x.ts');
  });

  test('cursorSearchKindFallback tries alternate search queue', () => {
    assert.deepStrictEqual(cursorSearchKindFallback('grep'), ['grep', 'glob']);
    assert.deepStrictEqual(cursorSearchKindFallback('glob'), ['glob', 'grep']);
    assert.deepStrictEqual(cursorSearchKindFallback('read'), ['read']);
  });

  test('indexToolCallsFromBlobTextsOrdered preserves blob rowid order', () => {
    const blobA = JSON.stringify({
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call-a\\nfc_1',
          toolName: 'Grep',
          args: { pattern: 'alpha', path: '/a' },
        },
      ],
    });
    const blobB = JSON.stringify({
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call-b\\nfc_2',
          toolName: 'Read',
          args: { path: '/b.ts' },
        },
      ],
    });
    const ordered = indexToolCallsFromBlobTextsOrdered([blobA, blobB]);
    assert.strictEqual(ordered.length, 2);
    assert.ok(ordered[0].title.includes('alpha'));
    assert.ok(ordered[1].title.includes('/b.ts'));
  });

  test('formatCursorEnrichedTitle includes path/pattern', () => {
    assert.strictEqual(
      formatCursorEnrichedTitle('Read', { path: '/Users/me/pkg.json' }),
      'Read /Users/me/pkg.json',
    );
    assert.strictEqual(
      formatCursorEnrichedTitle('Grep', {
        path: '/Users/me/src',
        pattern: 'ChatWebviewProvider',
      }),
      'grep "ChatWebviewProvider" /Users/me/src',
    );
    assert.strictEqual(
      formatCursorEnrichedTitle('Glob', {
        glob_pattern: '**/diagnose-l1*',
        target_directory: '/Users/me',
      }),
      'Find "**/diagnose-l1*" in /Users/me',
    );
  });

  test('indexToolCallsFromBlobTexts extracts tool-call parts', () => {
    const blob = JSON.stringify({
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call-abc',
          toolName: 'Read',
          args: { path: '/tmp/x.ts', limit: 10 },
        },
        {
          type: 'tool-call',
          toolCallId: 'call-def',
          toolName: 'Grep',
          args: { path: '/tmp', pattern: 'foo' },
        },
      ],
    });
    const map = indexToolCallsFromBlobTexts([blob]);
    assert.strictEqual(map.size, 2);
    const read = map.get('call-abc');
    assert.ok(read);
    assert.strictEqual(read!.toolName, 'Read');
    assert.strictEqual(read!.title, 'Read /tmp/x.ts');
    assert.deepStrictEqual(read!.locations, [{ path: '/tmp/x.ts' }]);
    const grep = map.get('call-def');
    assert.strictEqual(grep!.title, 'grep "foo" /tmp');
  });

  test('formatCursorEnrichedTitle grep uses glob when path missing', () => {
    assert.strictEqual(
      formatCursorEnrichedTitle('Grep', {
        pattern: 'memory',
        glob: '**/*memory*',
      }),
      'grep "memory" **/*memory*',
    );
  });

  // Synthetic store fixture instead of the live ~/.cursor store: pinned live
  // ids drift (Cursor rewrites blobs), and this.skip() inside an async test
  // can only be reported as pending by mocha — which fails the suite.
  const makeCursorStoreFixture = (tmp: string, sid: string, blobs: Array<[id: string, payload: unknown]>) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (path: string) => {
        exec: (sql: string) => void;
        prepare: (sql: string) => {
          run: (...params: unknown[]) => void;
        };
        close: () => void;
      };
    };
    const dbDir = path.join(tmp, 'acp-sessions', sid);
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, 'store.db');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('CREATE TABLE blobs (id TEXT, data BLOB)');
      const insert = db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)');
      for (const [id, payload] of blobs) {
        insert.run(id, Buffer.from(JSON.stringify(payload), 'utf8'));
      }
    } finally {
      db.close();
    }
    return dbPath;
  };

  test('loadEnrichedToolCallsByPrefix finds Read/Grep args in a synthetic store', async function () {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-enrich-prefix-'));
    try {
      const sid = 'prefix-scan-sess';
      const readId = 'call-read-1\nfc_batch_0';
      const grepId = 'call-grep-2\nfc_batch_1';
      // One batch blob holds both parallel tool calls; a noise blob must not match.
      const dbPath = makeCursorStoreFixture(tmp, sid, [
        ['noise', { role: 'user', content: [{ type: 'text', text: 'unrelated' }] }],
        [
          'batch',
          {
            role: 'assistant',
            content: [
              { type: 'tool-call', toolCallId: readId, toolName: 'Read', args: { path: '/tmp/a.ts', limit: 10 } },
              { type: 'tool-call', toolCallId: grepId, toolName: 'Grep', args: { path: '/tmp', pattern: 'needle' } },
            ],
          },
        ],
      ]);
      assert.strictEqual(toolCallIdPrefix(grepId), 'call-grep-2');
      const map = await loadEnrichedToolCallsByPrefix(dbPath, grepId);
      const grep = lookupEnriched(map, grepId);
      assert.ok(grep, 'prefix LIKE query must find the Grep tool');
      assert.strictEqual(grep!.toolName, 'Grep');
      assert.strictEqual(grep!.title, 'grep "needle" /tmp');
      const read = lookupEnriched(map, readId);
      assert.ok(read, 'sibling Read in the same batch blob must be indexed too');
      assert.strictEqual(read!.toolName, 'Read');
      assert.strictEqual(read!.title, 'Read /tmp/a.ts');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('listEnrichedTools preserves blob rowid order (not suffix-only sort)', async function () {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-enrich-rowid-'));
    try {
      const sid = 'rowid-order-sess';
      // Greps are inserted with descending numeric suffixes (10, 9, 2) so a
      // suffix-only sort would reorder them against the rowid order (10, 9, 2).
      const blobs: Array<[id: string, payload: unknown]> = [];
      for (let i = 0; i < 7; i++) {
        blobs.push([`filler-${i}`, { role: 'assistant', content: [{ type: 'tool-call', toolCallId: `call-f-${i}\nfc_f_${i}`, toolName: 'Read', args: { path: `/tmp/f${i}.ts` } }] }]);
      }
      blobs.push(['g10', { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-g-10\nfc_g_0', toolName: 'Grep', args: { pattern: 'p1', path: '/s' } }] }]);
      blobs.push(['g9', { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-g-9\nfc_g_1', toolName: 'Grep', args: { pattern: 'p2', path: '/s' } }] }]);
      blobs.push(['g2', { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-g-2\nfc_g_2', toolName: 'Grep', args: { pattern: 'p3', path: '/s' } }] }]);
      for (let i = 0; i < 3; i++) {
        blobs.push([`tail-${i}`, { role: 'assistant', content: [{ type: 'tool-call', toolCallId: `call-t-${i}\nfc_t_${i}`, toolName: 'Glob', args: { glob_pattern: `**/t${i}*.ts` } }] }]);
      }
      const dbPath = makeCursorStoreFixture(tmp, sid, blobs);
      const enricher = new CursorSessionToolEnricher(sid, tmp);
      const tools = await enricher.listEnrichedTools();
      assert.ok(tools.length >= 10, 'expected many indexed tools');
      const greps = tools.filter((t) => t.toolName.toLowerCase() === 'grep');
      assert.ok(greps.length >= 2, 'expected multiple grep tools');
      const suffixSort = greps.slice().sort((a, b) => {
        const seq = (id: string) => {
          const pref = id.split(/\n/)[0];
          const m = pref.match(/-(\d+)$/);
          return m ? parseInt(m[1], 10) : 0;
        };
        return seq(a.toolCallId) - seq(b.toolCallId);
      });
      const rowidOrder = greps.map((g) => g.toolCallId.split('\n')[0]);
      const wrongOrder = suffixSort.map((g) => g.toolCallId.split('\n')[0]);
      assert.notDeepStrictEqual(
        rowidOrder.slice(0, 8),
        wrongOrder.slice(0, 8),
        'suffix-only sort must not match chronological rowid order',
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('findCursorSessionStorePath resolves acp-sessions layout', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-enrich-'));
    const sessionId = 'sess-test-123';
    const dbDir = path.join(tmp, 'acp-sessions', sessionId);
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, 'store.db');
    fs.writeFileSync(dbPath, '');
    try {
      assert.strictEqual(findCursorSessionStorePath(sessionId, tmp), dbPath);
      assert.strictEqual(findCursorSessionStorePath('missing', tmp), null);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('lookupEnriched prefers call- prefix over shared fc_ batch id', () => {
    const map = new Map();
    const fc = 'fc_shared-batch-id';
    map.set(`call-aaa-1\n${fc}_0`, {
      toolCallId: `call-aaa-1\n${fc}_0`,
      toolName: 'Read',
      args: { path: '/a.ts' },
      title: formatCursorEnrichedTitle('Read', { path: '/a.ts' }),
    });
    map.set(`call-aaa-2\n${fc}_1`, {
      toolCallId: `call-aaa-2\n${fc}_1`,
      toolName: 'Grep',
      args: { path: '/src', pattern: 'x' },
      title: formatCursorEnrichedTitle('Grep', { path: '/src', pattern: 'x' }),
    });
    const grep = lookupEnriched(map, `call-aaa-2\n${fc}_1`);
    assert.ok(grep);
    assert.strictEqual(grep!.toolName, 'Grep');
    assert.ok(grep!.title.includes('grep'));
    // Truncated fc without _N must not steal the sibling Read tool.
    const truncated = lookupEnriched(map, `call-aaa-2\n${fc}`);
    assert.ok(truncated);
    assert.strictEqual(truncated!.toolName, 'Grep');
  });

  test('formatCursorEnrichedTitle maps StrReplace to Edit path', () => {
    assert.strictEqual(
      formatCursorEnrichedTitle('StrReplace', { path: '/Users/me/a.ts' }),
      'Edit /Users/me/a.ts',
    );
  });

  test('enrich sticks to primary session store without thrashing', async function () {
    this.timeout(8000);
    const sid = 'a4879912-b370-4918-ac86-965e011333ff';
    const db = findCursorSessionStorePath(sid);
    if (!db || !fs.existsSync(db) || fs.statSync(db).size < 1000) {
      this.skip();
      return;
    }
    const enricher = new CursorSessionToolEnricher(sid);
    const toolCallId =
      'call-6b826533-813a-4920-9633-56609c3021a3-2\nfc_2f7aa6c7-00c3-90fe-be31-8d579d58b273_1';
    const t0 = Date.now();
    const hit = await enricher.enrich(toolCallId, { timeoutMs: 3000 });
    const ms = Date.now() - t0;
    assert.ok(hit, 'expected Grep enrich hit');
    assert.strictEqual(hit!.toolName, 'Grep');
    assert.ok(ms < 2500, `enrich too slow (${ms}ms) — likely rescanning huge stores`);
  });
});

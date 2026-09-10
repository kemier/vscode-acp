import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { decodeTemplate } from './templateDecode';

/**
 * The usage ring must survive a resume and a reload.
 *
 * It is fed ONLY by live `usage_update` frames, and handleLoadSessionStart blanks it
 * (correctly — a load may be a switch to a different session). But agents report
 * usage on a model round-trip and `session/load` never replays it, so after a resume
 * the ring stayed empty until the next LLM call. Measured on one ericli turn: prompt
 * sent 03:34:56, first usage_update 03:39:42 — five minutes of tool calls with no
 * ring, which reads as "the ring only appears after end_turn".
 *
 * Remembering the last value per session id makes a resume show it immediately, and
 * the next live frame corrects it.
 */

const SOURCE = path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts');

interface UsageFns {
  updateTokenUsage(u: { used: number; size: number; cost?: number }): void;
  restoreTokenUsageForSession(): void;
  state(): { tokenUsage: unknown; bySession: Record<string, unknown>; domCalls: number };
  setSession(id: string | null): void;
}

function loadUsageFns(): UsageFns {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const start = src.indexOf('  var _tokenUsageDebounce = null;');
  assert.ok(start > 0, 'usage block not found');
  const end = src.indexOf('// ── Goal chip rendering', start);
  assert.ok(end > start, 'end of usage block not found');
  const body = decodeTemplate(src.slice(start, end));
  const factory = new Function(
    `
    let sessionState = null;
    let tokenUsage = null;
    let domCalls = 0;
    const tokenUsageRing = { classList: { add() {}, remove() {} } };
    function updateTokenUsageDOM() { domCalls++; }
    ${body}
    return {
      updateTokenUsage: (u) => updateTokenUsage(u),
      restoreTokenUsageForSession: () => restoreTokenUsageForSession(),
      setSession: (id) => { sessionState = id ? { sessionId: id } : null; },
      state: () => ({ tokenUsage, bySession: tokenUsageBySession, domCalls }),
    };
  `,
  );
  return factory() as UsageFns;
}

suite('usage ring survives resume and reload', () => {
  test('a live update is remembered against its session', () => {
    const wv = loadUsageFns();
    wv.setSession('sess-a');
    wv.updateTokenUsage({ used: 35015, size: 262144 });
    assert.deepStrictEqual(wv.state().bySession['sess-a'], { used: 35015, size: 262144, cost: undefined });
  });

  test('a resume shows the remembered value without waiting for the next model call', () => {
    const wv = loadUsageFns();
    wv.setSession('sess-a');
    wv.updateTokenUsage({ used: 100, size: 262144 });
    // handleLoadSessionStart blanks the ring; simulate that, then finish the load.
    const before = wv.state().domCalls;
    wv.restoreTokenUsageForSession();
    assert.deepStrictEqual(wv.state().tokenUsage, { used: 100, size: 262144, cost: undefined });
    assert.ok(wv.state().domCalls > before, 'the DOM must be refreshed on restore');
  });

  test('a different session does not inherit another session ring', () => {
    const wv = loadUsageFns();
    wv.setSession('sess-a');
    wv.updateTokenUsage({ used: 100, size: 262144 });
    wv.setSession('sess-b');
    const before = wv.state().domCalls;
    wv.restoreTokenUsageForSession();
    assert.strictEqual(wv.state().domCalls, before, 'nothing remembered for sess-b — leave the ring blank');
  });

  test('a usage frame with no size is not worth restoring', () => {
    // size 0 is what updateTokenUsageDOM treats as "no real data"; restoring it
    // would flash a 0% ring.
    const wv = loadUsageFns();
    wv.setSession('sess-a');
    wv.updateTokenUsage({ used: 5, size: 0 });
    const before = wv.state().domCalls;
    wv.restoreTokenUsageForSession();
    assert.strictEqual(wv.state().domCalls, before);
  });

  test('the memory is bounded', () => {
    const wv = loadUsageFns();
    for (let i = 0; i < 40; i++) {
      wv.setSession('s' + i);
      wv.updateTokenUsage({ used: i, size: 262144 });
    }
    const keys = Object.keys(wv.state().bySession);
    assert.ok(keys.length <= 20, `bounded to 20, got ${keys.length}`);
    assert.ok(keys.includes('s39'), 'the newest session must be kept');
  });

  test('it is persisted and read back, and restored at load end', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    assert.ok(src.includes('tokenUsageBySession: tokenUsageBySession,'), 'must be written to vscode.setState');
    assert.ok(
      src.includes('tokenUsageBySession = saved.tokenUsageBySession;'),
      'must be read back in restoreState',
    );
    const call = src.indexOf('restoreTokenUsageForSession();\n    // Rebuild the entire messages DOM');
    assert.ok(call > 0, 'must run at load end, before the DOM rebuild');
  });
});

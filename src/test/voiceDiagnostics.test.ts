import * as assert from 'assert';
import * as vscode from 'vscode';

/**
 * Voice diagnostics is mostly vscode + network; this test only checks that the
 * module exports a builder and that a stubbed report still has the required
 * section headers the docs promise.
 */
suite('VoiceDiagnostics', () => {
  test('buildVoiceDiagnosticsReport exports and returns labeled lines', async () => {
    assert.ok(vscode.window);
    const prevFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = async () => {
      throw new Error('fetch stubbed in unit test');
    };
    try {
      const { buildVoiceDiagnosticsReport } = await import('../voice/VoiceDiagnostics');
      const report = await buildVoiceDiagnosticsReport();
      for (const key of [
        'enabled:',
        'remote:',
        'captureMode:',
        'effective capture:',
        'companion:',
        'stt.endpoint:',
        'stt.probe:',
        'corrector.enabled:',
      ]) {
        assert.ok(report.includes(key), `missing section: ${key}\n${report}`);
      }
      assert.ok(report.includes('FAIL'), `expected STT probe FAIL under stubbed fetch\n${report}`);
    } finally {
      (globalThis as any).fetch = prevFetch;
    }
  });
});

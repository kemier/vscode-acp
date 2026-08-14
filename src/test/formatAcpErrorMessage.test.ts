import * as assert from 'assert';
import { formatAcpErrorMessage } from '../utils/formatAcpErrorMessage';

suite('formatAcpErrorMessage', () => {
  test('prefers data.details over generic Internal error', () => {
    const err = Object.assign(new Error('Internal error'), {
      data: { details: 'pi compact failed: Nothing to compact (session too small)' },
    });
    assert.strictEqual(
      formatAcpErrorMessage(err),
      'Internal error: pi compact failed: Nothing to compact (session too small)',
    );
  });

  test('stringifies object data without details', () => {
    const err = Object.assign(new Error('Internal error'), {
      data: { code: 'x', reason: 'y' },
    });
    assert.strictEqual(formatAcpErrorMessage(err), 'Internal error: {"code":"x","reason":"y"}');
  });

  test('uses string data as-is', () => {
    const err = Object.assign(new Error('Failed'), { data: 'session gone' });
    assert.strictEqual(formatAcpErrorMessage(err), 'Failed: session gone');
  });

  test('falls back when message empty', () => {
    assert.strictEqual(formatAcpErrorMessage(null, 'Command failed'), 'Command failed');
    assert.strictEqual(formatAcpErrorMessage(new Error(''), 'Command failed'), 'Command failed');
  });
});

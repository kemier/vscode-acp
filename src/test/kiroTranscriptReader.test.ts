import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  kiroTranscriptCandidates,
  parseKiroTranscript,
  readKiroTranscript,
} from '../core/KiroTranscriptReader';

/**
 * Forking a session that a terminal `kiro-cli chat` owns used to be impossible:
 * kiro refuses session/load ("active in another process (PID n)"), so the panel had
 * nothing to export and the fork reported an empty session.
 *
 * The transcript is on disk the whole time — beside the metadata, which is what
 * made it look absent. sessions/cli/<id>.json holds only session_id / cwd / title /
 * session_state; the messages are in the sibling <id>.jsonl (or
 * sess_<id>/messages.jsonl for IDE sessions). Verified against a real file: 84
 * messages, 43 KB of conversation, from a session held by another process.
 */

const LINE = (kind: string, text: string) =>
  JSON.stringify({ version: 1, kind, data: { message_id: 'm', content: [{ kind: 'text', data: text }] } });

suite('kiro transcript reader', () => {
  test('parses user and assistant turns, skipping tool results', () => {
    const jsonl = [
      LINE('Prompt', 'check the logs'),
      LINE('AssistantMessage', 'Looking now.'),
      JSON.stringify({
        version: 1,
        kind: 'ToolResults',
        data: { content: [{ kind: 'toolResult', data: { toolUseId: 't1', content: [{ kind: 'text', data: 'x'.repeat(5000) }] } }] },
      }),
      LINE('Prompt', 'and the traffic log'),
    ].join('\n');
    const items = parseKiroTranscript(jsonl);
    assert.deepStrictEqual(
      items.map((i) => [i.role, i.text]),
      [
        ['user', 'check the logs'],
        ['assistant', 'Looking now.'],
        ['user', 'and the traffic log'],
      ],
    );
  });

  test('survives a half-written final line, which is normal on a live session', () => {
    const jsonl = LINE('Prompt', 'first') + '\n' + '{"version":1,"kind":"Assistant';
    const items = parseKiroTranscript(jsonl);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0]!.text, 'first');
  });

  test('ignores records with no text, and blank lines', () => {
    const jsonl = [
      '',
      JSON.stringify({ version: 1, kind: 'Prompt', data: { content: [] } }),
      JSON.stringify({ version: 1, kind: 'AssistantMessage', data: {} }),
      LINE('Prompt', 'real'),
      '   ',
    ].join('\n');
    assert.deepStrictEqual(parseKiroTranscript(jsonl).map((i) => i.text), ['real']);
  });

  test('looks in the CLI location first, then the IDE hash directories', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-home-'));
    fs.mkdirSync(path.join(home, 'sessions', 'cli'), { recursive: true });
    fs.mkdirSync(path.join(home, 'sessions', 'abc123hash'), { recursive: true });
    const candidates = kiroTranscriptCandidates('sess_11111111-2222-3333-4444-555555555555', home);
    // The sess_ prefix must be stripped for the CLI path but kept for the IDE dir.
    assert.ok(candidates[0]!.endsWith(path.join('cli', '11111111-2222-3333-4444-555555555555.jsonl')));
    assert.ok(
      candidates.some((c) =>
        c.endsWith(path.join('abc123hash', 'sess_11111111-2222-3333-4444-555555555555', 'messages.jsonl')),
      ),
    );
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('reads a real file end to end and returns [] for an unknown session', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-home-'));
    const cli = path.join(home, 'sessions', 'cli');
    fs.mkdirSync(cli, { recursive: true });
    fs.writeFileSync(path.join(cli, 'sid.jsonl'), LINE('Prompt', 'hello') + '\n' + LINE('AssistantMessage', 'hi'));
    const items = readKiroTranscript('sid', home);
    assert.deepStrictEqual(items.map((i) => i.role), ['user', 'assistant']);
    // Must never throw for a session with no transcript.
    assert.deepStrictEqual(readKiroTranscript('missing', home), []);
    assert.deepStrictEqual(readKiroTranscript('', home), []);
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('the fork falls back to the transcript before reporting failure', () => {
    const ext = fs.readFileSync(path.resolve(__dirname, '../../src/extension.ts'), 'utf8');
    assert.ok(ext.includes('readKiroTranscript(sessionId)'));
    assert.ok(ext.includes("/kiro/i.test(sourceAgentName)"), 'only kiro stores this layout');
    // The fallback must run BEFORE the "nothing to fork" message.
    const fallback = ext.indexOf('readKiroTranscript(sessionId)');
    const failure = ext.indexOf('No conversation to fork');
    assert.ok(fallback > 0 && fallback < failure);
  });
});

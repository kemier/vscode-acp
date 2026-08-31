#!/usr/bin/env node
/**
 * Sandboxed ACP session/load replay probe.
 *
 * Spawns `ericli acp` with ERICLI_BASE_DIR pointed at a throw-away copy of the
 * user's session store, sends initialize + session/load, and prints the ORDER
 * of every session/update notification the agent emits during the replay.
 *
 * Purpose: the vscode-acp traffic log deliberately drops agent_message_chunk
 * (Logger.ts ~L181), so the true interleaving of tool_call vs assistant text
 * during replay is invisible there. This probe restores that visibility.
 */
import { spawn } from 'node:child_process';

const SESSION_ID = process.argv[2] || 'd751102e';
const CWD = process.argv[3] || '/workspace/git/ezennin/vscode-acp';
const BASE_DIR = process.env.PROBE_BASE_DIR || '/tmp/acp-probe-base';
const BIN = process.env.ERICLI_BIN || '/workspace/git/ezennin/.local/bin/ericli';

const child = spawn(BIN, ['acp'], {
  env: { ...process.env, ERICLI_BASE_DIR: BASE_DIR },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
const seq = [];
let nextId = 1;

function send(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return id;
}
function respond(id, result) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

child.stderr.on('data', (d) => {
  const s = String(d);
  if (/error|Error|ENOENT|not found/.test(s)) process.stderr.write('[agent stderr] ' + s);
});

child.stdout.on('data', (d) => {
  buf += String(d);
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});

let loadId = null;

function handle(msg) {
  if (msg.method === 'session/update') {
    const u = msg.params?.update || {};
    const kind = u.sessionUpdate;
    let tag = '?';
    if (kind === 'user_message_chunk') tag = 'U';
    else if (kind === 'agent_message_chunk') tag = 'A';
    else if (kind === 'agent_thought_chunk') tag = 'R';
    else if (kind === 'tool_call') tag = 'T';
    else if (kind === 'tool_call_update') tag = 't';
    else return; // available_commands_update etc.
    const preview = (u.content?.text || u.title || '').replace(/\s+/g, ' ').slice(0, 55);
    seq.push({ tag, kind, messageId: u.messageId || '', preview });
    return;
  }
  // Client-side requests the agent may make during load (permissions etc.)
  if (msg.method && msg.id !== undefined) {
    respond(msg.id, {});
    return;
  }
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    if (msg.id === 1) {
      loadId = send('session/load', { sessionId: SESSION_ID, cwd: CWD, mcpServers: [] });
    } else if (msg.id === loadId) {
      report();
    }
  }
}

function report() {
  console.log(`\n=== replay notification order (${seq.length} items) ===`);
  // Turn-split on user messages
  let turn = -1;
  let line = '';
  const turns = [];
  for (const s of seq) {
    if (s.tag === 'U') {
      if (line) turns.push(line);
      line = 'U';
      turn++;
    } else {
      line += s.tag;
    }
  }
  if (line) turns.push(line);
  turns.forEach((t, i) => console.log(`turn${String(i).padStart(2, '0')} ${t}`));
  const target = seq.findIndex((s) => s.preview.startsWith('check ericli acp log why after resume'));
  if (target >= 0) {
    console.log('\n=== detail for the screenshot turn ===');
    for (let i = target; i < Math.min(seq.length, target + 20); i++) {
      const s = seq[i];
      if (i > target && s.tag === 'U') break;
      console.log(`  ${String(i).padStart(3)} ${s.tag} ${s.kind.padEnd(20)} id=${s.messageId.padEnd(10)} ${JSON.stringify(s.preview)}`);
    }
  }
  child.kill('SIGTERM');
  process.exit(0);
}

send('initialize', {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
});

setTimeout(() => {
  console.error('timeout — no session/load response');
  if (seq.length) report();
  child.kill('SIGKILL');
  process.exit(1);
}, 60000);

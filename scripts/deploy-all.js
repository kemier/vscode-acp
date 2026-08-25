#!/usr/bin/env node
/**
 * Cross-platform lean deploy: webpack build → VSIX → local install.
 * No WSL/bash required (Windows / macOS / Linux).
 *
 * Usage:  node scripts/deploy-all.js
 *         npm run deploy
 */
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');

function run(cmd, args) {
  // Prefer npm.cmd / npx.cmd on Windows so we can avoid shell:true (DEP0190).
  let exe = cmd;
  if (process.platform === 'win32' && (cmd === 'npm' || cmd === 'npx')) {
    exe = `${cmd}.cmd`;
  }
  console.log(`\n> ${exe} ${args.join(' ')}`);
  const r = spawnSync(exe, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: false,
    env: process.env,
  });
  if (r.status !== 0) {
    console.error(`❌ Command failed (${r.status}): ${exe} ${args.join(' ')}`);
    process.exit(r.status || 1);
  }
}

function step(title) {
  console.log(`\n━━━ ${title} ━━━`);
}

step('1/3  Building (webpack production)');
run('npm', ['run', 'package']);
console.log('✅ Build succeeded');

step('2/3  Packaging VSIX');
run('npx', ['vsce', 'package', '--no-git-tag-version']);
console.log('✅ VSIX packaged');

step('3/3  Installing locally');
run(process.execPath, [path.join(__dirname, 'install-local.js')]);
console.log('✅ Local install finished');

console.log(`
╔══════════════════════════════════════════════════════╗
║  🚀 Deploy completed                                 ║
║  Reload: Ctrl+Shift+P / ⌘⇧P → Reload Window          ║
╚══════════════════════════════════════════════════════╝
`);

#!/usr/bin/env node
/**
 * Cross-platform lean deploy: webpack build → VSIX → local install.
 * No WSL/bash required (Windows / macOS / Linux).
 *
 * Usage:  node scripts/deploy-all.js
 *         npm run deploy
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');

/**
 * On Windows, spawnSync('npm.cmd', …, { shell: false }) fails with EINVAL.
 * Prefer running npm/npx CLI via node.exe (no shell needed).
 */
function resolveNpmLike(cmd, args) {
  if (cmd !== 'npm' && cmd !== 'npx') {
    return { exe: cmd, args };
  }
  if (process.platform !== 'win32') {
    return { exe: cmd, args };
  }
  const cli = path.join(
    path.dirname(process.execPath),
    'node_modules',
    'npm',
    'bin',
    cmd === 'npm' ? 'npm-cli.js' : 'npx-cli.js',
  );
  if (fs.existsSync(cli)) {
    return { exe: process.execPath, args: [cli, ...args] };
  }
  // Fallback: cmd.exe /c "npm …" without shell:true on spawnSync.
  const quoted = [cmd, ...args]
    .map((a) => (/\s/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : a))
    .join(' ');
  return {
    exe: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', quoted],
  };
}

function run(cmd, args) {
  const { exe, args: finalArgs } = resolveNpmLike(cmd, args);
  const label = exe === process.execPath ? 'node' : exe;
  console.log(`\n> ${label} ${finalArgs.join(' ')}`);
  const r = spawnSync(exe, finalArgs, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: false,
    env: process.env,
  });
  if (r.error) {
    console.error(`❌ Spawn error: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`❌ Command failed (${r.status}): ${cmd} ${args.join(' ')}`);
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
run('npx', ['vsce', 'package', '--no-git-tag-version', '--no-dependencies']);
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

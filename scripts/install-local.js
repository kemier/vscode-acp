#!/usr/bin/env node
/**
 * Cross-platform VSIX install into local editor extension dirs.
 * Works on Windows / macOS / Linux without WSL or bash.
 *
 * Env:
 *   ACP_INSTALL_TARGETS  space-separated absolute extension roots
 *                        (default: ~/.vscode-server/extensions plus
 *                        ~/.vscode/extensions and ~/.cursor/extensions)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { randomUUID } = require('crypto');

const repoRoot = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const extId = `${pkg.publisher}.${pkg.name}`;
const rel = `${extId}-${pkg.version}`;
const vsix = path.join(repoRoot, `${pkg.name}-${pkg.version}.vsix`);

function die(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

function defaultTargets() {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.vscode-server', 'extensions'),
    path.join(home, '.vscode', 'extensions'),
    path.join(home, '.cursor', 'extensions'),
  ];
  // Always include vscode-server (create if missing). Include desktop
  // Cursor/VS Code dirs when they already exist, or always on Windows
  // so a local desktop install works after first deploy.
  const out = [candidates[0]];
  for (const p of candidates.slice(1)) {
    if (process.platform === 'win32' || fs.existsSync(p)) out.push(p);
  }
  return out;
}

function resolveTargets() {
  // Match AGENTS.md / legacy bash: ACP_INSTALL_TARGETS
  const raw = (process.env.ACP_INSTALL_TARGETS || '').trim();
  if (raw) return raw.split(/\s+/).filter(Boolean);
  return defaultTargets();
}

function extractVsix(vsixPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (process.platform === 'win32') {
    const zipPath = path.join(destDir, 'pkg.zip');
    fs.copyFileSync(vsixPath, zipPath);
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
      ],
      { stdio: 'inherit' },
    );
    return;
  }
  execFileSync('unzip', ['-q', '-o', vsixPath, '-d', destDir], { stdio: 'inherit' });
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (ent.isDirectory()) copyDirRecursive(from, to);
    else fs.copyFileSync(from, to);
  }
}

function registerExtension(extRoot) {
  const ejPath = path.join(extRoot, 'extensions.json');
  let entries = [];
  if (fs.existsSync(ejPath)) {
    try {
      entries = JSON.parse(fs.readFileSync(ejPath, 'utf8'));
      if (!Array.isArray(entries)) entries = [];
    } catch {
      entries = [];
    }
  }
  // VS Code rejects the entire manifest if any location lacks scheme
  // (isUriComponents requires path + scheme). A single bad sidecar
  // entry (e.g. companion install) then unloads every user extension.
  for (const e of entries) {
    const loc = e && e.location;
    if (loc && typeof loc === 'object' && typeof loc.path === 'string' && !loc.scheme) {
      loc.scheme = 'file';
    }
  }
  entries = entries.filter((e) => e?.identifier?.id !== extId);
  const absPath = path.join(extRoot, rel);
  const fileUrl = pathToFileUrl(absPath);
  const extUuid = randomUUID();
  entries.push({
    identifier: { id: extId, uuid: extUuid },
    version: pkg.version,
    location: {
      $mid: 1,
      fsPath: absPath,
      external: fileUrl,
      path: absPath,
      scheme: 'file',
    },
    relativeLocation: rel,
    metadata: {
      installedTimestamp: Date.now(),
      pinned: false,
      source: 'vsix',
    },
  });
  fs.writeFileSync(ejPath, JSON.stringify(entries), 'utf8');
  console.log(`   Registered ${extId}@${pkg.version} in ${ejPath}`);
}

function pathToFileUrl(p) {
  const resolved = path.resolve(p);
  if (process.platform === 'win32') {
    const normalized = resolved.replace(/\\/g, '/');
    return `file:///${normalized}`;
  }
  return `file://${resolved}`;
}

function main() {
  if (!fs.existsSync(vsix)) {
    die(`VSIX not found: ${vsix}\n   Run 'npm run package && npx vsce package' first.`);
  }

  const targets = resolveTargets();
  console.log(`📦 Installing ${extId} v${pkg.version}...`);
  console.log(`   VSIX: ${vsix}`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-vsix-'));
  try {
    extractVsix(vsix, tmpDir);
    const extensionSrc = path.join(tmpDir, 'extension');
    if (!fs.existsSync(extensionSrc)) {
      die(`VSIX extract missing 'extension/' folder under ${tmpDir}`);
    }

    for (const extRoot of targets) {
      const extDir = path.join(extRoot, rel);
      console.log(`   Target: ${extDir}`);
      fs.mkdirSync(extRoot, { recursive: true });
      fs.rmSync(extDir, { recursive: true, force: true });
      copyDirRecursive(extensionSrc, extDir);
      registerExtension(extRoot);
      const js = path.join(extDir, 'dist', 'extension.js');
      const size = fs.existsSync(js) ? fs.statSync(js).size : 0;
      console.log(`✅ Installed to ${extDir} (extension.js ${size} bytes)`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('');
  console.log("✅ Done! Reload the editor (Ctrl+Shift+P / ⌘⇧P → 'Reload Window').");
}

main();

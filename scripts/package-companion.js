#!/usr/bin/env node
/**
 * Build + package the client-side voice companion extension.
 *
 * The companion (`companion/acp-local-capture`) declares extensionKind "ui", so it
 * must be installed on the machine that owns the microphone — i.e. the VS Code
 * client, not the remote server. This script only produces the VSIX; installing
 * it is a user action in the remote window (Extensions view → … → Install from
 * VSIX…), because VS Code routes UI-kind VSIX installs to the local extension
 * management server automatically.
 *
 * Usage: npm run package:companion
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const companionDir = path.join(repoRoot, 'companion', 'acp-local-capture');

function run(cmd, args, cwd) {
  console.log(`\n> ${cmd} ${args.join(' ')}   (cwd: ${path.relative(repoRoot, cwd) || '.'})`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.error) {
    console.error(`❌ ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    process.exit(r.status || 1);
  }
}

function rmrf(p) {
  if (fs.existsSync(p)) {
    fs.rmSync(p, { recursive: true, force: true });
  }
}

// 1. Compile the companion with tsc. Its tsconfig has rootDir "../.." so it can
//    reach the shared src/voice/*.ts, which makes tsc emit a nested tree:
//      dist/companion/acp-local-capture/src/extension.js
//      dist/src/voice/{AudioRecorder,MciRecorder,VoiceRecorder}.js
//    The companion's package.json main is "./dist/extension.js", so we flatten
//    the output afterwards.
rmrf(path.join(companionDir, 'dist'));
run('npx', ['tsc', '-p', 'tsconfig.json'], companionDir);

// 2. Flatten the tsc output to the layout the companion's package.json expects.
const nestedExt = path.join(companionDir, 'dist', 'companion', 'acp-local-capture', 'src', 'extension.js');
const flatExt = path.join(companionDir, 'dist', 'extension.js');
if (!fs.existsSync(nestedExt)) {
  console.error(`❌ companion entry missing: ${nestedExt}`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(flatExt), { recursive: true });
fs.copyFileSync(nestedExt, flatExt);

// Move the shared deps from dist/src/{voice,vision,utils}/*.js to
// dist/{voice,vision,utils}/*.js and drop the leftover nested scaffolding.
for (const dir of ['voice', 'vision', 'utils']) {
  const nested = path.join(companionDir, 'dist', 'src', dir);
  const flat = path.join(companionDir, 'dist', dir);
  if (fs.existsSync(nested)) {
    fs.mkdirSync(flat, { recursive: true });
    for (const f of fs.readdirSync(nested)) {
      fs.copyFileSync(path.join(nested, f), path.join(flat, f));
    }
  }
}
rmrf(path.join(companionDir, 'dist', 'companion'));
rmrf(path.join(companionDir, 'dist', 'src'));

// tsc emitted requires relative to companion/acp-local-capture/src/extension.ts:
//   require("../../../src/voice/AudioRecorder")
//   require("../../../src/vision/WindowRecorder")
// After flattening to dist/extension.js + dist/{voice,vision,utils}/*.js those
// paths no longer exist inside the VSIX — rewrite them or activate() fails
// with MODULE_NOT_FOUND and the companion appears to do nothing. The same
// rewrite applies inside the flattened shared modules themselves (e.g.
// WindowRecorder requires ../utils/Logger, which tsc emitted as
// ../../utils/Logger relative to dist/src/vision/).
{
  const rewrite = (file) => {
    let src = fs.readFileSync(file, 'utf8');
    const before = src;
    src = src.replace(
      /require\(["'](?:\.\.\/)+src\/(voice|vision|utils)\/([^"']+)["']\)/g,
      (_m, dir, mod) => `require("./${dir}/${mod}")`,
    );
    // Cross-module requires inside a flattened dir module (e.g. WindowRecorder's
    // ../utils/Logger) keep working after the move: dist/src/<dir>/x.js →
    // dist/<dir>/x.js leaves ../<other>/ resolving to dist/<other>/ either way.
    if (src !== before) {
      fs.writeFileSync(file, src);
    }
    return src;
  };
  const entry = rewrite(flatExt);
  if (/require\(["'](?:\.\.\/)+src\//.test(entry)) {
    console.error('❌ companion entry still has broken src/* requires after rewrite');
    process.exit(1);
  }
  for (const dir of ['voice', 'vision', 'utils']) {
    const flat = path.join(companionDir, 'dist', dir);
    if (!fs.existsSync(flat)) continue;
    for (const f of fs.readdirSync(flat)) {
      if (!f.endsWith('.js')) continue;
      const out = rewrite(path.join(flat, f));
      if (/require\(["'](?:\.\.\/)+(?:\.\.\/)+/.test(out)) {
        console.error(`❌ ${dir}/${f} still has a broken ../.. require after rewrite`);
        process.exit(1);
      }
    }
  }
  console.log('✅ rewrote companion requires → ./{voice,vision,utils}/*');
}

const bundle = flatExt;
console.log(`✅ companion bundle: ${(fs.statSync(bundle).size / 1024).toFixed(1)} KB`);

// 3. Package the VSIX.
// --no-dependencies: the companion has no runtime deps and no node_modules of
// its own; vsce would otherwise try to resolve a dependency tree that is
// deliberately absent.
run('npx', ['vsce', 'package', '--no-dependencies', '--no-git-tag-version'], companionDir);

const vsix = fs
  .readdirSync(companionDir)
  .filter((f) => f.endsWith('.vsix'))
  .map((f) => path.join(companionDir, f))
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];

console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║  🎙  Companion packaged                                              ║
╚══════════════════════════════════════════════════════════════════════╝
  ${vsix}

  Install it from THIS (remote) window:
    Extensions view → ... → "Install from VSIX..." → pick the file above
  VS Code installs extensionKind "ui" extensions on your local machine.
  Then: Reload Window, and run "ACP Local Capture: Test Local Microphone" to verify.
`);
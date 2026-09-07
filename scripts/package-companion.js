#!/usr/bin/env node
/**
 * Build + package the client-side voice companion extension.
 *
 * The companion (`companion/acp-voice-local`) declares extensionKind "ui", so it
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
const companionDir = path.join(repoRoot, 'companion', 'acp-voice-local');

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
//      dist/companion/acp-voice-local/src/extension.js
//      dist/src/voice/{AudioRecorder,MciRecorder,VoiceRecorder}.js
//    The companion's package.json main is "./dist/extension.js", so we flatten
//    the output afterwards.
rmrf(path.join(companionDir, 'dist'));
run('npx', ['tsc', '-p', 'tsconfig.json'], companionDir);

// 2. Flatten the tsc output to the layout the companion's package.json expects.
const nestedExt = path.join(companionDir, 'dist', 'companion', 'acp-voice-local', 'src', 'extension.js');
const flatExt = path.join(companionDir, 'dist', 'extension.js');
if (!fs.existsSync(nestedExt)) {
  console.error(`❌ companion entry missing: ${nestedExt}`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(flatExt), { recursive: true });
fs.copyFileSync(nestedExt, flatExt);

// Move the shared voice deps from dist/src/voice/*.js to dist/voice/*.js and
// drop the leftover nested scaffolding.
const nestedSrc = path.join(companionDir, 'dist', 'src', 'voice');
const flatVoice = path.join(companionDir, 'dist', 'voice');
if (fs.existsSync(nestedSrc)) {
  fs.mkdirSync(flatVoice, { recursive: true });
  for (const f of fs.readdirSync(nestedSrc)) {
    fs.copyFileSync(path.join(nestedSrc, f), path.join(flatVoice, f));
  }
}
rmrf(path.join(companionDir, 'dist', 'companion'));
rmrf(path.join(companionDir, 'dist', 'src'));

// tsc emitted requires relative to companion/acp-voice-local/src/extension.ts:
//   require("../../../src/voice/AudioRecorder")
// After flattening to dist/extension.js + dist/voice/*.js those paths no longer
// exist inside the VSIX — rewrite them or activate() fails with MODULE_NOT_FOUND
// and "ACP Voice: Test Local Microphone" appears to do nothing.
{
  let src = fs.readFileSync(flatExt, 'utf8');
  const before = src;
  src = src.replace(
    /require\(["'](?:\.\.\/)+src\/voice\/([^"']+)["']\)/g,
    (_m, mod) => `require("./voice/${mod}")`,
  );
  if (src === before) {
    console.error('❌ expected ../../../src/voice/* requires in companion entry — rewrite skipped');
    process.exit(1);
  }
  fs.writeFileSync(flatExt, src);
  if (/require\(["'](?:\.\.\/)+src\/voice\//.test(src)) {
    console.error('❌ companion entry still has broken src/voice requires after rewrite');
    process.exit(1);
  }
  console.log('✅ rewrote companion requires → ./voice/*');
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
  Then: Reload Window, and run "ACP Voice: Test Local Microphone" to verify.
`);
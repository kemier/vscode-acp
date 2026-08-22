#!/usr/bin/env bash
set -euo pipefail

# ╔══════════════════════════════════════════════════════════════════╗
# ║  All-in-one: build → package VSIX → install to ~/.vscode-server  ║
# ╚══════════════════════════════════════════════════════════════════╝
# Deploys what is committed; it does NOT reformat sources. (Run
# `npx prettier --write "src/**/*.ts"` yourself if you want to reformat —
# auto-formatting here churns CRLF/LF + style across the whole tree and
# dirties the working copy after every deploy.)
#
# This is a lean deploy: it builds, packages, and installs the VSIX into
# THIS server's ~/.vscode-server/extensions only. It deliberately does NOT:
#   - run a separate tsc --noEmit (the webpack build type-checks via ts-loader)
#   - run the unit-test / lint gates (kept out of the hot deploy path; run
#     `npm run test:unit` / `npm run lint` yourself when you want them)
#   - deploy to remote SSH (override with ACP_INSTALL_TARGETS for desktop)
#
# Usage:  ./scripts/deploy-all.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
cd "$REPO_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

step() { echo -e "\n${BLUE}━━━ $1 ━━━${NC}"; }
ok()   { echo -e "${GREEN}✅ $1${NC}"; }
fail() { echo -e "${RED}❌ $1${NC}"; exit 1; }

# ─── 1. Build (webpack production; type-checks via ts-loader) ──────
step "1/3  Building (webpack production)"
npm run package || fail "Build failed"
ok "Build succeeded"

# ─── 2. Package VSIX ───────────────────────────────────────────────
step "2/3  Packaging VSIX"
npx vsce package --no-git-tag-version || fail "VSIX packaging failed"
ok "VSIX packaged"

# ─── 3. Install into THIS server's vscode-server ───────────────────
step "3/3  Installing to ~/.vscode-server/extensions"
# Pin the target so this always deploys to this server's vscode-server,
# regardless of any ACP_INSTALL_TARGETS set in the environment.
ACP_INSTALL_TARGETS="$HOME/.vscode-server/extensions" \
  bash "$SCRIPT_DIR/install-vscode-server.sh" || fail "Local deploy failed"
ok "Local vscode-server installed"

# ─── Summary ───────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  🚀 All steps completed successfully!                ║${NC}"
echo -e "${GREEN}║  Reload: Ctrl+Shift+P → 'Reload Window'              ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════╝${NC}"
#!/usr/bin/env bash
set -euo pipefail

# ╔══════════════════════════════════════════════════════════════════╗
# ║  All-in-one: typecheck → test → lint → build → pkg → install    ║
# ╚══════════════════════════════════════════════════════════════════╝
# Deploys what is committed; it does NOT reformat sources. (Run
# `npx prettier --write "src/**/*.ts"` yourself if you want to reformat —
# auto-formatting here churns CRLF/LF + style across the whole tree and
# dirties the working copy after every deploy.)
# Usage:  ./scripts/deploy-all.sh
#         ./scripts/deploy-all.sh --skip-tests   # skip test step
#         ./scripts/deploy-all.sh --skip-lint    # skip lint step
# Installs the packaged VSIX into local ~/.vscode-server/extensions only
# (no remote SSH deploy).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
cd "$REPO_DIR"

SKIP_TESTS=false
SKIP_LINT=false
for arg in "$@"; do
  case "$arg" in
    --skip-tests) SKIP_TESTS=true ;;
    --skip-lint)  SKIP_LINT=true ;;
  esac
done

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

step() { echo -e "\n${BLUE}━━━ $1 ━━━${NC}"; }
ok()   { echo -e "${GREEN}✅ $1${NC}"; }
fail() { echo -e "${RED}❌ $1${NC}"; exit 1; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }

# ─── 1. Type Check (tsc --noEmit) ──────────────────────────────────
step "1/7  Type checking (tsc --noEmit)"
npx tsc --noEmit -p tsconfig.json || fail "Type check failed"
ok "Type check passed"

# ─── 2. Compile & Run Tests ────────────────────────────────────────
if [ "$SKIP_TESTS" = false ]; then
  step "2/7  Running tests"
  # Compile test TypeScript to out/
  npx tsc -p . --outDir out || fail "Test compilation failed"
  # Run ALL standalone tests with mocha (no VS Code dependency needed).
  # The file list lives in the npm `test:unit` target so it stays in one place.
  npm run test:unit || fail "Tests failed"
  ok "All tests passed"
else
  warn "Skipping tests (--skip-tests)"
fi

# ─── 3. Lint ───────────────────────────────────────────────────────
if [ "$SKIP_LINT" = false ]; then
  step "3/7  Linting (eslint)"
  npm run lint || fail "Lint failed"
  ok "Lint passed"
else
  warn "Skipping lint (--skip-lint)"
fi

# ─── 4. Build (webpack production) ─────────────────────────────────
step "4/7  Building (webpack production)"
npm run package || fail "Build failed"
ok "Build succeeded"

# ─── 5. Package VSIX ───────────────────────────────────────────────
step "5/7  Packaging VSIX"
npx vsce package --no-git-tag-version || fail "VSIX packaging failed"
ok "VSIX packaged"

# ─── 6. Install into local vscode-server ──────────────────────────
step "6/7  Installing to local vscode-server (~/.vscode-server/extensions)"
bash "$SCRIPT_DIR/install-vscode-server.sh" || fail "Local deploy failed"
ok "Local vscode-server installed"

# ─── Summary ───────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  🚀 All steps completed successfully!                ║${NC}"
echo -e "${GREEN}║  Reload each editor: Ctrl+Shift+P → 'Reload Window'  ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════╝${NC}"

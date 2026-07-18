#!/usr/bin/env bash
set -euo pipefail

# ╔══════════════════════════════════════════════════════════════════╗
# ║  All-in-one: format → typecheck → test → lint → build → pkg → local ║
# ╚══════════════════════════════════════════════════════════════════╝
# Usage:  ./scripts/deploy-all.sh
#         ./scripts/deploy-all.sh --skip-tests   # skip test step
#         ./scripts/deploy-all.sh --skip-lint    # skip lint step
#         ./scripts/deploy-all.sh --skip-format  # skip format step

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
cd "$REPO_DIR"

SKIP_TESTS=false
SKIP_LINT=false
SKIP_FORMAT=false
for arg in "$@"; do
  case "$arg" in
    --skip-tests) SKIP_TESTS=true ;;
    --skip-lint)  SKIP_LINT=true ;;
    --skip-format) SKIP_FORMAT=true ;;
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

# ─── 1. Format (prettier) ──────────────────────────────────────────
if [ "$SKIP_FORMAT" = false ]; then
  step "1/7  Formatting code (prettier)"
  npx prettier --write "src/**/*.ts" || fail "Format failed"
  ok "Code formatted"
else
  warn "Skipping format (--skip-format)"
fi

# ─── 1. Type Check (tsc --noEmit) ──────────────────────────────────
step "2/7  Type checking (tsc --noEmit)"
npx tsc --noEmit -p tsconfig.json || fail "Type check failed"
ok "Type check passed"

# ─── 2. Compile & Run Tests ────────────────────────────────────────
if [ "$SKIP_TESTS" = false ]; then
  step "3/7  Running tests"
  # Compile test TypeScript to out/
  npx tsc -p . --outDir out || fail "Test compilation failed"
  # Run standalone tests with mocha (no VS Code dependency needed)
  npx mocha --ui tdd 'out/test/cleanUserMessage.test.js' 'out/test/followAgent.test.js' 'out/test/linkifier.test.js' 'out/test/streamCoalescer.test.js' || fail "Tests failed"
  ok "All tests passed"
else
  warn "Skipping tests (--skip-tests)"
fi

# ─── 3. Lint ───────────────────────────────────────────────────────
if [ "$SKIP_LINT" = false ]; then
  step "4/7  Linting (eslint)"
  npm run lint || fail "Lint failed"
  ok "Lint passed"
else
  warn "Skipping lint (--skip-lint)"
fi

# ─── 4. Build (webpack production) ─────────────────────────────────
step "5/7  Building (webpack production)"
npm run package || fail "Build failed"
ok "Build succeeded"

# ─── 5. Package VSIX ───────────────────────────────────────────────
step "6/7  Packaging VSIX"
npx vsce package --no-git-tag-version || fail "VSIX packaging failed"
ok "VSIX packaged"

# ─── 7. Install into local VS Code ─────────────────────────────────
step "7/7  Installing to local VS Code (~/.vscode/extensions)"
bash "$SCRIPT_DIR/install-vscode-server.sh" || fail "Deploy failed"
ok "Deployed successfully"

# ─── Summary ───────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  🚀 All steps completed successfully!                ║${NC}"
echo -e "${GREEN}║  Reload VS Code: Ctrl+Shift+P → 'Reload Window'      ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════╝${NC}"

#!/usr/bin/env bash
set -euo pipefail

# Build codex-acp (Rust) and install the native binary to ~/.local/bin
# Usage: ./scripts/install-codex-acp.sh
#
# This script:
#   1. Builds codex-acp from ../codex-acp (Rust → target/release/codex-acp)
#   2. Installs the native binary to ~/.local/bin/codex-acp
#
# The vscode-acp extension resolves `codex-acp` from PATH, so ~/.local/bin
# must be on PATH (it is by default on this machine).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
CODEX_ACP_DIR="$REPO_DIR/../codex-acp"
LOCAL_BIN="${LOCAL_BIN:-$HOME/.local/bin}"

if [[ ! -d "$CODEX_ACP_DIR" ]]; then
  echo "❌ codex-acp repo not found at: $CODEX_ACP_DIR"
  echo "   Expected ../codex-acp relative to vscode-acp repo."
  exit 1
fi

echo "📦 Building codex-acp (Rust) from $CODEX_ACP_DIR..."
cd "$CODEX_ACP_DIR"
cargo build --release || { echo "❌ cargo build failed"; exit 1; }

BUILT="$CODEX_ACP_DIR/target/release/codex-acp"
if [[ ! -f "$BUILT" ]]; then
  echo "❌ Build output not found: $BUILT"
  exit 1
fi

VERSION=$(cargo pkgid 2>/dev/null | cut -d'#' -f2 | cut -d: -f2 || grep -m1 '^version' Cargo.toml | sed 's/.*"\(.*\)".*/\1/')
echo "   Built version: $VERSION"
echo "   Output: $BUILT"

# Install to LOCAL_BIN
mkdir -p "$LOCAL_BIN"
TARGET="$LOCAL_BIN/codex-acp"

cp "$BUILT" "$TARGET"
chmod +x "$TARGET"

echo "✅ Installed codex-acp v$VERSION to $TARGET"
echo ""
echo "   Verify: $(which codex-acp 2>/dev/null || echo 'codex-acp not on PATH')"
echo "   Version: $("$TARGET" --version 2>&1 | head -1)"
echo ""
echo "✅ Done! Reload VS Code to use the new codex-acp."

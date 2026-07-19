#!/usr/bin/env bash
set -euo pipefail

# Install the built VSIX into local editor extension dirs.
# Defaults: ~/.vscode/extensions and ~/.cursor/extensions (when present).
# Usage: ./scripts/install-vscode-server.sh
#        ACP_INSTALL_TARGETS="$HOME/.cursor/extensions" ./scripts/install-vscode-server.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

VERSION=$(node -p "require('$REPO_DIR/package.json').version")
PUBLISHER=$(node -p "require('$REPO_DIR/package.json').publisher")
NAME=$(node -p "require('$REPO_DIR/package.json').name")

VSIX="$REPO_DIR/$NAME-$VERSION.vsix"

if [[ ! -f "$VSIX" ]]; then
  echo "❌ VSIX not found: $VSIX"
  echo "   Run 'npm run package && npx vsce package' first."
  exit 1
fi

# Build target list. Prefer explicit ACP_INSTALL_TARGETS; otherwise install
# to VS Code and also Cursor when that extensions dir already exists.
if [[ -n "${ACP_INSTALL_TARGETS:-}" ]]; then
  # shellcheck disable=SC2206
  TARGETS=($ACP_INSTALL_TARGETS)
else
  TARGETS=("$HOME/.vscode/extensions")
  if [[ -d "$HOME/.cursor/extensions" ]]; then
    TARGETS+=("$HOME/.cursor/extensions")
  fi
fi

echo "📦 Installing $PUBLISHER.$NAME v$VERSION..."
echo "   VSIX: $VSIX"

TMP_DIR=$(mktemp -d)
unzip -q "$VSIX" -d "$TMP_DIR"

for EXT_ROOT in "${TARGETS[@]}"; do
  EXT_DIR="$EXT_ROOT/$PUBLISHER.$NAME-$VERSION"
  echo "   Target: $EXT_DIR"
  mkdir -p "$EXT_ROOT"
  if [[ -d "$EXT_DIR" ]]; then
    echo "   Removing previous installation..."
    rm -r "$EXT_DIR"
  fi
  mkdir -p "$EXT_DIR"
  cp -r "$TMP_DIR/extension/"* "$EXT_DIR/"
  echo "✅ Installed to $EXT_DIR"
done

rm -r "$TMP_DIR"

echo ""
echo "✅ Done! Reload the editor to activate (⌘⇧P / Ctrl+Shift+P → 'Reload Window')."

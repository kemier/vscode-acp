#!/usr/bin/env bash
set -euo pipefail

# Install the built VSIX into ~/.vscode/extensions (local VS Code)
# Usage: ./scripts/install-vscode-server.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

# Read version from package.json
VERSION=$(node -p "require('$REPO_DIR/package.json').version")
PUBLISHER=$(node -p "require('$REPO_DIR/package.json').publisher")
NAME=$(node -p "require('$REPO_DIR/package.json').name")

VSIX="$REPO_DIR/$NAME-$VERSION.vsix"
EXT_DIR="$HOME/.vscode/extensions/$PUBLISHER.$NAME-$VERSION"

if [[ ! -f "$VSIX" ]]; then
  echo "❌ VSIX not found: $VSIX"
  echo "   Run 'npm run package && npx vsce package' first."
  exit 1
fi

echo "📦 Installing $PUBLISHER.$NAME v$VERSION..."
echo "   VSIX:  $VSIX"
echo "   Target: $EXT_DIR"

# Remove old extension dir if it exists
if [[ -d "$EXT_DIR" ]]; then
  echo "   Removing previous installation..."
  rm -r "$EXT_DIR"
fi

# VSIX is a zip — extract directly into the extensions dir
TMP_DIR=$(mktemp -d)
unzip -q "$VSIX" -d "$TMP_DIR"
mkdir -p "$EXT_DIR"
cp -r "$TMP_DIR/extension/"* "$EXT_DIR/"
rm -r "$TMP_DIR"
echo "✅ Installed to $EXT_DIR"

echo ""
echo "✅ Done! Reload VS Code to activate (Ctrl+Shift+P → 'Reload Window')."

#!/usr/bin/env bash
set -euo pipefail

# Install the built VSIX into local editor extension dirs.
# Defaults (when present):
#   - ~/.vscode/extensions         (desktop VS Code)
#   - ~/.vscode-server/extensions  (local vscode-server / some remote helpers)
#   - ~/.cursor/extensions         (Cursor)
# Usage: ./scripts/install-vscode-server.sh
#        ACP_INSTALL_TARGETS="$HOME/.cursor/extensions" ./scripts/install-vscode-server.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

# Node on Windows can't resolve MSYS POSIX paths (/e/...), so convert for
# the require() calls below; bash-side uses ($REPO_DIR, $VSIX) keep POSIX.
# Use -m (forward slashes): -w backslashes get eaten as JS escape
# sequences inside the require() string literal.
if command -v cygpath >/dev/null 2>&1; then
  REPO_DIR_NODE="$(cygpath -m "$REPO_DIR")"
else
  REPO_DIR_NODE="$REPO_DIR"
fi

VERSION=$(node -p "require('$REPO_DIR_NODE/package.json').version")
PUBLISHER=$(node -p "require('$REPO_DIR_NODE/package.json').publisher")
NAME=$(node -p "require('$REPO_DIR_NODE/package.json').name")
EXT_ID="$PUBLISHER.$NAME"
REL="$EXT_ID-$VERSION"

VSIX="$REPO_DIR/$NAME-$VERSION.vsix"

if [[ ! -f "$VSIX" ]]; then
  echo "❌ VSIX not found: $VSIX"
  echo "   Run 'npm run package && npx vsce package' first."
  exit 1
fi

# Build target list. Prefer explicit ACP_INSTALL_TARGETS; otherwise install
# to every local editor extensions dir that exists.
if [[ -n "${ACP_INSTALL_TARGETS:-}" ]]; then
  # shellcheck disable=SC2206
  TARGETS=($ACP_INSTALL_TARGETS)
else
  TARGETS=()
  for candidate in \
    "$HOME/.vscode/extensions" \
    "$HOME/.vscode-server/extensions" \
    "$HOME/.cursor/extensions"
  do
    if [[ -d "$candidate" || "$candidate" == "$HOME/.vscode/extensions" ]]; then
      TARGETS+=("$candidate")
    fi
  done
fi

register_extension() {
  local ext_root="$1"
  python3 - "$ext_root" "$EXT_ID" "$VERSION" "$REL" <<'PY'
import json, sys, time, uuid
from pathlib import Path

ext_root = Path(sys.argv[1])
ext_id, version, rel = sys.argv[2], sys.argv[3], sys.argv[4]
abs_path = str(ext_root / rel)
ext_uuid = str(uuid.uuid5(uuid.NAMESPACE_URL, f"vscode-ext:{ext_id}"))

ej_path = ext_root / "extensions.json"
entries = json.loads(ej_path.read_text()) if ej_path.exists() else []
entries = [e for e in entries if e.get("identifier", {}).get("id") != ext_id]
entries.append({
    "identifier": {"id": ext_id, "uuid": ext_uuid},
    "version": version,
    "location": {
        "$mid": 1,
        "fsPath": abs_path,
        "external": Path(abs_path).as_uri(),
        "path": abs_path,
        "scheme": "file",
    },
    "relativeLocation": rel,
    "metadata": {
        "installedTimestamp": int(time.time() * 1000),
        "pinned": False,
        "source": "vsix",
    },
})
ej_path.write_text(json.dumps(entries))
print(f"   Registered {ext_id}@{version} in {ej_path}")
PY
}

echo "📦 Installing $PUBLISHER.$NAME v$VERSION..."
echo "   VSIX: $VSIX"

TMP_DIR=$(mktemp -d)
unzip -q "$VSIX" -d "$TMP_DIR"

for EXT_ROOT in "${TARGETS[@]}"; do
  EXT_DIR="$EXT_ROOT/$REL"
  echo "   Target: $EXT_DIR"
  mkdir -p "$EXT_ROOT"
  if [[ -d "$EXT_DIR" ]]; then
    echo "   Removing previous installation..."
    rm -r "$EXT_DIR"
  fi
  mkdir -p "$EXT_DIR"
  cp -r "$TMP_DIR/extension/"* "$EXT_DIR/"
  register_extension "$EXT_ROOT"
  echo "✅ Installed to $EXT_DIR"
done

rm -r "$TMP_DIR"

echo ""
echo "✅ Done! Reload the editor to activate (⌘⇧P / Ctrl+Shift+P → 'Reload Window')."

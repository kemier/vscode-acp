#!/usr/bin/env bash
set -euo pipefail

# Install the built VSIX on a remote SSH host into:
#   - ~/.vscode-server/extensions  (Remote SSH / code-server)
#   - ~/.vscode/extensions         (local VS Code on that machine)
#   - ~/.cursor/extensions         (local Cursor on that machine, if present)
#
# Each target is registered in extensions.json so the editor doesn't mark
# a plain unzip as .obsolete.
#
# Usage:
#   ./scripts/install-vscode-server-remote.sh
#   ACP_SSH_HOST=workstation ./scripts/install-vscode-server-remote.sh
#
# Without ACP_SSH_HOST, installs only into the local ~/.vscode-server/extensions.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

VERSION=$(node -p "require('$REPO_DIR/package.json').version")
PUBLISHER=$(node -p "require('$REPO_DIR/package.json').publisher")
NAME=$(node -p "require('$REPO_DIR/package.json').name")
EXT_ID="$PUBLISHER.$NAME"
REL="$EXT_ID-$VERSION"

VSIX="$REPO_DIR/$NAME-$VERSION.vsix"

if [[ ! -f "$VSIX" ]]; then
  echo "❌ VSIX not found: $VSIX"
  echo "   Run 'npm run package && npx vsce package' first."
  exit 1
fi

# Shared Python: register one extension in an extensions root.
REGISTER_PY=$(cat <<'PY'
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
    "location": {"$mid": 1, "path": abs_path, "scheme": "file"},
    "relativeLocation": rel,
    "metadata": {
        "isApplicationScoped": False,
        "isMachineScoped": False,
        "isBuiltin": False,
        "installedTimestamp": int(time.time() * 1000),
        "pinned": True,
        "source": "vsix",
    },
})
ej_path.write_text(json.dumps(entries))
(ext_root / ".obsolete").write_text("{}")
print(f"   Registered {ext_id}@{version} in {ej_path}")
PY
)

install_into_root() {
  local EXT_ROOT="$1"
  local EXT_DIR="$EXT_ROOT/$REL"

  echo "   Target: $EXT_DIR"
  mkdir -p "$EXT_ROOT"
  rm -rf "$EXT_ROOT/$EXT_ID"-*

  local TMP_DIR
  TMP_DIR=$(mktemp -d)
  unzip -q "$VSIX" -d "$TMP_DIR"
  mkdir -p "$EXT_DIR"
  cp -r "$TMP_DIR/extension/"* "$EXT_DIR/"
  rm -r "$TMP_DIR"

  python3 -c "$REGISTER_PY" "$EXT_ROOT" "$EXT_ID" "$VERSION" "$REL"
  echo "✅ Installed to $EXT_DIR"
}

install_local_vscode_server() {
  echo "📦 Installing $EXT_ID v$VERSION into local ~/.vscode-server..."
  echo "   VSIX: $VSIX"
  install_into_root "$HOME/.vscode-server/extensions"
}

if [[ -n "${ACP_SSH_HOST:-}" ]]; then
  echo "📦 Installing $EXT_ID v$VERSION on SSH host: $ACP_SSH_HOST"
  echo "   Targets: ~/.vscode-server/extensions, ~/.vscode/extensions, ~/.cursor/extensions (if present)"
  scp -o BatchMode=yes "$VSIX" "$ACP_SSH_HOST:/tmp/$NAME-$VERSION.vsix"
  # shellcheck disable=SC2087
  ssh -o BatchMode=yes "$ACP_SSH_HOST" bash -s <<EOF
set -euo pipefail
VSIX="/tmp/$NAME-$VERSION.vsix"
EXT_ID="$EXT_ID"
VERSION="$VERSION"
REL="$REL"
NAME="$NAME"

register() {
  python3 - "\$1" "\$EXT_ID" "\$VERSION" "\$REL" <<'PY'
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
    "location": {"\$mid": 1, "path": abs_path, "scheme": "file"},
    "relativeLocation": rel,
    "metadata": {
        "isApplicationScoped": False,
        "isMachineScoped": False,
        "isBuiltin": False,
        "installedTimestamp": int(time.time() * 1000),
        "pinned": True,
        "source": "vsix",
    },
})
ej_path.write_text(json.dumps(entries))
(ext_root / ".obsolete").write_text("{}")
print(f"Registered {ext_id}@{version} -> {ej_path}")
print("extensions:", [e["identifier"]["id"]+"@"+e["version"] for e in entries])
PY
}

install_root() {
  local EXT_ROOT="\$1"
  local LABEL="\$2"
  local EXT_DIR="\$EXT_ROOT/\$REL"
  echo "── \$LABEL"
  echo "   Target: \$EXT_DIR"
  mkdir -p "\$EXT_ROOT"
  rm -rf "\$EXT_ROOT/\$EXT_ID"-*
  local TMP
  TMP=\$(mktemp -d)
  unzip -q "\$VSIX" -d "\$TMP"
  mkdir -p "\$EXT_DIR"
  cp -r "\$TMP/extension/"* "\$EXT_DIR/"
  rm -rf "\$TMP"
  register "\$EXT_ROOT"
  echo "✅ Installed to \$EXT_DIR"
}

install_root "\$HOME/.vscode-server/extensions" "vscode-server (Remote SSH)"
install_root "\$HOME/.vscode/extensions" "local VS Code"

if [[ -d "\$HOME/.cursor/extensions" ]]; then
  install_root "\$HOME/.cursor/extensions" "local Cursor"
else
  echo "── local Cursor"
  echo "   Skip: \$HOME/.cursor/extensions not present"
fi

# Prefer CLI install when available (registers + activates cleanly).
if command -v code >/dev/null 2>&1; then
  echo "── code --install-extension"
  code --install-extension "\$VSIX" --force || true
fi
if command -v cursor >/dev/null 2>&1; then
  echo "── cursor --install-extension"
  cursor --install-extension "\$VSIX" --force || true
fi

rm -f "\$VSIX"
EOF
else
  install_local_vscode_server
fi

echo ""
echo "✅ Done! Reload each editor (⌘⇧P → 'Reload Window')."

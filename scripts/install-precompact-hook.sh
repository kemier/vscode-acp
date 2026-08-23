#!/usr/bin/env bash
# Install ~/.cursor/hooks.json + preCompact logger for vscode-acp memory re-inject.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_HOOK="$REPO_ROOT/scripts/hooks/pre-compact-log.mjs"
CURSOR_DIR="${HOME}/.cursor"
HOOKS_DIR="${CURSOR_DIR}/hooks"
DEST_HOOK="${HOOKS_DIR}/pre-compact-log.mjs"
HOOKS_JSON="${CURSOR_DIR}/hooks.json"

[[ -f "$SRC_HOOK" ]] || { echo "Source hook not found: $SRC_HOOK" >&2; exit 1; }

mkdir -p "$HOOKS_DIR"
cp -f "$SRC_HOOK" "$DEST_HOOK"
chmod +x "$DEST_HOOK" 2>/dev/null || true

python3 - "$HOOKS_JSON" <<'PY'
import json, os, sys

hooks_json = sys.argv[1]
entry = {"command": "node ./hooks/pre-compact-log.mjs", "timeout": 5}

if os.path.isfile(hooks_json):
    with open(hooks_json, encoding="utf-8") as f:
        cfg = json.load(f)
else:
    cfg = {"version": 1, "hooks": {}}

hooks = cfg.setdefault("hooks", {})
pre = list(hooks.get("preCompact") or [])
if not any(h.get("command") == entry["command"] for h in pre):
    pre.append(entry)
hooks["preCompact"] = pre

with open(hooks_json, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
PY

echo "Installed preCompact hook:"
echo "  script: $DEST_HOOK"
echo "  config: $HOOKS_JSON"
echo "  log:    ${HOME}/.cursor/acp-debug/compaction-events.jsonl"
echo ""
echo "Reload Cursor / restart cursor-agent sessions. Optional: ACP_PRECOMPACT_NOTIFY=1 for a user toast."

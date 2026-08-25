#!/usr/bin/env bash
# Thin wrapper — real implementation is Node (Windows/macOS/Linux).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/deploy-all.js" "$@"

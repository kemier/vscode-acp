#!/usr/bin/env bash
# Copy KaTeX CSS + fonts into resources/ for the webview (node_modules is
# excluded from the VSIX). Run after upgrading the katex dependency.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/node_modules/katex/dist"
DST="$ROOT/resources/katex"
if [[ ! -f "$SRC/katex.min.css" ]]; then
  echo "katex not installed; run: npm install katex --legacy-peer-deps" >&2
  exit 1
fi
mkdir -p "$DST/fonts"
cp "$SRC/katex.min.css" "$DST/"
cp "$SRC/fonts/"* "$DST/fonts/"
echo "Copied KaTeX assets to $DST ($(ls "$DST/fonts" | wc -l | tr -d ' ') fonts)"

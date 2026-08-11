#!/usr/bin/env bash
# One-command installer. Downloads latest release tarball, extracts, runs install.sh.
# Override URL via OLLAMA_TUI_URL.
set -euo pipefail
URL="${OLLAMA_TUI_URL:-https://github.com/psyc-exe/ollama-tui/releases/latest/download/ollama-tui.tar.gz}"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
echo "==> fetching $URL"
curl -fsSL "$URL" -o "$TMP/ollama-tui.tar.gz"
tar -xzf "$TMP/ollama-tui.tar.gz" -C "$TMP"
exec "$TMP/install.sh" "$@"

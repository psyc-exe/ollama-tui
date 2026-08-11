#!/usr/bin/env bash
# ollama-tui installer: one command, interactive, single-file release.
# Usage:
#   curl -L https://github.com/psyc-exe/ollama-tui/releases/latest/download/ollama-tui.tar.gz \
#     | tar xz && ./install.sh
#   curl -L https://raw.githubusercontent.com/psyc-exe/ollama-tui/main/installer/install-online.sh | bash -s -- --web
#
# Flags (non-interactive):
#   --mode web|tui|both       default: both
#   --port N                  default: 8080
#   --no-ollama               skip ollama install
#   --prefix DIR              default: /usr/local
#   --non-interactive         fail if a question is asked
set -euo pipefail

MODE="both"; PORT="8080"; PREFIX="/usr/local"; DO_OLLAMA=1; NONINT=0
for a in "$@"; do
  case "$a" in
    --mode=*) MODE="${a#*=}" ;;
    --mode) shift; MODE="${1:-both}" ;;
    --port=*) PORT="${a#*=}" ;;
    --port) shift; PORT="${1:-8080}" ;;
    --no-ollama) DO_OLLAMA=0 ;;
    --prefix=*) PREFIX="${a#*=}" ;;
    --prefix) shift; PREFIX="${1:-/usr/local}" ;;
    --non-interactive) NONINT=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown arg: $a"; exit 1 ;;
  esac
done

ARCH=$(uname -m)
case "$ARCH" in
  x86_64) OARCH=amd64 ;;
  aarch64|arm64) OARCH=arm64 ;;
  *) echo "Unsupported arch $ARCH"; exit 1 ;;
esac

RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; CYN=$'\033[36m'; RST=$'\033[0m'

step() { printf "\n${CYN}==>${RST} %s\n" "$*"; }
ok()   { printf "${GRN}ok${RST}  %s\n" "$*"; }
warn() { printf "${YLW}warn${RST} %s\n" "$*"; }
die()  { printf "${RED}err${RST} %s\n" "$*"; exit 1; }

have_ollama() { command -v ollama >/dev/null 2>&1; }
have_node()   { command -v node   >/dev/null 2>&1; }
ver_ge() { [ "$(printf '%s\n' "$2" "$1" | sort -V | tail -n1)" = "$1" ]; }

step "Detecting environment"
echo "  arch:      $ARCH (ollama: $OARCH)"
echo "  prefix:    $PREFIX"
echo "  mode:      $MODE"
echo "  port:      $PORT"
echo "  ollama:    $(have_ollama && ollama --version 2>/dev/null || echo 'absent')"
echo "  node:      $(have_node && node -v || echo 'absent')"

have_node || die "Node.js >= 18 required. Install Node first."

step "Installing Ollama"
if have_ollama; then
  ok "ollama already present at $(command -v ollama)"
elif [ "$DO_OLLAMA" = "1" ]; then
  TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
  URL=$(curl -s https://api.github.com/repos/ollama/ollama/releases/latest \
        | grep -oE "https://[^\"]+ollama-linux-${OARCH}\.tgz" | head -n1 || true)
  [ -z "$URL" ] && die "Could not resolve latest ollama release URL"
  curl -fsSL "$URL" -o "$TMP/ollama.tgz" || die "download failed"
  tar -xzf "$TMP/ollama.tgz" -C "$TMP"
  sudo install -m 0755 "$TMP/ollama" "$PREFIX/bin/ollama" || die "install failed (sudo?)"
  ok "ollama installed to $PREFIX/bin/ollama"
else
  warn "skipping ollama install (--no-ollama)"
fi

step "Locating release payload"
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC_WEB="$HERE/dist/ollama-tui-web.js"
SRC_TUI="$HERE/dist/ollama-tui-tui.js"
if [ ! -f "$SRC_WEB" ] && [ ! -f "$SRC_TUI" ]; then
  die "no payload found at $HERE/dist (run installer from extracted tarball root)"
fi

step "Installing ollama-tui ($MODE)"
if [[ "$MODE" == web || "$MODE" == both ]]; then
  [ -f "$SRC_WEB" ] || die "web payload missing"
  sudo install -m 0755 "$SRC_WEB" "$PREFIX/bin/ollama-tui-web" || die "install failed"
  ok "web  -> $PREFIX/bin/ollama-tui-web"
fi
if [[ "$MODE" == tui || "$MODE" == both ]]; then
  [ -f "$SRC_TUI" ] || die "tui payload missing"
  sudo install -m 0755 "$SRC_TUI" "$PREFIX/bin/ollama-tui" || die "install failed"
  ok "tui  -> $PREFIX/bin/ollama-tui"
fi

step "Summary"
cat <<EOF
  Run web UI:
    PORT=$PORT OLLAMA_HOST=http://127.0.0.1:11434 ollama-tui-web
    then open http://<host>:$PORT
  Run TUI:
    ollama-tui            # default model: llama3.2
    OLLAMA_MODEL=rpi-qwen:latest ollama-tui
EOF

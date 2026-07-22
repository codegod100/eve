#!/usr/bin/env bash
# Boot the eve stack.
#
# Prefer systemd user units when installed (eve.target). Otherwise fall back
# to a legacy foreground path (prep + background irc-bridge + eve).
#
#   npm run boxd:start
#   bash scripts/start.sh
#   bash scripts/start.sh --legacy    # force non-systemd path
#   bash scripts/start.sh --install   # install units then start
set -euo pipefail

export PATH="${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LEGACY=0
INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --legacy) LEGACY=1 ;;
    --install) INSTALL=1 ;;
    -h | --help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
  esac
done

units_installed() {
  systemctl --user cat eve.target >/dev/null 2>&1
}

if [ "$INSTALL" -eq 1 ]; then
  bash "$ROOT/scripts/install-systemd.sh"
fi

if [ "$LEGACY" -eq 0 ] && units_installed; then
  echo "[start] systemd: starting eve.target"
  # Refresh secrets/build before (re)starting long-running units.
  systemctl --user start eve-prep.service
  systemctl --user restart eve.service eve-irc-bridge.service
  if systemctl --user is-enabled eve-av-bridge.service >/dev/null 2>&1; then
    systemctl --user restart eve-av-bridge.service || true
  fi
  systemctl --user start eve.target
  systemctl --user --no-pager --full status eve.service eve-irc-bridge.service || true
  echo "[start] logs: journalctl --user -u eve.service -u eve-irc-bridge.service -f"
  exit 0
fi

if [ "$LEGACY" -eq 0 ] && ! units_installed; then
  echo "[start] systemd units not installed — legacy path"
  echo "[start] install with:  bash scripts/install-systemd.sh"
fi

# --- Legacy: prep + nohup bridge + foreground eve ---------------------------
bash "$ROOT/scripts/prep.sh"
RUNTIME_ENV="${EVE_RUNTIME_ENV:-$HOME/.config/eve/runtime.env}"
if [ -f "$RUNTIME_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$RUNTIME_ENV"
  set +a
fi

echo "[start] launching irc-bridge (legacy background) ..."
nohup node "$ROOT/irc-bridge/server.mjs" >>/tmp/irc-bridge.log 2>&1 &
echo "[start] irc-bridge pid $! (log /tmp/irc-bridge.log)"

echo "[start] launching eve start on :8000 ..."
exec npx eve start --port 8000 --host 0.0.0.0

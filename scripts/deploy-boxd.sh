#!/usr/bin/env bash
# Deploy this checkout on the eve boxd VM (systemd user units).
#
# Intended to run ON the VM after git has been synced to the target SHA:
#   bash scripts/deploy-boxd.sh
#   bash scripts/deploy-boxd.sh --skip-install   # source-only: skip npm ci
#
# Called from .github/workflows/deploy-boxd.yml via:
#   boxd machine exec eve -- …
set -euo pipefail

export PATH="${HOME}/.local/bin:/nix/var/nix/profiles/default/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

# Non-interactive boxd exec shells often lack a user systemd session.
if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ]; then
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
fi
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ -n "${XDG_RUNTIME_DIR:-}" ] \
  && [ -S "${XDG_RUNTIME_DIR}/bus" ]; then
  export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
fi

# nvm Node is not on PATH in non-interactive shells.
if [ -s "${HOME}/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "${HOME}/.nvm/nvm.sh"
  nvm use default >/dev/null 2>&1 || nvm use node >/dev/null 2>&1 || true
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SKIP_INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --skip-install) SKIP_INSTALL=1 ;;
    -h | --help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
  esac
done

echo "[deploy] root=${ROOT} sha=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"

if [ "$SKIP_INSTALL" -eq 0 ]; then
  echo "[deploy] npm ci ..."
  npm ci
else
  echo "[deploy] skipping npm ci (--skip-install)"
fi

# Refresh unit templates (WHEP flake paths, prep timeout, PATH) without
# changing which units are enabled.
if systemctl --user cat eve.target >/dev/null 2>&1; then
  echo "[deploy] refreshing systemd user units ..."
  bash "$ROOT/scripts/install-systemd.sh" --no-enable
fi

echo "[deploy] restarting stack ..."
bash "$ROOT/scripts/start.sh"

echo "[deploy] done"

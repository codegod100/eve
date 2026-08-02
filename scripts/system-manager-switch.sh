#!/usr/bin/env bash
# Apply flake systemConfigs.default via numtide system-manager.
#
#   bash scripts/system-manager-switch.sh
#   SYSTEM_MANAGER_NO_SUDO=1 bash scripts/system-manager-switch.sh   # already root
#
# Requires multi-user Nix with flakes. See nix/system-manager/README.md.
set -euo pipefail

export PATH="/nix/var/nix/profiles/default/bin:/run/system-manager/sw/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FLAKE="${SYSTEM_MANAGER_FLAKE:-$ROOT}"

if ! command -v nix >/dev/null 2>&1; then
  echo "[system-manager] nix not found — install multi-user Nix first:" >&2
  echo "  curl --proto '=https' --tlsv1.2 -sSf -L https://install.determinate.systems/nix | sh -s -- install" >&2
  exit 1
fi

SUDO_ARGS=(--sudo)
if [ "${SYSTEM_MANAGER_NO_SUDO:-0}" = "1" ]; then
  SUDO_ARGS=()
fi

echo "[system-manager] switch --flake ${FLAKE}"
# Locked input re-exported as .#system-manager (linux). Upstream flake as fallback.
if nix path-info --extra-experimental-features 'nix-command flakes' \
  "${ROOT}#system-manager" >/dev/null 2>&1; then
  nix run --extra-experimental-features 'nix-command flakes' \
    "${ROOT}#system-manager" -- switch --flake "${FLAKE}" "${SUDO_ARGS[@]}"
else
  nix run --extra-experimental-features 'nix-command flakes' \
    'github:numtide/system-manager' -- switch --flake "${FLAKE}" "${SUDO_ARGS[@]}"
fi

if [ -x /run/system-manager/sw/bin/whep-python ]; then
  echo "[system-manager] whep-python → /run/system-manager/sw/bin/whep-python"
fi

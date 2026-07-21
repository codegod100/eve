#!/usr/bin/env bash
# Build & run the freeq-based AV media plane (WebSocket control).
#
# Prefer **glibc crt-static** from the freeq flake when deploying to bare
# Ubuntu (boxd). Local NixOS can use dynamic cargo/nix build.
#
#   ./scripts/run-av-bridge.sh              # cargo run in freeq (dev)
#   ./scripts/run-av-bridge.sh --static     # nix build .#eve-av-bridge-static && run
#   cd ../freeq && ./scripts/build-eve-av-bridge-static.sh --deploy-boxd eve
set -euo pipefail

FREEQ_ROOT="${FREEQ_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../freeq" && pwd)}"
BIND="${AV_BRIDGE_BIND:-127.0.0.1:8790}"

if [[ ! -f "$FREEQ_ROOT/eve-av-bridge/Cargo.toml" ]]; then
  echo "eve-av-bridge not found under $FREEQ_ROOT" >&2
  echo "Expected freeq monorepo sibling with package eve-av-bridge." >&2
  exit 1
fi

cd "$FREEQ_ROOT"
echo "[av-bridge] freeq=$FREEQ_ROOT bind=$BIND"

if [[ "${1:-}" == "--static" ]]; then
  echo "[av-bridge] nix build .#eve-av-bridge-static (glibc crt-static)"
  nix build ".#eve-av-bridge-static" -L
  exec ./result/bin/eve-av-bridge --bind "${BIND}"
fi

# Dev: dynamic cargo build
if command -v nix >/dev/null 2>&1; then
  exec nix develop -c cargo run -p eve-av-bridge --release -- --bind "${BIND}"
elif command -v nix-shell >/dev/null 2>&1; then
  exec nix-shell -p pkg-config alsa-lib ffmpeg --run \
    "cargo run -p eve-av-bridge --release -- --bind ${BIND}"
else
  exec cargo run -p eve-av-bridge --release -- --bind "${BIND}"
fi

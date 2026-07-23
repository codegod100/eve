#!/usr/bin/env bash
# Long-running entrypoint for eve-av-bridge.service.
# Prefer a prebuilt binary (boxd static deploy); fall back to freeq cargo/nix.
set -euo pipefail

export PATH="${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIND="${AV_BRIDGE_BIND:-127.0.0.1:8790}"
export AV_PLANE_ROLE="${AV_PLANE_ROLE:-radio}"
export RADIO_TITLE_HOOK="${RADIO_TITLE_HOOK:-http://127.0.0.1:8791/radio/now-playing}"

candidates=(
  "${EVE_AV_BRIDGE_BIN:-}"
  "${HOME}/.local/bin/eve-av-bridge"
  "${HOME}/bin/eve-av-bridge"
  "${ROOT}/bin/eve-av-bridge"
  "${ROOT}/result/bin/eve-av-bridge"
)

for bin in "${candidates[@]}"; do
  if [ -n "$bin" ] && [ -x "$bin" ]; then
    echo "[av-bridge] exec $bin --bind $BIND (RADIO_TITLE_HOOK=$RADIO_TITLE_HOOK)"
    exec env RADIO_TITLE_HOOK="$RADIO_TITLE_HOOK" "$bin" --bind "$BIND"
  fi
done

echo "[av-bridge] no prebuilt binary; using scripts/run-av-bridge.sh"
exec "$ROOT/scripts/run-av-bridge.sh"

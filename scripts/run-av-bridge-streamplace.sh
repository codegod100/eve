#!/usr/bin/env bash
# Additional freeq MoQ media plane dedicated to stream.place rebroadcast.
set -euo pipefail

export PATH="${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export AV_BRIDGE_BIND="${STREAMPLACE_AV_BRIDGE_BIND:-127.0.0.1:8792}"
# Don't push ICY titles into the radio announce path (separate plane).
export RADIO_TITLE_HOOK="${STREAMPLACE_RADIO_TITLE_HOOK:-}"

echo "[av-bridge-streamplace] bind=$AV_BRIDGE_BIND"
exec "$ROOT/scripts/run-av-bridge-service.sh"

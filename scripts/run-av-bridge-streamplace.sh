#!/usr/bin/env bash
# stream-watch MoQ plane: stream.place HLS → freeq (not radio).
set -euo pipefail
export PATH="${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export AV_BRIDGE_BIND="${STREAM_WATCH_AV_BRIDGE_BIND:-${STREAMPLACE_AV_BRIDGE_BIND:-127.0.0.1:8792}}"
export AV_PLANE_ROLE=watch
# Never announce ICY titles from the watch plane.
export RADIO_TITLE_HOOK=
echo "[av-bridge-stream-watch] bind=$AV_BRIDGE_BIND role=$AV_PLANE_ROLE"
exec "$ROOT/scripts/run-av-bridge-service.sh"

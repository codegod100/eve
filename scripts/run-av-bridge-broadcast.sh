#!/usr/bin/env bash
# stream-broadcast MoQ plane: freeq call → stream.place RTMP (call-egress only).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export AV_BRIDGE_BIND="${STREAM_BROADCAST_AV_BRIDGE_BIND:-127.0.0.1:8793}"
export AV_PLANE_ROLE=broadcast
export RADIO_TITLE_HOOK=
echo "[av-bridge-broadcast] bind=$AV_BRIDGE_BIND role=$AV_PLANE_ROLE"
exec "$ROOT/scripts/run-av-bridge-service.sh"

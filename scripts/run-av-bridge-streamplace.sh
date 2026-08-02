#!/usr/bin/env bash
# stream-watch MoQ plane: stream.place WHEP → freeq (not radio, not HLS).
set -euo pipefail
export PATH="${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export AV_BRIDGE_BIND="${STREAM_WATCH_AV_BRIDGE_BIND:-${STREAMPLACE_AV_BRIDGE_BIND:-127.0.0.1:8792}}"
export AV_PLANE_ROLE=watch
# WHEP-only policy — do not point this plane at getLivePlaylist.
export STREAMPLACE_WATCH_TRANSPORT=whep
export WHEP_DEMUX_PATH="${WHEP_DEMUX_PATH:-$ROOT/scripts/whep-watch-demux.py}"
# P360 freeq tile at continuous 20 fps — matches demux drop-frame in watch.rs.
# 360p @ ~1.2Mbps stays workable on 2-core boxd without starving Opus.
export AV_VIDEO_PRESET="${AV_VIDEO_PRESET:-360p}"
export AV_VIDEO_FPS="${AV_VIDEO_FPS:-20}"
export AV_VIDEO_BITRATE="${AV_VIDEO_BITRATE:-1200000}"
# Never announce ICY titles from the watch plane.
export RADIO_TITLE_HOOK=
echo "[av-bridge-stream-watch] bind=$AV_BRIDGE_BIND role=$AV_PLANE_ROLE transport=whep demux=$WHEP_DEMUX_PATH preset=$AV_VIDEO_PRESET fps=$AV_VIDEO_FPS br=$AV_VIDEO_BITRATE"
exec "$ROOT/scripts/run-av-bridge-service.sh"

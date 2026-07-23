#!/usr/bin/env bash
# Sanity-check stream.place *publish* plane env (inverse of watch).
# Does not start ffmpeg — irc-bridge owns the publish process.
set -euo pipefail

RTMP_URL="${STREAMPLACE_RTMP_URL:-rtmps://stream.place:1935/live}"
KEY="${STREAMPLACE_STREAM_KEY:-}"
CONTROL="${IRC_CONTROL_URL:-http://127.0.0.1:8791}"

echo "[streamplace-publish] rtmp_base=$RTMP_URL"
echo "[streamplace-publish] key=${KEY:+set (${#KEY} chars)}${KEY:-MISSING — set STREAMPLACE_STREAM_KEY}"
echo "[streamplace-publish] handle=${STREAMPLACE_PUBLISH_HANDLE:-"(unset)"}"
echo "[streamplace-publish] control=$CONTROL"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "[streamplace-publish] ERROR: ffmpeg not on PATH" >&2
  exit 1
fi
echo "[streamplace-publish] ffmpeg=$(command -v ffmpeg)"

if curl -fsS --max-time 3 "$CONTROL/streamplace/publish/status" 2>/dev/null; then
  echo
else
  echo "[streamplace-publish] control not reachable (start eve-irc-bridge)"
fi

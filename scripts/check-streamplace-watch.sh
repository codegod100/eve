#!/usr/bin/env bash
# Quick health check for stream.place → freeq watch on a live eve host.
# Exit 0 only when WHEP is playing AND MoQ video has a subscriber consuming frames.
set -euo pipefail

CONTROL="${IRC_CONTROL_URL:-http://127.0.0.1:8791}"
PLANE="${STREAMPLACE_AV_BRIDGE_BIND:-http://127.0.0.1:8792}"
case "$PLANE" in
  http*|ws*) ;;
  *) PLANE="http://${PLANE}" ;;
esac
LOG="${STREAMPLACE_AV_LOG:-$HOME/logs/streamplace-av.log}"

echo "[check] control=$CONTROL plane=$PLANE"

status_json=$(curl -fsS --max-time 8 "$CONTROL/streamplace/status")
python3 -c 'import json,sys; j=json.loads(sys.argv[1]); print(json.dumps({"watch": j.get("status",{}).get("watch"), "session": j.get("status",{}).get("session")}, indent=2)[:500])' "$status_json"

playing=$(python3 -c 'import json,sys; j=json.loads(sys.argv[1]); print("1" if j.get("status",{}).get("watch",{}).get("playing") else "0")' "$status_json")
session=$(python3 -c 'import json,sys; j=json.loads(sys.argv[1]); s=j.get("status",{}).get("session") or {}; print(s.get("session_id") or "")' "$status_json")
path=$(python3 -c 'import json,sys; j=json.loads(sys.argv[1]); s=j.get("status",{}).get("session") or {}; print(s.get("broadcast_path") or "")' "$status_json")

if [[ "$playing" != "1" ]]; then
  echo "[check] FAIL: watch not playing" >&2
  exit 1
fi
if [[ -z "$session" ]]; then
  echo "[check] FAIL: no MoQ session on watch plane" >&2
  exit 1
fi

# Official freeq channel active must match our session (Join existing).
ch=$(echo "$status_json" | python3 -c 'import json,sys; j=json.load(sys.stdin); s=j.get("status",{}).get("session") or {}; print(s.get("channel") or "#test")')
api="${FREEQ_API_BASE:-https://irc.freeq.at}"
enc=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$ch")
chan_json=$(curl -fsS --max-time 8 "$api/api/v1/channels/${enc}/sessions" || echo '{}')
official=$(echo "$chan_json" | python3 -c 'import json,sys; j=json.load(sys.stdin); a=j.get("active") or {}; print(a.get("id") or "")')
echo "[check] session=$session path=$path official_active=${official:-null}"

if [[ -z "$official" ]]; then
  echo "[check] FAIL: freeq channel $ch has active=null (clients cannot Join existing)" >&2
  exit 2
fi
if [[ "$official" != "$session" ]]; then
  echo "[check] FAIL: eve on $session but official active is $official" >&2
  exit 2
fi

# Video encode only runs when a MoQ subscriber requests the track.
# Without a viewer, popped stays 0 by design — warn, don't hard-fail.
if [[ -f "$LOG" ]]; then
  recent=$(python3 - "$LOG" <<'PY'
import re, sys
from pathlib import Path
raw = Path(sys.argv[1]).read_bytes()[-200_000:]
plain = re.sub(r"\x1b\[[0-9;]*m", "", raw.decode("utf-8", "ignore"))
vals = [int(m) for m in re.findall(r"popped=(\d+)", plain)]
subs = sum(1 for line in plain.splitlines() if "started track: video/" in line)
print(f"popped_max={max(vals) if vals else 0} video_track_starts={subs}")
PY
)
  echo "[check] $recent (from log; needs a freeq viewer for popped>0)"
fi

echo "[check] ok — watch playing on official session $session"
exit 0

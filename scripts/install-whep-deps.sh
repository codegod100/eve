#!/usr/bin/env bash
# Install Python deps for stream.place WHEP demux (whep-watch-demux.py).
# WHEP is the only stream.place watch transport — these deps are required.
set -euo pipefail
export PATH="${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REQ="${ROOT}/scripts/requirements-whep.txt"
DEMUX="${ROOT}/scripts/whep-watch-demux.py"

if ! command -v python3 >/dev/null 2>&1; then
  echo "[whep-deps] python3 not found" >&2
  exit 1
fi

echo "[whep-deps] pip install --user -r ${REQ}"
python3 -m pip install --user -q -r "$REQ"

# Fail loud if imports still broken (common on bare boxd before this runs).
python3 - <<'PY'
import aiortc, aiohttp, av, numpy
print("[whep-deps] ok aiortc=%s av=%s" % (aiortc.__version__, av.__version__))
PY

if [ ! -f "$DEMUX" ]; then
  echo "[whep-deps] missing demux script: $DEMUX" >&2
  exit 1
fi

# Point the watch plane at this repo's demux (freeq looks for WHEP_DEMUX_PATH).
echo "[whep-deps] WHEP_DEMUX_PATH=${DEMUX}"

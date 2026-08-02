#!/usr/bin/env bash
# Materialize a Python env with aiortc/aiohttp/av/numpy for WHEP demux.
# WHEP is the only stream.place watch transport — this env is required.
#
# Preferred:  nix build .#whep-python
# Fallback:   pip install --target (no nix / no python3-venv needed on boxd)
# Roots:      ~/.local/share/eve/whep-python  (bin/python3 + libs)
# Wrapper:    ~/.local/share/eve/whep-watch-demux
# Exports:    WHEP_PYTHON / WHEP_DEMUX_PATH  (prep.sh → runtime.env)
set -euo pipefail
export PATH="${HOME}/.local/bin:/nix/var/nix/profiles/default/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMUX_PY="${ROOT}/scripts/whep-watch-demux.py"
REQ="${ROOT}/scripts/requirements-whep.txt"
SHARE="${EVE_WHEP_SHARE:-$HOME/.local/share/eve}"
OUT_LINK="${EVE_WHEP_PYTHON_LINK:-$SHARE/whep-python}"
WRAPPER="${EVE_WHEP_DEMUX_WRAPPER:-$SHARE/whep-watch-demux}"
SYS_PYTHON="$(command -v python3 || true)"

if [ ! -f "$DEMUX_PY" ]; then
  echo "[whep-deps] missing demux script: $DEMUX_PY" >&2
  exit 1
fi

mkdir -p "$SHARE"

verify_python() {
  local py="$1"
  "$py" - <<'PY'
import aiortc, aiohttp, av, numpy
print("[whep-deps] ok aiortc=%s av=%s" % (aiortc.__version__, av.__version__))
PY
}

write_demux_wrapper() {
  local py="$1"
  cat >"$WRAPPER" <<EOF
#!/usr/bin/env bash
exec "${py}" "${DEMUX_PY}" "\$@"
EOF
  chmod 755 "$WRAPPER"
}

install_via_nix() {
  echo "[whep-deps] nix build .#whep-python → ${OUT_LINK}"
  nix build "${ROOT}#whep-python" -o "$OUT_LINK" --no-warn-dirty
  local py="${OUT_LINK}/bin/python3"
  if [ ! -x "$py" ]; then
    echo "[whep-deps] missing interpreter after nix build: $py" >&2
    return 1
  fi
  verify_python "$py"
  write_demux_wrapper "$py"
  echo "[whep-deps] WHEP_PYTHON=${py}"
  echo "[whep-deps] WHEP_DEMUX_PATH=${WRAPPER}"
}

install_via_pip_target() {
  if [ -z "$SYS_PYTHON" ]; then
    echo "[whep-deps] python3 not found" >&2
    return 1
  fi
  if [ ! -f "$REQ" ]; then
    echo "[whep-deps] missing requirements: $REQ" >&2
    return 1
  fi
  if ! "$SYS_PYTHON" -m pip --version >/dev/null 2>&1; then
    echo "[whep-deps] python3 -m pip unavailable" >&2
    return 1
  fi

  # Replace a prior nix result symlink / partial tree with a real prefix.
  rm -rf "$OUT_LINK"
  mkdir -p "$OUT_LINK/lib" "$OUT_LINK/bin"

  echo "[whep-deps] pip install --target ${OUT_LINK}/lib -r ${REQ}"
  "$SYS_PYTHON" -m pip install -q --upgrade --target "$OUT_LINK/lib" -r "$REQ"

  local py="${OUT_LINK}/bin/python3"
  cat >"$py" <<EOF
#!/usr/bin/env bash
# Isolated site-packages from pip --target (boxd / no-nix fallback).
export PYTHONPATH="${OUT_LINK}/lib\${PYTHONPATH:+:\$PYTHONPATH}"
exec "${SYS_PYTHON}" "\$@"
EOF
  chmod 755 "$py"

  verify_python "$py"
  write_demux_wrapper "$py"
  echo "[whep-deps] WHEP_PYTHON=${py}"
  echo "[whep-deps] WHEP_DEMUX_PATH=${WRAPPER}"
}

NIX_OK=0
if command -v nix >/dev/null 2>&1; then
  if install_via_nix; then
    NIX_OK=1
  else
    echo "[whep-deps] nix build failed — falling back to pip --target" >&2
  fi
else
  echo "[whep-deps] nix not found — using pip --target fallback" >&2
fi

if [ "$NIX_OK" -eq 0 ]; then
  install_via_pip_target
fi

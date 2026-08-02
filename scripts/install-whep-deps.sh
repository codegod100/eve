#!/usr/bin/env bash
# Materialize flake package whep-python (aiortc/aiohttp/av/numpy) for WHEP demux.
# WHEP is the only stream.place watch transport — this env is required.
#
# Builds:  nix build .#whep-python
# Roots:   ~/.local/share/eve/whep-python  (survives nix-collect-garbage)
# Wrapper: ~/.local/share/eve/whep-watch-demux  (flake python + repo demux.py)
# Exports: WHEP_PYTHON / WHEP_DEMUX_PATH  (prep.sh → runtime.env)
set -euo pipefail
export PATH="${HOME}/.local/bin:/nix/var/nix/profiles/default/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMUX_PY="${ROOT}/scripts/whep-watch-demux.py"
SHARE="${EVE_WHEP_SHARE:-$HOME/.local/share/eve}"
OUT_LINK="${EVE_WHEP_PYTHON_LINK:-$SHARE/whep-python}"
WRAPPER="${EVE_WHEP_DEMUX_WRAPPER:-$SHARE/whep-watch-demux}"

if ! command -v nix >/dev/null 2>&1; then
  echo "[whep-deps] nix not found — install Nix, then re-run:" >&2
  echo "  curl --proto '=https' --tlsv1.2 -sSf -L https://install.determinate.systems/nix | sh -s -- install" >&2
  exit 1
fi

if [ ! -f "$DEMUX_PY" ]; then
  echo "[whep-deps] missing demux script: $DEMUX_PY" >&2
  exit 1
fi

mkdir -p "$SHARE"
echo "[whep-deps] nix build .#whep-python → ${OUT_LINK}"
nix build "${ROOT}#whep-python" -o "$OUT_LINK" --no-warn-dirty

WHEP_PYTHON="${OUT_LINK}/bin/python3"
if [ ! -x "$WHEP_PYTHON" ]; then
  echo "[whep-deps] missing interpreter after build: $WHEP_PYTHON" >&2
  exit 1
fi

# Fail loud if imports still broken.
"$WHEP_PYTHON" - <<'PY'
import aiortc, aiohttp, av, numpy
print("[whep-deps] ok aiortc=%s av=%s" % (aiortc.__version__, av.__version__))
PY

# freeq/av-bridge spawn WHEP_DEMUX_PATH directly (shebang). Prefer an explicit
# wrapper so PATH/python3 drift cannot pick a bare system interpreter.
cat >"$WRAPPER" <<EOF
#!/usr/bin/env bash
exec "${WHEP_PYTHON}" "${DEMUX_PY}" "\$@"
EOF
chmod 755 "$WRAPPER"

echo "[whep-deps] WHEP_PYTHON=${WHEP_PYTHON}"
echo "[whep-deps] WHEP_DEMUX_PATH=${WRAPPER}"

#!/usr/bin/env bash
# Install eve user systemd units (templates → ~/.config/systemd/user).
#
#   bash scripts/install-systemd.sh              # install + enable eve.target
#   bash scripts/install-systemd.sh --no-enable  # install only
#   bash scripts/install-systemd.sh --with-av    # also enable av-bridge
#   bash scripts/install-systemd.sh --with-rookery  # also enable rookery PDS (needs ~/rookery)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_SRC="$ROOT/systemd/user"
UNIT_DST="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
CONFIG_DIR="${EVE_CONFIG_DIR:-$HOME/.config/eve}"

ENABLE=1
WITH_AV=0
WITH_ROOKERY=0
for arg in "$@"; do
  case "$arg" in
    --no-enable) ENABLE=0 ;;
    --with-av) WITH_AV=1 ;;
    --with-rookery) WITH_ROOKERY=1 ;;
    -h | --help)
      sed -n '2,9p' "$0"
      exit 0
      ;;
    *)
      echo "unknown arg: $arg" >&2
      exit 2
      ;;
  esac
done

NODE="$(command -v node || true)"
NPX="$(command -v npx || true)"
if [ -z "$NODE" ] || [ -z "$NPX" ]; then
  echo "install-systemd: node and npx must be on PATH" >&2
  exit 1
fi
NODE_DIR="$(cd "$(dirname "$NODE")" && pwd)"

mkdir -p "$UNIT_DST" "$CONFIG_DIR" "$HOME/logs"
chmod 700 "$CONFIG_DIR"

echo "[install] root=$ROOT"
echo "[install] node=$NODE"
echo "[install] npx=$NPX"
echo "[install] units → $UNIT_DST"

UNITS=(
  eve-prep.service
  eve.service
  eve-irc-bridge.service
  eve-av-bridge.service
  eve-freeq-session-refresh.service
  eve-freeq-session-refresh.timer
  eve.target
)
if [ "$WITH_ROOKERY" -eq 1 ] || [ -d "$HOME/rookery" ]; then
  UNITS+=(rookery.service)
fi

for f in "${UNITS[@]}"; do
  src="$UNIT_SRC/$f"
  dst="$UNIT_DST/$f"
  if [ ! -f "$src" ]; then
    echo "missing template: $src" >&2
    exit 1
  fi
  sed \
    -e "s|@ROOT@|${ROOT//\\/\\\\}|g" \
    -e "s|@NODE@|${NODE//\\/\\\\}|g" \
    -e "s|@NPX@|${NPX//\\/\\\\}|g" \
    -e "s|@NODE_DIR@|${NODE_DIR//\\/\\\\}|g" \
    -e "s|@HOME@|${HOME//\\/\\\\}|g" \
    "$src" >"$dst"
  echo "[install] wrote $dst"
done

# Make scripts executable (repo may have lost +x).
chmod +x \
  "$ROOT/scripts/prep.sh" \
  "$ROOT/scripts/start.sh" \
  "$ROOT/scripts/run-av-bridge-service.sh" \
  "$ROOT/scripts/run-av-bridge.sh" \
  "$ROOT/scripts/fetch-keys.sh" \
  "$ROOT/scripts/refresh-freeq-session.sh" \
  "$ROOT/scripts/install-systemd.sh" 2>/dev/null || true

# Seed optional config files (do not overwrite secrets).
if [ ! -f "$CONFIG_DIR/openbao.env" ]; then
  cat >"$CONFIG_DIR/openbao.env.example" <<'EOF'
# Copy to openbao.env (mode 0600) and fill in:
#   cp ~/.config/eve/openbao.env.example ~/.config/eve/openbao.env
#   chmod 600 ~/.config/eve/openbao.env
OPENBAO_ADDR=https://openbao.boxd.sh
OPENBAO_TOKEN=
EOF
  echo "[install] wrote $CONFIG_DIR/openbao.env.example"
  if [ -n "${OPENBAO_ADDR:-}" ] && [ -n "${OPENBAO_TOKEN:-}" ]; then
    umask 077
    {
      printf 'OPENBAO_ADDR=%s\n' "$OPENBAO_ADDR"
      printf 'OPENBAO_TOKEN=%s\n' "$OPENBAO_TOKEN"
    } >"$CONFIG_DIR/openbao.env"
    chmod 600 "$CONFIG_DIR/openbao.env"
    echo "[install] wrote $CONFIG_DIR/openbao.env from current env"
  else
    echo "[install] create $CONFIG_DIR/openbao.env for boxd (see openbao.env.example)"
  fi
fi

if [ ! -f "$CONFIG_DIR/config.env" ]; then
  cat >"$CONFIG_DIR/config.env" <<'EOF'
# Optional non-secret overrides for eve units (systemd EnvironmentFile).
# IRC_NICK=eve
# IRC_CHANNEL=#test
# OPENCODE_MODEL=deepseek-v4-flash-free
EOF
  echo "[install] wrote $CONFIG_DIR/config.env"
fi
# Prefer a prebuilt av-bridge binary if present and not already configured.
if ! grep -qE '^EVE_AV_BRIDGE_BIN=' "$CONFIG_DIR/config.env" 2>/dev/null; then
  for cand in \
    "${EVE_AV_BRIDGE_BIN:-}" \
    "$HOME/.local/bin/eve-av-bridge" \
    "$HOME/bin/eve-av-bridge" \
    "$ROOT/bin/eve-av-bridge"; do
    if [ -n "$cand" ] && [ -x "$cand" ]; then
      echo "EVE_AV_BRIDGE_BIN=$cand" >>"$CONFIG_DIR/config.env"
      echo "[install] EVE_AV_BRIDGE_BIN=$cand"
      break
    fi
  done
fi
systemctl --user daemon-reload

if [ "$ENABLE" -eq 1 ]; then
  systemctl --user enable eve.target eve-prep.service eve.service eve-irc-bridge.service
  systemctl --user enable eve-freeq-session-refresh.timer
  echo "[install] enabled eve-freeq-session-refresh.timer (rook → freeq SASL every 5m)"
  if [ "$WITH_AV" -eq 1 ]; then
    systemctl --user enable eve-av-bridge.service
    echo "[install] enabled eve-av-bridge.service"
  fi
  if [ -f "$UNIT_DST/rookery.service" ] && { [ "$WITH_ROOKERY" -eq 1 ] || [ -d "$HOME/rookery" ]; }; then
    systemctl --user enable rookery.service
    echo "[install] enabled rookery.service (PDS :8787)"
  fi
  echo "[install] enabled eve.target (prep + eve + irc-bridge)"
fi

if ! loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q 'Linger=yes'; then
  echo "[install] note: user lingering is off — units stop on logout."
  echo "         enable with:  loginctl enable-linger $USER"
  echo "         (needs root/polkit; on boxd often already arranged)"
fi

echo
echo "Next:"
echo "  # ensure OpenBao creds (boxd):"
echo "  \$EDITOR $CONFIG_DIR/openbao.env && chmod 600 $CONFIG_DIR/openbao.env"
echo "  systemctl --user start eve.target"
echo "  systemctl --user start eve-freeq-session-refresh.timer"
echo "  systemctl --user status eve.service eve-irc-bridge.service"
echo "  systemctl --user list-timers eve-freeq-session-refresh.timer"
echo "  journalctl --user -u eve.service -u eve-irc-bridge.service -f"
echo "  # freeq SASL refresh log:"
echo "  tail -f ~/logs/freeq-session-refresh.log"
if [ "$WITH_AV" -eq 0 ]; then
  echo "  # optional AV:"
  echo "  systemctl --user enable --now eve-av-bridge.service"
fi

#!/usr/bin/env bash
# Refresh rook OAuth → freeq SASL session files.
# Invoked by systemd user timer: eve-freeq-session-refresh.timer
#
# Does NOT restart the IRC bridge on every tick — that was re-firing
# STREAMPLACE_AUTO and clobbering a user `watch` with the top-viewers stream.
# Restart only when the freeq access_token actually changes.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME="${HOME:-/home/boxd}"
export HOME
export PATH="${HOME}/.nvm/versions/node/v24.18.0/bin:${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin:${PATH}"

LOG_DIR="${EVE_LOG_DIR:-$HOME/logs}"
mkdir -p "$LOG_DIR"
LOG="${FREEQ_SESSION_REFRESH_LOG:-$LOG_DIR/freeq-session-refresh.log}"

SESSION_FILE="${IRC_FREEQ_SESSION:-$HOME/.config/freeq-tui/eve.boxd.sh.session.json}"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

token_fp() {
  local f="$1"
  if [ ! -f "$f" ]; then
    echo "missing"
    return
  fi
  # fingerprint access_token only (ignore nonce churn)
  node -e '
    const fs = require("fs");
    try {
      const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const t = j.access_token || j.accessJwt || "";
      const crypto = require("crypto");
      process.stdout.write(crypto.createHash("sha256").update(String(t)).digest("hex").slice(0, 16));
    } catch {
      process.stdout.write("unreadable");
    }
  ' "$f" 2>/dev/null || echo "unreadable"
}

{
  echo "[$(ts)] refresh start"

  if ! command -v npx >/dev/null 2>&1; then
    echo "[$(ts)] error: npx not on PATH ($PATH)"
    exit 1
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo "[$(ts)] error: node not on PATH"
    exit 1
  fi

  before="$(token_fp "$SESSION_FILE")"

  # establish or refresh headless OAuth
  npx --yes @solpbc/rook login --json

  # project freeq IRC SASL session files
  node "$ROOT/scripts/sync-freeq-session.mjs"

  after="$(token_fp "$SESSION_FILE")"
  echo "[$(ts)] token_fp before=$before after=$after"

  if [ "$before" != "$after" ]; then
    # Bridge reloads session on each connect; bounce only when token rotated so
    # a mid-session expiry can pick up the new SASL material promptly.
    if systemctl --user is-active eve-irc-bridge.service >/dev/null 2>&1; then
      systemctl --user try-restart eve-irc-bridge.service
      echo "[$(ts)] token changed — restarted eve-irc-bridge.service"
    else
      echo "[$(ts)] token changed — irc-bridge not active, skip restart"
    fi
  else
    echo "[$(ts)] token unchanged — leave irc-bridge running (preserves watch / AV)"
  fi

  echo "[$(ts)] refresh ok"
} >>"$LOG" 2>&1

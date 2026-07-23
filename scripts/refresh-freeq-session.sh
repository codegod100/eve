#!/usr/bin/env bash
# Refresh rook OAuth → freeq SASL session files.
# Invoked by systemd user timer: eve-freeq-session-refresh.timer
#
# Design:
#   - Always write a fresh freeq session.json to disk (tokens are short-lived).
#   - Never systemctl-restart the IRC bridge on token rotation — that drops the
#     freeq TCP session and thrashs AV / STREAMPLACE_AUTO / watch state.
#   - SASL only runs at IRC connect; connect() re-reads the session file.
#   - Soft-notify the bridge control HTTP: reload in-memory session; only
#     soft-reconnect if IRC is currently unhealthy (SASL fail / not joined).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME="${HOME:-/home/boxd}"
export HOME
export PATH="${HOME}/.nvm/versions/node/v24.18.0/bin:${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin:${PATH}"

LOG_DIR="${EVE_LOG_DIR:-$HOME/logs}"
mkdir -p "$LOG_DIR"
LOG="${FREEQ_SESSION_REFRESH_LOG:-$LOG_DIR/freeq-session-refresh.log}"

SESSION_FILE="${IRC_FREEQ_SESSION:-$HOME/.config/freeq-tui/eve.boxd.sh.session.json}"
CONTROL_HOST="${IRC_CONTROL_HOST:-127.0.0.1}"
CONTROL_PORT="${IRC_CONTROL_PORT:-8791}"
CONTROL_URL="http://${CONTROL_HOST}:${CONTROL_PORT}/session/reload"

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

# Soft-notify bridge: reload session from disk; reconnect only if unhealthy.
notify_bridge() {
  local reason="$1"
  local body
  body="$(printf '{"reason":%s}' "$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$reason")")"
  if ! command -v curl >/dev/null 2>&1; then
    echo "[$(ts)] bridge notify skipped — curl not on PATH"
    return 0
  fi
  local resp
  if resp="$(curl -sS -m 5 -X POST \
    -H 'content-type: application/json' \
    -d "$body" \
    "$CONTROL_URL" 2>&1)"; then
    echo "[$(ts)] bridge /session/reload → $resp"
  else
    echo "[$(ts)] bridge /session/reload failed (bridge down?) — $resp"
    echo "[$(ts)] disk session is still fresh; next IRC connect will pick it up"
  fi
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
    echo "[$(ts)] token changed — disk updated (no process restart)"
    notify_bridge "token-rotated"
  else
    echo "[$(ts)] token unchanged — still notify bridge in case IRC is unhealthy"
    notify_bridge "token-unchanged"
  fi

  echo "[$(ts)] refresh ok"
} >>"$LOG" 2>&1

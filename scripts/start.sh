#!/usr/bin/env bash
# Boot: OpenBao keys → freeq session → eve start → irc-bridge (background).
set -euo pipefail

export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[start] fetching keys from ${OPENBAO_ADDR:-<unset>} ..."
# shellcheck disable=SC1090
eval "$(bash "$ROOT/scripts/fetch-keys.sh")"
echo "[start] injected keys: $(env | grep -cE '^(FUGU|META|OLLAMA|OPENCODE|OPENROUTER|UMANS)_API_KEY=' || true)"

export OPENCODE_MODEL="${OPENCODE_MODEL:-deepseek-v4-flash-free}"

export IRC_HOST="${IRC_HOST:-irc.freeq.at}"
export IRC_PORT="${IRC_PORT:-6697}"
export IRC_TLS="${IRC_TLS:-1}"
export IRC_NICK="${IRC_NICK:-eve}"
export IRC_CHANNEL="${IRC_CHANNEL:-#test}"
export IRC_FREEQ_SESSION="${IRC_FREEQ_SESSION:-$HOME/.config/freeq-tui/eve.rookery.boxd.sh.session.json}"
export EVE_URL="${EVE_URL:-http://127.0.0.1:8000}"
export IRC_BACKLOG_MIN_MS="${IRC_BACKLOG_MIN_MS:-3000}"
export IRC_BACKLOG_GAP_MS="${IRC_BACKLOG_GAP_MS:-2000}"
export IRC_BACKLOG_MAX_MS="${IRC_BACKLOG_MAX_MS:-30000}"

echo "[start] model: ${OPENCODE_MODEL}"
echo "[start] irc: ${IRC_NICK}@${IRC_HOST} → ${IRC_CHANNEL} via bridge → ${EVE_URL}"

if command -v npx >/dev/null 2>&1; then
  echo "[start] rook login ..."
  npx --yes @solpbc/rook login || echo "[start] warning: rook login failed"
fi
if [ -f "$ROOT/scripts/sync-freeq-session.mjs" ]; then
  echo "[start] sync freeq session ..."
  node "$ROOT/scripts/sync-freeq-session.mjs" || echo "[start] warning: freeq session sync failed"
fi

echo "[start] building eve ..."
npx eve build

# IRC bridge (background). Waits for eve HTTP, then joins freeq.
echo "[start] launching irc-bridge ..."
nohup node "$ROOT/irc-bridge/server.mjs" >> /tmp/irc-bridge.log 2>&1 &
echo "[start] irc-bridge pid $! (log /tmp/irc-bridge.log)"

echo "[start] launching eve start on :8000 ..."
exec npx eve start --port 8000 --host 0.0.0.0

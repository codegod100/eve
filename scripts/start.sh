#!/usr/bin/env bash
# Boot: OpenBao keys → freeq session → eve start → irc-bridge (background).
set -euo pipefail

export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[start] fetching keys from ${OPENBAO_ADDR:-<unset>} ..."
# shellcheck disable=SC1090
eval "$(bash "$ROOT/scripts/fetch-keys.sh")"
echo "[start] injected keys: $(env | grep -cE '^(FUGU|META|OLLAMA|OPENCODE|OPENROUTER|UMANS|ANNA)_API_KEY=' || true)"
if [ -n "${ANNA_API_KEY:-}" ]; then
  echo "[start] ANNA_API_KEY present (Anna's Archive member JSON API)"
else
  echo "[start] ANNA_API_KEY missing — anna_download / anna_fast_download need a key"
fi
export ANNA_DOWNLOAD_DIR="${ANNA_DOWNLOAD_DIR:-$HOME/archive}"
mkdir -p "$ANNA_DOWNLOAD_DIR"
echo "[start] ANNA_DOWNLOAD_DIR=$ANNA_DOWNLOAD_DIR"

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

# annas-mcp for anna_search (ISBN/title → MD5)
if [ ! -x "${ANNAS_MCP_BIN:-$HOME/.local/bin/annas-mcp}" ]; then
  echo "[start] installing annas-mcp CLI ..."
  bash "$ROOT/scripts/install-annas-mcp.sh" || echo "[start] warning: annas-mcp install failed"
fi
export PATH="$HOME/.local/bin:$PATH"
if command -v annas-mcp >/dev/null 2>&1; then
  echo "[start] annas-mcp: $(command -v annas-mcp)"
else
  echo "[start] annas-mcp missing — anna_search will fail until install-annas-mcp.sh succeeds"
fi

echo "[start] building eve ..."
npx eve build

# IRC bridge (background). Waits for eve HTTP, then joins freeq.
echo "[start] launching irc-bridge ..."
nohup node "$ROOT/irc-bridge/server.mjs" >> /tmp/irc-bridge.log 2>&1 &
echo "[start] irc-bridge pid $! (log /tmp/irc-bridge.log)"

echo "[start] launching eve start on :8000 ..."
exec npx eve start --port 8000 --host 0.0.0.0

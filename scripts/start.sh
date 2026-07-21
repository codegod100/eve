#!/usr/bin/env bash
# Boot wrapper for the eve agent: pulls live keys from OpenBao, then execs eve dev.
# Keys are injected into eve's process env; they never touch disk in cleartext.
set -euo pipefail

# boxd exec runs with a minimal PATH; ensure core utils are findable.
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[start] fetching keys from ${OPENBAO_ADDR:-<unset>} ..."
# shellcheck disable=SC1090
eval "$(bash "$ROOT/scripts/fetch-keys.sh")"
echo "[start] injected keys: $(env | grep -cE '^(FUGU|META|OLLAMA|OPENCODE|OPENROUTER|UMANS)_API_KEY=' || true)"

# IRC channel config (agent/channels/irc.ts reads these).
# No password by default; set IRC_PASSWORD here or via openbao if the nick is registered.
export IRC_HOST="${IRC_HOST:-irc.freeq.at}"
export IRC_PORT="${IRC_PORT:-6697}"
export IRC_TLS="${IRC_TLS:-1}"
export IRC_NICK="${IRC_NICK:-eve}"
export IRC_CHANNEL="${IRC_CHANNEL:-#test}"
export IRC_FREEQ_SESSION="${IRC_FREEQ_SESSION:-$HOME/.config/freeq-tui/eve.rookery.boxd.sh.session.json}"
echo "[start] irc: ${IRC_NICK}@${IRC_HOST}:${IRC_PORT} (tls=${IRC_TLS:-1}) joining ${IRC_CHANNEL}"
echo "[start] freeq session: ${IRC_FREEQ_SESSION}"

# Keep freeq SASL fresh so nick stays "eve" (not Guest…). See skill freeq-irc.
if command -v npx >/dev/null 2>&1; then
  echo "[start] rook login (refresh OAuth if needed) ..."
  npx --yes @solpbc/rook login || echo "[start] warning: rook login failed (will try existing session)"
fi
if [ -f "$ROOT/scripts/sync-freeq-session.mjs" ]; then
  echo "[start] syncing freeq session from rook ..."
  node "$ROOT/scripts/sync-freeq-session.mjs" || echo "[start] warning: freeq session sync failed — IRC may join as Guest"
fi

# Production start so Nitro runs schedules (e.g. vit-request-caps every 10m).
# `eve dev` never fires cron; use `npx eve dev` locally when iterating.
echo "[start] building eve app ..."
npx eve build
echo "[start] launching eve start on :8000 (schedules enabled) ..."
exec npx eve start --port 8000 --host 0.0.0.0

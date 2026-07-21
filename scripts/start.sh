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
export IRC_NICK="${IRC_NICK:-eve-agent}"
export IRC_CHANNEL="${IRC_CHANNEL:-#test}"
echo "[start] irc: ${IRC_NICK}@${IRC_HOST}:${IRC_PORT} (tls=${IRC_TLS:-1}) joining ${IRC_CHANNEL}"

echo "[start] launching eve dev on :8000 ..."
exec npx eve dev --no-ui --port 8000 --host 0.0.0.0

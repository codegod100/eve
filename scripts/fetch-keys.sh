#!/usr/bin/env bash
# Fetch AI API keys from OpenBao KV v2 and emit `export KEY=VALUE` lines on stdout.
# Used by scripts/prep.sh (and legacy start). Requires OPENBAO_ADDR + OPENBAO_TOKEN.
set -euo pipefail

# boxd exec runs with a minimal PATH; ensure core utils are findable.
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

: "${OPENBAO_ADDR:?OPENBAO_ADDR must be set}"
: "${OPENBAO_TOKEN:?OPENBAO_TOKEN must be set}"

URL="$OPENBAO_ADDR/v1/secret/data/ai-api-keys"
RESP=$(curl -fsS -H "X-Vault-Token: $OPENBAO_TOKEN" "$URL") || {
  echo "fetch-keys: failed to read $URL from $OPENBAO_ADDR" >&2
  exit 1
}

# KV v2 wraps data under .data.data ; emit one shell-safe export per key.
jq -r '.data.data | to_entries[] | "export \(.key)=\"\(.value|tostring)\""' <<<"$RESP"

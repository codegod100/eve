#!/usr/bin/env bash
# One-shot prep for the eve stack: OpenBao keys, freeq session, annas-mcp,
# eve build, and a systemd EnvironmentFile at ~/.config/eve/runtime.env.
#
# Used by eve-prep.service and by start.sh (legacy / non-systemd path).
set -euo pipefail

export PATH="${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CONFIG_DIR="${EVE_CONFIG_DIR:-$HOME/.config/eve}"
RUNTIME_ENV="${EVE_RUNTIME_ENV:-$CONFIG_DIR/runtime.env}"
mkdir -p "$CONFIG_DIR"
mkdir -p "${XDG_RUNTIME_DIR:-/tmp}/eve" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Collect env into a temp file, then install as runtime.env (mode 0600).
# Format: KEY=VALUE (systemd EnvironmentFile — no `export`, no spaces around =).
# ---------------------------------------------------------------------------
tmp="$(mktemp)"
chmod 600 "$tmp"
cleanup() { rm -f "$tmp"; }
trap cleanup EXIT

env_set() {
  local key="$1" value="$2"
  # Escape backslashes and double quotes for EnvironmentFile.
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  # Drop any prior line for this key (last write wins when we append).
  if grep -q "^${key}=" "$tmp" 2>/dev/null; then
    grep -v "^${key}=" "$tmp" >"${tmp}.n" && mv "${tmp}.n" "$tmp"
  fi
  printf '%s="%s"\n' "$key" "$value" >>"$tmp"
}

# Optional operator overrides already on the process env (config.env is loaded
# by systemd before this script runs).
load_existing_exports() {
  # If a previous runtime.env exists and we are re-running without OpenBao,
  # keep non-key defaults only — keys are refreshed below when possible.
  :
}

load_existing_exports

# --- OpenBao API keys -------------------------------------------------------
if [ -n "${OPENBAO_ADDR:-}" ] && [ -n "${OPENBAO_TOKEN:-}" ]; then
  echo "[prep] fetching keys from ${OPENBAO_ADDR} ..."
  # fetch-keys emits shell-safe `export KEY="value"` lines (same as start.sh).
  keys_sh="$(bash "$ROOT/scripts/fetch-keys.sh")"
  # shellcheck disable=SC1090
  eval "$keys_sh"
  key_count=0
  while IFS= read -r key; do
    [ -z "$key" ] && continue
    env_set "$key" "${!key}"
    key_count=$((key_count + 1))
  done < <(printf '%s\n' "$keys_sh" | sed -n 's/^export \([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p')
  echo "[prep] injected keys: ${key_count}"
else
  echo "[prep] OPENBAO_ADDR/TOKEN unset — skipping key fetch (using process env if any)"
  for k in FUGU_API_KEY META_API_KEY OLLAMA_API_KEY OPENCODE_API_KEY \
    OPENROUTER_API_KEY UMANS_API_KEY ANNA_API_KEY LINEAR_API_KEY; do
    if [ -n "${!k:-}" ]; then
      env_set "$k" "${!k}"
    fi
  done
fi

if [ -n "${ANNA_API_KEY:-}" ]; then
  echo "[prep] ANNA_API_KEY present"
else
  echo "[prep] ANNA_API_KEY missing — anna_download / anna_fast_download need a key"
fi
if [ -n "${LINEAR_API_KEY:-}" ]; then
  echo "[prep] LINEAR_API_KEY present"
else
  echo "[prep] LINEAR_API_KEY missing — linear_* tools need a key"
fi

# --- Defaults (operator config.env / process env win if already set) --------
set_default() {
  local key="$1" default="$2"
  local cur="${!key:-}"
  if [ -n "$cur" ]; then
    env_set "$key" "$cur"
  else
    env_set "$key" "$default"
    export "${key}=${default}"
  fi
}

set_default ANNA_DOWNLOAD_DIR "${HOME}/archive"
mkdir -p "${ANNA_DOWNLOAD_DIR}"
echo "[prep] ANNA_DOWNLOAD_DIR=${ANNA_DOWNLOAD_DIR}"

set_default OPENCODE_MODEL "deepseek-v4-flash-free"
set_default IRC_HOST "irc.freeq.at"
set_default IRC_PORT "6697"
set_default IRC_TLS "1"
set_default IRC_NICK "eve"
set_default IRC_CHANNEL "#test"
set_default IRC_FREEQ_SESSION \
  "${HOME}/.config/freeq-tui/eve.boxd.sh.session.json"
set_default EVE_URL "http://127.0.0.1:8000"
set_default IRC_BACKLOG_MIN_MS "3000"
set_default IRC_BACKLOG_GAP_MS "2000"
set_default IRC_BACKLOG_MAX_MS "30000"
set_default AV_BRIDGE_URL "http://127.0.0.1:8790"
set_default AV_BRIDGE_BIND "127.0.0.1:8790"
set_default RADIO_TITLE_HOOK "http://127.0.0.1:8791/radio/now-playing"
set_default MEMORY_BANK_PATH "${HOME}/memory-bank.txt"

# PATH for services (annas-mcp, ffmpeg, etc.)
env_set PATH "${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin"
env_set HOME "${HOME}"
env_set EVE_ROOT "${ROOT}"

echo "[prep] model: ${OPENCODE_MODEL}"
echo "[prep] irc: ${IRC_NICK}@${IRC_HOST} → ${IRC_CHANNEL} via bridge → ${EVE_URL}"

# --- freeq / rook session ---------------------------------------------------
if command -v npx >/dev/null 2>&1; then
  echo "[prep] rook login ..."
  npx --yes @solpbc/rook login || echo "[prep] warning: rook login failed"
fi
if [ -f "$ROOT/scripts/sync-freeq-session.mjs" ]; then
  echo "[prep] sync freeq session ..."
  node "$ROOT/scripts/sync-freeq-session.mjs" || echo "[prep] warning: freeq session sync failed"
fi
# AT Protocol handle verification for eve.boxd.sh (agent channel atproto-wellknown)
if [ -f "${HOME}/.config/rook/identity.json" ]; then
  ATPROTO_DID="$(node -e "const i=require(process.env.HOME+'/.config/rook/identity.json'); process.stdout.write(i.did||'')" 2>/dev/null || true)"
  if [ -n "${ATPROTO_DID}" ]; then
    env_set ATPROTO_DID "${ATPROTO_DID}"
    export ATPROTO_DID
    echo "[prep] ATPROTO_DID=${ATPROTO_DID}"
  fi
fi

# --- annas-mcp --------------------------------------------------------------
if [ ! -x "${ANNAS_MCP_BIN:-$HOME/.local/bin/annas-mcp}" ]; then
  echo "[prep] installing annas-mcp CLI ..."
  bash "$ROOT/scripts/install-annas-mcp.sh" || echo "[prep] warning: annas-mcp install failed"
fi
if command -v annas-mcp >/dev/null 2>&1; then
  echo "[prep] annas-mcp: $(command -v annas-mcp)"
  env_set ANNAS_MCP_BIN "$(command -v annas-mcp)"
else
  echo "[prep] annas-mcp missing — anna_search will fail until install-annas-mcp.sh succeeds"
fi

# --- eve build --------------------------------------------------------------
echo "[prep] building eve ..."
npx eve build

# --- install runtime.env ----------------------------------------------------
cp "$tmp" "$RUNTIME_ENV"
chmod 600 "$RUNTIME_ENV"
echo "[prep] wrote ${RUNTIME_ENV}"

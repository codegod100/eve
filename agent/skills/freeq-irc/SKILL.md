---
name: freeq-irc
description: >-
  Fix freeq IRC nick / SASL auth for this agent. Use when the bot shows as
  Guest…, freeq/guest, wrong nick, SASL failed (904), expired freeq session,
  "nick is incorrect", or after hibernate/wake when IRC identity is broken.
  Covers rook login → freeq session sync → agent restart on the eve boxd VM.
---

# freeq IRC identity (nick + SASL)

## Symptom → cause

| You see | Cause |
|---------|--------|
| Nick `Guest…` or host `freeq/guest` | SASL `ATPROTO-CHALLENGE` failed; freeq force-renames unauthenticated clients off reserved DID nicks |
| Log: `SASL failed (904)` | Freeq session OAuth token invalid/expired |
| Log: `Invalid OAuth access token` on getSession | Same — freeq `*.session.json` is stale |
| Wanted nick `eve` but not authenticated as `did:plc:fdiivi2izdgx3rl2d4qedt7n` | Session missing or not loaded |

Correct state after fix:

```text
[irc-bridge] SASL success as did:plc:fdiivi2izdgx3rl2d4qedt7n
[irc-bridge] welcome 001 nick=eve preferred=eve sasl=ok
[irc-bridge] joined #test as eve
```

Bridge behavior (irc-bridge/server.mjs): always registers as `IRC_NICK` (`eve`),
reclaims that nick after SASL if freeq force-renamed us, refuses to stay as
`Guest*` when auth is required, and reloads the freeq session on every reconnect.

## Identity map

| Field | Value |
|-------|--------|
| Handle | `eve.boxd.sh` |
| DID | `did:plc:fdiivi2izdgx3rl2d4qedt7n` |
| PDS | `https://pds.eve.boxd.sh` (rookery unit on eve) |
| IRC nick | `eve` (`IRC_NICK`) |
| Channel | `#test` (`IRC_CHANNEL`) |
| Host | `irc.freeq.at:6697` TLS |

## Files (on the eve VM: `boxd` user)

| Path | Role |
|------|------|
| `~/.config/rook/identity.json` | Rook identity (DID, handle, keys) |
| `~/.config/rook/identity.session.json` | Headless OAuth session (refreshable via `rook login`) |
| `~/.config/freeq-tui/eve.boxd.sh.session.json` | **Primary** freeq SASL session (`IRC_FREEQ_SESSION`) |
| `~/.config/freeq/eve.boxd.sh.session.json` | Fallback freeq session path |
| `~/.config/freeq/eve.session.json` | Older fallback |
| `/home/boxd/rookery` + `rookery.service` | Single-user PDS (`pds.eve.boxd.sh:8787`) |
| `/home/boxd/my-agent/scripts/prep.sh` | Prep oneshot (OpenBao keys, freeq session, build) |
| `~/.config/systemd/user/eve*.service` | User units for agent + IRC bridge (+ optional AV) |
| `/home/boxd/my-agent/agent/channels/irc.ts` | IRC channel wiring (HTTP inbound only; socket is bridge) |

Freeq session JSON shape:

```json
{
  "did": "did:plc:…",
  "handle": "eve.boxd.sh",
  "access_token": "rkat_…",
  "pds_url": "https://pds.eve.boxd.sh",
  "dpop_key": "<JWK d / 32-byte P-256 scalar base64url>",
  "dpop_nonce": null
}
```

`dpop_key` must match the DPoP key that bound the access token (from rook `dpopJwk.d`).

## Fix procedure (agent-runnable on the VM)

Run from a shell on the **eve** boxd VM (`boxd exec eve -- bash -lc '…'` from outside, or already on-box).

### 1. Refresh rook OAuth

```bash
npx --yes @solpbc/rook login
npx --yes @solpbc/rook doctor   # session-restore-expiry should be ok, not expired
```

### 2. Sync freeq session from rook tokens

Prefer the packaged script (repo / skill):

```bash
node /home/boxd/my-agent/scripts/sync-freeq-session.mjs
# or from this skill package once installed:
# node "$HOME/.agents/skills/freeq-irc/scripts/sync-freeq-session.mjs"
```

If the script is missing, equivalent logic: read `identity.session.json` → take `access_token` + `dpopJwk.d` → write the freeq session files above (mode `0600`) → verify with DPoP `GET {pds}/xrpc/com.atproto.server.getSession` expecting HTTP 200.

### 3. Soft-reload session (prefer) or restart bridge

IRC sockets live in `irc-bridge/server.mjs`, not in the eve process.
Token refresh should **not** process-restart the bridge when IRC is healthy —
that drops AV / watch. Soft-reload re-reads session.json and only reconnects
if SASL/join is broken.

```bash
# preferred: soft reload (no process restart)
curl -sS -X POST http://127.0.0.1:8791/session/reload \
  -H 'content-type: application/json' \
  -d '{"reason":"operator-sasl-fix"}'
# or force a reconnect even when healthy:
# curl -sS -X POST 'http://127.0.0.1:8791/session/reload?force=1'

# timer path (same soft reload, every 5m when unit is enabled):
systemctl --user start eve-freeq-session-refresh.service
tail -n 20 ~/logs/freeq-session-refresh.log

# only if the bridge process itself is wedged:
systemctl --user restart eve-irc-bridge.service
# logs (journal may be empty on boxd — file log is authoritative):
tail -n 40 ~/logs/irc-bridge.log

# legacy (no units): kill old bridge pid if any, then:
EVE_URL=http://127.0.0.1:8000 nohup node irc-bridge/server.mjs >> /tmp/irc-bridge.log 2>&1 &
grep -E 'SASL success|joined |SASL failed|SSE' /tmp/irc-bridge.log | tail -10
```

Success in bridge log: `SASL success as did:plc:…` and `joined #test as eve`, plus `SSE connected`.

### 4. One-liner (from laptop)

```bash
boxd exec eve -- bash -lc 'npx --yes @solpbc/rook login && node /home/boxd/my-agent/scripts/sync-freeq-session.mjs && curl -sS -X POST http://127.0.0.1:8791/session/reload -H "content-type: application/json" -d "{\"reason\":\"laptop-fix\"}"'
```

## Do not

- Invent OAuth tokens or paste secrets into IRC replies.
- Scrape freeq HTML for auth.
- Change nick to a random suffix permanently — fix SASL instead of living as `Guest…`.
- Commit session JSON or tokens to git.

## Prevention

- Access tokens expire ~hours. Keep `eve-freeq-session-refresh.timer` **enabled** — it writes fresh session.json and soft-notifies the bridge; it does **not** restart the process on every rotation.
- On boot, `eve-prep.service` / `scripts/prep.sh` runs `rook login` + `sync-freeq-session.mjs` before agent and bridge.
- After **hibernate → wake**, TCP to freeq is often half-dead: `curl -X POST http://127.0.0.1:8791/session/reload -d '{"force":true}'` (or restart the unit if control HTTP is dead).
- Keep `openbao` reachable if keys come from OpenBao at prep (`~/.config/eve/openbao.env`).
- `IRC_REQUIRE_AUTH` defaults on for freeq hosts: bridge will not sit in `#test` as `Guest*`; it reconnects until SASL lands `eve`.

## Related

- IRC channel source: `agent/channels/irc.ts` (freeq session + ATPROTO-CHALLENGE)
- rook CLI: `rook whoami`, `rook doctor`, `rook login` — https://rook.host/llms.txt
- freeq: SASL `ATPROTO-CHALLENGE` method `pds-oauth`

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
| Wanted nick `eve` but not authenticated as `did:plc:76szbe2ywgwb7vzuingj4fhq` | Session missing or not loaded |

Correct state after fix:

```text
[irc] SASL success as did:plc:76szbe2ywgwb7vzuingj4fhq
[irc] joined #test on irc.freeq.at as eve
```

## Identity map

| Field | Value |
|-------|--------|
| Handle | `eve.rookery.boxd.sh` |
| DID | `did:plc:76szbe2ywgwb7vzuingj4fhq` |
| PDS | `https://rookery.boxd.sh` |
| IRC nick | `eve` (`IRC_NICK`) |
| Channel | `#test` (`IRC_CHANNEL`) |
| Host | `irc.freeq.at:6697` TLS |

## Files (on the eve VM: `boxd` user)

| Path | Role |
|------|------|
| `~/.config/rook/identity.json` | Rook identity (DID, handle, keys) |
| `~/.config/rook/identity.session.json` | Headless OAuth session (refreshable via `rook login`) |
| `~/.config/freeq-tui/eve.rookery.boxd.sh.session.json` | **Primary** freeq SASL session (`IRC_FREEQ_SESSION`) |
| `~/.config/freeq/eve.rookery.boxd.sh.session.json` | Fallback freeq session path |
| `~/.config/freeq/eve.session.json` | Older fallback |
| `/home/boxd/start.sh` | Boot: OpenBao keys + IRC env + `eve dev` |
| `/home/boxd/my-agent/agent/channels/irc.ts` | IRC client (loads freeq session, SASL pds-oauth) |

Freeq session JSON shape:

```json
{
  "did": "did:plc:…",
  "handle": "eve.rookery.boxd.sh",
  "access_token": "rkat_…",
  "pds_url": "https://rookery.boxd.sh",
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

### 3. Restart the agent so IRC reconnects with SASL

```bash
# kill existing eve node (by pid from ps; avoid pkill -f self-match)
# then:
nohup /home/boxd/start.sh > /tmp/eve-start.log 2>&1 &
# wait ~10s, then:
grep -E 'SASL success|joined |SASL failed' /tmp/eve-start.log | tail -5
```

Success requires **both** `SASL success as did:plc:…` and `joined #test … as eve`.

### 4. One-liner (from laptop)

```bash
boxd exec eve -- bash -lc 'npx --yes @solpbc/rook login && node /home/boxd/my-agent/scripts/sync-freeq-session.mjs && echo synced'
# then restart agent (step 3)
```

## Do not

- Invent OAuth tokens or paste secrets into IRC replies.
- Scrape freeq HTML for auth.
- Change nick to a random suffix permanently — fix SASL instead of living as `Guest…`.
- Commit session JSON or tokens to git.

## Prevention

- Access tokens expire ~hours. On boot, `start.sh` should run `rook login` + `sync-freeq-session.mjs` before `eve dev` (if not already wired, do it when fixing nick again).
- After **hibernate → wake**, TCP to freeq is often half-dead: restart the agent even if tokens are still valid.
- Keep `openbao` reachable if keys come from OpenBao at start.

## Related

- IRC channel source: `agent/channels/irc.ts` (freeq session + ATPROTO-CHALLENGE)
- rook CLI: `rook whoami`, `rook doctor`, `rook login` — https://rook.host/llms.txt
- freeq: SASL `ATPROTO-CHALLENGE` method `pds-oauth`

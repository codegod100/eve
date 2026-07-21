---
name: vit-request-watch
description: >-
  Poll explore.v-it.org for kind:request caps on beacons this agent controls
  and report findings to IRC. Use when debugging the vit-request-caps schedule,
  tuning VIT_CONTROLLED_BEACONS, or manually checking request caps for our
  beacons. Activates on "request caps", "vit request watch", "controlled
  beacons", or schedule vit-request-caps.
---

# vit request-cap watch

## What it does

Every **10 minutes** the schedule `vit-request-caps` (`agent/schedules/vit-request-caps.ts`):

1. `GET https://explore.v-it.org/api/caps?kind=request&limit=50`
2. Keeps caps whose `beacon` is in the controlled set
3. Posts a single-line summary to IRC (`IRC_CHANNEL`, default `#test` on `irc.freeq.at`)

## Controlled beacons

| Source | Env |
|--------|-----|
| Explicit list | `VIT_CONTROLLED_BEACONS` (comma-separated full beacon URIs) |
| Owner fragments | `VIT_CONTROLLED_BEACON_OWNERS` (default: `codegod100`) |
| Empty reports | `VIT_REQUEST_REPORT_EMPTY=1` to also announce "none found" |

Defaults (when env unset): `vit:github.com/codegod100/{zellij-right-click-tab,obsidian-myst,letta-chat,lnk,zellij}` plus any beacon containing `codegod100`.

## Manual check (bash)

```bash
vit explore caps --kind request --json --limit 50
# or
curl -sS 'https://explore.v-it.org/api/caps?kind=request&limit=50'
```

Filter to controlled beacons, then one IRC line:

```text
vit request-caps (N): ref "title" @ host/path by handle | …
```

## Dev fire (once)

`eve dev` does **not** run cron. Trigger once:

```bash
curl -X POST http://127.0.0.1:8000/eve/v1/dev/schedules/vit-request-caps
```

Production: `eve build && eve start` so Nitro's schedule runner fires `*/10 * * * *`.

## Related

- Skill `vit` / using-vit for the full CLI
- Channel `irc` receive target: `{ channel: "#test" }`

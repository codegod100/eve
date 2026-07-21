# eve-agent

[eve.dev](https://eve.dev) agent deployed on [eve.boxd.sh](https://eve.boxd.sh).

- **Model**: OpenCode Zen `deepseek-v4-flash-free` (OpenAI-compatible Chat Completions)
- **Channels**: built-in eve channel + IRC via **irc-bridge** (POST `/irc/inbound` + SSE `/irc/out`)
- **Tools**: cowsay, ATProto (`lookup_did`, `get_recent_posts`), [rook.host](https://rook.host/) / [thermals.cloud](https://thermals.cloud) board + CLI, Anna's Archive (`anna_torrents`, `anna_record`, `anna_fast_download`)
- **Skills**: `vit` (using-vit CLI), `vit-request-watch` (request-cap poll), `anna` (Anna's Archive / llms.txt), `freeq-irc` (IRC nick / SASL session refresh), `irc-backlog` (ignore channel history on JOIN)
- **Schedules**: `vit-request-caps` every 10m → explore kind:request on controlled beacons → IRC `#test`
- **Secrets**: API keys pulled live from OpenBao (`openbao.boxd.sh`) via `scripts/fetch-keys.sh` — never committed

## Layout

```
agent/
  agent.ts           # model + agent definition
  instructions.md
  channels/          # eve.ts, irc.ts (HTTP+SSE only — no IRC socket)
  lib/ tools/ skills/ schedules/
irc-bridge/
  server.mjs         # freeq IRC → POST /irc/inbound ; SSE /irc/out → PRIVMSG
scripts/
  fetch-keys.sh, start.sh, sync-freeq-session.mjs
flake.nix
```

## rook.host tools

Public (no identity):

| Tool | Purpose |
|------|---------|
| `thermals_stats` | Board totals |
| `thermals_requests` / `thermals_request` | Open work requests |
| `thermals_rook` | Profile + track record by did/handle |
| `thermals_leaderboard` | Ranked rooks |

Local CLI ([`@solpbc/rook`](https://www.npmjs.com/package/@solpbc/rook)):

| Tool | Purpose |
|------|---------|
| `rook_whoami` / `rook_doctor` | Identity + readiness |
| `rook_enroll` | Enroll with human invite URL + handle |
| `rook_profile` | Show / publish / remove thermals profile |
| `rook_submit` | fork → push → pr → ship from a local clone |

Optional env: `ROOK_IDENTITY_FILE`, `THERMALS_URL` (default `https://thermals.cloud`).

Agent-facing docs: https://rook.host/llms.txt · https://thermals.cloud/llms.txt

## Anna's Archive tools

Programmatic access only — see [llms.txt](https://annas-archive.gl/llms.txt). No HTML search scraping; no public title-search API.

| Tool | Purpose |
|------|---------|
| `anna_torrents` | Filter public `/dyn/torrents.json` (in-memory cache ~30m) |
| `anna_record` | Unified metadata for one MD5 |
| `anna_fast_download` | Member `/dyn/api/fast_download.json` URL |

| Variable | Default / notes |
|----------|-----------------|
| `ANNA_ARCHIVE_BASE` | `https://annas-archive.gl` |
| `ANNA_ARCHIVE_SECRET_KEY` | Membership secret key (optional; for fast downloads) |

Skill: `load_skill` → `anna`.

## freeq IRC nick / SASL

If the bot appears as `Guest…` or logs `SASL failed (904)`, the freeq OAuth session expired.

```bash
# on the eve VM
npx --yes @solpbc/rook login
node scripts/sync-freeq-session.mjs   # or /home/boxd/my-agent/scripts/…
# restart agent (start.sh)
```

Skill: `load_skill` → `freeq-irc`. Target nick: `eve` / `eve.rookery.boxd.sh`.

## Local dev

```bash
nix develop          # or: direnv allow
npm install
export OPENCODE_API_KEY=…   # or other provider keys
npm run dev
```

## Boxd (eve.boxd.sh)

On the VM, secrets come from OpenBao:

```bash
export OPENBAO_ADDR=https://openbao.boxd.sh
export OPENBAO_TOKEN=…      # boxd secret / service token
npm install
npm run boxd:start          # scripts/start.sh
```

Optional IRC env (defaults match freeq):

| Variable | Default |
|----------|---------|
| `IRC_HOST` | `irc.freeq.at` |
| `IRC_PORT` | `6697` |
| `IRC_TLS` | `1` |
| `IRC_NICK` | `eve-agent` |
| `IRC_CHANNEL` | `#test` |
| `IRC_PASSWORD` | (unset) |
| `IRC_OWNERS` | (unset) |

### vit request-cap schedule

| Variable | Default |
|----------|---------|
| `VIT_CONTROLLED_BEACONS` | codegod100 repo beacons (comma-separated overrides) |
| `VIT_CONTROLLED_BEACON_OWNERS` | `codegod100` (substring match on beacon) |
| `VIT_REQUEST_REPORT_EMPTY` | unset = quiet when no matches; `1` = always report |
| `VIT_EXPLORE_URL` | `https://explore.v-it.org` |

`npm run boxd:start` runs `eve build && eve start` so the cron fires. Locally with `eve dev`, fire once:

```bash
curl -X POST http://127.0.0.1:8000/eve/v1/dev/schedules/vit-request-caps
```

## Framework docs

See `node_modules/eve/docs/` or https://eve.dev/docs.

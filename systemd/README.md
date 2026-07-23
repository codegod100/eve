# eve systemd units (user)

Long-running processes are supervised by **systemd user units**, not `nohup`.

| Unit | Role |
|------|------|
| `eve-prep.service` | oneshot: OpenBao keys, freeq session, annas-mcp, `eve build` → `~/.config/eve/runtime.env` |
| `eve.service` | agent HTTP `:8000` (+ `/.well-known/atproto-did` for handle `eve.boxd.sh`) |
| `eve-irc-bridge.service` | freeq IRC ↔ eve (restart always) |
| `eve-freeq-session-refresh.timer` | every 5m: `rook login` → sync freeq SASL session → restart IRC bridge |
| `eve-freeq-session-refresh.service` | oneshot body of the timer |
| `eve-av-bridge.service` | optional MoQ / radio media plane |
| `rookery.service` | single-user PDS (`wrangler dev` on `:8787`, public `pds.eve.boxd.sh`) |
| `eve.target` | groups prep + agent + IRC bridge |

Identity: handle **`eve.boxd.sh`**, PDS **`https://pds.eve.boxd.sh`**, DID from `~/.config/rook/identity.json`.

## Install (boxd or local)

```bash
# from the agent checkout
bash scripts/install-systemd.sh
# optional radio/AV:
bash scripts/install-systemd.sh --with-av
# optional PDS (installs when ~/rookery exists, or force with --with-rookery):
bash scripts/install-systemd.sh --with-rookery

# OpenBao creds for prep (boxd)
cp ~/.config/eve/openbao.env.example ~/.config/eve/openbao.env
chmod 600 ~/.config/eve/openbao.env
# edit OPENBAO_TOKEN=…

# survive logout / reboot (once per machine)
loginctl enable-linger "$USER"

systemctl --user start eve.target
```

`npm run boxd:start` / `scripts/start.sh` will **start/restart the units** when they are installed; use `--legacy` for the old foreground path, or `--install` to install then start.

## Ops

```bash
systemctl --user status eve.target
systemctl --user restart eve-irc-bridge.service   # after freeq session sync
systemctl --user restart eve.service
systemctl --user stop eve.target                  # stop agent + bridge

journalctl --user -u eve.service -u eve-irc-bridge.service -f
```

### After SASL / Guest nick fix

```bash
npx --yes @solpbc/rook login
node scripts/sync-freeq-session.mjs
systemctl --user restart eve-irc-bridge.service
```


### freeq SASL session refresh (systemd timer)

Access tokens are short-lived. The timer keeps IRC SASL working:

```bash
systemctl --user status eve-freeq-session-refresh.timer
systemctl --user start eve-freeq-session-refresh.service   # run once now
systemctl --user list-timers eve-freeq-session-refresh.timer
tail -f ~/logs/freeq-session-refresh.log
```

`scripts/refresh-freeq-session.sh` runs `rook login --json`, writes freeq
session files via `sync-freeq-session.mjs`, then `try-restart`s
`eve-irc-bridge.service` so the bridge re-SASLs without a Guest nick.

If refresh fails with an expired rook session, re-auth once:

```bash
npx --yes @solpbc/rook login
systemctl --user start eve-freeq-session-refresh.service
```

### Config files (`~/.config/eve/`)

| File | Purpose |
|------|---------|
| `openbao.env` | `OPENBAO_ADDR`, `OPENBAO_TOKEN` (prep only; mode `0600`) |
| `config.env` | optional non-secret overrides (`IRC_*`, `OPENCODE_MODEL`, …) |
| `runtime.env` | **written by prep** — API keys + defaults for services |

Templates live in `systemd/user/`; install substitutes `@ROOT@`, `@NODE@`, `@NPX@`.

## Layout

```
systemd/user/*.service   # templates (not live units)
scripts/install-systemd.sh
scripts/prep.sh
scripts/run-av-bridge-service.sh
scripts/start.sh         # systemctl if installed, else legacy
```

### stream.place MoQ plane (additional)

Second `eve-av-bridge` on `127.0.0.1:8792` rebroadcasts a stream.place live
stream into freeq AV (default `#test`). Auto-starts when `STREAMPLACE_AUTO=1`
in `~/.config/eve/config.env`.

**One MoQ plane per freeq session:** the IRC bridge only keeps a single media
plane attached at a time. Starting radio or stream.place disconnects the other
plane and `av-leave`s prior `eve~instance` roster rows so freeq never sees two
eve publishers in the same call.

| Unit / endpoint | Role |
|-----------------|------|
| `eve-av-bridge-streamplace.service` | MoQ media plane `:8792` |
| `POST /streamplace/play` (irc-bridge `:8791`) | pick top-viewers stream (or body.streamer) + join AV |
| `POST /streamplace/stop` | stop rebroadcast + disconnect plane |
| `GET /streamplace/status` | plane health + top live |

```bash
systemctl --user status eve-av-bridge-streamplace.service
curl -sS http://127.0.0.1:8791/streamplace/status | jq .
curl -sS -X POST http://127.0.0.1:8791/streamplace/play -H 'content-type: application/json' -d '{}'
curl -sS -X POST http://127.0.0.1:8791/streamplace/stop
```

Picks `place.stream.live.getLiveUsers` sorted by `viewerCount`, plays HLS via
`place.stream.playback.getLivePlaylist?streamer=<did>` through ffmpeg → MoQ.

### stream.place publish plane (inverse / call rebroadcast)

Egress only: freeq radio / a media URL → **RTMP** into stream.place (not a freeq
MoQ attach). Managed by **irc-bridge** via ffmpeg; can run while a freeq plane
is live.

| Endpoint | Role |
|----------|------|
| `POST /streamplace/publish` | default **call mix** (freeq room → RTMP); or `mode:audio|av` + url |
| `POST /streamplace/publish/stop` | stop ffmpeg publish |
| `GET /streamplace/publish/status` | publishing?, pid, source |

Config in `~/.config/eve/config.env` (mode `0600`):

```bash
STREAMPLACE_STREAM_KEY=…          # Live Dashboard → Generate Stream Key
STREAMPLACE_RTMP_URL=rtmps://stream.place:1935/live   # default
STREAMPLACE_PUBLISH_HANDLE=eve.boxd.sh                # optional notice URL
```

```bash
# after freeq radio is playing:
curl -sS -X POST http://127.0.0.1:8791/streamplace/publish \
  -H 'content-type: application/json' -d '{}'
curl -sS http://127.0.0.1:8791/streamplace/publish/status | jq .
```

Channel: `eve: go live` / `eve: stop live`. Tool: `publish_stream`.

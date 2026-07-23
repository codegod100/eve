# irc-bridge

Standalone IRC client. Eve never opens an IRC socket.

```
irc.freeq.at  ←TLS→  irc-bridge  ──POST /irc/inbound──►  eve :8000
                              ◄──SSE  /irc/out──────────  eve
```

1. Channel PRIVMSGs after JOIN are ignored until the join backlog ends
   (`IRC_BACKLOG_*` min/gap/max). Live lines after that go into a per-target
   ring buffer (`IRC_CONTEXT_LINES`, default 40).
2. A live mention → bridge immediately 👀-reacts (TAGMSG `+react` /
   `+reply=<msgid>`), then `POST`s `{from,target,text,msgid,context}` to eve.
   `context` is **one framed** `<irc_channel_context>` blob (background only),
   not raw per-line history — eve injects context as `role:user`, so framing
   + instructions tell the model not to answer scrollback.
3. Eve runs the agent turn: background blob (if any) + current mention only.
4. On `message.completed`, eve pushes an SSE `privmsg` event.
5. Bridge reads SSE and sends `PRIVMSG` on IRC (and records own replies in
   the ring buffer).

## Run

```bash
# after freeq session is valid (rook login + sync-freeq-session)
export EVE_URL=http://127.0.0.1:8000
export IRC_NICK=eve IRC_CHANNEL=#test IRC_HOST=irc.freeq.at
node irc-bridge/server.mjs
```

`scripts/start.sh` starts eve first, then the bridge in the background.

## Env

| Variable | Default |
|----------|---------|
| `EVE_URL` | `http://127.0.0.1:8000` |
| `IRC_HOST` / `IRC_PORT` / `IRC_TLS` | freeq defaults |
| `IRC_NICK` / `IRC_CHANNEL` | `eve` / `#test` |
| `IRC_FREEQ_SESSION` | freeq-tui session JSON |
| `IRC_REQUIRE_AUTH` | auto-on for freeq hosts; refuse `Guest*` / reconnect until SASL nick is `IRC_NICK` |
| `IRC_BACKLOG_*` | join history ignore |
| `IRC_CONTEXT_LINES` | live ring buffer size for background context (default `40`; `0` = off) |
| `IRC_CONTEXT_MAX_CHARS` | max framed context blob size (default `6000`) |
| `IRC_WORKING_REACT` | emoji for “working on it” (default `👀`) |
| `IRC_CONTROL_HOST` / `IRC_CONTROL_PORT` | control HTTP (default `127.0.0.1:8791`) |
| `RADIO_AV_BRIDGE_URL` / `AV_BRIDGE_URL` | **radio** plane (default `http://127.0.0.1:8790`) |
| `STREAM_WATCH_AV_BRIDGE_URL` / `STREAMPLACE_AV_BRIDGE_URL` | **stream-watch** plane (default `:8792`) |
| `STREAM_BROADCAST_AV_BRIDGE_URL` | **stream-broadcast** plane (default `:8793`) |
| `SFU_URL` | MoQ SFU (default freeq `https://irc.freeq.at:8080/av/moq`) |
| `FREEQ_API_BASE` | REST for session discovery (default `https://<IRC_HOST>`) |
| `RADIO_ANNOUNCE` | `1` (default) — PRIVMSG when ICY song title changes |
| `RADIO_ANNOUNCE_MS` | poll interval for title changes (default `2000`) |
| `STREAMPLACE_API` | stream.place XRPC base (default `https://stream.place`) |
| `STREAMPLACE_AUTO` | `1` = restore last saved `watch` on boot (no pref → idle) |
| `STREAMPLACE_RTMP_URL` | publish ingest base (default `rtmps://stream.place:1935/live`) |
| `STREAMPLACE_STREAM_KEY` | required for **publish** (from stream.place dashboard) |
| `STREAMPLACE_PUBLISH_HANDLE` | optional public handle for go-live notices |

**Three MoQ planes** (separate `eve-av-bridge` processes — do not munge):

| Plane | Port | Role | Control |
|-------|------|------|---------|
| radio | `:8790` | internet radio only | `/v1/radio/*` |
| stream-watch | `:8792` | stream.place HLS → freeq | `/v1/watch/*` |
| stream-broadcast | `:8793` | freeq call → stream.place RTMP | `/v1/call-egress/*` |

Only **one** freeq tile plays at a time: starting radio, watch, or broadcast
releases the other planes (`exclusivePlane`).

### Control HTTP (eve tools)

| POST | body | action |
|------|------|--------|
| `/av/ensure` | `{ channel?, title? }` | av_start/join + connect media |
| `/radio/play` | `{ url, channel?, title? }` | ensure AV + stream radio |
| `/radio/stop` | | stop decode |
| `/radio/now-playing` | `{ title, channel? }` | announce song (from av-bridge `RADIO_TITLE_HOOK` or tooling) |
| `/streamplace/play` | `{ streamer?, channel? }` | stream.place → freeq MoQ (watch plane) |
| `/streamplace/stop` | | stop watch plane |
| `/streamplace/publish` | `{ url?, title?, mode?, channel? }` | freeq/URL → stream.place RTMP (inverse) |
| `/streamplace/publish/stop` | | stop RTMP publish |
| GET `/streamplace/status` | | watch plane + publish status |
| GET `/streamplace/publish/status` | | publish plane only |

Needs **eve-av-bridge** running with **ffmpeg** for radio / watch. Publish uses
**ffmpeg** in this process (RTMP egress).

### Now-playing (song changes)

When radio is playing, the bridge announces each new ICY `StreamTitle` as a
single PRIVMSG on the radio channel:

```
now playing: Artist - Track
```

Two paths (deduped):

1. **Push** — set `RADIO_TITLE_HOOK=http://127.0.0.1:8791/radio/now-playing` on
   eve-av-bridge (default in `scripts/run-av-bridge.sh`).
2. **Poll** — every `RADIO_ANNOUNCE_MS`, GET av-bridge `/v1/status` for
   `radio.title` (works with older av-bridge builds that only expose status).


## Channel commands

| Command | Effect |
|---------|--------|
| `eve: watch https://stream.place/<handle>` | switch stream.place rebroadcast to that streamer |
| `eve: watch <handle>` / `eve: watch did:plc:…` | same |
| `eve: go live` | publish active freeq radio source → stream.place RTMP |
| `eve: go live <url>` | publish that URL → stream.place |
| `eve: go live av <url>` | re-encode source video+audio (default is audio+slate) |
| `eve: stop live` | stop stream.place publish |

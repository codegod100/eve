---
name: freeq-radio
description: >-
  Stream internet radio into a freeq AV (voice) call when users say play radio,
  put on music, stop radio, or name a station. Watch stream.place into freeq or
  publish freeq out to stream.place. Tools: play_radio, stop_radio, radio_status,
  watch_stream, publish_stream, memory_bank_add, memory_bank_list.
  Needs irc-bridge control API + eve-av-bridge + ffmpeg.
---

# freeq radio (AV stream)

## When

- "play radio", "put on some music", "stream groove salad"
- Named stations: groove, drone, beatblender, defcon, deepspace, indie, metal
- "stop radio" / "kill the music"
- "watch stream.place/…" / "go live on stream.place" / "publish radio to stream.place"

## Tools

1. **`play_radio`** — ensure AV + stream a station (probes control + av-bridge first).
2. **`stop_radio`** — stop decode/feed (call may stay open).
3. **`radio_status`** — live probes: control_up, av_bridge_up, radio_playing. Use when user can’t hear or before claiming anything is “missing”.
4. **`watch_stream`** — stream.place → freeq MoQ (ingress plane `:8792`).
5. **`publish_stream`** — freeq / URL → stream.place RTMP (egress / inverse plane).
6. **`memory_bank_add`** / **`memory_bank_list`** — durable song/note list on host.

Default channel: `#test`. Users hear freeq radio only after **joining the freeq AV call**
in that channel (not via IRC text).

## Do not

- Invent “ffmpeg not installed / no av-bridge / bare container” without tool probes.
- Long infrastructure essays. Trust tool JSON (`verified_playing`, `radio_playing`).

## Stack

```
user → eve play_radio → irc-bridge :8791 /radio/play
                            ├─ freeq TAGMSG av_start/av_join
                            └─ eve-av-bridge :8790
                                   └─ ffmpeg → PCM → MoQ SFU

watch:  stream.place HLS → av-bridge :8792 → freeq MoQ
publish: freeq/source URL → ffmpeg RTMP → stream.place (inverse)
```

## Ops (VM)

```bash
# media plane (needs alsa + ffmpeg)
./scripts/run-av-bridge.sh   # or nix-shell -p pkg-config alsa-lib ffmpeg

# irc-bridge already exposes control on 127.0.0.1:8791 when running
```

If play fails: check av-bridge health `curl :8790/health`, control
`curl :8791/health`, and that `ffmpeg` is on PATH.


## stream.place (`watch` — into freeq)

- Channel command (instant): `eve: watch https://stream.place/handle`
- Also: `eve: watch handle` / `eve: watch did:plc:…`
- Tool: **`watch_stream`** for natural language ("put on iame.li stream").
- Switches the stream.place MoQ plane (one freeq plane at a time; replaces radio).

## stream.place (`publish` — freeq call → stream.place)

Inverse of watch: **rebroadcast the freeq AV room** (all remote participants,
video grid + mixed audio) to stream.place via RTMP. Implemented as av-bridge
**call-egress** (MoQ subscribe → mix → ffmpeg RTMP).

- Channel: `eve: go live` (call mix), `eve: go live audio <url>`, `eve: go live av <url>`, `eve: stop live`
- Tool: **`publish_stream`** (default mode `call`; `stop: true` to end)
- Requires:

  | Variable | Purpose |
  |----------|---------|
  | `STREAMPLACE_STREAM_KEY` | stream.place Live Dashboard → Generate Stream Key |
  | `STREAMPLACE_RTMP_URL` | Default `rtmps://stream.place:1935/live` |
  | `STREAMPLACE_PUBLISH_HANDLE` | Optional public page for notices |
  | eve-av-bridge with **call-egress** | mix + RTMP |

```bash
# join freeq #test then rebroadcast the room
curl -sS -X POST http://127.0.0.1:8791/streamplace/publish \
  -H 'content-type: application/json' -d '{"mode":"call","channel":"#test"}'
curl -sS http://127.0.0.1:8790/v1/status | jq .call_egress
curl -sS -X POST http://127.0.0.1:8791/streamplace/publish/stop
```

People must **join freeq AV** in the channel so their tiles appear in the mix.
Remind user to **Announce Livestream** on the stream.place dashboard.

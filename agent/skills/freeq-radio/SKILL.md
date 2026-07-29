---
name: freeq-radio
description: >-
  Stream internet radio into a freeq AV (voice) call when users say play radio,
  put on music, stop radio, stop media, or name a station. Watch stream.place into freeq or
  publish freeq out to stream.place. Tools: play_radio, stop_radio, stop_media, radio_status,
  watch_stream, publish_stream, memory_bank_add, memory_bank_list.
  Needs irc-bridge control API + eve-av-bridge + ffmpeg.
---

# freeq radio (AV stream)

## When

- "play radio" → **Groove Salad** (default)
- "play radio def con", "play radio drone", "play groove salad", "radio fluid"
- Named stations / aliases (pass the name in `station`; spaces ok):
  - groove / groovesalad / salad → Groove Salad (default)
  - defcon / def con → DEF CON Radio
  - drone / dronezone → Drone Zone
  - beatblender, deepspace, indie, metal, fluid, lush, secretagent, spacestation, …
  - any SomaFM channel id, or a raw http(s) stream URL
- "stop radio" / "kill the music" (radio only)
- "stop media" / "stop all" / "stop everything" (radio + watch + publish)
- "watch stream.place/…" / "go live on stream.place" / "publish radio to stream.place"

## Channel fast-path (no agent)

These hit the irc-bridge immediately (same as `eve: watch …`):

- `eve: play radio` → Groove Salad
- `eve: play radio def con` / `eve: play radio drone` / `eve: radio fluid`
- `eve: play groove salad`

## Tools

1. **`play_radio`** — ensure AV + stream a station (probes control + av-bridge first).
   - **`station`**: pass only the station name (`"def con"`, `"drone"`, `"fluid"`).
   - Omit `station` (or empty) for **Groove Salad**.
   - Do **not** pass the whole user sentence when you can extract the name.
2. **`stop_radio`** — stop radio decode/feed only (call may stay open). Prefer **`stop_media`** when they want everything off.
3. **`stop_media`** — stop **all** media: radio, stream.place watch, and stream.place publish; releases MoQ planes.
4. **`radio_status`** — live probes: control_up, av_bridge_up, radio_playing. Use when user can’t hear or before claiming anything is “missing”.
5. **`watch_stream`** — stream.place → freeq MoQ (ingress plane `:8792`).
6. **`publish_stream`** — freeq / URL → stream.place RTMP (egress / inverse plane).
7. **`memory_bank_add`** / **`memory_bank_list`** — durable song/note list on host.

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

## Stop all media

- Channel (instant, no agent): `eve: stop media` / `eve: stop all` / `eve: stop everything`
- Tool: **`stop_media`** for natural language
- Control: `POST http://127.0.0.1:8791/media/stop`
- Stops radio + stream.place watch + publish and releases planes. Freeq call may stay open.

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

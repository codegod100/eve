---
name: freeq-radio
description: >-
  Stream internet radio into a freeq AV (voice) call when users say play radio,
  put on music, stop radio, or name a station. Tools: play_radio, stop_radio, watch_stream.
  Needs irc-bridge control API + eve-av-bridge + ffmpeg.
---

# freeq radio (AV stream)

## When

- "play radio", "put on some music", "stream groove salad"
- Named stations: groove, drone, beatblender, defcon, deepspace, indie, metal
- "stop radio" / "kill the music"

## Tools

1. **`play_radio`** — ensure AV + stream a station (probes control + av-bridge first).
2. **`stop_radio`** — stop decode/feed (call may stay open).
3. **`radio_status`** — live probes: control_up, av_bridge_up, radio_playing. Use when user can’t hear or before claiming anything is “missing”.

Default channel: `#test`. Users hear audio only after **joining the freeq AV call**
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
```

## Ops (VM)

```bash
# media plane (needs alsa + ffmpeg)
./scripts/run-av-bridge.sh   # or nix-shell -p pkg-config alsa-lib ffmpeg

# irc-bridge already exposes control on 127.0.0.1:8791 when running
```

If play fails: check av-bridge health `curl :8790/health`, control
`curl :8791/health`, and that `ffmpeg` is on PATH.


## stream.place (`watch`)

- Channel command (instant): `eve: watch https://stream.place/handle`
- Also: `eve: watch handle` / `eve: watch did:plc:…`
- Tool: **`watch_stream`** for natural language ("put on iame.li stream").
- Switches the stream.place MoQ plane (one plane at a time; replaces radio).

# eve-av-bridge

Standalone **freeq AV media plane** for eve, controlled over a JSON WebSocket.

> **Source lives in the freeq monorepo** (Cargo workspace member — freeq-av
> needs freeq’s lockfile + iroh patches):
>
> [`/home/nandi/code/freeq/eve-av-bridge`](../../freeq/eve-av-bridge)
>
> This directory is the eve-facing docs + runbook.

Based on [freeq AV agents](https://freeq.at/docs/av-agents/).

## Architecture

```
freeq IRC  ←TLS→  irc-bridge (text, 👀, optional av TAGMSG)  ─HTTP→  eve
                         │
                         │  WS JSON control (next: wire from bridge)
                         ▼
freeq SFU  ←MoQ→  eve-av-bridge  ←ws://127.0.0.1:8790/ws→  controller
```

| Plane | Owner |
|-------|--------|
| PRIVMSG / context / 👀 | Node `irc-bridge` |
| `av_join` / `av_leave` TAGMSG | Node (recommended) or `irc-signaling` feature |
| MoQ media + VAD utterances | **eve-av-bridge** |
| STT / LLM / TTS | eve (or controller) via `utterance` / `speak_pcm` |

## Build & run

Source: freeq monorepo package `eve-av-bridge` (flake outputs).

### Portable static (recommended for boxd / bare Ubuntu)

**glibc crt-static** (`-C target-feature=+crt-static` on the host gnu
target) — no musl, no `/nix/store` dynamic linker on the VM:

```bash
cd ~/code/freeq
nix build .#eve-av-bridge-static
./result/bin/eve-av-bridge --bind 127.0.0.1:8790

# build + deploy to boxd:
./scripts/build-eve-av-bridge-static.sh --deploy-boxd eve

# or plain cargo inside the flake shell:
nix develop -c env RUSTFLAGS='-C target-feature=+crt-static' \
  cargo build -p eve-av-bridge --release
```

### Dev (dynamic)

```bash
cd ~/code/freeq
nix develop -c cargo run -p eve-av-bridge --release -- --bind 127.0.0.1:8790

# from eve:
./scripts/run-av-bridge.sh          # cargo
./scripts/run-av-bridge.sh --static # flake glibc crt-static
```

Env: `AV_BRIDGE_BIND` (default `127.0.0.1:8790`). **ffmpeg** on PATH for radio.

- Health: `GET /health`
- WebSocket: `ws://127.0.0.1:8790/ws`

## Protocol (JSON, `type` field)

### Client → bridge

| type | fields | meaning |
|------|--------|---------|
| `ping` | `id?` | heartbeat |
| `connect_session` | `sfu_url`, `session_id`, `nick`, `instance?`, `channel?`, `audio_only?` | open MoQ |
| `disconnect_session` | | drop media |
| `speak_pcm` | `pcm_f32_le_b64`, `sample_rate` | enqueue mono f32 LE |
| `speak_clear` | | barge-in |
| `status` | | snapshot |

Use the **same `instance`** in IRC `av_join` and `connect_session`.

### Bridge → client

| type | meaning |
|------|---------|
| `hello` | version + features |
| `session_state` | idle / connecting / connected / ended |
| `participant` | joined / left |
| `utterance` | 16 kHz mono f32 LE base64 (for STT) |
| `speaking` | outbound queue |
| `error` | failures |

### Example

```json
{
  "type": "connect_session",
  "sfu_url": "https://irc.freeq.at:8080/av/moq",
  "session_id": "01KY…",
  "nick": "eve",
  "instance": "a1b2c3d4",
  "channel": "#test",
  "audio_only": true
}
```

## Radio (play radio)

HTTP (used by eve tools via irc-bridge orchestration):

| Method | Path | Body |
|--------|------|------|
| POST | `/v1/session/connect` | `{ sfu_url, session_id, nick, instance?, channel?, audio_only? }` |
| POST | `/v1/radio/play` | `{ url }` — needs active session + **ffmpeg** |
| POST | `/v1/radio/stop` | |
| GET | `/v1/status` | |

Irc-bridge control (`:8791`) does AV TAGMSG + these calls:

```bash
curl -X POST http://127.0.0.1:8791/radio/play \
  -H 'content-type: application/json' \
  -d '{"url":"https://ice1.somafm.com/groovesalad-128-mp3"}'
```

Eve tools: `play_radio` / `stop_radio` (skill `freeq-radio`).

## Next

1. Eve: `utterance` → STT → model → TTS → `speak_pcm`
2. Optional feature `irc-signaling` for a single-process agent (not with text bridge)

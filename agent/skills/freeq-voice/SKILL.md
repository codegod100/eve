---
name: freeq-voice
description: >-
  Duplex spoken conversation with Eve over freeq AV using Grok Voice (default
  voice=eve). Triggers: enter voice mode, enter conversation mode, exit voice
  mode, voice status. Tools: enter_voice_mode, exit_voice_mode, voice_status.
  Needs irc-bridge control API + eve-av-bridge + CLOUDFLARE_ACCOUNT_ID +
  CLOUDFLARE_API_TOKEN.
---

# freeq voice (Grok Voice / Eve)

## When

- **"enter voice mode"** / **"enter conversation mode"** / **"voice mode"** / **"start voice"** → `enter_voice_mode`
- **"exit voice mode"** / **"leave voice mode"** / **"stop voice"** / **"end conversation mode"** → `exit_voice_mode`
- **"voice status"** / "is voice mode on?" / "can't hear you" (spoken path) → `voice_status`

Default spoken timbre is **eve** (energetic Grok Voice). Optional other ids: ara, orion, leo, rex, sal, carina, …

## Channel fast-path (no agent)

- `eve: enter voice mode` / `eve: enter conversation mode`
- `eve: exit voice mode` / `eve: leave conversation mode`
- `eve: voice status`

## Tools

1. **`enter_voice_mode`** — ensure freeq AV on channel, stop radio decode if needed, start Grok Voice duplex (Eve greets on the call).
2. **`exit_voice_mode`** — tear down Grok session; freeq call may stay open.
3. **`voice_status`** — probes control + voice state + av-bridge.

## Do not

- Invent "voice not installed / no API keys" without tool probes.
- Long infrastructure essays. Trust tool JSON (`live`, `say`).
- Confuse with **radio** (`play_radio`) — radio is music only; voice mode is conversational speech.

## Stack

```
user (freeq AV mic)
  → eve-av-bridge VAD utterance (f32 @ 16k)
  → voice-bridge → Cloudflare xai/grok-voice (voice=eve)
  → PCM16 TTS → speak_pcm → freeq AV speakers
```

Control: `POST :8791/voice/start|stop` · `GET :8791/voice/status`

## Env (VM)

| Variable | Purpose |
|----------|---------|
| `CLOUDFLARE_ACCOUNT_ID` | Workers AI account |
| `CLOUDFLARE_API_TOKEN` | Bearer for `xai/grok-voice` |
| `GROK_VOICE` | Default `eve` |
| `AV_BRIDGE_URL` / `IRC_CONTROL_URL` | media + control |

Listeners must **join the freeq voice call** in the channel (not IRC text audio).

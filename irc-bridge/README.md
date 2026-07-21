# irc-bridge

Standalone IRC client. Eve never opens an IRC socket.

```
irc.freeq.at  ←TLS→  irc-bridge  ──POST /irc/inbound──►  eve :8000
                              ◄──SSE  /irc/out──────────  eve
```

1. Channel PRIVMSGs after JOIN are ignored until the join backlog ends
   (`IRC_BACKLOG_*` min/gap/max).
2. A live mention → bridge immediately 👀-reacts (TAGMSG `+react` /
   `+reply=<msgid>`), then `POST`s `{from,target,text,msgid}` to eve.
   **No scrollback** is attached — eve's `SendPayload.context` becomes
   `role:user` history and models answer every historical line, so we send
   only the mention body.
3. Eve runs the agent turn on that single message.
4. On `message.completed`, eve pushes an SSE `privmsg` event.
5. Bridge reads SSE and sends `PRIVMSG` on IRC.

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
| `IRC_WORKING_REACT` | emoji for “working on it” (default `👀`) |
| `IRC_CONTROL_HOST` / `IRC_CONTROL_PORT` | control HTTP (default `127.0.0.1:8791`) |
| `AV_BRIDGE_URL` | eve-av-bridge base (default `http://127.0.0.1:8790`) |
| `SFU_URL` | MoQ SFU (default freeq `https://irc.freeq.at:8080/av/moq`) |
| `FREEQ_API_BASE` | REST for session discovery (default `https://<IRC_HOST>`) |

### Control HTTP (eve tools)

| POST | body | action |
|------|------|--------|
| `/av/ensure` | `{ channel?, title? }` | av_start/join + connect media |
| `/radio/play` | `{ url, channel?, title? }` | ensure AV + stream radio |
| `/radio/stop` | | stop decode |

Needs **eve-av-bridge** running with **ffmpeg** for radio.

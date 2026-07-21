# irc-bridge

Standalone IRC client. Eve never opens an IRC socket.

```
irc.freeq.at  ←TLS→  irc-bridge  ──POST /irc/inbound──►  eve :8000
                              ◄──SSE  /irc/out──────────  eve
```

1. Message arrives on IRC → bridge `POST`s `{from,target,text}` to eve.
2. Eve runs the agent turn.
3. On `message.completed`, eve pushes an SSE `privmsg` event.
4. Bridge reads SSE and sends `PRIVMSG` on IRC.

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
| `IRC_BACKLOG_*` | join history ignore |

# irc-bridge

Standalone IRC client. Eve never opens an IRC socket.

```
irc.freeq.at  ←TLS→  irc-bridge  ──POST /irc/inbound──►  eve :8000
                              ◄──SSE  /irc/out──────────  eve
```

1. Live PRIVMSGs (after join backlog) go into a per-target ring buffer.
2. A mention → bridge `POST`s `{from,target,text,context}` to eve.
   `context` is recent scrollback for that channel/DM (oldest → newest).
3. Eve runs the agent turn; `context` is injected as user-role messages
   before the mention (`SendPayload.context`).
4. On `message.completed`, eve pushes an SSE `privmsg` event.
5. Bridge reads SSE, sends `PRIVMSG` on IRC, and also records its own reply
   in the ring buffer.

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
| `IRC_CONTEXT_LINES` | ring buffer size (default `40`) |
| `IRC_CONTEXT_MAX_CHARS` | max formatted context chars (default `6000`) |

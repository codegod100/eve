---
name: irc-backlog
description: >-
  freeq (and similar) IRC servers replay channel history as PRIVMSG right after
  JOIN. Use when debugging join spam, double-replies to old mentions, "backlog",
  history flood, or why eve ignored/answered after reconnect. Documents the
  channel client's adaptive backlog ignore and IRC_BACKLOG_* env knobs.
---

# IRC join backlog ignore

## Rule

**Do not treat channel history after JOIN as live user input.** freeq dumps backlog as ordinary `PRIVMSG` lines (with `@msgid` tags). The IRC channel client drops those automatically; you should not invent replies for historical mentions that leaked through.

DMs are **not** backlog-dropped.

## Enforcement (code, not model)

`irc-bridge/server.mjs` enters **backlog mode** on our own JOIN (not the eve process):

1. **MIN** — drop every channel PRIVMSG for `IRC_BACKLOG_MIN_MS` (default **10s**) after JOIN.
2. **GAP** — after MIN, keep dropping while channel PRIVMSGs keep arriving; end when there is a quiet gap of `IRC_BACKLOG_GAP_MS` (default **3s**) with no channel PRIVMSG, then process the next live message.
3. **MAX** — hard stop ignoring after `IRC_BACKLOG_MAX_MS` (default **90s**) post-JOIN.

Logs:

```text
[irc] joined #test … (ignoring channel backlog min=… gap=… max=…)
[irc] backlog drop #1 from … in #test
[irc] backlog ignore ended (gap|max); dropped N channel msgs after Xs
```

## Env knobs

| Variable | Default | Meaning |
|----------|---------|---------|
| `IRC_BACKLOG_MIN_MS` | `10000` | Always drop channel msgs this long after JOIN |
| `IRC_BACKLOG_GAP_MS` | `3000` | Quiet gap that ends backlog after MIN |
| `IRC_BACKLOG_MAX_MS` | `90000` | Hard cap on ignore window |

Set on the eve VM before `start.sh` (or export in `start.sh`).

## Agent behavior if a historical mention still arrives

- Prefer **one short line**: you only handle live turns; ignore replaying prior conversation.
- Do **not** re-run long tool workflows for a mention that is clearly a backlog replay (same text as earlier in the scrollback the user just reconnected past).
- Real new mentions after the quiet gap are live — answer normally (single IRC line).

## Related

- Skill `freeq-irc` — wrong nick / SASL / Guest… (session refresh)
- Reconnect after hibernate often re-triggers backlog; that is expected

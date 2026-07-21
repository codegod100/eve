# eve-agent

[eve.dev](https://eve.dev) agent deployed on [eve.boxd.sh](https://eve.boxd.sh).

- **Model**: OpenCode Zen `hy3-free` (OpenAI-compatible Chat Completions)
- **Channels**: built-in eve channel + custom IRC (`agent/channels/irc.ts`)
- **Tools**: cowsay, ATProto `lookup_did`, `get_recent_posts`
- **Secrets**: API keys pulled live from OpenBao (`openbao.boxd.sh`) via `scripts/fetch-keys.sh` — never committed

## Layout

```
agent/
  agent.ts           # model + agent definition
  instructions.md
  channels/          # eve.ts, irc.ts
  tools/             # cowsay, ATProto helpers
scripts/
  fetch-keys.sh      # OpenBao KV → export KEY=VALUE
  start.sh           # boxd boot: fetch keys + eve dev :8000
flake.nix            # nix develop shell (nodejs 24, curl, jq)
```

## Local dev

```bash
nix develop          # or: direnv allow
npm install
export OPENCODE_API_KEY=…   # or other provider keys
npm run dev
```

## Boxd (eve.boxd.sh)

On the VM, secrets come from OpenBao:

```bash
export OPENBAO_ADDR=https://openbao.boxd.sh
export OPENBAO_TOKEN=…      # boxd secret / service token
npm install
npm run boxd:start          # scripts/start.sh
```

Optional IRC env (defaults match freeq):

| Variable | Default |
|----------|---------|
| `IRC_HOST` | `irc.freeq.at` |
| `IRC_PORT` | `6697` |
| `IRC_TLS` | `1` |
| `IRC_NICK` | `eve-agent` |
| `IRC_CHANNEL` | `#test` |
| `IRC_PASSWORD` | (unset) |
| `IRC_OWNERS` | (unset) |

## Framework docs

See `node_modules/eve/docs/` or https://eve.dev/docs.

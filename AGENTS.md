# eve Agent App

This project uses the eve framework. Before writing code, read the relevant guide
from the installed eve package docs. In most installs, those docs are at
`node_modules/eve/docs/`. In workspaces or local package installs, resolve the
installed `eve` package location first and read its `docs/` directory. If
package docs are unavailable, use https://eve.dev/docs as a fallback.

## stream.place watch = WHEP only

stream.place → freeq (`watch_stream` / `POST /streamplace/play`) uses **WHEP
only**. Never add HLS / `getLivePlaylist` as a watch fallback. If WHEP is flaky
or broken, fix the WHEP root cause (demux, deps, av-bridge ready-gate, rendition,
SDP) — do not switch transports. See `.cursor/rules/streamplace-whep.mdc`.

## Cursor Cloud specific instructions

The core product is the **eve agent** (the `eve` framework app under `agent/`),
served over HTTP. The update script runs `npm install`; the notes below are the
non-obvious things needed to run and test it.

### Node 24 is required, but a v22 node shadows PATH

`package.json` pins `engines.node` to `24.x`, and `eve build`/`eve dev` need it.
The VM's default `node` on `PATH` is `/exec-daemon/node` (**v22**), which shadows
nvm even after `nvm use`. Before running any `node`/`npm`/`npx`/`eve` command,
select nvm's Node 24 explicitly:

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
export PATH="$(nvm which 24 | xargs dirname):$PATH"   # beats /exec-daemon/node
```

### Model/API keys come from OpenBao (only `OPENBAO_TOKEN` is provided)

The one injected secret is `OPENBAO_TOKEN`. All AI keys — including
`OPENCODE_API_KEY`, which the agent needs for every model turn — are fetched
live from OpenBao (see README "Secrets" and `scripts/fetch-keys.sh`). Load them
into the current shell before starting the agent:

```bash
export OPENBAO_ADDR="https://openbao.boxd.sh"
eval "$(bash scripts/fetch-keys.sh)"   # exports OPENCODE_API_KEY, LINEAR_API_KEY, etc.
```

Without a model key the server still starts, but every session ends in
`MODEL_CALL_FAILED` ("Model provider API key missing"). `scripts/prep.sh` does
this same fetch as part of the full boxd/systemd path.

### Run + test the agent (dev)

- Lint/typecheck: `npm run typecheck` (`tsc`; there is no ESLint in this repo).
- Build: `npm run build` (`eve build` → `.eve/` + `.output`).
- Run (controllable/background): `npx eve dev --no-ui` → serves at
  `http://127.0.0.1:2000/` (note: dev port is **2000**, not the 8000 used by the
  prod `eve start`/`start.sh` path). `npm run dev` is the same but opens the
  interactive TUI.
- Smoke test (no GUI): `POST /eve/v1/session` with `{"message":"..."}`, then read
  `GET /eve/v1/session/<sessionId>/stream` (NDJSON). See `node_modules/eve/docs/getting-started.mdx`.

### Optional services (not needed for the core agent, extra infra required)

`irc-bridge` (`npm run irc-bridge`) needs a live freeq SASL session
(`npx @solpbc/rook login` + `node scripts/sync-freeq-session.mjs`). The
`eve-av-bridge` planes (radio/voice/slide/stream.place, ports 8790–8793) need the
Rust `eve-av-bridge` binary built from the **external freeq repo** plus `ffmpeg`,
and the WHEP watch plane needs the nix flake python env
(`scripts/install-whep-deps.sh`, i.e. `nix build .#whep-python` — `nix` is not
installed by default). Stand these up only when specifically testing those flows.

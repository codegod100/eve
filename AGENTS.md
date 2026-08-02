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

# Patches for sibling repos

## `freeq-whep-ready-gate.patch`

Apply on [codegod100/freeq](https://github.com/codegod100/freeq) `eve-av-bridge`:

```bash
cd ~/code/freeq
git apply /path/to/eve/patches/freeq-whep-ready-gate.patch
# then rebuild + deploy the static bridge to boxd
./scripts/build-eve-av-bridge-static.sh --deploy-boxd eve
```

Makes `/v1/watch/play` wait for demux `WHEP_READY` (and reject HLS URLs) so
missing Python deps or WHEP negotiate failures surface as hard errors instead
of a silent “playing” zombie. Required companion to eve’s WHEP-only policy.

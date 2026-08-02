# system-manager (eve.boxd.sh)

Host packages for the Ubuntu boxd VM via [numtide/system-manager](https://github.com/numtide/system-manager).

This is **not** a replacement for the systemd **user** units under `systemd/user/`. Those still run the agent, IRC bridge, and timers as the `boxd` user. system-manager puts immutable tools on `/run/system-manager/sw/bin` (notably `whep-python` / `whep-watch-demux`) so deploy/prep do not depend on an ad-hoc `nix build` or pip fallback.

## Bootstrap (once per VM)

1. Install **multi-user** Nix with flakes (system-manager does not support single-user Nix):

   ```bash
   curl --proto '=https' --tlsv1.2 -sSf -L https://install.determinate.systems/nix \
     | sh -s -- install
   ```

2. Ensure the deploy user can `sudo` without a TTY (passwordless or root-owned activate).

3. From the agent checkout:

   ```bash
   bash scripts/system-manager-switch.sh
   source /etc/profile.d/system-manager-path.sh   # or re-login
   which whep-python   # → /run/system-manager/sw/bin/whep-python
   ```

## Apply / update

```bash
bash scripts/system-manager-switch.sh
# equivalent:
# nix run .#system-manager -- switch --flake . --sudo
```

`scripts/deploy-boxd.sh` runs the switch when `nix` is available; failures fall through to `install-whep-deps.sh` (nix build → pip `--target`).

## What it installs

| Package | Role |
|---------|------|
| `whep-python` | flake `aiortc`/`av` env (does not shadow host `python3`) |
| `whep-watch-demux` | store-embedded demux helper |
| `jq`, `curl`, `git` | deploy/ops helpers |

Config: [`boxd.nix`](./boxd.nix) · flake output: `systemConfigs.default` (alias `systemConfigs.boxd`).

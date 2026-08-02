# boxd machine package

Generic host toolset for [boxd](https://boxd.sh) VMs. Separated from
eve-specific WHEP packages so a personal NixOS flake
([codegod100/nixos](https://github.com/codegod100/nixos)) can reuse the same
baseline without pulling agent runtime deps.

## Flake outputs

| Output | Purpose |
|--------|---------|
| `packages.<system>.boxd-machine` | `symlinkJoin` of `jq`, `curl`, `git` (+ optional extras) |
| `systemManagerModules.boxd` | system-manager module (flakes + host packages) |
| `nixosModules.boxd` | same module shape for NixOS `environment.systemPackages` |

## Consume from `codegod100/nixos`

```nix
# flake.nix (nixos)
{
  inputs.eve.url = "github:codegod100/eve";

  outputs = { self, nixpkgs, system-manager, eve, ... }: {
    # system-manager on Ubuntu boxd VMs
    systemConfigs.boxd = system-manager.lib.makeSystemConfig {
      modules = [ eve.systemManagerModules.boxd ];
    };

    # or NixOS host
    nixosConfigurations.boxd = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [ eve.nixosModules.boxd ];
    };

    # or just the package
    packages.x86_64-linux.boxd-machine =
      eve.packages.x86_64-linux.boxd-machine;
  };
}
```

Override platform / extras:

```nix
(import "${eve}/nix/boxd/module.nix" {
  hostPlatform = "aarch64-linux";
  # extraPackages filled inside the module via pkgs — prefer composing
  # another module that appends to environment.systemPackages.
})
```

## Eve composition

`nix/system-manager/boxd.nix` imports this module and adds WHEP tools for
`eve.boxd.sh` only.

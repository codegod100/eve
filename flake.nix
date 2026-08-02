{
  description = "eve-agent — eve.dev agent for eve.boxd.sh";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    system-manager = {
      url = "github:numtide/system-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      system-manager,
    }:
    let
      # nixos-unstable (26.11+) dropped x86_64-darwin; do not use eachDefaultSystem.
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];

      mkWhep =
        pkgs:
        import ./nix/whep.nix {
          inherit pkgs;
          demuxScript = ./scripts/whep-watch-demux.py;
        };

      # Generic boxd host module (no eve/WHEP). Reusable from codegod100/nixos.
      boxdModule = import ./nix/boxd/module.nix { };
    in
    (flake-utils.lib.eachSystem supportedSystems (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
        whep = mkWhep pkgs;
        systemManagerPkg =
          if builtins.hasAttr system system-manager.packages then
            system-manager.packages.${system}.default
          else
            null;
        # boxd-machine is a Linux host profile; skip on Darwin.
        boxdMachine =
          if pkgs.stdenv.isLinux then
            pkgs.callPackage ./nix/boxd/package.nix { }
          else
            null;
      in
      {
        packages =
          {
            default = whep.whepPython;
            whep-python = whep.whepPython;
            whep-python-bin = whep.whepPythonBin;
            whep-demux = whep.whepDemux;
          }
          // nixpkgs.lib.optionalAttrs (boxdMachine != null) {
            boxd-machine = boxdMachine;
          }
          // nixpkgs.lib.optionalAttrs (systemManagerPkg != null) {
            system-manager = systemManagerPkg;
          };

        apps =
          {
            whep-demux = {
              type = "app";
              program = "${whep.whepDemux}/bin/whep-watch-demux";
            };
          }
          // nixpkgs.lib.optionalAttrs (systemManagerPkg != null) {
            system-manager = {
              type = "app";
              program = "${systemManagerPkg}/bin/system-manager";
            };
          };

        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_24
            pkgs.typescript
            pkgs.curl
            pkgs.jq
            whep.whepPython
            whep.whepDemux
          ];

          shellHook = ''
            export WHEP_PYTHON="${whep.whepPython}/bin/python3"
            export WHEP_DEMUX_PATH="${whep.whepDemux}/bin/whep-watch-demux"
            echo "eve-agent dev shell"
            echo "  WHEP_PYTHON=$WHEP_PYTHON"
            echo "  npm install   # install deps"
            echo "  npm run dev   # local eve (needs model API keys in env)"
            echo "  npm run typecheck"
            echo "  npm run boxd:start  # OpenBao key bridge + eve on :8000"
            echo "  nix build .#whep-python   # GC-rooted via install-whep-deps.sh"
            echo "  nix build .#boxd-machine  # generic boxd host tools"
            echo "  bash scripts/system-manager-switch.sh  # boxd host packages"
          '';
        };

        formatter = pkgs.nixfmt;
      }
    ))
    // {
      # Generic module for any boxd VM — consume from github:codegod100/nixos.
      # See nix/boxd/README.md.
      systemManagerModules.boxd = boxdModule;
      nixosModules.boxd = boxdModule;
      nixosModules.default = boxdModule;

      # Host config for eve.boxd.sh — generic boxd + WHEP (nix/system-manager/).
      systemConfigs.default = system-manager.lib.makeSystemConfig {
        modules = [ ./nix/system-manager/boxd.nix ];
      };
      systemConfigs.boxd = self.systemConfigs.default;

      # Generic-only system-manager config (no eve WHEP) for other boxd machines.
      systemConfigs.boxd-machine = system-manager.lib.makeSystemConfig {
        modules = [ boxdModule ];
      };
    };
}

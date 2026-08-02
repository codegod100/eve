{
  description = "eve-agent — eve.dev agent for eve.boxd.sh";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };

        # Python env for scripts/whep-watch-demux.py (stream.place WHEP → freeq).
        # Prefer this over pip — aiortc/av need correctly linked ffmpeg/libsrtp.
        whepPython = pkgs.python3.withPackages (
          ps: with ps; [
            aiortc
            aiohttp
            av
            numpy
          ]
        );

        whepDemux = pkgs.writeShellApplication {
          name = "whep-watch-demux";
          runtimeInputs = [ whepPython ];
          text = ''
            exec ${whepPython}/bin/python3 ${./scripts/whep-watch-demux.py} "$@"
          '';
        };
      in
      {
        packages = {
          default = whepPython;
          whep-python = whepPython;
          whep-demux = whepDemux;
        };

        apps.whep-demux = {
          type = "app";
          program = "${whepDemux}/bin/whep-watch-demux";
        };

        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_24
            pkgs.typescript
            pkgs.curl
            pkgs.jq
            whepPython
          ];

          shellHook = ''
            export WHEP_PYTHON="${whepPython}/bin/python3"
            export WHEP_DEMUX_PATH="$PWD/scripts/whep-watch-demux.py"
            echo "eve-agent dev shell"
            echo "  WHEP_PYTHON=$WHEP_PYTHON"
            echo "  npm install   # install deps"
            echo "  npm run dev   # local eve (needs model API keys in env)"
            echo "  npm run typecheck"
            echo "  npm run boxd:start  # OpenBao key bridge + eve on :8000"
            echo "  nix build .#whep-python   # GC-rooted via install-whep-deps.sh"
          '';
        };

        formatter = pkgs.nixfmt;
      }
    );
}

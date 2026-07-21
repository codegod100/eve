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
      in
      {
        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_24
            pkgs.typescript
            pkgs.curl
            pkgs.jq
          ];

          shellHook = ''
            echo "eve-agent dev shell"
            echo "  npm install   # install deps"
            echo "  npm run dev   # local eve (needs model API keys in env)"
            echo "  npm run typecheck"
            echo "  npm run boxd:start  # OpenBao key bridge + eve on :8000"
          '';
        };

        formatter = pkgs.nixfmt-rfc-style;
      }
    );
}

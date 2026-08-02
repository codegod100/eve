# system-manager module for eve.boxd.sh (Ubuntu + multi-user Nix).
#
# Apply from the repo root:
#   bash scripts/system-manager-switch.sh
#
# Prerequisites: multi-user Nix with flakes (Determinate installer recommended).
# Agent/IRC services stay as systemd *user* units (see systemd/); this module
# only declares host packages and nix settings so non-interactive deploy shells
# and units can find WHEP deps without a per-user nix build.
{ pkgs, ... }:
let
  whep = import ../whep.nix {
    inherit pkgs;
    demuxScript = ../../scripts/whep-watch-demux.py;
  };
in
{
  config = {
    nixpkgs.hostPlatform = "x86_64-linux";

    nix.settings.experimental-features = [
      "nix-command"
      "flakes"
    ];

    environment.systemPackages = [
      whep.whepPythonBin
      whep.whepDemux
      pkgs.jq
      pkgs.curl
      pkgs.git
    ];
  };
}

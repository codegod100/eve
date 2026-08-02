# system-manager module for eve.boxd.sh (Ubuntu + multi-user Nix).
#
# Composes the generic boxd machine package with eve-specific WHEP tools.
#
# Apply from the repo root:
#   bash scripts/system-manager-switch.sh
#
# Prerequisites: multi-user Nix with flakes (Determinate installer recommended).
# Agent/IRC services stay as systemd *user* units (see systemd/); this module
# only declares host packages and nix settings so non-interactive deploy shells
# and units can find WHEP deps without a per-user nix build.
#
# Generic baseline (no WHEP): nix/boxd/ — for reuse from github:codegod100/nixos.
{ pkgs, ... }:
let
  boxdMachine = import ../boxd/module.nix {
    hostPlatform = "x86_64-linux";
  };
  whep = import ../whep.nix {
    inherit pkgs;
    demuxScript = ../../scripts/whep-watch-demux.py;
  };
in
{
  imports = [ boxdMachine ];

  config = {
    environment.systemPackages = [
      whep.whepPythonBin
      whep.whepDemux
    ];
  };
}

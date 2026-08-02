# Generic host toolset for boxd cloud VMs (Ubuntu + multi-user Nix).
#
# Intended for reuse from a personal NixOS / system-manager flake, e.g.
#   github:codegod100/nixos
# via:
#   pkgs.callPackage (eve + "/nix/boxd/package.nix") { }
# or the flake output `packages.<system>.boxd-machine`.
#
# Eve-specific tools (WHEP Python, demux) are *not* included — compose those
# separately (see nix/whep.nix / nix/system-manager/boxd.nix).
{
  lib,
  symlinkJoin,
  jq,
  curl,
  git,
  # Optional extras for a given machine profile.
  extraPackages ? [ ],
}:
symlinkJoin {
  name = "boxd-machine";
  paths = [
    jq
    curl
    git
  ]
  ++ extraPackages;

  meta = {
    description = "Baseline host tools for boxd cloud VMs";
    longDescription = ''
      Common CLI utilities expected on boxd machines for deploy shells and
      system-manager / NixOS host profiles. Does not include application-specific
      runtimes (e.g. eve WHEP Python).
    '';
    homepage = "https://boxd.sh";
    license = lib.licenses.mit;
    platforms = lib.platforms.linux;
  };
}

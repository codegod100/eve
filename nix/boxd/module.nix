# Reusable system-manager (and NixOS-compatible) module for boxd machines.
#
# Usage from github:codegod100/nixos (or any flake):
#
#   systemConfigs.boxd = system-manager.lib.makeSystemConfig {
#     modules = [
#       (import "${eve}/nix/boxd/module.nix" {
#         hostPlatform = "x86_64-linux";
#         # extraPackages = [ pkgs.htop ];
#       })
#     ];
#   };
#
# Or as a flake output: `systemManagerModules.boxd` / `nixosModules.boxd`.
{
  hostPlatform ? "x86_64-linux",
  extraPackages ? [ ],
}:
{ pkgs, ... }:
{
  config = {
    nixpkgs.hostPlatform = hostPlatform;

    nix.settings.experimental-features = [
      "nix-command"
      "flakes"
    ];

    environment.systemPackages = [
      (pkgs.callPackage ./package.nix { inherit extraPackages; })
    ];
  };
}

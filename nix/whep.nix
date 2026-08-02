# Shared WHEP Python env + wrappers used by flake packages and system-manager.
{
  pkgs,
  demuxScript,
}:
rec {
  # Full python3.withPackages env (aiortc/av linked against nix ffmpeg/libsrtp).
  whepPython = pkgs.python3.withPackages (
    ps: with ps; [
      aiortc
      aiohttp
      av
      numpy
    ]
  );

  # Named binary so /run/system-manager/sw/bin does not shadow host python3.
  whepPythonBin = pkgs.writeShellApplication {
    name = "whep-python";
    text = ''
      exec ${whepPython}/bin/python3 "$@"
    '';
  };

  whepDemux = pkgs.writeShellApplication {
    name = "whep-watch-demux";
    runtimeInputs = [ whepPython ];
    text = ''
      exec ${whepPython}/bin/python3 ${demuxScript} "$@"
    '';
  };
}

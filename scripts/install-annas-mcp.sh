#!/usr/bin/env bash
# Install iosifache/annas-mcp CLI into ~/.local/bin (or DEST).
# https://github.com/iosifache/annas-mcp/releases
set -euo pipefail

VERSION="${ANNAS_MCP_VERSION:-0.1}"
DEST="${ANNAS_MCP_DEST:-$HOME/.local/bin}"
ARCH="$(uname -m)"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"

case "$OS-$ARCH" in
  linux-x86_64|linux-amd64) ASSET="annas-mcp_${VERSION}_linux_amd64.tar.xz" ;;
  linux-aarch64|linux-arm64) ASSET="annas-mcp_${VERSION}_linux_arm64.tar.xz" ;;
  darwin-x86_64|darwin-amd64) ASSET="annas-mcp_${VERSION}_darwin_amd64.tar.xz" ;;
  darwin-arm64) ASSET="annas-mcp_${VERSION}_darwin_arm64.tar.xz" ;;
  *)
    echo "unsupported platform: $OS $ARCH" >&2
    exit 1
    ;;
esac

URL="https://github.com/iosifache/annas-mcp/releases/download/v${VERSION}/${ASSET}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "[install-annas-mcp] $URL → $DEST/annas-mcp"
mkdir -p "$DEST"
curl -fsSL -o "$TMP/annas-mcp.tar.xz" "$URL"
tar -xJf "$TMP/annas-mcp.tar.xz" -C "$TMP"
BIN="$(find "$TMP" -type f -name annas-mcp | head -1)"
if [ -z "$BIN" ]; then
  echo "binary not found in archive" >&2
  exit 1
fi
install -m 755 "$BIN" "$DEST/annas-mcp"
echo "[install-annas-mcp] ok: $($DEST/annas-mcp --version 2>/dev/null || echo installed at $DEST/annas-mcp)"

#!/usr/bin/env bash
# One-line install of Pathline Run on a Raspberry Pi:
#   curl -fsSL https://github.com/AESGlobalEngineering/Pathline/releases/download/run-latest/install-pi.sh | bash
# Downloads the latest Pi package into ~/pathline-run and runs its install.sh.
set -euo pipefail
URL="https://github.com/AESGlobalEngineering/Pathline/releases/download/run-latest/Pathline-Run-pi.tar.gz"
DEST="$HOME"
echo "Downloading Pathline Run…"
TMP="$(mktemp -d)"
curl -fSL --progress-bar -o "$TMP/pathline-run.tar.gz" "$URL"
tar -xzf "$TMP/pathline-run.tar.gz" -C "$DEST"
rm -rf "$TMP"
bash "$DEST/pathline-run/install.sh"

#!/usr/bin/env bash
# Installs Pathline Run on a Raspberry Pi (Raspberry Pi OS Bookworm 64-bit with desktop):
#   curl -fsSL https://github.com/AESGlobalEngineering/Pathline/releases/download/run-latest/install-pi.sh | bash
# - downloads the Pathline Run AppImage to ~/Applications (it updates itself there, like Pathline)
# - adds it to the menu, and opens it full screen (--kiosk) at login
# - libfuse2 for AppImages, and serial port access (dialout) for a Trotec on USB
set -euo pipefail

case "$(uname -m)" in
  aarch64|arm64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=x86_64 ;;
  *) echo "Pathline Run needs a 64-bit Raspberry Pi OS (this is $(uname -m))." >&2; exit 1 ;;
esac
URL="https://github.com/AESGlobalEngineering/Pathline/releases/download/run-latest/Pathline-Run-$ARCH.AppImage"
DEST="$HOME/Applications"
APP="$DEST/Pathline-Run.AppImage"

echo "Downloading Pathline Run…"
mkdir -p "$DEST"
curl -fSL --progress-bar -o "$APP.part" "$URL"
mv "$APP.part" "$APP"
chmod +x "$APP"

echo "Installing libfuse2 and serial port access (asks for your password)…"
sudo apt-get update -qq
sudo apt-get install -y -qq libfuse2t64 >/dev/null 2>&1 || sudo apt-get install -y -qq libfuse2
sudo usermod -aG dialout "$USER"

# menu entry
mkdir -p "$HOME/.local/share/applications"
cat > "$HOME/.local/share/applications/pathline-run.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Pathline Run
Comment=Runs Pathline jobs on this machine
Exec="$APP"
Categories=Utility;
EOF

# full screen at login: the XDG autostart folder (X11, wayfire) and labwc (Bookworm's default since late 2024)
mkdir -p "$HOME/.config/autostart" "$HOME/.config/labwc"
cat > "$HOME/.config/autostart/pathline-run.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Pathline Run
Exec="$APP" --kiosk
X-GNOME-Autostart-enabled=true
EOF
grep -qs "Pathline-Run.AppImage" "$HOME/.config/labwc/autostart" || echo "\"$APP\" --kiosk &" >> "$HOME/.config/labwc/autostart"

IP="$(hostname -I | awk '{print $1}')"
echo
echo "Done. Restart the Pi: Pathline Run opens full screen when you log in."
echo "In Pathline: Setup → Machines → Add machine → Ethernet, IP $IP, port 8470."
echo "Pathline Run checks for updates itself and asks before installing one."

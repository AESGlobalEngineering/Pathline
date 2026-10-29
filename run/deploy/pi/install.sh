#!/usr/bin/env bash
# Sets up Pathline Run on a Raspberry Pi (Raspberry Pi OS Bookworm, 64-bit, desktop).
# Run it from the extracted Pi package (the folder with launcher.js):  bash install.sh
# (install-pi.sh downloads the package and runs this for you.)
#   - Node.js 22 (NodeSource) if Node 18+ isn't there
#   - a systemd service that starts Pathline Run at boot (port 8470) and keeps it running
#   - Chromium full screen on the touchscreen at login
#   - serial port access (dialout group) for Trotec USB
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
USER_NAME="${SUDO_USER:-$USER}"
USER_HOME="$(getent passwd "$USER_NAME" | cut -d: -f6)"

if [ ! -f "$ROOT/launcher.js" ] || [ ! -f "$ROOT/app/current" ]; then
  echo "Run this from the extracted Pathline Run Pi package (the folder with launcher.js)." >&2
  exit 1
fi
echo "Pathline Run $(cat "$ROOT/app/current") in $ROOT for user $USER_NAME"

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  echo "Installing Node.js 22…"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

sudo usermod -aG dialout "$USER_NAME"

sed -e "s|@ROOT@|$ROOT|g" -e "s|@USER@|$USER_NAME|g" "$ROOT/pathline-run.service" | sudo tee /etc/systemd/system/pathline-run.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable pathline-run
sudo systemctl restart pathline-run

# kiosk: labwc (Bookworm's default desktop since late 2024), wayfire, and the X11 autostart folder
KIOSK="$ROOT/kiosk.sh"
chmod +x "$KIOSK"
mkdir -p "$USER_HOME/.config/labwc" "$USER_HOME/.config/autostart"
grep -qs "pathline-run" "$USER_HOME/.config/labwc/autostart" || echo "$KIOSK &  # pathline-run" >> "$USER_HOME/.config/labwc/autostart"
if [ -f "$USER_HOME/.config/wayfire.ini" ] && ! grep -qs "pathline-run" "$USER_HOME/.config/wayfire.ini"; then
  printf '\n[autostart]\npathline-run = %s\n' "$KIOSK" >> "$USER_HOME/.config/wayfire.ini"
fi
cat > "$USER_HOME/.config/autostart/pathline-run.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Pathline Run
Exec=$KIOSK
X-GNOME-Autostart-enabled=true
EOF
chown -R "$USER_NAME": "$USER_HOME/.config" "$ROOT"

IP="$(hostname -I | awk '{print $1}')"
echo
echo "Done. Pathline Run is running: http://$IP:8470/"
echo "In Pathline: Setup → Machines → Add machine → Ethernet, IP $IP, port 8470."
echo "It updates itself. Reboot once for the full-screen kiosk and serial port access."

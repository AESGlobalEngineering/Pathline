#!/usr/bin/env bash
# Installs Pathline Run on a Raspberry Pi (Raspberry Pi OS Bookworm, 64-bit, desktop):
#   - Node.js 22 (NodeSource) if Node 18+ isn't there
#   - npm install (serial port support for Trotec USB)
#   - a systemd service that starts Pathline Run at boot (port 8470)
#   - Chromium in kiosk mode on the touchscreen at login
#   - serial port access (dialout group)
# Run from the run/ folder:  bash deploy/pi/install.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
USER_NAME="${SUDO_USER:-$USER}"
USER_HOME="$(getent passwd "$USER_NAME" | cut -d: -f6)"

echo "Pathline Run in $APP_DIR for user $USER_NAME"

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  echo "Installing Node.js 22…"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

cd "$APP_DIR"
npm install --omit=dev

# serial port access for the Trotec USB link
sudo usermod -aG dialout "$USER_NAME"

# service
sed -e "s|@APP_DIR@|$APP_DIR|g" -e "s|@USER@|$USER_NAME|g" "$APP_DIR/deploy/pi/pathline-run.service" | sudo tee /etc/systemd/system/pathline-run.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now pathline-run

# kiosk: labwc (Bookworm's default desktop since late 2024) and the older wayfire / LXDE-X11 sessions
KIOSK="$APP_DIR/deploy/pi/kiosk.sh"
chmod +x "$KIOSK"
mkdir -p "$USER_HOME/.config/labwc"
grep -qs "pathline-run" "$USER_HOME/.config/labwc/autostart" || echo "$KIOSK &  # pathline-run" >> "$USER_HOME/.config/labwc/autostart"
if [ -f "$USER_HOME/.config/wayfire.ini" ] && ! grep -qs "pathline-run" "$USER_HOME/.config/wayfire.ini"; then
  printf '\n[autostart]\npathline-run = %s\n' "$KIOSK" >> "$USER_HOME/.config/wayfire.ini"
fi
mkdir -p "$USER_HOME/.config/autostart"
cat > "$USER_HOME/.config/autostart/pathline-run.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Pathline Run
Exec=$KIOSK
X-GNOME-Autostart-enabled=true
EOF
chown -R "$USER_NAME": "$USER_HOME/.config"

IP="$(hostname -I | awk '{print $1}')"
echo
echo "Done. Pathline Run is running: http://$IP:8470/"
echo "In Pathline: Setup → Machines → Add machine → Ethernet, IP $IP, port 8470."
echo "Log out and back in (or reboot) for the kiosk screen and serial port access."

#!/usr/bin/env bash
# Turns a Raspberry Pi into a Pathline Run station: switched on, it goes straight into Pathline
# Run full screen (no desktop, no login), starts it again if it ever stops, and is safe to switch
# off at the wall. Plain-words guide: run/deploy/pi/README.md.
#
# On Raspberry Pi OS Lite (64-bit), Bookworm or newer, on a Pi 4 or 5:
#   curl -fsSL https://github.com/AESGlobalEngineering/Pathline/releases/download/pathlinerun/install-pi.sh | sudo bash
# Options (after "sudo bash -s --" when piped, or after the file name):
#   --appimage FILE   install this Pathline Run AppImage instead of downloading it (a USB stick)
#   --reinstall       download Pathline Run again even if it's already there (it updates itself)
#   --rotate N        turn the picture and the touch: 0, 90, 180 or 270 (a screen mounted turned;
#                     the 10" Touch Display 2 is tall: 90 or 270 lays it on its side)
#   --touch-rotate N  turn only the touch, when taps land in the wrong place after --rotate
#                     (0 if the screen already turns its own touch)
#   --scale N         make everything on the screen bigger: 1 (as it is), 1.25, 1.5, 1.75 or 2.
#                     For sharp small screens: a 10" at 1920×1200 wants 1.5; at 1280×800 leave it.
#                     Raspberry Pi's 10" Touch Display 2 is found by itself and gets 1.5
#   --hide-cursor     never show a mouse pointer (touch screens that pretend to be a mouse)
#   --reboot          restart the Pi at the end
# Running it again is safe: it only puts back what it set (and keeps Pathline Run's data).
set -euo pipefail

RUN_USER=pathline
RUN_HOME=/home/$RUN_USER
APP_DIR=$RUN_HOME/Applications
APP=$APP_DIR/Pathline-Run.AppImage
RELEASE=https://github.com/AESGlobalEngineering/Pathline/releases/download/pathlinerun

APPIMAGE_FILE="" REINSTALL=0 ROTATE="" TOUCH_ROTATE="" SCALE="" HIDE_CURSOR="" REBOOT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --appimage) APPIMAGE_FILE="$2"; shift ;;
    --reinstall) REINSTALL=1 ;;
    --rotate) ROTATE="$2"; shift ;;
    --touch-rotate) TOUCH_ROTATE="$2"; shift ;;
    --scale) SCALE="$2"; shift ;;
    --hide-cursor) HIDE_CURSOR=1 ;;
    --reboot) REBOOT=1 ;;
    *) echo "Unknown option: $1 (see the top of this script)" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\n== %s\n' "$*"; }
die() { printf '\nPathline Run setup stopped: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "it needs to run as the administrator. Put sudo in front: curl -fsSL $RELEASE/install-pi.sh | sudo bash"
case "$(uname -m)" in
  aarch64|arm64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=x86_64 ;;
  *) die "Pathline Run needs the 64-bit Raspberry Pi OS (this one is $(uname -m))." ;;
esac
case "$ROTATE" in ""|0|90|180|270) ;; *) die "--rotate takes 0, 90, 180 or 270" ;; esac
case "$TOUCH_ROTATE" in ""|0|90|180|270) ;; *) die "--touch-rotate takes 0, 90, 180 or 270" ;; esac
case "$SCALE" in ""|auto|1|1.25|1.5|1.75|2) ;; *) die "--scale takes auto, 1, 1.25, 1.5, 1.75 or 2" ;; esac
if [ -n "$APPIMAGE_FILE" ] && [ ! -s "$APPIMAGE_FILE" ]; then die "there's no file at $APPIMAGE_FILE"; fi

# ---------------------------------------------------------------- packages
say "Installing what Pathline Run needs (a few minutes the first time)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# A first install brings Raspberry Pi OS and the Pi's firmware up to date (Raspberry Pi asks for
# this for the 10" Touch Display 2); running the setup again later leaves them be
if [ ! -s "$APP" ] || [ "$REINSTALL" = 1 ]; then
  say "Bringing Raspberry Pi OS up to date first (this can take a while)"
  apt-get full-upgrade -y -qq >/dev/null
  if command -v rpi-eeprom-update >/dev/null 2>&1; then rpi-eeprom-update -a >/dev/null || true; fi
fi
# the first name that exists in this release of Raspberry Pi OS (Trixie renamed some: …t64)
pick() { for p in "$@"; do if apt-cache show "$p" >/dev/null 2>&1; then echo "$p"; return; fi; done; }
PKGS=(cage wlr-randr curl ca-certificates)
for alt in "libfuse2t64 libfuse2" "libgtk-3-0t64 libgtk-3-0" "libnss3" "libasound2t64 libasound2" "libcups2t64 libcups2" \
           "libgbm1" "libxss1" "libxtst6" "libatspi2.0-0t64 libatspi2.0-0" "libsecret-1-0" "libnotify4" "libuuid1" "xdg-utils" \
           "fonts-ibm-plex" "fonts-dejavu-core"; do
  p=$(pick $alt)
  if [ -n "$p" ]; then PKGS+=("$p"); fi
done
apt-get install -y -qq --no-install-recommends "${PKGS[@]}" >/dev/null

# ---------------------------------------------------------------- the user Pathline Run runs as
say "Setting up the '$RUN_USER' user (no password: nobody logs in as it)"
if ! id "$RUN_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "Pathline Run" "$RUN_USER" >/dev/null
fi
# serial ports (the Trotec on USB, the Z axis ESP32), the screen and GPU, touch, the camera, the network
for g in dialout video render input plugdev netdev; do
  if getent group "$g" >/dev/null; then usermod -aG "$g" "$RUN_USER"; fi
done

# ---------------------------------------------------------------- Pathline Run itself
say "Putting Pathline Run in $APP"
install -d -o "$RUN_USER" -g "$RUN_USER" "$APP_DIR"
if [ -n "$APPIMAGE_FILE" ]; then
  install -o "$RUN_USER" -g "$RUN_USER" -m 755 "$APPIMAGE_FILE" "$APP.part"
  mv -f "$APP.part" "$APP"
elif [ ! -s "$APP" ] || [ "$REINSTALL" = 1 ]; then
  curl -fSL --progress-bar -o "$APP.part" "$RELEASE/Pathline-Run-$ARCH.AppImage"
  chown "$RUN_USER:$RUN_USER" "$APP.part"; chmod 755 "$APP.part"
  mv -f "$APP.part" "$APP"
else
  echo "Already there (it keeps itself up to date). --reinstall downloads it again."
fi
sync

# ---------------------------------------------------------------- settings file (kept when run again)
if [ ! -f /etc/default/pathline-run ]; then
  cat > /etc/default/pathline-run <<'EOF'
# Pathline Run kiosk settings (run/deploy/pi/README.md). After a change, restart the Pi
# (never while a job is running).
#   ROTATE   turn the picture: 0, 90, 180 or 270 (set it with the setup script's --rotate, which
#            turns the touch to match)
#   TOUCH_ROTATE  turn the touch differently from the picture (the setup's --touch-rotate);
#            empty: the same as ROTATE
#   SCALE    make everything bigger: 1, 1.25, 1.5, 1.75 or 2 (a 10" screen at 1920×1200: 1.5).
#            auto: 1.5 on Raspberry Pi's 10" Touch Display 2, otherwise 1
#   ARGS     more for Pathline Run: --hide-cursor (no mouse pointer ever), --no-keyboard (no
#            on-screen keyboard: a real keyboard is plugged in)
ROTATE=0
TOUCH_ROTATE=
SCALE=auto
ARGS=""
EOF
fi
set_setting() { # name value
  if grep -q "^$1=" /etc/default/pathline-run; then sed -i "s|^$1=.*|$1=$2|" /etc/default/pathline-run; else echo "$1=$2" >> /etc/default/pathline-run; fi
}
if [ -n "$ROTATE" ]; then
  set_setting ROTATE "$ROTATE"
  # a new turn: the touch follows it, unless told otherwise in the same run
  if [ -z "$TOUCH_ROTATE" ]; then set_setting TOUCH_ROTATE ""; fi
fi
if [ -n "$TOUCH_ROTATE" ]; then set_setting TOUCH_ROTATE "$TOUCH_ROTATE"; fi
if [ -n "$SCALE" ]; then set_setting SCALE "$SCALE"; fi
if [ -n "$HIDE_CURSOR" ] && ! grep -q -- '--hide-cursor' /etc/default/pathline-run; then
  sed -i 's|^ARGS="\(.*\)"|ARGS="\1 --hide-cursor"|; s|^ARGS=" |ARGS="|' /etc/default/pathline-run
fi

# touch turned with the picture (libinput reads this for every touch screen)
. /etc/default/pathline-run
case "${TOUCH_ROTATE:-${ROTATE:-0}}" in
  90)  MATRIX="0 1 0 -1 0 1" ;;
  180) MATRIX="-1 0 1 0 -1 1" ;;
  270) MATRIX="0 -1 1 1 0 0" ;;
  *)   MATRIX="" ;;
esac
if [ -n "$MATRIX" ]; then
  echo "ENV{ID_INPUT_TOUCHSCREEN}==\"1\", ENV{LIBINPUT_CALIBRATION_MATRIX}=\"$MATRIX\"" > /etc/udev/rules.d/99-pathline-run-touch.rules
else
  rm -f /etc/udev/rules.d/99-pathline-run-touch.rules
fi

# ---------------------------------------------------------------- what starts it
say "Making the Pi start Pathline Run full screen when it's switched on"
cat > /usr/local/bin/pathline-run-kiosk <<'EOF'
#!/bin/sh
# Started by pathline-run.service inside cage (a full-screen-only display): runs Pathline Run.
# Made by run/deploy/pi/install-pi.sh.
[ -f /etc/default/pathline-run ] && . /etc/default/pathline-run
APP="$HOME/Applications/Pathline-Run.AppImage"
PREV="$APP.prev"
# An update swaps the AppImage for the new one (removes it, then moves the new one in). Had the
# power gone in that moment, the copy kept aside below starts instead.
if [ ! -s "$APP" ] && [ -s "$PREV" ]; then cp "$PREV" "$APP.part" && chmod 755 "$APP.part" && mv -f "$APP.part" "$APP"; fi
# keep that copy aside: a second name for the same file, so it takes no extra space
ln -f "$APP" "$PREV" 2>/dev/null || true
# a screen mounted turned: turned before Pathline Run opens, so it lays out once (the Pi's own
# DSI screen first, if there's one; the screen can take a moment to be listed)
if [ -n "$ROTATE" ] && [ "$ROTATE" != 0 ]; then
  for i in 1 2 3 4 5 6 7 8 9 10; do
    OUT=$(wlr-randr 2>/dev/null | awk '/^[^ ]/{ if (!first) first = $1; if ($1 ~ /^DSI/ && !dsi) dsi = $1 } END { print (dsi ? dsi : first) }')
    if [ -n "$OUT" ]; then wlr-randr --output "$OUT" --transform "$ROTATE" && break; fi
    sleep 0.3
  done
fi
# Pathline Run's "already running" lock, left behind if the power went: nothing else can be
# running here (systemd stops everything the last one started before starting it again)
rm -f "$HOME/.config/Pathline Run/SingletonLock" "$HOME/.config/Pathline Run/SingletonSocket" "$HOME/.config/Pathline Run/SingletonCookie"
# everything bigger on a sharp small screen. auto: Raspberry Pi's 10" Touch Display 2
# (1200×1920, about 225 dots an inch) gets 1.5, which lays Pathline Run out at its own 1280×800
if [ -z "$SCALE" ] || [ "$SCALE" = auto ]; then
  SCALE=1
  if grep -qs '^1200x1920' /sys/class/drm/card*-DSI-*/modes; then SCALE=1.5; fi
fi
case "$SCALE" in 1) ;; *) ARGS="--zoom=$SCALE $ARGS" ;; esac
# shellcheck disable=SC2086
exec "$APP" --kiosk --ozone-platform=wayland $ARGS
EOF
chmod 755 /usr/local/bin/pathline-run-kiosk

cat > /etc/systemd/system/pathline-run.service <<EOF
# Pathline Run, full screen on the Pi's screen from power on (run/deploy/pi/install-pi.sh).
# cage shows one program full screen and nothing else; when Pathline Run stops, cage stops and
# systemd starts both again two seconds later, however it stopped.
[Unit]
Description=Pathline Run (full screen)
After=systemd-user-sessions.service plymouth-quit-wait.service network.target
Wants=network.target
Conflicts=getty@tty1.service
After=getty@tty1.service
StartLimitIntervalSec=0

[Service]
User=$RUN_USER
PAMName=login
TTYPath=/dev/tty1
TTYReset=yes
TTYVHangup=yes
TTYVTDisallocate=yes
StandardInput=tty-fail
StandardOutput=journal
StandardError=journal
UtmpIdentifier=tty1
UtmpMode=user
Environment=XDG_SESSION_TYPE=wayland
WorkingDirectory=$RUN_HOME
ExecStart=/usr/bin/cage -d -s -- /usr/local/bin/pathline-run-kiosk
Restart=always
RestartSec=2
# time to stop the machine safely when the Pi is shut down properly
TimeoutStopSec=20

[Install]
WantedBy=graphical.target
EOF

# no desktop, no login prompt on the screen (the second console, Ctrl+Alt+F2, still has one)
for dm in lightdm gdm3 sddm; do systemctl disable "$dm" >/dev/null 2>&1 || true; done
systemctl disable getty@tty1 >/dev/null 2>&1 || true
rm -f /etc/systemd/system/getty@tty1.service.d/autologin.conf
systemctl set-default graphical.target >/dev/null
systemctl daemon-reload
systemctl enable pathline-run >/dev/null

# ---------------------------------------------------------------- machines on USB
say "Leaving the laser's USB port to Pathline Run"
# ModemManager tries every USB serial port as a modem (sending it AT commands): not on this Pi
systemctl disable --now ModemManager >/dev/null 2>&1 || true
cat > /etc/udev/rules.d/99-pathline-run-serial.rules <<'EOF'
# Pathline Run (run/deploy/pi/install-pi.sh): the Trotec controller's USB serial port is the
# laser's, not a modem's or a braille display's
ATTRS{idVendor}=="1cbe", ATTRS{idProduct}=="0002", ENV{ID_MM_DEVICE_IGNORE}="1"
EOF
# brltty (a braille display driver, on the desktop edition) takes USB serial chips like the Z axis ESP32's
if dpkg -s brltty >/dev/null 2>&1; then systemctl mask brltty.service brltty-udev.service >/dev/null 2>&1 || true; fi
udevadm control --reload-rules >/dev/null 2>&1 || true

# Pathline Run may set the Pi's own IP address (Setup → Network): NetworkManager lets it
if [ -d /etc/polkit-1/rules.d ]; then
  cat > /etc/polkit-1/rules.d/50-pathline-run.rules <<EOF
// Pathline Run (run/deploy/pi/install-pi.sh) sets this Pi's IP address from its Setup screen
polkit.addRule(function (action, subject) {
  if (action.id.indexOf("org.freedesktop.NetworkManager.") === 0 && subject.user === "$RUN_USER") return polkit.Result.YES;
});
EOF
fi

# ---------------------------------------------------------------- screen always on, safe power off
say "Keeping the screen on and making it safe to switch off at the wall"
BOOT=/boot/firmware; [ -f $BOOT/cmdline.txt ] || BOOT=/boot
if [ -f $BOOT/cmdline.txt ]; then
  # consoleblank=0: the screen never blanks. fsck.repair=yes: a disk check after a power cut fixes
  # what it finds by itself. usbcore.usbfs_memory_mb: room for the head camera's pictures (USB3).
  # quiet …: no scrolling text at boot
  # (each setting once: an earlier value of it is replaced; the file stays one line)
  LINE=$(head -n1 $BOOT/cmdline.txt)
  for opt in consoleblank=0 fsck.repair=yes usbcore.usbfs_memory_mb=1000 quiet loglevel=3 logo.nologo vt.global_cursor_default=0; do
    LINE="$(printf '%s\n' "$LINE" | awk -v k="${opt%%=*}" '{ s = ""; for (i = 1; i <= NF; i++) { split($i, a, "="); if (a[1] != k) s = s $i " " } printf "%s", s }')$opt"
  done
  if [ "$LINE" != "$(head -n1 $BOOT/cmdline.txt)" ]; then
    cp $BOOT/cmdline.txt $BOOT/cmdline.txt.before-pathline-run 2>/dev/null || true
    printf '%s\n' "$LINE" > $BOOT/cmdline.txt.new && sync && mv -f $BOOT/cmdline.txt.new $BOOT/cmdline.txt
  fi
fi
if [ -f $BOOT/config.txt ] && ! grep -q '^disable_splash=1' $BOOT/config.txt; then
  printf '\n# Pathline Run: no rainbow square at boot\ndisable_splash=1\n' >> $BOOT/config.txt
fi
# the Pi's own watchdog restarts it if it ever hangs completely
mkdir -p /etc/systemd/system.conf.d
printf '[Manager]\nRuntimeWatchdogSec=15\nRebootWatchdogSec=2min\n' > /etc/systemd/system.conf.d/pathline-run-watchdog.conf
# the system log keeps to 100 MB, sparing the SD card
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=100M\n' > /etc/systemd/journald.conf.d/pathline-run.conf
sync

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
say "Done"
echo "Restart the Pi: Pathline Run then comes up full screen by itself whenever it's switched on."
echo "In Pathline: Setup → Machines → Add machine → Ethernet, IP ${IP:-(this Pi's address)}, port 8470."
echo "Pathline Run checks for updates itself and asks on its screen before installing one."
if grep -qs '^1200x1920' /sys/class/drm/card*-DSI-*/modes; then
  echo "Found Raspberry Pi's 10\" Touch Display 2: Pathline Run is shown 1.5 times bigger on it."
  if [ "${ROTATE:-0}" = 0 ]; then echo "It stands tall as it is. On its side (Pathline Run's own layout): run this setup again with --rotate 90 (or 270)."; fi
fi
if [ "$REBOOT" = 1 ]; then echo "Restarting now…"; sleep 2; systemctl reboot; fi

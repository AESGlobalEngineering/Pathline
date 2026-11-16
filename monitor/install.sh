#!/bin/sh
# Puts Pathline Monitor on an Amazon Linux 2023 server (or another Linux with dnf and systemd)
# that has nothing else on ports 80 and 443:
#
#   sudo sh install.sh monitor.example.com
#
# It installs Node.js and certbot, copies the files to /opt/pathline-monitor, asks for the
# workshop password, gets a Let's Encrypt certificate for that address, and starts the service.
# Run it again from a newer download to update: the password, certificate, machines and phones
# are kept (/etc/pathline-monitor, /etc/letsencrypt, /var/lib/pathline-monitor).
# Before it: the address must point at this server, and ports 80 and 443 must be open to it.
set -e
DOMAIN="$1"
HERE="$(cd "$(dirname "$0")" && pwd)"
if [ -z "$DOMAIN" ] || [ "$(id -u)" != 0 ]; then echo "Use: sudo sh install.sh monitor.example.com"; exit 1; fi
if [ ! -f "$HERE/server.js" ]; then echo "Run this from the unzipped Pathline Monitor folder."; exit 1; fi

echo "1/5  Node.js and certbot"
command -v node > /dev/null || dnf install -y nodejs
command -v certbot > /dev/null || dnf install -y certbot
node -e 'process.exit(parseInt(process.versions.node) >= 18 ? 0 : 1)' || { echo "Pathline Monitor needs Node.js 18 or newer (this is $(node -v))."; exit 1; }

echo "2/5  The files, in /opt/pathline-monitor"
mkdir -p /opt/pathline-monitor
rm -rf /opt/pathline-monitor/lib /opt/pathline-monitor/app
cp -r "$HERE/server.js" "$HERE/package.json" "$HERE/lib" "$HERE/app" /opt/pathline-monitor/

echo "3/5  The workshop password"
if [ ! -s /etc/pathline-monitor/password ]; then
  printf 'Choose the password phones sign in with (8 characters or more): '
  read -r PW
  if [ "${#PW}" -lt 8 ]; then echo "That's shorter than 8 characters. Run this again."; exit 1; fi
  mkdir -p /etc/pathline-monitor
  chmod 700 /etc/pathline-monitor
  (umask 077; printf '%s\n' "$PW" > /etc/pathline-monitor/password)
else
  echo "     kept (to change it: edit /etc/pathline-monitor/password, then sudo systemctl restart pathline-monitor)"
fi

echo "4/5  The certificate for $DOMAIN"
if [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  # certbot asks for an email address and for agreement to Let's Encrypt's terms
  certbot certonly --standalone -d "$DOMAIN" --deploy-hook "systemctl restart pathline-monitor"
else
  echo "     kept"
fi
# renewed by itself every couple of months (the service restarts to pick the new one up)
systemctl enable --now certbot-renew.timer 2> /dev/null || echo "     NOTE: no certbot-renew.timer here. Add a daily 'certbot renew' to root's crontab."

echo "5/5  The service"
sed "s/DOMAIN/$DOMAIN/g" "$HERE/pathline-monitor.service" > /etc/systemd/system/pathline-monitor.service
systemctl daemon-reload
systemctl enable pathline-monitor > /dev/null 2>&1
systemctl restart pathline-monitor
sleep 2
if systemctl is-active --quiet pathline-monitor; then
  echo
  echo "Pathline Monitor is running: https://$DOMAIN"
  echo "Open it on a phone and sign in with the workshop password."
else
  echo
  echo "Pathline Monitor didn't start. What it said:"
  journalctl -u pathline-monitor --no-pager -n 20
  exit 1
fi

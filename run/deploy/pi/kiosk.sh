#!/usr/bin/env bash
# Full-screen Pathline Run on the Pi's touchscreen. Waits for the service first.
for i in $(seq 1 60); do
  curl -fs http://localhost:8470/api/v1/info >/dev/null && break
  sleep 1
done
BROWSER="$(command -v chromium-browser || command -v chromium)"
exec "$BROWSER" --kiosk --noerrdialogs --disable-infobars --no-first-run --disable-session-crashed-bubble \
  --disable-pinch --overscroll-history-navigation=0 --check-for-update-interval=31536000 \
  http://localhost:8470/

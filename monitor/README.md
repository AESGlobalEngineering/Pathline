# Pathline Monitor

An internal phone app, for the workshop network only. It shows every Pathline Run machine: what each one is doing, how long the job has left, what's queued, and what finished today. When a job finishes, or a machine is stuck waiting for someone, the phone shows an alert with a tone.

```
Pathline Run (each machine) ◀──HTTP 8470──  Pathline Monitor service  ──HTTP 8480──▶  phones on the
                                             (one workshop PC or Pi)                  workshop Wi-Fi
```

It only watches. Nothing on the phone starts, pauses or moves a machine on: a laser is started by someone standing at it. Nothing leaves the workshop network.

## What makes an alert

| What happens | Alert |
|---|---|
| A job finishes | **Laser A finished Coasters**: how long it took, and what's waiting (lasers need Start at the machine) |
| The last queued job finishes | The same alert, which also counts as "a queue runs out" |
| A registration mark can't be found | **Laser C needs you** |
| An error, a stopped job, or a machine not answering for 20 s | **Laser E stopped answering** and so on |
| Lid opened, or Pause pressed at the machine | None. It's shown in the app, but someone is already there |
| A machine answers again | Listed in Alerts, without a tone |

Each phone chooses which of these it gets (Settings), can mute single machines, and can set quiet hours (18:00 to 07:00, no tone).

## Set up

On a PC or Raspberry Pi that's always on, on the same network as the machines, with Node.js 18 or newer. Use the whole Pathline folder: Monitor finds machines with Pathline Prepare's own code (`src/main/discover.js`).

```bash
cd monitor
npm install
node server.js
```

It prints the address for phones, for example `http://192.168.1.20:8480`.

### Finding the machines

Monitor finds machines the way Pathline Prepare's **Add machine → Find machines** does. It looks when it starts, every 10 minutes, and when **Look now** is pressed in the app's Settings:

- it asks the network for Pathline Run's announcement (`_pathline._tcp.local`), and
- it tries port 8470 on every address of this computer's own network.

Machines it finds are kept in `data/found.json`, so a machine that's switched off still shows (as Offline). A machine on another network, or on a port other than 8470, can be listed in `config.json` (copy `config.example.json`):

```json
{
  "port": 8480,
  "machines": [{ "name": "Laser A", "host": "192.168.1.40", "port": 8470 }]
}
```

`"find": false` turns the network search off.

### On each phone

Open the address it printed, in Safari (iPhone) or Chrome (Android), on the workshop Wi-Fi. To keep it one tap away:

- **iPhone**: Share → **Add to Home Screen**.
- **Android**: menu → **Add to Home screen**.

Alerts show while Pathline Monitor is open on the phone: a banner, a short tone and a buzz. Phones only play sound after a tap, so tap the app once after opening it. **Try it** in Settings shows how an alert looks and sounds.

### Alerts with the app closed (optional)

Phones only deliver alerts to a closed app from an `https://` address they trust. On the local network that means a certificate from your own small certificate authority. Everything still stays on the workshop network, but the Monitor computer needs internet access, because phones receive these alerts through Apple's and Google's push services.

1. On the Monitor computer, install [mkcert](https://github.com/FiloSottile/mkcert), then run `mkcert -install` and `mkcert 192.168.1.20` (its own address). Put the two `.pem` files next to `config.json` and add `"tls": { "cert": "192.168.1.20.pem", "key": "192.168.1.20-key.pem" }`.
2. Trust the authority on each phone. Send `rootCA.pem` (`mkcert -CAROOT` shows where it is) to the phone.
   - **iPhone**: install it as a profile (Settings → General → VPN & Device Management), then turn it on in Settings → General → About → Certificate Trust Settings.
   - **Android**: Settings → Security → Encryption & credentials → Install a certificate → CA certificate.
3. Open `https://192.168.1.20:8480`. On iPhone, add it to the Home Screen and open it from there (iOS 16.4 or newer). Then Settings → **Turn on**, and **Send a test**.

### Keep it running

- **Windows**: Task Scheduler → Create Task → "Run whether user is logged on or not", trigger **At startup**, action `node` with argument `server.js`, "Start in" the `monitor` folder. Allow Node.js through Windows Firewall on private networks, for port 8480 and for the search (mDNS answers come back to it).
- **Raspberry Pi**: a systemd service with `WorkingDirectory=/home/pi/Pathline/monitor` and `ExecStart=/usr/bin/node server.js`, `Restart=always`.

## What it keeps

In `monitor/data/` (left out of git):

- `found.json`: the machines found on the network.
- `devices.json`: each phone's alert choices (and its push subscription, with https).
- `alerts.json`: the last 14 days of alerts (300 at most).
- `vapid.json`: the push keys, used only with https.

## How it works

- `lib/watch.js` asks each machine's Pathline Run every 2 s (`GET /api/local/state`, the same data Run's own screen uses, and `GET /api/v1/info` once a minute). It turns the answers into one view per machine, and compares each look with the last to make the alerts in the table above.
- `server.js` finds machines (`../src/main/discover.js`) and keeps the alerts. It streams the machines and alerts to the app (`GET /api/events`) and serves the app. With https it also sends Web Push.
- `app/` is the phone app: `app.js` (screens, and the banner and tone for new alerts), `sw.js` (service worker, used with https), `manifest.webmanifest` and the icons. `tools/make-icons.js` redraws the icons from the Pathline mark (run it with Electron).

`npm test` puts a stand-in Pathline Run through each case and checks which alerts come out.

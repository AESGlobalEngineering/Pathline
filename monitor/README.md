# Pathline Monitor

A phone app (a progressive web app) for the workshop network only. It shows every Pathline Run machine: what each one is doing, how long the job has left, what's queued, and what finished today. When a job finishes, or a machine is stuck waiting for someone, the phone gets an alert, even with the app closed.

The phones get the app, and the machines' news, from the **Monitor hub**: one always-on PC or Pi on the same network, set up once.

```
Pathline Run (each machine) ◀──HTTP 8470──  Monitor hub              ──https 8443──▶  the app, on phones
                                             (one workshop PC or Pi)  ──http 8480───▶  (setup, and as a web page)
```

It only watches. Nothing on the phone starts, pauses or moves a machine on: a laser is started by someone standing at it. The machines' data never leaves the workshop network.

## What makes an alert

| What happens | Alert |
|---|---|
| A job finishes | **Laser A finished Coasters**: how long it took, and what's waiting (lasers need Start at the machine) |
| The last queued job finishes | The same alert, which also counts as "a queue runs out" |
| A registration mark can't be found | **Laser C needs you** |
| An error, a stopped job, or a machine not answering for 20 s | **Laser E stopped answering** and so on |
| Lid opened, or Pause pressed at the machine | None. It's shown in the app, but someone is already there |
| A machine answers again | Listed in Alerts, without a tone |

Each phone chooses which of these it gets (Settings), can mute single machines, and can set quiet hours (18:00 to 07:00, no sound).

## Get it on a phone

1. On the hub PC, open `http://localhost:8480`. It shows a QR code.
2. On the phone, on the workshop Wi-Fi, scan it with the camera. It opens **Set up this phone** (`http://<hub>:8480/setup`), which walks through the rest and checks each step as it goes:
   - **Download the workshop certificate**: a profile on iPhone, a certificate file on Android.
   - **Install and trust it**:
     - **iPhone**: Settings → Profile Downloaded → Install, then Settings → General → About → Certificate Trust Settings → turn on **Pathline Monitor workshop**.
     - **Android**: Settings → Security & privacy → More security settings → Encryption & credentials → Install a certificate → CA certificate.
   - **Open the app** (`https://<hub>:8443`). The page turns this step green as soon as the phone trusts the certificate.
   - **Add it to the Home Screen** (iPhone: Share → Add to Home Screen; Android: Chrome offers **Install app**).
   - **Turn on notifications** in the app's Settings, then **Send a test**.

That takes a few minutes, once per phone. From then on it's an app on the Home Screen: full screen, it opens without the network (showing the last it saw), and alerts arrive with it closed. iPhones need iOS 16.4 or newer, with the app opened from the Home Screen.

A phone can skip the setup and use `http://<hub>:8480` as a web page instead. It's the same app, but it alerts only while it's open (a banner, a tone and a buzz).

### The workshop certificate

Phones only treat a web page as an app (installable, offline, notifications) when it comes from an `https://` address they trust. On a local network nobody issues certificates for, the hub makes its own the first time it starts:

- `data/workshop-ca.crt` is the workshop's certificate authority, which each phone trusts once. It can **only** vouch for private network addresses (10.x, 172.16–31.x, 192.168.x), `.local` names and `localhost`, because of X.509 name constraints. A phone that trusts it can't be fooled about any real website. Keep `data/workshop-ca.key` private all the same.
- `data/monitor.crt` is the hub's own certificate, for its current addresses. It lasts 397 days and is renewed automatically when the hub's address changes or a month before it runs out. Phones don't need to do anything when that happens.

If IT issues certificates on your network, use theirs instead: put the files next to `config.json` and add `"tls": { "cert": "cert.pem", "key": "key.pem" }`. `"https": false` turns https off.

Notifications to a closed app go through the phone maker's push service (Apple or Google), so the hub needs internet access for those, and only for those. The machines' data stays on the workshop network.

## Set up the hub (once)

On a PC or Raspberry Pi that's always on, on the same network as the machines:

| For | Download | Then |
|---|---|---|
| **Windows PC** | **[⬇ Pathline-Monitor-Windows.zip](https://github.com/AESGlobalEngineering/Pathline/releases/download/pathlinemonitor/Pathline-Monitor-Windows.zip)** | Right-click it, **Extract All**, then double-click **Start Pathline Monitor.cmd** in the folder it makes, and leave its window open. Node.js is inside: nothing else to install |
| **Raspberry Pi**, Linux or Mac | [Pathline-Monitor.zip](https://github.com/AESGlobalEngineering/Pathline/releases/download/pathlinemonitor/Pathline-Monitor.zip) | Unzip it, then `sh start.sh` (needs Node.js 18 or newer: `sudo apt install nodejs`) |

To update the hub, unzip a newer download over the old folder. `monitor/data` (the machines it found, the workshop certificate, phones' choices, alerts) and `monitor/config.json` are kept, so phones don't need setting up again. Phones get the new app the next time they open it.

From a copy of this repository instead (Node.js 18 or newer; Monitor uses Pathline Prepare's machine finder, `src/main/discover.js`, so keep the whole folder):

```bash
cd monitor
npm install
node server.js
```

### Finding the machines

Monitor finds machines the way Pathline Prepare's **Add machine → Find machines** does. It looks when it starts, every 10 minutes, and when **Look now** is pressed in the app's Settings:

- it asks the network for Pathline Run's announcement (`_pathline._tcp.local`), and
- it tries port 8470 on every address of this computer's own network.

Machines it finds are kept in `data/found.json`, so a machine that's switched off still shows (as Offline). A machine on another network, or on a port other than 8470, can be listed in `config.json` (copy `config.example.json`):

```json
{
  "port": 8480,
  "httpsPort": 8443,
  "machines": [{ "name": "Laser A", "host": "192.168.1.40", "port": 8470 }]
}
```

`"find": false` turns the network search off.

### Keep it running

- **Windows**: Task Scheduler → Create Task → "Run whether user is logged on or not", trigger **At startup**, action **Start Pathline Monitor.cmd** from the unzipped folder. The first time it runs, Windows Firewall asks about Node.js: allow private networks, so phones can connect (ports 8480 and 8443) and the search hears Pathline Run's answers.
- **Raspberry Pi**: a systemd service with `WorkingDirectory=/home/pi/Pathline-Monitor/monitor` and `ExecStart=/usr/bin/node server.js`, `Restart=always`.

Give the hub a fixed address (a DHCP reservation on the router), so the phones' Home Screen app keeps finding it.

## What it keeps

In `monitor/data/` (left out of git):

- `workshop-ca.crt` / `.key`, `monitor.crt` / `.key`: the workshop certificate and the hub's own. Keep them: a new authority means setting every phone up again.
- `found.json`: the machines found on the network.
- `devices.json`: each phone's alert choices and its push subscription.
- `alerts.json`: the last 14 days of alerts (300 at most).
- `vapid.json`: the push keys. Keep them too, or every phone has to turn notifications on again.

## How it works

- `lib/watch.js` asks each machine's Pathline Run every 2 s (`GET /api/local/state`, the same data Run's own screen uses, and `GET /api/v1/info` once a minute). It turns the answers into one view per machine, and compares each look with the last to make the alerts in the table above.
- `lib/certs.js` makes the workshop certificate authority (with name constraints) and the hub's certificate, renews it, and writes the iPhone profile.
- `server.js` serves http (8480: the setup page, the certificate downloads, and the app as a web page) and https (8443: the full app). It finds machines (`../src/main/discover.js`), keeps the alerts, streams machines and alerts to the app (`GET /api/events`) and sends Web Push.
- `app/` is the phone app: `app.js` (screens, and the banner and tone for new alerts), `setup.html` (Set up this phone), `sw.js` (service worker: opens without the network, shows notifications), `manifest.webmanifest` and the icons. `tools/make-icons.js` redraws the icons from the Pathline mark (run it with Electron).
- `tools/package.js` lays out the download (`dist/Pathline-Monitor/`: the starters, `monitor/`, the machine finder, and with `--node <node.exe>` Node.js itself). The release workflow ([../.github/workflows/release-monitor.yml](../.github/workflows/release-monitor.yml)) zips it whenever `package.json` has a new version.

`npm test` puts a stand-in Pathline Run through each case and checks which alerts come out, then checks the workshop certificate.

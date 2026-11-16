# Pathline Monitor

A phone app (a progressive web app) that works anywhere the phone has internet. It shows every Pathline Run machine: what each one is doing, how long the job has left, what's queued, and what finished today. When a job finishes, or a machine is stuck waiting for someone, the phone gets an alert, even with the app closed.

There is one **Monitor server**, on the company's own server. Each machine's Pathline Run reports to it, and each phone opens it.

```
Pathline Run (each machine) ──https, outgoing only──▶  Monitor server  ◀──https──  the app, on phones
                                                       (monitor.<your domain>)
```

- **It only watches.** Nothing on the phone starts, pauses or moves a machine on, and the server never sends a machine anything: a report is answered with an empty "received".
- **Nothing is opened at the workshop.** Each Run connects out to the server, the way a browser does. No port is opened on the workshop network.
- **It's small.** The server is about 500 lines of Node.js with no packages to install, and keeps its data in a few JSON files.

Machines report from the Pathline Run version that has **Settings → Pathline Monitor** (the brief for it is [hmi/RUN-REPORT-BRIEF.md](../hmi/RUN-REPORT-BRIEF.md)). Until a machine's Run has that, it can't be added.

## What makes an alert

| What happens | Alert |
|---|---|
| A job finishes | **Laser A finished Coasters**: how long it took, and what's waiting (lasers need Start at the machine) |
| The last queued job finishes | The same alert, which also counts as "a queue runs out" |
| A registration mark can't be found | **Laser C needs you** |
| An error, a stopped job, or a laser its Run can't reach | **Laser E has an error** and so on |
| A machine stops reporting for about a minute | **Laser E stopped reporting**: its PC is off, Run is closed, or it lost the internet |
| Every machine stops reporting together | One alert, **The workshop stopped reporting**, not one per machine |
| Lid opened, or Pause pressed at the machine | None. It's shown in the app, but someone is already there |
| A machine reports again | Listed in Alerts, without a notification |

Each phone chooses which of these it gets (Settings), can mute single machines, and can set quiet hours (18:00 to 07:00, no sound).

## Get it on a phone

1. Open the server's address (`https://monitor.<your domain>`) in the phone's browser: Safari on iPhone, Chrome on Android.
2. Sign in with the **workshop password**. The phone stays signed in.
3. Add it to the Home Screen (iPhone: Share → Add to Home Screen; Android: Chrome offers **Install app**), and open it from there.
4. In its Settings, turn on notifications, then **Send a test**.

From then on it's an app on the Home Screen: full screen, it opens even without a connection (and says it's reconnecting), and alerts arrive with it closed. iPhones need iOS 16.4 or newer, and notifications only work from the Home Screen app, so sign in there.

## Add a machine

1. In the app: **Settings → Add a machine**. It shows a 6-character code that works once, for 10 minutes.
2. At the machine, in Pathline Run: **Settings → Pathline Monitor**. Type the server's address and the code, and press **Connect**.

The machine appears in the app straight away. Run gets its own key from the server and reports with it from then on. To take a machine off, open it in the app and choose **Remove from Pathline Monitor**: its key stops working and its Run stops reporting.

## Put it on the server (once)

For an Amazon Linux 2023 server with nothing else on ports 80 and 443. Before starting:

- **A web address pointing at the server**: an A record such as `monitor.<your domain>` with the server's public IP address.
- **Ports 80 and 443 open** to the server in its AWS security group. 443 is the app; 80 is only used to get and renew the certificate.

Then, on the server:

```bash
curl -LO https://github.com/AESGlobalEngineering/Pathline/releases/download/pathlinemonitor/Pathline-Monitor.zip
unzip -o Pathline-Monitor.zip
sudo sh pathline-monitor/install.sh monitor.example.com
```

`install.sh` does five things, and says which it's on:

1. installs Node.js and certbot (`dnf`);
2. copies the files to `/opt/pathline-monitor`;
3. asks for the **workshop password** (8 characters or more; a few words is better than one) and keeps it in `/etc/pathline-monitor/password`, readable by root only;
4. gets a certificate for the address from Let's Encrypt (certbot asks for an email address and for agreement to its terms). It renews by itself;
5. installs and starts the `pathline-monitor` service ([pathline-monitor.service](pathline-monitor.service)), which also starts with the server.

After that:

| To | Do |
|---|---|
| Update | Download and unzip the newer zip, and run `install.sh` again. The password, certificate, machines, phones and alerts are kept. Phones get the new app the next time they open it |
| Change the password | Edit `/etc/pathline-monitor/password`, then `sudo systemctl restart pathline-monitor`. Every phone signs in again and turns notifications on again. Machines aren't affected |
| See what it's doing | `journalctl -u pathline-monitor -f` |
| Back it up | `/var/lib/pathline-monitor` (below) and `/etc/pathline-monitor/password` |

### On a server that already hosts a website

Don't use `install.sh`: the web server already there (nginx, Apache) has ports 80 and 443. Run Monitor on a local port behind it instead. Copy `config.example.json` to `config.json`, set the password, and start `node server.js` as a service. Then give the web server a site for Monitor's address, with its own certificate, that passes everything on. For nginx:

```nginx
location / {
  proxy_pass http://127.0.0.1:8480;
  proxy_set_header X-Forwarded-For $remote_addr;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header Host $host;
  proxy_read_timeout 1h;
}
```

### To try it on your own PC

```bash
cd monitor
node test.js --demo
```

That starts a server on `http://127.0.0.1:8480` with three pretend machines (the password is `workshop demo`). `npm test` runs the self-test.

## What the server keeps

In `/var/lib/pathline-monitor` (or `monitor/data/` when started by hand):

- `keys.json`: the push keys and the server's own secret. Keep it: without it every phone signs in and turns notifications on again.
- `machines.json`: the machines added, each with a fingerprint of its key (not the key itself).
- `devices.json`: each signed-in phone's alert choices and its push subscription.
- `alerts.json`: the last 14 days of alerts (300 at most).
- `state.json`: what each machine last showed, so a job that finishes while the server restarts still alerts.

Job names, materials and times are stored there and nowhere else. Notifications to a closed app go through the phone maker's push service (Apple or Google), encrypted so that only the phone can read them.

## How it's kept safe

- **Phones** sign in with the workshop password. Five wrong tries from one address pause sign-in from that address (1 minute, doubling to an hour). Signing out, or changing the password, ends a phone's access.
- **Machines** each have their own key, given once in exchange for a one-time code that a signed-in phone made. Removing a machine ends its key.
- **Reports are cut down to what's shown** and to sane lengths before they're kept or sent on, so a broken or pretend report can't do more than show wrong text.
- **A phone's push subscription** is only accepted if it points at Apple's, Google's, Mozilla's or Microsoft's push service.
- **No packages**: nothing to install from npm, so nothing to keep patched but Node.js itself.

## What a machine sends

Two calls, both to the Monitor server over https. Pathline Run's side is described in [hmi/RUN-REPORT-BRIEF.md](../hmi/RUN-REPORT-BRIEF.md).

| Call | Body | Answer |
|---|---|---|
| `POST /api/v1/enrol` | `{ "code": "K7M2QX", "id": "run-3f9c2a71", "name": "Laser A" }` | `200 { "key": "…" }`, once. `403` for a wrong or used code, `429` after too many tries |
| `POST /api/v1/report` with `Authorization: Bearer <key>` | Run's `GET /api/v1/monitor` answer ([PROTOCOL.md](../PROTOCOL.md) *Watching*) | `204`, nothing else. `401` when the machine has been removed |

Run reports when something changes and at least every 10 seconds. After 35 seconds without a report the machine shows as not reporting.

## How it works

- `server.js` is the whole server: sign-in, the machines' two calls, the phones' live stream (`GET /api/events`: everything once, then each machine as it changes) and the app's files. With a certificate it serves https itself; without one, plain http for a web server in front.
- `lib/machines.js` turns each report into one view per machine and compares it with the last to make the alerts in the table above. Phones count a running job down themselves, so they're only told when something else changes, and every 15 seconds while a job runs.
- `lib/push.js` is Web Push with Node's own crypto: the message is encrypted for one phone and signed as coming from this server.
- `app/` is the phone app: `app.js` (screens, sign-in, and the banner and tone for new alerts), `sw.js` (service worker: opens without the network, shows notifications), `manifest.webmanifest` and the icons. `tools/make-icons.js` redraws the icons from the Pathline mark (run it with Electron).
- `install.sh` and `pathline-monitor.service` put it on a server. The release workflow ([../.github/workflows/release-monitor.yml](../.github/workflows/release-monitor.yml)) zips the folder whenever `package.json` has a new version.

`npm test` checks which alerts each kind of report makes, the notification encryption against a message made by the `web-push` library, and the server itself: sign-in, adding and removing a machine, reporting, and what survives a restart.

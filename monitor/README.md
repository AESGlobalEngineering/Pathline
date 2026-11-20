# Pathline Monitor

A phone app (a progressive web app) that works anywhere the phone has internet. It shows every Pathline Run machine: what each one is doing, how long the job has left, what's queued, and what finished today. When a job finishes, or a machine is stuck waiting for someone, the phone gets an alert, even with the app closed.

There is one **Monitor server**, on the company's own server. Each machine's Pathline Run reports to it, and each phone opens it.

```
Pathline Run (each machine) ──https, outgoing only──▶  Monitor server  ◀──https──  the app, on phones
                                                       (monitor.<your domain>)
```

- **It only watches.** Nothing on the phone starts, pauses or moves a machine on, and a report is answered with an empty "received". The one thing a machine can be asked is to send a log, a drawing or its camera pictures (**Pulls**, below): read and sent, never changed.
- **Nothing is opened at the workshop.** Each Run connects out to the server, the way a browser does. No port is opened on the workshop network.
- **It's small.** The server is about 500 lines of Node.js with no packages to install, and keeps its data in a few JSON files.

Machines report from **Pathline Run 0.7.13**, which has **Setup → Pathline Monitor** (the brief for it is [hmi/RUN-REPORT-BRIEF.md](../hmi/RUN-REPORT-BRIEF.md)). A machine on an older Run can't be added until it's updated.

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
2. At the machine, in Pathline Run: **Setup → Pathline Monitor**. Type the server's address and the code, and press **Connect**.

The machine appears in the app straight away. Run gets its own key from the server and reports with it from then on. To take a machine off, open it in the app and choose **Remove from Pathline Monitor**: its key stops working and its Run stops reporting.

## Pulls: a machine's logs, drawings and camera pictures, when they're needed

From **Pathline Monitor 0.6** and **Pathline Run 0.7.21**. From any computer with the **pull token**, ask a machine for one thing; it sends just that, through this server, which hands it over and keeps nothing.

```
pull.js ──https──▶  Monitor server  ◀──https, outgoing only──  Pathline Run (waiting for asks)
        ◀── the answer, once ────────────────────── reads and sends it
```

What can be asked for, and nothing else:

| Ask | What comes back |
|---|---|
| `list` | What the machine has: its days of logs, its jobs, which still have their files, mark pictures and run records |
| `log <day>` | That day's diagnostics log (the last 30 days are kept) |
| `job <J…>` | The job's drawings and package (kept 30 days after it ran) |
| `marks <J…>` | The camera's pictures of the job's registration marks (the last 5 jobs) |
| `runs <J… or day>` | Run records: the head positions and timing of each run |
| `fit` | The head drawing's fit and the bed maps |
| `settings` | The machine's settings and materials (never its Monitor key) |
| `health` | Temperature, a Raspberry Pi's power warnings (under-voltage, slowing down), memory, disk, when it and Pathline Run last started, versions |

With **Node.js 18 or newer** on the computer that pulls (no packages):

```bash
node monitor/tools/pull.js                          # the machines, and which are listening
node monitor/tools/pull.js "Laser A" list
node monitor/tools/pull.js "Laser A" log 2026-11-20
node monitor/tools/pull.js "Laser A" marks J0123
```

The files land in `pulled/<machine>/<ask>/` (`--out` for another folder). It needs the server's address and the pull token, as `PATHLINE_MONITOR` and `PATHLINE_PULL_TOKEN`, or in `pull.json` (`{ "address": "https://monitor.example.com", "token": "…" }`) in `%APPDATA%\Pathline Monitor\` on Windows or `~/.config/pathline-monitor/` elsewhere.

- **The pull token** is made by `install.sh` in `/etc/pathline-monitor/pull-token` (read it with `sudo cat`). Anyone with it can read every machine's logs and drawings, so keep it like a password. For a new one: delete the file, run `install.sh` again. Without a token (24 characters or more) pulling is off.
- **At the machine:** Pathline Run's **Setup → Pathline Monitor** has a switch, **Let Pathline Monitor ask for logs, drawings and camera pictures**. Every ask is in its diagnostics log. An ask can only make Run read one of the things above: it can't change a setting, or touch the machine or a job, and Run checks every ask against its own list again.
- **When the machine is off,** the ask waits for it, a day at most. An answer nobody collects is dropped after an hour. A running job is never held up: Run reads and packs in small steps, one ask at a time, on its own connection.
- **Nothing is kept:** answers are held in memory only until they're collected, 512 MB at most at a time, 64 MB each.

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
3. asks for the **workshop password** (8 characters or more; a few words is better than one) and keeps it in `/etc/pathline-monitor/password`, readable by root only, and makes the **pull token** beside it (`pull-token`);
4. gets a certificate for the address from Let's Encrypt (certbot asks for an email address and for agreement to its terms). It renews by itself;
5. installs and starts the `pathline-monitor` service ([pathline-monitor.service](pathline-monitor.service)), which also starts with the server.

After that:

| To | Do |
|---|---|
| Update | Download and unzip the newer zip, and run `install.sh` again. The password, pull token, certificate, machines, phones and alerts are kept. Phones get the new app the next time they open it |
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

Job names, materials and times are stored there and nowhere else. Nothing a machine sends for a pull is written to disk. Notifications to a closed app go through the phone maker's push service (Apple or Google), encrypted so that only the phone can read them.

## How it's kept safe

- **Phones** sign in with the workshop password. Five wrong tries from one address pause sign-in from that address (1 minute, doubling to an hour). Signing out, or changing the password, ends a phone's access.
- **Machines** each have their own key, given once in exchange for a one-time code that a signed-in phone made. Removing a machine ends its key.
- **Pulls** need the pull token, which is apart from the workshop password: a phone can't pull, and the token can't open the phones' side. Five wrong tokens from one address pause it, as for passwords. A machine only answers its own asks, and only asks on the list.
- **Reports are cut down to what's shown** and to sane lengths before they're kept or sent on, so a broken or pretend report can't do more than show wrong text.
- **A phone's push subscription** is only accepted if it points at Apple's, Google's, Mozilla's or Microsoft's push service.
- **No packages**: nothing to install from npm, so nothing to keep patched but Node.js itself.

## What a machine sends

Two calls, both to the Monitor server over https. Pathline Run's side is described in [hmi/RUN-REPORT-BRIEF.md](../hmi/RUN-REPORT-BRIEF.md).

| Call | Body | Answer |
|---|---|---|
| `POST /api/v1/enrol` | `{ "code": "K7M2QX", "id": "run-3f9c2a71", "name": "Laser A" }` | `200 { "key": "…" }`, once. `403` for a wrong or used code, `429` after too many tries |
| `POST /api/v1/report` with `Authorization: Bearer <key>` | Run's `GET /api/v1/monitor` answer ([PROTOCOL.md](../PROTOCOL.md) *Watching*) | `204`, nothing else. `401` when the machine has been removed |
| `GET /api/v1/asks` with the key | | The asks for data waiting for it, as soon as there are any, or `204` after 25 s ([PROTOCOL.md](../PROTOCOL.md) *Pulls*) |
| `POST /api/v1/answer/<id>` with the key | The packed files, or `{ "error" }` | `204` |

Run reports when something changes and at least every 10 seconds. After 35 seconds without a report the machine shows as not reporting.

## How it works

- `server.js` is the whole server: sign-in, the machines' calls (reports, and asks for data with their answers), the pull token's calls, the phones' live stream (`GET /api/events`: everything once, then each machine as it changes) and the app's files. With a certificate it serves https itself; without one, plain http for a web server in front.
- `lib/machines.js` turns each report into one view per machine and compares it with the last to make the alerts in the table above. Phones count a running job down themselves, so they're only told when something else changes, and every 15 seconds while a job runs.
- `lib/push.js` is Web Push with Node's own crypto: the message is encrypted for one phone and signed as coming from this server.
- `lib/pulls.js` holds the asks for data and their answers, in memory only; `tools/pull.js` is the command that pulls (it isn't part of the server download).
- `app/` is the phone app: `app.js` (screens, sign-in, and the banner and tone for new alerts), `sw.js` (service worker: opens without the network, shows notifications), `manifest.webmanifest` and the icons. `tools/make-icons.js` redraws the icons from the Pathline mark (run it with Electron).
- `install.sh` and `pathline-monitor.service` put it on a server. The release workflow ([../.github/workflows/release-monitor.yml](../.github/workflows/release-monitor.yml)) zips the folder whenever `package.json` has a new version.

`npm test` checks which alerts each kind of report makes, the notification encryption against a message made by the `web-push` library, and the server itself: sign-in, adding and removing a machine, reporting, and what survives a restart.

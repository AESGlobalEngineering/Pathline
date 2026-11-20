# Brief for Pathline Run: report to Pathline Monitor

From Pathline Monitor 0.5.0 (16 Nov 2026). It replaces the way Monitor got its data in [RUN-MONITOR-BRIEF.md](RUN-MONITOR-BRIEF.md).

> **Since Pathline Monitor 0.6 and Pathline Run 0.7.21 (20 Nov 2026)** the one rule below has one exception, chosen by the owner: **pulls**. Someone with Monitor's pull token can ask a machine for one thing from a fixed list (a day's log, a job's drawings, its mark pictures, health …), and Run reads it and sends it. It still never changes anything because of the server. See *Pulls* in [PROTOCOL.md](../PROTOCOL.md).

## What changed in Monitor

Monitor used to be a hub on the workshop network that asked each Run what it was doing. That only worked on the workshop Wi-Fi. Now Monitor is one small server on the company's own AWS server ([monitor/README.md](../monitor/README.md)), and phones open it from anywhere.

The server can't reach into the workshop, and it shouldn't. So each Run **reports to it**: an outgoing https request carrying the same answer Run already builds for `GET /api/v1/monitor`.

## The one rule: it's one way

Run sends its status. **Run never does anything because of what the server answers.** There are exactly two things Run reads from the server:

- the key, once, when the machine is added (`/api/v1/enrol`);
- the status code of a report (204, 401, or a failure).

Nothing else. No settings, no commands, no "report faster", no job changes, ever. A report's answer has no body, and if one ever has, Run ignores it. This goes in the self-test (below), because Run drives lasers and this is its first connection to the internet.

Reporting must also never get in the machine's way. It runs on its own timers, apart from job control. Every failure is caught, and is shown only in the settings panel.

## 1. Settings → Pathline Monitor

A new panel in Run's Settings. Monitor's app tells people to go to exactly this place ("At the machine, open Pathline Run's Settings, then Pathline Monitor"), so please keep those names.

**Not connected:**

- **Address**: the Monitor server, such as `monitor.example.com`. Accept it with or without `https://` and a trailing slash.
- **Code**: 6 letters and digits from the app's **Settings → Add a machine**, shown there as `K7M-2QX`. Accept any case, with or without the dash or spaces.
- **Connect**.

**Connected:**

- "Reporting to `monitor.example.com`", and how it's going. One of:
  - "Last sent 12:01:05";
  - "Can't reach it since 11:58. Still trying";
  - "Removed in Pathline Monitor" (see 401 below), with the Address and Code fields back.
- **Disconnect**: forgets the key and stops reporting. It doesn't call the server. The machine then shows as "not reporting" in the app until someone removes it there.

## 2. Adding the machine: `POST /api/v1/enrol`

When Connect is pressed:

```
POST https://monitor.example.com/api/v1/enrol
content-type: application/json

{ "code": "K7M2QX", "id": "run-3f9c2a71", "name": "Laser A" }
```

- `id` is the machine's own stable id, the one in `GET /api/v1/info`. The server needs 8 to 64 letters, digits or dashes.
- `name` is the machine's name. It's only used until the first report arrives.

| Answer | Run does |
|---|---|
| `200 { "key": "…" }` | Saves the address and the key, and starts reporting straight away |
| `403 { "error": "…" }` | Shows the `error` text (the code is wrong, used, or older than 10 minutes) |
| `429 { "error": "…" }` | Shows the `error` text (too many wrong tries; wait a few minutes) |
| Anything else, or no answer | "Can't reach Pathline Monitor at `<address>`. Check the address and this PC's internet." |

Keep the key in Run's data folder, in a file of its own (`monitor-report.json`, say), not in the config that's exported or shown. Don't log it and don't show it. Adding the same machine again (a new code) gives a new key and ends the old one, and the machine keeps its place in the app.

## 3. Reporting: `POST /api/v1/report`

```
POST https://monitor.example.com/api/v1/report
authorization: Bearer <key>
content-type: application/json

<exactly what GET /api/v1/monitor answers>
```

Build the body with the same function as `GET /api/v1/monitor` (`run/src/monitor.js`), so the two can't drift apart.

**When to send:**

- **Straight away when something changes**, other than a running job's `progress`, `elapsed` and `remaining`. This is the same test `/api/v1/events` uses. At most once a second.
- **Every 5 seconds while a job runs.** Phones count the job down themselves between reports.
- **Every 10 seconds otherwise.** Monitor shows a machine as "not reporting" after 35 seconds of silence, and alerts about a minute after the last report.

**How to send:**

- One request at a time. If one is still on its way when the next is due, wait, then send the newest state. Never queue old ones: only the latest matters, and `today` carries the finished jobs, so nothing is lost while the internet is down.
- Give up on a request after 8 seconds.
- Reuse the connection (a keep-alive agent).
- Keep the body under 64 KB. The server refuses more. It uses the first 20 entries of `today` and the first 100 of `queue`.
- **https only**, with the certificate checked as usual. Allow plain `http://` only for `localhost` and `127.0.0.1`, for testing.

**What the answer means:**

| Answer | Run does |
|---|---|
| `204` (no body) | Notes the time ("Last sent …"). Ignores any body |
| `401` | The machine was removed in Pathline Monitor. Stop reporting, forget the key, and show "Removed in Pathline Monitor" in the panel |
| Any other answer, a timeout, or no connection | Notes when it started failing ("Can't reach it since …") and tries again on the normal schedule, no faster |

Start reporting when Run starts, if a key is saved. With no machine set up yet, report anyway: `/api/v1/monitor` already answers with `link: "offline"`.

## 4. Self-test (`run/tools/selftest.js`, "Reporting")

With a stand-in Monitor server on `http://127.0.0.1`:

- Connect with a code: the key is saved, and the first report arrives with it as the bearer.
- The report's body equals `GET /api/v1/monitor`'s answer.
- A change (a mark not found, say) arrives within a second. With nothing changing, one arrives about every 10 seconds, and about every 5 while a job runs.
- A wrong code shows the server's `error` text and saves nothing.
- The server answers `401`: Run stops reporting and the key is gone.
- The server is unreachable: Run and a running job carry on untouched, the panel says so, and reports resume when it's back.
- **The one-way rule:** the server answers a report with a body full of made-up instructions (`{ "start": "J0031", "config": { … }, "interval": 0 }`). Nothing in Run changes, and the report rate stays the same.
- An `http://` address that isn't localhost is refused.

To try it against a real Monitor: `cd monitor && node test.js --demo` starts one on `http://127.0.0.1:8480` with pretend machines (the password is `workshop demo`). Its **Settings → Add a machine** gives a code.

## 5. What stays, and what Monitor no longer uses

- `GET /api/v1/monitor` and `GET /api/v1/events` stay as they are: they're part of the protocol, and the report is built from the same answer.
- The machine `id` and the mDNS announcement stay: Pathline Prepare finds machines with them.
- Monitor no longer reads `GET /api/local/state` or `GET /api/v1/info`. The promise in RUN-MONITOR-BRIEF.md to keep `/api/local/state`'s fields for Monitor no longer applies.

## When it's done

- Document it in [PROTOCOL.md](../PROTOCOL.md) (a *Reporting* section beside *Watching*) and in `run/README.md`.
- Release Run as usual: bump `run/package.json`, add to `run/src/changelog.js`, then commit and push to `main`.
- In the commit message, say which Run version reports to Monitor, so [monitor/README.md](../monitor/README.md) can name it.

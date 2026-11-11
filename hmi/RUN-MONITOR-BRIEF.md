# Brief for Pathline Run: what Pathline Monitor (the phone app) needs

From Pathline Monitor 0.3.0 (11 Nov 2026). Monitor is the phone app for the workshop (`monitor/`, see [monitor/README.md](../monitor/README.md)). One always-on PC or Pi runs the Monitor hub. It finds every Pathline Run on the network, asks each one what it's doing every 2 seconds, and sends phones the machines' progress, queues and alerts (a job finished, a registration mark not found, an error, a machine offline).

Monitor only reads. It never starts, pauses, moves or changes a machine, and nothing here should let it.

## What Monitor does today (no Run change needed for it to work)

`monitor/lib/watch.js`, every 2 s for each machine:

- `GET /api/v1/info` once a minute: `name`, `type`, `ctrl`, `model`.
- `GET /api/local/state` (the data Run's own screen reads). From it, Monitor uses only:
  - `status.state`, `status.link`, `status.progress`, `status.job`, `status.message`, `status.markWait` (`mark`, `of`), `status.interlock`
  - `jobs[]`: `id`, `name`, `status`, `material`, `seconds`, `hidden`
  - `history[]`: `id`, `name`, `material`, `seconds`, `result`, `finishedAt`
  - `config`: `name`, `type`, `controller`

That works, but `/api/local/state` is Run's private screen API. It's big (config, camera, Ruida models, motion), and it can change whenever the screen changes. Monitor also has to guess some things:

- **When a state began.** Monitor first sees "waiting for a mark" or "lid open" at its next look, and after the hub restarts it starts counting again.
- **Time left.** Monitor uses `seconds × (1 − progress)`. Run knows better, because it follows the head along the route.
- **Whether the next job starts by itself.** Plotters running several jobs back to back (Select) do; lasers wait for Start.

## 1. Discovery: do [RUN-DISCOVERY-BRIEF.md](RUN-DISCOVERY-BRIEF.md)

Prepare's brief from 10 Nov 2026, not done in Run yet:

- a stable **`id`** in `GET /api/v1/info`, and
- **announcing** the machine over mDNS (`_pathline._tcp.local`).

Monitor uses Prepare's own finder (`src/main/discover.js`), so the same work serves both. With it, Monitor:

- finds machines on another port or across a busy network straight away, without waiting for its port-8470 scan;
- follows a machine whose IP address changed, by its `id`.

Include the Windows Firewall rules from that brief (TCP 8470 and UDP 5353 on private networks).

## 2. A small, stable status for watchers: `GET /api/v1/monitor`

One read-only answer with everything a watcher needs, in the public `api/v1` space. Document it in [PROTOCOL.md](../PROTOCOL.md) as part of protocol 1: it's an addition, so `protocol` stays 1. Keep it small (a few KB), fast and `cache-control: no-store`, with no config, camera or controller internals.

```json
{
  "id": "run-3f9c2a71",
  "name": "Laser A", "type": "laser", "ctrl": "Trotec", "model": "Speedy 400", "app": "Pathline Run 0.7.12",
  "link": "online",
  "state": "running",
  "since": "2026-11-11T09:41:07.000Z",
  "message": "Running Coasters",
  "interlock": false, "interlockSince": null,
  "markWait": null,
  "job": {
    "id": "J0031", "name": "Coasters", "material": "Birch ply 3 mm",
    "seconds": 612, "progress": 0.43, "elapsed": 261, "remaining": 349,
    "startedAt": "2026-11-11T09:41:07.000Z",
    "beds": null
  },
  "queue": [
    { "id": "J0032", "name": "Name badges", "material": "Birch ply 3 mm", "seconds": 1080, "autoStart": false }
  ],
  "today": [
    { "id": "J0030", "name": "Keyrings", "material": "Cast acrylic 3 mm", "seconds": 742, "result": "Completed",
      "startedAt": "2026-11-11T09:20:01.000Z", "finishedAt": "2026-11-11T09:32:23.000Z" }
  ]
}
```

| Field | Meaning |
|---|---|
| `link` | `online`, `connecting` or `offline`: whether Run reaches the laser itself (Run answering at all is Monitor's own check) |
| `state` | `idle`, `running`, `paused`, `framing` or `alarm`, as `status.state` |
| `since` | When `state` last changed (ISO time). Kept across a Run restart if it can be |
| `message` | As `status.message` (the alarm text when `state` is `alarm`) |
| `interlock`, `interlockSince` | Lid open, and since when |
| `markWait` | Print and cut waiting for a mark to be found by hand: `{ "mark": 2, "of": 3, "since": "…" }`, else `null` |
| `job` | The running (or paused, or waiting-for-a-mark) job, else `null`. `remaining` and `elapsed` in seconds are Run's own figures (the head followed along the route), not `seconds × progress`. `beds`: `[2, 3]` on a plotter job over several beds, else `null` |
| `queue` | The queued jobs in run order, `hidden` ones left out. `autoStart: true` when Run starts that job by itself when the one before finishes (a plotter's Select run), `false` when someone has to press Start |
| `today` | Jobs finished or stopped since local midnight, newest first, at most 50: `result` is `Completed` or `Stopped` |

Monitor turns this into its alerts. So:

- `today` entries must keep their `id` and `finishedAt` exactly, so a job finishing is seen once and never twice.
- `markWait`, `alarm` and `link` must change as soon as they happen.

**Please don't change what `/api/local/state` gives** (the fields listed at the top) until Monitor has switched. Monitor will use `/api/v1/monitor` when a machine has it, and fall back to `/api/local/state` for older Runs.

Add it to Run's self-test (`run/tools/selftest.js`):

- a running job shows `remaining`;
- a finished job appears once in `today`;
- `markWait` carries `since`;
- `hidden` jobs are left out of `queue`.

## 3. Optional, later: `GET /api/v1/events`

A server-sent event stream: the same object as `/api/v1/monitor` whenever something in it changes, and an `event: finished` line with the `today` entry when a job finishes. Monitor would then alert within a second instead of on its next 2-second look. It isn't needed: polling `/api/v1/monitor` is fine. If you add it, send a comment line every 25 s so it stays open.

## When it's done

- Release Run as usual: bump `run/package.json`, add to `run/src/changelog.js`, then commit and push to `main`.
- In the commit message, say which Run version has `/api/v1/monitor` and the discovery `id`, so Monitor can switch over to it.

## Done in Pathline Run 0.7.12

All three parts:

- **Discovery:** the `id` in `GET /api/v1/info`, and the mDNS announcement. See RUN-DISCOVERY-BRIEF.md. The installer's firewall rules are on private networks only.
- **`GET /api/v1/monitor`** (`run/src/monitor.js`), with the fields and shape above. Some details:
  - `since` and `interlockSince` are kept in Run's data folder (`monitor.json`) across a restart, while the state is still the same.
  - `job.remaining` is `job.seconds × (1 − progress)`. `seconds` is Run's own estimate as converted for the machine. `progress` comes from the parts the laser reports done, ignoring the previous job's last marker.
  - `job.beds` is `[bed, of]`, taken from the job's feed steps against its progress.
  - `queue[].autoStart` is true for the jobs left in a Queue → Select run.
  - `today` is Run's history since local midnight.
  - With no machine set up, it still answers: `link` is `offline`.
- **`GET /api/v1/events`:**
  - It sends the same object straight away, then whenever it changes; while only a job's `elapsed` and `remaining` move, at most once a second.
  - It sends `event: finished` with the `today` entry, once per job.
  - A comment line goes every 25 s.
- **Documented** in PROTOCOL.md under *Watching*.
- **Self-test** (`run/tools/selftest.js`, "Watchers"): `remaining` while a job runs, the finished job once in `today` and one `finished` event, `markWait.since`, `interlockSince`, hidden jobs left out of `queue`, and `autoStart`.
- `/api/local/state` is unchanged.

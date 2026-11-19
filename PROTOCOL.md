# Controller protocol (v1)

This is how **Pathline** talks to the device that runs the machine (the HMI / controller PC). Implement these endpoints on that device and the app can send jobs, read settings and jog over Ethernet. `tools/device-emulator.js` is a working reference implementation.

- Transport: HTTP/1.1 with JSON bodies, `http://<ip>:<port>/api/v1/...` (port 8470 by default, set per machine on the Machines page)
- Errors: any non-2xx status with `{ "error": "message" }`. The app shows the message to the operator.
- Units: millimetres, seconds, mm/s. Coordinates have their origin at the **top left of the bed, Y pointing towards the front**.
- The device is responsible for safety: it should refuse motion (`409`) while a job runs, or while interlocks are open.

## Read

| Method | Path | Returns |
|---|---|---|
| GET | `/info` | `{ id, name, type: "laser" \| "plotter", ctrl, model, firmware, protocol: 1, bed: [w, h] }`, used by **Test connection** and the network scan in Add machine. `id` is the machine's own id, which never changes; Prepare uses it to follow a machine to a new IP address. See hmi/RUN-DISCOVERY-BRIEF.md, which also covers announcing the machine (mDNS `_pathline._tcp.local`). |
| GET | `/machine` | Settings set on the HMI, shown read-only on the Machines page (**Refresh from machine**). See *Machine settings* below. |
| GET | `/status` | `{ state: "idle" \| "running" \| "paused" \| "framing" \| "alarm", pos: { x, y, z }, progress: 0–1, job, message, io: { air, pointer, vacuum, exhaust } }`, polled every 1.5 s |
| GET | `/jobs` | The machine's queue, in run order: `[{ id, name, status: "queued" \| "running" \| "done" \| "stopped", progress: 0–1, seconds, receivedAt, finishedAt }]`. The app's Queue tab shows this list, polled every 3 s. |
| DELETE | `/jobs/{id}` | Remove a job that hasn't started (`409` if it is running) |
| POST | `/jobs/order` | `{ ids: [...] }`: new order for the waiting jobs |
| GET | `/monitor` | Everything a watcher needs in one small, read-only answer. See *Watching* below. |
| GET | `/events` | The same as `/monitor`, as a server-sent event stream. See *Watching* below. |

## Watching (`GET /monitor`, `GET /events`)

For watchers that only read, such as Pathline Monitor, the workshop's phone app (hmi/RUN-MONITOR-BRIEF.md). These are additions to protocol 1, which stays 1. A device that has them answers `GET /monitor` with a few KB and `cache-control: no-store`; one without them answers 404, and a watcher then falls back on `/status` and `/jobs`. Neither changes anything on the machine. Pathline Run has them from 0.7.12.

```json
{
  "id": "run-3f9c2a71", "name": "Laser A", "type": "laser", "ctrl": "Trotec", "model": "Speedy 400", "app": "Pathline Run 0.7.12",
  "link": "online", "state": "running", "since": "2026-11-11T09:41:07.000Z", "message": "Running Coasters",
  "interlock": false, "interlockSince": null,
  "markWait": null,
  "job": { "id": "J0031", "name": "Coasters", "material": "Birch ply 3 mm", "seconds": 612, "progress": 0.43, "elapsed": 261, "remaining": 349, "startedAt": "2026-11-11T09:41:07.000Z", "beds": null },
  "queue": [ { "id": "J0032", "name": "Name badges", "material": "Birch ply 3 mm", "seconds": 1080, "autoStart": false } ],
  "today": [ { "id": "J0030", "name": "Keyrings", "material": "Cast acrylic 3 mm", "seconds": 742, "result": "Completed", "startedAt": "2026-11-11T09:20:01.000Z", "finishedAt": "2026-11-11T09:32:23.000Z" } ]
}
```

| Field | Meaning |
|---|---|
| `id`, `name`, `type`, `ctrl`, `model`, `app` | As `GET /info` |
| `link` | `online`, `connecting` or `offline`: whether the device reaches the machine itself |
| `state`, `since` | As `/status` `state` (`idle`, `running`, `paused`, `framing`, `alarm`), and when it last changed (kept across a restart of the device when it can be) |
| `message` | As `/status` `message`; the alarm's text in `alarm` |
| `interlock`, `interlockSince` | Lid open, and since when |
| `markWait` | Print and cut waiting for a registration mark to be found by hand: `{ mark, of, since }`, else `null` |
| `job` | The job running (or paused, or reading its marks), else `null`. `seconds` is the device's own estimate; `progress` 0–1; `elapsed` and `remaining` in seconds are the device's own figures; `beds` is `[bed, of]` on a plotter job over several beds, else `null` |
| `queue` | The queued jobs in run order, without the hidden ones. `autoStart: true` when the device starts the job by itself when the one before finishes (a plotter's Select run), else `false` |
| `today` | Jobs finished or stopped since local midnight, newest first, at most 50. `result` is `Completed` or `Stopped`. Each keeps its `id` and `finishedAt` exactly, so a watcher sees a job finish once |

`GET /events` (`text/event-stream`) sends the same object as a `data:` line straight away, then again whenever anything in it changes: at most once a second while only a job's `elapsed` and `remaining` move. When a job finishes it also sends `event: finished` with that job's `today` entry. A comment line every 25 s keeps the connection open.

## Reporting (to Pathline Monitor)

From Pathline Monitor 0.5, the device sends its status out instead of being asked for it: Monitor is one server on the internet (monitor/README.md) and can't reach into the workshop. Pathline Run does this from 0.7.13 (hmi/RUN-REPORT-BRIEF.md). It's set up in Run's **Setup → Pathline Monitor** with the server's address and a one-time code from the app's **Settings → Add a machine**.

**It's one way.** The device reads back only the key, once, from `/api/v1/enrol`, and each report's status code. A report's answer body is never read. Nothing the server answers changes the machine, a job, the settings or how often the device reports.

| Method | Path (on the Monitor server) | Body | Answer |
|---|---|---|---|
| POST | `/api/v1/enrol` | `{ "code": "K7M2QX", "id": "<GET /info id>", "name": "Laser A" }` | `200 { "key" }`; `403 { "error" }` code wrong, used or older than 10 minutes; `429 { "error" }` too many tries |
| POST | `/api/v1/report` | Exactly what `GET /monitor` answers, with `authorization: Bearer <key>` | `204`; `401` the machine was removed in Monitor |

- **When:** straight away when anything changes other than a running job's `progress`, `elapsed` and `remaining` (at most once a second); every 5 s while a job runs; every 10 s otherwise. Monitor shows a machine as not reporting after 35 s of silence.
- **How:** one request at a time, given up after 8 s, on a kept-open connection. A report that's due while one is on its way waits, then sends the newest state: old ones aren't queued (`today` carries the finished jobs). Under 64 KB (the server reads the first 20 of `today` and 100 of `queue`). https only, with the certificate checked; plain http only to `localhost` or `127.0.0.1`, for testing.
- **Answers:** `2xx` notes the time ("Last sent"). `401`: stop, forget the key, show "Removed in Pathline Monitor". Anything else, a timeout or no connection: note since when ("Can't reach it since …") and try again on the normal schedule, no faster.
- The key is kept in Run's data folder (`monitor-report.json`), apart from the config, and is never logged or shown. **Disconnect** forgets it without calling the server. A key saved when Run starts starts the reporting.

`GET /monitor` and `GET /events` stay as they are, for anything else that watches.

## Send a job

`POST /jobs` with a **job package** (below). Respond `{ id, status: "queued" }`. The app may then call `POST /start`.

## Commands

All are `POST` with a JSON body and return a small JSON object.

| Path | Body | Meaning |
|---|---|---|
| `/jog` | `{ axis: "x" \| "y" \| "z", distance }` or `{ x, y }` | Relative jog, or absolute move |
| `/home` | `{}` | Home all axes |
| `/frame` | `{ box: [x0, y0, x1, y1], path: [[x, y]…], speed }` | Trace the job outline (laser pointer / low power). `path` is the box's corners in order: from the top-right corner down, left, up and back right (Prepare 1.6.18+). `speed` is mm/s (the machine's travel speed); Run caps it at the machine's own speed. Run always traces the box in that order and leaves the head at the last corner (top right); `path` only gives the box when `box` is missing. Older Prepare sends `box` only: Run uses its default speed. |
| `/send` | `{ id: "J0111" }` | Ruida only: store the queued job in the controller's memory under its number, not started, to run later from the machine's panel (`/start` runs it now) |
| `/start`, `/pause`, `/resume`, `/stop` | `{}` | Job control. `/stop` must always be accepted. |
| `/io` | `{ air?, pointer?, vacuum? }` | Switch outputs |
| `/autofocus` | `{}` | Laser auto-focus |
| `/testfire` | `{ power, ms }` | Laser test pulse (the app asks the operator to confirm first) |
| `/feed` | `{ length? }` | Conveyor: feed one bed |
| `/toolchange` | `{ slot: "T1" }` | Plotter tool change |

## Job package

`format: "lrc-job-package"`, `version: 1`:

```json
{
  "format": "lrc-job-package", "version": 1, "createdAt": "2026-10-28T12:00:00Z",
  "job": { "id": "j…", "name": "batch-14 · window signs", "notes": "" },
  "machine": { "id": "trotec", "name": "Trotec Speedy 360", "type": "laser", "ctrl": "Trotec", "bed": [813, 508] },
  "material": { "id": "acr-print-3", "name": "Printed acrylic", "thickness": 3 },
  "sheet": { "w": 600, "h": 400, "x": 40, "y": 40 },
  "regMarks": { "mode": "linear", "aci": [9], "marks": [{ "id": "e…", "x": 50.5, "y": 50.5, "d": 5 }] },
  "beds": 1,
  "cutOrder": { "order": "speed", "inside": "part" },
  "processes": [
    { "index": 3, "name": "Engrave fill", "proc": "Engrave", "power": 60, "speed": 400, "f": 500, "passes": 1, "dir": "fastest", "uni": false,
      "air": "Off", "aci": [7], "adv": { "Dithering": "Floyd–Steinberg" }, "summary": "Engrave · 60 % · 400 mm/s · 500 DPI · 1× · fastest direction, both ways" },
    { "index": 0, "name": "Cut contour", "proc": "Cut", "power": 90, "speed": 20, "f": 5000, "passes": 1,
      "dash": false, "dl": 5, "gl": 2, "aci": [1, 6] }
  ],
  "disabledProcesses": ["Kiss cut"],
  "estimate": { "totalSeconds": 2305, "total": "38 min 25 s", "perProcess": [{ "name": "Engrave fill", "seconds": 2140 }],
                "travelSeconds": 4, "travelMm": 2500, "cutLengthMm": 3300, "engraveAreaMm2": 42800, "toolChanges": 0, "feeds": 0 },
  "checks": [{ "ok": true, "l": "Job inside bed" }],
  "entities": [{ "id": "e…", "name": "Label 1", "aci": 1, "bed": 0, "paths": [{ "p": [[80, 80], [216, 80], [216, 216]], "c": true }] }],
  "toolpath": [
    { "type": "engrave", "process": 3, "name": "Engrave fill", "ents": ["e…"], "dpi": 500, "passes": 1, "lines": 2047, "scan": "island", "direction": "up", "bidirectional": true, "box": [102, 122, 528, 334], "seconds": 2140.2 },
    { "type": "cut", "process": 0, "name": "Cut contour", "ent": "e…", "closed": true, "passes": 1, "seconds": 9.81, "p": [[216, 80], [216, 216], [80, 216], [80, 80]] }
    // plotter punch process (mode "punch"): strike the punch head at each point of p, in order
    { "type": "punch", "process": 1, "name": "Holes", "tool": "T3", "ent": "e…", "bed": 0, "centre": true, "passes": 1, "seconds": 0.3, "p": [[40, 60]] }
  ],
  "files": { "dxf": "…", "svg": "…", "sheet": "…", "cjob": { } }
}
```

- `processes` are in **run order** (engrave → mark → cut on lasers; marking tools → V-cut → crease → knife on plotters). Each process lists the colour indexes (`aci`) it applies to.
- `entities[].paths` are polylines in mm (`c: true` = closed). Curves are already flattened.
- Plotter processes use `tool: "T1 · Knife"` in place of `proc/power/f`, and `dash/dl/gl` for perforation or bridges.
- A plotter (router) process with `mode: "punch"` punches instead of cutting (`punchSpace` mm, default 5; `centre` true/false). Its shapes come as `punch` steps, one per shape: `{ "type": "punch", "process": 1, "name": "Holes", "tool": "T3", "ent": "e12", "centre": true, "passes": 1, "seconds": 0.3, "p": [[40, 60]] }`. `p` is the strike points in order, already worked out (spaced at most `punchSpace` apart along the line, or the one centre of the shape's box). Run moves to each with the tool up and strikes once (Pathline Run 0.7.14 and later). No `mode`: cutting. Lasers refuse punch steps.
- Laser cuts with `dash: true` are cut in links: `dl` mm cut, `gl` mm left uncut, repeated along the path.
- Engrave processes carry `dir` (`"down"` top down, `"up"` bottom up, `"fastest"`) and `uni` (`true`: every scan line left to right, with the beam off on the return stroke; `false`: both ways). Each `engrave` step gives the result for that step: `direction` (`"down"` or `"up"`, so "fastest" is already decided) and `bidirectional`.
- `regMarks.marks` are the objects the operator drew in a **Registration marks** colour (`regMarks.aci`), given by their centre and size. Nothing is placed automatically, and they are not in `processes`, so they are never cut. They're still in `entities` and on the `REGMARKS` layer of the DXF.
- `cutOrder.order` is `file` (as drawn), `speed` (shortest travel) or `heat` (spread heat). `cutOrder.inside` is `part` (each part's holes, then its outline), `all` (every hole before any outline) or `off`.
- `toolpath` is the job **in run order, exactly as simulated**. It starts with `inspect` steps (the head visits each registration mark so the camera can read it), then engraving, then cutting. Each cut has its chosen start point (closed shapes start where it's most convenient on the travel path); tool changes and conveyor feeds are listed too. Travel between steps is implied: go to the next step's first point. Every step is one pass. Engraving is split into islands (artwork more than 2 mm apart), one `engrave` step each with its own `box`. Where one side-to-side scan across islands at the same height is quicker, they share a step with `scan: "across"`: engrave over the artwork and cross the gaps at travel speed (beam off). Otherwise `scan: "island"`. A `dwell` step (`seconds`, `pass`) means wait with the beam off before the next pass; it comes from the process's `dwell` setting (seconds between passes, laser only). With `cutOrder.order` `speed`, each island's and each path's passes are listed straight after each other (`pass: 1`, `pass: 2`, then the next one). With `file` or `heat`, passes repeat a group: every island with `pass: 1`, then every island again with `pass: 2`. Cut paths go in groups (the inside shapes of a nesting layer, or of one part with **Per part**): every path in the group with `pass: 1`, then every path again with `pass: 2`, then the next group.
- An `inspect` step is one registration mark: `{ "type": "inspect", "mark": 1, "of": 3, "at": [x, y], "d": 6, "kind": "dot", "seconds": 1.5 }`. `kind` says what the camera looks for (Pathline Run 0.7.13 and later; leave it out for `"dot"`):
  - `"dot"`: a printed dark dot `d` mm across on plain white. If no dark dot is there, Run also looks for a light one (a hole), so holes already work with jobs that don't send `kind`.
  - `"hole"`: a hole `d` mm across cut through the plate, with white card or paper under it. The camera sees a light disc in darker steel (or a dark one, where the steel shines brighter than the card). `at` is the hole's centre.
  - `"corner"`: a corner of the plate itself, lying on a white background. `at` is the corner as drawn and `toward: [sx, sy]` (each `1` or `-1`) says which way the plate lies from it along X and Y: `[1, 1]` is the corner with the plate's least X and least Y, `[-1, 1]` the corner with the greatest X and least Y, and so on. The plate's edges must run along X and Y in the job as drawn. Run finds the two straight edges that meet there and where they meet. For a plate with rounded corners, `r` is the corner radius in mm (none or `0`: square), and `at` is where the two straight edges would meet if they carried on: the corner of the plate's bounding box. Run aims the camera about `r` inside the plate, fits each edge only more than `r` from that point (leaving the arc out), and needs at least 3 mm of straight edge in view past the rounding. If it can't see that much, the jog dialog says so. A job with corners is only moved and turned, never stretched (the plate is its own size), whatever `regMarks.mode` says; one corner is enough (the turn comes from its edges), two or three are better.
  - Unknown kinds, and a corner without `toward`, are refused.
- Jobs with more registration marks than the mode uses are refused by the app (`checks` has an entry with `block: true`).
- Times in `estimate.perProcess` are cutting/engraving only. Travel (from the machine origin, between cuts and back) is `travelSeconds`.
- `files.dxf` is the same geometry as an R12 DXF (Y up, origin bottom left, one layer per process, `REGMARKS` layer for the camera marks). `files.sheet` is a plain-text job sheet for the operator. `files.cjob` is the same content as a saved job file (below).

## Job file (.cjob) — Save, Save to computer and Save locally

All three save the same single file, which holds everything needed to run the job as set up:

| Key | Contents |
|---|---|
| (top level) | The editable job: `entities` (geometry), `processes`, `sheet`, `regMode`, `cutOrder`, `beds`, `notes`… |
| `material` | The material and its presets: `presets.laser` / `presets.plotter` are the shared starting values, and `presets[<machine id>]` a machine's own list when it has one |
| `machine` | The machine it was set up for (connection, bed, speeds, features) |
| `run` | The job package above (settings in run order, `toolpath`, `estimate`, `regMarks`, `checks`), without `entities` since they're at the top level |

Opening a .cjob in the app restores the job, and adds the material and machine to the library if they're missing.

## Machine settings (`GET /machine`)

Any subset of these. Missing keys keep their current value.

```json
{
  "bed": [813, 508], "speed": 3550, "acc": 50000, "origin": "tl", "units": "mm", "home": true, "prefix": "TRO-",
  "source": "CO2", "power": 80, "lens": "2.0\"", "pwm": 5000, "minPower": 8, "focus": "0.0", "airDefault": "High",
  "markType": "Dot", "markD": "5.0", "camX": "-42.15", "camY": "18.60", "calibrated": "12 Oct 2026", "markTime": 4.7,
  "heads": [{ "slot": "T1", "tool": "Knife", "x": "0.00", "y": "0.00", "loaded": true }],
  "feedLen": 1000, "timing": { "toolDown": 0.15, "toolUp": 0.12, "toolChange": 8, "feedSpeed": 200, "feedSettle": 3 },
  "f": { "camera": true, "autofocus": true, "rotary": false, "air": true, "conveyor": false, "vacuum": false }
}
```

`speed`, `acc` and (for plotters) `timing` feed the time estimate, so the more accurately the device reports them, the closer the simulation gets. `markTime` is the seconds the device takes per registration mark (Pathline Run 0.7.13 on: learnt from the jobs it ran, including the short move between marks); without it Pathline uses 1.5 s. On a Trotec, `acc` is the acceleration that times a short travel hop (see `travelAcc` and `jerk` for the real figures): it's for travel only, not for an engraving line's turnaround.

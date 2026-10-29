# Controller protocol (v1)

This is how **Pathline** talks to the device that runs the machine (the HMI / controller PC). Implement these endpoints on that device and the app can send jobs, read settings and jog over Ethernet. `tools/device-emulator.js` is a working reference implementation.

- Transport: HTTP/1.1 with JSON bodies, `http://<ip>:<port>/api/v1/...` (port 8470 by default, set per machine on the Machines page)
- Errors: any non-2xx status with `{ "error": "message" }`. The app shows the message to the operator.
- Units: millimetres, seconds, mm/s. Coordinates have their origin at the **top left of the bed, Y pointing towards the front**.
- The device is responsible for safety: it should refuse motion (`409`) while a job runs, or while interlocks are open.

## Read

| Method | Path | Returns |
|---|---|---|
| GET | `/info` | `{ name, type: "laser" \| "plotter", ctrl, model, firmware, protocol: 1, bed: [w, h] }`, used by **Test connection** |
| GET | `/machine` | Settings set on the HMI, shown read-only on the Machines page (**Refresh from machine**). See *Machine settings* below. |
| GET | `/status` | `{ state: "idle" \| "running" \| "paused" \| "framing" \| "alarm", pos: { x, y, z }, progress: 0–1, job, message, io: { air, pointer, vacuum, exhaust } }`, polled every 1.5 s |
| GET | `/jobs` | The machine's queue, in run order: `[{ id, name, status: "queued" \| "running" \| "done" \| "stopped", progress: 0–1, seconds, receivedAt, finishedAt }]`. The app's Queue tab shows this list, polled every 3 s. |
| DELETE | `/jobs/{id}` | Remove a job that hasn't started (`409` if it is running) |
| POST | `/jobs/order` | `{ ids: [...] }`: new order for the waiting jobs |

## Send a job

`POST /jobs` with a **job package** (below). Respond `{ id, status: "queued" }`. The app may then call `POST /start`.

## Commands

All are `POST` with a JSON body and return a small JSON object.

| Path | Body | Meaning |
|---|---|---|
| `/jog` | `{ axis: "x" \| "y" \| "z", distance }` or `{ x, y }` | Relative jog, or absolute move |
| `/home` | `{}` | Home all axes |
| `/frame` | `{ box: [x0, y0, x1, y1] }` | Trace the job outline (laser pointer / low power) |
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
  ],
  "files": { "dxf": "…", "svg": "…", "sheet": "…", "cjob": { } }
}
```

- `processes` are in **run order** (engrave → mark → cut on lasers; marking tools → V-cut → crease → knife on plotters). Each process lists the colour indexes (`aci`) it applies to.
- `entities[].paths` are polylines in mm (`c: true` = closed). Curves are already flattened.
- Plotter processes use `tool: "T1 · Knife"` in place of `proc/power/f`, and `dash/dl/gl` for perforation or bridges.
- Laser cuts with `dash: true` are cut in links: `dl` mm cut, `gl` mm left uncut, repeated along the path.
- Engrave processes carry `dir` (`"down"` top down, `"up"` bottom up, `"fastest"`) and `uni` (`true`: every scan line left to right, with the beam off on the return stroke; `false`: both ways). Each `engrave` step gives the result for that step: `direction` (`"down"` or `"up"`, so "fastest" is already decided) and `bidirectional`.
- `regMarks.marks` are the objects the operator drew in a **Registration marks** colour (`regMarks.aci`), given by their centre and size. Nothing is placed automatically, and they are not in `processes`, so they are never cut. They're still in `entities` and on the `REGMARKS` layer of the DXF.
- `cutOrder.order` is `file` (as drawn), `speed` (shortest travel) or `heat` (spread heat). `cutOrder.inside` is `part` (each part's holes, then its outline), `all` (every hole before any outline) or `off`.
- `toolpath` is the job **in run order, exactly as simulated**. It starts with `inspect` steps (the head visits each registration mark so the camera can read it), then engraving, then cutting. Each cut has its chosen start point (closed shapes start where it's most convenient on the travel path); tool changes and conveyor feeds are listed too. Travel between steps is implied: go to the next step's first point. Every step is one pass. Engraving is split into islands (artwork more than 2 mm apart), one `engrave` step each with its own `box`. Where one side-to-side scan across islands at the same height is quicker, they share a step with `scan: "across"`: engrave over the artwork and cross the gaps at travel speed (beam off). Otherwise `scan: "island"`. A `dwell` step (`seconds`, `pass`) means wait with the beam off before the next pass; it comes from the process's `dwell` setting (seconds between passes, laser only). With `cutOrder.order` `speed`, each island's and each path's passes are listed straight after each other (`pass: 1`, `pass: 2`, then the next one). With `file` or `heat`, passes repeat a group: every island with `pass: 1`, then every island again with `pass: 2`. Cut paths go in groups (the inside shapes of a nesting layer, or of one part with **Per part**): every path in the group with `pass: 1`, then every path again with `pass: 2`, then the next group.
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
  "markType": "Dot", "markD": "5.0", "camX": "-42.15", "camY": "18.60", "calibrated": "12 Oct 2026",
  "heads": [{ "slot": "T1", "tool": "Knife", "x": "0.00", "y": "0.00", "loaded": true }],
  "feedLen": 1000, "timing": { "toolDown": 0.15, "toolUp": 0.12, "toolChange": 8, "feedSpeed": 200, "feedSettle": 3 },
  "f": { "camera": true, "autofocus": true, "rotary": false, "air": true, "conveyor": false, "vacuum": false }
}
```

`speed`, `acc` and (for plotters) `timing` feed the time estimate, so the more accurately the device reports them, the closer the simulation gets.

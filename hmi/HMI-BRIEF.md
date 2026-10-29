# Pathline Run: brief for building the controller/HMI app

This package has everything needed to build **Pathline Run**: the app that runs on the machine's own PC or touchscreen (the HMI, "human–machine interface"), receives jobs from **Pathline** over Ethernet, and actually drives the laser or plotter.

**Read in this order:**
1. This brief (what the HMI is for, how to interpret a job, what's still open).
2. [`PROTOCOL.md`](PROTOCOL.md): the normative wire protocol. When this brief and PROTOCOL.md disagree, PROTOCOL.md wins.
3. [`examples/`](examples/): real job packages produced by Pathline's own code, plus example responses.
4. [`reference/device-emulator.js`](reference/device-emulator.js): a working (pretend) implementation of every endpoint.

Then check your implementation with [`tools/check-hmi.js`](tools/check-hmi.js) (§9).

### What's new in Pathline 1.1 (29 Oct 2026)

The wire protocol hasn't changed (`protocol: 1`). What the HMI will see differently:
- **Nested jobs.** Pathline can now nest parts onto a laser sheet or bed, or across plotter beds (adding beds as needed), and may turn parts 90°. Packages still arrive as plain, already-placed geometry, so there's nothing new to implement, but expect more parts per job, rotated parts, and plotter jobs using several beds with `feed` steps between them.
- **Test grids with many processes.** The Materials test grid now uses the operator's own range: low and high power, low and high speed, and up to 9 divisions each. That means up to 10 × 10 = 100 squares, each with **its own process** (ACI 10 and up), plus a low-power "Grid labels" engrave process (ACI 8). Handle jobs with 100+ processes, and ACI numbers above 9.
- **Engrave direction and scan.** Each `engrave` step carries `direction` and `bidirectional` (4.4, 4.5). Power ratio and `/origin` are gone (§11).
- **Pathline updates itself** from GitHub releases, checking each time it opens, and keeps bug and crash reports locally (Help → Report a bug…). Pathline Run should do the same (§8), so both apps can be supported the same way.

---

## 1. The system

```
 Office / design PC                                 Machine
┌──────────────────────────────┐   Ethernet      ┌──────────────────────────────┐
│ Pathline (Windows, Electron) │  HTTP + JSON    │ Pathline Run  (THIS APP)     │
│  · import & arrange drawings │ ──────────────▶ │  · HTTP server, port 8470    │
│  · processes, materials      │  POST /jobs     │  · job queue                 │
│  · simulate + time estimate  │  GET /status …  │  · executes job packages     │
│  · send job, jog, frame      │ ◀────────────── │  · camera, safety, local UI  │
└──────────────────────────────┘                 │  → motion controller / laser │
                                                 └──────────────────────────────┘
```

- **Pathline prepares; Pathline Run runs.** Pathline never talks to motors, lasers or controller boards. It sends one self-contained JSON **job package**. The HMI turns that into machine motion, using whatever controller the machine has (a Trotec or Ruida controller, GRBL, a motion card, and so on). That translation is entirely the HMI's job.
- Pathline is finished, and so is its side of the protocol. **The HMI implements the server side.** Pathline is only an HTTP client: it starts every request, and the HMI never calls Pathline.
- One HMI serves one machine. Pathline can have several machines set up, each with its own IP and port.
- Pathline's name for this app is **Pathline Run**. Its icon is in [`brand/`](brand/).

## 2. What the HMI must do

| Area | Responsibility |
|---|---|
| Network API | Serve every endpoint in PROTOCOL.md at `http://<ip>:8470/api/v1/…` (the port is configurable; 8470 is the default). JSON in and out. |
| Job queue | Keep received jobs in order. Start the next one when told (`POST /start`, or the operator on the HMI). Report the queue (`GET /jobs`), and let Pathline reorder or remove waiting jobs. |
| Execution | Run a package's `toolpath` steps in order (§4), with the process settings (power, speed, frequency or DPI, passes, links, air), registration-mark correction, tool changes and conveyor feeds. |
| Status | Report state, head position, progress, current job, a message and I/O within ~1 s (`GET /status` is polled every 1.5 s). |
| Machine settings | Be the source of truth for the bed, speeds, features, heads and camera calibration, and report them in `GET /machine`. Pathline shows them read-only and uses them for its time estimate and to decide which controls to show. |
| Manual control | Jog, home, frame, outputs (air, pointer, vacuum), autofocus, test fire, conveyor feed, tool change (§6). |
| **Safety** | **The HMI alone is responsible for safety.** It refuses motion while busy (`409`), honours interlocks, lid and e-stop, and always accepts `/stop`. Pathline trusts the HMI to refuse anything unsafe (§7). |
| Local UI | A screen at the machine (queue, live status, start/pause/stop, jog, camera view, alarms), plus a web page at `/` (Pathline's **Open HMI** button opens `http://<ip>:<port>/` in a browser). |
| Storage | Keep each received job, including the files in `files`: DXF, SVG, job sheet and the `.cjob`, which Pathline can reopen. The emulator writes one folder per job. |

## 3. Network contract: what Pathline relies on

PROTOCOL.md lists every endpoint. These are the practical details Pathline depends on:

- **Timeouts:** Pathline gives up after the machine's timeout (default **3000 ms**, set per machine) and reports "No response after … ms". Answer `/info`, `/status` and `/jobs` quickly. Do slow work, like starting a homing cycle, in the background and return at once.
- **Polling:** while the Job page is open and the machine's connection is Ethernet, Pathline polls `GET /status` every **1.5 s** and `GET /jobs` every **3 s**. The Machines page checks `/status` every 8 s for its online dot.
- **Errors:** any non-2xx status with body `{ "error": "Human-readable message" }`. Pathline shows the message to the operator as-is, so write it for operators ("Lid is open", not "E_INTLK_3"). Use `409` for "not now" (busy, lid open, job running), `400` for a bad request, and `404` for an unknown job.
- **Body size:** `POST /jobs` carries the whole package *plus* `files` (DXF, SVG, sheet and `.cjob`). That is typically 0.1–5 MB, but large engravings or many parts can be tens of MB. Accept at least 100 MB (the emulator allows 200 MB).
- **Encoding:** UTF-8 JSON. Names contain characters like `×`, `·`, `°`, `–`.
- **No CORS needed:** Pathline calls from Electron's main process, not a browser. **No authentication** in protocol v1 (LAN only, see §11).
- **Additive changes:** ignore fields you don't know. Pathline may add fields later. `protocol: 1` in `/info` is the version.

### Which Pathline action sends which request

| In Pathline | Request(s) |
|---|---|
| Machines → **Test connection** | `GET /info`: must return `protocol: 1`, `type`, `bed` |
| Machines → **Refresh from machine** | `GET /machine`; the values replace the machine's settings in Pathline |
| Machines → **Open HMI** | Opens `http://<ip>:<port>/` in the browser |
| Job page header status / Move tab position | `GET /status` (polled) |
| Job → **Send to machine** | `GET /status` first ("connection check"), then `POST /jobs` with the package. Pathline does **not** start the job. |
| Job → Queue tab: list / drag to reorder / remove / **Start** | `GET /jobs`, `POST /jobs/order`, `DELETE /jobs/{id}`, `POST /start` |
| Move tab: jog arrows (step 0.1, 1, 10 or 100 mm) | `POST /jog { axis: "x"\|"y"\|"z", distance: ±mm }` |
| Move tab: **Stop machine** (red) | `POST /stop {}` |
| Move tab: Home | `POST /home {}` |
| Move tab: Frame | `POST /frame { box: [x0, y0, x1, y1] }` (bounding box of the visible job, bed mm) |
| Move tab: Air / Pointer / Vacuum switches | `POST /io { air: true }` (one key per call) |
| Move tab: Auto-focus (lasers with autofocus) | `POST /autofocus {}` |
| Move tab: Test fire (operator confirms in Pathline) | `POST /testfire { power: %, ms }` |
| Move tab: Pause / resume | `POST /pause` or `POST /resume` (chosen from `status.state`) |
| Move tab: Feed one bed (plotters with a conveyor); Machines → Features → Test | `POST /feed {}` |
| Move tab: Tool change (plotters) | `POST /toolchange { slot: "T2" }` |

`POST /stop` must always work. Pathline's Stop goes over the network, so the HMI's own physical and on-screen Stop/E-stop remain the primary ones.

## 4. Executing a job package

The examples in [`examples/`](examples/) are exact outputs of Pathline's exporter:

| Example | Shows |
|---|---|
| `laser-print-and-cut/` | Laser with a camera: 3 registration marks (`inspect`), engraving as one **shared scan** (`scan: "across"`) and one **island**, an inside hole cut before the outline, a cut in **2 passes with a 3 s dwell**, and a **dashed** tear-off line |
| `plotter-two-beds/` | Plotter on a conveyor: knife, perforation (dashed), crease and V-cut across **2 beds**, with **tool changes** and a **conveyor feed** |

Each example folder contains `post-jobs-body.json` (the exact body POSTed), `package-without-files.json` (easier to read), and the separate `job.dxf`, `job.svg`, `job-sheet.txt` and `example.cjob`.

### 4.1 Coordinates and units
- **Millimetres, seconds, mm/s.** The origin is the **top-left of the bed, with Y pointing towards the front** (down on screen). All geometry (`toolpath[].p`, `box`, `at`, `entities[].paths`, `frame` boxes and jog targets) uses this system.
- On a multi-bed plotter job, each bed uses the **same** bed coordinates. A step's `bed` says which bed it's on, and the conveyor `feed` step moves the material forward between beds.
- `files.dxf` is **Y-up with its origin bottom-left** (DXF convention). Don't mix it with the package coordinates. The package is authoritative.
- Pathline's time estimate assumes the head starts at, and returns to, the corner named by `origin` in `/machine` (`tl`, `tr`, `bl`, `br`), and travels between steps at the machine's max `speed` with `acc`.

### 4.2 Top-level fields
| Field | Meaning |
|---|---|
| `format`, `version` | `"lrc-job-package"`, `1`. Refuse anything else with `400`. |
| `job` | `{ id, name, notes }`. Show `name` in the queue. |
| `machine` | What Pathline thinks it's sending to (`id`, `name`, `type`, `bed`). Refuse with a clear error if `type` doesn't match the machine. |
| `material` | `{ id, name, thickness }` or `null`. For display, and optionally focus/Z. |
| `sheet` | `{ w, h, x, y }` of the material sheet on the bed, or `null` |
| `regMarks` | `{ mode: "off"\|"pos"\|"linear"\|"nonlinear", aci, marks: [{ id, x, y, d }] }` on lasers, `null` on plotters |
| `beds` | Number of beds (plotters) |
| `cutOrder` | How Pathline ordered the cuts (informational; the order is already applied in `toolpath`) |
| `processes` | The processes that output, **in run order**, each with `index` (referenced by `toolpath[].process`). See 4.3. |
| `disabledProcesses` | Names of processes switched off (informational) |
| `estimate` | `totalSeconds`, `total` (text), `perProcess`, `travelSeconds`, `travelMm`, `cutLengthMm`, `engraveAreaMm2`, `toolChanges`, `feeds`. Use it for queue times. |
| `checks` | Pathline's pre-send checks. A job with a `block: true` check is never sent. Warnings may be shown. |
| `toolpath` | **The job, in run order, exactly as simulated.** See 4.4. |
| `entities` | The geometry (`id`, `name`, `aci`, `bed`, `paths: [{ p: [[x, y]…], c: closed }]`). Curves are already flattened to polylines. Needed for engraving (4.5). |
| `files` | `dxf`, `svg`, `sheet` (plain text) and `cjob` (an object). Store them with the job. |

### 4.3 Process settings
**Laser processes** (`proc` is `"Cut"` or `"Engrave"`):

| Field | Meaning |
|---|---|
| `name` | Operator's name for it |
| `proc` | `"Cut"`: vector, follow the path with the beam on. `"Engrave"`: raster fill (4.5). **Every Engrave process is raster**, even one named "Engrave outline". |
| `power` | % of the laser's rated power (`/machine power` W) |
| `speed` | mm/s along the path (Cut) or along the scan line (Engrave) |
| `f` | **Cut:** pulse frequency in Hz. **Engrave:** resolution in **DPI**: line spacing = 25.4 / f mm |
| `passes` | Passes per item. Already expanded in `toolpath` (one step per pass), so don't repeat steps yourself. |
| `dwell` | Seconds to wait between passes (only when passes ≥ 2). Also expanded as `dwell` steps. |
| `air` | `"On"` / `"Off"`: air assist during this process (only if the machine has air, `f.air`) |
| `dash`, `dl`, `gl` | **Links (bridges/perforation)** on cuts: when `dash` is true, cut `dl` mm, leave `gl` mm uncut (beam off), and repeat along the path |
| `dir`, `uni` | **Engrave only.** `dir`: `"down"` (top down, the default), `"up"` (bottom up) or `"fastest"`. `uni`: `true` = one way (every line left to right, beam off on the return stroke), `false` = both ways. Each `engrave` step already has the result (`direction`, `bidirectional`), so follow the step (4.4). |
| `aci` | The drawing colours (AutoCAD Color Index) this process applies to |
| `adv` | Advanced settings set by the operator. **Only changed values are present.** Defaults below. |

`adv` keys and the defaults Pathline shows:
- **Cut:** `Source` (CO2 DC / CO2 RF / Fiber, default CO2 DC), `Power correction` (7), `Path planning` (Standard / Inner geometries first / Optimised), `Process gas` (Air assist / Off / Nitrogen), `Z-offset` (0 mm).
- **Engrave:** `Source`, `Frequency` (0 Hz), `Power correction` (20), `Engrave mode` (Standard / Stamp / Relief), `High quality` (Off/On), `Relief` (bool), `Extended overshoot` (0 mm), `Z-offset` (0 mm), `Process gas`, `Dithering` (Floyd–Steinberg / Ordered / Jarvis / Stucki / None), `Engrave covered layers` (bool), `Process splitting` (None / By colour / By object).

Apply the ones your controller supports, ignore the rest, and say which you ignore in your docs. (These names came from the original UI design, modelled on Trotec's settings.)

**Plotter processes:** `tool` (e.g. `"T2 · V-cut 45°"`; the slot is the part before ` · `), `speed` mm/s, `passes`, `dash`/`dl`/`gl` (perforation: cut `dl`, skip `gl`), `aci`. There's no `proc`, `power` or `f`.

**Registration-mark processes** are never in `processes` and are never cut. The marks arrive as `regMarks` and `inspect` steps.

### 4.4 Toolpath steps
Run `toolpath` **in array order**. **Every step is one pass.** Travel between steps is implied: move to the next step's first point (or `box`/`at`) with the beam off or the tool up, at travel speed. Each step has `seconds`, Pathline's estimate for that step, which you can use for progress.

| `type` | Fields | What to do |
|---|---|---|
| `inspect` | `mark`, `of`, `at: [x, y]`, `d`, `seconds` | Move the **camera** over the registration mark at design position `at` (apply your camera offset `camX`/`camY`), find the filled black dot of diameter `d` mm, and record its measured position. After the last `inspect` (`mark === of`), compute the correction (4.6) and apply it to every later step. If a mark can't be found: stop, set `state: "alarm"` and give a clear `message`. |
| `engrave` | `process`, `name`, `ents: [ids]`, `bed`, `dpi`, `passes` (=1), `pass`, `lines`, `scan: "across"\|"island"`, `box: [x0, y0, x1, y1]`, `seconds` | Raster-engrave the listed entities inside `box` (4.5). |
| `cut` | `process`, `name`, `ent`, `bed`, `closed`, `passes` (=1), `pass`, `p: [[x, y]…]`, `seconds` | Follow the polyline `p` with the process settings. If `closed`, finish back at `p[0]`. The start point is already chosen (Pathline picks the most convenient point on closed shapes). Apply links if `dash`. |
| `dwell` | `process`, `name`, `pass`, `seconds` | Beam off, wait `seconds` before the next pass |
| `toolchange` | `process`, `tool`, `bed` | Plotter: switch to the tool's slot (`"T2 · V-cut 45°"` → `T2`) |
| `feed` | `bed` | Plotter conveyor: advance the material one bed (`feedLen`), then continue with the next bed's steps |

`pass` (when present) is the pass number for that step (1, 2, …), for display only.

**Order rules, already applied by Pathline:** registration marks first, then engraving, then cutting (lasers), with inside shapes before their outline. Passes are grouped according to `cutOrder`. Run the list as given; don't reorder it.

### 4.5 Raster engraving (`engrave` steps)
1. Take the entities whose `id` is in `ents` (from top-level `entities`). Closed paths are **filled even-odd** (a hole inside a shape is not engraved). Open paths are engraved as a thin band one line wide.
2. Scan lines are horizontal and spaced **25.4 / dpi mm**, covering `box` (`lines` is Pathline's count).
   - **`direction`:** `"down"` starts at the top line of `box` and works down; `"up"` starts at the bottom and works up. Pathline has already resolved "fastest" for each step, picking the end nearer the head.
   - **`bidirectional`:** `true` alternates left→right, then right→left. `false` (one way) engraves every line left→right and returns with the beam off. One way is slower, but gives a cleaner edge on some materials.
3. On each line, the beam is on only over the filled intervals (intersect the line with the shapes, then apply even-odd). Add **overscan** beyond the ends so the head is at speed before the beam turns on. Pathline's estimate uses speed² / (2 · acc), plus `adv['Extended overshoot']`.
4. `scan: "island"`: these entities are one island (shapes within 2 mm of each other). Scan only across their own extent.
5. `scan: "across"`: several islands at the same height share **one side-to-side scan**. Engrave at process speed over the artwork, and **cross the gaps with the beam off at travel speed**. Pathline chose this because it's quicker than doing them one by one.
6. `reference/core.js` → `rasterSpans(paths, dpi)` gives Pathline's per-line extents **for timing** (`[y, xmin, xmax]`, the head sweep). It's not the beam on/off intervals, but it's a useful cross-check. `core.js` is UMD: `require('./core.js')` in Node, or `<script>` → `window.CC`.

Bitmap/photo engraving isn't in Pathline yet. Today only vector shapes are filled. `Dithering` matters only once images arrive.

### 4.6 Registration marks (print and cut)
The operator prints artwork with marks, puts the sheet on the bed, and the camera reads the marks so the cut lines up with the print, even if the sheet is shifted, rotated or slightly distorted.

- `regMarks.marks` are the design positions (centre `x`, `y`, diameter `d`). The `inspect` steps visit them in Pathline's chosen order, ending nearest where the work starts.
- `mode: "pos"` (2 marks): **position and rotation**. Fit a rigid transform (translation + rotation; scale is optional).
- `mode: "linear"` (3 marks): **full linear**. Fit an affine transform (translation, rotation, scale and shear) from the 3 point pairs.
- `mode: "nonlinear"` (3 marks): **non-linear**. The intent is to correct uneven distortion as well. The method is the HMI's choice (§11).
- Apply the transform to every coordinate of every later step (paths, boxes, gaps). Pathline never sends more marks than the mode uses (such jobs are blocked). If there are fewer marks than the mode needs, Pathline only warns, so handle it: refuse to start, or fall back.
- Machine settings that matter: `markType` (Dot), `markD`, `camX`/`camY` (camera offset from the beam), `calibrated` (date text), and `markTime` (seconds to read one mark, used by Pathline's estimate, default 1.5).

## 5. Machine settings (`GET /machine`)

Return any subset. Missing keys keep Pathline's current value. Pathline reads this on Refresh from machine, on first contact (Test connection, or the first status answer after it was offline), each time Pathline opens, and every 5 minutes. Answer quickly, and keep it cheap. Pathline uses the keys as follows:

| Key | Used for |
|---|---|
| `name` | **The machine's name in Pathline** (from Pathline 1.2.6; if `/machine` has no `name`, the one in `/info` is used). Pathline shows it read-only, so the name is set on the HMI. |
| `bed: [w, h]` | Canvas size, "job inside bed" check, frame limits |
| `speed`, `acc` | **Time estimate** (max travel speed mm/s, acceleration mm/s²) |
| `origin` (`tl`/`tr`/`bl`/`br`) | Start/return corner in the estimate |
| `units`, `home`, `prefix` | Shown in Pathline; `prefix` is put in front of saved job file names |
| Laser: `source`, `power` (W), `lens`, `pwm`, `minPower`, `focus`, `airDefault`, `lid`, `exhaust` | Shown read-only; `power` also drives the thermal map |
| Camera: `markType`, `markD`, `camX`, `camY`, `calibrated`, `markTime` | Registration marks |
| Plotter: `heads: [{ slot, tool, x, y, loaded }]` | Tool list and offsets (strings), shown read-only |
| Plotter: `feedLen`, `timing: { toolDown, toolUp, toolChange, feedSpeed, feedSettle }` | Conveyor length; **time estimate** for tool up/down, changes and feeds |
| `f: { camera, autofocus, rotary, air, conveyor, vacuum, pointer, pass, interlock, detect }` | **Feature flags.** Pathline **hides** the controls for features that are `false` (registration marks, auto-focus, air, conveyor feed, vacuum, pointer…), so report them accurately. |

See `examples/responses/GET-machine-laser.json` and `GET-machine-plotter.json`. `/info` is separate and small (`name`, `type`, `ctrl`, `model`, `firmware`, `protocol: 1`, `bed`).

## 6. Status, queue and state

- `state`: `idle` (ready) → `running` (a job is executing) ⇄ `paused` → back to `idle` when it finishes or stops. `framing` while tracing a frame. `alarm` for faults (lid open, mark not found, limit hit…), with an operator-readable `message`. (There is no "clear alarm" endpoint in v1; clear it on the HMI.)
- `pos: { x, y, z }`: the live head position in bed mm. Pathline shows it, so update it while moving.
- `progress`: 0–1 for the current job. Suggested: the sum of the completed steps' `seconds` ÷ `estimate.totalSeconds`.
- `job`: the id of the running job, or `null`. `io: { air, pointer, vacuum, exhaust }`: current outputs.
- Queue entries: `{ id, name, status: queued|running|done|stopped, progress, seconds, receivedAt, finishedAt }`, in run order. Keep finished ones for a while, so the operator sees what ran. `POST /start` runs the **next queued** job. The emulator also moves on to the next queued job when one finishes. That's reasonable behaviour, but your choice.
- `POST /jobs/order { ids }` reorders only the waiting jobs. `DELETE /jobs/{id}` refuses (`409`) a running job.
- **Receiving a job never starts it.** It starts only on `POST /start` or the operator's Start on the HMI.

## 7. Safety (non-negotiable)

- `POST /stop` must **always** be accepted, in every state, and must stop motion and the beam immediately.
- Refuse motion (`jog`, `home`, `frame`, `feed`, `toolchange`, `testfire`, `start`) with `409` while a job runs, while framing, or while interlocks (lid, door, exhaust, e-stop) are open. Give the reason in `error`.
- `testfire`: Pathline asks the operator to confirm first, but check interlocks yourself anyway.
- Clamp jogs and absolute moves to the bed. Validate every number in a package (power 0–100, speeds > 0, coordinates inside the bed) before starting.
- The HMI's physical/on-screen Stop and E-stop take priority over anything from the network.

## 8. The HMI's own interface

- A touchscreen app at the machine: queue (start/pause/stop, reorder), live status and position, a preview of the running job (the `toolpath` is drawable), jog/home/frame, the camera view for registration, alarms with clear text, and settings (bed, speeds, features, camera calibration, heads), which `GET /machine` reports.
- A web page at `/`. Pathline's **Open HMI** button opens it. The emulator's page is a minimal example (status and queue).
- To match Pathline: use the design tokens in [`reference/theme.css`](reference/theme.css).
  - **Brand:** IBM Plex Sans/Mono, accent Path red `#D62828`, light and dark themes, the **Pathline Run** icon in `brand/`.
  - **Bed:** white in light mode, grey (`--bed` `#3B3E44`) in dark mode.
  - **ACI colours** (1 red, 2 yellow, 3 green, 4 cyan, 5 blue, 6 magenta…) identify processes, so show them as-is. The exception is ACI 7, which is black on a light bed and white on a dark one, as in CAD. Registration marks and other marks drawn on the bed follow the same rule (`--ink`).
- **Updates and reports, the same way Pathline does them** (recommended):
  - check GitHub releases each time the app opens, download in the background, and install on restart;
  - offer Help → Check for updates;
  - keep crash and bug reports as folders in the app's data folder, not the program folder, since an update replaces the program folder.

  Pathline's versions are in [`reference/updates.js`](reference/updates.js) and [`reference/reports.js`](reference/reports.js). On a machine PC that's often offline, a failed update check must never block the HMI.

## 9. Testing

1. **Reference behaviour:** `node reference/device-emulator.js` (add `--type plotter` for a plotter) starts a pretend machine on port 8470 that implements every endpoint. Open `http://localhost:8470/`. Compare your HMI with it.
2. **Protocol check:** `node tools/check-hmi.js <hmi-ip>` (Node 18+). By default it only reads, and queues and removes two test jobs. Add `--allow-motion` to also home, jog and frame, and `--run` to start, pause, resume and stop a test job. **These move the real machine.** It passes against the emulator, for both laser and plotter.
3. **Replay real packages:** `curl -X POST -H "content-type: application/json" --data-binary @examples/laser-print-and-cut/post-jobs-body.json http://<hmi-ip>:8470/api/v1/jobs`
4. **With Pathline itself:** Setup → Machines → **Add machine** → Ethernet, the HMI's IP and port 8470 → **Test connection** → **Refresh from machine** → Save. Then send a job from the Job page, and watch the Queue and Move tabs.

`reference/pathline-device-client.js` is Pathline's actual HTTP client (how every request is made, timeouts and error handling). `reference/exporters.js` is how the package is built.

## 10. What's in this package

| Path | What it is |
|---|---|
| `HMI-BRIEF.md` | This brief |
| `PROTOCOL.md` | The wire protocol (normative) |
| `examples/laser-print-and-cut/`, `examples/plotter-two-beds/` | Real packages: the POST body, a readable version, and the DXF, SVG, job sheet and `.cjob` |
| `examples/responses/` | Example `/info`, `/machine` (laser and plotter), `/status` (idle and running), `/jobs`, `POST /jobs` and error responses |
| `reference/device-emulator.js` | Working reference server (Node, no dependencies) |
| `reference/pathline-device-client.js` | Pathline's client side of the protocol |
| `reference/core.js` | Pathline's geometry and estimator (raster spans, time model, registration marks) |
| `reference/exporters.js` | How Pathline builds the package and the toolpath |
| `reference/theme.css` | Pathline's design tokens (colours, light and dark, bed and ACI 7 rules) |
| `reference/updates.js`, `reference/reports.js` | How Pathline checks GitHub for updates and keeps crash and bug reports |
| `tools/check-hmi.js` | Protocol conformance checker |
| `brand/` | Pathline Run icon (SVG, PNG, ICO) |

## 11. Open questions for the owner

**Settled by the owner (28 Oct 2026):**
- **Power ratio is removed.** Links are simply cut `dl` mm, then `gl` mm with the beam off.
- **There is no job origin.** Packages use absolute bed coordinates, and there's no `/origin` endpoint.
- **Engrave direction** is a setting: top down (the default), bottom up or fastest, plus one way or both ways. Each `engrave` step carries the resolved `direction` and `bidirectional`.
- **No authentication.** LAN only is fine.

**Still open.** Ask the owner, or choose and document:
1. **Non-linear registration:** which correction method to use with 3 marks.
2. **Alarms:** v1 has no endpoint to read alarm details or clear an alarm. `status.message` carries the text. Is that enough?
3. **Material thickness / focus:** should the HMI set Z or focus from `material.thickness` plus `adv['Z-offset']`, or leave focus to the operator or autofocus?
4. **Air:** process `air` ("On"/"Off") and `adv['Process gas']` overlap. Suggested: `air` says on/off; `Process gas` chooses air or nitrogen when on.

## 12. Done when

- [ ] `tools/check-hmi.js <ip> --allow-motion --run` passes on the real machine (laser and/or plotter).
- [ ] Pathline: Test connection, Refresh from machine (correct bed, speeds, features), send, queue reorder/remove, Start, Move tab controls and live position all work.
- [ ] Both example jobs run correctly on the machine: marks read and the cut aligned with the print; engraving with shared scans and islands; passes with dwell; links; tool changes and conveyor feed.
- [ ] A 10 × 10 test grid from Setup → Materials (100 processes) and a nested plotter job over several beds both run correctly.
- [ ] Stop, E-stop and interlocks stop everything, from any state, and motion is refused with `409` while busy.
- [ ] Received jobs and their files are stored. Errors reach Pathline as readable `{ error }` messages.
- [ ] Actual run times roughly match `estimate.totalSeconds` (if not, report better `speed`/`acc`/`timing` in `/machine`).

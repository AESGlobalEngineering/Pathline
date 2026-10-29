# Pathline: handoff

This brief lets someone (a person or another AI assistant) pick up Pathline with no other context. It covers what the app is for, what the owner asked for and decided, how the code is laid out, and how to run, test and ship it. The raw chat transcript is in `handoff/transcript.jsonl`. You only need it for exact wording; this file is the summary.

State at handoff: **28 Oct 2026**, final version. Self-test passes, and the installer was built from this source (`dist\Pathline Setup 1.0.0.exe`). There is no git history; this folder is the only copy.

Latest round (28 Oct, final):
- **Ships with no machines or materials.** Until a machine is added under Setup → Machines, the Job page lays the job out on a stand-in "No machine" bed (never stored; sending is blocked). Both Setup pages have empty states. The last machine can now be removed. The metals seeding migration is gone.
- **Fixed:** after ungrouping, a registration mark sitting in a ring's hole couldn't be selected, because the ring won the click. Marks are drawn solid, so a click anywhere inside one now picks it. On a tie, the smaller object wins (`JobCanvas.hit` in app.js).
- **Zoom controls standardised:** Simulation now uses the same [− · zoom % · +] group and Fit button as the Job canvas, with the same wheel feel and + / − / 0 keys. Clicking the % gives actual size. Left, right or middle drag pans.
- **Design package** for harmonising the whole design: see §5.

29 Oct (after the red/dark redesign was merged):
- **No light/dark switch in the app bar.** The theme is chosen in Preferences (System / Light / Dark).
- **Dark mode bed is grey** (`--bed`, `--sheet`, `--bed-grid*` in theme.css). **ACI 7 shows as white in dark mode** (black in light), as in CAD, and so do the marks drawn on the bed (registration marks, engrave hatching, arrows, start points): see the `--aci7*` and `--ink` tokens, and `LRC.aci.hex/fg/stroke` in app.js. Exports (DXF/SVG/PDF) still use real black.
- **Sample machines and materials from earlier builds are removed on first start** (main.js, tracked by `settings.samplesRemoved`). This is by exact id (trotec, flatbed, laser2, acr-print-3 … brass-1); anything the operator created stays.

Version 1.2.2 (29 Oct):
- **Fixed: importing several drawings stacked some on top of each other.** Each drawing was placed below the last; when the next one didn't fit, it went back to the top, over what was there. Now each drawing goes in the first free spot (`LRC.ops.freeSpot`: topmost, then leftmost, 10 mm apart) on the sheet or bed, never over existing objects or other imported drawings. A drawing that doesn't fit goes on the next plotter bed (adding beds as needed), or beside the laser bed with a note suggesting Nest parts.

Version 1.2.1 (29 Oct):
- **Updates ask first.** When Pathline opens (and from Help → Check for updates), a found update opens the update window: "Update available — Later / Download and install". Nothing downloads until the operator clicks. The download shows a progress bar (percent, MB, speed) and can be hidden. When it's done: "Restart and install" or Later. `autoDownload` and `autoInstallOnAppQuit` are off (`src/main/updates.js`; the window is `updateWindow()` in app.js). Tested end to end against the real v1.2.0 release with a copy built as version 0.9.0. `LRC_UPDATES=1` lets the screenshot harness run update checks.
- **New jobs start with no processes** when they have no material (before, they got five built-in starting processes).
- **Simulated machines keep a controller type** (Trotec / Ruida / Other), chosen in Add machine and changeable on the Machines page.
- **Releases are automatic:** pushing to main with a package.json version that has no release builds and publishes it. Actions → Release → Run workflow redoes a release. (Re-running an old run rebuilds that run's old commit.)

Version 1.2.0 (29 Oct):
- **Simulated machines, for testing.** Setup → Machines → Add machine → "Simulated, for testing".
  - Stored as `{ sim: true, conn: 'Local', ctrl: 'Simulated' }`. Ethernet is greyed out on the Machines page and in the Send dialog (`localOnly`), and main.js `deliver()` always saves simulated machines' jobs as files.
  - Refresh from machine and Open HMI are disabled.
  - The settings normally read from the machine are editable for simulated machines: bed, speeds, origin, units, laser source, camera, features, safety, vacuum, conveyor and plotter timing. Every `ro…` helper on the Machines page takes a setter that only applies when `raw.sim`. Save keeps the bed, speed and acceleration numeric.

Version 1.1.0 (29 Oct):
- **Nesting optimiser** (Arrange → Nest parts…, and a toolbar button) for lasers and plotters. `CC.nestRects` in core.js packs part footprints (a group counts as one part) with MaxRects, optionally turning parts 90°. It tries 5 sort orders × 3 placement rules and keeps the layout with the fewest areas, then the least material. Lasers nest on the sheet (or the whole bed); plotters add beds as needed. Parts that don't fit a single sheet stay where they were. `LRC.ops.nest` applies the result. This is rectangle (bounding-box) nesting, not true-shape nesting.
- **Test grid range** (Setup → Materials): low and high power, low and high speed, and divisions (1–9 equal steps) for each. The defaults are the old 5 × 5 grid around the preset.
- **Bug and crash reports** (`src/main/reports.js`) are folders in `%APPDATA%\Pathline\reports`, beside the data folder, because the program folder is replaced on every update. Nothing is sent anywhere.
  - Help → Report a bug… saves report.json, log.txt, a screenshot and, optionally, the job.
  - Errors in the main process, crashed pages and crashed child processes are written as crash reports; native dumps go in `reports\dumps`.
  - A `running.lock` left behind marks an unexpected exit.
  - Page errors are appended to `errors.log`.
  - The next start mentions a pending crash once. Help → Open reports folder; Preferences shows the path.
- **Updates** (`src/main/updates.js`, electron-updater) come from GitHub releases. Pathline checks 3 s after each start, downloads in the background, and installs on quit or from "Restart now". Help → Check for updates… checks on demand.
  - Updates work only when `build.publish` (provider github, owner, repo) is set in package.json. The installer then contains `app-update.yml`; without it the check says "not set up".
  - The portable exe can't update itself.
  - `.github/workflows/release.yml` builds and publishes a release when a `v*` tag is pushed.
  - Version 1.1.0 is the first build that has the updater. Anyone on 1.0.0 must install it by hand once.

---

## 1. What Pathline is

A Windows desktop app (Electron) that **prepares** laser and plotter/router jobs. It is not real CAD/CAM. Operators:

1. Import DXF / PDF / SVG / PLT (HPGL) drawings, then arrange and edit them.
2. Assign each drawing colour (AutoCAD Color Index, ACI) to a **process**: cut, engrave or registration mark on lasers, or a tool head on plotters. Each process has speeds and feeds, taken from a **material** preset.
3. **Simulate** the job: the toolpath in run order, a time estimate and a thermal map.
4. **Send** the job to the machine's own controller (an HMI device on the network) over **Ethernet**, or **save it locally** as a `.cjob` file. The controller runs the actual cut.
5. Jog and command the machine through the controller (Move tab).

The original UI prototype (four pages, built on a custom React template runtime) is in `_prototype/`, untouched. The app grew from it.

### Test machines (self-test fixtures only; the app ships with none)
These live in `tools/selftest.js` (`fixtureMachines`). `seed.js` now holds only the blank templates that "Add machine" starts from.

| id | name | type | notes |
|---|---|---|---|
| `trotec` | Trotec Speedy 360 | laser, CO2 80 W | camera (registration marks), autofocus, no rotary, fast (3550 mm/s, 50 000 mm/s²) |
| `flatbed` | Flatbed 1 | plotter, 4 heads | conveyor, vacuum, pointer |
| `laser2` | Laser 2 | laser, CO2 100 W | **no camera**, no autofocus, rotary; slow accel (600 mm/s, 8000 mm/s²) |

---

## 2. Owner's requirements and decisions (cumulative, newest wins)

These are rules the owner set over many rounds. Keep them unless the owner changes them.

### General / app shell
- Rebranded to **Pathline** (brand files in `src/ui/brand/`, `build/`, `build/brand/`). The app was formerly "Laser & Router Control"; its data folder is migrated once on first run.
- **No session persistence.** Closing the app really quits (no background process). Each launch opens a clean job, or the `.cjob` it was opened with.
- Top bar: **Job · Simulation** only. Machines and Materials live under the **Setup** menu (in the Job page menu bar: Setup → Machines…, Materials… (Ctrl+M), Test grid…). The Setup pages show a **Machines | Materials** switch.
- The **Machine** menu was removed entirely, along with its shortcuts (Ctrl+F frame, F5 send-and-start, F6 pause). Frame, home and jog stay in the Move tab. **Go to origin / Set origin were removed** (28 Oct). There's no job origin: packages use absolute bed coordinates, and `/origin` is gone from the protocol.
- Machine **features a machine doesn't have are hidden, not greyed out**: rotary, auto-focus, camera/registration marks, air assist, conveyor, vacuum and pointer. This applies on the Job page (toolbar, Move tab) and on Setup → Machines (Features card, Focus & air, and so on).
- No save icon in the top-left corner. The bottom bar has **no Frame button**, only Send to machine.

### Import / editing (Job page)
- Right-click menu: colour swatches (recolour every selected object), ungroup/group, rename, duplicate, rotate, mirror, lock, hide, and more. The Objects panel also has colour swatches.
- **Rename objects** in the Objects list (pencil button or double-click, then type; Enter saves, Esc cancels), with F2 (dialog), or from the right-click menu. Renaming several at once numbers them Name, Name 2, Name 3…
- **Copies are numbered**: duplicate, paste, Alt+drag, Array and Fill give "Ring 2", "Ring 3"…, counting on from the highest number in use. A cut-and-paste keeps the original name.
- Snap to the visible grid and to objects; the closer snap wins. The measure and line tools snap to outline corners and edges, and the last measurement stays on screen.
- Process settings open as a dropdown under each process row (not a separate panel).
- **Eye icon on a process = view-only hide**: the objects are faded on the canvas and can't be selected, but are **still sent and still simulated**. Output on/off for a process is only set in Setup → Materials (the "Out" column). The "Include in job" switch on the Job page was removed at the owner's request.
- **One process per colour.** A colour used by another process can't be added (greyed in the pickers, with a toast).
- **Process edits apply to the job immediately** (no "Save for this job" button; the "changes apply straight away" tip was removed). An edited process shows a **Job override** tag. "Save to material" saves it as the preset **for the current machine**. "Revert to material preset" undoes it.
- **Before exporting** (Send, Save locally, Save to computer) a job with overrides, the app asks: **Go back / Revert to presets / Continue with changes**.
- **Dwell between passes** (seconds, laser only). The field appears once a process has 2 or more passes; it's also in the material's Advanced settings.

### Registration marks (print and cut, laser with a camera)
- Switching marks on adds a **"Registration marks"** process. Objects in its colours ARE the marks; nothing is auto-placed. The old "Mark" process type was removed.
- Marks are drawn filled black and go on the `REGMARKS` DXF layer. **More marks than the mode needs blocks sending** (Position 2, Linear 3, Non-linear 3).
- Marks are read first. The reading order is chosen to travel least and **end nearest where the work starts** (so the job then runs from that end, normally the top).

### Run order, passes, cut order (estimator: `src/shared/core.js`)
- Order: **registration-mark inspection → engraving → cutting**.
- Cut order setting: **As drawn / Fastest / Spread heat**. Inside-first: **Per part / All insides / Off**.
- Each closed cut starts at the most convenient point on the travel path (`refineStarts`).
- Travel from the machine origin corner and back is included in the time.
- **Passes**
  - **Fastest**: each item's passes run back to back, **unless whole rounds are quicker**. With a dwell, back to back costs one dwell per item, while rounds cost one per round. The estimator compares both and picks the quicker (`backToBack()`).
  - **As drawn / Spread heat**: whole rounds. Every item in the group once, then all of them again (with a dwell between rounds).
- **Engrave direction and scan** (28 Oct). These are process fields `dir` (`down` top down, the default; `up` bottom up; `fastest`, which starts each island from the end nearer the head) and `uni` (one way: every line left to right, with a return stroke timed at travel speed; otherwise both ways). They appear on the Job page (process → Advanced → Direction, Scan) and in Materials → Advanced. Old `adv.Direction` values are still read (`engraveScan()` in core.js). Each engrave step in the package carries the resolved `direction` and `bidirectional`.
- **Power ratio was removed** (28 Oct). Links are just `dl` cut, then `gl` uncut. Old `ratio` values in stored presets are ignored and left out of the package.
- **Engraving islands**: artwork more than 2 mm apart is engraved separately, so the head doesn't scan across empty space. **Exception:** where islands share the same height, the estimator also times one side-to-side scan across them (engrave speed over the art, travel speed across the gaps) and **uses whichever is faster** (`rasterBands()`). The job package marks each engrave step `scan: "across"` or `"island"`.

### Simulation page
- One Simulate entry point. The "Export job sheet" and "Back to design" buttons were removed.
- Breakdown: processes, then a single **Travel** line (short times in tenths of a second). A "Registration marks (n)" line comes first when there are marks, and a "Dwell between passes" line appears when dwell is used. Engraved area is shown in mm², or m² when large.
- Toggles: travel, direction, start points, cut order, **Thermal map** (lasers only; plotters never show it). Direction arrows, start points and order numbers are large, at a fixed screen size.
- **Zoom/pan**: the same controls as the Job canvas: scroll wheel (at the cursor), the [− · % · +] group (click % for actual size), **Fit**, and the + / − / 0 keys. Drag to pan; double-click also fits.
- **Thermal map**: an explicit 2-D heat diffusion over the job area (about 110 cells), driven by the simulated head position.
  - **Inputs**: rated power × process power × absorption × residual (0.3 cut / 0.45 engrave).
  - **Cooling**: forced airflow, because every laser has robust extraction (h ≈ 50 W/m²K top, 25 W/m²K bottom).
  - **Readouts**: under the head, hottest now, peak and when, beam absorbed %, and a warning past the material limit with the area affected.
  - **Material data comes only from a fixed reference table with sources** (`THERMAL` in core.js: Evonik PLEXIGLAS, EN ISO 10456, ASM Handbook, CDA…). **Not editable**, and values stored on materials are ignored. A material with no match gets no map, never invented numbers.

### Materials (Setup → Materials)
- The library is edited as a working copy; Save / Discard apply or drop the changes.
- **Presets per machine: one tab per machine** that can run the material, since each machine needs its own power settings.
  - Storage: `material.presets[<machineId>]`.
  - A machine without its own list uses the shared starting values `presets.laser` / `presets.plotter` until its tab is changed. The tab says so.
  - "+ Plotter" / "+ Laser" adds the other machine type.
- **Test grid**: process choice is **Cut or Engrave only**. It is centred on the open machine's first preset of that kind (or standard values), and builds the grid job for that machine.
- The library starts empty (final version). New material offers the standard groups (Acrylic, Wood, Board & card, Film & sheet, Metal) because the thermal reference data is matched by group and name. Metal presets (`metalPresets`) and the thermal data for stainless 304/316, mild steel, aluminium and brass are still in core.js.

### Sending / files
- Connection per machine: **Ethernet** (IP/port) or **Save locally**. USB and folder options were removed.
- Send dialog:
  - checks the connection first; a red "Connection failed — …" box with Try again;
  - blocking problems in red, warnings in amber;
  - then a progress bar and "Sent to …".
  - No blue explainer box.
- **One file type everywhere: `.cjob`** (Save, Save to computer, Save locally). It holds the editable job, the material, a machine snapshot, and `run` (the full package: settings in run order, `toolpath` exactly as simulated, the estimate, regMarks and checks).
- The Queue tab mirrors the **machine's own queue** (reorder, remove, start). There is no local "add to queue".

---

## 3. Architecture

```
src/main/        Electron main process
  main.js        window, IPC, store setup + startup migrations, job session (undo/redo), .cjob read/write, deliver()
  preload.js     window.api bridge (contextIsolation, sandbox)
  device.js      HTTP+JSON client for the controller (port 8470), see PROTOCOL.md
  exporters.js   DXF (R12, REGMARKS layer), SVG, PDF/print sheet, job sheet, toolpath(), buildPackage()
  importers/     dxf.js, svg.js, pdf.js (pdfjs-dist, unpacked from asar), hpgl.js, common.js (joinPaths)
  seed.js        empty machines/materials, "Add machine" templates, settings
  store.js       JSON files in %APPDATA%\Pathline\data
src/shared/core.js   UMD (window.CC in pages, require() in main): geometry, ACI colours,
                     estimate() + timeline, orderPaths/refineStarts, rasterSpans/rasterIslands/rasterBands,
                     backToBack (Fastest passes), regMarks, checkJob, headAt, THERMAL/thermalOf/thermalSim,
                     defaultPresets/metalPresets, presetsFor(material, machine)
src/ui/          the four pages (the owner's designs, wired to window.api)
  support.js     the prototype's template runtime: <x-dc>, {{bindings}}, sc-for/sc-if, DCLogic.renderVals(), React global
  app.js         LRC: toast, dialog, sendDialog, confirm, keys, guardNav, contextMenu, clip, ops (editing ops,
                 copyNamer, offAci, pickableIds), textEntity, JobCanvas
  MainDetailed.dc.html        Job page
  SimulationDetailed.dc.html  Simulation page
  MaterialsDetailed.dc.html   Setup → Materials
  MachineSetupDetailed.dc.html Setup → Machines
tools/           selftest.js (npm test), device-emulator.js (npm run emulator), make-icon.js,
                 make-design-package.js + shoot-design.js (the design package, §5)
design/          mock-api.js, index.html ("START HERE"), DESIGN-BRIEF.md, screenshots/ (sources of the design package)
build/           installer icons; build/brand/ = pathline-run icons kept for the HMI
_prototype/      the original UI prototype (reference only)
```

### Template runtime gotchas (support.js)
- Pages are `<x-dc>` templates plus a `class Component extends DCLogic { renderVals() { return {...} } }`. Bindings are `{{name}}`; lists are `<sc-for list="{{x}}" as="o">`; conditionals are `<sc-if value="{{x}}">`.
- Supported events include onClick, onDoubleClick, onContextMenu, onMouseDown, onKeyDown, onBlur and onChange. **onDrop is not supported.**
- A `<sc-for>` inside a `<select>` is dropped by the HTML parser, so build those selects with `React.createElement` and bind the element (see the Group and test-grid selects).
- Anything interactive and complex (SVG scenes, inline inputs with autoFocus) is built with `React.createElement` in renderVals and bound as a value.
- `window.__page` is the page component (handy for tests).

### Data notes
- **Job** (in main's session): `{ machineId, machineType, materialId, processes[], entities[], sheet, regMode, cutOrder{order,inside}, beds, … }`.
  - A process is `{ name, proc|tool, power, speed, f, passes, dwell, dash, dl, gl, out, aci[], adv{}, src: 'preset'|'job', hidden }`.
  - `hidden` is view-only and is stripped when saving to a material.
  - An entity is `{ id, name, type, aci, paths:[{p:[[x,y]…], c:closed}], group, locked, hidden, bed }`, in mm with the origin top-left.
- **Material**: `{ id, g(group), name, t, sw, m:['laser'|'plotter'], notes, locked, presets:{ laser:[], plotter:[], <machineId>:[] }, … }`.
- Startup migrations (main.js, `app.whenReady`):
  - USB/Folder connections become Local;
  - Mark presets are removed;
  - the old session.json is deleted;
  - stored `thermal` is stripped from materials.
- Existing installs keep the machines and materials already in `%APPDATA%\Pathline\data`. Only a fresh install (or a deleted data folder) starts empty.

---

## 4. Run, test, build

Node.js **22+** is needed for `npm install` (on Node 20 the Electron binary download silently fails). Electron 44.7.0, electron-builder 26.17.0.

```bash
npm install
npm start               # run the app
npm test                # self-test: estimator, passes, islands, shared scans, dwell, marks, thermal, importers, exporters, device protocol vs emulator
npm run emulator        # pretend controller on :8470 (--type plotter for a plotter); set the machine IP to 127.0.0.1
npm run dist            # installer + portable exe into dist\ (delete dist first if you get EBUSY)
```

### UI test harness (built into main.js; used for every check in this project)
Environment variables:
- `LRC_SHOT=<dir>`: enables the harness. It uses its own profile, skips the single-instance lock, disables window occlusion, logs the page console, saves screenshots and quits.
- `LRC_PAGE=<page>.dc.html`: the page to open.
- `LRC_DATA_DIR=<dir>`: a throwaway data folder.
- `LRC_STEPS=<file.json>`: `[ { "wait": ms, "js": "expression (await ok)", "shot": "name" } ]`, run in order. They keep running across a `location.reload()` or navigation inside a step.

Example (PowerShell):
```powershell
$env:LRC_SHOT="$PWD\.shots\run1"; $env:LRC_PAGE="SimulationDetailed.dc.html"; $env:LRC_DATA_DIR="$PWD\.shots\data1"; $env:LRC_STEPS="$PWD\.shots\steps.json"; npx electron .
```
`.shots/` holds the step files and screenshots from this project (scratch; safe to delete). `.shots/repro.js` rebuilds the owner's part (rounded outline, slot, three rings with registration marks) and prints the run order for each cut-order mode: `node .shots/repro.js`.

---

## 5. Design package (harmonising the whole design)

The owner wants the whole design harmonised in a design environment. `Pathline-design-handoff.zip` (from the `design-handoff\` folder) contains every page running standalone with sample data, plus `START HERE.html`, `DESIGN-BRIEF.md` (the rules, the owner's decisions and a list of inconsistencies) and `screenshots\`.

```bash
node tools/make-design-package.js
```

```bash
npx electron tools/shoot-design.js
```

- The first command rebuilds `design-handoff\` and the zip from `src\ui` and `design\`. The second opens every standalone page and dialog with no app bridge, fails on page errors, and refreshes `design\screenshots\`. After it, run the first command again so the zip includes the new screenshots.
- `design/mock-api.js` stands in for `window.api` (sample machines, materials, a job with registration marks, and a device queue). `?scenario=empty` shows first run. It does nothing when `window.api` exists, i.e. inside the app.
- **Merging the designed pages back:** copy the returned `src/ui/*.dc.html`, `fonts.css`, any new stylesheet and any `app.js` changes into `src/ui`. Delete the `design/mock-api.js` script line from each page. Then run `npm test`, the screenshot harness on the real pages, and `npm run dist`. Check that every `{{binding}}` and `aria-label` survived.

### HMI package (for building the controller app, "Pathline Run")

`Pathline-HMI-handoff.zip` (from `hmi-handoff\`) is everything another developer or chat needs to build the controller/HMI side:
- `HMI-BRIEF.md`: the system, the Pathline action → request map, how to execute every toolpath step, raster and registration-mark rules, safety, open questions and the acceptance checklist;
- `PROTOCOL.md`;
- real example packages (laser print-and-cut, plotter on two beds) and example responses;
- the emulator, Pathline's client, core.js and exporters as references;
- `tools/check-hmi.js`, a conformance checker. By default it only reads; `--allow-motion` and `--run` exercise the machine.

Sources: `hmi/HMI-BRIEF.md` and `hmi/check-hmi.js`. Rebuild with:

```bash
node tools/make-hmi-package.js
```

The checker passes against the emulator, for both laser and plotter.

## 6. Known gaps / possible next steps

- Not built yet:
  - raster image import, image tracing, node editing (the tools say so when clicked);
  - real machine drivers (the controller implements PROTOCOL.md);
  - code signing.
- The HMI/controller side must implement PROTOCOL.md, including:
  - the queue endpoints;
  - `dwell` steps;
  - `scan: "across"` engrave steps (beam off across the gaps at travel speed).
- The thermal map is approximate (cell averages a few mm across). It deposits heat uniformly along raster rows, including the gaps in shared scans.
- A Setup page is reached only from the Job page's **Setup** menu (by the owner's choice; the Simulation page has no link to it).
- The owner reviews by screenshots of the running app. Show changes working, not just tests.

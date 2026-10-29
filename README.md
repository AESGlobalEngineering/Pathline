# Pathline

Windows desktop app for preparing laser and plotter/router jobs: import drawings, arrange them, set speeds and feeds per colour, simulate with a time estimate, then hand the finished job to the machine's own controller over **Ethernet**, or **save it locally** wherever you choose. The controller runs the actual cut. This app prepares the file and can jog the machine through the controller.

## Install

Download the latest release from [github.com/AESGlobalEngineering/Pathline/releases](https://github.com/AESGlobalEngineering/Pathline/releases):

- `Pathline-Setup-<version>.exe`: installer (Start menu and desktop shortcut, opens `.cjob` files). **It updates itself:** each time Pathline opens it checks for a newer release, downloads it in the background, and installs it when you close the app or click **Restart now**. **Help → Check for updates…** checks on demand.
- `Pathline-<version>-portable.exe`: single file, no install. It can't update itself.

The builds are not code-signed, so Windows SmartScreen will warn the first time ("More info" → "Run anyway").

Problems: **Help → Report a bug…** saves a report (with a screenshot and, if you like, the job) in Pathline's reports folder, `%APPDATA%\Pathline\reports`. Crash reports are saved there automatically. Nothing is sent anywhere, so attach the report folder to a [GitHub issue](https://github.com/AESGlobalEngineering/Pathline/issues).

## Download Pathline Run (for the machine)

**Pathline Run** is the app for the PC or Raspberry Pi next to the laser. It receives jobs from Pathline and runs them on a Trotec or Ruida controller. More in [run/README.md](run/README.md).

| For | Download | Then |
|---|---|---|
| **Windows PC** | **[⬇ Pathline-Run-Setup.exe](https://github.com/AESGlobalEngineering/Pathline/releases/download/pathlinerun/Pathline-Run-Setup.exe)** | Installer, like Pathline's: Start menu and desktop shortcut, and it updates itself |
| Windows, no install | [Pathline-Run-portable.exe](https://github.com/AESGlobalEngineering/Pathline/releases/download/pathlinerun/Pathline-Run-portable.exe) | A single file. It can't update itself. |
| **Raspberry Pi** | The line below, in a terminal on the Pi | Opens full screen at login and updates itself |

```bash
curl -fsSL https://github.com/AESGlobalEngineering/Pathline/releases/download/pathlinerun/install-pi.sh | bash
```

Updates work as in Pathline: it checks when it opens and every 5 minutes, then asks before downloading. All Pathline Run downloads are in the [**pathlinerun**](https://github.com/AESGlobalEngineering/Pathline/releases/tag/pathlinerun) release.

## Releasing a new version

1. Set the new `version` in `package.json` (e.g. 1.3.0), commit, and push to `main`.
2. That's it: the workflow ([.github/workflows/release.yml](.github/workflows/release.yml)) sees a version with no release yet, runs the self-test, builds the installer and publishes release `v1.3.0` with `latest.yml` (about 10 minutes). Installed copies pick it up the next time they open.
3. To redo a release, use **Actions → Release → Run workflow**. It builds the latest commit. (**Re-run** on an old run rebuilds that run's old commit instead.)

Pathline Run is released the same way from `run/package.json`, by [.github/workflows/release-run.yml](.github/workflows/release-run.yml). It replaces the files in the one `pathlinerun` release. That release never becomes the repository's "latest" release, which Pathline's own updater reads.

Pathline comes with no machines or materials. Add your machines under **Setup → Machines** (connection, then **Refresh from machine**), and your materials under **Setup → Materials** (or import a library). Until a machine is added, the Job page lays jobs out on a stand-in bed and can't send.

## What it does

| Page | Backend |
|---|---|
| **Job** | Import **DXF** (lines, arcs, polylines with bulges, splines, ellipses, blocks; loose segments are joined into closed contours), **PDF** vector paths, **SVG** and **HPGL/PLT**. Select, move, scale, nudge, draw lines/rectangles/ellipses/polygons, text to outlines, align, distribute, mirror, rotate, weld, offset, array, **Fill** (copies that fit a bed, sheet or custom area) and **Nest** (plotter beds). Undo/redo, copy/paste, sheet. Right-click menu (colour, ungroup, group, rename, duplicate, rotate, mirror, lock, hide), and colour swatches in the Objects panel, both acting on everything selected. Objects can be renamed in the Objects list (pencil or double-click, then type; Enter saves, Esc cancels), with F2 or from the right-click menu; copies are numbered on from the name ("Ring 2", "Ring 3"…). The **Setup** menu opens Setup → Machines / Materials and the test grid. Snapping to the visible grid and to other objects. The measure and line tools snap to outline corners and edges. Process settings open as a dropdown under each process. Hiding a process (eye icon) fades its objects on the canvas and stops them being selected; they are still sent and simulated. (A process's output on/off is set in Setup → Materials.) Registration marks: switching them on adds a **Registration marks** process, and objects in its colours are the marks (nothing is placed automatically). A job with more marks than the mode uses can't be sent. Processes per colour (ACI); each colour belongs to one process only. Process edits apply to the job straight away and show as a **Job override**; **Save to material** makes them the preset. Before sending or saving a job with overrides, the app asks: **Go back**, **Revert to presets** or **Continue with changes**. Machine panel: live position, jog, home, origin, frame, air/pointer/vacuum. The Queue tab shows the machine's own queue (reorder, remove, start). Send shows a red **Connection failed** box if the machine doesn't answer, then a progress bar until it's sent. Open/save `.cjob`, export DXF/SVG/PDF, print sheet with registration marks, and a job sheet. |
| **Setup → Materials** | Material library stored on disk, including metals (stainless 304 and 316, mild steel, anodised and bare aluminium, brass): presets per machine (one tab per machine, since each machine needs its own power settings; a machine uses the shared starting values for its type until its tab is changed), colour assignment (one process per colour), advanced settings, lock, import/export, and test grid (Cut or Engrave; creates a power × speed grid job for the open machine). |
| **Setup → Machines** | Connection per machine (Ethernet IP/port, or Save locally), connection test, and **Refresh from machine**, which reads bed, speeds and features from the controller. Other settings stay read-only, as in the design. |
| **Simulation** | Toolpath playback from the real job: engraving fills line by line, cuts in order (inner contours first), travel, start points, direction, cut order (scroll to zoom, drag to pan, double-click to reset). **Thermal map** (lasers only): an approximate heat simulation of the sheet from the material, its thickness and the laser power, showing temperature under the head, hottest now, peak, and where the material passes its limit (e.g. acrylic softens at 105 °C). Material properties (density, specific heat, conductivity, beam absorption, limit) come from a fixed reference table with named sources (manufacturer data, ASM Handbook, EN ISO 10456) and can't be edited. Materials without reference data get no map. The sheet is assumed to be cooled by forced airflow from the laser's extraction. Per-process times, travel from and back to the machine origin, cut length. **Cut order**: as drawn, fastest or spread heat. **Cut inside shapes first**: per part, all insides first, or off. Also checks. |

The time estimate uses the machine's max speed and acceleration with corner slowdown (laser vectors), scan-line timing with overscan (engraving), and tool up/down, tool changes and conveyor feeds (plotters). It's sent with every job.

Machines and materials are kept in `%APPDATA%\Pathline\data` (copied over once from the old `Laser & Router Control` folder the first time Pathline runs). Jobs are only kept when you save them: closing the app closes it completely, and it opens with a new, clean job (or the `.cjob` you opened it with).

Run order: registration marks are read first (the head visits each mark, in the order that ends nearest where the work starts), then engraving, then cutting. Engraving is split into islands (artwork more than 2 mm apart). Where islands sit at the same height, the app also times one side-to-side scan across them (engrave speed over the artwork, travel speed across the gaps) and uses whichever is quicker. Laser processes can have a **dwell between passes**: the head waits that long before each later pass. It shows on the Job page once a process has more than one pass, and in the material's advanced settings. Controls for machine features a machine doesn't have (rotary, auto-focus, camera, conveyor, vacuum…) are hidden, not greyed out. Passes depend on the cut order:

- **Fastest**: each item's passes run straight after each other (engrave island 1 twice, then island 2 twice; cut hole 1 twice, then hole 2 twice), unless whole rounds are quicker. With a dwell, that means waiting once per round instead of once per item.
- **As drawn** and **Spread heat**: passes repeat a whole group. All the inside shapes run once, then all of them again, then the outlines once, then again. With **Per part**, that happens part by part.

## The controller side

Ethernet jobs, status and jogging use a small HTTP/JSON protocol, described in **[PROTOCOL.md](PROTOCOL.md)**. **[Pathline Run](run/README.md)** (in `run/`) implements it for Trotec and Ruida lasers, on a Raspberry Pi or a Windows PC, and converts jobs into controller code. For a pretend machine, use the emulator:

```bash
npm run emulator
```

That starts a pretend Trotec on port 8470 (`--type plotter` for a plotter). In the app, set the machine's IP to `127.0.0.1` on the Machines page. Received jobs are written to `received-jobs\`. Open `http://localhost:8470` to watch it.

**Save locally**, **Save** and **Save to computer** all write the same single `.cjob` file wherever you choose. It holds the editable job, the material and machine, and the full run: settings in run order, the toolpath as simulated, and the time estimate. See [PROTOCOL.md](PROTOCOL.md).

## Develop

Needs Node.js 22 or newer for `npm install`. On Node 20 the Electron download step silently fails.

```bash
npm install
```

```bash
npm start
```

```bash
npm test
```

```bash
npm run dist
```

`npm test` checks the estimator, every importer, the DXF round trip, and the full device protocol against the emulator. `npm run dist` builds the installer and the portable `.exe` into `dist\`.

Layout:

- `src/main/`: Electron main process: data store, importers (`importers/`), exporters, device link, IPC
- `src/shared/core.js`: geometry, colour index, estimator and simulation timeline (used by both sides)
- `src/ui/`: the four pages (your original designs, wired to `window.api`), `app.js` (job canvas, editing operations, dialogs)
- `tools/`: device emulator, self-test, icon generator
- `_prototype/`: the original UI prototype, untouched

## Not done yet

- Raster image import/engraving, image tracing and node editing (the tools say so when clicked)
- Real machine drivers: the app speaks the protocol above, and the controller device does the machine-specific part
- Code signing for the installer

## Brand

The app icon and logo come from the Pathline brand package (build\icon.ico, src\ui\brand\). The **Pathline Run** icon (build\brand\pathline-run.*) is kept for the controller/HMI app.

## Design package

`Pathline-design-handoff.zip` holds every screen running on its own with sample data, for harmonising the design in a design tool. Open `START HERE.html` and read `DESIGN-BRIEF.md`. Rebuild it with `node tools/make-design-package.js`, and refresh its screenshots with `npx electron tools/shoot-design.js`.

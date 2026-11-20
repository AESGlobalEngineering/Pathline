# Pathline Run

The machine-side HMI for **Pathline**. It runs on the PC or Raspberry Pi next to the laser and receives jobs from Pathline over Ethernet (the protocol in [../PROTOCOL.md](../PROTOCOL.md), port 8470). It **converts** each job into code for the machine's controller (**Trotec** or **Ruida**) and runs it, with a touchscreen UI built from the HMI design ([../hmi/project/HMI.dc.html](../hmi/project/HMI.dc.html)).

```
Pathline (design PC) ──HTTP/JSON──▶ Pathline Run ──USB serial──▶ Trotec (SF packets)
                                                └─UDP 50200───▶ Ruida (.rd stream)
```

## Install

Pathline Run installs and updates like Pathline.

| For | Download | Then |
|---|---|---|
| **Windows PC** | **[⬇ Pathline-Run-Setup.exe](https://github.com/AESGlobalEngineering/Pathline/releases/download/pathlinerun/Pathline-Run-Setup.exe)** | Run the installer. It adds a Start menu entry and a desktop shortcut, and **Pathline Run updates itself**. |
| Windows, no install | [Pathline-Run-portable.exe](https://github.com/AESGlobalEngineering/Pathline/releases/download/pathlinerun/Pathline-Run-portable.exe) | A single file. It can't update itself. |
| **Raspberry Pi** | The line below, on a fresh Raspberry Pi OS Lite (64-bit) | Makes the Pi a Pathline Run station: switched on, it goes straight into Pathline Run full screen, and **updates itself** |

```bash
curl -fsSL https://github.com/AESGlobalEngineering/Pathline/releases/download/pathlinerun/install-pi.sh | sudo bash
```

These links always give the newest version. They all live in one release, [**pathlinerun**](https://github.com/AESGlobalEngineering/Pathline/releases/tag/pathlinerun), titled with the current version. The builds aren't code-signed, so Windows SmartScreen warns the first time ("More info" → "Run anyway"). The first time Pathline Run starts, Windows Firewall asks about it: allow private networks, so Pathline can connect.

**Raspberry Pi:** a Pi 5 (or a Pi 4) with a touch screen, on Raspberry Pi OS Lite (64-bit), Bookworm or newer. Raspberry Pi's 10" Touch Display 2 (Pi 5 only) is found by itself and shown 1.5 times bigger. After the setup line and a restart, the Pi boots straight into Pathline Run full screen (no desktop, no login), starts it again if it ever stops, keeps the screen on, and is safe to switch off at the wall. Pathline Run brings its own on-screen keyboard there. The whole guide, in plain words, with turned screens and what the setup changes: [deploy/pi/README.md](deploy/pi/README.md). There's also an x64 AppImage for Linux PCs (`Pathline-Run-x86_64.AppImage`).

**Then:** Pathline Run opens on **Setup → Add a machine**. Name the machine, choose Trotec or Ruida and how it's connected, check the bed size, then **Add machine**. (☰ → Remove machine… removes it again, after two checks.) In Pathline, **Setup → Machines → Add machine** → Ethernet, the Pathline Run computer's IP address, port 8470.

Settings, the queue and received jobs are kept in `%APPDATA%\Pathline Run\data` (Windows) or `/home/pathline/.config/Pathline Run/data` (Pi), so updates and reinstalls keep them. Pathline Run 0.1.0's data is brought across the first time.

## Updates

The same as Pathline. Pathline Run checks for a newer release when it opens and every minute while it runs. When it finds one it **asks first**: **Later** or **Download and install**. A version you said Later to isn't offered again until the next start. The download shows its progress and can be hidden. When it has finished, **Restart and install** closes Pathline Run, installs the update and opens it again. Queued jobs and settings are kept. It can't restart while a job is running. After the update, Pathline Run shows **what's new**. **☰ → Check for updates…** checks on demand, and **☰ → What's new** lists every version.

Only the machine's own screen offers updates. Browsers on other PCs viewing the same page (Pathline's **Open HMI**) don't. The portable exe and copies run from source don't update themselves.

Updates come from the `pathlinerun` release (a generic feed, set in `build.publish` in `package.json`), so Pathline's own releases never mix in.

## Releasing a new version

1. Set the new `version` in `run/package.json` and add an entry to `src/changelog.js`. Commit and push to `main`.
2. That's it. The workflow ([../.github/workflows/release-run.yml](../.github/workflows/release-run.yml)) runs the self-test. It builds the Windows installer and portable exe on Windows, and the AppImages on Linux. It replaces the files in the `pathlinerun` release with the new version's, and installed copies read them there. They offer the update within a minute, and download only the parts of the installer that changed.
3. To redo a release, use **Actions → Release Pathline Run → Run workflow**.

## Develop

Node.js 22 for `npm install` (as for Pathline: Electron's download step needs it).

```bash
cd run
npm install
npm run sim
```

That opens Pathline Run in its window with a **simulated** controller. In Pathline, add a machine with IP `127.0.0.1`, port 8470, and send a job. Or use **Import** on the Queue page to load a `.cjob`. The simulator still converts every job for the configured controller, so conversion problems show up, then replays the estimated times 20× faster. Toggle the simulated lid on the Jog page.

`npm start` runs it with the real controller. `npm run server` runs only the server, with no window, and the screen is at `http://localhost:8470/`. `npm test` runs the self-test. `npm run dist` builds the Windows installer into `dist\`. `npm run dist:pi` builds the Pi AppImage (on Linux).

## Convert without a machine

```bash
node tools/convert.js job.cjob --ctrl ruida --txt
```

```bash
node tools/convert.js job.cjob --ctrl trotec --txt
```

```bash
node tools/decode.js job.rd
```

`convert` takes a `.cjob` or a job package JSON and writes `job.rd` (Ruida, swizzled with magic 0x88, ready for a USB stick or RDWorks/LightBurn) or `job.sf` (Trotec data-lane stream). `--txt` adds a readable listing. Options: `--origin tl|tr|bl|br` and `--magic` for Ruida, `--bed 900x600`. The Queue page has the same as **Save .rd file / Save Trotec stream** and **Code listing**.

## How a job is converted

`src/job/plan.js` turns the package's `toolpath` (already in run order, one step per pass) into steps in bed millimetres. It cuts links (`dash`) into beam-on runs and fills engravings even-odd on horizontal scan lines. Then:

| | Trotec (`src/ctrl/trotec/`) | Ruida (`src/ctrl/ruida/`) |
|---|---|---|
| Transport | USB CDC serial or raw TCP, text handshake (`pg0` … `TX;`), then SF packets with CRC-16/ARC, one in flight, resent on buffer-full | UDP to port 50200 from 40200, 16-bit checksum + swizzled bytes, ACK `0xCC` per packet |
| Units | 10.125 µm position units, plus the factory mechanical offset (14.833, 9.528 mm) | µm, X/Y mirrored for the machine's origin corner (default top right) |
| Power, speed | `DEFINEPOWERLEVELS {0, 0, P}` + `SELECTPOWERLEVEL`, `CutVelocity` = mm/s ÷ 0.010125 | Layer settings: `C9 02` speed, `C6 01/02` min/max power |
| Cuts | Level 2 once per run; curves as `CUBIC_BEZIER_ABSOLUTE` in 45° pieces (arcs fitted to the polyline, `arcs.js`) and straight segments as `MOVEXY`, one `COMMIT` per run (at least every 200 commands), as Ruby does. `trotec.arcs: false` in the config sends segments only | `MOVE_ABS` + `CUT_ABS` |
| Engraving | `MOVEX±` + b/w switch table per line, 10 mm overscan, pitch rounded to 6 µm | Work mode 3 + `CUT_REL_X` / `MOVE_REL_X` runs per line, overscan from speed and acceleration |
| Settings used | power, speed, frequency, air, power correction, path planning, links, extended overshoot | power, speed, air, power correction (as min power), links, extended overshoot |
| Dwell | Host waits between streams | Host waits between streams (left out of a saved `.rd`) |
| Plotters | — | Ruida only. Each tool (T1–T4) on a controller output (1–4, Setup → Tools): its layer sets that output to 100 % and the others to 0 %. Tool down/up times as the laser on/off delays, perforation as cut/move, conveyor feeds as U-axis moves from where the conveyor stopped |
| Progress | Progress markers (`D2`) after each step | Time against Pathline's estimate |

`adv` settings not listed are ignored: Source, Engrave mode, High quality, Relief, Dithering, Process gas, Z-offset. Dithering has no effect anyway: Pathline only sends vector fills so far.

Sources: the Trotec protocol comes from our own decompile and captures (`TROTEC_PROTOCOL.md`, kept outside the repository). For Ruida: the [EduTech wiki Ruida page](https://edutechwiki.unige.ch/en/Ruida) and [MeerK40t's RDJob writer](https://github.com/meerk40t/meerk40t/blob/main/meerk40t/ruida/rdjob.py).

## Verified, and not yet

`npm test` checks the Trotec encoder against bytes captured from Ruby: the worked packets, the 20 × 20 mm square cut (positions, velocities, power levels), and the 20 × 20 mm 500 DPI engraving (417 lines, 988/1975-unit switch table, 3951-unit lines). It checks the Ruida encoder against the wiki's example bytes. It converts the example jobs both ways, runs the HTTP protocol against the simulator, and runs Pathline's own `check-hmi.js --allow-motion --run` when `hmi-handoff/` exists (`node tools/make-hmi-package.js` in the Pathline folder).

**Not yet tried on hardware.** Before cutting material:

- **Trotec:** jog, home and frame first. Then cut a 20 mm square at low power and compare with Ruby. Engraving (`ACTIVATEPPIMODE` 5 at every DPI, which power level the switch table fires) is copied from one capture at 500 DPI.
- **Ruida:** the header, the layer blocks and the work-mode-3 raster are from public notes and haven't been tried on a controller. Choose the controller model in Setup → Machine. The swizzle magic is also detected from the controller's first reply. Check the checksum, status bits and rapid-move option bytes. The origin corner is a setting. Run a small square at low power first, or save the `.rd` file and open it in RDWorks/LightBurn to check it.
- **Ruida plotters:** tools on outputs 1–4 and the conveyor on the U axis are the laser-family command set used for tools. That's the likely wiring for a plotter on a Ruida laser-family board, but it's unconfirmed. RDD6584 knife controllers use their own format (`src/ctrl/ruida/knife.js`), copied from VCutWorks captures on a YC-1610.
- **Head camera (Trotec):** built and tested against the simulated camera only. See below.
- **Not supported:** test fire, auto-focus, Z, rotary, Trotec plotters. Pathline is told through `GET /machine` features, so it hides those controls.

## Head camera (Trotec print and cut)

The Trotec's camera is an Allied Vision **Alvium 1800 U-500c** on the head. It plugs into the **computer** by USB 3, not into the laser.

1. Install Allied Vision's **Vimba X** (free, from alliedvision.com) on the PC or the Pi (64-bit Raspberry Pi OS). Pathline Run calls its `VmbC` library through `koffi`, so nothing is compiled.
2. Close Ruby and JobDispatcher: only one program can use the camera.
3. **Setup → Camera:** turn the camera on and save, then:
   - The offset calibration and the checkerboard start from **where the laser head is**, like an anchored job; camera calibration starts from **where the camera is** (it needs no offset). The head goes back where it started afterwards.
   - **1 · Camera calibration:** lay the small checkerboard (10 mm squares, size in Setup) flat, at any angle, and jog the head until the board fills the camera view. Its corners give the pixel size, independent of the machine's own accuracy, and show how much the lens bends straight lines. A few mm of head movement then shows which way the picture is turned.
   - **2 · Offset calibration (cut check):** jog the laser over scrap. It cuts a small 3 mm mark there (power and speed are in Setup), and the camera finds it and sets the offset. One more picture then checks it and reports how far off the cut still is.
   - **Checkerboard:** lay the 50 mm board anywhere, at any angle. Jog the laser head over its top-left inner corner, then **Calibrate bed**. The board's position and angle are fitted out, and the rest is saved as a bed map applied to every job. **Check bed** measures again with the map on.
4. Jobs with registration marks: the camera reads each mark (re-centring if it's more than 1 mm out) and fits Pathline's mode. `pos` is shift + rotation, `linear` is affine, `nonlinear` is triangles. The job is then moved onto the marks. A mark not found near where it's expected doesn't stop the job: it waits with the beam off (`status.markWait`), the screen opens Jog with the camera picture, and jogging is allowed. `POST /api/v1/marks/accept` (the Accept button) has the camera look again from where it now is, taking the dot nearest the crosshair; Stop ends the job. Dots are found in the camera's full picture (the whole sensor).
5. A job that engraves also checks how far its sheet lies turned from the job as drawn: engraving lines run along the machine's X, so a turned sheet gets them at that angle across the parts. Up to 5° runs. Between 5° and 10° the job waits with the beam off (`status.angleWait`: `{ angle, text }`) and the screen asks: `POST /api/v1/marks/angle-ok` (Continue) runs it, Stop ends it. More than 10° stops before anything is cut. The limits are `placementAngle: { ask: 5, stop: 10 }` in the config.
6. A mark needn't be printed. Each `inspect` step's `kind` (PROTOCOL.md) can be:
   - `"dot"` (the default): a printed dark dot. Where none is found, Run looks for a light one.
   - `"hole"`: a hole in the plate with white under it.
   - `"corner"`: the plate's corner on white, with `toward: [±1, ±1]`, which way the plate lies from the corner.

   Holes use `detect.findDots(…, { light: true })`. Corners use `detect.findPlateCorner`: the two straight edges, each found across lines a few tenths of a mm apart and fitted straight, and where they meet. A job with corners is fitted rigid (shift and turn only), or from one corner's position and edge angle (`fit.pose`). `status.markWait.kind` tells the jog dialog what to look for.

   Rounded corners carry `r`, and `at` is where the straight edges meet. `Vision.cornerAim` puts the camera up to `r` inside the plate (less if an edge would leave the picture). The finder starts its lines `r` + 1 mm past the expected corner and drops points within `r` + 0.5 mm of the fitted one. When it can't see 3.5 mm of straight edge past the rounding, `status.markWait.why` says so.

Everything is in `src/vision/`: `camera.js` (Vimba X and the simulated camera), `detect.js` (dots and checkerboard corners, plain JS), `fit.js` (the corrections from `TROTEC_PROTOCOL.md` §7.5 and the bed map) and `vision.js` (the workflows). `npm test` runs them all end to end on the simulated camera with `--sim`.

## Pathline Monitor (the phone app)

From 0.7.13, Pathline Run reports this machine's status to the workshop's Pathline Monitor server, so phones see it from anywhere (`monitor/README.md`).

1. In the Monitor app: **Settings → Add a machine**. It shows the server's address and a code that works once, for 10 minutes.
2. In Pathline Run: **Setup → Pathline Monitor**. Type the address and the code, and press **Connect**.

Run then sends what `GET /api/v1/monitor` answers to the server over https: straight away when anything changes, every 5 s while a job runs, every 10 s otherwise. The panel shows when it last sent, or since when it can't reach the server. Reporting is one way: Run reads back only its key (once) and each report's status code, never instructions, and it runs on its own timer, apart from the machine. A machine removed in the app shows "Removed in Pathline Monitor" and stops. **Disconnect** forgets the key. The key is kept in `data/monitor-report.json`, not in the config. Details: *Reporting* in `PROTOCOL.md`. Once connected, ☰ → **Pathline Monitor on a phone** shows the server's address as a QR code.

**Pulls (from 0.7.21, with Pathline Monitor 0.6):** someone with Monitor's pull token can ask this machine for a day's diagnostics log, a job's drawings, the camera's pictures of its marks, its run records, the head drawing fit and bed maps, its settings (never the key) or its health (temperature and a Pi's power warnings among them). Run listens over its own outgoing connection, reads what's asked and sends it; Monitor passes it on and keeps nothing. An ask can only ever make Run read one of those things: it can't change a setting or touch the machine or a job. Each ask is in the diagnostics log, and the switch **Let Pathline Monitor ask for logs, drawings and camera pictures** in Setup → Pathline Monitor turns it off (on the machine's own screen only). Details: *Pulls* in `PROTOCOL.md`; the tool that pulls is `monitor/tools/pull.js`.

## Layout

- `src/server.js`: HTTP server, Pathline protocol (`/api/v1`) and the screen's own calls (`/api/local`)
- `src/machine.js`: link, status, manual control with the safety rules, and the job runner
- `src/job/`: package checks and the controller-neutral plan
- `src/ctrl/trotec`, `src/ctrl/ruida`: converters, links and decoders. `src/ctrl/sim.js`: simulated link
- `src/vision/`: the Trotec's head camera (print and cut, calibration, checkerboard bed map)
- `src/monitor.js`, `src/report.js`, `src/pull.js`: the status for watchers (`GET /api/v1/monitor`, `/events`), its report out to Pathline Monitor, and answering Monitor's asks for logs and pictures
- `electron/`: the app window and updates (`electron-updater`, as in Pathline). `src/changelog.js`: What's new
- `ui/`: touchscreen page (plain JS). `tools/`: convert, decode, self-test. `deploy/pi/`: the Raspberry Pi station (`install-pi.sh`, and its guide `README.md`). `ui/keyboard.js`: the kiosk's on-screen keyboard. `src/safefile.js`: saving files so a power cut can't leave them half written

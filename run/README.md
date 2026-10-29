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
| **Raspberry Pi** | The line below, in a terminal on the Pi | Installs the AppImage, which opens full screen at login and updates itself |

```bash
curl -fsSL https://github.com/AESGlobalEngineering/Pathline/releases/download/pathlinerun/install-pi.sh | bash
```

These links always give the newest version. They all live in one release, [**pathlinerun**](https://github.com/AESGlobalEngineering/Pathline/releases/tag/pathlinerun), titled with the current version. The builds aren't code-signed, so Windows SmartScreen warns the first time ("More info" → "Run anyway"). The first time Pathline Run starts, Windows Firewall asks about it: allow private networks, so Pathline can connect.

**Raspberry Pi:** Raspberry Pi OS Bookworm 64-bit with desktop, on a Pi 4 or 5 with a touchscreen. The script puts `Pathline-Run.AppImage` in `~/Applications`, adds it to the menu, and starts it full screen (`--kiosk`) at login. It also installs `libfuse2` (AppImages need it) and allows the USB port (`/dev/ttyACM0` for a Trotec). Restart the Pi afterwards. There's also an x64 AppImage for Linux PCs (`Pathline-Run-x86_64.AppImage`).

**Then:** Pathline Run opens on **Setup → Add a machine**. Name the machine, choose Trotec or Ruida and how it's connected, check the bed size, then **Add machine**. (☰ → Remove machine… removes it again, after two checks.) In Pathline, **Setup → Machines → Add machine** → Ethernet, the Pathline Run computer's IP address, port 8470.

Settings, the queue and received jobs are kept in `%APPDATA%\Pathline Run\data` (Windows) or `~/.config/Pathline Run/data` (Pi), so updates and reinstalls keep them. Pathline Run 0.1.0's data is brought across the first time.

## Updates

The same as Pathline. Pathline Run checks for a newer release when it opens and every 5 minutes while it runs. When it finds one it **asks first**: **Later** or **Download and install**. A version you said Later to isn't offered again until the next start. The download shows its progress and can be hidden. When it has finished, **Restart and install** closes Pathline Run, installs the update and opens it again. Queued jobs and settings are kept. It can't restart while a job is running. After the update, Pathline Run shows **what's new**. **☰ → Check for updates…** checks on demand, and **☰ → What's new** lists every version.

Only the machine's own screen offers updates. Browsers on other PCs viewing the same page (Pathline's **Open HMI**) don't. The portable exe and copies run from source don't update themselves.

Updates come from the `pathlinerun` release (a generic feed, set in `build.publish` in `package.json`), so Pathline's own releases never mix in.

## Releasing a new version

1. Set the new `version` in `run/package.json` and add an entry to `src/changelog.js`. Commit and push to `main`.
2. That's it. The workflow ([../.github/workflows/release-run.yml](../.github/workflows/release-run.yml)) runs the self-test. It builds the Windows installer and portable exe on Windows, and the AppImages on Linux. It replaces the files in the `pathlinerun` release with the new version's, and installed copies read them there. They offer the update within 5 minutes.
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
| Cuts | `MOVEXY` per segment at level 2, as Ruby does | `MOVE_ABS` + `CUT_ABS` |
| Engraving | `MOVEX±` + b/w switch table per line, 10 mm overscan, pitch rounded to 6 µm | Work mode 3 + `CUT_REL_X` / `MOVE_REL_X` runs per line, overscan from speed and acceleration |
| Settings used | power, speed, frequency, air, power correction, path planning, links, extended overshoot | power, speed, air, power correction (as min power), links, extended overshoot |
| Dwell | Host waits between streams | Host waits between streams (left out of a saved `.rd`) |
| Progress | Progress markers (`D2`) after each step | Time against Pathline's estimate |

`adv` settings not listed are ignored: Source, Engrave mode, High quality, Relief, Dithering, Process gas, Z-offset. Dithering has no effect anyway: Pathline only sends vector fills so far.

Sources: the Trotec protocol comes from our own decompile and captures (`TROTEC_PROTOCOL.md`, kept outside the repository). For Ruida: the [EduTech wiki Ruida page](https://edutechwiki.unige.ch/en/Ruida) and [MeerK40t's RDJob writer](https://github.com/meerk40t/meerk40t/blob/main/meerk40t/ruida/rdjob.py).

## Verified, and not yet

`npm test` checks the Trotec encoder against bytes captured from Ruby: the worked packets, the 20 × 20 mm square cut (positions, velocities, power levels), and the 20 × 20 mm 500 DPI engraving (417 lines, 988/1975-unit switch table, 3951-unit lines). It checks the Ruida encoder against the wiki's example bytes. It converts the example jobs both ways, runs the HTTP protocol against the simulator, and runs Pathline's own `check-hmi.js --allow-motion --run` when `hmi-handoff/` exists (`node tools/make-hmi-package.js` in the Pathline folder).

**Not yet tried on hardware.** Before cutting material:

- **Trotec:** jog, home and frame first. Then cut a 20 mm square at low power and compare with Ruby. Engraving (`ACTIVATEPPIMODE` 5 at every DPI, which power level the switch table fires) is copied from one capture at 500 DPI.
- **Ruida:** the header, the layer blocks and the work-mode-3 raster are from public notes and haven't been tried on a controller. Check the swizzle magic for your card (Setup → Controller), and the checksum, status bits and rapid-move option bytes. The origin corner is a setting. Run a small square at low power first, or save the `.rd` file and open it in RDWorks/LightBurn to check it.
- **Not supported:** registration marks (no camera: jobs wait, or run uncorrected if Setup → Jobs → Registration marks is "Skip"), test fire, auto-focus, Z, rotary, plotters. Pathline is told through `GET /machine` features, so it hides those controls.

## Layout

- `src/server.js`: HTTP server, Pathline protocol (`/api/v1`) and the screen's own calls (`/api/local`)
- `src/machine.js`: link, status, manual control with the safety rules, and the job runner
- `src/job/`: package checks and the controller-neutral plan
- `src/ctrl/trotec`, `src/ctrl/ruida`: converters, links and decoders. `src/ctrl/sim.js`: simulated link
- `electron/`: the app window and updates (`electron-updater`, as in Pathline). `src/changelog.js`: What's new
- `ui/`: touchscreen page (plain JS). `tools/`: convert, decode, self-test. `deploy/pi/install-pi.sh`: Raspberry Pi install

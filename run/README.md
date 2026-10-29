# Pathline Run

The machine-side HMI for **Pathline**. It runs on the PC or Raspberry Pi next to the laser and receives jobs from Pathline over Ethernet (the protocol in [../PROTOCOL.md](../PROTOCOL.md), port 8470). It **converts** each job into code for the machine's controller (**Trotec** or **Ruida**) and runs it, with a touchscreen UI built from the HMI design ([../hmi/project/HMI.dc.html](../hmi/project/HMI.dc.html)).

```
Pathline (design PC) ──HTTP/JSON──▶ Pathline Run ──USB serial──▶ Trotec (SF packets)
                                                └─UDP 50200───▶ Ruida (.rd stream)
```

Plain Node.js (18 or newer), no build step. The only dependency is `serialport` for Trotec USB, and it's optional: Ruida, simulation and conversion work without it.

## Try it on Windows

```bash
cd run
npm install
npm run sim
```

That starts Pathline Run with a **simulated** controller and opens `http://localhost:8470/`. In Pathline, add a machine with IP `127.0.0.1`, port 8470, and send a job. Or use **Import** on the Queue page to load a `.cjob`. The simulator still converts every job for the configured controller, so conversion problems show up, then replays the estimated times 20× faster. Toggle the simulated lid on the Jog page.

For the real machine: `npm start`, then **Setup** → Machine → controller and connection → **Save to machine**.

Settings, the queue and received jobs are kept in `%APPDATA%\Pathline Run` (Windows) or `~/.config/pathline-run` (Pi). Use `--data <folder>` to keep them somewhere else.

## Raspberry Pi

Raspberry Pi OS Bookworm (64-bit, desktop), Pi 4 or 5 with a touchscreen. Copy or clone the repository onto the Pi, then:

```bash
cd Pathline/run
bash deploy/pi/install.sh
```

The script installs Node.js 22 if needed and runs `npm install`. It adds a `pathline-run` systemd service, so the server starts at boot, and adds your user to `dialout` for the USB port. It also opens Chromium full screen on the touchscreen at login. Logs: `journalctl -u pathline-run -f`. Trotec over USB shows up as `/dev/ttyACM0`.

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
- `ui/`: touchscreen page (plain JS). `tools/`: convert, decode, self-test. `deploy/pi/`: Raspberry Pi install

# Handover: Pathline Run session, 18 Nov 2026

For the next assistant taking over this chat. Read this first, then `HANDOFF.md` (Prepare), `run/README.md` (Run) and `PROTOCOL.md` (the job package).

## 1. Names: get these right

- **Trotec Q500**: the laser, a CO2 machine with a head camera. Run advertises it on the network as "Trotec Q-500".
- **Ruby**: Trotec's *own* laser software. It is **not** the machine. It must be closed for Run to connect ("are Ruby and JobDispatcher closed?"). Comments such as "Ruby's workflow" in `vision.js` mean Trotec's software.
- **Pathline Run**: `run/`, the Electron app on the shop PC that drives the Q500.
- **Pathline Prepare**: the repo root. It designs jobs and sends JSON packages to Run.
- **Pathline Monitor**: `monitor/`, the phone and server app for watching jobs remotely.

The owner corrected me for calling the laser "Ruby". Don't.

## 2. Standing rules from the owner

- **Local commits only, no pushing.** The owner pushes with GitHub Desktop. `main` is 20 commits ahead of `origin/main`.
- **Never restart Run while a job is running.** Check first that `GET http://127.0.0.1:8470/api/v1/status` shows `state: idle` with no `job`.
- **Speed matters.** The owner has twice asked to cancel or skip the full self-test (about 10 minutes). Run quick, targeted checks instead and say what wasn't run.
- Explain in plain words. Don't give them commands to run themselves.

## 3. Where things are

| What | Where |
|---|---|
| Repo | `C:\Users\Machine2\Documents\GitHub\Pathline` |
| git (no credentials) | `C:\Users\Machine2\AppData\Local\GitHubDesktop\app-3.6.10\resources\app\git\cmd\git.exe` |
| Installed Run (unpacked, edit-in-place) | `C:\Users\Machine2\Downloads\Pathline Run\resources\app\` (`src\`, `ui\`); exe `C:\Users\Machine2\Downloads\Pathline Run\Pathline Run.exe` |
| Installed Prepare | `C:\Users\Machine2\Downloads\Pathline\Pathline Prepare\` (now 1.6.16, built elsewhere) |
| Run data | `C:\Users\Machine2\AppData\Roaming\Pathline Run\data\` (`config.json`, `queue.json`, `history.json`) |
| Run logs | `…\data\logs\run-YYYY-MM-DD.log` |
| Last job's mark photos | `…\data\marks\markN[-hand][2].bin.gz` + `.json` (see §6) |
| Per-run records | `…\data\runs\<id>-<time>.json` (placement, marks expected and found, timeline) |
| Run API | `http://127.0.0.1:8470/api/v1/…` (status, jobs, start, stop, marks/accept, marks/angle-ok) and `/api/local/…` (log, logs/day?d=, jobs/<id>/package, config, changelog, state) |
| Run self-test | in `run/`: `node tools/selftest.js` (about 10 min; prints "All passed") |
| Sim preview | `.claude/launch.json` → `run-sim` (port 8491, `--sim`) |

## 4. How to install a Run change

Run is edited in place; there's no installer step.

1. Check the Q500 is idle (§2).
2. Check the installed files match the previous commit, byte for byte. In PowerShell 5, `git show` piped through PowerShell mangles UTF-8, so redirect through `cmd /c "git show <commit>:run/<file> > out"`.
3. Back up the files you'll replace to `C:\Users\Machine2\Downloads\Pathline-Run-before-<name>-<HHmm>`.
4. Stop the `Pathline Run` processes, copy the new files in, and start the exe.
5. Wait about 30 s for `link: online`. The first connect usually fails once, then connects.

## 5. What was done this session (all committed locally, all installed)

| Commit | What |
|---|---|
| `324795d` | Placement-angle check for print and cut with engraving. Up to 5° runs, 5–10° asks (Continue or Stop: `status.angleWait`, `POST /marks/angle-ok`), over 10° stops. Config `placementAngle`. |
| `15af455` | Registration mark kinds on `inspect` steps: `kind: "dot"` (default; falls back to finding a light hole), `"hole"` (light disc in steel), `"corner"` (a plate corner on white, with `toward: [±1, ±1]`). Corners fit rigid; one corner uses `fit.pose` with its edge angle. Sim scene has a steel plate with holes. Docs: `PROTOCOL.md`, `HANDOFF-prepare-mark-kinds.md`. |
| `ac91c1c` | Rounded corners. A corner step's `r` is the radius; `at` is where the straight edges meet. `Vision.cornerAim` looks up to `r` inside the plate, and the finder fits edges only clear of the arc. If the camera can't see 3.5 mm of straight edge, `status.markWait.why` says so. Matches Prepare 1.6.16 (corners come from a box drawn in the mark colour, ids `<box>-tl` etc.). |
| `02ba703` | Prepare handover wording: the Q500, not "Ruby". |
| `bf764da` | **Corner finder works through lamp glare** (fix for J0111). Edge steps are taken whichever way they go, edges are fitted by consensus within 0.1 mm, corners more than 3° off square are rejected, and failures give the real reason. Checked on J0111's three real photos (they agree within 0.14 mm) and the sim trials. **The full self-test has NOT been run on `bf764da`.** |

The main code is in `run/src/vision/detect.js` (`findDots` with `light`, `findPlateCorner`), `vision.js` (`find`, `measure` with `aim`, `cornerAim`, `readMarks`), `fit.js` (`pose`) and `job/validate.js` (checks on `kind`, `toward` and `r`).

## 6. Mark photo format

`markN.bin.gz` is gzipped: a 4-byte header (width and height as 16-bit big-endian), then grey bytes. It's half size (1296 × 972), so use twice `pixel`. Camera matrix from `config.json`:

    vision.matrix = [-0.00013118357, 0.01316835, -0.013049282, -0.00014486898]   (mm per full-res px)
    image right (u) = bed −Y, image down (v) = bed +X

To read a frame, `require` `run/src/vision/detect.js` from a scratch script and call `findPlateCorner(img, { M: matrix×2, toward, r, c0, why: {} })` or `findDots`.

## 7. Open items

1. **Re-run J0111** ("Multicom classic trim trim etching v1", plate corners, `r` 2, 98.8 × 314 mm plate) with the glare fix, and check the etch against the plate edges. It was stopped while waiting for mark 1.
2. **Run the full self-test on `bf764da`** when there's time.
3. **Real-steel unknowns:**
   - **Lamp glare** can make the steel brighter than the white background in places. This is handled now, but only proven on one plate.
   - **Shadows.** The plate's thickness may move every mark by 0.1–0.4 mm.
   - **Plate edges.** Sheared edges carry a burr. J0111's corner measured 1.1° off square across all three frames; it isn't known yet whether that's the plate or the camera.
4. **Dot-size reading is wrong.** Run's dot finder under-reads printed dots: J0106's 5.8 mm dots read 4.1–4.6 mm, and mark 2 read 1.2 mm. That gives false warnings like "marks measure 31 % smaller than printed / sheet further from the camera". The positions are fine. The earlier diagnosis of a "6–11 % height mismatch" was probably the same measuring error. Fix: measure size by fitting a circle to the dot's edge (the J0106 analysis did this).
5. **Unanswered: J0106 came out about 1° turned.** The marks read 0.83–0.97° clockwise and Run followed them correctly. Still unanswered: was the owner comparing the etch with the print or with the sheet's edge? If with the print, check the head positions and the laser-link drop at 11:44 that day.
6. **Daily calibration check** (an offset cut check plus a sparse checkerboard check, with a trend log and room temperature). Offered, not built.
7. **Calibration state:** the offset and bed map date from 12 Nov. The laser-to-camera offset reads about 1.6–2.2 mm off where the laser is put at Start (seen again on J0111), so re-running the offset calibration may be worth it.
8. `.claude/` is left uncommitted on purpose (its `launch.json` points into a scratchpad).

## 8. Facts for answering questions

- **Engraving direction:** lines always run along the machine's X (Trotec flatbed); a turned sheet gets them at an angle. That's why the placement-angle check exists.
- **Temperature effects** (answered): about 0.03–0.07 mm on a 300 mm part over 10 °C. The bigger risk is heat from long engraving bowing thin 0.9 mm 304 (it bows at roughly a 50 °C rise over a 100 mm hot spot). The Q500's temperature query returns 0, so nothing is measured.
- **Marks** are read in the order top left, bottom left, top right (Prepare's `markOrder`). The distance check stops a job when marks are more than max(2 mm, 1 %) out from the job's spacing.

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

Version 1.6.22 (20 Nov):
- **Speed limit**: `CC.MAX_PROCESS_SPEED` 200 mm/s for cuts and plotting; engraving is limited by the machine's travel speed (`CC.speedLimitOf(p, machine)`). The estimator, `packageProcess` (clamps), the sliders and inputs (Job and Materials), the starter presets (`capSpeeds`) and a check warning for used processes set faster all use it.
- **Scale buttons** (Objects tab, beside Rotation): `LRC.ops.scaleBy(job, ids, k)` scales about the selection's top left and remembers `size0` per object; `revertScale` / `revertFactor` go back to it.
- **Simulation Job peak**: `thermalPeak()` runs a second model to the end once per timeline/material (after drawing) and shows its peak and worst bending at any time.
- **Part edges source** is derived (`edgeSourceOf`): the Registration marks process has a colour → boxes in it (not cut), else the cut lines. The menu text under Part edges is gone; its description is "4 Corners - Linear Only".
- **Text pass**: no machine kind in the machine box sub (controller · Simulated/IP), no toolbar controller label, no bed label for the camera-reach strips, a shorter orphan note, Queue tab only for networked non-simulated machines, dialog messages and toasts trimmed, check messages shortened (self-test patterns updated). Simulation thermal card: no material/power line, no Colour/Beam absorbed rows, limit as a number.
- Merged on top of 1.6.21 (Monitor). The Machine setup conflict kept 1.6.21's Monitor fields with a one-line note. 1.6.21's changelog entry got the `fixed: []` What's new needs.

Version 1.6.21 (20 Nov):
- **Machines from anywhere, through the workshop's Pathline Monitor** (owner; Monitor 0.7, Run 0.7.23). `src/main/workshop.js` signs the computer in (`POST /api/v1/prepare/join` with the workshop password and an authenticator app code; the key is kept in `workshop.json`, sealed with `safeStorage`, never in settings.json) and makes calls (`POST /api/v1/prepare/call/<machine>` with `x-pathline-call`). `device.js` `request()` tries the machine's IP first; a machine with `monitorId` and no IP, or whose IP didn't answer (then for a minute), goes through `relay` (set in main.js). Answers carry `via: 'monitor'`; `deliver()` returns `relayed`, and Send and start then doesn't start (Monitor and Run refuse Start anyway: queue, reorder, remove, read, materials only).
- IPC `workshop:*` (preload `window.api.workshop`); `LRC.workshop` in app.js: `firstStart()` (Job page, once: `settings.workshopAsked`; test runs skip it unless `LRC_WORKSHOP`), `signIn()`, `pick()`, `add()`. Add machine has *Machines in your workshop…* (`box.close('workshop')`; `LRC.dialog` got `type: 'password'`, `code: true` and `box.close`). Machines added get `monitorId` = `deviceId` = Run's id; one already set up with that `deviceId` is linked (`workshopMachines()`), and `machines:saveAll` keeps a `monitorId` the page didn't know about. `findOnNetwork()` fills in the IP when the machine is on this network.

Version 1.6.20 (20 Nov):
- **Move tab removed** (owner). Jog, home, frame, test fire, tool change, IO toggles and Stop machine went with it, and the page methods frame/testFire/toolChange/toggleIo/setRegKind are gone. `CC.frameArgs` and the /frame protocol stay for Run.
- **Marks menu: five choices** (Off, Position & rotation, Full linear, Non-linear, Part edges), via `setRegChoice(id)`. The Mark type section is gone. The dot modes set `regKind: 'dot'`. Old jobs with hole/plate-corner kinds still load and run, but the menu can't pick those kinds any more.
- **Part edges reworked**: always 4 corners (`regCornersOf` → 4) and `regMode: 'linear'`. `job.edgeSource` is 'cut' (part outlines in output Cut processes) or 'mark' (rectangles in the reg colour: read, not cut; turning it on opens the colour picker). `edgeBoxes(job)` lists the readable boxes. `job.edgeCorners[slot] = { part, corner }` moves a slot (tl/tr/bl/br) to any box corner; a missing part falls back to the default. `CC.snapEdgeCorner(job, x, y)` gives the nearest box corner; butted parts share corners, so ties go to the part whose middle is nearest the point. JobCanvas: `props.onCornerMove(slot, x, y)` and `props.cornerSnap`; drag kind 'corner' shows the snapped L while dragging. Checks: BLOCK with no box, or two slots on the same spot; OK "part edges · 4 corners · rounded, r X mm (· box not cut)".
- Run brief updated: hmi/RUN-PART-EDGES-BRIEF.md (fit 4 corners full linear; corners can be inner corners).

Version 1.6.19 (19 Nov):
- **Part edges** (`regKind: 'edge'`, owner: drop printed marks on full printed sheets; "for full sheets, not individual"). `CC.partCorners(job)`: part outlines = the biggest closed path of each object in an output laser Cut process that `rectShape` says is a rectangle along X and Y (≥ 10 mm, rounded allowed); for each sheet corner the part whose box corner lies furthest that way. `regMarks` gives { id: `<part>-tl`…, at the box corner, kind 'corner', part, toward, r } for `regCornersOf` corners (2–4 for edge; `CORNER_SETS[4]` adds br). Sent to Run as corner inspect steps plus `part`. No mark colour: turning it on opens no colour picker. Checks: BLOCK with no rectangular part outline, or only one part; OK "N part corners · rounded, r X mm". Example: the X105 job (bug report 2026-11-19_15-22-32) reads (44.4, 46.4), (44.4, 882.9), (1236.9, 46.4), r 10.
  - Per-part alignment was turned down: the parts share cut lines (butted grid), and 105 camera reads cost ~5–7 min.
  - **Run needs:** to find a printed edge (not a plate on white), fit shift, rotation and scale with 3–4 corners: **hmi/RUN-PART-EDGES-BRIEF.md**.

Version 1.6.18 (18 Nov):
- **Punch (plotter)**, after the controller's Layer Parameter dialog (owner screenshot: Processing mode Punch, Punch tool, Punch space, Center punch). Process fields `mode: 'punch'`, `punchSpace` (mm, default 5), `centre`. `CC.punchPoints(path, proc)`: closed lines divided evenly (no double strike at the seam), open lines struck at both ends, centre = box centre of a closed shape. The estimator pushes `{ kind: 'op', mode: 'punch', path: { p: strikes }, hits }` per line (nearest next; a ring starts at its strike nearest the head), timed `plot.punch` (0.3 s) per strike plus moveT between; `est.punches`. The package step is `{ type: 'punch', tool: slot, centre, p }`. JobCanvas and Simulation draw a ring at each strike; the panel has Processing mode, Punch space and Centre punch, and no Speed slider for punch. "Up down punching" isn't done.
- **Frame**: `CC.frameArgs(box, machine)` → { box, path from top right: down, left, up, right; speed = travelSpeed or speed }. The emulator follows `path`.
- **Origin**: `CC.originOf(machine)` returns `machine.origin` (set in Machine setup for any machine, kept across controller syncs), else `info.origin`, else tl. Run's /machine reports `cfg.origin` (default tl), not the Ruida origin it actually runs with (`cfg.ruida.origin`), and every sync overwrote `info.origin`. So the owner saw top left whatever the setting. `originOf` feeds the origin dot, the estimate's home and the setup preview. Rulers and coordinates stay top left (the protocol's system).
- **Tool heads**: `CC.toolOptions(machine, current)` (the machine's `info.heads`, else the standard four) and `CC.toolFor(machine, tool)` (same slot). Used on Materials (row select, Tool heads card from the tab's machine) and the Job page (new process, process panel).
- **Machines on a material**: `mat.off` = machine ids taken off; `CC.matOnMachine(mat, machine)`. Materials tabs have × (removeMachine: deletes that machine's presets; the last machine of a type drops the type) and Add machine. Saving a preset from the Job page puts the machine back on.
- **Run:** `punch` steps and `/frame` path and speed are in Run 0.7.14 (commit 2752246, from **hmi/RUN-PUNCH-FRAME-BRIEF.md**). Not yet tried on a real router.

Version 1.6.17 (18 Nov):
- **Job tabs** (owner: "multiple jobs open on prepare"). `src/main/tabs.js` keeps the open jobs: `createTabs({ newJob, prepare })` → current, job, set(job, opts, tab), create, open, switchTo, close, move, undo, redo, history, info, unsavedTabs. Each tab has its own undo/redo. main.js has no `session` any more; `currentJob()` is the front tab's job, so Simulation, Setup and bug reports see the tab in front.
  - IPC: `job:tabs` ({ active, tabs: [{ id, name, dirty, path }] }), `job:switchTab`, `job:closeTab`, `job:moveTab` (not used by the UI yet). `job:new` opens a new tab; `job:open` uses the tab that has the file, else the front tab if it is still a blank new job, else a new tab. `job:update` takes `opts.tab` so an edit handed over after a switch lands in its own tab; `job:save` stores into the tab holding that job id.
  - Page: tab strip `.jtabs` under the app bar (always shown, with + for a new job). `rememberTab()` keeps sel, procSel and the canvas view per tab; `showJob(job, fresh)` brings a job to the front. Closing a dirty tab brings it to the front and asks Save / Don't save / Cancel. Keys: Ctrl+W, Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+PageUp/PageDown; middle-click closes (onMouseUp: the page runtime doesn't map onAuxClick).
  - `commit()` marks the job dirty in the page too, so the dot and "Unsaved changes" show at once. Quitting asks once for all dirty tabs (Save all / Don't save / Cancel).

Version 1.6.16 (18 Nov):
- **Plate corners from a drawn box, not the sheet** (owner didn't like the sheet for this; "most of our shapes are with rounded corners"). `plateOutline(job)` picks the biggest closed shape in the Registration marks colour and returns { e, box, r, square, count }.
  - `r` is the corner radius: the smallest distance from a box corner to the outline, ÷ (√2 − 1), to 0.1 mm; under 0.2 counts as square. `square` means the area matches W·H − (4 − π)·r² within 2 %, i.e. a rectangle along X and Y.
  - `regMarks` gives the bounding box's corners (where the straight edges meet), with ids `<box id>-tl` etc. and `r`. Inspect steps carry `r` (`cornerR` on the timeline) when it is above 0.
  - checkJob BLOCKs when there's no box, more than one object in the mark colour, or the outline isn't a rectangle along X and Y. The OK line says "rounded, r N mm". The sheet isn't used for marks any more.
  - Turning marks on with corners opens the colour picker again. The tip and toast say to draw the plate's outline in the mark colour.
  - **Run needs:** to accept `r` and fit the straight edges past the radius, then intersect them: **hmi/RUN-PLATE-CORNERS-BRIEF.md**.
- **Only printed dots are drawn solid** (owner: a box set as a reg mark turned bright white). In JobCanvas, `regSolid` = reg mark and kind dot, for both the fill and the hit test, so a click inside a hole mark or the plate outline picks what's inside it.

Version 1.6.15 (18 Nov):
- **Registration mark kinds** (from the Run session's HANDOFF-prepare-mark-kinds.md; owner: "registration marks … holes in steel on a white background, or the plate's edges"). `job.regKind` is `'dot'` (default, older jobs), `'hole'` or `'corner'`. `CC.regKindOf`, `REG_KINDS` and `REG_TIPS` hold the operator tips.
  - `regMarks` now returns `{ id, x, y, d, kind, toward? }` and nothing while regMode is off. For corners it uses the sheet (`job.sheet`, on): `CORNER_SETS` by `regCornersOf(job)` (`job.regCorners` 1–3, else 2 for pos and 3 otherwise). 1 = tl; 2 = tl + br (the diagonal); 3 = tl, tr, bl. `toward` is tl [1,1], tr [-1,1], bl [1,-1], br [-1,-1]; d = 0; ids are `corner-tl` and so on. markOrder, camReach and Move into reach work unchanged.
  - Estimate inspect entries carry `markKind` (the timeline already uses `kind`) and `toward`. `toolpath()` writes `kind` only for hole/corner (dot packages are unchanged for older Runs) and `toward`. The package's `regMarks` has `kind`.
  - checkJob: corners with no sheet BLOCK; objects in the mark colour with corners warn "won't be read"; holes are counted as before ("Registration holes"); `marksCutByJob` warns when a cut in this job passes within the hole (d/2 + 0.5 mm of its centre).
  - Job page: the marks menu has a "Mark type" segment (Printed dots / Holes / Plate corners) and the tip. With corners the list is Off / 1 / 2 / 3 corners (pos+regCorners 1 or 2, linear+3), and no colour picker or toast. The label reads "Holes · 3" / "Plate corners · 3". JobCanvas draws `props.corners` as 12 mm Ls along the edges; Simulation draws the same. The DXF REGMARKS layer gets nothing for corners.
  - Setup → Machines: the unused "Mark type: Dot / Cross" field was removed (Run has no crosses; the type is per job now). The owner can still ask for a per-machine default.
  - Not checked against Run: Run 0.7.13's mark-kind commit (after 324795d) wasn't in this repo. The self-test runs Run's `validate.check` on a corner and a hole package once `run/src/job/validate.js` knows `toward`. PROTOCOL.md's inspect `kind`/`toward` text comes with Run's commit.

Version 1.6.14 (17 Nov):
- **Binary DXF import** (owner: "BFT HK panel face trim v2 (BFT-HBK-BFP).dxf" gave errors; it is an AC1014 binary DXF). `src/main/importers/dxfbin.js` turns a binary DXF (sentinel "AutoCAD Binary DXF\r\n\x1a\0") into text group-code pairs for dxf-parser.
  - Group codes are 2 bytes (R13+) or 1 byte with 255 escaping (R12), detected from the first pair. Values are typed by group code (strings 0-terminated, ANSI before AC1021 and UTF-8 after, doubles, int16/32/64, bool, binary chunks as hex). A file that ends early or has an unknown code gives a clear error.
- **Duplicate lines dropped before joining** (`joinPaths` in importers/common.js): open pieces of the same colour with the same points, either way round (to the join tolerance), are kept once. That BFT drawing has every keypad edge twice, so 12 keypad holes came in as open shapes and loose lines; now all 30 shapes are closed.

Version 1.6.13 (16 Nov):
- **Trotec engraving timed as measured** (from Pathline Run 0.7.13's PREPARE-ESTIMATE-FINDINGS: Prepare was +1574 % / +1429 % on J0093/J0094). `rasterModelOf(machine)` returns `TROTEC_RASTER` for ctrl Trotec, or the machine's own `info.raster` when it sends one.
  - `rasterModelTime`: pitch = floor(25.4/dpi / 0.006)·0.006; lines = round(boxH / pitch); W = boxW + 2·10; t = lines·(0.955·W/v + 0.077 + 4.58e-5·v) + 0.32. One way adds the return stroke across W, from acc (not measured yet).
  - Used for islands and shared scans (the whole art box per line), and as the overscan for travel to an island (10 mm). `info.acc` is travel only for a Trotec. Other controllers keep `lineTime`. The beam-on time `on` is scaled to the real line count, so the thermal map heats at the real rate.
  - Etch Calibration: 1 h 55 min → 9 min 48 s, travel 17.5 → 6.5 s. Heat with the real timing: bare +12 °C (10 % of the bending limit), spray +83 °C (68 %), nearly all from the 11 × 53 mm frames island (189 s).
  - **Banded/interleaved engraving was simulated and not built**: 5 / 2 / 1 mm bands round-robin give 65 / 62 / 57 % for +6 / +16 / +33 % time. The local heat settles within seconds, about one band's time, so stepping away between bands lets little escape. Prototype: scratchpad `band-proto.js` (not in the repo).
- **Trotec cutting and travel timed as Run times them** (the findings' +10 % on J0087). `cutModelOf(machine)` → `TROTEC_CUT` { acc 2000, arc 1000, corner 20, travelAccScale 4, moveExtra 0.03 } for ctrl Trotec, or `info.cutModel`.
  - `fitArcs` and `cutModelTime` are ports of Run's `arcs.js fitArcs` and `compile.js runTime`; the self-test checks they give Run's numbers exactly when `run/` is there. Travel: `travelTime(d, vTravel, travelAcc·4, jerk) + 0.03` (Run's `travelTiming`). Other controllers keep `polyTime` / `travelTime`.
  - Cause: Prepare cut at the travel acc (352 mm/s²), segment by segment, so it slowed at every arc vertex and took 0.1 s at each start and stop.
  - Against Run's estimator on the same package (Ruby's GET /machine values): X28 2004 vs 2002 s, sample 462 vs 461 s, PCB Cover 356 vs 353 s (were +6–11 % on the cutting). J0087's own data is on Ruby's PC and wasn't checked directly.
  - The emulator queue test now waits for the emulator to settle (it starts the next job 0.5 s after one ends, and the test job is now quicker).

Version 1.6.12 (12 Nov):
- **Engraving holes across objects** (owner's bug report "Etch issue": the magnifying glass lens was engraved). Run fills even-odd per object, then merges, so a hole drawn as its own object was filled. `CC.engraveHoles(job)` maps each closed-only object of an Engrave process that lies inside another object of the same process (`insideOf` on every ring) to the outermost one.
  - The package: `packageEntities` adds the holes' paths to the host, and the hole gets `holeOf`. `toolpath` drops holes from engrave steps whose host is in the step. This works with the current Run, with no Run change.
  - Job page (`JobCanvas`): the host is filled with its holes cut out, and holes are drawn as outlines (cached on `entities`/`processes`). The Simulation page already drew islands even-odd.
  - Self-test: ring/lens/dot, separate and overlapping circles, cut shapes, the package, and Run's own `plan.scanLines` (when `run/` is there).
- **Thermal map: bending of sheet metal** (owner: "at what point does the material start to bend from the uneven heat"). The metal rows in `THERMAL` have `mech` { E GPa, alpha µm/m·K, nu, yield MPa, src }.
  - `bendLimit(props, tMm, hotDiaMm)`: set = 2·σy/(E·α) (a hot disc in a cold plate yields); bow = 2.45·(t/a)²/((1−ν²)·α) (a clamped disc of radius a buckles). Both are a rise over the cold sheet; the lower one is used. For 0.9 mm 304: set ≈ 123 °C, and a 100 mm hot area bows at ≈ 50 °C.
  - `thermalSim`: `hotSpot()` (the area at or above half the hottest rise, as an equivalent diameter), and `bend`/`bendAt` (worst share of the limit, checked every 0.5 s of sim time and kept in the snapshots). Metals keep 0.9 of the absorbed power when engraving (nothing is removed) and 0.5 when cutting.
  - Simulation panel for metals: the scale tops out at T0 + set, rows for Hot area / Bends at / Towards bending, and warnings for bending now, past the limit, or ≥ 80 %. Plastics keep their own limits.
  - **Marking spray** (the owner marks stainless through spray): `SPRAY_ABSORB` 0.7 (an estimate; no published 10.6 µm figure) for bare metal when `markingSprayOf(mat, job)` is true. That is `job.thermalSpray` (the Simulation panel's Marking spray switch, bare metals only), else /spray|coated|cermark|thermark|enduramark/ in the material's name or notes. The panel's thermal cache is keyed on it.
  - **Engraving heats only while the beam is on**: raster islands carry `on` (seconds crossing the artwork: Σ width ÷ speed, also for shared scans), and `thermalSim` scales a raster op's power by `on / dur`. Before, it heated for the whole line time, turnarounds included, which on a slow-accelerating machine is most of it, so it overstated the heat many times over.
  - Etch Calibration job (0.9 mm stainless, 35 % at 400 mm/s, Run reports acc 352 mm/s²): the beam is on 48 s of an estimated 1 h 55 min (0.7 %), giving bare +1 °C and spray +8 °C. **That depends on the line time**: if the real job is much shorter (Trotec turnarounds are far quicker than 352 mm/s² suggests), the same energy goes in 10–20× faster. Needs the real run time to calibrate. Banded/interleaved engraving (spreading the heat across islands) was discussed with the owner and is not built.

Version 1.6.11 (10 Nov):
- **Finding machines without an IP address** (owner's request), in `src/main/discover.js`:
  - `scan()`: `GET /api/v1/info` on port 8470 for every host of each local IPv4 network (narrowed to the /24 around the PC's address; 128 at a time, 0.9 s each). Works with any Run today.
  - `browse()`: an mDNS PTR question for `_pathline._tcp.local`, sent from an ordinary port (QU), so Run answers by unicast and Windows Firewall lets it in. It also listens on 5353 where it can. The DNS packet code is hand-written (no dependency); `_packet.encodeAnswer` is the reference for Run.
  - `find()` runs both and `merge()`s the results by `id`, else by address and port. IPC `discover:find` marks each result with the saved machine it already is (`added`).
- **Add machine** has a `custom` dialog field (`mount(el, box)`, plus `box.setValue`; new in `LRC.dialog`): "Machines on this network", with Search again. Picking one fills in the IP and port. Already-added machines show an Added tag. Typing a different IP drops the pick.
- **machine.deviceId** = Run's `/info` id. It's saved on Add, on Test connection and on sync. `follow(id)` runs when a status check fails (at most once a minute): `discover.relocate` looks for that id among the machines announcing themselves and moves the saved machine to the new IP and port (`machines:updated`, log `[discover]`). It needs Run's `id` and announcements: **hmi/RUN-DISCOVERY-BRIEF.md**.
- The emulator's `/info` has an `id` (`--id`, default `emu-<port>`). Self-test: the /24 host list, the scan against the emulator, a stand-in Run answering the mDNS question, relocate, and merge.

Version 1.6.10 (10 Nov):
- Release of the muted teal accent (`--accent` #3D6C71 light / #83B5B9 dark, commit db0cbc1; see design/HARMONISE-SPEC.md). No other changes. Segmented controls (`.seg`) stay neutral and bed markers stay `--ink`, as the spec says.

Version 1.6.9 (10 Nov):
- **Registration marks are always read top left, bottom left, top right** (owner's rule; any others after, nearest next). `markOrder(list, home)` no longer searches for the least travel or an end point; both callers (the part-by-part plan and `estimateIn`) start the cutting from the last mark, so the top right. Run follows the `inspect` steps as sent (HMI-BRIEF §4.6 updated).
- Checked the owner's full-bed X28 job (1322 cuts, All insides, Q500: 2000 mm/s, 352 mm/s², jerk 10000): travel 25.5 m / 475 s → 22.9 m / 470 s. The hole route has settled (more search time changes nothing).
  - Known, left alone: holes with a shape inside (10 on that job) split the holes run into separate groups that 2-opt can't reorder across. Joining them as chains saved 1.6 m in distance but only ~4 s, and made the search 4× slower, so it wasn't kept.

Version 1.6.8 (10 Nov):
- **`camReach` uses the machine's `markArea`** (`[x0, y0, x1, y1]` from Run's GET /machine; the Q500 sends [26.9, 3.5, 1300, 900]). Run works it out from the camera offset and the head's travel, which Prepare can't know, so `camX`/`camY` are no longer used for it. Without `markArea` (or with the camera off, or on a plotter) it returns null and nothing is checked. `keep` is 2 mm inside it.
  - The "too wide" check now says the job "is too big for print and cut on this machine".
  - The bed band shows on any camera machine (`reach`), fainter while registration marks are off (`reachOn`). It is labelled "Registration marks can't go here" in the widest strip when there's room, and in a tooltip.
- **Start/stop gap** (owner's request): `job.startClear` in mm, default `START_CLEAR` (0.1), set in Job settings and clamped to 0–20. `startPoints(p, clear)` adds corners as candidates when it is 0. It is passed through `orderPaths` → `refineStarts` / `bestStarts` as `opts.startClear`. `newJob` takes `settings.startClear` (saved from Job settings), and the job sheet prints "Start/stop: … mm from corners".

Version 1.6.7 (10 Nov):
- **Registration marks within the head camera's reach** (brief from the Pathline Run session; the X28 job had marks at 28 mm from the left on a Q500 whose camera sits 41.74 mm from the beam). In core.js:
  - `camReach(machine)` returns `{ see, keep, W, H, camX, camY }` from `info.camX`/`camY` (strings) and `bed`; `keep` is `see` with `REACH_MARGIN` (2 mm). It is null for plotters, `f.camera === false`, or a missing offset.
  - `marksOutOfReach(job, machine)` lists `{ n, id, edge, from, see, keep }`.
  - `reachShift(job, machine)` gives the smallest whole-job move `{ dx, dy }`, keeping the job on the bed where possible, or `{ tooWide, span, reach }`.
  - `checkJob` adds a blocking check (`reach: true`), or a blocking "too wide" check.
- On the Job page, the check pill runs `moveIntoReach()`: it translates every entity, and the sheet when on, and says to place the printed sheet there too. `JobCanvas` draws the unreachable band from `props.reach`, passed only while registration marks are on.
- Prepare never places marks itself; they are objects in the drawing given the Registration marks colour, which is why the fix moves the job rather than the marks. HMI-BRIEF §4.6 documents the rule.

Version 1.6.6 (10 Nov):
- **Inside test for nesting** (`insideOf(inner, innerBox, innerArea, outer, outerBox, outerArea)`), used by `nestDepth` and by `isHole` in `estimate()`. A shape is inside another only when:
  - its box fits within the other's;
  - the other's area is clearly bigger (relative and absolute margins);
  - its box middle is inside the other. For an open line the middle point is used; for a concave shape whose box middle falls outside itself, its first point.
- This came from a bug report (X28 job: 4 touching parts of the same size, 2 passes, Ordered + All insides). Two part outlines were cut among the holes. Each started on the edge it shared with its neighbour, where the old first-point test could say "inside", and floating-point rounding made the neighbour's area a hair bigger. The self-test reproduces this with widths differing by 1e-7 mm: the old core cuts outlines among the holes.

Version 1.6.5 (6 Nov):
- **Job page speed on large jobs.** Measured on the owner's PCB Cover job: 4176 objects and about 140 000 points, 150 of them cut. An edit used to take 984 ms: about 725 ms for the estimate and about 200 ms to send the 15 MB job to main. It now takes about 20 ms.
  - The estimate runs in `src/ui/estimate-worker.js` (a Worker that loads core.js).
    - `MainDetailed.estimate()` returns the cached full result for this job object. Otherwise it returns the last one shown for this job id, or, for a job just opened, `CC.estimate(…, { quick: true })` (no route search).
    - It asks the worker 200 ms after the last change (`estimateLater`) and redraws on the answer (`estimateDone`).
    - The worker only gets the entities in colours a process sends (`cutOnly`).
    - The Send dialog uses the full estimate (computed directly if not ready).
  - `commit()` updates the page at once and hands the job to main 300 ms after the last change (`flushJob`); edits in one burst become one undo step. `flushJob()` runs before undo/redo/history, on clicks on links to other pages, on Ctrl+R/Ctrl+M, on pagehide and on unmount. `commit()` still returns a promise, which resolves once the job is handed over.
  - `estimate(…, { quick })` sets the route search budget to 0. `twoOptGroups`/`orderPaths` now respect a 0 budget; before, `|| 80` turned 0 into 80.
- PCB Cover's route was checked: Per part, 149 moves, 6.1 m, 62 s of travel (the least time of the three modes). Through the shapes' centres the app's route is 4822 mm against 4741 mm for the best tour found with no time limit (within 2 %).

Version 1.6.4 (5 Nov):
- **Print and cut starts next to the last mark.** `markOrder(list, home, end)` (shared) picks the mark reading order. Fastest's part-by-part plan in `estimate()` now starts its part order from the last mark read, worked out the same way as `estimateIn` (end = the cut point nearest the origin), not from the machine origin. On the X8 job the hop from the last mark (top right) to cut 1 was 607 mm and is now 59 mm.
- **All insides without a job-wide depth layer.** Each depth-1 hole is grouped with what's inside it (deepest first, blk `nest<k>d<depth>`). Single holes share blk `holes`, which the 2-opt pass reorders freely, and outlines come last (blk `outlines`). Before, all depth-2 shapes in the job went first wherever they were.
- X8 travel: All insides 8.2 → 7.8 m, Per part 7.7 m, Off 6.5 → 6.3 m. Self-test: print and cut's first cut is within 200 mm of the last mark in every mode.

Version 1.6.3 (5 Nov):
- **The route minimises travel distance, at the owner's request** ("travel as little as possible; punish travel, reward cutting"). The route cost is `routeCost(d) = d + ROUTE_MOVE_MM` (5 mm per move; 0 for a join). It is passed to `orderPaths` instead of the travel time; `moveT` still times the estimate. The search budget is 150 ms per group. `estimate(…, { routeCost, routeBudget })` can override both (used for experiments).
- Checked on the X8 job (All insides): the hole route is 6058 mm against 6015 mm for the same holes solved as a standalone shortest-tour problem (2-opt + or-opt to convergence, centre to centre), so within 1 %.
  - Travel by purpose: to the 3 registration marks 1.25 m, marks → first cut 0.6 m (All insides starts with the deepest holes), between holes 5.7 m, outlines 0.6 m.
  - Inside-first is the biggest remaining factor: All insides 8.2 m, Per part 7.7 m, Off 6.5 m.

Version 1.6.2 (5 Nov):
- `twoOptGroups(list, start, cost, budgetMs)` now alternates 2-opt and or-opt (chains of 1–3 moved, either way round) until nothing improves or the time budget per group runs out. The default is 80 ms; groups of up to 1500 paths.
- `bestStarts(list, start, cost)` finishes `orderPaths`. Dynamic programming picks every closed path's start (up to 16 `startPoints` each) and every open path's direction together, for the least total travel for that order.
- Tried on the owner's X8 job (376 shapes, 381 moves, travel ≈ 161 s against a measured 160 s): only about 1 % better. The route is near the best the geometry allows: 376 separate shapes, hops mostly 2–40 mm, each limited by the jerk. A full joint search (3 rounds, 64 candidates) gained under 1 % more and took 3.4 s, so it was dropped.
- **The real lever is on the Run side:** beam-off travel with Throughput jerk (40 000) would take this route's travel from 161 s to about 124 s, and with acc 1000 to about 94 s. See `hmi/RUN-TRAVEL-BRIEF.md`.

Version 1.6.1 (5 Nov):
- `nestDepth` judges an open path at its middle point, so an open line inside a closed shape is nested in it. With Per part or All insides it is cut with the holes, before the outline (previously depth 0, grouped with the outline).
- `partOrder(units, start)` orders the parts in Per part mode by the gap between their boxes (plus 1 % of the centre distance to break ties), greedy and then 2-opt. It replaces `sequence(units…)`, whose unit `exit` was the first hole's end.
- Measured on a rebuilt copy of the owner's sample (8 touching rounded parts, each with 2 circles, a 10-line burst and a 4 × 3 square grid), travel against 1.6.0: Per part 88.3 → 79.5 s, All insides 81.7 → 78.2 s, Off 75.4 s unchanged. What's left with Per part is structural: touching parts share an edge cut once, so an outline is an open U whose ends sit on one side.

Version 1.6.0 (5 Nov):
- **Travel model:** `jerkTime(d, v, a, j)` gives a rest-to-rest S-curve. Short hops take (32·d/j)^⅓, and 7 mm at 5000 mm/s³ is 0.355 s, matching the Trotec measurements the Run session made (700 mm/s, 500 mm/s², 5000 mm/s³, Ruby's Standard; its jobs matched within 1–4 %).
  - `travelTime(d, v, a, j)` uses the S-curve when `j` is given, otherwise the trapezoid.
  - In `estimateIn`, travel uses `info.travelSpeed`, `info.travelAcc` (else `acc`) and `info.jerk`. A laser that reports no `acc` gets `DEFAULTS.laser` (700 / 500 / jerk 5000). Run currently sends equivalent 700 mm/s and 250 mm/s² without jerk, which the trapezoid matches closely.
  - `est.moves` counts travel moves between cuts, and `est.machine` carries the travel figures.
- **Optimising by time:** `orderPaths` takes `cost(d)` (the estimator passes the travel time). Within the existing order rules, the pipeline is `refineStarts` → `twoOptGroups` (2-opt within each `blk` group of up to 400 paths, reversing open paths in a flipped stretch) → `refineStarts` again. Only paths within one group move, so inside-first is kept.
  - Per part: parts with no holes become free single pieces (blk `free…`) and can chain across touching parts. Parts with holes keep holes → outline.
  - Measured: a 200-object real job saves 3–4 % travel (it is within one move of the minimum: about 84 separate runs per process, from the line network's odd vertices). 48 touching squares with Per part go from 33 to 19 moves (15.6 → 9.8 s); with Off they were already at the minimum of 12.
- HMI-BRIEF §5 documents `travelSpeed`, `travelAcc` and `jerk`.

Version 1.5.8 (4 Nov): the Job page's Queue tab lists only active jobs. `qList` drops statuses in `FINISHED` (done, stopped, failed, error, cancelled, aborted), and the Clear finished button and `queueClear` are gone.

Version 1.5.7 (4 Nov):
- **Registration marks always start off** (`newJob` in main.js, and switching machine on the Job page).
  - `CC.ensureRegProcess(job)` adds a Registration marks process whenever `regMode` isn't off. It runs in main's `setJob` and the Job page's `commit`.
  - `CC.withPresets(job, presets)` is used wherever processes are replaced by a material's presets (new job, Choose material, Use for current job, switching machine type). It keeps the job's own Registration marks process (with its colours) and drops any that a preset brings.
  - Choosing a material no longer counts the registration process as a job override.
  - The Registration marks process has no Advanced section (`sel.showAdv`).
- **Thermal map colour:** `CC.colourOf(mat)` reads the colour from the material's name or notes (clear, translucent, black, white, common colour words), else from its swatch (the default `#E1E4E8` is not a colour). `CC.absorptionOf(props, mat, fibre)`:
  - CO2: base ±3 % by darkness.
  - Fibre: 0.03 (clear) / 0.08 (white) up to 0.9 (black).
  - Bare metals: no colour.

  `thermalSim` returns `colour`, and the Simulation's thermal panel shows it, with a note on how much colour matters for the source.

Version 1.5.6 (4 Nov): `START_CLEAR` 0.1 mm, set by the owner (1.5.5 had 0.3 mm, 1.5.4 had 1 mm).

Version 1.5.4 (4 Nov):
- **Closed cuts start off the corners** (`startPoints`, `pointOn`, `rotateTo`, `refineStarts` in core.js). A closed path's start (which is also its end) is chosen from:
  - points along straight edges of 3 mm or more: `START_CLEAR` (0.1 mm since 1.5.5, set by the owner) from each end, and the middle. 1.5.4 first used a quarter of the edge, which put starts 2.5 mm in on 10 mm squares. The start distance doesn't change how slowly the machine takes a corner: that's the controller's motion planning;
  - vertices where the path turns less than 20° (on a curve).

  It falls back to plain vertices only when a shape has neither. The cheapest candidate for travel in and out still wins. A start along an edge inserts that point as the path's first vertex. This came from a bug report: square corners melted regardless of power correction. Pathline Run does send power correction to the Trotec (`compile.js`); the double pass over the start corner was the cause.

Version 1.5.3 (4 Nov):
- **Repeat is always visible.** `checkJob` adds a warn check, "Runs the whole job N times (Job settings)" (`repeat: true`), whenever `job.repeat > 1`; on the Job page that pill opens Job settings. The summary under the estimate ends with "whole job N×". This came from a bug report: a test-grid job with 2 passes was reused for parts and silently cut everything twice.

Version 1.5.2 (4 Nov; 1.5.1 was released by the Pathline Run session with its test grid choices, see its commit):
- **Whole-job repeat:** `job.repeat` (1–50; set in Job settings → Run the whole job). In `estimateIn`, each bed's work runs `repeat` times, every step once before any is repeated. Timeline ops carry `round`, and so do package steps (exporters `toolpath`). A process with `once: true` runs only in round 1. The job sheet says "Repeat". The Simulation shows "round r of n" and counts items within the round.
- **Test grid passes** now set the job's `repeat` (each square is one pass) with Ordered cut order, and the label process is `once`, so the whole grid runs and then runs again.

Version 1.5.0 (4 Nov):
- **Materials on the machine** (main.js, protocol in HMI-BRIEF §5.3; the brief for the Run side is `hmi/RUN-MATERIALS-BRIEF.md`).
  - `stampPresets(before, after)` stamps `mat.presetsAt[machineId]` whenever a material's presets for that machine change. This happens in `materials:save`, `saveAll` and `import`.
  - `syncMaterials(m)` runs at the end of every `syncMachine`. It calls `GET /materials` (a 404 means the HMI doesn't keep materials, and nothing is sent), merges with `mergeMachineMaterials` (newer `updatedAt` wins per material; unknown materials are added), then `PUT`s `materialsDoc(m)` if the machine's id/updatedAt list differs.
  - Saving the library calls `schedulePushMaterials()` (1.5 s debounce, every machine).
  - Deleted ids go to `settings.removedMaterials` and are never pulled back.
  - The window hears `materials:updated` (`api.materials.onUpdated`). Materials takes the new list except for materials with unsaved edits; the Job page refreshes its list.
  - `device.materials` / `device.putMaterials` are the device calls, and errors from the device now carry `status`. The emulator stores the list in `<out>/materials.json` (it ignores a BOM).
- **Test grid:** the button is now **Create job**. Apply is replaced by a process dropdown (`tgSendTo`; default is the first process of the kind being tested) and **Send**.

Version 1.4.0 (3 Nov):
- **Renamed Pathline Prepare.**
  - What changed: `productName` and `shortcutName`, window titles, the brand word, dialogs, update, crash and bug-report text, and the release title in `.github/workflows/release.yml`.
  - What stayed: "Pathline Run", "Pathline job" files (.cjob), the package `name` (`pathline`, so the updater cache folder is the same), the installer artifact names (`Pathline-Setup-<v>.exe`, which release.yml relies on), `appId`, and the GitHub repo.
  - userData is now `%APPDATA%\Pathline Prepare`. On first start the old `%APPDATA%\Pathline\data` (or `Laser & Router Control`) is copied across when the new folder has none.
- **Process reordering:** shared `LRC.rowDrag(e, k, show, drop, delay)` and `LRC.rowDragStyle(drag, k)` in app.js.
  - Materials: a `.grip` handle on each row (delay 0); holding ⋮ still works (300 ms).
  - Job page: a grip on each process row. Visible rows map to process indices (`pi`), and `moveProcess(from, to)` carries in-progress edits (`S.edit`) and the open process with the move.
- **Test grid passes** (`tg.passes`, 1–20): used by the generated grid job and set by Apply.
- **Foam** material group.
- **Thermal map material:** a picker in the Simulation's thermal panel. It stores `job.thermalMaterialId`, defaulting to `job.materialId`, and only the heat model uses it.
- **Add machine (Real):** only the IP address is asked for. Type, name and controller come from GET /info; a controller that isn't reported falls back to the type's default. Fields that don't apply are hidden, not greyed.

Version 1.3.2 (2 Nov):
- **Nested fill:** Fill copies has Layout **Grid / Nested** (`fillLayout`, default Nested), plus the Turn parts 90° switch. `LRC.ops.fillNest(job, ids, area, count, { spacing, margin, rotate, beds, dry })` packs `count` copies with `CC.nestRects`, or as many as fit when `count` is null (bounded by area). With `beds` (plotter) a count can add beds. The first copy is the original, moved into place.
  - The popover's count comes from a `dry` run, cached in `this.fillMemo` by its inputs. It also says how many more than a grid fit.

Version 1.3.1 (2 Nov):
- **Nest & fill** (Job page toolbar, plus Arrange → Nest & fill) replaces the separate Fill popover, the Nest parts dialog and the Nest parts machine-tool buttons. The popover has a Nest parts / Fill copies switch (`fillKind`), with shared Area (Bed / Sheet / Custom), Spacing and Edge margin.
  - Nest also has "Turn parts 90°" (`nestRot`) and works on the selection, or on all parts when nothing is selected.
  - Fill keeps As many as fit / Set a number.
  - `nestDlg` was removed.
- **Add machine detects the type.** For a Real machine the Type choice is hidden. On Add, Pathline calls `device.test` (GET /info) on the IP and takes `type`, `name` (with `hmiName`) and, if it's a known controller, `ctrl`. If the machine doesn't answer, a second dialog asks for the type.
  - `syncMachine` now also takes `type` from /info when /machine doesn't report it, so the type corrects itself once the machine connects.

Version 1.3.0 (29 Oct):
- **Common lines** (`commonLines(paths, eps = 0.05)` in core.js). Where a path runs along part of an earlier path in the same process, and on the same bed, that stretch is dropped, so the line is cut once. A closed path that loses a stretch becomes open pieces; a full duplicate disappears. This happens in `estimateIn` (`commonOf(pi, bed)`, worked out once per run), so the Simulation, the cut length and the job package all use the merged paths. The DXF export still holds the drawing as it is.
  - Merged pieces carry `orig`. `arrangePaths` nests by the original shape, so an outline opened by a shared edge is still that part's outline for inside-first.
- **Fastest honours "Cut inside shapes first."** In the part-by-part plan, steps can carry `only` (a Set of paths). Within a part the order is engraving, then holes, then outlines. With All insides the outlines are deferred to one final run per process; with Off the cuts are unconstrained. Process orders are also checked (`allowed`): with inside-first on, a cut inside another process's shape runs first; with All insides, no process with outlines runs before one with holes.
- An entity is only "inside" a cut shape that is bigger than it (a centred hole no longer counts as enclosing its own part).

Version 1.2.9 (29 Oct):
- **Fastest never engraves inside a cut-out part** (`estimate()` in core.js). An entity is "inside" a through-cut (laser `Cut`, plotter knife) when its centre lies within one of that cut's closed paths.
  - Process orders where such an engraving would come after its cut are not used.
  - On a laser, Fastest also tries a **part-by-part plan**. Each entity is grouped with the outermost cut around it; groups run nearest next from the origin; within a group, engraving comes before cutting. These steps go to `estimateIn(…, plan)`, and `runPass` caches per step key.
  - The quickest candidate runs. Engraving outside any cut can come before or after the cuts.

Version 1.2.8 (29 Oct):
- **Cut order modes are `process` (By process), `speed` (Fastest) and `ordered` (Ordered)** (`cutOrderOf` in core.js). Old `file` and `heat` jobs read as `ordered`. Paths within a process always go to the nearest next one; "As drawn" and "Spread heat" are gone.
  - By process: processes run in the job's list order (`processOrder`).
  - Ordered: marks, then engraving, then cutting; every pass is a whole round.
  - Fastest: `estimate()` times every order of the processes (up to 5) and keeps the quickest. Passes run back to back when that is quicker.

  The order used is returned as `est.procOrder`. The Simulation page, the job sheet and the job package all use it.
- **Materials: press and hold ⋮ for 300 ms, then drag** to reorder processes (`holdDrag`). A plain click still opens the menu.
- **Machine offline:** when `/status` has `link` other than `online`, Machines shows "Connected · machine offline" and the Job page shows "Machine offline" (warn colours). The emulator takes `--link offline`, and HMI-BRIEF §6 documents `link`.
- **Add machine:** Real / Simulated and Laser / Plotter. The Name field shows only for Simulated (dialog fields take `sim` and `hidden`).
- **Hints removed:** the dialog message, the header subtitle hints, and the Simulation order tooltips and travel note.

Version 1.2.7 (29 Oct):
- **Engrave DPI is a choice of `CC.DPI_STEPS` (100, 300, 500, 1000)**, built by `LRC.dpiSelect` (app.js) and used in the Materials process table and the Job page process editor. A stored value outside the list still shows, as an extra option.
- **New materials start with `CC.starterPresets(type)`**: laser gets Cut contour (ACI 1) and Engrave fill (ACI 7); plotter gets one Knife through (ACI 1). This applies to New material, Add type, and `materials:create`.
- **Machines header:** the name box is shown only for simulated machines; real machines show the name as a heading, taken from the HMI. Beside the status: latency over the last sync time, then icon-only Test connection and Refresh from machine (each shows its name on hover). The Open HMI button and the sync bar card are gone.
- **Simulated machines** are labelled "Simulated", with no note under Connection. Their Controller is one of `CONTROLLERS` (Trotec, Ruida, Other); a value left over from older builds (e.g. "Simulated") shows "Choose…".

Version 1.2.6 (29 Oct):
- **Machine settings refresh automatically** (`syncMachine` / `autoSync` in main.js). GET /machine is read:
  - on first contact (a successful Test connection of a saved machine, or the first status answer after starting or being offline);
  - for every Ethernet machine when the app opens;
  - every 5 minutes (`SYNC_EVERY_MS`; `LRC_SYNC_EVERY_MS` for tests).

  Automatic reads are quiet and at most every 30 s per machine. Pages hear `machines:updated` and update live; the Machines page keeps connection edits in progress.
- **The machine name comes from the HMI:** `name` from GET /machine, else from GET /info. Once reported (`hmiName`), the name box is read-only for that Ethernet machine.
- **Fixed (from a bug report):** the thermal map crashed Simulation when the job had no material. The scene now draws the heat image only when there's a model.

Version 1.2.5 (29 Oct):
- **Periodic update checks:** every 5 minutes while Pathline runs (`UPDATE_EVERY_MS` in main.js; each check reads only latest.yml), as well as at start. A version the operator said Later to isn't offered again that session (`check({ periodic: true })` in updates.js).
- **What's new after an update:**
  - `src/main/changelog.js` lists every release, newest first, with `added` and `fixed`. **Add an entry with every version bump**; the self-test fails if the top entry isn't the package.json version.
  - At start, main.js compares with `settings.lastRunVersion` and shows the entries in between once. Installs from before this feature see the current version's entry; fresh installs see none.
  - Help → What's new shows the whole list. `LRC_WHATSNEW=1` lets harness runs show it.

Version 1.2.4 (29 Oct):
- **Arrays are editable** (from a bug report: changing an array added a second set of copies on top, 757 objects). The original objects keep the settings (`array: { id, cols, rows, gx, gy }`) and each copy is marked `arrayOf: id`.
  - Array on any part of an existing array opens as **Edit array** with its current values, and **Update** replaces the copies; 1 × 1 removes them (`ops.arrayOf`, `ops.array` in app.js).
  - Duplicates and pastes never carry array markers.

Version 1.2.3 (29 Oct):
- **Fixed: imported objects couldn't be selected** when their colour belonged to a process with output off. A plotter material's Pen (ACI 7, 8) is off by default, and DXF lines usually import as ACI 7. Those objects were treated like hidden ones. Now only the eye icon blocks selection (`ops.offAci`): output-off objects are drawn faded and not sent, but can be selected, moved and recoloured. The Objects list says "<process> is off, not sent", and `checkJob` warns "Output off: <process> — those objects won't be sent". (Reported via the new bug report: plotter, simulated Ruida, one DXF outline in ACI 7.)

Version 1.2.2 (29 Oct):
- **Bug reports are sent through GitHub.** Help → Report a bug…:
  - keeps a copy in the reports folder;
  - **asks where to save** the report, as one `.zip` (report.json, log.txt, screenshot, job);
  - then offers **Report on GitHub**: a pre-filled issue on the project's repository (title, description, steps, version, Windows, machine and job summary, recent errors), with the zip shown so it can be dragged in.

  Pathline can't file issues itself without a GitHub token in the app, which would be extractable from a public installer, so the operator submits the issue while signed in. `issueUrl()` in main.js builds the address from `build.publish`; the zip writer is in reports.js. `LRC_SAVE_DIR` lets harness runs save without the dialog.
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
- **To do (18 Nov 2026): marks that are holes in the plate, or the plate's own corners.** Run already reads them (`kind` on `inspect` steps, PROTOCOL.md). What Prepare needs is in `HANDOFF-prepare-mark-kinds.md`.

### Run order, passes, cut order (estimator: `src/shared/core.js`)
- Order: **registration-mark inspection → engraving → cutting**.
- Cut order setting: **By process / Fastest / Ordered**. Inside-first: **Per part / All insides / Off**.
- Each closed cut starts at the most convenient point on the travel path (`refineStarts`).
- Travel from the machine origin corner and back is included in the time.
- **Passes**
  - **Fastest**: each item's passes run back to back, **unless whole rounds are quicker**. With a dwell, back to back costs one dwell per item, while rounds cost one per round. The estimator compares both and picks the quicker (`backToBack()`).
  - **By process / Ordered**: whole rounds. Every item in the group once, then all of them again (with a dwell between rounds).
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

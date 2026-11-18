# Handover: registration marks that are holes, or the plate's corners (Pathline Prepare)

For whoever picks up Pathline Prepare next, a person or an AI assistant. Pathline Run already does its half. This document says what Prepare has to add so operators can choose the new mark types when they set up a job. Read `HANDOFF.md` first for how Prepare is laid out, run and tested.

Written 18 Nov 2026, with Run 0.7.13 (commit after 324795d, not pushed).

## 1. What the owner asked for

> "can we allow registration marks to be holes in steel on a white background? or to use the plates edges on a white background"

Then: "build both up, then the handover document for pathline prepare".

The work is unprinted steel plates on Ruby, a Trotec Q500 with the head camera. Today the only kind of mark is a printed dark dot on white. The owner wants to locate the plate either by:

- **holes already cut through it**, with white card or paper under the plate; or
- **the plate's own corners**, with the plate lying on a white background.

## 2. What Run does now

Run reads one new field on each `inspect` step, `kind`. `PROTOCOL.md` (Job package, the `inspect` bullet) is the reference. In short:

| `kind` | The camera looks for | Other fields |
|---|---|---|
| `"dot"`, or left out | A dark dot `d` mm across on plain white. If there is none, Run looks for a light one, a hole. | `at` (centre), `d` |
| `"hole"` | A light disc `d` mm across in a darker surround. If the steel shines brighter than the card, it looks for a dark one instead. | `at` (centre), `d` |
| `"corner"` | Two straight edges meeting at the plate's corner, against a white background. | `at` (the corner as drawn), `toward: [sx, sy]` |

`toward` says which way the plate lies from the corner, along X and Y, in the package's own coordinates (the same ones as `at`). Each value is `1` or `-1`:

- `[1, 1]` is the corner at the plate's least X and least Y: top left on Prepare's screen, back left on the bed.
- `[-1, 1]` is top right, `[1, -1]` bottom left and `[-1, -1]` bottom right.

The plate's edges must run along X and Y in the job as drawn.

How Run uses the marks:

- **Dots and holes** are fitted according to `regMarks.mode`, exactly as printed dots are today.
- **Corners** are never stretched, whatever the mode says: two or more give shift and rotation only (Run's `rigid` fit). One corner is enough, because its two edges give the turn. The log then says `print and cut: corner`.
- The existing checks apply to every kind:
  - Marks that come out more than 1 % (and at least 2 mm) further apart or closer together than in the job stop it.
  - The placement-angle limits apply: up to 5° runs, up to 10° asks, more stops.
  - A mark that isn't found waits for the operator to jog the camera over it. For a corner, the dialog says "Plate corner … with white background showing past both edges".
- Run refuses a job with an unknown `kind`, or with a corner that has no `toward`.
- Hole sizes are logged but don't trigger Run's "marks measure N % smaller than printed" height warning, which is for printed dots.

**Holes already work with today's Prepare.** Draw each hole as a registration mark of the hole's size and send the job. Run finds no dark dot there and falls back to finding a hole; the self-test checks this. Prepare only needs `kind: "hole"` so that the jog dialog and log say "hole", and so that Run tries the light disc first.

**Corners need Prepare.** Nothing in today's package tells Run where the plate's corners are or which way the plate lies.

Run side, for reference:

| File | What's in it |
|---|---|
| `run/src/vision/detect.js` | `findDots(…, { light })` and `findPlateCorner` |
| `run/src/vision/vision.js` | `find`, `readMarks` |
| `run/src/vision/fit.js` | `pose` |
| `run/src/job/validate.js` | Checks on `kind` and `toward` |
| `run/tools/selftest.js` | Tests, under "marks that aren't printed" |

## 3. What Prepare needs to change

### 3.1 A mark type on the job

- **Setting:** add `job.regKind`, one of `'dot'` (default, and what older jobs mean), `'hole'` or `'corner'`. Save it in .cjob files like `regMode`.
- **Where to choose it:** in the **Registration marks** menu on the Job page (`src/ui/MainDetailed.dc.html`, the `regOpen` pop-up around line 282, with `MODES` around line 1641), under the mode list. Use a small segmented control, "Printed dots / Holes / Plate corners", shown only while marks are on.
- **Button label:** `regLabel` should read, for example, "Holes · 3" or "Plate corners · 3".
- **Machine setup card:** Setup → Machines has a "Mark type: Dot / Cross" field (`MachineSetupDetailed.dc.html` line 586) that nothing reads, and Run has no crosses. Remove the Cross option, or replace the field with this job setting's default. The owner hasn't decided which.

### 3.2 Holes (`regKind: 'hole'`)

- **Marks stay as they are.** They're still objects drawn in a Registration marks colour: draw each one as a circle the size of the hole. `CC.regMarks` (`src/shared/core.js` around line 1985) is unchanged.
- **Package:**
  - The estimator pushes inspect steps in `core.js` around line 1443; add `kind` there.
  - `toolpath()` in `src/main/exporters.js` (line 195) should then write `kind: 'hole'` into each `inspect` step.
  - Also add `kind` to the package's `regMarks` object (exporters.js line 235), so tools that read only `regMarks` know.
- **Same-job warning:** the hole has to be in the plate *before* the job runs. If a registration mark lies on an object that the same job cuts, add a warning to `checkJob`: "Mark N is cut by this job; the camera reads it before cutting starts". That usually means the job should be two jobs: one cuts the holes, and the next uses them.
- **Operator tip:** put a short line in the job sheet (`exporters.js` around line 131) and as a tip in the menu: "Put white card or paper under the plate, so the holes show light".

### 3.3 Plate corners (`regKind: 'corner'`)

The corners come from the **sheet** rectangle (`job.sheet`, with `on`, `x`, `y`, `w` and `h`), which stands for the plate. Its edges are always along X and Y.

**Building the marks.** `CC.regMarks(job, machine)` returns the corners when `regKind === 'corner'` and the sheet is on. Use `d: 0`, an id such as `'corner-tl'`, and `toward`:

| Corner | `x`, `y` | `toward` |
|---|---|---|
| Top left | `sheet.x`, `sheet.y` | `[1, 1]` |
| Top right | `sheet.x + w`, `sheet.y` | `[-1, 1]` |
| Bottom left | `sheet.x`, `sheet.y + h` | `[1, -1]` |
| Bottom right | `sheet.x + w`, `sheet.y + h` | `[-1, -1]` |

Because everything goes through `regMarks`, the following keep working unchanged: `markOrder`, the estimate's inspect steps and times, `camReach` / `marksOutOfReach` / **Move into reach** (which already moves the sheet with the job, `moveIntoReach` in MainDetailed), and the `checkJob` count.

**How many corners:** take the number from the mode.
- Position & rotation: two corners, top left and bottom right. The diagonal gives the longest baseline.
- Full linear or Non-linear: three corners, top left, top right and bottom left.

Run fits shift and rotation only for corners in every mode, so in the menu name them by count ("1 / 2 / 3 corners") rather than Linear or Non-linear. Allowing one corner is useful when only one corner of a big plate has white round it. Whether the corner list replaces `MODES` or sits beside it is a design call for the owner.

**Package:**
- The inspect steps carry `kind: 'corner'` and `toward`; pass `toward` through the push in `core.js` line 1443.
- `d` may be 0.
- `regMarks.marks` should carry `kind` and `toward` too.

**Checks to add in `checkJob`:**
- **Sheet:** "Plate corners need the sheet (Job settings → Sheet) to show where the plate lies". This blocks sending: there is nothing to read without it.
- **Objects in the mark colour:** with corners, any objects in a Registration marks colour are ignored. Warn that they won't be read.

**Drawing:**
- On the Job canvas and Simulation page, draw each corner mark as a short L along the two edges at the corner, instead of a dot. Simulation draws marks at `SimulationDetailed.dc.html` line 641, which currently uses `r: mk.d / 2`, and `d` is 0 for corners.
- For the DXF `REGMARKS` layer, draw nothing for corners, or the same L.

**Operator tip** (job sheet and menu): "Lay the plate on white, with at least 10 mm of white showing past both edges at each corner that's read. Don't push those corners against a fence."

### 3.4 Prepare's self-test and emulator

- **Self-test** (`tools/selftest.js`):
  - For each kind, `regMarks` returns the right marks.
  - The package's inspect steps carry `kind` (and `toward` for corners).
  - A corner job without a sheet is blocked.
  - The same-job hole warning appears.
  - Older jobs without `regKind` behave as before.
- **Run's validator:** if `run/` sits next to Prepare (as in this repository), also send one corner package and one hole package through Run's `validate.js`. Prepare's self-test already calls Run's `plan.scanLines` that way.
- **Emulator:** check the device emulator (`npm run emulator`) accepts the new fields. It should ignore fields it doesn't know.

## 4. What hasn't been tried yet

Run's finders were tested on the simulator only. Simulated frames covered:
- a turned steel plate, and a plate lighter or darker than its background;
- the head lamp's uneven light;
- brushed streaks and holes near the corners;
- the real camera's pixel size.

Corners came within 0.025 mm and holes within 0.001 mm. The corner finder also found no false corners in Ruby's three real mark photos from J0106.

These haven't been tried on Ruby with real steel:

- **How brushed stainless looks under the head lamp.** If it shines as brightly as the card, the hole or the edge loses contrast. Run accepts either way round, plate darker or lighter, but needs a clear difference.
- **Shadows from the plate's thickness.** If the lamp is off to one side, the 0.9 mm wall of a hole can shade part of the card under it, and a plate edge can shade the background beside it. That would move every mark by the same small amount (probably 0.1–0.4 mm). Holes would move the whole job slightly; corners on opposite sides of the plate would move in opposite directions.
- **Sheared plate edges.** They can carry a burr and be up to 0.5 mm off straight, and the corners aren't always square. Run logs each corner's edge angles, and warns when they differ from the corners' combined angle by more than 1°.

**Suggested first real check:** put an offcut with a cut hole on white paper. Run a small engrave job twice, once with a hole mark and once with a corner mark, then measure the etch against the hole and the edges.

## 5. Done means

- A job set to Holes or Plate corners sends packages that match `PROTOCOL.md`, and Run reads them without the operator doing anything.
- Older jobs and printed-dot jobs are unchanged.
- The Job page and Simulation page show the marks where Run will look for them.
- The checks and tips above are in place, and Prepare's self-test covers them.

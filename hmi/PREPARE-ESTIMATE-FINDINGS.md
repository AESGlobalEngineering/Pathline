# Time estimates: what Ruby's jobs show, for Pathline Prepare

From Pathline Run 0.7.13, 16 Nov 2026. Measured on the Trotec Q500 "Ruby" from Run's saved runs (`runs/*.json`: the controller's step markers and busy span), the job packages Prepare sent (`jobs/<id>/package.json`, each step's `seconds`) and Run's day logs. "Real" is the busy span: from the laser's first busy report to its last, after the marks are read.

## In short

| | Run's estimate | Prepare's estimate |
|---|---|---|
| Cutting jobs (Ruby's last 27 runs) | 1.11 % off (rms) | J0087: **+10 %** |
| Engraving jobs (J0093, J0094) | were +5.0 % and +5.7 %; −0.6 % and +0.9 % with the model below (Run 0.7.13) | **+1574 % and +1429 %** (about 16× too long) |
| Registration marks | learnt per machine (4.7 s now) | 1.5 s each, always |

The engraving error is one term, and it's the first thing to fix. Run now sends `markTime`, which Prepare already reads.

## 1. Engraving is 16× too long (fix first)

**The cause.** `lineTime()` in `src/shared/core.js` charges `2 · v / acc` per scan line for accelerating into and out of it. `acc` is what Run's `GET /machine` sends. On a Trotec that's the *equivalent travel acceleration*: the one value that times a short travel hop right when every move is timed with one acceleration and no jerk limit. It's 352 mm/s² on Ruby. At 493 mm/s that's 2.80 s per line. Ruby really spends about 0.10 s per line turning round. Over the job's 2966 lines, that one term is about 95 % of Prepare's figure.

The same `acc` gives an overscan of v²/2acc = 345 mm, which inflates the travel to each island (Prepare 22 s, Run 5 s).

**What the laser really does** (measured, both directions, ~500 mm/s, 18 engraving steps on two jobs plus the 16 steps of the 100–600 mm/s calibration job J0076):

- **Line spacing** is 25.4/DPI rounded *down* to the controller's 6 µm steps: 0.048 mm at 500 DPI, not 0.0508. That's 5 % more lines than 25.4/DPI gives.
- **Every line sweeps the whole island's box width plus 10 mm overscan each side**, whatever the artwork on that line. Prepare uses each line's own extent, about 2 mm on these jobs, with no overscan.
- **Each line costs a near-constant ~0.1 s on top of the sweep**: the turnaround. It isn't proportional to the line's length, and what's left after it is within ±3 ms per line.

Pathline Run 0.7.13 times engraving this way now (`ENGRAVE` in `run/src/ctrl/trotec/compile.js`). It was fitted on all 34 engraving steps of the three jobs, with each step's travel (timed separately) taken out of its real time: 2.2 % rms per step, and the job totals −0.6 % (J0093), +0.9 % (J0094) and −0.3 % (J0076's bars). Run's old constants ran the two jobs +5.0 % and +5.7 %.

```
p     = floor(25.4 / dpi / 0.006) · 0.006            line spacing, mm
lines = round(boxH / p)
W     = boxW + 2 · 10                                 each line as sent, mm (box and overscan)
time  = lines · ((W − 3.43) / v + 0.0902 + 2.295e-5 · v) + 0.203 s   per island, v in mm/s
        plus the travel to the island, as any travel
```

- **The sweep, `(W − 3.43) / v`.** The head covers each line as if the overscan were 8.3 mm, not the 10 mm sent. It's at speed sooner than the line's ends. A sweep factor (0.955 · W / v) fits the data just as well; the shorter overscan is the one kept because it leaves the head at the set speed. Which one is physically right is inferred, not measured.
- **The turn, `0.0902 + 2.295e-5 · v` per line:** 0.094 s at 200 mm/s, 0.102 s at 500.
- **0.203 s per island.** An earlier fit gave 0.32 s, but that included the travel to the island.

**For Prepare (Trotec, both directions):**

1. Don't use `info.acc` for an engraving line's turnaround or overscan. It's for travel only. PROTOCOL.md now says so under `GET /machine`.
2. Time each island with the formula above, the same one Run uses: box width plus 2 × 10 mm per line, and the line count from the 6 µm spacing.
3. One-way engraving hasn't been measured on Ruby. Keep the return stroke as it is until it is.

**What Prepare can't know.** Run places a print-and-cut job onto its marks. J0094's sheet lay rotated −46°, so its lines came out 2–4× wider than designed (step 1: 66 mm, not 31 mm), and the job ran longer than J0093. Run estimates again after placing, so the machine's own figure (Monitor, the screen) covers this. Prepare's figure can only assume the sheet lies square.

## 2. Registration marks: use `markTime`

| | Seconds per mark |
|---|---|
| Found by the camera, J0093 and J0094 | 2.0–3.3 |
| Found by hand (J0094 mark 2: the camera was jogged over it) | 74.8 |
| Earlier jobs, before Run 0.7.13 sped mark reading up | 7–9 |
| Prepare's default | 1.5 |
| Run's learnt `markSec` now | 4.7 |

Prepare already reads `info.markTime` and falls back to 1.5 s, but Run never sent it. **From Run 0.7.13, `GET /machine` sends `markTime`** whenever the camera is on. It's the seconds per mark as that machine has read them, learnt from its jobs and leaving out marks found by hand. It includes the short move between marks, so Prepare's own travel to each mark counts that move twice; that's under 0.5 s per mark. Nothing in Prepare needs to change for this.

## 3. Cutting and travel

- **Cutting (J0087 "Etch Calibration", 966 cut steps at 35 mm/s, no engraving):**

  | | Seconds | Off by |
  |---|---|---|
  | Real | 1358 | |
  | Run | 1346 | −0.9 % |
  | Prepare | 1494 | +10 % |

  Where Prepare's 10 % comes from hasn't been worked out. Both apps time travel as S-curves from `travelSpeed`, `travelAcc` and `jerk` (Prepare 1.6.0 on), so the place to look is the cutting itself. Run slows the head on curves (`cutProfile`: arcs 1000 mm/s², corners by angle) and sends runs of short segments as true arcs, which the Trotec takes about three times faster.
- **Run's own scales.** Over Ruby's last 27 completed runs, Run fits a scale to each part of its estimate:

  | Part | Scale |
  |---|---|
  | Cutting | ×0.993 |
  | Travel | ×1.057 |
  | Engraving | ×0.997 (×0.973 after J0093 and J0094) |

  These took Run's totals from 1.36 % to 1.11 % off (rms). The scales are small. Run's model was already close, and the travel figure is what a fixed per-move overhead looks like. They're specific to this machine and aren't sent.
- **Job order.** Run's route through each job was within 1–2 % of the shortest it could find, so there's little to gain from reordering in Prepare.

## 4. What changed in Run for this (0.7.13)

- `GET /machine` sends `markTime` (section 2).
- PROTOCOL.md says what a Trotec's `acc` is for (travel only) and what `markTime` is.
- Run's own estimate fits its cut, travel and engrave scales after every job (`timeScale`), and learns the time per mark.
- Run times engraving with the formula in section 1. The screen draws the head across each line at the sweep's pace and steps it down as it turns. Run's estimate fit now works every past job out again with the current model, placed where it was cut. On Ruby's last 26 runs that fit puts engraving at ×0.991, so the formula needs almost no machine scale.

## The data

- Jobs: J0093 and J0094 "Blank Test CUTready": 0.9 mm stainless, 9 raster islands, 500 DPI, both directions, no cutting, 493 and 501 mm/s, 16 Nov. Also J0087 (cutting only) and J0076 (engraving calibration, 100–600 mm/s).
- J0093 and J0094, measured from the step markers, which agree with the busy span to within 0.4 s:

  | Job | Sweeping at the set speed | Per-line overhead | Run's travel |
  |---|---|---|---|
  | J0093 | 181 s | 291 s | 5.3 s |
  | J0094 | 266 s | 260 s | |
- J0093's marks measured 7 % smaller than printed: the table wasn't focused on the sheet. It doesn't affect the times.

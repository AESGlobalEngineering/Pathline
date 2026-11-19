# Brief for Pathline Run: registration by part edges

From Pathline Prepare 1.6.19 (19 Nov 2026). This builds on plate corners (`RUN-PLATE-CORNERS-BRIEF.md`). Read that first.

## Why

The owner wants full printed sheets lined up without printed registration marks. The example job (`MOD-ACR-GSM_CUTready_X105`, Q-500) is 105 parts of 80 × 120 mm with 10 mm rounded corners, in a 15 × 7 grid, on 3 mm clear acrylic. The camera reads the **printed corners of the parts at the sheet's corners**, on the parts' own cut lines. The whole job is then fitted to those corners, the same way it is fitted to marks.

## What Prepare sends

The new mark type is `job.regKind: "edge"`, called **Part edges** in Prepare. `regMarks.kind` in the package is `"edge"`. Each `inspect` step is a plate corner, so the existing corner finder runs:

```json
{ "type": "inspect", "mark": 1, "of": 3, "at": [44.4, 46.4], "d": 0, "kind": "corner", "toward": [1, 1], "r": 10, "part": "emwnp53dl1gzqpk", "seconds": 4.7 }
```

- **`at`:** the corner of the part outline's bounding box. On a rounded corner, that's where the two straight edges would meet.
- **`toward`:** which way the part lies from that corner, along X and Y.
- **`r`:** the corner radius in mm.
- **`part`:** new. It's the entity id of the part whose corner this is. That part is cut as normal and appears in the toolpath as `cut` steps. Its outline isn't a mark object and mustn't be skipped.
- **Order:**
  - 3 corners: top left, bottom left, top right.
  - 2 corners: top left, bottom right.
  - 4 corners: the three above, then bottom right, for large sheets where the print may stretch.

`validate.js` already accepts these steps; Prepare's self-test checks it.

## What Run needs to do

1. **Find a printed edge, not a plate edge.** For plate corners, the plate stands out against white. Here the edge is the **edge of the print**, on material that may be clear. The operator's instructions are to print a sharp edge on the cut line at those parts, with no bleed past it, and to put white paper or card under those corners on clear material. The corner finder should:
   - accept a dark-on-light or light-on-dark edge;
   - fit the straight edges past the radius `r`, as in the plate-corners brief;
   - ignore texture beyond the edge, such as the honeycomb through clear acrylic, by fitting only strong straight runs along the expected directions.
2. **Fit all corners together.** Use the corners found like marks. With three or four corners, fit shift, rotation and scale, as Full linear does. Today Run fits plate corners by shift and turn only. Across a 1.3 m sheet, print stretch matters.
3. **Log** `part` and `r` in the `print and cut: corner` line, and give the residual when four corners are read.
4. **When a corner isn't found,** the jog dialog should say "the printed corner of the part at the top left" (and so on), rather than "the plate's corner".

## Check

- The X105 job from Prepare 1.6.19 with Part edges · 3 parts: three corner steps at (44.4, 46.4), (44.4, 882.9) and (1236.9, 46.4), each with r 10. `validate.check` passes.
- Simulator: a printed sheet turned 0.5° and stretched 0.1 % is placed within 0.1 mm at the far corner with four corners.
- Ruby or the Q-500: a printed test sheet with no bleed at the corner parts, on white card.

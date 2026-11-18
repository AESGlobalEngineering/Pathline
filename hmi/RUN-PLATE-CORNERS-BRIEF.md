# Brief for Pathline Run: plate corners from a drawn box, and rounded corners

From Pathline Prepare 1.6.16 (18 Nov 2026). This follows Run 0.7.13's mark kinds (`HANDOFF-prepare-mark-kinds.md`). Prepare sends plate corners a little differently from that handover's plan, and adds one field.

## What changed in Prepare

**Plate corners come from a box, not the sheet.** The owner didn't want the sheet used for this. The operator now draws the plate's outline as a box (a rectangle along X and Y) and gives it the Registration marks colour, the same way as dots and holes. Prepare sends the box's corners as `inspect` steps with `kind: "corner"` and `toward`, as in the handover. The mark ids are `<box id>-tl`, `-tr`, `-bl` and `-br`.

**Most of the owner's plates have rounded corners.** For those:

- `at` is the corner of the plate's **bounding box**: where its two straight edges would meet if they were extended. The plate itself doesn't reach that point; the corner is cut away by a radius.
- A new field, **`r`**, gives the corner radius in mm. It's measured from the drawing, to 0.1 mm, and is the same for every corner Prepare reads. `r: 0` (or no `r`) means a square corner.

```json
{ "type": "inspect", "mark": 1, "of": 3, "at": [50, 40], "d": 0, "kind": "corner", "toward": [1, 1], "r": 8, "seconds": 4.7 }
```

## What Run needs to do

1. **Accept `r`** on a corner step: a number of 0 or more. Older Prepare packages have no `r`; treat that as 0.
2. **Find a rounded corner by its straight edges.** Around `at`, the camera sees the two edges as straight lines until they get within `r` of the corner, then an arc joining them. The corner Run reports must be where the two straight edges' lines meet, not a point on the arc:
   - fit each straight edge using only the part more than about `r` (plus a margin) from `at`, along that edge, in the `toward` direction;
   - intersect the two lines;
   - leave the arc out of the fit.

   With `r` near 0 this is the same as the finder today.
3. **Field of view.** With a large radius, the straight parts of the edges start `r` from the corner. If the camera can't see enough straight edge (about 3 mm or more each way past the radius, say), say so in the jog dialog and the log rather than fit a curve.
4. **Logging.** Add `r` to the `print and cut: corner` log line, and log the angle between the two fitted edges as you do now.

## Check

- A Prepare 1.6.16 package for a rounded plate (`r` 8) passes `validate.js`. Prepare's self-test runs Run's `validate.check` on a corner package once `validate.js` knows `toward`.
- On the simulator: a plate with 8 mm corner radii, turned 2°, is placed to the same accuracy as a square plate (within 0.05 mm).
- On Ruby: an offcut with rounded corners on white paper, engraved with a corner mark, measured against its straight edges.

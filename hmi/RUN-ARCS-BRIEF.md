# Brief for Pathline Run: radii and curves crawl on the Trotec

**From:** the Pathline Prepare session, 4 Nov 2026. **For:** the Pathline Run chat (Trotec driver, `run/src/ctrl/trotec/`).

## The problem

The owner reports that on the Trotec Q500, the rounded corners of parts **cut very slowly**. This happens regardless of power correction, and it's much slower than Trotec's own software (Ruby) on the same shapes.

## Cause, as far as the Prepare side can see

- Pathline Prepare sends every cut as a polyline (`toolpath` steps of type `cut` with `p: [[x, y]…]`). Curves arrive as chains of short straight segments. In the reported job, a radius was 1 mm segments turning 3–6° at each joint, and small holes were 24 segments of 0.26 mm turning 15°. That's normal, fine tessellation.
- `ctrl/trotec/compile.js` sends each segment as its own `MOVEXY`, with a `commit()` after every one (`cut()`, the loop at about line 144).
- The planner limits Run sends (`PLANNER`, copied from Ruby's `PathPlanningParameter.json`) treat straight segments far more strictly than arcs. With **Standard**, `MaxCentrifugalAccVector` is **20** against `MaxCentrifugalAccArc` **200** and `MaxCentrifugalAccBezier` **300**.
  - Speed through a curve goes with √(a·r), so a radius made of vectors runs at about √(20/200) ≈ **⅓ of the speed** of the same radius sent as an arc.
  - Ruby presumably sends curves as arcs or Béziers, which is why it doesn't crawl.
- Prepare's own time estimate assumes the head keeps most of its speed through joints this gentle, so the estimate is also optimistic for curved parts on the Trotec until this is fixed.

## What to do, in order

1. **Quick test: does committing every move stop look-ahead?**
   - Send a run's `MOVEXY`s with a single `commit()` at the end (or every N moves, within the buffer limits), not after every segment.
   - Time a rounded rectangle before and after. If the Trotec was planning each committed move on its own, this alone may help a lot.
2. **Find Ruby's curve commands.**
   - Capture what Ruby sends for a job with a circle (Ø 20 mm), a rounded rectangle (40 × 30 mm, 3 mm corner radius) and a spline.
   - Look for the arc and Bézier move commands that `MaxCentrifugalAccArc` and `MaxCentrifugalAccBezier` apply to.
   - Add them to `sf.js` (`TT.…`) and document them in Run's protocol notes, as was done for `MOVEXY`.
3. **Send curves as arcs.**
   - In the plan for a cut run, fit arcs to chains of points: consecutive points on one circle within a small tolerance (e.g. 0.01 mm, Ruby's `MaxChordError` is 0.001), with at least 3 segments and turning the same way.
   - Send each fitted arc as an arc move and leave straight stretches as `MOVEXY`.
   - Keep the beam on through the whole run, as now.
   - This works on any input with no change to the package format: DXF arcs, circles, PDF/SVG curves and text all arrive as polylines.
4. **If arc commands can't be found:** with **Optimised** path planning (`Throughput`, vector limit 250) radii are already about 3.5× faster. The owner can use that as a stopgap: Advanced → Path planning → Optimised. Treat raising the vector limit under Standard as a last resort, and only with Ruby-like edge quality checked on material.

## Optional: arcs from Prepare

If fitting arcs in Run turns out unreliable, Prepare can add the original arcs to the package. For example, a cut step could carry `arcs: [{ from: i, to: j, c: [x, y], r, cw }]` alongside `p`, for the stretches that came from DXF arcs, circles and bulges. That needs Prepare's importers to keep arc data, so it's a bigger change. Ask the Prepare session if you need it; fitting in Run is preferred because it covers every source.

## Check it

1. Test shapes: a 40 × 30 mm rounded rectangle with 3 mm radius corners, a Ø 20 mm circle and a 10 mm square with sharp corners, at the same power and speed.
2. Compare the cut time against Ruby on the same shapes, before and after. The radii and circle should now take about as long as in Ruby.
3. Check that the sharp square isn't affected: it still slows properly at its 90° corners, and power correction still works there.
4. Run self-test: a 24-segment circle compiles to arc moves (or one arc), a rounded rectangle to 4 lines + 4 arcs, and a zig-zag stays as `MOVEXY`.
5. Tell the Prepare session when it's in, so its time estimate for curves can be compared with the machine.

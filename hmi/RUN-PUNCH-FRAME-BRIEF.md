# Brief for Pathline Run: punch steps, and frame path and speed

From Pathline Prepare 1.6.18 (18 Nov 2026). Prepare now sends two things Run needs to act on.

## 1. Punch (plotter)

A plotter process can now punch instead of cutting. This follows the controller's own Layer Parameter dialog: Processing mode **Punch**, a **punch tool**, **Punch space** (mm) and **Center punch**.

- **The process** (in `processes[]`) has `mode: "punch"`, `punchSpace` (mm, default 5) and `centre` (true/false). Its `tool` is the head, for example `"T3 · Punch 4 mm"`. Older packages have no `mode`; treat that as cutting.
- **The step.** Prepare sends a new step type in `toolpath`, one step per shape:

  ```json
  { "type": "punch", "process": 1, "name": "Holes", "tool": "T3", "ent": "e12", "bed": 0, "centre": true, "passes": 1, "seconds": 0.3, "p": [[40, 60]] }
  ```

  - `p` lists the strike points in order. Prepare has already worked them out:
    - **Spaced punching:** points along the line, no more than `punchSpace` apart. A closed line is divided evenly, so there is no double hit where it starts and ends.
    - **Centre punch** (`centre: true`): one point, the centre of the shape's box.
  - For each point: move there with the head up, then strike once (down, then up).
  - A `toolchange` step comes before it when the slot changes, the same as for cuts.
  - Treat a `punch` step like a `cut` for pause, stop, progress and the queue preview: draw each point as a ring.
- **Validator.** `run/src/job/validate.js` turns down step types it doesn't know, so today a job with a punch process is refused. Add `punch` to `STEP_TYPES`, check its `process` like a cut, and count a `punch` step as something to run (`nothingToRun`).
- **Timing.** Prepare times each strike at 0.3 s (`info.timing.punch`). If the machine reports `timing.punch` in /machine, Prepare uses that.
- **Up down punching** (in the controller dialog) isn't sent yet. Tell Prepare if Run needs it.

## 2. Frame

`POST /frame` now has two more fields:

```json
{ "box": [x0, y0, x1, y1], "path": [[x1, y0], [x1, y1], [x0, y1], [x0, y0], [x1, y0]], "speed": 1000 }
```

- **`path`:** trace these corners in order. The owner wants the frame to always start at the **top-right** corner and go **down, then left, up and right**. When `path` is missing (older Prepare), trace the box in that same order.
- **`speed`:** mm/s, the machine's travel speed. The owner reports that framing on the plotter is very slow, so frame at this speed, capped at the machine's own limit, rather than a slow default.

## Check

- `node tools/check-hmi.js --allow-motion` against the plotter: the frame visits top right → bottom right → bottom left → top left → top right, at the speed sent.
- A Prepare 1.6.18 package with a centre-punch process over four circles has four `punch` steps, and the emulator or simulator strikes once at each centre.

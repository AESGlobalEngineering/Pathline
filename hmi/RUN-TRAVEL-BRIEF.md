# Brief for Pathline Run: faster travel between cuts on the Trotec

**From:** the Pathline Prepare session, 5 Nov 2026. **For:** the Pathline Run chat (`run/src/ctrl/trotec/compile.js`).

## Why

The owner's X8 job (8 parts, 376 separate cut shapes, 218 of them 4 mm holes) takes about **160 s of travel against 436 s of cutting**. You measured the 160 s and modelled the travel (700 mm/s, 500 mm/s², jerk 5000 mm/s³, Ruby's Standard).

Prepare has now optimised the route as far as the geometry allows:
- Moves can't be reduced: 376 separate shapes need at least 376 runs, and there are 381 moves.
- Searching the order and start points harder moves the travel by about 1 %.
- Most hops are 2–40 mm. A short hop's time is set by the jerk limit, not the top speed: t ≈ (32·d / jerk)^⅓, so 7 mm takes 0.355 s.

So what's left is **how hard the head may accelerate with the beam off**.

## What travel would take with other limits

The same route (Prepare 1.6.2, All insides) re-timed with Prepare's S-curve model:

| Travel limits (beam off) | X8 travel | 7 mm hop |
|---|---|---|
| Standard (now): 700 mm/s, 500 mm/s², jerk 5000 | 160.9 s | 0.355 s |
| Throughput jerk (40 000), same speed and acc | 123.5 s (−37 s) | 0.249 s |
| Jerk 40 000 and tangential acc 1000 | 94.2 s (−67 s) | 0.194 s |

## What to do

1. In `cut()`, Run already switches `MaxTangentialAcc` between travel (`P[5]`, idle) and cutting (`P[6]`) for every run. Do the same with **`MaxTangentialJerk`**: use the **Throughput** value (40 000) for travel and put the cut planner's value back before the beam goes on.
   - These are Trotec's own planner sets, so the values are ones the machine is built for.
   - Cutting is unchanged: the cut planner's limits are in force whenever the beam is on.
2. Try a higher idle tangential acceleration for travel too (e.g. 1000). Check that the head doesn't lose position: repeat a job with registration marks, or cut a square, travel 100 hops and cut it again, and check the two match.
3. Check the Trotec takes the extra parameter changes without hesitating between runs. If each change costs time, change the jerk only once for a whole stretch of short hops.
4. Time the X8 job before and after; the table gives what to expect. Then update the travel figures Run sends Prepare, so its estimates follow:
   - send `travelSpeed`, `travelAcc` and `jerk` (HMI-BRIEF §5, read since Prepare 1.6.0) with the real travel values;
   - or update the equivalent `speed`/`acc`.

## Not needed from Prepare

Prepare already plans by travel time with the machine's figures. When Run reports the faster travel, Prepare's estimate and its choices (start points, order) follow by themselves.

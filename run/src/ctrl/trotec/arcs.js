// Curves back into arcs. Prepare sends every cut as a polyline, so a radius arrives as a chain of
// short straight segments. The Trotec's path planner holds straight segments to a much lower
// cornering acceleration than arcs (MaxCentrifugalAccVector 20 against MaxCentrifugalAccArc 200 in
// the Standard set), so a radius sent as segments runs at about a third of its speed as an arc.
// Ruby sends its curves as curves (on the Q500, cubic Béziers of 45°: TTCMD_CUBIC_BEZIER_ABSOLUTE in
// the vision capture of 2026-10-28). This finds the stretches of a polyline that lie on one circle
// and gives them back as arcs; compile.js sends each arc as Béziers the same way.
'use strict';

const LIMITS = {
  tol: 0.01, // every point within this of the circle, mm
  // Prepare splits a circle into 6 segments per mm of radius, 24 to 256 (dxf.js arcSteps): joints
  // of 15° at most, chords up to 0.075 mm inside a 1 m radius. A deliberate polygon has sharper
  // corners than that (an 18-gon turns 20°), or sides far off any circle
  sag: 0.1, // the most a chord may sit inside its arc, mm
  turn: (16 * Math.PI) / 180, // the sharpest joint inside an arc
  minSegs: 3, // fewer segments than this stay as lines
  maxR: 1000, // Ruby sends arcs only up to a 1 m radius
  minR: 0.05,
  maxSweep: Math.PI // longer curves become several arcs
};

// the circle through a, b and c (null when they're in a line)
function circle3(a, b, c) {
  const bx = b[0] - a[0], by = b[1] - a[1], cx = c[0] - a[0], cy = c[1] - a[1];
  const d = 2 * (bx * cy - by * cx);
  if (Math.abs(d) < 1e-12) return null;
  const b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
  const ux = (cy * b2 - by * c2) / d, uy = (bx * c2 - cx * b2) / d;
  return { c: [a[0] + ux, a[1] + uy], r: Math.hypot(ux, uy) };
}

// signed angle from u to v
const angle = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);

// pts: [[x, y]…] from the start of a cut run. Returns the moves after pts[0]:
//   { to: [x, y] }                     a straight segment
//   { to: [x, y], c: [x, y], r, sweep } an arc about c; sweep in radians, positive turning from +x
//                                       towards +y, in the coordinates given
function fitArcs(pts, opts = {}) {
  const L = { ...LIMITS, ...opts };
  // repeated points would give zero-length segments with no direction
  const p = [];
  for (const q of pts) if (!p.length || Math.hypot(q[0] - p[p.length - 1][0], q[1] - p[p.length - 1][1]) > 1e-6) p.push(q);
  const n = p.length;
  // turn at each inside point
  const turn = new Float64Array(n);
  for (let k = 1; k < n - 1; k++) turn[k] = angle(p[k][0] - p[k - 1][0], p[k][1] - p[k - 1][1], p[k + 1][0] - p[k][0], p[k + 1][1] - p[k][1]);

  // the arc from point i to point j, or null when those points aren't one
  const arcOf = (i, j) => {
    if (j - i < L.minSegs) return null;
    const s = Math.sign(turn[i + 1]);
    if (!s) return null;
    for (let k = i + 1; k < j; k++) if (Math.sign(turn[k]) !== s || Math.abs(turn[k]) > L.turn) return null;
    const C = circle3(p[i], p[(i + j) >> 1], p[j]);
    if (!C || C.r > L.maxR || C.r < L.minR) return null;
    let sweep = 0;
    for (let k = i; k <= j; k++) {
      if (Math.abs(Math.hypot(p[k][0] - C.c[0], p[k][1] - C.c[1]) - C.r) > L.tol) return null;
      if (k === j) break;
      const chord = Math.hypot(p[k + 1][0] - p[k][0], p[k + 1][1] - p[k][1]);
      if (chord > 2 * C.r || C.r - Math.sqrt(C.r * C.r - (chord * chord) / 4) > L.sag) return null;
      const a = angle(p[k][0] - C.c[0], p[k][1] - C.c[1], p[k + 1][0] - C.c[0], p[k + 1][1] - C.c[1]);
      if (Math.sign(a) !== s) return null;
      sweep += a;
    }
    if (Math.abs(sweep) > L.maxSweep + 1e-9) return null;
    return { to: p[j], c: C.c, r: C.r, sweep };
  };

  const out = [];
  let i = 0;
  while (i < n - 1) {
    let best = null, bj = i;
    for (let j = i + L.minSegs; j < n; j++) {
      const a = arcOf(i, j);
      if (!a) break;
      best = a; bj = j;
    }
    if (best) { out.push(best); i = bj; } else { out.push({ to: p[i + 1] }); i++; }
  }
  return out;
}

module.exports = { fitArcs, circle3, LIMITS };

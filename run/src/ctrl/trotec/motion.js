// How the Trotec moves between cuts, and how long that takes.
//
// The controller's path planner holds every move to the tangential acceleration and jerk it was
// last given (keys 261 / 262, mm/s² and mm/s³). Run sends Ruby's planner set for the material's
// path planning; travel used its idle values (Standard: 500 mm/s², jerk 5000). Measured against
// the real run times of the jobs cut since 0.7.11 (2026-11-04/05: X8 screens at 34 and 38 mm/s,
// MODULA_4), an S-curve over those limits gives every job to within 1–4 %, so these are the
// machine's real travel limits. Most moves between cuts are a few mm, so the jerk decides how long
// they take, not the speed: a 7 mm hop takes 0.35 s at jerk 5000 whatever the travel speed is set to.
'use strict';

// travel profiles (Setup → Machine → Travel between cuts). Standard is what Ruby sends.
// Faster: Ruby's own jerk for positioning moves and for the Y axis when engraving (10000).
// Fastest: beyond anything Ruby sends for travel; check the bed or a print and cut job after using it.
const TRAVEL = {
  standard: null,
  faster: { a: 500, j: 10000, v: 700 },
  fastest: { a: 1000, j: 20000, v: 1000 }
};

// the travel limits for a planner set ([.., tanAcc idle (5), tanAcc cut (6), jerk (7), ..]) and travel speed
function travelLimits(cfg, planner, travelSpeed) {
  const t = (cfg && cfg.trotec) || {};
  const p = TRAVEL[t.travel] || null;
  if (!p) return { a: planner[5], j: planner[7], v: travelSpeed };
  return { a: Math.max(p.a, planner[5]), j: Math.max(p.j, planner[7]), v: Math.max(p.v, travelSpeed) };
}

// rest-to-rest time over d mm with speed v, acceleration a and jerk j (an S-curve)
function moveTime(d, v, a, j) {
  if (!(d > 0)) return 0;
  // speed u reached and dropped back: time and distance of one ramp 0 → u
  const ramp = (u) => {
    const t = u <= (a * a) / j ? 2 * Math.sqrt(u / j) : u / a + a / j;
    return { t, s: (u * t) / 2 };
  };
  const top = ramp(v);
  if (2 * top.s <= d) return 2 * top.t + (d - 2 * top.s) / v;
  let lo = 0, hi = v;
  for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (2 * ramp(m).s > d) hi = m; else lo = m; }
  return 2 * ramp(lo).t;
}

// For Pathline Prepare's estimate (GET /machine), which times travel at one acceleration without a
// jerk limit: the acceleration that gives the same time over a typical 10 mm move between cuts
function equivalentAcc(lim) {
  const t = moveTime(10, lim.v, lim.a, lim.j);
  return Math.round((4 * 10) / (t * t));
}

module.exports = { TRAVEL, travelLimits, moveTime, equivalentAcc };

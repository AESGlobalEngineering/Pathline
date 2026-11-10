// The nozzle's height along a job: where the head Z axis should be at each moment of the job's
// route (ui/follow.js times the route; the server follows the head along it).
//
// pos is mm down from the top end stop (PROTOCOL.md); ref is the pos focused over the reference
// point, so over a sheet h mm higher the nozzle is focused at pos = ref − h.
//  - cutting (and engraving): focused, pos = ref − h(beam)
//  - travel between cuts: `lift` mm higher than the higher of its two ends
//  - never deeper than the map allows anywhere within ±window s of route time: if the drawing is
//    early or late by up to that, the nozzle is high, not low (deep = ref + (gap − gapMin) − the
//    highest h in the window)
//  - then limited to vmax: a change too fast to follow starts early, and only ever upwards
// Between 0 (top) and bottom (the deepest the axis may go).
'use strict';

const F = require('../../ui/follow');
const mesh = require('./mesh');

// vmax: the plan's speed, two thirds of the axis's 15 mm/s, so the axis can catch up (at full
// speed it trailed a rising sheet on a 400 mm/s job); margin: room for the axis trailing the plan
// (it did by 0.05 mm, which took the gap under gapMin on that job)
// extend: how far past the scanned grid the map's edge is taken as the sheet (the sensor sits
// beside the nozzle, so it can't reach the bed's edge strip the nozzle can; a sheet doesn't
// bend much in 20 mm)
const DEFAULTS = { dt: 0.02, lift: 1, window: 0.5, gap: 2, gapMin: 0.8, margin: 0.2, vmax: 10, bottom: 8, extend: 20 };

// route: F.routeOf(...); m: the height map; o: { ref, ...DEFAULTS }
function plan(route, m, o) {
  o = { ...DEFAULTS, ...o };
  const n = Math.max(2, Math.ceil(route.end / o.dt) + 1);
  const need = new Float32Array(n), h = new Float32Array(n), kind = new Uint8Array(n); // 1 cut, 2 travel/wait, 0 outside the map
  let outside = 0, cutSamples = 0, worstOut = null;
  const gx1 = m.x0 + (m.nx - 1) * m.dx, gy1 = m.y0 + (m.ny - 1) * m.dy;
  const outBy = (x, y) => Math.max(m.x0 - x, x - gx1, m.y0 - y, y - gy1, 0);
  // walk the route once
  let k = 0;
  const segs = route.segs;
  for (let s = 0; s < n; s++) {
    const t = s * o.dt;
    while (k + 1 < segs.length && segs[k + 1].t0 <= t) k++;
    const g = segs[k], u = Math.max(0, Math.min(1, (t - g.t0) / g.dt));
    const x = g.a[0] + (g.b[0] - g.a[0]) * u, y = g.a[1] + (g.b[1] - g.a[1]) * u;
    const cutting = g.kind === 'cut' || g.kind === 'row';
    const known = mesh.inside(m, x, y, o.extend);
    h[s] = mesh.height(m, x, y);
    if (cutting) {
      cutSamples++;
      if (!known) { outside++; const d = outBy(x, y); if (!worstOut || d > worstOut.by) worstOut = { by: +d.toFixed(1), x: +x.toFixed(1), y: +y.toFixed(1) }; }
    }
    kind[s] = cutting ? (known ? 1 : 0) : 2;
    need[s] = cutting && known ? o.ref - h[s] : NaN;
  }
  // travel (and waits): at the higher end's height, lifted `lift` mm in the middle when there's
  // time to rise after the cut ends and be down again before the next one starts (a lift held to
  // the travel's ends left the nozzle coming down while the next cut began: 12 % of the cutting
  // over 0.3 mm from focus on the Q500 runs, 0.8 % without)
  const ramp = Math.round((o.lift / o.vmax + 0.1) / o.dt);
  for (let s = 0; s < n;) {
    if (kind[s] !== 2) { s++; continue; }
    let e = s;
    while (e < n && kind[e] === 2) e++;
    const a = s > 0 && Number.isFinite(need[s - 1]) ? need[s - 1] : 0, b = e < n && Number.isFinite(need[e]) ? need[e] : 0;
    if (o.lift > 0 && e - s > 2 * ramp + 2) {
      // long enough: the last cut's height, lifted above both, then the next cut's height
      const lifted = Math.max(0, Math.min(a, b) - o.lift);
      for (let i = s; i < e; i++) need[i] = i < s + ramp ? a : i >= e - ramp ? b : lifted;
    } else {
      // a short hop: the deeper end's height all the way (the speed passes below rise in time
      // and come down slowly; `deep` keeps it clear of the sheet in between)
      for (let i = s; i < e; i++) need[i] = Math.max(a, b);
    }
    s = e;
  }
  // what the axis can't reach while cutting: a sheet higher than the axis can rise above it (the
  // nozzle would stay too low: a crash), or lower than it can go down (out of focus). Checked
  // before the job starts
  let tooHigh = 0, tooLow = 0, worstHigh = 0, worstLow = 0;
  for (let s = 0; s < n; s++) {
    if (kind[s] !== 1) continue;
    const clear = o.ref + (o.gap - o.gapMin - o.margin) - h[s];
    if (need[s] < 0 || clear < 0) { tooHigh++; worstHigh = Math.max(worstHigh, -Math.min(need[s], clear)); }
    if (need[s] > o.bottom) { tooLow++; worstLow = Math.max(worstLow, need[s] - o.bottom); }
  }
  // cuts outside the map: at the top (no focus, but no crash); start() refuses such a job
  for (let s = 0; s < n; s++) if (!Number.isFinite(need[s])) need[s] = 0;
  // the deepest allowed: the highest sheet within ±window (a sliding maximum)
  const w = Math.max(1, Math.round(o.window / o.dt));
  const deep = new Float32Array(n);
  {
    const dq = [];
    // deque over h for the window [s − w, s + w]
    let r = 0;
    for (let s = 0; s < n; s++) {
      while (r < n && r <= s + w) { while (dq.length && h[dq[dq.length - 1]] <= h[r]) dq.pop(); dq.push(r); r++; }
      while (dq[0] < s - w) dq.shift();
      deep[s] = o.ref + (o.gap - o.gapMin - o.margin) - h[dq[0]];
    }
  }
  const pos = new Float32Array(n);
  for (let s = 0; s < n; s++) pos[s] = Math.max(0, Math.min(o.bottom, need[s], deep[s]));
  // speed: a rise too fast to follow starts early (backwards), a drop is slowed (forwards); both
  // only ever raise the nozzle
  const step = o.vmax * o.dt;
  for (let s = n - 2; s >= 0; s--) pos[s] = Math.min(pos[s], pos[s + 1] + step);
  for (let s = 1; s < n; s++) pos[s] = Math.min(pos[s], pos[s - 1] + step);
  // how far from focus the plan is while cutting (the price of the limits)
  let off = 0, offN = 0;
  for (let s = 0; s < n; s++) if (kind[s] === 1) { const e = Math.abs(pos[s] - (o.ref - h[s])); off = Math.max(off, e); offN += e > 0.2 ? 1 : 0; }
  return {
    dt: o.dt, n, pos, h, kind, opts: o, outside, worstOut, cutSamples, focusWorst: +off.toFixed(3), focusOver02: cutSamples ? +(offN / cutSamples).toFixed(4) : 0,
    reach: { tooHigh, tooLow, worstHigh: +worstHigh.toFixed(2), worstLow: +worstLow.toFixed(2) }
  };
}

// Why a planned job can't be followed (null when it can): in the operator's terms
function refusal(p) {
  if (p.outside) {
    const w = p.worstOut;
    return 'Part of the job is outside the height map' + (w ? ': at X ' + w.x + ', Y ' + w.y + ' it\'s ' + Math.round(w.by) + ' mm past what was scanned' : '') +
      '. Scan the sheet again (Z axis → Scan) with this job on it. If it still doesn\'t reach, that part is too near the bed\'s edge for the sensor, which sits beside the nozzle: move the job in from the edge in Prepare.';
  }
  if (p.reach.tooHigh) return 'The sheet is too high for the Z axis in places: ' + p.reach.worstHigh.toFixed(1) + ' mm more than the nozzle can rise above it. Flatten or weigh down the sheet, or set focus with the nozzle lower (Z axis → Set focus).';
  if (p.reach.tooLow) return 'The sheet is too low for the Z axis to focus in places (' + p.reach.worstLow.toFixed(1) + ' mm below what it can reach). Set focus with the nozzle higher (Z axis → Set focus).';
  return null;
}

// The planned pos at route time t (s)
function at(p, t) {
  const f = Math.max(0, Math.min(p.n - 1, t / p.dt)), i = Math.min(p.n - 2, Math.floor(f)), u = f - i;
  return p.pos[i] * (1 - u) + p.pos[i + 1] * u;
}

// The highest (smallest) planned pos over route times [t0, t1]
function highest(p, t0, t1) {
  let lo = Infinity;
  const a = Math.max(0, Math.floor(t0 / p.dt)), b = Math.min(p.n - 1, Math.ceil(t1 / p.dt));
  for (let i = a; i <= b; i++) lo = Math.min(lo, p.pos[i]);
  return Number.isFinite(lo) ? lo : 0;
}

module.exports = { plan, at, highest, refusal, DEFAULTS, F };

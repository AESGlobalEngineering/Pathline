// Turns a Pathline job package (PROTOCOL.md) into a controller-neutral plan.
// Everything stays in bed millimetres: origin top left, Y towards the front.
// The controller compilers (src/ctrl/*) turn the plan into machine code.
//
// plan = { name, procs: { [index]: proc }, steps: [...], seconds, warnings }
// steps, in run order, one per toolpath step:
//   { op: 'cut',     i, proc, runs: [[[x, y]…]…], seconds }   beam on along each run, travel between runs (links already applied)
//   { op: 'engrave', i, proc, paths, box, dpi, down, bidi, seconds }
//   { op: 'dwell',   i, seconds }
//   { op: 'inspect', i, at, d, mark, of, seconds }
'use strict';

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// Process settings, normalised. `adv` holds only the values the operator changed.
function normProc(p) {
  const adv = p.adv || {};
  const engrave = p.proc === 'Engrave';
  return {
    index: p.index,
    name: p.name || (engrave ? 'Engrave' : 'Cut'),
    kind: engrave ? 'engrave' : 'cut',
    power: Math.max(0, Math.min(100, num(p.power, 0))),
    speed: num(p.speed, 10),
    freq: engrave ? null : num(p.f, 5000),
    dpi: engrave ? num(p.f, 500) : null,
    air: p.air === 'On',
    dash: !!p.dash && num(p.dl, 0) > 0 && num(p.gl, 0) > 0,
    dl: num(p.dl, 0),
    gl: num(p.gl, 0),
    aci: Array.isArray(p.aci) ? p.aci : [],
    powerCorrection: adv['Power correction'] !== undefined ? Number(adv['Power correction']) : null,
    planning: adv['Path planning'] || 'Standard',
    overshoot: num(Number(adv['Extended overshoot']), 0)
  };
}

// Split a polyline into the parts where the beam is on: dl mm on, gl mm off, repeated.
function dashRuns(pts, dl, gl) {
  const runs = [];
  let on = true;
  let left = dl;
  let cur = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    let [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    let segLen = Math.hypot(bx - ax, by - ay);
    while (segLen > 1e-9) {
      if (segLen < left) {
        left -= segLen;
        if (on) cur.push([bx, by]);
        break;
      }
      const t = left / segLen;
      const px = ax + (bx - ax) * t;
      const py = ay + (by - ay) * t;
      if (on) { cur.push([px, py]); runs.push(cur); } else cur = [[px, py]];
      on = !on;
      left = on ? dl : gl;
      segLen -= Math.hypot(px - ax, py - ay);
      ax = px; ay = py;
    }
  }
  if (on && cur.length > 1) runs.push(cur);
  return runs;
}

function build(pkg) {
  const procs = {};
  for (const p of pkg.processes || []) procs[p.index] = normProc(p);
  const ents = new Map((pkg.entities || []).map((e) => [e.id, e]));
  const warnings = [];
  const steps = [];
  (pkg.toolpath || []).forEach((s, i) => {
    const seconds = num(s.seconds, 0);
    if (s.type === 'cut') {
      const proc = procs[s.process];
      const pts = (s.p || []).slice();
      if (s.closed && pts.length > 1) {
        const [x0, y0] = pts[0];
        const [xn, yn] = pts[pts.length - 1];
        if (x0 !== xn || y0 !== yn) pts.push([x0, y0]);
      }
      if (pts.length < 2) return;
      steps.push({ op: 'cut', i, proc, runs: proc.dash ? dashRuns(pts, proc.dl, proc.gl) : [pts], seconds, name: s.name });
    } else if (s.type === 'engrave') {
      const proc = procs[s.process];
      const paths = [];
      for (const id of s.ents || []) {
        const e = ents.get(id);
        if (!e) { warnings.push('Engrave step ' + (i + 1) + ': shape ' + id + ' is missing'); continue; }
        for (const p of e.paths || []) paths.push({ p: p.p, c: !!p.c, ent: id });
      }
      steps.push({
        op: 'engrave', i, proc, paths, box: s.box, dpi: num(s.dpi, proc.dpi || 500),
        down: s.direction !== 'up', bidi: s.bidirectional !== false, seconds, name: s.name
      });
    } else if (s.type === 'dwell') {
      steps.push({ op: 'dwell', i, seconds });
    } else if (s.type === 'inspect') {
      steps.push({ op: 'inspect', i, at: s.at, d: s.d, mark: s.mark, of: s.of, seconds });
    }
  });
  const seconds = steps.reduce((a, s) => a + s.seconds, 0);
  return { name: (pkg.job && pkg.job.name) || 'Job', procs, steps, seconds, warnings };
}

// Raster: horizontal scan lines `pitch` mm apart covering `box`, each with the
// x intervals where the beam is on. Closed paths fill even-odd per shape and the
// shapes are then merged. Open paths engrave a band one line wide.
function scanLines(step, pitch) {
  const [, y0, , y1] = step.box;
  const byEnt = new Map();
  const open = [];
  for (const p of step.paths) {
    if (p.c) {
      if (!byEnt.has(p.ent)) byEnt.set(p.ent, []);
      byEnt.get(p.ent).push(p.p);
    } else open.push(p.p);
  }
  const lines = [];
  const n = Math.max(1, Math.round((y1 - y0) / pitch));
  for (let k = 0; k < n; k++) {
    const y = y0 + (k + 0.5) * pitch;
    let spans = [];
    for (const polys of byEnt.values()) {
      const xs = [];
      for (const poly of polys) {
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i];
          const b = poly[(i + 1) % poly.length];
          if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
        }
      }
      xs.sort((u, v) => u - v);
      for (let i = 0; i + 1 < xs.length; i += 2) spans.push([xs[i], xs[i + 1]]);
    }
    for (const poly of open) {
      for (let i = 0; i + 1 < poly.length; i++) {
        const seg = clipToBand(poly[i], poly[i + 1], y - pitch / 2, y + pitch / 2);
        if (seg) spans.push([Math.min(seg[0], seg[1]) - pitch / 2, Math.max(seg[0], seg[1]) + pitch / 2]);
      }
    }
    spans = merge(spans);
    if (spans.length) lines.push({ y, spans });
  }
  if (!step.down) lines.reverse();
  return lines;
}

// x range of segment a-b inside the horizontal band lo <= y < hi, or null
function clipToBand(a, b, lo, hi) {
  let t0 = 0, t1 = 1;
  const dy = b[1] - a[1];
  if (Math.abs(dy) < 1e-12) {
    if (a[1] < lo || a[1] >= hi) return null;
  } else {
    let ta = (lo - a[1]) / dy, tb = (hi - a[1]) / dy;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return null;
  }
  const x = (t) => a[0] + (b[0] - a[0]) * t;
  return [x(t0), x(t1)];
}

function merge(spans) {
  spans.sort((u, v) => u[0] - v[0]);
  const out = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else out.push([s[0], s[1]]);
  }
  return out;
}

// Points along the plan for the on-screen head trace (sim mode and preview).
function trace(step) {
  if (step.op === 'cut') return [].concat(...step.runs);
  if (step.op === 'engrave') {
    const [x0, y0, x1, y1] = step.box;
    return step.down ? [[x0, y0], [x1, y0], [x0, y1], [x1, y1]] : [[x0, y1], [x1, y1], [x0, y0], [x1, y0]];
  }
  if (step.op === 'inspect') return [step.at];
  return [];
}

module.exports = { build, normProc, dashRuns, scanLines, merge, trace };

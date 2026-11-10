// The sheet's height map, from the ultrasonic sensor's readings on a grid.
//
// A reading is the sensor's distance to the sheet; height h = dRef − distance (mm, + = the sheet
// is higher than where focus was set). The sensor sees a patch ~10–15 mm across, so a reading
// near the sheet's edge, a hole or a part already cut is wrong: a point that disagrees with the
// median of its neighbours by more than `tol` is dropped, and gaps are filled from neighbours.
// Between points: bilinear. Outside the grid: the nearest edge, flagged (inside() is false).
'use strict';

// points: [{ x, y, d }] (bed mm where the sensor read, distance mm); grid: { x0, y0, dx, dy, nx, ny }
function build(points, grid, opts = {}) {
  const tol = opts.tol === undefined ? 0.6 : opts.tol;
  const dRef = opts.dRef;
  const { x0, y0, dx, dy, nx, ny } = grid;
  const h = new Array(nx * ny).fill(NaN);
  const sum = new Array(nx * ny).fill(0), cnt = new Array(nx * ny).fill(0);
  for (const p of points) {
    const i = Math.round((p.x - x0) / dx), j = Math.round((p.y - y0) / dy);
    if (i < 0 || j < 0 || i >= nx || j >= ny || !Number.isFinite(p.d)) continue;
    sum[j * nx + i] += dRef - p.d; cnt[j * nx + i]++;
  }
  for (let k = 0; k < h.length; k++) if (cnt[k]) h[k] = sum[k] / cnt[k];
  const at = (i, j) => (i >= 0 && j >= 0 && i < nx && j < ny ? h[j * nx + i] : NaN);
  // outliers: against the median of the 8 neighbours (needs 3 of them)
  const dropped = [];
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
  const keep = h.slice();
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const v = at(i, j);
    if (!Number.isFinite(v)) continue;
    const nb = [];
    for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) if (a || b) { const w = at(i + a, j + b); if (Number.isFinite(w)) nb.push(w); }
    if (nb.length >= 3 && Math.abs(v - med(nb)) > tol) { keep[j * nx + i] = NaN; dropped.push({ x: x0 + i * dx, y: y0 + j * dy, h: +v.toFixed(3) }); }
  }
  // gaps: the mean of the known neighbours, repeated until full (or nothing known)
  const out = keep.slice();
  for (let pass = 0; pass < nx + ny; pass++) {
    let missing = 0;
    const next = out.slice();
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      if (Number.isFinite(out[j * nx + i])) continue;
      let s = 0, c = 0;
      for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) if (a || b) { const ii = i + a, jj = j + b; if (ii >= 0 && jj >= 0 && ii < nx && jj < ny && Number.isFinite(out[jj * nx + ii])) { s += out[jj * nx + ii]; c++; } }
      if (c) next[j * nx + i] = s / c; else missing++;
    }
    for (let k = 0; k < out.length; k++) out[k] = next[k];
    if (!missing) break;
  }
  const filled = out.filter((v, k) => Number.isFinite(v) && !Number.isFinite(keep[k])).length;
  return finish({ ...grid, h: out.map((v) => (Number.isFinite(v) ? +v.toFixed(3) : 0)), dRef, dropped, filled, n: points.length, at: new Date().toISOString() });
}

// stats: height range and the steepest slope between neighbours
function finish(m) {
  const { nx, ny, dx, dy, h } = m;
  let lo = Infinity, hi = -Infinity, slope = 0;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const v = h[j * nx + i];
    lo = Math.min(lo, v); hi = Math.max(hi, v);
    if (i + 1 < nx) slope = Math.max(slope, Math.abs(h[j * nx + i + 1] - v) / dx);
    if (j + 1 < ny) slope = Math.max(slope, Math.abs(h[(j + 1) * nx + i] - v) / dy);
  }
  return { ...m, min: +lo.toFixed(3), max: +hi.toFixed(3), slope: +slope.toFixed(4) };
}

// The height at bed point (x, y): bilinear inside, the nearest edge outside
function height(m, x, y) {
  const fx = Math.max(0, Math.min(m.nx - 1, (x - m.x0) / m.dx)), fy = Math.max(0, Math.min(m.ny - 1, (y - m.y0) / m.dy));
  const i = Math.min(m.nx - 2, Math.floor(fx)), j = Math.min(m.ny - 2, Math.floor(fy));
  if (m.nx < 2 || m.ny < 2) return m.h[0] || 0;
  const u = fx - i, v = fy - j, H = (a, b) => m.h[b * m.nx + a];
  return (1 - u) * (1 - v) * H(i, j) + u * (1 - v) * H(i + 1, j) + (1 - u) * v * H(i, j + 1) + u * v * H(i + 1, j + 1);
}

// Whether (x, y) is inside the grid (with `slack` mm round it)
const inside = (m, x, y, slack = 0) => x >= m.x0 - slack && y >= m.y0 - slack && x <= m.x0 + (m.nx - 1) * m.dx + slack && y <= m.y0 + (m.ny - 1) * m.dy + slack;

// The grid to scan for a job: its box (bed mm, [x0, y0, x1, y1]) plus a margin, kept inside
// where the sensor can reach (reach: [x0, y0, x1, y1]), at about `step` mm
function gridFor(box, step, margin, reach) {
  let [x0, y0, x1, y1] = [box[0] - margin, box[1] - margin, box[2] + margin, box[3] + margin];
  if (reach) { x0 = Math.max(x0, reach[0]); y0 = Math.max(y0, reach[1]); x1 = Math.min(x1, reach[2]); y1 = Math.min(y1, reach[3]); }
  const nx = Math.max(2, Math.ceil((x1 - x0) / step) + 1), ny = Math.max(2, Math.ceil((y1 - y0) / step) + 1);
  return { x0, y0, dx: (x1 - x0) / (nx - 1), dy: (y1 - y0) / (ny - 1), nx, ny };
}

// The order to visit the grid: rows, every other one backwards (the shortest way round)
function scanOrder(g) {
  const out = [];
  for (let j = 0; j < g.ny; j++) for (let k = 0; k < g.nx; k++) { const i = j % 2 ? g.nx - 1 - k : k; out.push({ i, j, x: g.x0 + i * g.dx, y: g.y0 + j * g.dy }); }
  return out;
}

module.exports = { build, finish, height, inside, gridFor, scanOrder };

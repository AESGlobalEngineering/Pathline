// Part edges: a printed part's corner read as its whole outline (Prepare's Part edges, regMarks.kind
// 'edge'). The corner is where the part's two straight edges meet; with a rounded corner (radius r)
// the print never reaches it, and its straight edges only start r past it.
//
// Why not two straight lines (detect.findPlateCorner): on the Q500 (J0115, 20 Nov), each edge was a
// few mm of straight print past a 10 mm rounding, fitted on its own and carried 10 mm to where the
// two meet; three pictures from the same place gave corners 0.45 mm apart, and moving the camera
// 2–3 mm moved them up to 0.9 mm. And the camera's scale on the print isn't its calibration's: the
// print lies at another height (printed under the clear sheet, or the table not on it), 1–6 %
// different corner to corner on that sheet (lining up pictures taken with the head moved a known
// way said the same). A corner measured 10 mm from the picture's middle was pulled up to 0.5 mm
// towards it.
//
// So: locate() finds where the corner is in the picture, from the outline's shape (its straight
// edges and the arc), wherever it is, or just past the picture's side (the camera is then re-aimed
// on it); fit() fits the outline, two straight edges at right angles and the arc between, to the
// print's edge found across it at every 0.1 mm. Read with the corner in the middle of the picture,
// the camera's scale, a small turn of its calibration and any stretch all leave the corner where it
// is (lines through the middle stay through the middle); the arc's radius is left free (the scale
// shows in it: a 10 mm rounding read 9.25–10.2 mm on that sheet), and the edges' turn can be held at
// what all the job's corners say (Vision.readMarks), as a few mm of straight edge give it poorly.
// On J0115: each corner the same within 2–10 µm picture to picture and round to round; the sheet's
// opposite edges parallel within 0.025°, its width as the job's within 3 µm.
//
// Everything in bed mm round the picture's middle, through the camera's matrix M (pixel → mm).
'use strict';

const detect = require('./detect');

function frame(img, M) {
  const det = M[0] * M[3] - M[1] * M[2];
  if (!det) return null;
  const Mi = [M[3] / det, -M[1] / det, -M[2] / det, M[0] / det];
  const { w, h, data } = img;
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const toPx = (X, Y) => [cx + Mi[0] * X + Mi[1] * Y, cy + Mi[2] * X + Mi[3] * Y];
  // brightness at a bed point (bilinear), NaN off the picture (2 px kept clear of its side)
  const at = (X, Y) => {
    const u = cx + Mi[0] * X + Mi[1] * Y, v = cy + Mi[2] * X + Mi[3] * Y;
    if (!(u >= 2 && v >= 2 && u <= w - 3 && v <= h - 3)) return NaN;
    const x0 = u | 0, y0 = v | 0, fx = u - x0, fy = v - y0, i = y0 * w + x0;
    return data[i] * (1 - fx) * (1 - fy) + data[i + 1] * fx * (1 - fy) + data[i + w] * (1 - fx) * fy + data[i + w + 1] * fx * fy;
  };
  const px = Math.sqrt(Math.abs(det));
  // how far the picture reaches from its middle along bed X and Y
  const half = [(Math.abs(M[0]) * w + Math.abs(M[1]) * h) / 2, (Math.abs(M[2]) * w + Math.abs(M[3]) * h) / 2];
  return { at, toPx, px, half };
}

// The outline near the corner in the part's own terms: a (into the part along its X), b (along its
// Y), with the inward normal; `len` mm of each straight edge past the arc, a point every `step` mm
function outlinePts(r, len, step) {
  const pts = [];
  for (let t = len; t > 0; t -= step) pts.push({ a: r + t, b: 0, na: 0, nb: 1, arc: null });
  if (r > 0) {
    const n = Math.max(4, Math.ceil(((Math.PI / 2) * r) / step));
    for (let k = 0; k <= n; k++) { const th = (k / n) * (Math.PI / 2); pts.push({ a: r - r * Math.cos(th), b: r - r * Math.sin(th), na: Math.cos(th), nb: Math.sin(th), arc: th }); }
  }
  for (let t = step; t <= len; t += step) pts.push({ a: 0, b: r + t, na: 1, nb: 0, arc: null });
  return pts;
}

// Where is the corner? Every place it could be (a 0.5 mm grid over the picture and r + 5 mm past
// it), the outline (5 mm of each straight edge and the arc) laid there; just inside it against
// just outside it (0.4 and 0.9 mm each way), steady all along it (a corner, not a patch of one
// edge or the card's side). opts.dark: true / false to take only a print darker / lighter than
// past it (known after the job's first corner). Returns the best { c: [X, Y] mm from the middle,
// value, seen (the share of the outline in the picture), dark } or null.
// (A shrunk copy, ~400 px across: about 0.2 s for a 5 MP picture)
function locate(img, M, toward, r, opts = {}) {
  const sm = detect.shrink(img, opts.size || 400);
  const k = img.w / sm.w;
  const F = frame(sm, M.map((v) => v * k));
  if (!F) return null;
  const { at } = F;
  const vals = Float32Array.from(sm.data).sort();
  const span = Math.max(8, vals[Math.floor(vals.length * 0.97)] - vals[Math.floor(vals.length * 0.03)]);
  const [sx, sy] = toward;
  const R = Math.max(0, Number(r) || 0), len = 5;
  const P = outlinePts(R, len, Math.max(0.25, F.px));
  const offs = [0.4, 0.9];
  const score = (cX, cY) => {
    let s = 0, ss = 0, n = 0;
    for (const p of P) {
      let d = 0, m = 0;
      for (const o of offs) {
        const vi = at(cX + sx * (p.a + p.na * o), cY + sy * (p.b + p.nb * o)), vo = at(cX + sx * (p.a - p.na * o), cY + sy * (p.b - p.nb * o));
        if (vi !== vi || vo !== vo) continue;
        d += vo - vi; m++;
      }
      if (!m) continue;
      s += d / m; ss += (d / m) ** 2; n++;
    }
    if (n < 0.45 * P.length) return null;
    const mean = s / n, sd = Math.sqrt(Math.max(0, ss / n - mean * mean));
    if (opts.dark === true && mean < 0) return null;
    if (opts.dark === false && mean > 0) return null;
    const steady = Math.abs(mean) / (sd + 0.1 * span);
    return { c: [cX, cY], step: mean / span, seen: n / P.length, value: (Math.abs(mean) / span) * Math.min(1, steady) * Math.sqrt(n / P.length) };
  };
  const g = 0.5, rx = F.half[0] + len + R, ry = F.half[1] + len + R;
  let best = null;
  for (let X = -rx; X <= rx; X += g) for (let Y = -ry; Y <= ry; Y += g) { const q = score(X, Y); if (q && (!best || q.value > best.value)) best = q; }
  if (!best) return null;
  const c0 = best.c;
  for (let X = c0[0] - g; X <= c0[0] + g + 1e-9; X += g / 5) for (let Y = c0[1] - g; Y <= c0[1] + g + 1e-9; Y += g / 5) { const q = score(X, Y); if (q && q.value > best.value) best = q; }
  return { c: best.c, value: +best.value.toFixed(3), seen: +best.seen.toFixed(2), dark: best.step > 0 };
}

// The outline fitted: corner (X, Y), turn theta and, with opts.fitR, the radius, from init { c, dark,
// theta (degrees) }. At every point of the outline (len mm of each straight edge, the arc), the
// print's edge is where the brightness changes fastest across it (over ±0.02 mm) within the window
// (±1 mm, then ±0.5, 0.3, 0.2 mm as the fit settles), the right way (a dark print darker inside);
// points far off the rest count less and less (Tukey, 4.7 × their typical spread), weak ones not at
// all. opts.theta (degrees): the turn held there, not fitted.
// Returns { bed: [X, Y], theta (degrees), r, spread (mm, the points' typical distance from the
// outline), points, used, arc (points on the arc) } or { fail }.
function fit(img, M, toward, r, init, opts = {}) {
  const F = frame(img, M);
  if (!F) return { fail: 'no camera matrix' };
  const { at, px } = F;
  const [sx, sy] = toward;
  const r0 = Math.max(0, Number(r) || 0);
  const local = outlinePts(r0, opts.len || 12, 0.1);
  let X = init.c[0], Y = init.c[1], R = r0;
  const holdTh = Number.isFinite(opts.theta);
  let th = ((holdTh ? opts.theta : init.theta || 0) * Math.PI) / 180;
  const fitR = !!opts.fitR && r0 > 0;
  const sgn = init.dark === false ? 1 : -1;
  const step = px / 2, ker = Math.max(1, Math.round(0.02 / step));
  let last = null;
  // (the last steps at ±0.2 mm repeated while the outline still moves, up to 4 more; a short straight
  // edge leaves the turn loose and the fit can wander along it, so the last two are averaged)
  const Ws = [1.0, 0.5, 0.3, 0.2, 0.2, 0.2];
  const hist = [];
  for (let it = 0; it < Ws.length + 4; it++) {
    if (it >= Ws.length && last.move <= 0.02) break;
    const W = Ws[Math.min(it, Ws.length - 1)];
    const ex = [Math.cos(th), Math.sin(th)], ey = [-Math.sin(th), Math.cos(th)];
    const rows = [];
    const lim = Math.round(W / step), m = lim + ker + 2;
    const prof = new Float64Array(2 * m + 1);
    for (const p of local) {
      // the point with the radius in use (the straight edges start R past the corner)
      const A = p.arc !== null ? R - R * Math.cos(p.arc) : p.b === 0 ? p.a - r0 + R : 0;
      const B = p.arc !== null ? R - R * Math.sin(p.arc) : p.a === 0 ? p.b - r0 + R : 0;
      const P = [X + sx * A * ex[0] + sy * B * ey[0], Y + sx * A * ex[1] + sy * B * ey[1]];
      const n = [sx * p.na * ex[0] + sy * p.nb * ey[0], sx * p.na * ex[1] + sy * p.nb * ey[1]];
      let bad = false;
      for (let k = -m; k <= m; k++) { const v = at(P[0] + n[0] * k * step, P[1] + n[1] * k * step); if (v !== v) { bad = true; break; } prof[k + m] = v; }
      if (bad) continue;
      const g = (k) => sgn * (prof[k + m + ker] - prof[k + m - ker]);
      let top = 0, bk = 0;
      for (let k = -lim; k <= lim; k++) { const v = g(k); if (v > top) { top = v; bk = k; } }
      if (top <= 0) continue;
      const g0 = g(bk - 1), g2 = g(bk + 1), den = g0 - 2 * top + g2;
      const t = (bk + (den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (g0 - g2)) / den)) : 0)) * step;
      // how the residual t (edge found − outline, inward) changes with the corner, the turn, the radius
      const dTh = [sx * A * ey[0] - sy * B * ex[0], sx * A * ey[1] - sy * B * ex[1]];
      const dR = p.arc === null ? 0 : -((sx * (1 - Math.cos(p.arc)) * ex[0] + sy * (1 - Math.sin(p.arc)) * ey[0]) * n[0] + (sx * (1 - Math.cos(p.arc)) * ex[1] + sy * (1 - Math.sin(p.arc)) * ey[1]) * n[1]);
      rows.push({ t, g: top, J: [-n[0], -n[1], holdTh ? 0 : -(dTh[0] * n[0] + dTh[1] * n[1]), dR], arc: p.arc !== null });
    }
    if (rows.length < 30) return { fail: 'only ' + rows.length + ' points of the outline in the picture' };
    const abs = rows.map((q) => Math.abs(q.t)).sort((a, b) => a - b);
    const s = Math.max(px, 1.4826 * abs[abs.length >> 1]);
    const gs = rows.map((q) => q.g).sort((a, b) => a - b), gmed = gs[gs.length >> 1];
    const np = fitR ? 4 : 3;
    const N = Array.from({ length: np }, () => new Array(np).fill(0)), b = new Array(np).fill(0);
    if (holdTh) N[2][2] += 1;
    let used = 0;
    for (const q of rows) {
      const u = q.t / (4.685 * s);
      const w = q.g < 0.3 * gmed || Math.abs(u) >= 1 ? 0 : (1 - u * u) ** 2;
      if (!w) continue;
      used++;
      for (let i = 0; i < np; i++) { b[i] -= w * q.J[i] * q.t; for (let j = 0; j < np; j++) N[i][j] += w * q.J[i] * q.J[j]; }
    }
    if (used < 30) return { fail: 'only ' + used + ' points on the outline' };
    const d = solve(N, b);
    if (!d) return { fail: 'the outline couldn\'t be placed' };
    X += d[0]; Y += d[1]; th += d[2]; if (fitR) R += d[3];
    if (fitR && (!(R > 0.3 * r0) || R > 2 * r0 + 1)) return { fail: 'the rounding read ' + R.toFixed(2) + ' mm, not ' + r0 + ': not this corner' };
    last = { used, n: rows.length, s, arc: rows.filter((q) => q.arc).length, move: Math.hypot(d[0], d[1]) };
    hist.push([X, Y, th, R]);
  }
  // settled: the last step under 0.05 mm (opts.settle). Not settled is a failure only where asked
  // (opts.mustSettle): a rough first read (to aim the camera, and a turn to start from) still does
  const a = hist[hist.length - 1], b = hist[hist.length - 2] || a;
  const settled = last.move <= (opts.settle || 0.05);
  if (!settled && opts.mustSettle) return { fail: 'the outline didn\'t settle (' + (last.move * 1000).toFixed(0) + ' µm a step)' };
  const mean = settled ? a : a.map((v, i) => (v + b[i]) / 2);
  return { bed: [mean[0], mean[1]], theta: (mean[2] * 180) / Math.PI, r: mean[3], spread: last.s, points: last.n, used: last.used, arc: last.arc, settled, step: last.move };
}

function solve(A, b) {
  const n = b.length, m = A.map((row, i) => row.concat([b[i]]));
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let k = i + 1; k < n; k++) if (Math.abs(m[k][i]) > Math.abs(m[p][i])) p = k;
    [m[i], m[p]] = [m[p], m[i]];
    if (Math.abs(m[i][i]) < 1e-12) return null;
    for (let k = 0; k < n; k++) if (k !== i) { const f = m[k][i] / m[i][i]; for (let c = i; c <= n; c++) m[k][c] -= f * m[i][c]; }
  }
  return m.map((row, i) => row[n] / row[i]);
}

module.exports = { locate, fit, frame };

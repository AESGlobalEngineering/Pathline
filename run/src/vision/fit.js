// Fitting where things were expected → where the camera found them, and correcting with it.
// The mark corrections follow Ruby's (TROTEC_PROTOCOL.md §7.5):
//   'shift'     translation only (from the first mark)                   (Ruby type 10)
//   'rigid'     translation + rotation                                     (20)
//   'similar'   translation + rotation + one scale                         (21)
//   'affine'    least-squares affine (scale and shear too), ≥ 3 marks      (22)
//   'nonlinear' triangles over the marks (Delaunay), each point moved by the blend of its
//               triangle's corner displacements; 4 far points follow the affine fit (30)
// Too few or collinear marks for 'affine' / 'nonlinear' → 'similar', as Ruby does.
// A fit is a function p → p'; fit.info says what was found (shift, rotation, scale, residuals).
'use strict';

const centroid = (P) => P.reduce((a, p) => [a[0] + p[0] / P.length, a[1] + p[1] / P.length], [0, 0]);

function similarity(E, D, { rotate = true, scale = true } = {}) {
  const cA = centroid(E), cB = centroid(D);
  let num = 0, den = 0, se = 0, sd = 0;
  for (let i = 0; i < E.length; i++) {
    const ex = E[i][0] - cA[0], ey = E[i][1] - cA[1], dx = D[i][0] - cB[0], dy = D[i][1] - cB[1];
    num += ex * dy - ey * dx; den += ex * dx + ey * dy;
    se += ex * ex + ey * ey; sd += dx * dx + dy * dy;
  }
  const th = rotate && E.length > 1 ? Math.atan2(num, den) : 0;
  const s = scale && E.length > 1 && se > 0 ? Math.sqrt(sd / se) : 1;
  const c = Math.cos(th) * s, sn = Math.sin(th) * s;
  // t = cB − R·S·cA
  const tx = cB[0] - (c * cA[0] - sn * cA[1]), ty = cB[1] - (sn * cA[0] + c * cA[1]);
  return { m: [c, -sn, tx, sn, c, ty], rotation: (th * 180) / Math.PI, scale: s };
}

// least squares p' = M p (M 2×3)
function affine(E, D) {
  // normal equations, columns [x y 1]
  const N = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bx = [0, 0, 0], by = [0, 0, 0];
  for (let i = 0; i < E.length; i++) {
    const r = [E[i][0], E[i][1], 1];
    for (let a = 0; a < 3; a++) { for (let b = 0; b < 3; b++) N[a][b] += r[a] * r[b]; bx[a] += r[a] * D[i][0]; by[a] += r[a] * D[i][1]; }
  }
  const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const d = det(N);
  const solve = (b) => [0, 1, 2].map((k) => det(N.map((row, i) => row.map((v, j) => (j === k ? b[i] : v)))) / d);
  const ax = solve(bx), ay = solve(by);
  return { m: [ax[0], ax[1], ax[2], ay[0], ay[1], ay[2]], det: d };
}

const apply = (m, p) => [m[0] * p[0] + m[1] * p[1] + m[2], m[3] * p[0] + m[4] * p[1] + m[5]];

// spread of the expected marks: enough, and not on one line, for affine / nonlinear
function spreadOk(E) {
  if (E.length < 3) return false;
  const xs = E.map((p) => p[0]), ys = E.map((p) => p[1]);
  if (Math.max(...xs) - Math.min(...xs) < 0.1 && Math.max(...ys) - Math.min(...ys) < 0.1) return false;
  const c = centroid(E);
  let a = 0, b = 0, d = 0;
  for (const p of E) { const x = p[0] - c[0], y = p[1] - c[1]; a += x * x; b += x * y; d += y * y; }
  return Math.abs(a * d - b * b) >= 0.1;
}

// Bowyer–Watson Delaunay triangulation of a few points → triangles as index triples
function delaunay(P) {
  const tris = [];
  const big = 1e7;
  const pts = P.concat([[-big, -big], [big * 2, -big], [-big, big * 2]]);
  const n = P.length;
  tris.push([n, n + 1, n + 2]);
  const circ = (t) => {
    const [a, b, c] = t.map((i) => pts[i]);
    const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
    const ux = ((a[0] ** 2 + a[1] ** 2) * (b[1] - c[1]) + (b[0] ** 2 + b[1] ** 2) * (c[1] - a[1]) + (c[0] ** 2 + c[1] ** 2) * (a[1] - b[1])) / d;
    const uy = ((a[0] ** 2 + a[1] ** 2) * (c[0] - b[0]) + (b[0] ** 2 + b[1] ** 2) * (a[0] - c[0]) + (c[0] ** 2 + c[1] ** 2) * (b[0] - a[0])) / d;
    return [ux, uy, (a[0] - ux) ** 2 + (a[1] - uy) ** 2];
  };
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const bad = tris.filter((t) => { const [ux, uy, r2] = circ(t); return (p[0] - ux) ** 2 + (p[1] - uy) ** 2 < r2; });
    const edges = [];
    for (const t of bad) for (const [a, b] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) {
      const k = edges.findIndex((e) => (e[0] === b && e[1] === a) || (e[0] === a && e[1] === b));
      if (k >= 0) edges.splice(k, 1); else edges.push([a, b]);
    }
    for (const t of bad) tris.splice(tris.indexOf(t), 1);
    for (const [a, b] of edges) tris.push([a, b, i]);
  }
  return tris.filter((t) => t.every((i) => i < n));
}

function barycentric(p, a, b, c) {
  const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  const l1 = ((b[1] - c[1]) * (p[0] - c[0]) + (c[0] - b[0]) * (p[1] - c[1])) / d;
  const l2 = ((c[1] - a[1]) * (p[0] - c[0]) + (a[0] - c[0]) * (p[1] - c[1])) / d;
  return [l1, l2, 1 - l1 - l2];
}

// expected E → discovered D, both [[x, y]…] mm
function fit(E, D, type) {
  let kind = type;
  if ((kind === 'affine' || kind === 'nonlinear') && !spreadOk(E)) kind = 'similar';
  let f, m;
  if (kind === 'shift') { m = [1, 0, D[0][0] - E[0][0], 0, 1, D[0][1] - E[0][1]]; f = (p) => apply(m, p); }
  else if (kind === 'rigid' || kind === 'similar') { const s = similarity(E, D, { scale: kind === 'similar' }); m = s.m; f = (p) => apply(m, p); }
  else {
    m = affine(E, D).m;
    f = (p) => apply(m, p);
    if (kind === 'nonlinear') {
      // the marks plus 4 far points that follow the affine fit, triangulated
      const far = [[-50000, -50000], [50000, -50000], [50000, 50000], [-50000, 50000]];
      const P = E.concat(far), Q = D.concat(far.map((p) => apply(m, p)));
      const tris = delaunay(P);
      f = (p) => {
        for (const t of tris) {
          const l = barycentric(p, P[t[0]], P[t[1]], P[t[2]]);
          if (l.every((v) => v >= -1e-9)) return [0, 1].map((k) => p[k] + l[0] * (Q[t[0]][k] - P[t[0]][k]) + l[1] * (Q[t[1]][k] - P[t[1]][k]) + l[2] * (Q[t[2]][k] - P[t[2]][k]));
        }
        return apply(m, p);
      };
    }
  }
  const res = E.map((e, i) => { const q = f(e); return Math.hypot(q[0] - D[i][0], q[1] - D[i][1]); });
  f.info = {
    type: kind, shift: [m[2], m[5]],
    rotation: (Math.atan2(m[3], m[0]) * 180) / Math.PI,
    scaleX: Math.hypot(m[0], m[3]), scaleY: Math.hypot(m[1], m[4]),
    residual: res.length ? Math.max(...res) : 0
  };
  return f;
}

// Pathline's regMarks.mode → fit type (HMI-BRIEF §4.6): pos = position and rotation, linear =
// affine, nonlinear = triangles. One mark: shift only.
function typeFor(mode, n) {
  if (n <= 1) return 'shift';
  return { pos: 'rigid', linear: 'affine', nonlinear: 'nonlinear' }[mode] || 'similar';
}

// least squares: coefficients c with Σ c_k · row_k ≈ y (Gaussian elimination on the normal equations)
function lsq(rows, ys) {
  const k = rows[0].length;
  const A = Array.from({ length: k }, () => new Array(k + 1).fill(0));
  rows.forEach((r, i) => { for (let a = 0; a < k; a++) { for (let b = 0; b < k; b++) A[a][b] += r[a] * r[b]; A[a][k] += r[a] * ys[i]; } });
  for (let c = 0; c < k; c++) {
    let p = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    if (Math.abs(A[c][c]) < 1e-12) return null;
    for (let r = 0; r < k; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let j = c; j <= k; j++) A[r][j] -= f * A[c][j]; }
  }
  return A.map((row, i) => row[k] / row[i]);
}

// The machine's error across the bed, as a model fitted to the checkerboard residuals (what's
// left once the board's own position and angle are taken out):
//   'linear'  scale and squareness (an affine error): belts, steps/mm, gantry out of square
//   'smooth'  a gentle curve (2nd order) on top
//   'full'    every corner as measured (for a board that's truly flat)
// A board that isn't flat moves corners locally; those don't fit a smooth machine and are
// thrown out (more than 3 × the typical misfit, at least 0.05 mm), and the fit is done again.
// pts: [{ p: [x, y] machine mm, r: [rx, ry] residual mm }] → { f(p) → [ex, ey], out: [indices], noise (mm rms misfit) }
function errorModel(pts, model) {
  const terms = model === 'smooth' && pts.length >= 10 ? (x, y) => [1, x, y, x * x, x * y, y * y] : (x, y) => [1, x, y];
  // scale positions to ~1 so the solve is well conditioned
  const cx = pts.reduce((a, q) => a + q.p[0], 0) / pts.length, cy = pts.reduce((a, q) => a + q.p[1], 0) / pts.length;
  const sc = Math.max(1, ...pts.map((q) => Math.max(Math.abs(q.p[0] - cx), Math.abs(q.p[1] - cy))));
  const row = (p) => terms((p[0] - cx) / sc, (p[1] - cy) / sc);
  let use = pts.map((_, i) => i);
  let f = () => [0, 0];
  let noise = 0;
  for (let it = 0; it < 3; it++) {
    const rows = use.map((i) => row(pts[i].p));
    const cxs = lsq(rows, use.map((i) => pts[i].r[0])), cys = lsq(rows, use.map((i) => pts[i].r[1]));
    if (!cxs || !cys) break;
    f = (p) => { const r = row(p); return [r.reduce((a, v, k) => a + v * cxs[k], 0), r.reduce((a, v, k) => a + v * cys[k], 0)]; };
    const d = pts.map((q) => { const m = f(q.p); return Math.hypot(q.r[0] - m[0], q.r[1] - m[1]); });
    const med = d.slice().sort((a, b) => a - b)[Math.floor(d.length / 2)];
    const limit = Math.max(0.05, 3 * 1.4826 * med);
    const keep = pts.map((_, i) => i).filter((i) => d[i] <= limit);
    noise = Math.sqrt(keep.reduce((a, i) => a + d[i] * d[i], 0) / Math.max(1, keep.length));
    if (keep.length === use.length || keep.length < Math.max(4, pts.length / 2)) break;
    use = keep;
  }
  const out = pts.map((_, i) => i).filter((i) => !use.includes(i));
  return { f, out, noise };
}

// ---------------------------------------------------------------- bed map
// The checkerboard result: on a regular grid over the bed (x0, y0, step, nx × ny), how far the
// head really is from where it was sent (ex, ey mm). correct(p): where to send the head so it
// really gets to p.
function bedMap(points, step, bed) {
  // points: [{ at: [x, y] where the head was sent (mm), err: [ex, ey] }]
  const x0 = 0, y0 = 0;
  const nx = Math.floor(bed[0] / step) + 1, ny = Math.floor(bed[1] / step) + 1;
  const ex = new Array(nx * ny), ey = new Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const g = [x0 + i * step, y0 + j * step];
      // inverse-distance blend of the nearest measured points (they don't sit on this grid:
      // the board can be anywhere, at any angle)
      const near = points.map((p) => ({ p, d: Math.hypot(p.at[0] - g[0], p.at[1] - g[1]) })).sort((a, b) => a.d - b.d).slice(0, 4);
      let sw = 0, sx = 0, sy = 0;
      for (const { p, d } of near) { const wgt = 1 / Math.max(1e-6, d) ** 2; sw += wgt; sx += wgt * p.err[0]; sy += wgt * p.err[1]; }
      ex[j * nx + i] = +(sx / sw).toFixed(4); ey[j * nx + i] = +(sy / sw).toFixed(4);
    }
  }
  return { x0, y0, step, nx, ny, ex, ey };
}

// A checkerboard can't show where the whole machine sits or which way it's turned (the board
// could be anywhere), only how it stretches and skews. So the error field is anchored the way
// the machine is: none at home (0, 0), and none across the X axis (the X axis is the reference;
// out of square shows as the Y axis leaning). Returns the anchored err(p), and the numbers:
// X / Y length error (mm per m, + = the head goes further than told) and Y's lean (°).
function anchorError(errAt, bed) {
  const pts = [], ys = [];
  const n = 8;
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) { const p = [(bed[0] * i) / n, (bed[1] * j) / n]; pts.push(p); ys.push(errAt(p)[1]); }
  // e_y = c + ω·x + β·y: ω is a turn of the whole machine frame, taken out
  const c = lsq(pts.map((p) => [1, p[0], p[1]]), ys) || [0, 0, 0];
  const w = c[1];
  const e0 = errAt([0, 0]);
  const f = (p) => { const e = errAt(p); return [e[0] - e0[0] + w * p[1], e[1] - e0[1] - w * p[0]]; };
  // slopes across the middle of the bed
  const m = [bed[0] / 2, bed[1] / 2], d = Math.min(bed[0], bed[1]) / 4;
  const dx = (k) => (f([m[0] + d, m[1]])[k] - f([m[0] - d, m[1]])[k]) / (2 * d), dy = (k) => (f([m[0], m[1] + d])[k] - f([m[0], m[1] - d])[k]) / (2 * d);
  return { f, scaleX: dx(0) * 1000, scaleY: dy(1) * 1000, lean: (Math.atan(dy(0)) * 180) / Math.PI };
}

// a bed map straight from an error model: err(p) at every grid point of the whole bed
function gridMap(errAt, step, bed) {
  const nx = Math.floor(bed[0] / step) + 1, ny = Math.floor(bed[1] / step) + 1;
  const ex = new Array(nx * ny), ey = new Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const e = errAt([i * step, j * step]); ex[j * nx + i] = +e[0].toFixed(4); ey[j * nx + i] = +e[1].toFixed(4); }
  return { x0: 0, y0: 0, step, nx, ny, ex, ey };
}

// error at p (bilinear between grid points; held at the edges)
function mapError(map, p) {
  const fx = Math.max(0, Math.min(map.nx - 1, (p[0] - map.x0) / map.step)), fy = Math.max(0, Math.min(map.ny - 1, (p[1] - map.y0) / map.step));
  const i = Math.min(map.nx - 2, Math.floor(fx)), j = Math.min(map.ny - 2, Math.floor(fy));
  const u = map.nx > 1 ? fx - i : 0, v = map.ny > 1 ? fy - j : 0;
  const at = (a, ii, jj) => a[Math.max(0, jj) * map.nx + Math.max(0, ii)];
  const blend = (a) => (1 - u) * (1 - v) * at(a, i, j) + u * (1 - v) * at(a, i + 1, j) + (1 - u) * v * at(a, i, j + 1) + u * v * at(a, i + 1, j + 1);
  return [blend(map.ex), blend(map.ey)];
}

// where to send the head to really reach p: c with c + err(c) = p (a few fixed-point steps)
function correct(map, p) {
  if (!map) return p;
  let c = p;
  for (let k = 0; k < 3; k++) { const e = mapError(map, c); c = [p[0] - e[0], p[1] - e[1]]; }
  return c;
}

// Every coordinate of a Pathline job package through f (paths, boxes, preview shapes).
function transformPkg(pkg, f) {
  const out = JSON.parse(JSON.stringify(pkg));
  const tp = (pts) => pts.map((q) => { const r = f([q[0], q[1]]); return [r[0], r[1]]; });
  const boxOf = (pts) => [Math.min(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1])), Math.max(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[1]))];
  for (const s of out.toolpath || []) {
    if (Array.isArray(s.p)) s.p = tp(s.p);
    if (Array.isArray(s.paths)) s.paths = s.paths.map((path) => (Array.isArray(path) ? tp(path) : path && Array.isArray(path.p) ? { ...path, p: tp(path.p) } : path));
    if (Array.isArray(s.box) && s.box.length === 4) {
      const [a, b, c, d] = s.box;
      s.box = boxOf(tp([[a, b], [c, b], [c, d], [a, d]]));
    }
    if (Array.isArray(s.at)) s.at = f(s.at);
  }
  for (const e of out.entities || []) for (const p of e.paths || []) if (Array.isArray(p.p)) p.p = tp(p.p);
  return out;
}

module.exports = { fit, typeFor, similarity, affine, delaunay, lsq, errorModel, anchorError, bedMap, gridMap, mapError, correct, transformPkg };

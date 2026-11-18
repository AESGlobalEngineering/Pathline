// Finding things in camera frames, in plain JavaScript (no OpenCV): grey images are
// { w, h, data: Uint8Array } (0 black … 255 white), positions in pixels (x right, y down).
//   findDots(img, { minD, maxD })  dark round blobs (printed registration marks, laser marks)
//   findCorner(img)                 the checkerboard corner nearest the middle, sub-pixel
// Both return what's nearest the middle of the frame first, as the camera is sent to centre on it.
'use strict';

// Otsu's threshold: the grey level that best splits dark from light
function otsu(data) {
  const hist = new Float64Array(256);
  for (let i = 0; i < data.length; i++) hist[data[i]]++;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let wB = 0, sumB = 0, best = 0, t = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = data.length - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; t = i; }
  }
  return t;
}

// Which pixels are dark, judged against their own neighbourhood (a win × win box): the light
// across the bed needn't be even. Dark = more than `t` (as a fraction) below the local mean and
// at least `minDiff` grey levels below it.
function darkMask(img, win, t = 0.25, minDiff = 12) {
  const { w, h, data } = img;
  const W = w + 1;
  const I = new Uint32Array(W * (h + 1)); // integral image (fits: 255 × 5 Mpx < 2³²)
  for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += data[y * w + x]; I[(y + 1) * W + x + 1] = I[y * W + x + 1] + row; } }
  const r = Math.max(2, win >> 1);
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const n = (x1 - x0) * (y1 - y0);
      const mean = (I[y1 * W + x1] - I[y0 * W + x1] - I[y1 * W + x0] + I[y0 * W + x0]) / n;
      const v = data[y * w + x];
      if (v <= mean * (1 - t) && mean - v >= minDiff) mask[y * w + x] = 1;
    }
  }
  return mask;
}

// Light pixels enclosed by dark ones (not reachable from the frame's edge through light) made
// dark too: a ring, or rings with light between, count as the disc they outline (the laser's
// calibration mark)
function fillHoles(mask, w, h) {
  const seen = new Uint8Array(w * h), stack = new Int32Array(w * h);
  let sp = 0;
  const push = (i) => { if (!mask[i] && !seen[i]) { seen[i] = 1; stack[sp++] = i; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (sp) {
    const i = stack[--sp], x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < w * (h - 1)) push(i + w);
  }
  for (let i = 0; i < w * h; i++) if (!mask[i] && !seen[i]) mask[i] = 1;
  return mask;
}

// Dark blobs whose size fits a dot of diameter minD … maxD px, round enough, not cut off by the
// frame edge. Dark is judged locally (darkMask), so uneven light doesn't matter; opts.global
// uses one threshold for the whole picture instead. Centre = darkness-weighted centroid.
// opts.light: light blobs in a darker surround instead (a hole cut in steel, white card under it):
// the picture is turned negative and looked at the same way, with a looser check of what's round
// the hole (brushed steel has streaks where paper is plain). The dots found carry light: true.
function findDots(img, opts = {}) {
  if (opts.light) {
    const neg = { ...img, data: new Uint8Array(img.data.length) };
    for (let i = 0; i < img.data.length; i++) neg.data[i] = 255 - img.data[i];
    return findDots(neg, { ...opts, light: false, ring: { ratio: 0.75, spread: 0.15 } }).map((d) => ({ ...d, light: true }));
  }
  const { w, h, data } = img;
  const minD = opts.minD || 8, maxD = opts.maxD || Math.min(w, h) * 0.8;
  // the box must be well bigger than a dot, so a dot's middle is compared with paper round it,
  // but not much more: about 2.4 × the dot (1.5 × the largest allowed). At 2.5 × the largest (4 × a
  // 6 mm mark, 90 % of the real camera's picture) the "local" light was nearly the whole picture's,
  // and a printed mark on clear acrylic was never found
  const win = opts.window || Math.max(15, Math.min(Math.min(w, h), Math.round(opts.maxD ? maxD * 1.5 : Math.min(w, h) / 3)));
  let dark;
  if (opts.global) { const t = opts.threshold || otsu(data); dark = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) dark[i] = data[i] < t ? 1 : 0; }
  else dark = darkMask(img, win);
  if (opts.fillHoles) fillHoles(dark, w, h);
  const label = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  const out = [];
  let next = 1;
  const t = 256;
  for (let start = 0; start < w * h; start++) {
    if (label[start] || !dark[start]) continue;
    let sp = 0, area = 0, sw = 0, sx = 0, sy = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
    stack[sp++] = start;
    label[start] = next;
    while (sp) {
      const i = stack[--sp];
      const x = i % w, y = (i / w) | 0;
      const wt = t - data[i];
      area++; sw += wt; sx += wt * x; sy += wt * y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && !label[i - 1] && dark[i - 1]) { label[i - 1] = next; stack[sp++] = i - 1; }
      if (x < w - 1 && !label[i + 1] && dark[i + 1]) { label[i + 1] = next; stack[sp++] = i + 1; }
      if (y > 0 && !label[i - w] && dark[i - w]) { label[i - w] = next; stack[sp++] = i - w; }
      if (y < h - 1 && !label[i + w] && dark[i + w]) { label[i + w] = next; stack[sp++] = i + w; }
    }
    next++;
    if (x0 === 0 || y0 === 0 || x1 === w - 1 || y1 === h - 1) continue; // cut off by the edge
    const d = 2 * Math.sqrt(area / Math.PI);
    if (d < minD || d > maxD) continue;
    const span = Math.max(x1 - x0 + 1, y1 - y0 + 1);
    const round = area / (Math.PI * (span / 2) ** 2); // 1 for a perfect disc
    if (round < (opts.minRound || 0.7)) continue;
    out.push({ x: sx / sw, y: sy / sw, d, round, area });
  }
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  // printed registration marks always sit in plain white: keep only dots whose surroundings are
  // clean paper (anything dark next to a candidate, artwork or an edge, rules it out)
  const keep = opts.whiteRing ? out.filter((dot) => whiteRound(img, dot, opts.ring)) : out;
  keep.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
  // the one that will be used, refined so uneven light doesn't pull its centre
  if (keep.length && !opts.global) keep[0] = refineDot(img, keep[0]);
  return keep;
}

// Is the ring just outside a dot (1.3 … 1.9 × its radius) plain white? The dot must be well darker
// than the ring, and the ring's darkest tenth nearer the ring's middle than the dot: dark artwork
// touching the ring brings its darkest tenth down to the dot's level. The light may fall across the
// ring very unevenly (the Trotec's lamp: a printed white disc round a mark read 135 on one side,
// 68 on the other); judging the darkest tenth against the brightest, as before, ruled that out.
// (k: { ratio, spread } in place of 0.55 and 0.4: looser for holes in steel)
function whiteRound(img, dot, k) {
  const { w, h, data } = img;
  const R = dot.d / 2, r1 = R * 1.3, r2 = R * 1.9;
  const ring = [], inner = [];
  const x0 = Math.floor(dot.x - r2), x1 = Math.ceil(dot.x + r2), y0 = Math.floor(dot.y - r2), y1 = Math.ceil(dot.y + r2);
  if (x0 < 0 || y0 < 0 || x1 >= w || y1 >= h) return false; // the ring must be in the picture
  const step = Math.max(1, Math.round(R / 40));
  for (let y = y0; y <= y1; y += step) for (let x = x0; x <= x1; x += step) {
    const r = Math.hypot(x - dot.x, y - dot.y), v = data[y * w + x];
    if (r >= r1 && r <= r2) ring.push(v); else if (r <= R * 0.6) inner.push(v);
  }
  const q = (a, f) => a.sort((m, n) => m - n)[Math.min(a.length - 1, Math.floor(a.length * f))];
  const lo = q(ring, 0.1), mid = q(ring, 0.5), dark = q(inner, 0.5);
  const ratio = (k && k.ratio) || 0.55, spread = (k && k.spread) || 0.4;
  return dark <= mid * ratio && lo - dark >= spread * (mid - dark);
}

// ------------------------------------------------------------------ a plate's corner
// A plate (steel, any colour) on a white background: its corner from the two straight edges that
// meet there. M: the camera matrix [a, b, c, d] (pixel offset from the frame centre → bed mm);
// toward: [sx, sy], which way the plate lies from its corner in bed X and Y (±1 each: [1, 1] is the
// corner at the plate's least X and least Y). Works in bed mm round the frame centre, so the
// picture's own turn doesn't matter.
// Edge "X" (along bed X, plate on its sy side) is found across lines along Y, at X from 1 mm past
// the frame centre outward on the plate's side; edge "Y" likewise. On each line the edge is where
// the brightness steps most (averaged over half a mm each side, so steel's brushed streaks don't
// count), placed at the halfway level between the two sides. Lines with too small a step (off the
// plate) are left out, a straight line fitted through the rest twice (dropping points 0.15 mm off),
// and the two lines meet at the corner.
// Returns { x, y } px (as findDots), the edges' angles (degrees, X edge from +X towards +Y; Y edge
// the same turn of +Y), the turn of the corner (their mean), squareness (their difference),
// contrast and the points used; null if there's no clear corner.
// Rounded corners (opts.r, the radius in mm): the corner is still where the two straight edges'
// lines meet (the plate's bounding box corner, which the plate itself doesn't reach), so each edge
// is fitted only where it's more than r + 0.5 mm from that point, leaving the arc out. opts.c0:
// where the corner is expected, mm from the frame centre (Vision aims the camera inside a rounded
// corner, so more straight edge is in view). opts.why: given an object, it gets the reason when no
// corner is found (why.reason; why.view when the camera can't see enough straight edge).
function findPlateCorner(img, opts = {}) {
  const { w, h, data } = img;
  const M = opts.M, [sx, sy] = opts.toward || [1, 1];
  const R = Math.max(0, Number(opts.r) || 0), c0 = opts.c0 || [0, 0];
  const why = opts.why || {};
  const fail = (reason, view) => { why.reason = reason; if (view) why.view = true; return null; };
  const det = M[0] * M[3] - M[1] * M[2];
  if (!det) return null;
  const Mi = [M[3] / det, -M[1] / det, -M[2] / det, M[0] / det];
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const px = Math.sqrt(Math.abs(det));
  const toPx = (X, Y) => [cx + Mi[0] * X + Mi[1] * Y, cy + Mi[2] * X + Mi[3] * Y];
  const at = (X, Y) => {
    const [u, v] = toPx(X, Y);
    if (u < 1 || v < 1 || u > w - 2 || v > h - 2) return null;
    const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0, i = y0 * w + x0;
    return data[i] * (1 - fx) * (1 - fy) + data[i + 1] * fx * (1 - fy) + data[i + w] * (1 - fx) * fy + data[i + w + 1] * fx * fy;
  };
  // the frame's reach in mm from the centre along X and Y
  const half = [w, h].map(() => 0);
  const reachAlong = (ax) => { let r = 0; while (r < 500 && at(ax ? 0 : r + px, ax ? r + px : 0) !== null && at(ax ? 0 : -(r + px), ax ? -(r + px) : 0) !== null) r += px; return r; };
  half[0] = reachAlong(0); half[1] = reachAlong(1);
  const step = Math.max(px, 0.02), n = Math.max(3, Math.round(0.5 / step));
  // one line across an edge: points along `t` (mm) at fixed `s`; returns the steps on it (each
  // biggest within a mm), each placed at the halfway level between its two sides: { t, d }
  const across = (along, s, lim) => {
    const P = [];
    for (let t = -lim; t <= lim; t += step) { const v = along ? at(s, t) : at(t, s); if (v !== null) P.push([t, v]); }
    if (P.length < 4 * n) return [];
    const S = [0];
    for (const p of P) S.push(S[S.length - 1] + p[1]);
    const mean = (a, b) => (S[b] - S[a]) / (b - a);
    // each step against the light there (a fraction of the brightness round it): the Trotec's lamp
    // lights part of the view four times brighter than the rest, and an edge in the shadow counts
    // as much as one in the light
    const D = new Float64Array(P.length);
    let top = 0;
    for (let i = n; i < P.length - n; i++) { D[i] = (mean(i, i + n) - mean(i - n, i)) / (mean(i - n, i + n) + 8); top = Math.max(top, Math.abs(D[i])); }
    const out = [];
    for (let i = n; i < P.length - n; i++) {
      const a0 = Math.abs(D[i]);
      if (a0 < 0.3 * top) continue;
      let peak = true;
      for (let j = Math.max(n, i - 2 * n); j <= Math.min(P.length - n - 1, i + 2 * n); j++) if (Math.abs(D[j]) > a0 || (Math.abs(D[j]) === a0 && j < i)) { peak = false; break; }
      if (!peak) continue;
      const a = Math.max(0, i - 3 * n), b = Math.min(P.length, i + 3 * n);
      const lo = mean(a, Math.max(a + 1, i - n)), hi = mean(Math.min(b - 1, i + n), b), mid = (lo + hi) / 2;
      let t = P[i][0];
      for (let k = Math.max(1, i - n); k <= Math.min(P.length - 1, i + n); k++) {
        const v0 = P[k - 1][1] - mid, v1 = P[k][1] - mid;
        if ((v0 <= 0 && v1 > 0) || (v0 >= 0 && v1 < 0)) { t = P[k - 1][0] + (P[k][0] - P[k - 1][0]) * (v0 / (v0 - v1)); break; }
      }
      out.push({ t, d: (hi - lo) / ((hi + lo) / 2 + 8) });
    }
    return out;
  };
  // an edge: lines from 1 mm past the expected corner (r + 1 for a rounded one) out to the frame's
  // side, every 0.4 mm or more; d is plate − background when the plate is on the tSide of the step
  const sStart = [c0[0] + sx * (R + 1), c0[1] + sy * (R + 1)];
  const edge = (along, s0Side, tSide) => {
    const lim = half[along ? 1 : 0] * 0.95, sMax = half[along ? 0 : 1] * 0.95;
    const s0 = sStart[along ? 0 : 1], lines = [];
    for (let u = 0; Math.abs(s0 + s0Side * u) <= sMax; u += Math.max(0.4, sMax / 24)) {
      const s = s0 + s0Side * u;
      lines.push({ s, steps: across(along, s, lim).map((c) => ({ t: c.t, d: c.d * tSide })), tSide });
    }
    return lines;
  };
  // how much straight edge the frame can show past the rounding: 3 mm at least along each
  const viewX = half[0] * 0.95 - sx * c0[0] - R, viewY = half[1] * 0.95 - sy * c0[1] - R;
  if (Math.min(viewX, viewY) < 3.5) return fail('the camera sees only ' + Math.max(0, Math.min(viewX, viewY)).toFixed(1) + ' mm of straight edge past the corner' + (R ? ' (radius ' + R + ' mm)' : '') + ', and needs 3.5', true);
  const LA0 = edge(true, sx, sy), LB0 = edge(false, sy, sx);
  // the plate against the background, the same way round on both edges: the sign of the biggest
  // steps (a hole in the plate steps both ways, an edge one way)
  const allSteps = LA0.concat(LB0).flatMap((l) => l.steps);
  if (!allSteps.length) return fail('no edge in view');
  const big = Math.max(...allSteps.map((p) => Math.abs(p.d)));
  const sign = Math.sign(allSteps.filter((p) => Math.abs(p.d) > 0.6 * big).reduce((s, p) => s + Math.sign(p.d), 0)) || 1;
  // on each line, the edge is the first step into the plate coming from the background's side
  const pick = (lines) => lines.map((l) => {
    const c = l.steps.filter((p) => Math.sign(p.d) === sign && Math.abs(p.d) > 0.4 * big).sort((p, q) => p.t * l.tSide - q.t * l.tSide)[0];
    return c ? { s: l.s, t: c.t, d: c.d } : null;
  }).filter(Boolean);
  const A = pick(LA0), B = pick(LB0);
  if (A.length < 5 || B.length < 5) return fail('not two edges meeting at a corner (' + A.length + ' and ' + B.length + ' points along them)');
  // a straight line t = k0 + k1·s through the points, the worst dropped one at a time until all lie
  // within 0.15 mm (a line that grazed the other edge, a scratch)
  const line = (P) => {
    let Q = P.slice(), f = null;
    while (Q.length >= 4) {
      const m = Q.length, ss = Q.reduce((a, p) => a + p.s, 0), st = Q.reduce((a, p) => a + p.t, 0);
      const sss = Q.reduce((a, p) => a + p.s * p.s, 0), sst = Q.reduce((a, p) => a + p.s * p.t, 0);
      const dd = m * sss - ss * ss;
      if (!dd) return null;
      const k1 = (m * sst - ss * st) / dd;
      f = { k0: (st - k1 * ss) / m, k1, n: m, span: Math.max(...Q.map((p) => p.s)) - Math.min(...Q.map((p) => p.s)) };
      const res = Q.map((p) => Math.abs(p.t - (f.k0 + f.k1 * p.s)));
      const worst = res.indexOf(Math.max(...res));
      if (res[worst] < Math.max(0.15, 3 * px)) break;
      Q.splice(worst, 1);
    }
    if (f) f.rms = Math.sqrt(Q.reduce((a, p) => a + (p.t - (f.k0 + f.k1 * p.s)) ** 2, 0) / Q.length);
    return f;
  };
  // the edges meet at the corner; lines at or past it (near the corner a line along one edge can
  // cross the other, turned, edge), or on a rounded corner's arc (within r of it), are left out and
  // the edges fitted again
  let A1 = A, B1 = B, LA, LB, X, Y;
  for (let k = 0; k < 6; k++) {
    LA = line(A1); LB = line(B1);
    if (!LA || !LB) return fail('the edges aren\'t straight');
    // edge X: Y = a0 + a1·X; edge Y: X = b0 + b1·Y
    X = (LB.k0 + LB.k1 * LA.k0) / (1 - LB.k1 * LA.k1); Y = LA.k0 + LA.k1 * X;
    const nA = A.filter((p) => (p.s - X) * sx >= R + 0.5), nB = B.filter((p) => (p.s - Y) * sy >= R + 0.5);
    if (nA.length === A1.length && nB.length === B1.length && nA.every((p, i) => p === A1[i]) && nB.every((p, i) => p === B1[i])) break;
    A1 = nA; B1 = nB;
  }
  if (LA.n < 5 || LB.n < 5 || LA.span < 3 || LB.span < 3) return fail('only ' + Math.min(LA.span, LB.span).toFixed(1) + ' mm of straight edge found past the corner' + (R ? ' (radius ' + R + ' mm)' : '') + ', and 3 are needed', R > 0);
  const angX = (Math.atan(LA.k1) * 180) / Math.PI, angY = (-Math.atan(LB.k1) * 180) / Math.PI;
  const [u, v] = toPx(X, Y);
  if (u < 0 || v < 0 || u > w - 1 || v > h - 1) return fail('the corner the edges meet at is outside the picture');
  return { x: u, y: v, bed: [X, Y], r: R, angles: [angX, angY], rotation: (angX + angY) / 2, squareness: angX - angY, contrast: Math.abs(big), plateBrighter: sign > 0, points: LA.n + LB.n, rms: Math.max(LA.rms, LB.rms) };
}

// A dot's centre without the light's slope: fit the paper round it as a tilted plane
// (brightness a + b·x + c·y on a ring outside the dot), divide it out, and take the plain
// centre of what's under half the paper's brightness. Twice, as the centre moves.
function refineDot(img, dot) {
  const { w, h, data } = img;
  let { x: cx, y: cy, d } = dot;
  for (let it = 0; it < 2; it++) {
    const R = d / 2;
    const r1 = R * 1.35, r2 = R * 1.9, r3 = R * 1.6;
    const x0 = Math.max(0, Math.floor(cx - r2)), x1 = Math.min(w - 1, Math.ceil(cx + r2));
    const y0 = Math.max(0, Math.floor(cy - r2)), y1 = Math.min(h - 1, Math.ceil(cy + r2));
    // plane through the ring: normal equations for [1, x, y]
    const N = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], B = [0, 0, 0];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const r = Math.hypot(x - cx, y - cy);
      if (r < r1 || r > r2) continue;
      const row = [1, x - cx, y - cy], v = data[y * w + x];
      for (let a = 0; a < 3; a++) { for (let b = 0; b < 3; b++) N[a][b] += row[a] * row[b]; B[a] += row[a] * v; }
    }
    const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const D = det(N);
    if (Math.abs(D) < 1e-9) break;
    const p = [0, 1, 2].map((k) => det(N.map((row, i) => row.map((v, j) => (j === k ? B[i] : v)))) / D);
    let n = 0, sx = 0, sy = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (Math.hypot(x - cx, y - cy) > r3) continue;
      const bg = p[0] + p[1] * (x - cx) + p[2] * (y - cy);
      if (bg > 4 && data[y * w + x] < bg * 0.5) { n++; sx += x; sy += y; }
    }
    if (n < 10) break;
    cx = sx / n; cy = sy / n; d = 2 * Math.sqrt(n / Math.PI);
  }
  return { ...dot, x: cx, y: cy, d };
}

// box-average down to about `size` px across
function shrink(img, size) {
  const f = Math.max(1, Math.round(Math.max(img.w, img.h) / size));
  const w = Math.floor(img.w / f), h = Math.floor(img.h / f);
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let j = 0; j < f; j++) { const row = (y * f + j) * img.w + x * f; for (let i = 0; i < f; i++) s += img.data[row + i]; }
      data[y * w + x] = s / (f * f);
    }
  }
  return { w, h, data, f };
}

// Checkerboard corners (where two black and two white squares meet), at any angle (the board
// needn't be square to the machine or the camera).
// Coarse, on a shrunk copy: the ChESS response. 16 samples on a ring round each point; at a
// corner, opposite samples match and samples a quarter turn apart differ, whichever way the
// board is turned. Fine: the classic gradient refinement (every edge pixel nearby points at the
// corner).
// The ChESS response over a shrunk, evened-out copy: score and contrast per pixel (score > 0 and
// contrast above the minimum: a corner there).
function chessMap(img, opts = {}) {
  const s = shrink(img, opts.work || 400);
  // even out the light: each pixel against the darkest and lightest round it (a quarter of
  // the picture), so a dim side and a bright side both read as black and white squares
  const data = evenOut(s, Math.round(Math.min(s.w, s.h) / 4));
  const { w, h } = s;
  const r = Math.max(4, Math.round(Math.min(w, h) * (opts.ring || 0.04)));
  const ring = [];
  for (let k = 0; k < 16; k++) { const a = (k * Math.PI) / 8; ring.push(Math.round(Math.cos(a) * r) + Math.round(Math.sin(a) * r) * w); }
  const score = new Float32Array(w * h), contrast = new Float32Array(w * h);
  const v = new Float32Array(16);
  for (let y = r + 1; y < h - r - 1; y++) {
    for (let x = r + 1; x < w - r - 1; x++) {
      const i = y * w + x;
      let mean = 0;
      for (let k = 0; k < 16; k++) { v[k] = data[i + ring[k]]; mean += v[k]; }
      mean /= 16;
      let sum = 0, diff = 0;
      for (let k = 0; k < 4; k++) sum += Math.abs(v[k] + v[k + 8] - v[k + 4] - v[k + 12]);
      for (let k = 0; k < 8; k++) diff += Math.abs(v[k] - v[k + 8]);
      const local = (data[i] + data[i - 1] + data[i + 1] + data[i - w] + data[i + w]) / 5;
      score[i] = sum - diff - 16 * Math.abs(mean - local) / 4;
      contrast[i] = sum / 8;
    }
  }
  return { s, w, h, r, score, contrast, minContrast: opts.minContrast || 25 };
}

// The corner nearest the middle (the bed checkerboard, one corner in view), with angle (deg): the
// direction of one of the board's lines through it, in the image. Only a real crossing counts,
// as in findCorners: before, the strongest ChESS response near the middle did, and on the
// Trotec's unevenly lit view a shadow's edge could. Returns { x, y, angle } or null.
function findCorner(img, opts = {}) {
  return findCorners(img, { ...opts, angle: true })[0] || null;
}

// The copy corners are refined on: about 800 px across, then each pixel the mean of the 5 × 5
// round it (the same in every direction, so a corner stays where it is). At full size (the
// Alvium's 1944 px) the paper's texture outweighs the squares' soft edges and pulled the corner
// off into a white square (Pathline Run 0.7.7).
function fineCopy(img) {
  const s = shrink(img, 800), { w, h } = s, k = 2;
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += s.data[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; } }
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - k), y1 = Math.min(h, y + k + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - k), x1 = Math.min(w, x + k + 1);
      data[y * w + x] = (I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0]) / ((x1 - x0) * (y1 - y0));
    }
  }
  return { w, h, data, f: s.f };
}

// A ChESS peak (full-size pixels) refined to sub-pixel on the fine copy. Returns full-size x, y,
// and the copy's own fx, fy and window.
function refineAt(fine, M, x, y) {
  const g = fine.f, win = Math.max(6, Math.round((M.r * M.s.f * 0.8) / g));
  const q = refineCorner(fine, (x + 0.5) / g - 0.5, (y + 0.5) / g - 0.5, win);
  return q && { x: (q.x + 0.5) * g - 0.5, y: (q.y + 0.5) * g - 0.5, fx: q.x, fy: q.y, win };
}

// Every corner in the picture (a small checkerboard filling the view): the ChESS peaks, each
// refined to sub-pixel; nearest the middle first.
function findCorners(img, opts = {}) {
  const M = chessMap(img, opts);
  const { w, h, r, s } = M;
  const peaks = [];
  const nr = Math.max(2, Math.round(r * 0.75));
  for (let y = r + 1; y < h - r - 1; y++) {
    for (let x = r + 1; x < w - r - 1; x++) {
      const i = y * w + x, v = M.score[i];
      if (v <= 0 || M.contrast[i] < M.minContrast) continue;
      let top = true;
      for (let dy = -nr; dy <= nr && top; dy++) for (let dx = -nr; dx <= nr; dx++) { if ((dx || dy) && M.score[i + dy * w + dx] > v) { top = false; break; } }
      if (top) peaks.push({ x, y, v });
    }
  }
  const win = Math.max(6, Math.round(r * s.f * 0.8));
  const fine = fineCopy(img);
  const out = [];
  for (const p of peaks.sort((a, b) => b.v - a.v)) {
    const f = refineAt(fine, M, p.x * s.f + s.f / 2, p.y * s.f + s.f / 2);
    const q = f && { x: f.x, y: f.y };
    // (judged on the shrunk copy, as the corners were looked for: the same at any camera resolution,
    // and the paper's texture at full size can't count as changes)
    if (!q || out.some((o) => Math.hypot(o.x - q.x, o.y - q.y) < win) || !crossing(s, (q.x - s.f / 2) / s.f, (q.y - s.f / 2) / s.f, r * 1.2)) continue;
    out.push(q);
  }
  const cx = (img.w - 1) / 2, cy = (img.h - 1) / 2;
  out.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
  // opts.angle: the first one's line direction too (findCorner)
  if (opts.angle && out[0]) { const g = fine.f; out[0].angle = cornerAngle(fine, (out[0].x + 0.5) / g - 0.5, (out[0].y + 0.5) / g - 0.5, Math.max(6, Math.round(win / g))); }
  return out;
}

// Corners in several pictures of the same view (the exposure stepped: the head's light on one part,
// the rest in shadow, where corners only show at a longer exposure), one per place, nearest the
// middle first.
function findCornersIn(imgs, opts = {}) {
  const img = imgs[0], near = img.w * 0.02, all = [];
  for (const im of imgs) for (const c of findCorners(im, opts)) if (!all.some((o) => Math.hypot(o.x - c.x, o.y - c.y) < near)) all.push(c);
  const cx = (img.w - 1) / 2, cy = (img.h - 1) / 2;
  return all.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
}

// Is (qx, qy) where two black and two white squares meet? Round a circle of radius R it goes
// dark, light, dark, light, each part about a quarter turn (50° … 130°: the board at an angle,
// the corner a little off). A soft edge goes dark, light; a bright strip along an edge gives two
// thin light parts. Every grey level is tried as the split, as the two white squares (or the two
// black ones) can differ a lot in uneven light.
function crossing(img, qx, qy, R) {
  const n = 48, raw = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const x = Math.round(qx + R * Math.cos((2 * Math.PI * k) / n)), y = Math.round(qy + R * Math.sin((2 * Math.PI * k) / n));
    if (x < 0 || y < 0 || x >= img.w || y >= img.h) return false;
    raw[k] = img.data[y * img.w + x];
  }
  // a little smoothing round the circle, so noise at a split doesn't count as a change
  const v = raw.map((x, k) => (raw[(k + n - 1) % n] + 2 * x + raw[(k + 1) % n]) / 4);
  const levels = [...new Set(v)].sort((a, b) => a - b);
  for (let t = 0; t + 1 < levels.length; t++) {
    const split = (levels[t] + levels[t + 1]) / 2;
    const runs = [];
    for (let k = 0; k < n; k++) {
      const side = v[k] > split;
      if (runs.length && runs[runs.length - 1].side === side) runs[runs.length - 1].len++;
      else runs.push({ side, len: 1 });
    }
    if (runs.length > 1 && runs[0].side === runs[runs.length - 1].side) runs[0].len += runs.pop().len;
    if (runs.length === 4 && runs.every((r) => r.len >= (n * 50) / 360 && r.len <= (n * 130) / 360)) return true;
  }
  return false;
}

// the corner near (qx, qy), sub-pixel: over the window, Σ g gᵀ (q − p) = 0
function refineCorner(img, qx, qy, win) {
  const px = (x, y) => img.data[y * img.w + x];
  for (let it = 0; it < 12; it++) {
    let a = 0, b = 0, c = 0, bx = 0, by = 0;
    const x0 = Math.max(1, Math.round(qx) - win), x1 = Math.min(img.w - 2, Math.round(qx) + win);
    const y0 = Math.max(1, Math.round(qy) - win), y1 = Math.min(img.h - 2, Math.round(qy) + win);
    // only the squares' edges: gradients under a fifth of the strongest here are texture or noise
    let top = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const gx = px(x + 1, y) - px(x - 1, y), gy = px(x, y + 1) - px(x, y - 1); top = Math.max(top, gx * gx + gy * gy); }
    const floor = top * 0.04;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const gx = (px(x + 1, y) - px(x - 1, y)) / 2, gy = (px(x, y + 1) - px(x, y - 1)) / 2;
        if (4 * (gx * gx + gy * gy) <= floor) continue;
        a += gx * gx; b += gx * gy; c += gy * gy;
        bx += gx * gx * x + gx * gy * y; by += gx * gy * x + gy * gy * y;
      }
    }
    const det = a * c - b * b;
    if (Math.abs(det) < 1e-9) break;
    const nx = (c * bx - b * by) / det, ny = (a * by - b * bx) / det;
    const moved = Math.hypot(nx - qx, ny - qy);
    qx = nx; qy = ny;
    if (moved < 0.01) break;
  }
  if (!(qx > 0 && qy > 0 && qx < img.w && qy < img.h)) return null;
  return { x: qx, y: qy };
}

// The board's angle at a corner: edges round it run two ways a quarter turn apart, so average
// the edge directions ×4 (both ways then agree) and divide by 4 → a line's angle, 0 … 90°
function cornerAngle(img, qx, qy, win) {
  const px = (x, y) => img.data[y * img.w + x];
  let s4 = 0, c4 = 0;
  const x0 = Math.max(1, Math.round(qx) - win), x1 = Math.min(img.w - 2, Math.round(qx) + win);
  const y0 = Math.max(1, Math.round(qy) - win), y1 = Math.min(img.h - 2, Math.round(qy) + win);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const gx = (px(x + 1, y) - px(x - 1, y)) / 2, gy = (px(x, y + 1) - px(x, y - 1)) / 2;
      const m = Math.hypot(gx, gy);
      if (m < 4) continue;
      const a = Math.atan2(gy, gx) * 4;
      s4 += m * Math.sin(a); c4 += m * Math.cos(a);
    }
  }
  let angle = (Math.atan2(s4, c4) / 4) * (180 / Math.PI);
  if (angle < 0) angle += 90;
  return angle;
}

// The corners of a small checkerboard as a grid: every corner given whole-number grid indices,
// then a least-squares fit pixel = o + i·a + j·b. Some corners found are false (a soft edge, a
// shadow across a square), so the grid isn't taken from the nearest neighbours: each pair of
// steps between the corners nearest the middle is tried, and the grid most corners sit on wins.
// A 2 × 2 is enough: the Trotec's head camera sees under 3 of the 10 mm squares across.
// Returns { a, b, o, n, worst, points } (px; worst = the largest misfit of a corner, px: how much
// the lens bends straight lines here; points = the corners on the grid, nearest the middle
// first) or null.
function fitLattice(corners) {
  if (corners.length < 4) return null;
  const onGrid = (c0, a, b) => {
    const det = a[0] * b[1] - a[1] * b[0];
    const rows = [];
    let off = 0;
    for (const c of corners) {
      const dx = c.x - c0.x, dy = c.y - c0.y;
      const fi = (dx * b[1] - dy * b[0]) / det, fj = (a[0] * dy - a[1] * dx) / det;
      const i = Math.round(fi), j = Math.round(fj);
      if (Math.abs(fi - i) > 0.25 || Math.abs(fj - j) > 0.25) continue;
      rows.push({ i, j, c });
      off += Math.abs(fi - i) + Math.abs(fj - j);
    }
    return { rows, off };
  };
  let best = null;
  for (const c0 of corners.slice(0, 6)) {
    const vecs = corners.filter((c) => c !== c0).map((c) => [c.x - c0.x, c.y - c0.y]);
    for (const a of vecs) {
      const la = Math.hypot(...a);
      for (const b of vecs) {
        const lb = Math.hypot(...b);
        // squares: two steps about as long, about square to each other; each grid once (b left of a)
        if (a[0] * b[1] - a[1] * b[0] <= 0 || lb < la / 1.5 || lb > la * 1.5 || Math.abs(a[0] * b[0] + a[1] * b[1]) / (la * lb) >= 0.3) continue;
        const g = onGrid(c0, a, b);
        // across and down both: not just a row of corners
        if (new Set(g.rows.map((r) => r.i)).size < 2 || new Set(g.rows.map((r) => r.j)).size < 2) continue;
        if (!best || g.rows.length > best.rows.length || (g.rows.length === best.rows.length && g.off < best.off)) best = g;
      }
    }
  }
  if (!best || best.rows.length < 4) return null;
  const rows = best.rows;
  // least squares for x and y separately: [1, i, j]
  const solve = (val) => {
    const N = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], B = [0, 0, 0];
    for (const r of rows) { const v = [1, r.i, r.j], y = val(r.c); for (let p = 0; p < 3; p++) { for (let q = 0; q < 3; q++) N[p][q] += v[p] * v[q]; B[p] += v[p] * y; } }
    const d3 = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const D = d3(N);
    return [0, 1, 2].map((k) => d3(N.map((row, i) => row.map((v, j) => (j === k ? B[i] : v)))) / D);
  };
  // fit; drop corners that don't fit (a false corner at the edge of the picture, say); again
  let use = rows, fx, fy, miss;
  for (let it = 0; it < 3; it++) {
    fx = solve((c) => c.x); fy = solve((c) => c.y);
    miss = (r) => Math.hypot(fx[0] + r.i * fx[1] + r.j * fx[2] - r.c.x, fy[0] + r.i * fy[1] + r.j * fy[2] - r.c.y);
    const d = use.map(miss).sort((p, q) => p - q);
    const limit = Math.max(1.5, 3 * d[Math.floor(d.length / 2)]);
    const keep = use.filter((r) => miss(r) <= limit);
    if (keep.length === use.length || keep.length < 4) break;
    use = keep;
    rows.splice(0, rows.length, ...use);
  }
  const fitA = [fx[1], fy[1]], fitB = [fx[2], fy[2]], o = [fx[0], fy[0]];
  const worst = Math.max(...use.map(miss));
  return { a: fitA, b: fitB, o, n: use.length, worst, points: corners.filter((c) => use.some((r) => r.c === c)) };
}

// local min / max over a (2r+1)² box, then stretched to 0 … 255 (flat areas stay mid grey)
function evenOut(s, r) {
  const { w, h, data } = s;
  // one row or column at a time, in one sweep: a queue of the window's candidates, best at the
  // front (each value goes in and out once), the same as looking at the whole window per pixel
  const q = new Int32Array(Math.max(w, h));
  const pass = (src, horizontal, better) => {
    const out = new Float32Array(w * h);
    const lines = horizontal ? h : w, n = horizontal ? w : h, step = horizontal ? 1 : w;
    for (let l = 0; l < lines; l++) {
      const base = horizontal ? l * w : l;
      let head = 0, tail = 0, next = 0;
      for (let i = 0; i < n; i++) {
        for (const hi = Math.min(n - 1, i + r); next <= hi; next++) {
          const v = src[base + next * step];
          while (tail > head && !better(src[base + q[tail - 1] * step], v)) tail--;
          q[tail++] = next;
        }
        while (q[head] < i - r) head++;
        out[base + i * step] = src[base + q[head] * step];
      }
    }
    return out;
  };
  const lt = (a, b) => a < b, gt = (a, b) => a > b;
  const mn = pass(pass(data, true, lt), false, lt), mx = pass(pass(data, true, gt), false, gt);
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) { const span = mx[i] - mn[i]; out[i] = span < 20 ? 128 : ((data[i] - mn[i]) / span) * 255; }
  return out;
}

// a smaller copy for the screen (grey bytes), about `size` px across
function preview(img, size) {
  const s = shrink(img, size);
  const data = new Uint8Array(s.w * s.h);
  for (let i = 0; i < data.length; i++) data[i] = Math.round(s.data[i]);
  return { w: s.w, h: s.h, data };
}

module.exports = { otsu, findDots, findPlateCorner, findCorner,findCorners, findCornersIn, fitLattice, shrink, preview };

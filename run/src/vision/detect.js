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

// Dark blobs whose size fits a dot of diameter minD … maxD px, round enough, not cut off by the
// frame edge. Dark is judged locally (darkMask), so uneven light doesn't matter; opts.global
// uses one threshold for the whole picture instead. Centre = darkness-weighted centroid.
function findDots(img, opts = {}) {
  const { w, h, data } = img;
  const minD = opts.minD || 8, maxD = opts.maxD || Math.min(w, h) * 0.8;
  // the box must be well bigger than a dot, so a dot's middle is compared with paper round it
  const win = opts.window || Math.max(15, Math.min(Math.min(w, h), Math.round(opts.maxD ? maxD * 2.5 : Math.min(w, h) / 3)));
  let dark;
  if (opts.global) { const t = opts.threshold || otsu(data); dark = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) dark[i] = data[i] < t ? 1 : 0; }
  else dark = darkMask(img, win);
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
  const keep = opts.whiteRing ? out.filter((dot) => whiteRound(img, dot)) : out;
  keep.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
  // the one that will be used, refined so uneven light doesn't pull its centre
  if (keep.length && !opts.global) keep[0] = refineDot(img, keep[0]);
  return keep;
}

// Is the ring just outside a dot (1.3 … 1.9 × its radius) plain white? Its darkest tenth must be
// close to its brightest tenth (light may slope across it, a little), and the dot well darker.
function whiteRound(img, dot) {
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
  const lo = q(ring, 0.1), hi = q(ring, 0.9), mid = q(ring, 0.5), dark = q(inner, 0.5);
  return lo >= hi * 0.7 && dark <= mid * 0.55;
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

// The checkerboard corner (where two black and two white squares meet) nearest the middle, at
// any angle (the board needn't be square to the machine or the camera).
// Coarse, on a shrunk copy: the ChESS response. 16 samples on a ring round each point; at a
// corner, opposite samples match and samples a quarter turn apart differ, whichever way the
// board is turned. Fine: the classic gradient refinement (every edge pixel nearby points at the
// corner) at full size. Returns { x, y, contrast, angle } or null; angle (deg) is the direction
// of one of the board's lines through the corner, in the image.
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

function findCorner(img, opts = {}) {
  const M = chessMap(img, opts);
  const { w, h, r, s } = M;
  const cx = w / 2, cy = h / 2;
  let best = null;
  for (let y = r + 1; y < h - r - 1; y++) {
    for (let x = r + 1; x < w - r - 1; x++) {
      const i = y * w + x;
      if (M.contrast[i] < M.minContrast || M.score[i] <= 0) continue;
      // prefer the middle: a strong corner a little further out loses to one near the centre
      const val = M.score[i] - 0.5 * Math.hypot(x - cx, y - cy);
      if (!best || val > best.val) best = { x, y, val, contrast: M.contrast[i] };
    }
  }
  if (!best) return null;
  const win = Math.max(6, Math.round(r * s.f * 0.8));
  const q = refineCorner(img, best.x * s.f + s.f / 2, best.y * s.f + s.f / 2, win);
  return q ? { ...q, contrast: best.contrast, angle: cornerAngle(img, q.x, q.y, win) } : null;
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
  const out = [];
  for (const p of peaks.sort((a, b) => b.v - a.v)) {
    const q = refineCorner(img, p.x * s.f + s.f / 2, p.y * s.f + s.f / 2, win);
    if (!q || out.some((o) => Math.hypot(o.x - q.x, o.y - q.y) < win)) continue;
    out.push(q);
  }
  const cx = (img.w - 1) / 2, cy = (img.h - 1) / 2;
  return out.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
}

// the corner near (qx, qy), sub-pixel: over the window, Σ g gᵀ (q − p) = 0
function refineCorner(img, qx, qy, win) {
  const px = (x, y) => img.data[y * img.w + x];
  for (let it = 0; it < 12; it++) {
    let a = 0, b = 0, c = 0, bx = 0, by = 0;
    const x0 = Math.max(1, Math.round(qx) - win), x1 = Math.min(img.w - 2, Math.round(qx) + win);
    const y0 = Math.max(1, Math.round(qy) - win), y1 = Math.min(img.h - 2, Math.round(qy) + win);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const gx = (px(x + 1, y) - px(x - 1, y)) / 2, gy = (px(x, y + 1) - px(x, y - 1)) / 2;
        if (!gx && !gy) continue;
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

// The corners of a small checkerboard as a grid: two lattice vectors from the corner nearest
// the middle to its nearest neighbours, every corner given whole-number grid indices, then a
// least-squares fit pixel = o + i·a + j·b. Returns { a, b, o, n, worst } (px; worst = the
// largest misfit of a corner, px: how much the lens bends straight lines here) or null.
function fitLattice(corners) {
  if (corners.length < 6) return null;
  const c0 = corners[0];
  const vecs = corners.slice(1).map((c) => [c.x - c0.x, c.y - c0.y]).sort((p, q) => Math.hypot(...p) - Math.hypot(...q));
  const a = vecs[0];
  const la = Math.hypot(...a);
  const b = vecs.find((v) => { const cos = Math.abs(v[0] * a[0] + v[1] * a[1]) / (la * Math.hypot(...v)); return cos < 0.3 && Math.hypot(...v) < la * 1.5; });
  if (!b) return null;
  const det = a[0] * b[1] - a[1] * b[0];
  const rows = [], X = [], Y = [];
  for (const c of corners) {
    const dx = c.x - c0.x, dy = c.y - c0.y;
    const fi = (dx * b[1] - dy * b[0]) / det, fj = (a[0] * dy - a[1] * dx) / det;
    const i = Math.round(fi), j = Math.round(fj);
    if (Math.abs(fi - i) > 0.25 || Math.abs(fj - j) > 0.25) continue;
    rows.push({ i, j, c });
  }
  if (rows.length < 6) return null;
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
    if (keep.length === use.length || keep.length < 6) break;
    use = keep;
    rows.splice(0, rows.length, ...use);
  }
  const fitA = [fx[1], fy[1]], fitB = [fx[2], fy[2]], o = [fx[0], fy[0]];
  const worst = Math.max(...use.map(miss));
  return { a: fitA, b: fitB, o, n: use.length, worst };
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

module.exports = { otsu, findDots, findCorner, findCorners, fitLattice, shrink, preview };

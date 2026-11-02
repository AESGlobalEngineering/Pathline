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

// Dark blobs whose size fits a dot of diameter minD … maxD px, round enough, not cut off by the
// frame edge. Centre = darkness-weighted centroid (sub-pixel).
function findDots(img, opts = {}) {
  const { w, h, data } = img;
  const t = opts.threshold || otsu(data);
  const minD = opts.minD || 8, maxD = opts.maxD || Math.min(w, h) * 0.8;
  const label = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  const out = [];
  let next = 1;
  for (let start = 0; start < w * h; start++) {
    if (label[start] || data[start] >= t) continue;
    let sp = 0, area = 0, sw = 0, sx = 0, sy = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
    stack[sp++] = start;
    label[start] = next;
    while (sp) {
      const i = stack[--sp];
      const x = i % w, y = (i / w) | 0;
      const wt = t - data[i];
      area++; sw += wt; sx += wt * x; sy += wt * y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && !label[i - 1] && data[i - 1] < t) { label[i - 1] = next; stack[sp++] = i - 1; }
      if (x < w - 1 && !label[i + 1] && data[i + 1] < t) { label[i + 1] = next; stack[sp++] = i + 1; }
      if (y > 0 && !label[i - w] && data[i - w] < t) { label[i - w] = next; stack[sp++] = i - w; }
      if (y < h - 1 && !label[i + w] && data[i + w] < t) { label[i + w] = next; stack[sp++] = i + w; }
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
  return out.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
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
function findCorner(img, opts = {}) {
  const s = shrink(img, opts.work || 400);
  const { w, h, data } = s;
  const r = Math.max(4, Math.round(Math.min(w, h) * (opts.ring || 0.04)));
  const ring = [];
  for (let k = 0; k < 16; k++) { const a = (k * Math.PI) / 8; ring.push(Math.round(Math.cos(a) * r) + Math.round(Math.sin(a) * r) * w); }
  const cx = w / 2, cy = h / 2;
  const v = new Float32Array(16);
  let best = null;
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
      const score = sum - diff - 16 * Math.abs(mean - local) / 4;
      const contrast = sum / 8;
      if (contrast < (opts.minContrast || 25) || score <= 0) continue;
      // prefer the middle: a strong corner a little further out loses to one near the centre
      const val = score - 0.5 * Math.hypot(x - cx, y - cy);
      if (!best || val > best.val) best = { x, y, val, contrast };
    }
  }
  if (!best) return null;
  // refine at full size: sum over the window of g gᵀ (q − p) = 0 for the corner q
  let qx = best.x * s.f + s.f / 2, qy = best.y * s.f + s.f / 2;
  const win = Math.max(6, Math.round(r * s.f * 0.8));
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
  // the board's angle here: edges round a corner run two ways a quarter turn apart, so average
  // the edge directions ×4 (both ways then agree) and divide by 4 → a line's angle, 0 … 90°
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
  return { x: qx, y: qy, contrast: best.contrast, angle };
}

// a smaller copy for the screen (grey bytes), about `size` px across
function preview(img, size) {
  const s = shrink(img, size);
  const data = new Uint8Array(s.w * s.h);
  for (let i = 0; i < data.length; i++) data[i] = Math.round(s.data[i]);
  return { w: s.w, h: s.h, data };
}

module.exports = { otsu, findDots, findCorner, shrink, preview };

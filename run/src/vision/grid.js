// Automatic power and speed calibration from a test grid (Pathline Prepare's Test grid: a square
// per process, each named "P % · V mm/s"). Once the grid has been cut, the head camera looks at
// every square and Pathline Run decides which cut through, then picks the setting to keep:
// the fastest speed that cut through, one power step above the lowest power that did there.
//
// Each square is measured along its own cut line, in the picture taken with the camera over it:
//  - line: how the line compares with the material just inside and outside it (a cut through
//    shows what's under the sheet; one that isn't leaves a groove: on clear acrylic, frosted)
//  - weakest: the line's weakest stretch (a bridge left uncut)
//  - inside: how the inside of the square differs from outside it (a piece that dropped)
// Which way each measure points differs by material, so it isn't assumed: the grid itself says.
// More power or a slower speed can only help a cut go through, so the squares that cut through
// lie on one side of a staircase across the grid (power up, speed down). The staircase and the
// threshold that fit the measures best decide, using whichever measure separates the grid most
// cleanly; how cleanly is the confidence.
'use strict';

const NAME = /^\s*(\d+(?:\.\d+)?)\s*%\s*·\s*(\d+(?:\.\d+)?)\s*mm\/s\s*$/;

// ---------------------------------------------------------------- the grid in a job
// { material: { id, name, thickness }, squares: [{ i (toolpath index), power, speed, p, c (centre),
// size }], powers, speeds } or null when the job isn't a power × speed test grid
function detect(pkg) {
  if (!pkg || !Array.isArray(pkg.toolpath)) return null;
  const procs = new Map((pkg.processes || []).map((p) => [p.index, p]));
  const squares = [];
  pkg.toolpath.forEach((s, i) => {
    if (s.type !== 'cut' || !Array.isArray(s.p) || s.p.length < 3) return;
    const pr = procs.get(s.process);
    if (!pr || !NAME.test(String(pr.name || ''))) return;
    const xs = s.p.map((q) => q[0]), ys = s.p.map((q) => q[1]);
    const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    squares.push({ i, power: Number(pr.power), speed: Number(pr.speed), p: s.p, closed: s.closed !== false, c: [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2], size: Math.max(box[2] - box[0], box[3] - box[1]) });
  });
  const powers = [...new Set(squares.map((s) => s.power))].sort((a, b) => a - b);
  const speeds = [...new Set(squares.map((s) => s.speed))].sort((a, b) => a - b);
  // a grid: two or more of each, power and speed both varying
  if (squares.length < 4 || powers.length < 2 || speeds.length < 2) return null;
  const m = pkg.material || {};
  return { material: { id: m.id || null, name: m.name || '', thickness: m.thickness }, squares, powers, speeds, name: (pkg.job && pkg.job.name) || '' };
}

// ---------------------------------------------------------------- measuring one square
// img: { w, h, data } grey; at: the bed point the camera was over (the picture's middle);
// M: the camera's matrix [a, b, c, d] (pixel offset → bed mm, vision.toBed)
function measure(img, sq, at, M) {
  const [a, b, c, d] = M, det = a * d - b * c;
  const px = (q) => { const dx = q[0] - at[0], dy = q[1] - at[1]; return [(d * dx - b * dy) / det + (img.w - 1) / 2, (-c * dx + a * dy) / det + (img.h - 1) / 2]; };
  const val = (q) => {
    const [x, y] = px(q);
    if (!(x >= 0 && y >= 0 && x < img.w - 1 && y < img.h - 1)) return NaN;
    const x0 = Math.floor(x), y0 = Math.floor(y), u = x - x0, v = y - y0, w = img.w, D = img.data;
    return (1 - u) * (1 - v) * D[y0 * w + x0] + u * (1 - v) * D[y0 * w + x0 + 1] + (1 - u) * v * D[(y0 + 1) * w + x0] + u * v * D[(y0 + 1) * w + x0 + 1];
  };
  const pts = sq.closed ? sq.p.concat([sq.p[0]]) : sq.p;
  const rel = [], outs = [];
  for (let k = 1; k < pts.length; k++) {
    const A = pts[k - 1], B = pts[k], L = Math.hypot(B[0] - A[0], B[1] - A[1]);
    if (L < 1e-6) continue;
    const t = [(B[0] - A[0]) / L, (B[1] - A[1]) / L], n = [-t[1], t[0]];
    // along the line, keeping 0.6 mm clear of its corners
    for (let s = 0.6; s <= L - 0.6; s += 0.2) {
      const q = [A[0] + t[0] * s, A[1] + t[1] * s];
      const at2 = (o) => val([q[0] + n[0] * o, q[1] + n[1] * o]);
      const line = [-0.12, 0, 0.12].map(at2);
      const side = [0.5, 0.7, -0.5, -0.7].map(at2);
      if (line.some(Number.isNaN) || side.some(Number.isNaN)) continue;
      const around = side.reduce((x, y) => x + y, 0) / 4;
      // the line's own level: its most different sample from the material either side
      const lo = Math.min(...line), hi = Math.max(...line);
      const l = Math.abs(lo - around) > Math.abs(hi - around) ? lo : hi;
      rel.push((around - l) / (around + 8));
      outs.push(around);
    }
  }
  if (rel.length < 8) return null;
  // the inside against a ring outside the square
  const box = [Math.min(...sq.p.map((q) => q[0])), Math.min(...sq.p.map((q) => q[1])), Math.max(...sq.p.map((q) => q[0])), Math.max(...sq.p.map((q) => q[1]))];
  const inner = [], ring = [];
  for (let x = box[0] - 2; x <= box[2] + 2; x += 0.4) {
    for (let y = box[1] - 2; y <= box[3] + 2; y += 0.4) {
      const inBox = x > box[0] + 1 && x < box[2] - 1 && y > box[1] + 1 && y < box[3] - 1;
      const outBox = x < box[0] - 0.8 || x > box[2] + 0.8 || y < box[1] - 0.8 || y > box[3] + 0.8;
      const v = val([x, y]);
      if (Number.isNaN(v)) continue;
      if (inBox) inner.push(v); else if (outBox) ring.push(v);
    }
  }
  const q = (arr, f) => { const s = arr.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(f * s.length))]; };
  const mean = (arr) => arr.reduce((x, y) => x + y, 0) / Math.max(1, arr.length);
  return {
    line: +q(rel, 0.5).toFixed(4),
    weakest: +q(rel, 0.1).toFixed(4),
    strongest: +q(rel, 0.9).toFixed(4),
    inside: inner.length && ring.length ? +((mean(inner) - mean(ring)) / (mean(ring) + 8)).toFixed(4) : 0,
    level: +q(outs, 0.5).toFixed(1),
    n: rel.length
  };
}

// ---------------------------------------------------------------- deciding
// The staircase fit for one measure: y (higher = more like a cut through) per square; through
// squares are, in each speed's row, those from some power index up, the index never falling as
// the speed rises. Brute force over thresholds, dynamic programming over the rows.
function staircase(grid, y) {
  const P = grid.powers, V = grid.speeds;
  const cell = new Map(grid.squares.map((s, k) => [P.indexOf(s.power) + ',' + V.indexOf(s.speed), k]));
  const vals = grid.squares.map((s, k) => y[k]).filter(Number.isFinite).sort((a, b) => a - b);
  if (vals.length < 4) return null;
  const spread = vals[vals.length - 1] - vals[0] || 1;
  let best = null;
  // thresholds: between each neighbouring pair, and beyond either end (all one way)
  const ts = [vals[0] - spread * 0.01].concat(vals.slice(1).map((v, k) => (v + vals[k]) / 2), [vals[vals.length - 1] + spread * 0.01]);
  // each square should sit clear of the threshold on its own side by a margin (a fifth of the
  // measure's range): calling every square one kind then costs something too, unless the measure
  // really is all one level (a plain hinge left "all cut through" as cheap as the true split)
  const margin = spread * 0.2;
  for (const t of ts) {
    // cost of a row with threshold index j (powers index >= j are through)
    const rowCost = (r, j) => {
      let c = 0;
      for (let pi = 0; pi < P.length; pi++) {
        const k = cell.get(pi + ',' + r);
        if (k === undefined || !Number.isFinite(y[k])) continue;
        c += pi >= j ? Math.max(0, margin - (y[k] - t)) : Math.max(0, margin - (t - y[k]));
      }
      return c;
    };
    // rows by speed ascending; j non-decreasing
    let prev = new Array(P.length + 1).fill(0), from = [];
    for (let r = 0; r < V.length; r++) {
      const cur = new Array(P.length + 1).fill(Infinity), arg = new Array(P.length + 1).fill(0);
      let bestPrev = Infinity, bestJ = 0;
      for (let j = 0; j <= P.length; j++) {
        if (prev[j] < bestPrev) { bestPrev = prev[j]; bestJ = j; }
        cur[j] = bestPrev + rowCost(r, j);
        arg[j] = bestJ;
      }
      from.push(arg);
      prev = cur;
    }
    let j = 0;
    for (let k = 1; k <= P.length; k++) if (prev[k] < prev[j]) j = k;
    const cost = prev[j] / spread;
    if (!best || cost < best.cost) {
      const js = new Array(V.length);
      js[V.length - 1] = j;
      for (let r = V.length - 1; r > 0; r--) js[r - 1] = from[r][js[r]];
      best = { t, cost, js };
    }
  }
  // labels, and how well the two kinds separate: the gap between their medians against their spread
  const through = grid.squares.map((s) => P.indexOf(s.power) >= best.js[V.indexOf(s.speed)]);
  const a = [], b = [];
  grid.squares.forEach((s, k) => { if (Number.isFinite(y[k])) (through[k] ? a : b).push(y[k]); });
  const med = (arr) => { const s = arr.slice().sort((x, z) => x - z); return s.length ? s[s.length >> 1] : NaN; };
  const mad = (arr, m) => med(arr.map((v) => Math.abs(v - m)));
  let sep = 0;
  if (a.length && b.length) { const ma = med(a), mb = med(b); sep = (ma - mb) / (1.4826 * Math.max(1e-6, (mad(a, ma) * a.length + mad(b, mb) * b.length) / (a.length + b.length)) + spread * 0.02); }
  return { ...best, through, sep, nThrough: a.length, nNot: b.length };
}

// Decide from the measures: each measure both ways round; the fit that separates best
function classify(grid, m) {
  // which way "more energy" points: power ÷ speed, the energy put into each mm
  const E = grid.squares.map((s) => s.power / s.speed);
  const rank = (arr) => { const idx = arr.map((v, k) => [v, k]).sort((x, y) => x[0] - y[0]); const r = new Array(arr.length); idx.forEach(([, k], i) => { r[k] = i; }); return r; };
  const corr = (x, y) => { const ok = x.map((v, k) => Number.isFinite(v) && Number.isFinite(y[k])); const xs = x.filter((v, k) => ok[k]), ys = y.filter((v, k) => ok[k]); if (xs.length < 4) return 0; const rx = rank(xs), ry = rank(ys); const n = xs.length, mx = (n - 1) / 2; let s = 0, sx = 0, sy = 0; for (let k = 0; k < n; k++) { s += (rx[k] - mx) * (ry[k] - mx); sx += (rx[k] - mx) ** 2; sy += (ry[k] - mx) ** 2; } return s / Math.sqrt(sx * sy || 1); };
  let best = null;
  for (const key of ['line', 'weakest', 'strongest', 'inside']) {
    const raw = m.map((x) => (x ? x[key] : NaN));
    const rc = corr(E, raw);
    if (Math.abs(rc) < 0.3) continue; // doesn't follow the energy at all
    const y = raw.map((v) => v * Math.sign(rc));
    const fit = staircase(grid, y);
    if (fit && (!best || fit.sep > best.sep)) best = { ...fit, key, sign: Math.sign(rc), corr: +rc.toFixed(3) };
  }
  if (!best) return { through: grid.squares.map(() => null), confident: false, why: 'The camera couldn\'t tell the squares apart: no measure followed the power and speed.' };
  // confident: the two kinds clearly apart, or all one kind with the measure following the energy strongly
  const confident = best.nThrough && best.nNot ? best.sep >= 3 : Math.abs(best.corr) >= 0.8;
  return { through: best.through, measure: best.key, sign: best.sign, corr: best.corr, separation: +best.sep.toFixed(2), confident };
}

// The setting to keep: the fastest speed that cut through, one power step above the lowest power
// that cut through at that speed (margin for the sheet's variation), when that one cut through too
function choose(grid, through) {
  const P = grid.powers, V = grid.speeds;
  const ok = (p, v) => grid.squares.some((s, k) => s.power === p && s.speed === v && through[k]);
  const all = grid.squares.length, n = through.filter(Boolean).length;
  if (!n) return { best: null, why: 'None of the squares cut through: try a grid with more power or slower speeds.' };
  for (let r = V.length - 1; r >= 0; r--) {
    const v = V[r];
    const ps = P.filter((p) => ok(p, v));
    if (!ps.length) continue;
    const lowest = ps[0], above = P[P.indexOf(lowest) + 1];
    const power = above !== undefined && ok(above, v) ? above : lowest;
    const why = (n === all ? 'Every square cut through, so the grid may not reach the limit: the' : 'The') +
      ' fastest speed that cut through is ' + v + ' mm/s, from ' + lowest + ' %' + (power !== lowest ? '. ' + power + ' %, one step above it, for margin' : '') + '.';
    return { best: { power, speed: v }, lowest: { power: lowest, speed: v }, why };
  }
  return { best: null, why: 'None of the squares cut through.' };
}

// ---------------------------------------------------------------- the whole check
// vision: the head camera (moveCamera, grab, cfg.matrix); returns the result to keep and show
async function inspect(vision, grid, ctl = {}, status = () => {}) {
  const M = vision.cfg.matrix;
  const m = [], thumbs = [];
  for (let k = 0; k < grid.squares.length; k++) {
    if (ctl.aborted) throw Object.assign(new Error('Stopped'), { code: 409 });
    const sq = grid.squares[k];
    status('Checking the test grid: square ' + (k + 1) + ' of ' + grid.squares.length);
    await vision.moveCamera(sq.c);
    const img = await vision.grab();
    m.push(measure(img, sq, sq.c, M));
    thumbs.push(thumb(img, sq, sq.c, M));
  }
  const cls = classify(grid, m);
  const pick = cls.through.every((v) => v === null) ? { best: null, why: cls.why } : choose(grid, cls.through);
  return {
    at: new Date().toISOString(), material: grid.material, name: grid.name, powers: grid.powers, speeds: grid.speeds,
    squares: grid.squares.map((s, k) => ({ i: s.i, power: s.power, speed: s.speed, through: cls.through[k], m: m[k], thumb: thumbs[k] })),
    measure: cls.measure || null, separation: cls.separation || 0, confident: !!cls.confident, ...pick
  };
}

// a small picture of the square (grey, ~96 px across, its middle at the square's middle)
function thumb(img, sq, at, M) {
  const [a, b, c, d] = M, det = a * d - b * c;
  const size = 96, mm = sq.size + 4;
  const out = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const q = [sq.c[0] + ((x - size / 2) / size) * mm, sq.c[1] + ((y - size / 2) / size) * mm];
      const dx = q[0] - at[0], dy = q[1] - at[1];
      const u = Math.round((d * dx - b * dy) / det + (img.w - 1) / 2), v = Math.round((-c * dx + a * dy) / det + (img.h - 1) / 2);
      out[y * size + x] = u >= 0 && v >= 0 && u < img.w && v < img.h ? img.data[v * img.w + u] : 0;
    }
  }
  return { w: size, h: size, mm, data: Buffer.from(out).toString('base64') };
}

module.exports = { detect, measure, classify, choose, inspect, staircase, NAME };

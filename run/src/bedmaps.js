// The Trotec's bed maps over time (data/bedmaps.json), newest last: each one the checkerboard
// made, with what it says about the machine. Kept so that
//   - a run can be replayed through the map it was sent with (run.placement.mapAt, follow-fit.js),
//   - a new map that differs a lot from the last is flagged: a machine doesn't change 1 ‰ in
//     scale or 0.1° in squareness in a day without a crash or a skipped belt tooth, a paper
//     board laid bent or damp does (Ruby, 3 → 12 Nov: Y scale 1.2 ‰, squareness 0.18°).
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = 'bedmaps.json';
const KEEP = 20;
// a new map further than this from the last is flagged
const LIMIT = { scale: 0.5, lean: 0.05 }; // ‰, degrees

function load(dir) {
  try { const l = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8')); return Array.isArray(l) ? l : []; } catch (e) { return []; }
}

function save(dir, list) {
  require('./safefile').write(path.join(dir, FILE), JSON.stringify(list.slice(-KEEP)));
}

// What a map says, from its own grid (the same for every map, however it was made): a straight
// line fitted to its corrections. scaleX, scaleY: ‰ (mm per metre the head is corrected by along
// X, Y); lean: degrees (X corrected per Y: the Y axis out of square); bend: mm, the most the map
// departs from a straight line (a smooth or every-corner map).
function summary(map) {
  const P = [];
  for (let j = 0; j < map.ny; j++) for (let i = 0; i < map.nx; i++) {
    const k = j * map.nx + i;
    P.push([map.x0 + i * map.step, map.y0 + j * map.step, map.ex[k], map.ey[k]]);
  }
  const lsq = (col) => {
    const N = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], B = [0, 0, 0];
    for (const p of P) { const v = [1, p[0], p[1]]; for (let r = 0; r < 3; r++) { B[r] += v[r] * p[col]; for (let c = 0; c < 3; c++) N[r][c] += v[r] * v[c]; } }
    const d3 = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const D = d3(N);
    return [0, 1, 2].map((k) => d3(N.map((row, i) => row.map((v, j) => (j === k ? B[i] : v)))) / D);
  };
  const fx = lsq(2), fy = lsq(3);
  let bend = 0;
  for (const p of P) bend = Math.max(bend, Math.hypot(p[2] - (fx[0] + fx[1] * p[0] + fx[2] * p[1]), p[3] - (fy[0] + fy[1] * p[0] + fy[2] * p[1])));
  return {
    scaleX: +(fx[1] * 1000).toFixed(3), scaleY: +(fy[2] * 1000).toFixed(3),
    lean: +((Math.atan(fx[2] - fy[1]) * 180) / Math.PI).toFixed(4), bend: +bend.toFixed(3)
  };
}

// how a map differs from another, and whether that's more than a machine drifts
function compare(a, b) {
  const d = { scaleX: +(b.scaleX - a.scaleX).toFixed(3), scaleY: +(b.scaleY - a.scaleY).toFixed(3), lean: +(b.lean - a.lean).toFixed(4) };
  d.big = Math.abs(d.scaleX) > LIMIT.scale || Math.abs(d.scaleY) > LIMIT.scale || Math.abs(d.lean) > LIMIT.lean;
  return d;
}

// a new map (info: the scan's own numbers, kept with it); returns { entry, since } where since is
// how it differs from the map before (null for the first)
function add(dir, map, at, info = {}) {
  const list = load(dir).filter((e) => e.at !== at);
  const entry = { at, ...summary(map), ...info, map };
  const prev = list[list.length - 1] || null;
  list.push(entry);
  save(dir, list);
  return { entry, since: prev ? { from: prev.at, ...compare(prev, entry) } : null };
}

// the map in use, kept too (a map made before this file existed)
function ensure(dir, map, at) {
  if (!map || !at) return;
  const list = load(dir);
  if (list.some((e) => e.at === at)) return;
  list.push({ at, ...summary(map), map, seeded: true });
  list.sort((p, q) => String(p.at).localeCompare(String(q.at)));
  save(dir, list);
}

const byAt = (dir, at) => (at ? load(dir).find((e) => e.at === at) || null : null);

module.exports = { load, add, ensure, byAt, summary, compare, LIMIT };

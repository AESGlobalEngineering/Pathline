#!/usr/bin/env node
// Motion calibration jobs for the head drawing and the time estimate, at 0 % power by default (the
// head moves as it would cut or engrave; the beam never fires). Each run records every head
// position, so follow-fit.js and the estimate can be fitted on them.
//   node tools/calibration-grid.js [shapes|engrave|hops] [--speeds 15,30,60] [--at x,y] [--power 0]
//  shapes:  squares (5, 10, 20, 40 mm) and circles (10, 20, 40 mm), each twice, a row per speed
//  engrave: filled bars (20 × 4 and 60 × 4 mm, 300 DPI) at each speed (default 100,200,400,600)
//  hops:    10 mm squares at 30 mm/s with travel of 20 to 600 mm between them, in X, Y and diagonally
// POST the output to /api/v1/jobs (or Import it on the screen).
'use strict';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const kind = ['shapes', 'engrave', 'hops'].find((k) => argv.includes(k)) || 'shapes';
const power = Number(opt('power', 0));
const [x0, y0] = String(opt('at', kind === 'hops' ? '100,120' : '390,270')).split(',').map(Number);
const speeds = String(opt('speeds', kind === 'engrave' ? '100,200,400,600' : kind === 'hops' ? '30' : '15,30,60')).split(',').map(Number);

const processes = speeds.map((v, k) => ({
  index: k, name: power + ' % · ' + v + ' mm/s', proc: kind === 'engrave' ? 'Engrave' : 'Cut', power, speed: v, f: kind === 'engrave' ? 300 : 5000, passes: 1, air: 'Off',
  dash: false, dl: 5, gl: 2, out: true, aci: [k + 1], adv: {}, ...(kind === 'engrave' ? { dir: 'down', uni: false } : {})
}));
const toolpath = [], entities = [];
const square = (x, y, s, k, name) => toolpath.push({ type: 'cut', process: k, closed: true, name, p: [[x, y], [x + s, y], [x + s, y + s], [x, y + s]] });

if (kind === 'shapes') {
  let y = y0;
  speeds.forEach((v, k) => {
    let x = x0;
    for (let rep = 0; rep < 2; rep++) for (const s of [5, 10, 20, 40]) { square(x, y, s, k, s + ' mm square at ' + v + ' mm/s'); x += s + 12; }
    for (let rep = 0; rep < 2; rep++) {
      for (const d of [10, 20, 40]) {
        const r = d / 2, cx = x + r, cy = y + r, n = 72;
        toolpath.push({ type: 'cut', process: k, closed: true, name: d + ' mm circle at ' + v + ' mm/s', p: Array.from({ length: n }, (_, i) => [+(cx + r * Math.cos((2 * Math.PI * i) / n)).toFixed(3), +(cy + r * Math.sin((2 * Math.PI * i) / n)).toFixed(3)]) });
        x += d + 12;
      }
    }
    y += 60;
  });
} else if (kind === 'engrave') {
  // a bar 20 × 4 mm and one 60 × 4 mm per speed, twice: one engrave step each
  let y = y0;
  speeds.forEach((v, k) => {
    let x = x0;
    for (let rep = 0; rep < 2; rep++) {
      for (const w of [20, 60]) {
        const id = 'bar' + k + '-' + rep + '-' + w;
        entities.push({ id, name: id, bed: 0, paths: [{ p: [[x, y], [x + w, y], [x + w, y + 4], [x, y + 4]], c: true }] });
        toolpath.push({ type: 'engrave', process: k, name: w + ' × 4 mm bar at ' + v + ' mm/s', ents: [id], bed: 0, dpi: 300, passes: 1, scan: 'across', direction: 'down', bidirectional: true, box: [x, y, x + w, y + 4] });
        x += w + 30;
      }
    }
    y += 20;
  });
} else {
  // hops: a 10 mm square, then travel of each length in X, in Y and diagonally to the next
  let x = x0, y = y0, n = 0;
  const lengths = [20, 50, 100, 200, 400, 600];
  for (const L of lengths) {
    for (const [dx, dy] of [[1, 0], [0, 1], [Math.SQRT1_2, Math.SQRT1_2]]) {
      square(x, y, 10, 0, 'square ' + (++n) + ' then ' + L + ' mm');
      let nx = x + dx * L, ny = y + dy * L;
      // stay on the bed: bounce back
      if (nx > 1150) nx = x - dx * L;
      if (ny > 760) ny = y - dy * L;
      x = Math.max(60, nx); y = Math.max(60, ny);
    }
  }
  square(x, y, 10, 0, 'last square');
}
// each step's time for Pathline's own estimate (length ÷ speed; Run times it itself)
for (const s of toolpath) {
  if (!s.p) { s.seconds = 1; continue; }
  let L = 0;
  for (let i = 0; i < s.p.length; i++) { const a = s.p[i], b = s.p[(i + 1) % s.p.length]; L += Math.hypot(b[0] - a[0], b[1] - a[1]); }
  s.seconds = +(L / processes[s.process].speed).toFixed(2);
}
const title = { shapes: 'shapes at ' + speeds.join('/') + ' mm/s', engrave: 'engraving at ' + speeds.join('/') + ' mm/s', hops: 'travel hops' }[kind];
const pkg = {
  format: 'lrc-job-package', version: 1, createdAt: new Date().toISOString(),
  job: { id: 'calibration-' + kind, name: 'Calibration · ' + title + ' · ' + power + ' %', notes: 'Motion calibration (head moves only at 0 %)' },
  machine: { type: 'laser', ctrl: 'Trotec' },
  material: { name: 'None (no beam)', thickness: 0 },
  beds: 1, cutOrder: { order: 'as drawn' },
  processes, toolpath, entities
};
process.stdout.write(JSON.stringify(pkg));

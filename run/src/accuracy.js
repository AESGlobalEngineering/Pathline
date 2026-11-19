// Setup → Camera → 4 · Check with a cut rectangle: the machine's accuracy measured with a ruler,
// not with a printed board. The laser cuts (or scores) a large rectangle and its two diagonals;
// its sides and diagonals, measured with a steel rule or tape, give the machine's X and Y scale and
// how far it is out of square, with the bed map as it is. If they're out, the bed map can be
// corrected by them.
//
// Why: Ruby's bed maps of 3 and 12 Nov differed by 1.2 ‰ in Y and 0.18° in squareness, about 3 mm
// over a metre. A machine doesn't change that much in a week; a paper board laid bent or damp
// does. A cut rectangle settles which.
'use strict';

const r3 = (v) => +v.toFixed(3);

// The job: a W × H mm rectangle and its diagonals, in the middle of the bed (power, speed: a score
// on card or a cut through thin board, whatever measures cleanly)
function rectJob(o, bed) {
  const [BW, BH] = bed;
  const w = Math.min(Number(o.w) || 1000, BW - 20), h = Math.min(Number(o.h) || 800, BH - 20);
  if (!(w >= 100 && h >= 100)) throw Object.assign(new Error('The rectangle must be at least 100 × 100 mm and fit on the bed'), { code: 400 });
  const x = Number.isFinite(Number(o.x)) && o.x !== '' && o.x !== null ? Number(o.x) : (BW - w) / 2;
  const y = Number.isFinite(Number(o.y)) && o.y !== '' && o.y !== null ? Number(o.y) : (BH - h) / 2;
  if (x < 0 || y < 0 || x + w > BW || y + h > BH) throw Object.assign(new Error('The rectangle doesn\'t fit on the ' + BW + ' × ' + BH + ' mm bed there'), { code: 400 });
  const power = Math.max(0, Math.min(100, Number(o.power) || 30)), speed = Math.max(1, Number(o.speed) || 50);
  const TL = [x, y], TR = [x + w, y], BR = [x + w, y + h], BL = [x, y + h];
  const toolpath = [
    { type: 'cut', process: 0, closed: true, name: 'Rectangle ' + w + ' × ' + h + ' mm', p: [TL, TR, BR, BL].map((q) => q.map(r3)) },
    { type: 'cut', process: 0, closed: false, name: 'Diagonal top left → bottom right', p: [TL, BR].map((q) => q.map(r3)) },
    { type: 'cut', process: 0, closed: false, name: 'Diagonal top right → bottom left', p: [TR, BL].map((q) => q.map(r3)) }
  ];
  for (const s of toolpath) {
    let L = 0;
    for (let i = 1; i < s.p.length; i++) L += Math.hypot(s.p[i][0] - s.p[i - 1][0], s.p[i][1] - s.p[i - 1][1]);
    if (s.closed) L += Math.hypot(s.p[0][0] - s.p[s.p.length - 1][0], s.p[0][1] - s.p[s.p.length - 1][1]);
    s.seconds = +(L / speed).toFixed(2);
  }
  return {
    format: 'lrc-job-package', version: 1, createdAt: new Date().toISOString(),
    job: { id: 'bed-check', name: 'Bed check · rectangle ' + w + ' × ' + h + ' mm', notes: 'Measure its sides and diagonals: Setup → Camera → Check with a cut rectangle' },
    machine: { type: 'laser' },
    material: { name: 'Card or thin board', thickness: 0 },
    beds: 1, cutOrder: { order: 'as drawn' },
    processes: [{ index: 0, name: power + ' % · ' + speed + ' mm/s', proc: 'Cut', power, speed, f: 5000, passes: 1, air: 'Off', dash: false, dl: 5, gl: 2, out: true, aci: [1], adv: {} }],
    toolpath, entities: [],
    bedCheck: { w, h, x, y }
  };
}

// From what was measured (mm): top, bottom (either or both), left, right (either or both), d1 the
// diagonal top left → bottom right, d2 top right → bottom left. Returns the machine's errors with
// the bed map as it is:
//   scaleX, scaleY: ‰ (the head goes this much further than told, per metre)
//   lean: degrees (+: the bottom of the rectangle is cut to the right of its top)
// and whether that's within what a ruler can tell (ok).
function measure(m) {
  const n = (k) => (Number.isFinite(Number(m[k])) && Number(m[k]) > 0 ? Number(m[k]) : null);
  const W = n('w'), H = n('h');
  if (!W || !H) throw Object.assign(new Error('The rectangle\'s size is missing'), { code: 400 });
  const avg = (a, b) => (a && b ? (a + b) / 2 : a || b);
  const a = avg(n('top'), n('bottom')), b = avg(n('left'), n('right'));
  if (!a || !b) throw Object.assign(new Error('Measure at least one side across (top or bottom) and one down (left or right)'), { code: 400 });
  const d1 = n('d1'), d2 = n('d2');
  const out = { w: W, h: H, scaleX: r3((a / W - 1) * 1000), scaleY: r3((b / H - 1) * 1000), lean: null };
  // a parallelogram x' = x + t·y: d1² − d2² = 4·a·b·t
  if (d1 && d2) {
    out.lean = +((Math.atan((d1 * d1 - d2 * d2) / (4 * a * b)) * 180) / Math.PI).toFixed(4);
    // the diagonals against the sides: a check on the measuring (a parallelogram's d1² + d2² =
    // 2(a² + b²)), as a length (mm)
    out.misfit = +Math.abs(Math.sqrt((d1 * d1 + d2 * d2) / 2) - Math.sqrt(a * a + b * b)).toFixed(2);
  }
  // a careful rule reading is good to about ±0.3 mm over a metre
  const tol = { scale: 0.4, lean: 0.03 };
  out.ok = Math.abs(out.scaleX) <= tol.scale && Math.abs(out.scaleY) <= tol.scale && (out.lean === null || Math.abs(out.lean) <= tol.lean);
  out.tol = tol;
  return out;
}

// The bed map corrected by a check made with it on: what was left over, added to its errors (the
// head goes where it's told plus the map's error; the check measured what the map still missed).
// Kept anchored at the machine's zero, as every map is.
function correctMap(map, res) {
  const sx = (res.scaleX || 0) / 1000, sy = (res.scaleY || 0) / 1000, t = Math.tan(((res.lean || 0) * Math.PI) / 180);
  const out = { ...map, ex: map.ex.slice(), ey: map.ey.slice() };
  for (let j = 0; j < map.ny; j++) for (let i = 0; i < map.nx; i++) {
    const k = j * map.nx + i, x = map.x0 + i * map.step, y = map.y0 + j * map.step;
    out.ex[k] = r3(map.ex[k] + sx * x + t * y);
    out.ey[k] = r3(map.ey[k] + sy * y);
  }
  return out;
}

// a flat map (no correction) the size of the bed, for a check made with no map yet
function flatMap(bed, step = 50) {
  const nx = Math.ceil(bed[0] / step) + 1, ny = Math.ceil(bed[1] / step) + 1;
  return { x0: 0, y0: 0, step, nx, ny, ex: new Array(nx * ny).fill(0), ey: new Array(nx * ny).fill(0) };
}

module.exports = { rectJob, measure, correctMap, flatMap };

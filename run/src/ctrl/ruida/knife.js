// Plan → RDD6584 knife-controller job files (unswizzled). Not the laser layout in compile.js:
// a knife job is uploaded to the controller as a file called START and then started
// (link.runFile), and every cut carries the knife's angle. Field by field, this copies what
// VCutWorks sent a YC-1610 (card 0x6910): knife lines, squares and rectangles, a pen square,
// a row of punches, and a pen + knife + punch job, with feeds (recorded Nov 2026).
//
// One layer per Pathline process. Its tool is a code (CA 41 part code, and CA 00 at the
// layer's start, + 0x40 on every layer after the first): oscillating knife 00, pen 11, punch 20.
//   knife, per straight run:  80 x y a · E7 3A 01 · E7 35 (1500 − y max, 1700 − y min)
//                             · CA 08 a · A0 x y a … · CA 09 v      (a = angle, 0.001°)
//   pen, per path:            80 x y a · CA 08 a · A0 x y a … · CA 09 v
//   punch, per hole:          80 x y 0 · CA 0A 5000
//   CA 09 v: 0 after each cut, and a value at the end of the job that isn't understood yet
//   (written as 0; the controller runs the job anyway)
//   E7 18 n                   end of layer n (1, 2, 3 …)
//   E7 06 2 L                 after the job, feed L µm (the controller clamps and pulls along Y)
//   F3 0A k · F3 09 n         k = 1 when the knife is used, n = number of layers
//   DA 01 0620 L L            the job's cut length, |dx| + |dy| in mm
// Pathline's beds become one file each; a bed with a feed after it carries that feed.
'use strict';

const { RD, abs } = require('./rd');
const { trace } = require('../../job/plan');

const um = (mm) => Math.round(mm * 1000);
const two = (n) => [(n >> 7) & 0x7f, n & 0x7f];
// angle of travel from a to b, 0.001° (0 = +X, 90° = +Y), 0 … 359.999°
const angle = (a, b) => { let d = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI; if (d < 0) d += 360; return Math.round(d * 1000) % 360000; };
const turn = (a1, a2) => { const d = Math.abs(a1 - a2) % 360000; return Math.min(d, 360000 - d) / 1000; };

const TOOL = { knife: 0x00, pen: 0x11, punch: 0x20 };
// the tool a process uses, from its name ("T2 · Punch") or Setup → Tools
function toolOf(proc, cfg) {
  const name = (String((proc && proc.tool) || '').split(' · ')[1] || ((cfg.heads || []).find((h) => proc && h.slot === proc.slot) || {}).tool || '').toLowerCase();
  if (/pen|marker|plot/.test(name)) return 'pen';
  if (/punch|hole/.test(name)) return 'punch';
  return 'knife';
}

// punch holes along a path: a small closed shape is one hole at its middle, anything else a
// hole every `step` mm along it (as VCutWorks punched a line: every 5 mm)
function holes(pts, step) {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const closed = pts.length > 2 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 0.01;
  if (closed && Math.max(...xs) - Math.min(...xs) <= 10 && Math.max(...ys) - Math.min(...ys) <= 10) return [[(Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...ys) + Math.min(...ys)) / 2]];
  const out = [pts[0]];
  let left = step;
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let at = left;
    while (at <= len + 1e-9) { out.push([a[0] + ((b[0] - a[0]) * at) / len, a[1] + ((b[1] - a[1]) * at) / len]); at += step; }
    left = at - len;
  }
  return out;
}

// one bed: layers [{ tool, speed, runs: [[x, y]…]… }] (machine mm, from the origin) → file bytes
function bedFile(layers, opts = {}) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  const grow = (b, [x, y]) => { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); };
  for (const l of layers) { l.box = [Infinity, Infinity, -Infinity, -Infinity]; for (const r of l.runs) for (const p of r) { grow(box, p); grow(l.box, p); } }
  const fix = (b) => (Number.isFinite(b[0]) ? b : [0, 0, 0, 0]).map(um);
  const [x0, y0, x1, y1] = fix(box);
  const card = opts.card || 0x6910;
  const liftAt = opts.liftAngle || 20; // knife: bends sharper than this lift, turn and plunge again
  const knifeOnly = layers.every((l) => l.tool === 'knife');
  let length = 0;

  const body = [];
  layers.forEach((l, k) => {
    body.push(0xca, 0x00, TOOL[l.tool] | (k ? 0x40 : 0), 0xca, 0x02, k, ...RD.speed(l.speed));
    for (const p of l.runs) {
      if (l.tool === 'punch') {
        for (const [x, y] of holes(p, opts.punchStep || 5)) body.push(0x80, ...abs(um(x)), ...abs(um(y)), ...abs(0), 0xca, 0x0a, ...abs(5000));
        continue;
      }
      let i = 0;
      while (i < p.length - 1) {
        // the pen draws a path in one go; the knife as far as the bends stay shallow
        let e = i + 1;
        while (e < p.length - 1 && (l.tool === 'pen' || turn(angle(p[e - 1], p[e]), angle(p[e], p[e + 1])) <= liftAt)) e++;
        const run = p.slice(i, e + 1);
        const a0 = angle(run[0], run[1]);
        body.push(0x80, ...abs(um(run[0][0])), ...abs(um(run[0][1])), ...abs(a0));
        if (l.tool === 'knife') {
          const ys = run.map((q) => um(q[1]));
          body.push(0xe7, 0x3a, 0x01, 0xe7, 0x35, ...abs(1500000 - Math.max(...ys)), ...abs(1700000 - Math.min(...ys)));
        }
        body.push(0xca, 0x08, ...abs(a0));
        for (let j = 1; j < run.length; j++) {
          body.push(0xa0, ...abs(um(run[j][0])), ...abs(um(run[j][1])), ...abs(angle(run[j - 1], run[j])));
          length += Math.abs(run[j][0] - run[j - 1][0]) + Math.abs(run[j][1] - run[j - 1][1]);
        }
        body.push(0xca, 0x09, ...abs(0));
        i = e;
      }
    }
    body.push(0xe7, 0x18, ...abs(k + 1));
  });

  const feed = opts.feed > 0 ? [2, um(opts.feed)] : [0, 0];
  const f = [];
  f.push(0xd8, 0x10, ...abs(x1), ...abs(y1), 0x04, knifeOnly ? 0x0c : 0x0d);
  f.push(0xe6, 0x01, 0xca, 0x30, (card >> 8) & 0x7f, card & 0x7f, 0xf1, 0x02, 0x00, ...RD.start());
  f.push(0xe7, 0x18, ...abs(0), 0xe7, 0x65, ...abs(0));
  f.push(0xe7, 0x06, ...abs(feed[0]), ...abs(feed[1]), 0xe7, 0x38, 0x00, 0xe7, 0x3b, 0x40);
  f.push(0xe7, 0x03, ...abs(x0), ...abs(y0), 0xe7, 0x07, ...abs(x1), ...abs(y1));
  f.push(0xe7, 0x50, ...abs(x0 - 20000), ...abs(y0 - 20000), 0xe7, 0x51, ...abs(x1 + 20000), ...abs(y1 + 20000));
  f.push(0xe7, 0x04, ...two(1), ...two(1), ...abs(0), ...abs(0), 0xe7, 0x05, 0x00);
  f.push(0xf3, 0x0a, ...abs(0), layers.some((l) => l.tool === 'knife') ? 1 : 0, 0xf3, 0x09, ...abs(0), Math.max(1, layers.length));
  layers.forEach((l, k) => {
    const [a, b, c, d] = fix(l.box);
    f.push(...RD.partSpeed(k, l.speed), 0xca, 0x06, k, ...abs(0), 0xca, 0x41, k, TOOL[l.tool]);
    f.push(0xe7, 0x52, k, ...abs(a), ...abs(b), 0xe7, 0x53, k, ...abs(c), ...abs(d));
  });
  f.push(0xca, 0x22, Math.max(0, layers.length - 1), 0xe7, 0x66, 0x02, 0xea, 0x01, 0xe7, 0x60, 0x01);
  f.push(0xe7, 0x13, ...abs(x0), ...abs(y0), 0xe7, 0x17, ...abs(x1), ...abs(y1));
  f.push(0xe7, 0x23, ...abs(0), ...abs(0), 0xe7, 0x24, 0x00);
  // the job's size; VCutWorks writes the width negative when only the knife is used
  const w = knifeOnly ? x0 - x1 : x1 - x0;
  f.push(0xe7, 0x37, ...abs(w), ...abs(y1 - y0));
  f.push(0xe7, 0x08, ...two(1), ...two(1), ...abs(w), ...abs(y1 - y0));
  f.push(...body);
  f.push(0xeb, 0xe7, 0x00);
  const L = Math.round(length);
  f.push(0xda, 0x01, 0x06, 0x20, ...abs(L), ...abs(L), 0xd7);
  return Buffer.from(f);
}

// Pathline's bed (origin top left, Y to the front) → the machine's job coordinates. A YC-1610
// counts from home, its top right corner, X to the left (Setup → Ruida origin "top right"): a
// shape at the right of the bed has a small X. Knife angles follow from the mapped points.
// The controller runs a job relative to home itself (it refuses one that reaches past home,
// "frame slop"), so nothing is subtracted.
function mapPts(cfg) {
  const r = cfg.ruida || {};
  const [W, H] = cfg.bed || [0, 0];
  const fx = r.origin === 'tr' || r.origin === 'br', fy = r.origin === 'bl' || r.origin === 'br';
  return (pts) => pts.map(([x, y]) => [fx ? W - x : x, fy ? H - y : y]);
}

// opts.card: the controller's card ID (from link.info), for CA 30
function compile(plan, cfg, opts = {}) {
  const warnings = plan.warnings.slice();
  const map = mapPts(cfg);
  const feedLen = cfg.feedLen || 1000;
  const segments = [];
  let bed = null;
  const close = (feed) => {
    if (!bed) return;
    const data = bedFile([...bed.layers.values()], { ...opts, feed, liftAngle: cfg.timing && cfg.timing.liftAngle });
    segments.push({ kind: 'file', data, steps: bed.steps.map((s) => ({ i: s.i, seconds: s.seconds })), seconds: bed.steps.reduce((a, s) => a + s.seconds, 0), trace: [].concat(...bed.steps.map(trace)) });
    bed = null;
  };
  for (const step of plan.steps) {
    if (step.op === 'dwell' || step.op === 'inspect') { close(0); if (!opts.file) segments.push({ ...step, kind: step.op }); continue; }
    if (step.op === 'feed') { if (!bed) bed = { layers: new Map(), steps: [] }; bed.steps.push(step); close(feedLen); continue; }
    if (step.op === 'toolchange') continue; // each layer names its tool
    if (step.op === 'engrave') { warnings.push('Step ' + (step.i + 1) + ': engraving can\'t run on a knife cutter'); continue; }
    if (!bed) bed = { layers: new Map(), steps: [] };
    bed.steps.push(step);
    // one layer per process, in the order Pathline runs them
    const key = step.proc.index;
    if (!bed.layers.has(key)) bed.layers.set(key, { tool: toolOf(step.proc, cfg), speed: step.proc.speed, runs: [] });
    for (const run of step.runs) if (run.length > 1) bed.layers.get(key).runs.push(map(run));
  }
  close(0);
  return { ctrl: 'ruida', knife: true, name: plan.name, segments, seconds: plan.seconds, warnings };
}

// the Conveyor button: a job with no cuts and a feed after it, as a pen layer so the knife
// (and its oscillation) isn't started
const feedFile = (mm, opts = {}) => bedFile([{ tool: 'pen', speed: 60, runs: [] }], { ...opts, feed: mm });

module.exports = { compile, bedFile, feedFile, angle, mapPts, toolOf, holes };

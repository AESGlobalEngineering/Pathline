// Plan → RDD6584 knife-controller job files (unswizzled). Not the laser layout in compile.js:
// a knife job is uploaded to the controller as a file called START and then started
// (link.runFile), and every cut carries the knife's angle. Field by field, this copies what
// VCutWorks sent a YC-1610 (card 0x6910) for a line, two squares and a long rectangle, each
// with a feed after it (recorded Nov 2026):
//   80 x y a           move to the start of a cut, knife pointing at angle a (0.001°)
//   E7 3A 01 · E7 35 (1500 − y max, 1700 − y min) of the cut · CA 08 a     before plunging
//   A0 x y a           cut to (x, y); further A0s continue a cut round shallow bends
//   CA 09 v            after each cut: 0, and a value at the end of the job that isn't
//                      understood yet (written as 0)
//   E7 06 2 L          after the job, feed L µm (the controller clamps and pulls along Y)
//   DA 01 0620 L L     the job's cut length, |dx| + |dy| in mm
// Pathline's beds become one file each; a bed with a feed after it carries that feed.
'use strict';

const { RD, abs } = require('./rd');
const { trace } = require('../../job/plan');

const um = (mm) => Math.round(mm * 1000);
const two = (n) => [(n >> 7) & 0x7f, n & 0x7f];
// angle of travel from a to b, 0.001° (0 = +X, 90° = +Y), 0 … 359.999°
const angle = (a, b) => { let d = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI; if (d < 0) d += 360; return Math.round(d * 1000) % 360000; };
const turn = (a1, a2) => { const d = Math.abs(a1 - a2) % 360000; return Math.min(d, 360000 - d) / 1000; };

// one bed: its cuts (each { speed, pts }) → file bytes
function bedFile(cuts, opts) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const c of cuts) for (const [x, y] of c.pts) { box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y); }
  if (!Number.isFinite(box[0])) box.splice(0, 4, 0, 0, 0, 0);
  const [x0, y0, x1, y1] = box.map(um);
  const card = opts.card || 0x6910;
  const speed = cuts.length ? cuts[0].speed : 50;
  const liftAt = opts.liftAngle || 20; // bends sharper than this: lift, turn the knife, plunge again
  let length = 0;

  const moves = [];
  for (const c of cuts) {
    if (c.speed !== speed) moves.push(...RD.speed(c.speed));
    const p = c.pts;
    let k = 0;
    while (k < p.length - 1) {
      // one plunge: as far along the run as the bends stay shallow
      let e = k + 1;
      while (e < p.length - 1 && turn(angle(p[e - 1], p[e]), angle(p[e], p[e + 1])) <= liftAt) e++;
      const run = p.slice(k, e + 1);
      const ys = run.map((q) => um(q[1]));
      const a0 = angle(run[0], run[1]);
      moves.push(0x80, ...abs(um(run[0][0])), ...abs(um(run[0][1])), ...abs(a0));
      moves.push(0xe7, 0x3a, 0x01, 0xe7, 0x35, ...abs(1500000 - Math.max(...ys)), ...abs(1700000 - Math.min(...ys)));
      moves.push(0xca, 0x08, ...abs(a0));
      for (let j = 1; j < run.length; j++) {
        moves.push(0xa0, ...abs(um(run[j][0])), ...abs(um(run[j][1])), ...abs(angle(run[j - 1], run[j])));
        length += Math.abs(run[j][0] - run[j - 1][0]) + Math.abs(run[j][1] - run[j - 1][1]);
      }
      moves.push(0xca, 0x09, ...abs(0));
      k = e;
    }
  }

  const feed = opts.feed > 0 ? [2, um(opts.feed)] : [0, 0];
  const f = [];
  f.push(0xd8, 0x10, ...abs(x1), ...abs(y1), 0x04, 0x0c);
  f.push(0xe6, 0x01, 0xca, 0x30, (card >> 8) & 0x7f, card & 0x7f, 0xf1, 0x02, 0x00, ...RD.start());
  f.push(0xe7, 0x18, ...abs(0), 0xe7, 0x65, ...abs(0));
  f.push(0xe7, 0x06, ...abs(feed[0]), ...abs(feed[1]), 0xe7, 0x38, 0x00, 0xe7, 0x3b, 0x40);
  f.push(0xe7, 0x03, ...abs(x0), ...abs(y0), 0xe7, 0x07, ...abs(x1), ...abs(y1));
  f.push(0xe7, 0x50, ...abs(x0 - 20000), ...abs(y0 - 20000), 0xe7, 0x51, ...abs(x1 + 20000), ...abs(y1 + 20000));
  f.push(0xe7, 0x04, ...two(1), ...two(1), ...abs(0), ...abs(0), 0xe7, 0x05, 0x00);
  f.push(0xf3, 0x0a, ...abs(0), 0x01, 0xf3, 0x09, ...abs(0), 0x01);
  f.push(...RD.partSpeed(0, speed), 0xca, 0x06, 0x00, ...abs(0), 0xca, 0x41, 0x00, 0x00);
  f.push(0xe7, 0x52, 0x00, ...abs(x0), ...abs(y0), 0xe7, 0x53, 0x00, ...abs(x1), ...abs(y1));
  f.push(0xca, 0x22, 0x00, 0xe7, 0x66, 0x02, 0xea, 0x01, 0xe7, 0x60, 0x01);
  f.push(0xe7, 0x13, ...abs(x0), ...abs(y0), 0xe7, 0x17, ...abs(x1), ...abs(y1));
  f.push(0xe7, 0x23, ...abs(0), ...abs(0), 0xe7, 0x24, 0x00);
  f.push(0xe7, 0x37, ...abs(x0 - x1), ...abs(y1 - y0));
  f.push(0xe7, 0x08, ...two(1), ...two(1), ...abs(x0 - x1), ...abs(y1 - y0));
  f.push(0xca, 0x00, 0x00, 0xca, 0x02, 0x00, ...RD.speed(speed));
  f.push(...moves);
  f.push(0xe7, 0x18, ...abs(1), 0xeb, 0xe7, 0x00);
  const L = Math.round(length);
  f.push(0xda, 0x01, 0x06, 0x20, ...abs(L), ...abs(L), 0xd7);
  return Buffer.from(f);
}

// opts.card: the controller's card ID (from link.info), for CA 30
function compile(plan, cfg, opts = {}) {
  const warnings = plan.warnings.slice();
  const feedLen = cfg.feedLen || 1000;
  const segments = [];
  let bed = null;
  const close = (feed) => {
    if (!bed) return;
    const data = bedFile(bed.cuts, { ...opts, feed, liftAngle: cfg.timing && cfg.timing.liftAngle });
    segments.push({ kind: 'file', data, steps: bed.steps.map((s) => ({ i: s.i, seconds: s.seconds })), seconds: bed.steps.reduce((a, s) => a + s.seconds, 0), trace: [].concat(...bed.steps.map(trace)) });
    bed = null;
  };
  const tools = new Set();
  for (const step of plan.steps) {
    if (step.op === 'dwell' || step.op === 'inspect') { close(0); if (!opts.file) segments.push({ ...step, kind: step.op }); continue; }
    if (step.op === 'feed') { if (!bed) bed = { cuts: [], steps: [] }; bed.steps.push(step); close(feedLen); continue; }
    if (step.op === 'toolchange') continue;
    if (step.op === 'engrave') { warnings.push('Step ' + (step.i + 1) + ': engraving can\'t run on a knife cutter'); continue; }
    if (!bed) bed = { cuts: [], steps: [] };
    bed.steps.push(step);
    if (step.proc && step.proc.slot) tools.add(step.proc.slot);
    for (const run of step.runs) if (run.length > 1) bed.cuts.push({ speed: step.proc.speed, pts: run });
  }
  close(0);
  if (tools.size > 1) warnings.push('This job uses ' + [...tools].join(', ') + ': on the RDD6584 every cut uses the tool chosen on the machine for now');
  return { ctrl: 'ruida', knife: true, name: plan.name, segments, seconds: plan.seconds, warnings };
}

// the Conveyor button: a job with no cuts and a feed after it
const feedFile = (mm, opts = {}) => bedFile([], { ...opts, feed: mm });

module.exports = { compile, bedFile, feedFile, angle };

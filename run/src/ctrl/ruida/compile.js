// Plan → Ruida .rd byte stream (unswizzled; swizzle when saving or sending).
// File layout follows MeerK40t's RDJob writer: header with bounds and one
// "part" (layer) per process, then per layer a settings block and the moves,
// then the tail with the file checksum.
'use strict';

const { RD, abs, rel, swizzle, listing } = require('./rd');
const { scanLines, trace } = require('../../job/plan');

// AutoCAD colour index → RGB for the layer colour shown on the controller
const ACI_RGB = { 1: 0xff0000, 2: 0xffff00, 3: 0x00ff00, 4: 0x00ffff, 5: 0x0000ff, 6: 0xff00ff, 7: 0x000000, 8: 0x808080, 9: 0xc0c0c0 };
const bgr = (rgb) => ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff);
const REL_MAX = 8191;

function settings(cfg) {
  const r = cfg.ruida || {};
  return { origin: r.origin || 'tr', magic: r.magic !== undefined ? r.magic : 0x88, minPower: r.minPower, bed: cfg.bed };
}

// bed mm (origin top left, Y to the front) → controller µm
function mapper(S) {
  const [W, H] = S.bed;
  const fx = S.origin === 'tr' || S.origin === 'br';
  const fy = S.origin === 'bl' || S.origin === 'br';
  return {
    x: (mm) => Math.round((fx ? W - mm : mm) * 1000),
    y: (mm) => Math.round((fy ? H - mm : mm) * 1000),
    dir: fx ? -1 : 1,
    toMm: (ux, uy) => [fx ? W - ux / 1000 : ux / 1000, fy ? H - uy / 1000 : uy / 1000]
  };
}

// opts.file: one stream for a file on disk (dwells and marks dropped)
function compile(plan, cfg, opts = {}) {
  const S = settings(cfg);
  const M = mapper(S);
  const warnings = plan.warnings.slice();
  const parts = new Map(); // process index → part number
  for (const s of plan.steps) if (s.proc && !parts.has(s.proc.index)) parts.set(s.proc.index, parts.size);
  if (parts.size > 127) warnings.push('More than 127 processes: Ruida layer numbers repeat after 127');
  const partOf = (p) => parts.get(p.index) % 128;
  const minPowerOf = (p) => (p.powerCorrection !== null ? Math.min(p.power, p.powerCorrection) : S.minPower !== undefined ? Math.min(p.power, S.minPower) : p.power);

  // Plotter on a Ruida: each tool is wired to one of the controller's four outputs (Setup → Tools).
  // A tool's layer sets its output to 100 % and the others to 0 %, so "beam on" lowers that
  // tool only. Tool down/up times go in the laser on/off delays. Conveyor feeds move the U axis.
  const heads = cfg.heads || [];
  const outputOf = (p) => { const h = heads.find((x) => x.slot === p.slot); return h ? Math.min(4, Math.max(1, Number(h.output) || 1)) : 1; };
  const outputPowers = (out) => [1, 2, 3, 4].map((k) => (k === out ? 100 : 0));
  const timing = cfg.timing || {};
  let u = opts.uStart || 0; // conveyor (U axis) position, mm: read from the controller before a job
  for (const s of plan.steps) {
    if (s.proc && s.proc.kind === 'tool' && !heads.some((h) => h.slot === s.proc.slot)) {
      warnings.push(s.proc.slot + ' isn\'t set up (Setup → Tools): "' + s.proc.name + '" uses output 1');
    }
  }

  // group steps into streams separated by dwells / marks
  const groups = [];
  let g = null;
  for (const step of plan.steps) {
    if (step.op === 'dwell' || step.op === 'inspect') {
      if (opts.file) continue;
      g = null; groups.push({ ...step, kind: step.op }); continue;
    }
    if (!g) { g = { kind: 'stream', steps: [] }; groups.push(g); }
    g.steps.push(step);
  }

  const segments = groups.map((grp) => {
    if (grp.kind !== 'stream') return grp;
    // body first (so the header can carry the real bounds)
    const body = [];
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    const see = (x, y) => { box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y); };
    const partBox = new Map();
    const seePart = (part, x, y) => {
      see(x, y);
      const b = partBox.get(part) || [Infinity, Infinity, -Infinity, -Infinity];
      b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y);
      partBox.set(part, b);
    };
    let curProc = null;
    let first = true;
    const layer = (p, raster) => {
      if (curProc === p) return;
      if (!first) body.push(...RD.layerEnd());
      first = false;
      curProc = p;
      if (p.kind === 'tool') {
        const pw = outputPowers(outputOf(p));
        body.push(...RD.layerNumber(partOf(p)), ...RD.laserDevice0(), ...RD.airOff());
        body.push(...RD.speed(p.speed), ...RD.laserOnDelay(timing.toolDown || 0), ...RD.laserOffDelay(timing.toolUp || 0));
        body.push(...RD.minPower1(pw[0]), ...RD.maxPower1(pw[0]), ...RD.minPower2(pw[1]), ...RD.maxPower2(pw[1]));
        body.push(...RD.minPower3(pw[2]), ...RD.maxPower3(pw[2]), ...RD.minPower4(pw[3]), ...RD.maxPower4(pw[3]), ...RD.enLaserTubeStart());
        return;
      }
      if (raster) body.push(0xca, 0x01, 0x03); // work mode 3: horizontal scanning
      body.push(...RD.layerNumber(partOf(p)), ...RD.laserDevice0());
      body.push(...(p.air && cfg.f.air !== false ? RD.airOn() : RD.airOff()));
      body.push(...RD.speed(p.speed), ...RD.laserOnDelay(0), ...RD.laserOffDelay(0));
      const lo = minPowerOf(p);
      body.push(...RD.minPower1(lo), ...RD.maxPower1(p.power), ...RD.minPower2(lo), ...RD.maxPower2(p.power), ...RD.enLaserTubeStart());
    };
    const relX = (op, d) => {
      // relative X moves (0x8A beam off, 0xAA beam on) in pieces of at most ±8.191 mm
      let left = d;
      while (left !== 0) {
        const n = Math.max(-REL_MAX, Math.min(REL_MAX, left));
        body.push(op, ...rel(n));
        left -= n;
      }
    };
    const seconds = grp.steps.reduce((a, s) => a + s.seconds, 0);
    for (const step of grp.steps) {
      const p = step.proc;
      // conveyor: advance the material one bed (U axis), then the next bed's steps follow
      if (step.op === 'feed') {
        u += cfg.feedLen || 1000;
        body.push(...RD.moveU(Math.round(u * 1000)));
        continue;
      }
      if (step.op === 'toolchange') continue; // the next layer selects the tool's output
      const part = partOf(p);
      if (step.op === 'cut') {
        layer(p, false);
        for (const run of step.runs) {
          const [sx, sy] = [M.x(run[0][0]), M.y(run[0][1])];
          body.push(...RD.moveAbs(sx, sy));
          seePart(part, sx, sy);
          for (let k = 1; k < run.length; k++) {
            const [x, y] = [M.x(run[k][0]), M.y(run[k][1])];
            body.push(...RD.cutAbs(x, y));
            seePart(part, x, y);
          }
        }
      } else if (step.op === 'engrave') {
        layer(p, true);
        const pitch = 25.4 / step.dpi;
        const lines = scanLines(step, pitch);
        const os = (p.speed * p.speed) / (2 * (cfg.acc || 20000)) + 2 + p.overshoot;
        const xs = Math.max(0, step.box[0] - os);
        const xe = Math.min(S.bed[0], step.box[2] + os);
        lines.forEach((ln, k) => {
          const fwd = !step.bidi || k % 2 === 0;
          const y = M.y(ln.y);
          // walk along the line in bed mm, then convert each distance to controller µm
          const xsU = M.x(xs), xeU = M.x(xe);
          const startU = fwd ? xsU : xeU, endU = fwd ? xeU : xsU;
          body.push(...RD.moveAbs(startU, y));
          seePart(part, startU, y); seePart(part, endU, y);
          const edges = [];
          for (const [a, b] of ln.spans) edges.push(M.x(a), M.x(b));
          if (!fwd) edges.reverse();
          let at = startU;
          edges.forEach((e, i) => { relX(i % 2 === 0 ? 0x8a : 0xaa, e - at); at = e; });
          relX(0x8a, endU - at);
        });
        if (!lines.length) warnings.push('Step ' + (step.i + 1) + ' (' + p.name + '): nothing to engrave');
      }
    }
    if (!Number.isFinite(box[0])) box.splice(0, 4, 0, 0, 0, 0);

    // header
    const h = [];
    const tlx = M.dir < 0 ? box[2] : box[0];
    const brx = M.dir < 0 ? box[0] : box[2];
    h.push(0xd8, 0x10, 0xe6, 0x01, 0xf0, 0xf1, 0x02, 0x00, ...RD.start());
    h.push(0xe7, 0x06, ...abs(0), ...abs(0), 0xe7, 0x38, 0x00);
    h.push(0xe7, 0x03, ...abs(tlx), ...abs(box[1]), 0xe7, 0x07, ...abs(brx), ...abs(box[3]));
    h.push(0xe7, 0x50, ...abs(tlx), ...abs(box[1]), 0xe7, 0x51, ...abs(brx), ...abs(box[3]));
    h.push(0xe7, 0x04, ...[1, 1, 0, 0, 0, 0, 0].flatMap((v) => rel(v)), 0xe7, 0x05, 0x00);
    const used = [...new Set(grp.steps.map((s) => s.proc).filter(Boolean))];
    for (const p of used) {
      const part = partOf(p);
      const b = partBox.get(part) || box;
      if (p.kind === 'tool') {
        const pw = outputPowers(outputOf(p));
        h.push(...RD.partSpeed(part, p.speed), ...RD.partMinPower1(part, pw[0]), ...RD.partMaxPower1(part, pw[0]), ...RD.partMinPower2(part, pw[1]), ...RD.partMaxPower2(part, pw[1]));
        h.push(...RD.partMinPower3(part, pw[2]), ...RD.partMaxPower3(part, pw[2]), ...RD.partMinPower4(part, pw[3]), ...RD.partMaxPower4(part, pw[3]));
      } else {
        const lo = minPowerOf(p);
        h.push(...RD.partSpeed(part, p.speed), ...RD.partMinPower1(part, lo), ...RD.partMaxPower1(part, p.power));
        h.push(...RD.partMinPower2(part, lo), ...RD.partMaxPower2(part, p.power));
      }
      h.push(...RD.partColor(part, bgr(ACI_RGB[p.aci[0]] !== undefined ? ACI_RGB[p.aci[0]] : 0xff0000)), ...RD.partWorkMode(part, 0));
      h.push(0xe7, 0x52, part, ...abs(b[0]), ...abs(b[1]), 0xe7, 0x53, part, ...abs(b[2]), ...abs(b[3]));
      h.push(0xe7, 0x61, part, ...abs(b[0]), ...abs(b[1]), 0xe7, 0x62, part, ...abs(b[2]), ...abs(b[3]));
    }
    h.push(...RD.maxLayerPart(used.length ? Math.max(...used.map(partOf)) : 0));
    h.push(0xe7, 0x54, 0x00, ...abs(0), 0xe7, 0x54, 0x01, ...abs(0), 0xe7, 0x55, 0x00, ...abs(0), 0xe7, 0x55, 0x01, ...abs(0));
    h.push(0xf1, 0x03, ...abs(0), ...abs(0), 0xe7, 0x0a, 0x00);
    h.push(0xea, 0x00, 0xe7, 0x60, 0x00, 0xe7, 0x0b, 0x00);
    h.push(0xe7, 0x13, ...abs(box[0]), ...abs(box[1]), 0xe7, 0x17, ...abs(box[2]), ...abs(box[3]));
    h.push(0xe7, 0x23, ...abs(0), ...abs(0), 0xe7, 0x24, 0x00);
    h.push(0xe7, 0x08, ...[1, 1, 0, 1123, -3328, 4, 3480].flatMap((v) => rel(v)));

    // tail
    const all = h.concat(body, [0xeb], RD.layerEnd());
    const sum = all.reduce((a, b) => a + b, 0) + 0xd7;
    all.push(0xe5, 0x05, ...abs(sum), 0xd7);
    const t = [].concat(...grp.steps.map(trace));
    return { kind: 'stream', data: Buffer.from(all), steps: grp.steps.map((s) => ({ i: s.i, seconds: s.seconds })), seconds, trace: t };
  });
  return { ctrl: 'ruida', name: plan.name, segments, seconds: plan.seconds, warnings, magic: S.magic };
}

// .rd file (swizzled), as one stream. Dwells and marks can't be expressed in a file.
function exportFiles(plan, cfg) {
  const program = compile(plan, cfg, { file: true });
  const notes = [];
  if (plan.steps.some((s) => s.op === 'dwell')) notes.push('Dwells between passes are left out of the file (they only happen when Pathline Run runs the job).');
  if (plan.steps.some((s) => s.op === 'inspect')) notes.push('Registration marks are left out of the file.');
  const raw = program.segments.length ? program.segments[0].data : Buffer.alloc(0);
  const txt = ['; Pathline Run · Ruida .rd listing · ' + program.name, '; Coordinates in controller mm (µm / 1000, origin ' + settings(cfg).origin + ').', ...notes.map((n) => '; ' + n), '', listing(raw)];
  return { bin: swizzle(raw, program.magic), txt: txt.join('\n'), ext: '.rd', notes };
}

module.exports = { compile, exportFiles, mapper, settings };

// Plan → Trotec data-lane command stream. The command sequences copy what
// Ruby sends (TROTEC_PROTOCOL.md §4.4–4.7): power as DEFINEPOWERLEVELS +
// SELECTPOWERLEVEL, speed as CutVelocity / raster velocity in position units
// per second, cuts as MOVEXY per segment, raster lines as MOVEX± with a b/w
// switch table.
'use strict';

const { TT, KEY, listing } = require('./sf');
const { scanLines, trace } = require('../../job/plan');

// Path-planner sets from Ruby's PathPlanningParameter.json (Q500): keys 256–263.
// [arc, bezier, vector, chord, kappa, tanAcc idle, tanAcc cut, jerk, interp]
const PLANNER = {
  Accuracy: [200, 50, 5, 0.001, 0.2, 200, 100, 1000, 0.001],
  Standard: [200, 300, 20, 0.001, 0.2, 500, 500, 5000, 0.001],
  Throughput: [200, 500, 250, 0.001, 0.2, 500, 500, 40000, 0.001],
  EngraveX: [200, 100, 5, 0.001, 0.2, 1500, 1500, 75000, 0.001]
};
const plannerFor = (name) => (/optimi[sz]ed|speed|throughput/i.test(name) ? 'Throughput' : /accura|quality/i.test(name) ? 'Accuracy' : 'Standard');

function plannerCmds(set, cut) {
  const v = PLANNER[set];
  // same key order as Ruby: 260, 259, 256, 257, 258, 261, 262, 263
  return [
    TT.setParam64(KEY.KappaThreshold, v[4]), TT.setParam64(KEY.MaxChordError, v[3]),
    TT.setParam64(KEY.MaxCentrifugalAccArc, v[0]), TT.setParam64(KEY.MaxCentrifugalAccBezier, v[1]),
    TT.setParam64(KEY.MaxCentrifugalAccVector, v[2]), TT.setParam64(KEY.MaxTangentialAcc, cut ? v[6] : v[5]),
    TT.setParam64(KEY.MaxTangentialJerk, v[7]), TT.setParam64(KEY.MaxVectorInterpolationError, v[8])
  ];
}

function settings(cfg) {
  const t = cfg.trotec || {};
  return {
    unit: t.unit || 0.010125,
    off: t.offset || [14.833125, 9.527625],
    source: t.laserSource !== undefined ? t.laserSource : 5,
    travel: t.travelSpeed || 700,
    max: t.maxSpeed || 2000,
    airOut: t.airOutput !== undefined ? t.airOutput : 4,
    overscan: t.overscan !== undefined ? t.overscan : 10,
    pcCut: t.cutPowerCorrection !== undefined ? t.cutPowerCorrection : 15,
    pcEngrave: t.engravePowerCorrection !== undefined ? t.engravePowerCorrection : 20,
    bed: cfg.bed
  };
}

// bed mm → machine position units (Ruby adds the factory mechanical offset, then floors)
const units = (S) => ({
  x: (mm) => Math.floor((mm + S.off[0]) / S.unit + 1e-6),
  y: (mm) => Math.floor((mm + S.off[1]) / S.unit + 1e-6),
  v: (mmps) => Math.round(Math.min(mmps, S.max) / S.unit),
  toMm: (ux, uy) => [ux * S.unit - S.off[0], uy * S.unit - S.off[1]]
});

function compile(plan, cfg) {
  const S = settings(cfg);
  const U = units(S);
  const segments = [];
  const warnings = plan.warnings.slice();
  let seg = null;
  let st = null; // what the controller is set to inside the current stream
  const out = (...c) => seg.cmds.push(...c);

  const begin = () => {
    if (seg) return;
    seg = { kind: 'stream', cmds: [], steps: [], seconds: 0, trace: [] };
    segments.push(seg);
    st = { mode: null, proc: null, vel: null, air: false };
  };
  const end = () => {
    if (!seg) return;
    out(TT.selectPowerLevel(0));
    if (st.air) out(TT.clrOutput(S.airOut));
    out(TT.commit());
    seg = null;
  };
  const air = (on) => {
    if (on === st.air) return;
    out(on ? TT.setOutput(S.airOut) : TT.clrOutput(S.airOut));
    st.air = on;
  };
  const velocity = (v) => {
    if (st.vel === v) return;
    out(TT.setParam32(KEY.CutVelocity, v), TT.commit());
    st.vel = v;
  };

  const setupCut = (p) => {
    if (st.mode === 'cut' && st.proc === p) return;
    const pc = p.powerCorrection !== null ? p.powerCorrection : S.pcCut;
    st.planner = plannerFor(p.planning);
    out(TT.setParam8(KEY.LaserSource, S.source), TT.powerCorrectionOn(), TT.setParam16(KEY.PowerCorrection, Math.round(pc * 100)));
    out(TT.definePowerLevels([0, 0, p.power]), TT.commit());
    out(TT.frequency(p.freq));
    air(p.air && cfg.f.air !== false);
    out(TT.commit(), TT.selectPowerLevel(0), TT.commit());
    out(TT.setParam8(KEY.AccelX, 9), TT.setParam8(KEY.AccelY, 9), TT.setParam8(KEY.AccelXY, 9));
    out(...plannerCmds(st.planner, false), TT.commit());
    st.vel = null;
    st.mode = 'cut';
    st.proc = p;
  };

  const setupEngrave = (p) => {
    if (st.mode === 'engrave' && st.proc === p) return;
    const pc = p.powerCorrection !== null ? p.powerCorrection : S.pcEngrave;
    out(TT.setParam8(KEY.LaserSource, S.source), TT.powerCorrectionOn(), TT.setParam16(KEY.PowerCorrection, 0));
    out(TT.setParam32(KEY.CutVelocity, U.v(S.travel)), TT.commit(), TT.selectPowerLevel(0));
    air(p.air && cfg.f.air !== false);
    out(TT.setParam8(KEY.AccelX, 9), TT.setParam8(KEY.AccelY, 9), TT.setParam8(KEY.AccelXY, 9));
    out(...plannerCmds('EngraveX', true), TT.commit());
    out(TT.definePowerLevels([0, p.power]), TT.commit());
    out(TT.setParam32(KEY.RasterVelocity, U.v(p.speed)), TT.setParam32(KEY.CutVelocity, U.v(S.max)));
    out(TT.setParam16(KEY.PowerCorrection, Math.round(pc * 100)));
    // PPI mode 5 and the {5k, 5k−1, 5k+1} table are what Ruby sent for 500 DPI.
    // Our switch tables only use raw 3-byte runs, so the table is never indexed.
    const pulse = Math.max(1, Math.round(25400 / (p.dpi * S.unit * 1000)));
    const fav = [];
    for (let k = 1; k <= 85; k++) fav.push(pulse * k, pulse * k - 1, pulse * k + 1);
    out(TT.ppiMode(5), TT.ppiMode(5), TT.commit(), TT.favoriteDistances(fav), TT.commit());
    st.vel = U.v(S.max);
    st.mode = 'engrave';
    st.proc = p;
  };

  const cut = (step) => {
    const p = step.proc;
    setupCut(p);
    const P = PLANNER[st.planner];
    for (const run of step.runs) {
      // travel with the beam off
      out(TT.selectPowerLevel(0), TT.commit());
      out(TT.setParam64(KEY.MaxTangentialAcc, P[5]), TT.commit());
      st.vel = null;
      velocity(U.v(S.travel));
      out(TT.moveXY(U.x(run[0][0]), U.y(run[0][1])), TT.commit());
      out(TT.setParam64(KEY.MaxTangentialAcc, P[6]), TT.commit());
      velocity(U.v(p.speed));
      for (let k = 1; k < run.length; k++) {
        out(TT.selectPowerLevel(2), TT.moveXY(U.x(run[k][0]), U.y(run[k][1])), TT.commit(), TT.selectPowerLevel(0), TT.commit());
      }
    }
  };

  const engrave = (step) => {
    const p = step.proc;
    setupEngrave(p);
    // line pitch: the nominal pitch rounded down to whole 6 µm firmware Y steps (§4.7)
    const pitch = Math.max(0.006, Math.floor(25.4 / step.dpi / 0.006 + 1e-9) * 0.006);
    const lines = scanLines(step, pitch);
    const os = S.overscan + p.overshoot;
    const xs = Math.max(0, step.box[0] - os);
    const xe = Math.min(S.bed[0], step.box[2] + os);
    const uS = U.x(xs);
    const uE = U.x(xe);
    const len = uE - uS;
    lines.forEach((ln, k) => {
      const fwd = !step.bidi || k % 2 === 0;
      const uy = U.y(ln.y);
      const edges = [];
      for (const [a, b] of ln.spans) edges.push(Math.min(len, Math.max(0, U.x(a) - uS)), Math.min(len, Math.max(0, U.x(b) - uS)));
      const dist = fwd ? edges : edges.reverse().map((e) => len - e);
      const runs = dist.map((d, i) => d - (i ? dist[i - 1] : 0));
      out(TT.moveXY(fwd ? uS : uE, uy), TT.commit());
      out(fwd ? TT.moveXPlus(len) : TT.moveXMinus(len), TT.switchTableBW(runs), TT.commit());
    });
    if (!lines.length) warnings.push('Step ' + (step.i + 1) + ' (' + p.name + '): nothing to engrave');
  };

  for (const step of plan.steps) {
    if (step.op === 'dwell' || step.op === 'inspect') {
      end();
      segments.push({ ...step, kind: step.op });
      continue;
    }
    begin();
    if (step.op === 'cut') cut(step);
    else if (step.op === 'engrave') engrave(step);
    out(TT.progressMarker(step.i + 1));
    seg.steps.push({ i: step.i, marker: step.i + 1, seconds: step.seconds });
    seg.seconds += step.seconds;
    seg.trace.push(...trace(step));
  }
  end();
  for (const s of segments) if (s.kind === 'stream') s.data = Buffer.concat(s.cmds);
  return { ctrl: 'trotec', name: plan.name, segments, seconds: plan.seconds, warnings };
}

// File to save: the data-lane bytes of every stream, plus a readable listing.
function exportFiles(plan, cfg) {
  const program = compile(plan, cfg);
  const bin = Buffer.concat(program.segments.filter((s) => s.kind === 'stream').map((s) => s.data));
  const txt = ['; Pathline Run · Trotec SF data-lane stream · ' + program.name,
    '; Positions in machine units (10.125 µm), mechanical offset included. Velocities in units/s.', ''];
  program.segments.forEach((s, n) => {
    if (s.kind === 'stream') txt.push('; ---- stream ' + (n + 1) + ' (' + s.data.length + ' bytes, steps ' + s.steps.map((x) => x.i + 1).join(', ') + ')', listing(s.data), '');
    else if (s.kind === 'dwell') txt.push('; ---- dwell ' + s.seconds + ' s (host waits, beam off)', '');
    else txt.push('; ---- registration mark ' + s.mark + ' of ' + s.of + ' at ' + s.at.join(', ') + ' (camera)', '');
  });
  return { bin, txt: txt.join('\n'), ext: '.sf' };
}

module.exports = { compile, exportFiles, settings, units, PLANNER };

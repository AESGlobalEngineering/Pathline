// Plan → Trotec data-lane command stream. The command sequences copy what
// Ruby sends (TROTEC_PROTOCOL.md §4.4–4.7): power as DEFINEPOWERLEVELS +
// SELECTPOWERLEVEL, speed as CutVelocity / raster velocity in position units
// per second, cuts as MOVEXY per straight segment and cubic Béziers for curves, raster lines as
// MOVEX± with a b/w switch table.
'use strict';

const { TT, KEY, listing } = require('./sf');
const { fitArcs } = require('./arcs');
const { travelLimits, moveTime } = require('./motion');
const { scanLines, trace } = require('../../job/plan');

const COMMIT_EVERY = 200;

// An arc from `from` (on its circle) as cubic Béziers of at most 45° (Ruby's piece size): each
// [c1x, c1y, c2x, c2y, ex, ey] in mm. Control points at 4/3·tan(θ/4)·r along the tangents; the
// curve then stays within 5·10⁻⁶·r of the circle (5 µm at a 1 m radius). The last piece ends
// exactly on the polyline's point.
function bezierPieces(from, m) {
  const [cx, cy] = m.c, r = m.r, s = Math.sign(m.sweep);
  const n = Math.max(1, Math.ceil(Math.abs(m.sweep) / (Math.PI / 4) - 1e-9));
  const th = m.sweep / n, k = (4 / 3) * Math.tan(Math.abs(th) / 4) * r;
  let a = Math.atan2(from[1] - cy, from[0] - cx);
  let p = from;
  const out = [];
  for (let i = 1; i <= n; i++) {
    const b = a + th;
    const e = i === n ? m.to : [cx + r * Math.cos(b), cy + r * Math.sin(b)];
    out.push([p[0] - s * k * Math.sin(a), p[1] + s * k * Math.cos(a), e[0] + s * k * Math.sin(b), e[1] - s * k * Math.cos(b), e[0], e[1]]);
    a = b; p = e;
  }
  return out;
}

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
    arcs: t.arcs !== false,
    bed: cfg.bed
  };
}

// bed mm → machine position units (Ruby adds the factory mechanical offset, then floors)
const units = (S) => ({
  x: (mm) => Math.floor((mm + S.off[0]) / S.unit + 1e-6),
  y: (mm) => Math.floor((mm + S.off[1]) / S.unit + 1e-6),
  v: (mmps) => Math.round(Math.min(mmps, S.max) / S.unit),
  // unrounded, for the doubles of a Bézier
  fx: (mm) => (mm + S.off[0]) / S.unit,
  fy: (mm) => (mm + S.off[1]) / S.unit,
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

  // where the head is (for the travel time; the job starts from home)
  let head = [0, 0];
  const cut = (step) => {
    const p = step.proc;
    setupCut(p);
    const P = PLANNER[st.planner];
    // travel between cuts: the planner set's idle limits, or a faster profile (motion.js)
    const T = travelLimits(cfg, P, S.travel);
    let travelSec = 0;
    let cutSec = 0;
    const speed = Math.min(p.speed, S.max);
    for (const run of step.runs) {
      for (let k = 1; k < run.length; k++) cutSec += Math.hypot(run[k][0] - run[k - 1][0], run[k][1] - run[k - 1][1]) / speed;
      // travel with the beam off
      out(TT.selectPowerLevel(0), TT.commit());
      out(TT.setParam64(KEY.MaxTangentialAcc, T.a), TT.commit());
      if (T.j !== P[7]) out(TT.setParam64(KEY.MaxTangentialJerk, T.j), TT.commit());
      st.vel = null;
      velocity(U.v(T.v));
      out(TT.moveXY(U.x(run[0][0]), U.y(run[0][1])), TT.commit());
      travelSec += moveTime(Math.hypot(run[0][0] - head[0], run[0][1] - head[1]), Math.min(T.v, S.max), T.a, T.j);
      head = run[run.length - 1];
      if (T.j !== P[7]) out(TT.setParam64(KEY.MaxTangentialJerk, P[7]), TT.commit());
      out(TT.setParam64(KEY.MaxTangentialAcc, P[6]), TT.commit());
      velocity(U.v(p.speed));
      // the beam on once for the whole run, off at its end (the next travel, or end()). Off and
      // on again round every segment made the Trotec stop at each one: corners and curves (many
      // short segments) crawled
      out(TT.selectPowerLevel(2));
      // curves as cubic Béziers in 45° pieces, as Ruby sends them on this Q500: the planner lets a
      // curve keep several times the speed of the same radius as short straight segments (see
      // arcs.js). One COMMIT for the run, as Ruby commits once per cut item, but at least every
      // COMMIT_EVERY commands
      const moves = S.arcs ? fitArcs(run) : run.slice(1).map((q) => ({ to: q }));
      let at = run[0], sent = 0;
      for (const m of moves) {
        const cmds = m.c ? bezierPieces(at, m).map((b) => TT.cubicBezier(U.fx(b[0]), U.fy(b[1]), U.fx(b[2]), U.fy(b[3]), U.fx(b[4]), U.fy(b[5])))
          : [TT.moveXY(U.x(m.to[0]), U.y(m.to[1]))];
        for (const c of cmds) {
          out(c);
          if (++sent % COMMIT_EVERY === 0) out(TT.commit());
        }
        at = m.to;
      }
      if (sent % COMMIT_EVERY) out(TT.commit());
      out(TT.selectPowerLevel(0), TT.commit());
    }
    return travelSec + cutSec;
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
    // the step's time. A cut is timed here: the cutting at its set speed (the planner holds it,
    // corners and curves included: on the X8 sheet Pathline's own cutting time ran ~15 % long) and
    // the travel to each cut as the planner really moves (Pathline times that at 2000 mm/s with no
    // jerk limit). Engraving keeps Pathline's time
    let sec = step.seconds;
    if (step.op === 'cut') sec = cut(step);
    else if (step.op === 'engrave') engrave(step);
    out(TT.progressMarker(step.i + 1));
    seg.steps.push({ i: step.i, marker: step.i + 1, seconds: sec });
    seg.seconds += sec;
    seg.trace.push(...trace(step));
  }
  end();
  for (const s of segments) if (s.kind === 'stream') s.data = Buffer.concat(s.cmds);
  const seconds = segments.reduce((a, s) => a + (s.seconds || 0), 0);
  return { ctrl: 'trotec', name: plan.name, segments, seconds, estimated: true, warnings };
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

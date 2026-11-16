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

// How the Trotec moves along a cut, fitted to every job run on the Q500 (J0040–J0065): it holds
// the set speed on straight lines (measured 1.000–1.001 ×), but slows on curves to √(arc · r)
// and at a corner of angle θ to √(corner · sin(θ/2) / (1 − sin(θ/2))) (corner is the planner's
// vector setting, 20 in Standard), speeding up and slowing down at acc mm/s², and stops at each
// run's ends. Length ÷ speed ran 2–5 % short at 33 mm/s and 78 % short at 400 mm/s (small shapes
// never reach speed); this lands every job within −2.5 … +3.3 %.
const CUT = { arc: 1000, acc: 2000 };
// a registration mark, s: learnt from the jobs run (cfg.markSec, server.js), this until then.
// Ruby's X21 jobs took 7–9 s a mark (19–28 s for 3), not the 4 s first assumed
const MARK_SEC = 8;
// Engraving: each line is one move across the island's box and its overscan, whatever is on that
// line, at the engraving speed; the head then turns, in turn0 + turnPerV · v seconds; and each
// island (step) costs `step` s more. The sweep takes as long as if it were `short` mm shorter than
// sent (as if the overscan were 8.3 mm, not 10: the head is at speed sooner than the line's ends).
// Fitted on 34 engraving steps: the calibration bars (J0076, 100–600 mm/s, 40 and 80 mm) and two
// 500 DPI stainless jobs of 9 islands each (J0093, J0094, ~500 mm/s, 16 Nov), each step's real time
// from its markers less Run's own travel to it: 2.2 % rms a step, the jobs −0.7, +0.8, −0.3 %.
// (Before: turn0 0.0578, turnPerV 9.44e-5 on J0076 and J0068 alone ran the two jobs 5–6 % long.
// Pathline Prepare's 2·v/acc a line, with the travel acceleration, ran them 16× long.)
const ENGRAVE = { turn0: 0.0902, turnPerV: 2.295e-5, short: 3.43, step: 0.203 };

// The lines one engraving step is sent as: { pitch, lines, xs, xe (mm, the row with its
// overscan), v, sweep and turn (s, one line's), secPerLine, lead (s, the step's own) }
function engraveLines(step, S) {
  const p = step.proc;
  // line pitch: the nominal pitch rounded down to whole 6 µm firmware Y steps (§4.7)
  const pitch = Math.max(0.006, Math.floor(25.4 / step.dpi / 0.006 + 1e-9) * 0.006);
  const lines = scanLines(step, pitch);
  const os = S.overscan + (p.overshoot || 0);
  const xs = Math.max(0, step.box[0] - os), xe = Math.min(S.bed[0], step.box[2] + os);
  const v = Math.min(p.speed, S.max);
  const sweep = Math.max(0.2 * (xe - xs), xe - xs - ENGRAVE.short) / v, turn = ENGRAVE.turn0 + ENGRAVE.turnPerV * v;
  return { pitch, lines, xs, xe, v, sweep, turn, secPerLine: sweep + turn, lead: ENGRAVE.step };
}
// (cfg.trotec.cutModel overrides any of them: for fitting and trying values)
const cutProfile = (P, cfg) => ({ arc: CUT.arc, corner: P ? P[2] : 20, acc: CUT.acc, ...((cfg && cfg.trotec && cfg.trotec.cutModel) || {}) });

// Travel between cuts, as it takes time: the head accelerates about 4× harder than the
// planner's travel setting says, and each move costs 0.03 s more (stopping, the beam off and on).
// Fitted on 18 runs (11–12 Nov: the jobs, and calibration hops of 20–600 mm, J0073): the planner
// values ran 18–34 % long on 200–600 mm moves, and faster travel alone made the jobs of many
// short moves 2 % short. Only the timing: what's sent to the laser is the planner's.
// (cfg.trotec.travelModel overrides any of a, j, v, h: for fitting and trying values)
const travelTiming = (T, cfg) => ({ ...T, a: T.a * 4, h: 0.03, ...((cfg && cfg.trotec && cfg.trotec.travelModel) || {}) });

// Seconds along one cut run at speed v: moves are fitArcs pieces ({ to } lines, { c, r, sweep,
// to } arcs), from run[0]
function runTime(start, moves, v, prof) {
  const pc = [];
  let at = start;
  for (const m of moves) {
    if (m.c) {
      const L = Math.abs(m.sweep) * m.r;
      const a0 = Math.atan2(at[1] - m.c[1], at[0] - m.c[0]), s = Math.sign(m.sweep);
      if (L > 1e-6) pc.push({ L, cap: Math.min(v, Math.sqrt(prof.arc * m.r)), d0: a0 + (s * Math.PI) / 2, d1: a0 + m.sweep + (s * Math.PI) / 2 });
    } else {
      const L = Math.hypot(m.to[0] - at[0], m.to[1] - at[1]);
      if (L > 1e-6) { const d = Math.atan2(m.to[1] - at[1], m.to[0] - at[0]); pc.push({ L, cap: v, d0: d, d1: d }); }
    }
    at = m.to;
  }
  if (!pc.length) return 0;
  // the speed at each join: the slower piece's, and the corner's. Junction deviation: with the
  // direction turning by φ, v² = corner · c / (1 − c), c = cos(φ/2) (straight on: no limit; a full
  // reversal: a stop). This was sin(φ/2), the same at 90° but a near stop at every slight bend of a
  // curve and too fast round sharp ones: circles and small shapes ran 9–11 % long on the
  // calibration grid (J0071)
  const vj = new Array(pc.length + 1).fill(0);
  for (let i = 1; i < pc.length; i++) {
    let th = Math.abs(pc[i].d0 - pc[i - 1].d1) % (2 * Math.PI);
    if (th > Math.PI) th = 2 * Math.PI - th;
    const c = Math.cos(th / 2);
    const lim = th < 1e-3 ? Infinity : c <= 1e-4 ? 0 : c >= 0.9999 ? Infinity : Math.sqrt((prof.corner * c) / (1 - c));
    vj[i] = Math.min(pc[i].cap, pc[i - 1].cap, lim);
  }
  // as fast as it can get there, and still slow down in time
  for (let i = 0; i < pc.length; i++) vj[i + 1] = Math.min(vj[i + 1], Math.sqrt(vj[i] * vj[i] + 2 * prof.acc * pc[i].L));
  for (let i = pc.length - 1; i >= 0; i--) vj[i] = Math.min(vj[i], Math.sqrt(vj[i + 1] * vj[i + 1] + 2 * prof.acc * pc[i].L));
  let t = 0;
  for (let i = 0; i < pc.length; i++) {
    const u0 = vj[i], u1 = vj[i + 1], L = pc[i].L, a = prof.acc;
    const peak = Math.max(1e-6, Math.min(pc[i].cap, Math.sqrt((2 * a * L + u0 * u0 + u1 * u1) / 2)));
    const s1 = (peak * peak - u0 * u0) / (2 * a), s2 = (peak * peak - u1 * u1) / (2 * a);
    t += (peak - u0) / a + (peak - u1) / a + Math.max(0, L - s1 - s2) / peak;
  }
  return t;
}

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
  // The time model's parts, each scaled by what the jobs run have shown (cfg.timeScale, fitted by
  // timefit.js from when each part was reported done: on Ruby the cutting ran 1.2 % longer than
  // runTime says and the travel 10 % shorter). Each step keeps its parts unscaled, for the next fit
  const TS = cfg.timeScale || {};
  const within = (v, lo, hi) => (Number.isFinite(v) && v >= lo && v <= hi ? v : 1);
  const kCut = within(TS.cut, 0.7, 1.4), kTravel = within(TS.travel, 0.6, 1.5), kEngrave = within(TS.engrave, 0.6, 1.6);
  let parts = null;
  const cut = (step) => {
    const p = step.proc;
    setupCut(p);
    const P = PLANNER[st.planner];
    // travel between cuts: the planner set's idle limits, or a faster profile (motion.js)
    const T = travelLimits(cfg, P, S.travel);
    // the travel's timing (what's sent stays T)
    const Tt = travelTiming(T, cfg);
    let travelSec = 0;
    let cutSec = 0;
    const speed = Math.min(p.speed, S.max);
    const prof = cutProfile(P, cfg);
    for (const run of step.runs) {
      // travel with the beam off
      out(TT.selectPowerLevel(0), TT.commit());
      out(TT.setParam64(KEY.MaxTangentialAcc, T.a), TT.commit());
      if (T.j !== P[7]) out(TT.setParam64(KEY.MaxTangentialJerk, T.j), TT.commit());
      st.vel = null;
      velocity(U.v(T.v));
      out(TT.moveXY(U.x(run[0][0]), U.y(run[0][1])), TT.commit());
      travelSec += moveTime(Math.hypot(run[0][0] - head[0], run[0][1] - head[1]), Math.min(Tt.v, S.max), Tt.a, Tt.j) + (Tt.h || 0);
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
      cutSec += runTime(run[0], moves, speed, prof);
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
    parts = { cut: +cutSec.toFixed(3), travel: +travelSec.toFixed(3) };
    return travelSec * kTravel + cutSec * kCut;
  };

  const engrave = (step) => {
    const p = step.proc;
    setupEngrave(p);
    const E = engraveLines(step, S);
    const { lines, xs, xe } = E;
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
    if (!lines.length) { warnings.push('Step ' + (step.i + 1) + ' (' + p.name + '): nothing to engrave'); return 0; }
    // the time: travel to the first line, then each line across and back (engraveLines)
    const T = travelTiming(travelLimits(cfg, PLANNER[st.planner] || PLANNER.Standard, S.travel), cfg);
    // (the first line always goes left to right)
    const first = [xs, lines[0].y];
    const travel = moveTime(Math.hypot(first[0] - head[0], first[1] - head[1]), Math.min(T.v, S.max), T.a, T.j) + (T.h || 0);
    const last = lines[lines.length - 1];
    head = [!step.bidi || (lines.length - 1) % 2 === 0 ? xe : xs, last.y];
    const eng = lines.length * E.secPerLine + E.lead;
    parts = { travel: +travel.toFixed(3), engrave: +eng.toFixed(3) };
    return travel * kTravel + eng * kEngrave;
  };

  for (const step of plan.steps) {
    if (step.op === 'dwell' || step.op === 'inspect') {
      end();
      // a registration mark: the camera moves to it, settles and looks (learnt per machine)
      const markSec = Number(cfg.markSec) > 0 ? Number(cfg.markSec) : MARK_SEC;
      segments.push({ ...step, kind: step.op, seconds: step.op === 'inspect' ? Math.max(Number(step.seconds) || 0, markSec) : step.seconds });
      continue;
    }
    begin();
    // the step's time. A cut is timed here: the cutting at its set speed on straights, slower round
    // curves and corners (runTime: on the X8 sheet Pathline's own cutting time ran ~15 % long) and
    // the travel to each cut as the planner really moves (Pathline times that at 2000 mm/s with no
    // jerk limit). Engraving from the lines sent (engraveLines: Pathline's time ran 10× long)
    let sec = step.seconds;
    parts = null;
    if (step.op === 'cut') sec = cut(step);
    else if (step.op === 'engrave') sec = engrave(step);
    out(TT.progressMarker(step.i + 1));
    seg.steps.push({ i: step.i, marker: step.i + 1, seconds: sec, ...(parts ? { parts } : {}) });
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

// For the screen's route (and the follow fit): each engraving step as sent, by toolpath index:
// { n lines, y0, y1 (first and last line), xs, xe (the row with overscan), sec (whole step,
// lines only), lead (the step's own) }. The screen draws the head along these at this pace. With
// the job's timeScale.engrave, as the estimate (so the drawing keeps up with the laser the same way).
function engraveRows(pkg, cfg) {
  const S = settings(cfg);
  const out = {};
  const { build } = require('../../job/plan');
  const TS = (cfg && cfg.timeScale) || {};
  const k = Number.isFinite(TS.engrave) && TS.engrave >= 0.6 && TS.engrave <= 1.6 ? TS.engrave : 1;
  for (const step of build(pkg).steps) {
    if (step.op !== 'engrave') continue;
    const E = engraveLines(step, S);
    if (!E.lines.length) continue;
    out[step.i] = {
      n: E.lines.length, y0: +E.lines[0].y.toFixed(3), y1: +E.lines[E.lines.length - 1].y.toFixed(3), xs: +E.xs.toFixed(3), xe: +E.xe.toFixed(3), bidi: step.bidi,
      sec: +(E.lines.length * E.secPerLine * k).toFixed(3), lead: +(E.lead * k).toFixed(3)
    };
  }
  return out;
}

module.exports = { compile, exportFiles, settings, units, PLANNER, runTime, cutProfile, engraveRows, MARK_SEC };

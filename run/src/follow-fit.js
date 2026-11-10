// Fitting the screen's head drawing to where the head really was, from the jobs this machine has
// run (data/runs: every reported position, with when it was asked for and when it came back).
//
// Each run is replayed through the screen's own code (ui/follow.js) as the screen sees it: a
// refresh every 0.7 s with the newest position and its age, frames every 33 ms. The error is how
// far the drawn head is from each reported position at that position's own time, before the
// screen has seen it. Three things are fitted, in turn:
//  1. when the laser read each position, between asking (sent) and the reply (rx): at = sent +
//     k·(rx − sent), per kind of reply. k is chosen where three reports in a row on a straight cut
//     at a steady speed line up best, so it needs no "truth" (the replies scattered ±80 ms)
//  2. a constant c added to that (how far behind the drawing runs), by the replay error
//  3. the route's timing: travel (a, j, v) and cuts (arc, corner, acc), by coordinate search
//     within sensible limits, from the values in use
// A result is used only when it beats what's in use by at least 3 % on the same runs.
'use strict';

const fs = require('fs');
const path = require('path');
const F = require('../ui/follow');

const LIMITS = {
  travel: { a: [200, 5000], j: [2000, 200000], v: [300, 2000] },
  cut: { arc: [50, 5000], corner: [1, 100], acc: [100, 5000] }
};
const KINDS = ['ok', 'full'];

const q = (a, f) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))] : NaN; };

// ---------------------------------------------------------------- the runs
// The most recent completed (or long stopped) Trotec runs with their packages: [{ run, pkg }]
function loadRuns(dataDir, opts = {}) {
  const dir = path.join(dataDir, 'runs');
  let files = [];
  try { files = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); } catch (e) { return []; }
  const out = [];
  for (const f of files.reverse()) {
    if (out.length >= (opts.max || 8)) break;
    let run, pkg;
    try { run = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { continue; }
    const busy = (run.timeline || []).filter((t) => t[4] === 'busy' && t[1] != null).length;
    if (busy < (opts.minReports || 150)) continue;
    try { pkg = JSON.parse(fs.readFileSync(path.join(dataDir, 'jobs', run.id, 'package.json'), 'utf8')); } catch (e) { continue; }
    if (!(pkg.toolpath || []).some((s) => Array.isArray(s.p) && s.p.length > 1)) continue;
    out.push({ run, pkg, file: f });
  }
  return out.reverse();
}

// A position's time (ms in the run): fitted from sent/rx where the run has them
function timeOf(t, stamp) {
  const sent = t[6], kind = t[7], rx = t[9];
  const s = stamp && (stamp[kind] || stamp.all);
  if (s && Number.isFinite(sent) && Number.isFinite(rx)) return Math.min(rx, sent + s.k * (rx - sent) + (s.c || 0));
  return Number.isFinite(rx) ? rx : t[0];
}

// The run's timeline with each position at its fitted time (busy reports in time order)
function retimed(run, stamp) {
  return run.timeline.filter((t) => t[1] != null).map((t) => [timeOf(t, stamp), t[1], t[2], t[3], t[4]]).sort((a, b) => a[0] - b[0]);
}

// ---------------------------------------------------------------- the job on the bed
// Where the job really was: an affine fit of each step's start to where its marker first
// showed, then refined on the reports (a print and cut job is moved onto its marks; this finds
// it without the marks)
function placement(run, pkg0, M) {
  const tl = run.timeline.filter((t) => t[1] != null);
  const tp = pkg0.toolpath;
  const cutIdx = tp.map((s, i) => (s.type === 'inspect' ? -1 : i)).filter((i) => i >= 0);
  const renum = run.steps && run.steps.length && run.steps[0].i === 0 && cutIdx[0] > 0;
  const TP = (m) => (renum ? (m >= 0 && m < cutIdx.length ? cutIdx[m] : (m < 0 ? -1 : 1e9)) : m);
  const firstSeen = {};
  for (const t of tl) if (t[3] != null && t[4] === 'busy' && !(t[3] in firstSeen)) firstSeen[t[3]] = t;
  const pairs = [];
  for (const [m, t] of Object.entries(firstSeen)) { const s = tp[TP(+m)]; const a = s && Array.isArray(s.p) && s.p[0]; if (a) pairs.push([a, [t[1], t[2]]]); }
  if (pairs.length < 6) return null;
  const fit = (ps) => {
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bx = [0, 0, 0], by = [0, 0, 0];
    for (const [p, r] of ps) { const v = [p[0], p[1], 1]; for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) A[i][j] += v[i] * v[j]; bx[i] += v[i] * r[0]; by[i] += v[i] * r[1]; } }
    const solve = (Mx, b) => { const m = Mx.map((r, i) => r.concat([b[i]])); for (let i = 0; i < 3; i++) { let p = i; for (let k = i + 1; k < 3; k++) if (Math.abs(m[k][i]) > Math.abs(m[p][i])) p = k; [m[i], m[p]] = [m[p], m[i]]; for (let k = 0; k < 3; k++) if (k !== i) { const r = m[k][i] / m[i][i]; for (let j = i; j < 4; j++) m[k][j] -= r * m[i][j]; } } return m.map((r, i) => r[3] / r[i]); };
    return [solve(A, bx), solve(A, by)];
  };
  const ap = (T, p) => [T[0][0] * p[0] + T[0][1] * p[1] + T[0][2], T[1][0] * p[0] + T[1][1] * p[1] + T[1][2]];
  const inv = (A) => { const [a, b, c] = A[0], [d, e, f] = A[1]; const det = a * e - b * d; return [[e / det, -b / det, (b * f - c * e) / det], [-d / det, a / det, (c * d - a * f) / det]]; };
  let T = fit(pairs);
  const res = pairs.map(([a, b]) => Math.hypot(ap(T, a)[0] - b[0], ap(T, a)[1] - b[1])).sort((x, y) => x - y);
  T = fit(pairs.filter(([a, b]) => Math.hypot(ap(T, a)[0] - b[0], ap(T, a)[1] - b[1]) <= res[Math.floor(res.length * 0.8)]));
  const placed = () => ({ ...pkg0, toolpath: tp.map((s) => (Array.isArray(s.p) ? { ...s, p: s.p.map((p) => ap(T, p)) } : s)) });
  for (let it = 0; it < 6; it++) {
    const route = F.routeOf(placed(), M);
    const stepK = {};
    route.segs.forEach((g, k) => { const r = stepK[g.step] || (stepK[g.step] = [k, k]); r[1] = k; });
    const Ti = inv(T), pr = [];
    for (let i = 0; i < tl.length; i += 3) {
      const t = tl[i];
      if (t[4] !== 'busy' || !t[3]) continue;
      const a = stepK[TP(t[3] - 1)] || stepK[TP(t[3])], b = stepK[TP(t[3] + 1)] || stepK[TP(t[3])];
      if (!a || !b) continue;
      let best = null;
      for (let k = a[0]; k <= b[1]; k++) {
        const g = route.segs[k], dx = g.b[0] - g.a[0], dy = g.b[1] - g.a[1], L2 = dx * dx + dy * dy;
        let u = L2 ? ((t[1] - g.a[0]) * dx + (t[2] - g.a[1]) * dy) / L2 : 0;
        u = Math.max(0, Math.min(1, u));
        const p = [g.a[0] + dx * u, g.a[1] + dy * u], d = Math.hypot(p[0] - t[1], p[1] - t[2]);
        if (!best || d < best.d) best = { d, p };
      }
      if (best && best.d < 12 - it * 1.5) pr.push([ap(Ti, best.p), [t[1], t[2]]]);
    }
    if (pr.length < 20) break;
    T = fit(pr);
  }
  return placed();
}

// ---------------------------------------------------------------- the replay
// How far the drawn head is from each reported position (mm), replaying `run` (its positions at
// their fitted times) through follow.js with motion M. pkg: the job where it was on the bed
function replay(run, pkg, M, stamp, opts = {}) {
  const tl = retimed(run, stamp);
  if (tl.length < 20) return [];
  const steps = run.steps || [], total = run.estimate || 1;
  const markerSec = {};
  { let acc = 0; for (const s of steps) { acc += s.seconds; markerSec[s.marker] = acc; } }
  const stepSec = {};
  for (const s of steps) stepSec[s.marker] = s.seconds;
  const follow = F.follower();
  let active = 0, lastT = tl[0][0], mark = null, prog = 0, ti = 0, seen = -1, ri = 0;
  const errs = [];
  const poll = opts.poll || 700, bias = opts.bias || 0;
  let nextPoll = tl[0][0] + (opts.phase || 350);
  const endMs = tl[tl.length - 1][0];
  for (let clock = tl[0][0]; clock <= endMs; clock += 33) {
    // the server's progress, as machine.js works it out
    while (ti < tl.length && tl[ti][0] <= clock) {
      const p = tl[ti];
      if (p[4] === 'busy') active += (p[0] - lastT) / 1000;
      lastT = p[0];
      if (p[3] && markerSec[p[3]] !== undefined && (!mark || mark.m !== p[3])) mark = { m: p[3], at: active };
      const est = mark ? markerSec[mark.m] + Math.min(active - mark.at, stepSec[mark.m + 1] || 0) : Math.min(active, steps.length ? steps[0].seconds : active);
      prog = Math.max(prog, Math.min(0.999, est / total));
      ti++;
    }
    if (clock >= nextPoll) {
      nextPoll += poll;
      const j = ti - 1;
      if (j >= 0) {
        const r = tl[j];
        F.place(follow, { job: run.id, pos: { x: r[1], y: r[2] }, posAge: clock - r[0] + bias, progress: prog }, pkg, clock, M);
        seen = j;
      }
    }
    if (!follow.found || !follow.route) { while (ri < tl.length && tl[ri][0] <= clock) ri++; continue; }
    const d = F.draw(follow, tl[Math.max(0, ti - 1)][4] !== 'paused', clock);
    while (ri < tl.length && tl[ri][0] <= clock) {
      const r = tl[ri];
      if (ri > seen && r[4] === 'busy' && clock - r[0] < 33) errs.push(Math.hypot(d.p[0] - r[1], d.p[1] - r[2]));
      ri++;
    }
  }
  return errs;
}

// One number to compare fits by (lower is better): the median and the 9-in-10 error together
const score = (errs) => (errs.length ? q(errs, 0.5) + 0.5 * q(errs, 0.9) : Infinity);
const summary = (errs) => ({ n: errs.length, median: +q(errs, 0.5).toFixed(2), p90: +q(errs, 0.9).toFixed(2), over10: +(errs.filter((e) => e > 10).length / Math.max(1, errs.length)).toFixed(3) });

// ---------------------------------------------------------------- 1. when each position was read
// Three reports in a row on one straight line at a cutting speed: how far the middle one's time is
// from where a steady speed puts it. Spread (p90 − p10, ms) for times at = sent + k·(rx − sent)
function tripleSpread(runs, kind, k) {
  const res = [];
  for (const { run } of runs) {
    const tl = run.timeline.filter((t) => t[4] === 'busy' && t[1] != null && Number.isFinite(t[6]) && Number.isFinite(t[9]));
    const T = (t) => t[6] + k * (t[9] - t[6]);
    for (let i = 2; i < tl.length; i++) {
      const a = tl[i - 2], b = tl[i - 1], c = tl[i];
      if (b[7] !== kind) continue;
      const ab = [b[1] - a[1], b[2] - a[2]], bc = [c[1] - b[1], c[2] - b[2]];
      const lab = Math.hypot(ab[0], ab[1]), lbc = Math.hypot(bc[0], bc[1]);
      if (lab < 3 || lbc < 3) continue;
      if ((ab[0] * bc[0] + ab[1] * bc[1]) / (lab * lbc) < 0.9999) continue;
      const ta = T(a), tb = T(b), tc = T(c);
      if (!(tc > ta)) continue;
      const v = (lab + lbc) / ((tc - ta) / 1000);
      if (v < 5 || v > 80) continue;
      res.push(tb - (ta + (lab / (lab + lbc)) * (tc - ta)));
    }
  }
  return res.length >= 40 ? { n: res.length, spread: q(res, 0.9) - q(res, 0.1) } : null;
}

function fitStampK(runs) {
  const out = {};
  for (const kind of KINDS) {
    let best = null;
    for (let k = 0; k <= 1.0001; k += 0.1) {
      const r = tripleSpread(runs, kind, +k.toFixed(1));
      if (r && (!best || r.spread < best.spread - 0.5)) best = { k: +k.toFixed(1), ...r };
    }
    const atRx = tripleSpread(runs, kind, 1);
    // only when it's clearly better than the reply's arrival
    if (best && atRx && best.k !== 1 && best.spread < 0.9 * atRx.spread) out[kind] = { k: best.k, c: 0, spread: Math.round(best.spread), was: Math.round(atRx.spread), n: best.n };
  }
  return Object.keys(out).length ? out : null;
}

// ---------------------------------------------------------------- the whole fit
// current: { stamp, travel, cut } in use (or nothing: the defaults). Returns what was found and
// whether it's better: { use, stamp, travel, cut, before, after, runs, why }
function fit(dataDir, current = {}, opts = {}) {
  const log = opts.log || (() => {});
  const runs = loadRuns(dataDir, opts);
  if (runs.length < (opts.minRuns || 2)) return { use: false, why: 'not enough jobs run yet (' + runs.length + ')' };
  const cfg = opts.cfg || {};
  const motion = opts.motion || {};
  const prof0 = { travel: { ...F.TROTEC.travel, ...(current.travel || {}) }, cut: { ...F.TROTEC.cut, ...(current.cut || {}) } };
  const M = (prof) => F.motionFor({ ...motion, cut: motion.cut || prof.cut, follow: prof }, cfg);
  // where each job was, found once with the profile in use: the placement found, or the job as
  // sent if that fits the reports better (a placement can go wrong on a regular grid of parts)
  const jobs = runs.map((r) => {
    const found = placement(r.run, r.pkg, M(prof0));
    const sent = score(replay(r.run, r.pkg, M(prof0), current.stamp || null));
    return { ...r, placed: found && score(replay(r.run, found, M(prof0), current.stamp || null)) <= sent ? found : r.pkg };
  });
  if (jobs.length < (opts.minRuns || 2)) return { use: false, why: 'the jobs couldn\'t be placed on the bed' };
  const evaluate = (prof, stamp, bias) => {
    const all = [];
    for (const j of jobs) all.push(...replay(j.run, j.placed, M(prof), stamp, { bias }));
    return all;
  };
  const stamp0 = current.stamp || null;
  const base = evaluate(prof0, stamp0, 0);
  const before = summary(base);
  log('follow fit: ' + jobs.length + ' jobs (' + jobs.map((j) => j.run.id).join(', ') + '), drawn head ' + before.median + ' mm from the reported head (9 in 10 within ' + before.p90 + ' mm) with what\'s in use');

  // 1–2: the stamp (only runs that kept sent/rx times can say)
  let stamp = stamp0;
  const ks = fitStampK(jobs);
  if (ks) {
    stamp = { ...(stamp0 || {}) };
    for (const [kind, s] of Object.entries(ks)) { stamp[kind] = { k: s.k, c: 0 }; log('follow fit: ' + kind + ' replies read ' + Math.round(s.k * 100) + ' % of the way from asking to the reply: scatter ' + s.spread + ' ms, was ' + s.was + ' ms (' + s.n + ' straight-cut triples)'); }
    // the constant: by the replay
    let bestC = { c: 0, s: score(evaluate(prof0, stamp, 0)) };
    for (const c of [-150, -100, -50, 50, 100]) {
      const st = Object.fromEntries(Object.entries(stamp).map(([k, v]) => [k, { ...v, c }]));
      const s = score(evaluate(prof0, st, 0));
      if (s < bestC.s) bestC = { c, s };
    }
    for (const k of Object.keys(stamp)) stamp[k] = { ...stamp[k], c: bestC.c };
  }

  // 3: the route's timing, a parameter at a time, ×/÷ steps getting finer
  let prof = JSON.parse(JSON.stringify(prof0));
  let cur = score(evaluate(prof, stamp, 0));
  for (const step of opts.steps || [1.6, 1.25, 1.1]) {
    let moved = true, rounds = 0;
    while (moved && rounds++ < 3) {
      moved = false;
      for (const [grp, keys] of Object.entries(LIMITS)) {
        for (const [key, [lo, hi]] of Object.entries(keys)) {
          for (const f of [step, 1 / step]) {
            const v = Math.max(lo, Math.min(hi, prof[grp][key] * f));
            if (v === prof[grp][key]) continue;
            const trial = JSON.parse(JSON.stringify(prof));
            trial[grp][key] = +v.toPrecision(3);
            const s = score(evaluate(trial, stamp, 0));
            if (s < cur - 1e-3) { prof = trial; cur = s; moved = true; break; }
          }
        }
      }
    }
  }
  const afterErrs = evaluate(prof, stamp, 0);
  const after = summary(afterErrs);
  // better by 3 % and by 0.2 mm (in median + half the 9-in-10 error): below that it's noise
  const better = score(afterErrs) < 0.97 * score(base) && score(base) - score(afterErrs) >= 0.2;
  log('follow fit: ' + (better ? 'using' : 'not using (not clearly better)') + ' travel a ' + prof.travel.a + ' j ' + prof.travel.j + ' v ' + prof.travel.v + ', cut arc ' + prof.cut.arc + ' corner ' + prof.cut.corner + ' acc ' + prof.cut.acc + ': ' + after.median + ' mm (9 in 10 within ' + after.p90 + ' mm), was ' + before.median + ' and ' + before.p90 + ' mm');
  // the stamp stands on its own measure (the straight-cut scatter, no truth needed); the route's
  // timing only when it beats what's in use
  return { use: better, stampUse: !!ks, stamp, travel: prof.travel, cut: prof.cut, before, after, runs: jobs.map((j) => j.run.id), at: new Date().toISOString() };
}

module.exports = { fit, loadRuns, placement, replay, retimed, timeOf, tripleSpread, fitStampK, summary, score, LIMITS };

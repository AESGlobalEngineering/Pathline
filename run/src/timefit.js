// The Trotec estimate's parts, fitted to the jobs run: the cutting, the travel between cuts and
// the engraving each scaled by what the laser really took (cfg.timeScale, used by compile.js).
//
// Each step's estimate keeps its parts (compile.js, unscaled: cut, travel, engrave seconds), and
// over the recent runs
//   real ≈ cut·kCut + travel·kTravel + engrave·kEngrave
// is fitted by least squares, each k held gently towards 1 (a part the runs hardly have, say
// engraving, stays near 1). Used only when it brings the runs' totals nearer what they really
// took than the scales in use.
'use strict';

const fs = require('fs');
const path = require('path');

const LIMIT = { cut: [0.7, 1.4], travel: [0.6, 1.5], engrave: [0.6, 1.6] };
const KEYS = ['cut', 'travel', 'engrave'];

// a run's steps with their parts: as saved (since 13 Nov), or worked out again from the job
function stepsOf(run, dataDir, cfg) {
  if ((run.steps || []).some((s) => s.parts)) return run.steps;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dataDir, 'jobs', run.id, 'package.json'), 'utf8'));
    const plan = require('./job/plan');
    const p = require('./ctrl/trotec/compile').compile(plan.build(pkg), { ...cfg, timeScale: null });
    return p.segments.filter((s) => s.kind === 'stream').flatMap((s) => s.steps);
  } catch (e) { return null; }
}

// each step's real time: from when the marker before it was first reported to when its own was
// (not across a pause, nor the first step: its start isn't reported)
function stepTimes(run) {
  const first = new Map();
  const tl = (run.timeline || []).filter((t) => t[3] !== undefined && t[3] !== null);
  for (const t of tl) if (!first.has(t[3])) first.set(t[3], t[0]);
  const paused = (run.timeline || []).filter((t) => t[4] === 'paused').map((t) => t[0]);
  const out = new Map();
  for (const [m, at] of first) {
    if (!first.has(m - 1)) continue;
    const from = first.get(m - 1);
    if (paused.some((p) => p >= from && p <= at)) continue;
    out.set(m, (at - from) / 1000);
  }
  return out;
}

function solve3(A, b) {
  const m = A.map((r, i) => r.concat([b[i]]));
  for (let i = 0; i < 3; i++) {
    let p = i;
    for (let r = i + 1; r < 3; r++) if (Math.abs(m[r][i]) > Math.abs(m[p][i])) p = r;
    [m[i], m[p]] = [m[p], m[i]];
    if (Math.abs(m[i][i]) < 1e-12) return null;
    for (let r = 0; r < 3; r++) if (r !== i) { const f = m[r][i] / m[i][i]; for (let c = i; c < 4; c++) m[r][c] -= f * m[i][c]; }
  }
  return m.map((r, i) => r[3] / r[i]);
}

// Fitted on whole runs: each completed run's working time (its first busy report to its last)
// against the sum of its parts. Part by part (the time between two markers) was tried first and
// came out worse: a short part often passes between two status replies, so the parts timed are
// mostly the long ones, and the fit leaned on them. Whole runs, each counted as a fraction of its
// own length (a 2-minute job counts as much as a 25-minute one), each k held towards 1.
// On Ruby's last 27 runs: 1.37 % rms off → 1.13 %, the X21 job −0.8 % → +0.1 %.
// opts: { maxRuns (30), current: the timeScale in use }
function fit(dataDir, cfg, opts = {}) {
  const dir = path.join(dataDir, 'runs');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, opts.maxRuns || 30); } catch (e) { return { use: false, why: 'no runs' }; }
  const runs = [];
  for (const f of files) {
    let run;
    try { run = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { continue; }
    if (run.result !== 'Completed') continue;
    // (a pause would count as working time)
    if ((run.timeline || []).some((t) => t[4] === 'paused')) continue;
    const busy = (run.timeline || []).filter((t) => t[4] === 'busy');
    if (busy.length < 20) continue;
    const steps = stepsOf(run, dataDir, cfg);
    if (!steps) continue;
    const x = [0, 0, 0];
    let other = 0;
    for (const s of steps) {
      if (s.parts) KEYS.forEach((k, i) => { x[i] += s.parts[k] || 0; });
      else other += s.seconds || 0;
    }
    const d = (busy[busy.length - 1][0] - busy[0][0]) / 1000 - other;
    const est = x[0] + x[1] + x[2];
    if (!(d > 10) || !(est > 5) || Math.abs(est / d - 1) > 0.5) continue;
    runs.push({ file: f, x, d });
  }
  if (runs.length < 4) return { use: false, why: 'not enough runs yet (' + runs.length + ')' };
  const LAM = 0.01;
  const N = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], B = [0, 0, 0];
  for (const r of runs) { const w = 1 / (r.d * r.d); for (let i = 0; i < 3; i++) { B[i] += w * r.x[i] * r.d; for (let j = 0; j < 3; j++) N[i][j] += w * r.x[i] * r.x[j]; } }
  for (let i = 0; i < 3; i++) { N[i][i] += LAM; B[i] += LAM; }
  const k = solve3(N, B);
  if (!k) return { use: false, why: 'could not fit' };
  const scale = Object.fromEntries(KEYS.map((key, i) => [key, +k[i].toFixed(4)]));
  // how far each run's total comes out, with these and with those in use
  const cur = opts.current || {};
  const kc = KEYS.map((key) => (Number.isFinite(cur[key]) ? cur[key] : 1));
  const err = (ks) => {
    const e = runs.map((r) => ((r.x[0] * ks[0] + r.x[1] * ks[1] + r.x[2] * ks[2]) / r.d - 1) * 100);
    return { mean: +(e.reduce((a, v) => a + v, 0) / e.length).toFixed(2), worst: +Math.max(...e.map(Math.abs)).toFixed(2), rms: +Math.sqrt(e.reduce((a, v) => a + v * v, 0) / e.length).toFixed(2) };
  };
  const before = err(kc), after = err(k);
  const inside = KEYS.every((key, i) => k[i] >= LIMIT[key][0] && k[i] <= LIMIT[key][1]);
  const use = inside && after.rms < before.rms - 0.1;
  return {
    use, scale, before, after, runs: runs.length, at: new Date().toISOString(),
    why: !inside ? 'a scale came out of range (' + JSON.stringify(scale) + ')' : !use ? 'no better than what is in use' : ''
  };
}

module.exports = { fit, stepTimes, stepsOf };

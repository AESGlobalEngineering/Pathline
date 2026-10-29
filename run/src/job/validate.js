// Checks a job package before it is queued (POST /jobs → 400 with the first
// problem) and before it runs. Messages are written for the operator.
'use strict';

const STEP_TYPES = new Set(['inspect', 'engrave', 'cut', 'dwell', 'toolchange', 'feed']);
const ok = (v) => typeof v === 'number' && Number.isFinite(v);

function bad(msg) {
  return Object.assign(new Error(msg), { code: 400 });
}

// Throws on anything that would make the package unusable. Returns warnings.
function check(pkg, cfg) {
  if (!pkg || typeof pkg !== 'object') throw bad('Not a job package');
  if (pkg.format !== 'lrc-job-package') throw bad('Not a Pathline job package (format is ' + JSON.stringify(pkg.format) + ')');
  if (pkg.version !== 1) throw bad('Job package version ' + pkg.version + ' is not supported (expected 1)');
  const type = cfg.controller === 'ruida' && cfg.type === 'plotter' ? 'plotter' : 'laser';
  const plotter = type === 'plotter';
  if (pkg.machine && pkg.machine.type && pkg.machine.type !== type) {
    throw bad('This is a ' + pkg.machine.type + ' job, but ' + cfg.name + ' is a ' + type);
  }
  if (!Array.isArray(pkg.toolpath)) throw bad('The job has no toolpath');
  const procs = new Map((pkg.processes || []).map((p) => [p.index, p]));
  const slots = new Set((cfg.heads || []).map((h) => h.slot));
  const warnings = [];
  for (const p of procs.values()) {
    if (!ok(p.speed) || p.speed <= 0) throw bad('Process "' + p.name + '": speed must be above 0');
    if (plotter) {
      // plotter processes name a tool: "T2 · V-cut 45°" → slot T2
      const slot = String(p.tool || '').split(' · ')[0].trim();
      if (!slot) throw bad('Process "' + p.name + '" has no tool');
      if (!slots.has(slot)) warnings.push('Process "' + p.name + '" uses ' + slot + ', which isn\'t set up on this plotter (Setup → Tools)');
      continue;
    }
    if (p.proc !== 'Cut' && p.proc !== 'Engrave') throw bad('Process "' + p.name + '" is not a laser process');
    if (!ok(p.power) || p.power < 0 || p.power > 100) throw bad('Process "' + p.name + '": power must be 0–100 %');
    if (p.proc === 'Engrave' && (!ok(p.f) || p.f < 10 || p.f > 2000)) throw bad('Process "' + p.name + '": resolution must be 10–2000 DPI');
  }
  const [W, H] = cfg.bed;
  const tol = 0.5;
  const inBed = (x, y) => ok(x) && ok(y) && x >= -tol && y >= -tol && x <= W + tol && y <= H + tol;
  pkg.toolpath.forEach((s, i) => {
    const where = 'Step ' + (i + 1) + ' (' + (s.name || s.type) + ')';
    if (!STEP_TYPES.has(s.type)) throw bad(where + ': unknown step type ' + JSON.stringify(s.type));
    if (!plotter && (s.type === 'toolchange' || s.type === 'feed')) throw bad(where + ': plotter steps can\'t run on a laser');
    if (plotter && (s.type === 'engrave' || s.type === 'inspect')) throw bad(where + ': laser steps can\'t run on a plotter');
    if (plotter && s.type === 'feed' && !cfg.f.conveyor) throw bad(where + ': the job feeds the conveyor, but this plotter has no conveyor (Setup → Work area)');
    if ((s.type === 'cut' || s.type === 'engrave') && !procs.has(s.process)) throw bad(where + ': unknown process ' + s.process);
    if (s.type === 'cut') {
      if (!Array.isArray(s.p) || s.p.length < 2) throw bad(where + ': the path has no points');
      for (const [x, y] of s.p) if (!inBed(x, y)) throw bad(where + ': the path leaves the bed (' + W + ' × ' + H + ' mm)');
    }
    if (s.type === 'engrave') {
      const b = s.box;
      if (!Array.isArray(b) || b.length !== 4 || !inBed(b[0], b[1]) || !inBed(b[2], b[3])) throw bad(where + ': the engraving leaves the bed (' + W + ' × ' + H + ' mm)');
    }
    if (s.type === 'dwell' && (!ok(s.seconds) || s.seconds < 0 || s.seconds > 3600)) throw bad(where + ': dwell must be 0–3600 s');
  });
  if (pkg.toolpath.some((s) => s.type === 'inspect')) {
    warnings.push(cfg.regMarks === 'ignore'
      ? 'Registration marks are skipped: the job runs without print-and-cut correction'
      : 'Uses registration marks. Pathline Run has no camera yet, so it won\'t start unless Setup → Job defaults → Registration marks is set to "Skip"');
  }
  const blocked = (pkg.checks || []).find((c) => c && c.block);
  if (blocked) throw bad('Pathline blocked this job: ' + blocked.l);
  return warnings;
}

// A .cjob file holds the editable job at the top level and the package in `run`.
function fromCjob(cjob) {
  if (cjob && cjob.format === 'lrc-job-package') return cjob;
  if (!cjob || !cjob.run || cjob.run.format !== 'lrc-job-package') throw bad('This file has no prepared run. Open it in Pathline and save or send it again.');
  return { ...cjob.run, entities: cjob.run.entities || cjob.entities || [], files: { cjob } };
}

module.exports = { check, fromCjob, bad };

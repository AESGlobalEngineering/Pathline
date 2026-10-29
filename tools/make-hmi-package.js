// Builds hmi-handoff\ (and Pathline-HMI-handoff.zip): everything another
// developer or chat needs to build the controller/HMI app ("Pathline Run")
// that Pathline sends jobs to. Example packages are produced by the app's own
// exporters, so they are exactly what the HMI will receive.
// Run: node tools/make-hmi-package.js
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const CC = require('../src/shared/core');
const ex = require('../src/main/exporters');
const seed = require('../src/main/seed');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'hmi-handoff');
const ZIP = path.join(ROOT, 'Pathline-HMI-handoff.zip');
const write = (rel, data) => {
  const f = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
};
const copy = (from, to) => {
  const dst = path.join(OUT, to);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(path.join(ROOT, from), dst, { recursive: true });
};

// ---------------------------------------------------------------- example machines
const laser = {
  ...seed.machineTemplate('laser'), id: 'm-laser', name: 'Laser A', ctrl: 'Trotec', ip: '192.168.1.40',
  info: { ...seed.machineTemplate('laser').info, bed: [813, 508], speed: 3000, acc: 40000, prefix: 'LA-', markType: 'Dot', markD: '5.0', camX: '-42.15', camY: '18.60',
    f: { camera: true, autofocus: true, rotary: false, air: true, pass: false, interlock: true } }
};
const plotter = {
  ...seed.machineTemplate('plotter'), id: 'm-plotter', name: 'Plotter B', ctrl: 'Ruida', ip: '192.168.1.52',
  info: { ...seed.machineTemplate('plotter').info, prefix: 'PB-',
    heads: [['T1', 'Knife'], ['T2', 'V-cut 45°'], ['T3', 'Crease wheel'], ['T4', 'Pen']].map(([slot, tool], i) => ({ slot, tool, x: (i * 24.5).toFixed(2), y: '0.00', loaded: true })),
    f: { conveyor: true, vacuum: true, pointer: true, camera: false } }
};

// ---------------------------------------------------------------- example jobs
const E = (x, y, r) => CC.shapes.ellipse(x, y, r, r);
const ent = (id, name, aci, paths, bed) => ({ id, name, type: 'Path', aci, paths, group: null, bed: bed || 0 });

// Print and cut on a laser with a camera: 3 registration marks, engraving in
// two islands (two discs at the same height share one scan, a label stands
// alone) in the "fastest" direction, a dashed tear-off line, and a contour
// cut in 2 passes with a dwell.
function laserJob() {
  const processes = CC.defaultPresets('laser', 3).map((p) => (p.name === 'Cut contour' ? { ...p, passes: 2, dwell: 3 } : p.name === 'Engrave fill' ? { ...p, dir: 'fastest' } : p))
    .concat({ ...CC.regProcess(), aci: [9] });
  const entities = [
    ent('outline', 'Outline', 1, [{ p: CC.shapes.rect(60, 40, 260, 160, 12), c: true }]),
    ent('hole', 'Hole', 1, [{ p: E(280, 160, 14), c: true }]),
    ent('disc1', 'Disc', 7, [{ p: E(110, 90, 18), c: true }]),
    ent('disc2', 'Disc 2', 7, [{ p: E(160, 90, 18), c: true }]),
    ent('label', 'Label', 7, [{ p: CC.shapes.rect(90, 150, 120, 24, 4), c: true }, { p: CC.shapes.rect(96, 156, 108, 12, 2), c: true }]),
    ent('tear', 'Tear-off line', 3, [{ p: [[240, 50], [240, 190]], c: false }]),
    ent('m1', 'Mark', 9, [{ p: CC.shapes.dot(40, 25, 5), c: true }]),
    ent('m2', 'Mark 2', 9, [{ p: CC.shapes.dot(340, 25, 5), c: true }]),
    ent('m3', 'Mark 3', 9, [{ p: CC.shapes.dot(40, 215, 5), c: true }])
  ];
  return {
    format: 'cjob', version: 2, id: 'j-example-laser', name: 'Print and cut example', notes: 'Example job for the HMI handoff',
    machineId: laser.id, machineType: 'laser', materialId: 'acr-3', regMode: 'linear',
    sheet: { on: true, w: 400, h: 260, x: 10, y: 5 }, processes, entities, beds: 1, cutOrder: { order: 'speed', inside: 'part' }
  };
}
// Plotter on a conveyor: knife, perforation, crease and V-cut over two beds
// (tool changes and one conveyor feed in the toolpath).
function plotterJob() {
  const processes = CC.defaultPresets('plotter', 5);
  const box = (bed) => [
    ent('box' + bed, 'Box ' + (bed + 1), 1, [{ p: CC.shapes.rect(100, 100, 600, 400, 0), c: true }], bed),
    ent('perf' + bed, 'Perforation ' + (bed + 1), 6, [{ p: [[100, 300], [700, 300]], c: false }], bed),
    ent('crease' + bed, 'Crease ' + (bed + 1), 3, [{ p: [[400, 100], [400, 500]], c: false }], bed),
    ent('vcut' + bed, 'V-cut ' + (bed + 1), 5, [{ p: [[250, 100], [250, 500]], c: false }], bed)
  ];
  return {
    format: 'cjob', version: 2, id: 'j-example-plotter', name: 'Folding box ×2', notes: '',
    machineId: plotter.id, machineType: 'plotter', materialId: 'foam-5', regMode: 'off',
    sheet: { on: false }, processes, entities: box(0).concat(box(1)), beds: 2, cutOrder: { order: 'speed', inside: 'part' }
  };
}
const materials = {
  laser: { id: 'acr-3', g: 'Acrylic', name: 'Cast acrylic, clear', t: 3, m: ['laser'], presets: { laser: CC.defaultPresets('laser', 3), plotter: [] } },
  plotter: { id: 'foam-5', g: 'Board & card', name: 'Foam board', t: 5, m: ['plotter'], presets: { laser: [], plotter: CC.defaultPresets('plotter', 5) } }
};

// the exact body Pathline POSTs to /api/v1/jobs (see deliver() in src/main/main.js)
function example(dir, job, m, mat) {
  const est = CC.estimate(job, m, { timeline: true });
  const pkg = ex.buildPackage(job, m, mat, est);
  pkg.createdAt = '2026-10-28T12:00:00.000Z';
  const run = { ...pkg };
  delete run.entities;
  const cjob = { ...job, format: 'cjob', version: 3, savedAt: pkg.createdAt, material: mat, machine: m, run };
  const files = { dxf: ex.toDxf(job, m, { onlyOutput: true }), svg: ex.toSvg(job, m), sheet: ex.jobSheet(job, m, mat, est), cjob };
  write(dir + '/post-jobs-body.json', { ...pkg, files });
  write(dir + '/package-without-files.json', pkg);
  write(dir + '/job.dxf', files.dxf);
  write(dir + '/job.svg', files.svg);
  write(dir + '/job-sheet.txt', files.sheet);
  write(dir + '/example.cjob', cjob);
  const kinds = {};
  pkg.toolpath.forEach((s) => { const k = s.type + (s.scan ? ':' + s.scan : ''); kinds[k] = (kinds[k] || 0) + 1; });
  console.log(dir + ': ' + pkg.toolpath.length + ' steps ' + JSON.stringify(kinds) + ', ' + pkg.estimate.total);
}

// ---------------------------------------------------------------- build
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
example('examples/laser-print-and-cut', laserJob(), laser, materials.laser);
example('examples/plotter-two-beds', plotterJob(), plotter, materials.plotter);

// example responses, as the emulator and Pathline expect them
const { name: _n, ...laserSettings } = { name: laser.name, ...laser.info, f: laser.info.f };
write('examples/responses/GET-info.json', { name: 'Laser A', type: 'laser', ctrl: 'Trotec', model: 'Speedy 360', firmware: '2.4.1', protocol: 1, bed: [813, 508] });
write('examples/responses/GET-machine-laser.json', laserSettings);
write('examples/responses/GET-machine-plotter.json', plotter.info);
write('examples/responses/GET-status-idle.json', { state: 'idle', pos: { x: 0, y: 0, z: 0 }, progress: 0, job: null, message: 'Ready', io: { air: false, pointer: false, vacuum: false, exhaust: true } });
write('examples/responses/GET-status-running.json', { state: 'running', pos: { x: 212.4, y: 96.75, z: 0 }, progress: 0.42, job: 'J0012', message: 'Running Print and cut example', io: { air: true, pointer: false, vacuum: false, exhaust: true } });
write('examples/responses/GET-jobs.json', [
  { id: 'J0012', name: 'Print and cut example', status: 'running', progress: 0.42, seconds: 312, receivedAt: '2026-10-28T09:40:00Z', finishedAt: null },
  { id: 'J0013', name: 'Folding box ×2', status: 'queued', progress: 0, seconds: 95, receivedAt: '2026-10-28T09:52:00Z', finishedAt: null },
  { id: 'J0011', name: 'Test grid', status: 'done', progress: 1, seconds: 410, receivedAt: '2026-10-28T08:10:00Z', finishedAt: '2026-10-28T08:17:00Z' }
]);
write('examples/responses/POST-jobs-response.json', { id: 'J0014', status: 'queued' });
write('examples/responses/error-409.json', { error: 'Machine is busy' });

copy('PROTOCOL.md', 'PROTOCOL.md');
copy('hmi/HMI-BRIEF.md', 'HMI-BRIEF.md');
copy('hmi/check-hmi.js', 'tools/check-hmi.js');
copy('tools/device-emulator.js', 'reference/device-emulator.js');
copy('src/main/device.js', 'reference/pathline-device-client.js');
copy('src/shared/core.js', 'reference/core.js');
// core.js sits next to it in reference\
write('reference/exporters.js', fs.readFileSync(path.join(ROOT, 'src/main/exporters.js'), 'utf8').replace("require('../shared/core')", "require('./core')"));
copy('src/ui/theme.css', 'reference/theme.css');
copy('src/main/updates.js', 'reference/updates.js');
copy('src/main/reports.js', 'reference/reports.js');
copy('build/brand', 'brand');

fs.rmSync(ZIP, { force: true });
execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Compress-Archive -Path "' + OUT + '\\*" -DestinationPath "' + ZIP + '"'], { stdio: 'inherit' });
console.log('Wrote ' + path.relative(ROOT, OUT) + '\\ and ' + path.basename(ZIP));

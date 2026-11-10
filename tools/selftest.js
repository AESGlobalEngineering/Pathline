#!/usr/bin/env node
// Backend self-test: importers, exporters, estimator and the device protocol
// (against the emulator). Run with `npm test`.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const CC = require('../src/shared/core');
const { importFile } = require('../src/main/importers');
const ex = require('../src/main/exporters');
const device = require('../src/main/device');
const discover = require('../src/main/discover');
const seed = require('../src/main/seed');

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  ok   ' : '  FAIL ') + msg);
  if (!cond) failed++;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrc-test-'));

// Test machines (the app itself ships with none): a fast laser with a camera,
// a 4-head plotter with a conveyor, and a slow laser without a camera.
const fixtureMachines = () => [
  { ...seed.machineTemplate('laser'), id: 'trotec', name: 'Trotec Speedy 360', ctrl: 'Trotec', ip: '192.168.1.40',
    info: { ...seed.machineTemplate('laser').info, bed: [813, 508], speed: 3550, acc: 50000, prefix: 'TRO-', f: { camera: true, autofocus: true, rotary: false, air: true } } },
  { ...seed.machineTemplate('plotter'), id: 'flatbed', name: 'Flatbed 1', ctrl: 'Ruida', ip: '192.168.1.52',
    info: { ...seed.machineTemplate('plotter').info, prefix: 'FLT-',
      heads: [['T1', 'Knife'], ['T2', 'V-cut 45°'], ['T3', 'Crease wheel'], ['T4', 'Pen']].map(([slot, tool], i) => ({ slot, tool, x: (i * 24.5).toFixed(2), y: '0.00', loaded: true })),
      f: { conveyor: true, vacuum: true, pointer: true, camera: false } } },
  { ...seed.machineTemplate('laser'), id: 'laser2', name: 'Laser 2', ctrl: 'Ruida', ip: '192.168.1.61',
    info: { ...seed.machineTemplate('laser').info, bed: [1300, 900], speed: 600, acc: 8000, power: 100, f: { camera: false, autofocus: false, rotary: true, air: true } } }
];

function testJob() {
  const machines = fixtureMachines();
  const laser = machines[0];
  const ents = [
    { id: 'a', name: 'Square', aci: 1, paths: [{ p: CC.shapes.rect(10, 10, 100, 100, 0), c: true }] },
    { id: 'b', name: 'Hole', aci: 1, paths: [{ p: CC.shapes.ellipse(60, 60, 20, 20), c: true }] },
    { id: 'c', name: 'Fill', aci: 7, paths: [{ p: CC.shapes.rect(200, 10, 50, 50, 0), c: true }] },
    { id: 'd', name: 'Tear', aci: 3, paths: [{ p: [[150, 10], [150, 110]], c: false }] }
  ].concat([[5, 5], [300, 5], [5, 200]].map(([x, y], i) => ({ id: 'r' + i, name: 'Reg mark', aci: 9, paths: [{ p: CC.shapes.dot(x, y, 5), c: true }] })));
  const processes = seed.laserPresets(3).concat({ ...CC.regProcess(), aci: [9] });
  const job = { format: 'cjob', id: 'j1', name: 'Selftest', machineId: laser.id, machineType: 'laser', processes, entities: ents, sheet: { on: false }, regMode: 'linear', beds: 1, cutOrder: { order: 'file', inside: 'all' } };
  return { job, laser, plotter: machines[1] };
}

async function main() {
  console.log('Estimator');
  {
    // a straight 100 mm line at 10 mm/s with huge acceleration ≈ 10 s
    ok(near(CC.polyTime([[0, 0], [100, 0]], false, 10, 1e9), 10, 0.01), 'straight line time = length / speed');
    // with finite acceleration the profile adds (v/a) seconds
    ok(near(CC.polyTime([[0, 0], [100, 0]], false, 100, 1000), 1.1, 0.01), 'trapezoid profile (1.1 s)');
    // a square must slow at the corners, so it takes longer than its perimeter at full speed
    const sq = CC.polyTime(CC.shapes.rect(0, 0, 100, 100, 0), true, 200, 2000);
    ok(sq > 2 && sq < 3.5, 'corner slowdown on a square (' + sq.toFixed(2) + ' s)');
    const { job, laser } = testJob();
    const est = CC.estimate(job, laser, { timeline: true });
    ok(est.total > 0 && est.perProcess.length === 3, 'estimate covers cut, tear-off and engrave (' + CC.fmtDuration(est.total, true) + ')');
    const order = est.timeline.filter((o) => o.kind === 'op').map((o) => job.processes[o.proc].proc);
    ok(order[0] === 'Engrave' && order[order.length - 1] === 'Cut', 'engrave runs before cutting');
    const cuts = est.timeline.filter((o) => o.kind === 'op' && o.mode === 'vector' && o.proc === 0);
    ok(cuts[0].ent === 'b', 'inner hole is cut before the outer square');
    const opt = CC.estimate({ ...job, cutOrder: { order: 'speed', inside: 'all' } }, laser);
    ok(opt.travel <= est.travel + 1e-6, 'fastest order does not add travel');
    ok(est.travelLegs.fromOrigin > 0 && est.travelLegs.toOrigin > 0, 'travel from and back to the origin is counted');
    const sum = est.perProcess.reduce((s, p) => s + p.time, 0) + est.travelTime + est.inspectTime;
    ok(near(sum, est.total, 1e-6), 'process times + travel + mark reading = total');
    const br = CC.estimate(job, { ...laser, info: { ...laser.info, origin: 'br' } }, { timeline: true });
    ok(br.timeline[0].from[0] === 813 && br.timeline[0].from[1] === 508, 'head starts at the machine origin corner (bottom right)');
    ok(CC.regMarks(job, laser).length === 3 && !est.timeline.some((o) => o.ent && o.ent[0] === 'r'), 'reg marks come from Reg marks colours and are not cut');

    // cut order: two parts (each a square with a hole), in file order part 1 then part 2
    const parts = [];
    [[0, 0], [300, 0]].forEach(([x, y], k) => {
      parts.push({ id: 'o' + k, aci: 1, paths: [{ p: CC.shapes.rect(x + 10, y + 10, 100, 100, 0), c: true }] });
      parts.push({ id: 'h' + k, aci: 1, paths: [{ p: CC.shapes.ellipse(x + 60, y + 60, 20, 20), c: true }] });
    });
    const pj = { ...job, entities: parts, regMode: 'off' };
    const seq = (inside, order) => CC.estimate({ ...pj, cutOrder: { inside, order } }, laser, { timeline: true }).timeline.filter((o) => o.kind === 'op').map((o) => o.ent).join(',');
    ok(/^h(\d),o\1,h(\d),o\2$/.test(seq('part', 'ordered')), 'inside first, part by part: ' + seq('part', 'ordered'));
    ok(/^h\d,h\d,o\d,o\d$/.test(seq('all', 'ordered')), 'all insides first: ' + seq('all', 'ordered'));
    ok(seq('off', 'file') === 'o0,h0,o1,h1', 'inside-first off: ' + seq('off', 'file'));
    // heat: a 6 × 6 grid of small squares — consecutive cuts should be further apart than with fastest order
    const grid = [];
    for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) grid.push({ id: 'g' + r + c, aci: 1, paths: [{ p: CC.shapes.rect(20 + c * 30, 20 + r * 30, 20, 20, 0), c: true }] });
    const gap = (order) => {
      const ops = CC.estimate({ ...pj, entities: grid, cutOrder: { inside: 'off', order } }, laser, { timeline: true }).timeline.filter((o) => o.kind === 'op');
      let s = 0;
      for (let i = 1; i < ops.length; i++) s += Math.hypot(ops[i].path.p[0][0] - ops[i - 1].path.p[0][0], ops[i].path.p[0][1] - ops[i - 1].path.p[0][1]);
      return s / (ops.length - 1);
    };
    ok(gap('ordered') <= gap('speed') + 1e-6, 'ordered also goes to the nearest next cut (' + gap('ordered').toFixed(0) + ' mm vs ' + gap('speed').toFixed(0) + ' mm)');
    // cut order modes: old 'file'/'heat' jobs read as Ordered; By process keeps the list order; Fastest picks the quickest order
    ok(CC.cutOrderOf({ cutOrder: { order: 'file' } }).order === 'ordered' && CC.cutOrderOf({ cutOrder: { order: 'heat' } }).order === 'ordered', 'old cut orders read as Ordered');
    {
      const mix = { ...pj, entities: [{ id: 'c', aci: 1, paths: [{ p: CC.shapes.rect(10, 10, 40, 40, 0), c: true }] }, { id: 'g', aci: 7, paths: [{ p: CC.shapes.rect(15, 15, 20, 20, 0), c: true }] }],
        processes: [{ name: 'Cut', proc: 'Cut', power: 80, speed: 20, f: 5000, passes: 1, out: true, aci: [1] }, { name: 'Engrave', proc: 'Engrave', power: 60, speed: 400, f: 500, passes: 1, out: true, aci: [7] }] };
      const by = (order) => CC.estimate({ ...mix, cutOrder: { inside: 'part', order } }, laser);
      ok(by('process').procOrder.join() === '0,1', 'by process runs the processes in list order (' + by('process').procOrder + ')');
      ok(by('ordered').procOrder.join() === '1,0', 'ordered engraves before cutting (' + by('ordered').procOrder + ')');
      ok(by('speed').total <= by('ordered').total + 1e-6, 'fastest is never slower than ordered');
      // here the engraving sits inside the cut, so fastest may not cut first (by process would)
      ok(by('speed').procOrder.join() === '1,0', 'fastest engraves before cutting the part it sits in (' + by('speed').procOrder + ')');
      // fastest may engrave after cutting, but never inside a part already cut out
      const part = (x, k) => [{ id: 'c' + k, aci: 1, paths: [{ p: CC.shapes.rect(x, 20, 80, 80, 0), c: true }] }, { id: 'g' + k, aci: 7, paths: [{ p: CC.shapes.rect(x + 20, 40, 40, 40, 0), c: true }] }];
      const far = { ...mix, entities: [...part(10, 0), ...part(600, 1), { id: 'gx', aci: 7, paths: [{ p: CC.shapes.rect(700, 300, 30, 30, 0), c: true }] }] };
      const ops = CC.estimate({ ...far, cutOrder: { inside: 'part', order: 'speed' } }, laser, { timeline: true }).timeline.filter((o) => o.kind === 'op');
      const runs = ops.map((o) => (o.mode === 'raster' ? (o.ents || []).join('+') : o.ent));
      const at = (id) => runs.findIndex((r) => String(r).split('+').includes(id));
      ok(at('g0') < at('c0') && at('g1') < at('c1'), 'fastest engraves inside a part before cutting it out (' + runs.join(' ') + ')');
      ok(Math.min(at('c0'), at('c1')) < Math.max(at('g0'), at('g1'), at('gx')), 'fastest can engrave after cutting (' + runs.join(' ') + ')');
      const t = (order) => CC.estimate({ ...far, cutOrder: { inside: 'part', order } }, laser).total;
      ok(t('speed') <= t('ordered') + 1e-6, 'part by part is no slower than ordered (' + t('speed').toFixed(1) + ' s vs ' + t('ordered').toFixed(1) + ' s)');
      // fastest keeps to "Cut inside shapes first": parts with a hole and a logo, far apart
      const holed = (x, k) => [{ id: 'o' + k, aci: 1, paths: [{ p: CC.shapes.rect(x, 20, 120, 120, 0), c: true }] }, { id: 'h' + k, aci: 1, paths: [{ p: CC.shapes.ellipse(x + 90, 80, 10, 10), c: true }] }, { id: 'g' + k, aci: 7, paths: [{ p: CC.shapes.rect(x + 15, 40, 40, 40, 0), c: true }] }];
      const hj = { ...mix, entities: [...holed(10, 0), ...holed(700, 1)] };
      const runOf = (inside) => CC.estimate({ ...hj, cutOrder: { inside, order: 'speed' } }, laser, { timeline: true }).timeline.filter((o) => o.kind === 'op').map((o) => (o.mode === 'raster' ? (o.ents || []).join('+') : o.ent));
      const idx = (r, id) => r.findIndex((x) => String(x).split('+').includes(id));
      const rAll = runOf('all'), rPart = runOf('part'), rOff = runOf('off');
      ok(Math.max(idx(rAll, 'h0'), idx(rAll, 'h1')) < Math.min(idx(rAll, 'o0'), idx(rAll, 'o1')), 'fastest, all insides: every hole before any outline (' + rAll.join(' ') + ')');
      ok(idx(rPart, 'h0') < idx(rPart, 'o0') && idx(rPart, 'h1') < idx(rPart, 'o1') && (idx(rPart, 'o0') < idx(rPart, 'h1') || idx(rPart, 'o1') < idx(rPart, 'h0')), 'fastest, per part: each part finished before the next (' + rPart.join(' ') + ')');
      ok(rOff.length === 6 && idx(rOff, 'g0') < idx(rOff, 'o0') && idx(rOff, 'g1') < idx(rOff, 'o1'), 'fastest, inside-first off: still engraves before cutting out (' + rOff.join(' ') + ')');
    }
    // registration marks: on means a Registration marks process; presets keep the job's own and never bring one
    {
      const cut = { name: 'Cut', proc: 'Cut', aci: [1] }, reg = { ...CC.regProcess(), aci: [5] };
      ok(CC.ensureRegProcess({ regMode: 'linear', processes: [cut] }).processes.some(CC.isRegProc), 'marks on adds a Registration marks process');
      ok(!CC.ensureRegProcess({ regMode: 'off', processes: [cut] }).processes.some(CC.isRegProc), 'marks off adds nothing');
      const kept = CC.withPresets({ processes: [cut, reg] }, [{ name: 'New cut', proc: 'Cut', aci: [1] }, { ...CC.regProcess(), aci: [9] }]);
      ok(kept.length === 2 && kept[1].aci[0] === 5, 'material presets keep the job\'s registration marks (and their colour)');
    }
    // thermal map: colour matters on a fibre laser, barely on CO2
    {
      const clear = { name: 'Clear acrylic', g: 'Acrylic', t: 3 }, black = { name: 'Black acrylic', g: 'Acrylic', t: 3 };
      const P = CC.thermalOf(clear);
      const f = (m, fib) => CC.absorptionOf(P, m, fib).absorb;
      ok(f(black, true) > 5 * f(clear, true), 'fibre: black acrylic takes far more of the beam than clear (' + f(black, true) + ' vs ' + f(clear, true) + ')');
      ok(Math.abs(f(black, false) - f(clear, false)) <= 0.0601, 'CO2: colour changes absorption only a little (' + f(black, false) + ' vs ' + f(clear, false) + ')');
      ok(CC.absorptionOf(CC.thermalOf({ name: 'Black stainless 304' }), { name: 'Black stainless 304' }, true).colour === null, 'bare metal has no colour');
    }
    // repeat: the whole job once, then again; a process marked once isn't repeated
    {
      const sq = (id, x, aci) => ({ id, aci, paths: [{ p: CC.shapes.rect(x, 10, 20, 20, 0), c: true }] });
      const rj = { ...pj, regMode: 'off', repeat: 3, cutOrder: { order: 'process', inside: 'off' }, entities: [sq('a', 10, 1), sq('b', 60, 2), sq('l', 110, 3)],
        processes: [{ name: 'A', proc: 'Cut', power: 50, speed: 20, f: 5000, passes: 1, out: true, aci: [1] }, { name: 'B', proc: 'Cut', power: 60, speed: 20, f: 5000, passes: 1, out: true, aci: [2] }, { name: 'Labels', proc: 'Cut', power: 10, speed: 50, f: 5000, passes: 1, once: true, out: true, aci: [3] }] };
      const ops = CC.estimate(rj, laser, { timeline: true }).timeline.filter((o) => o.kind === 'op');
      const seq = ops.map((o) => o.ent + o.round).join(' ');
      ok(seq === 'a1 b1 l1 a2 b2 a3 b3', 'repeat runs the whole job, then again; once-only processes once (' + seq + ')');
    }
    // print and cut: registration marks must be inside the machine's markArea (where Run's camera can read them)
    {
      const dot = (id, x, y) => ({ id, aci: 5, paths: [{ p: CC.shapes.ellipse(x, y, 2.5, 2.5), c: true }] });
      const procs = [{ name: 'Cut', proc: 'Cut', power: 80, speed: 20, f: 5000, passes: 1, out: true, aci: [1] }, { ...CC.regProcess(), aci: [5] }];
      const pc = (marks, art) => ({ ...pj, regMode: 'nonlinear', entities: [art || { id: 'art', aci: 1, paths: [{ p: CC.shapes.rect(60, 60, 300, 200, 0), c: true }] }].concat(marks), processes: procs });
      const mach = (area, extra) => ({ id: 'q', type: 'laser', info: { bed: [1300, 900], markArea: area, camX: '-41.74', camY: '-12.99', f: { camera: true }, ...(extra || {}) } });
      // the owner's Q500 sends [26.9, 3.5, 1300, 900]: marks at x ≥ 28.9, y ≥ 5.5 (2 mm inside it)
      const q500 = mach([26.9, 3.5, 1300, 900]);
      const R = CC.camReach(q500);
      ok(Math.abs(R.keep.x0 - 28.9) < 1e-9 && Math.abs(R.keep.y0 - 5.5) < 1e-9 && R.keep.x1 === 1298 && R.keep.y1 === 898, 'Q500 markArea: marks kept in x 28.9–1298, y 5.5–898 (not worked out from camX/camY)');
      const x28 = pc([dot('m1', 13, 13), dot('m2', 1269.57, 13), dot('m3', 13, 844.35)]);
      const far = CC.marksOutOfReach(x28, q500);
      ok(far.length === 2 && far.every((f) => f.edge === 'left' && f.from === 13 && f.see === 26.9), 'the X28 job: marks 1 and 3 are 13 mm from the left edge, the camera sees from 26.9 mm');
      const chk = CC.checkJob(x28, q500).find((c) => c.reach);
      ok(chk && chk.block && /Mark 1 is 13 mm from the left edge; this laser's camera can only see from 26.9 mm/.test(chk.l), 'out-of-reach marks block Send and name the mark and the edge (' + (chk && chk.l) + ')');
      const sh = CC.reachShift(x28, q500);
      const moved = { ...x28, entities: x28.entities.map((e) => CC.translate(e, sh.dx, sh.dy)) };
      const mk = CC.regMarks(moved, q500);
      ok(mk.every((m) => m.x >= 28.9 - 1e-6 && m.y >= 5.5 - 1e-6) && !CC.checkJob(moved, q500).some((c) => c.block), 'moving the job ' + sh.dx + ' mm right puts every mark at x ≥ 28.9, y ≥ 5.5 and nothing blocks Send');
      // each edge: a mark too near it is flagged, and the job moves away from it
      const area = mach([40, 30, 1260, 870]);
      const edgeOf = (x, y) => CC.marksOutOfReach(pc([dot('a', x, y), dot('b', 650, 450), dot('c', 600, 400)]), area).map((f) => f.edge).join();
      ok(edgeOf(35, 450) === 'left' && edgeOf(1262, 450) === 'right' && edgeOf(650, 20) === 'back' && edgeOf(650, 880) === 'front', 'marks too near each edge are flagged with that edge');
      const away = (x, y) => CC.reachShift(pc([dot('a', x, y), dot('b', 650, 450), dot('c', 600, 400)]), area);
      ok(away(35, 450).dx > 0 && away(1262, 450).dx < 0 && away(650, 20).dy > 0 && away(650, 880).dy < 0, 'the job moves away from whichever edge a mark is too near');
      // parts may sit outside the marks, right up to the bed edge: only the marks are limited
      const edgeArt = { id: 'art', aci: 1, paths: [{ p: CC.shapes.rect(0, 0, 1300, 120, 0), c: true }] };
      const inside = pc([dot('m1', 40, 200), dot('m2', 1200, 200), dot('m3', 40, 700)], edgeArt);
      ok(!CC.marksOutOfReach(inside, q500).length && !CC.checkJob(inside, q500).some((c) => c.block), 'parts right up to the bed edge are fine when the marks are inside markArea');
      // marks further apart than markArea: no placement works
      const big = pc([dot('m1', 2, 100), dot('m2', 1299, 100), dot('m3', 2, 500)]);
      const bs = CC.reachShift(big, q500), bc = CC.checkJob(big, q500).find((c) => c.block && /too big for print and cut/.test(c.l));
      ok(bs.tooWide === 'x' && bc, 'marks further apart than markArea: the job is too big for print and cut on this machine (' + (bc && bc.l) + ')');
      // no markArea (camera off, older Run, even with camX/camY), camera off, or a plotter: nothing is checked
      ok(!CC.camReach(mach(undefined)) && !CC.camReach(mach([26.9, 3.5, 1300, 900], { f: { camera: false } })) && !CC.camReach({ type: 'plotter', info: { markArea: [10, 10, 100, 100] } }), 'no markArea, camera off or a plotter: marks are not checked');
      ok(!CC.marksOutOfReach(x28, mach(undefined)).length && !CC.checkJob(x28, mach(undefined)).some((c) => c.reach || /too big/.test(c.l)), 'without markArea the X28 marks pass as before');
      ok(!CC.marksOutOfReach({ ...x28, regMode: 'off' }, q500).length, 'registration marks off: nothing is checked');
    }
    // same-size parts touching side by side are never "inside" each other (a first point on the shared
    // edge, and rounding in the areas, made a part count as a hole of its neighbour and get cut early)
    {
      const ents = [];
      for (let k = 0; k < 3; k++) {
        const x = 20 + k * 100;
        // start each outline on the edge it shares with the next part, like the owner's job
        const w = 100 + k * 1e-7, r = CC.shapes.rect(x, 20, w, 297, 0); const i0 = r.findIndex((q) => q[0] === x + w);
        ents.push({ id: 'o' + k, aci: 1, paths: [{ p: r.slice(i0).concat(r.slice(0, i0)), c: true }] });
        for (let j = 0; j < 4; j++) ents.push({ id: 'h' + k + j, aci: 1, paths: [{ p: CC.shapes.ellipse(x + 50, 60 + j * 60, 8, 8), c: true }] });
      }
      const pj2 = { ...pj, regMode: 'off', repeat: 1, entities: ents, processes: [{ name: 'Cut', proc: 'Cut', power: 80, speed: 20, f: 5000, passes: 2, out: true, aci: [1] }] };
      for (const order of ['ordered', 'speed', 'process']) {
        const seq = CC.estimate({ ...pj2, cutOrder: { order, inside: 'all' } }, laser, { timeline: true }).timeline.filter((o) => o.kind === 'op').map((o) => o.ent[0]);
        ok(seq.lastIndexOf('h') < seq.indexOf('o'), order + ', all insides, touching parts and 2 passes: every hole before any outline (' + seq.join('') + ')');
      }
    }
    // print and cut: the first cut is next to the last registration mark read, in every inside-first mode
    {
      const dot = (id, x, y) => ({ id, aci: 5, paths: [{ p: CC.shapes.ellipse(x, y, 2.5, 2.5), c: true }] });
      const part = (k, x, y) => [{ id: 'o' + k, aci: 1, paths: [{ p: CC.shapes.rect(x, y, 120, 60, 0), c: true }] }, { id: 'h' + k, aci: 1, paths: [{ p: CC.shapes.ellipse(x + 30, y + 30, 8, 8), c: true }] },
        { id: 'n' + k, aci: 1, paths: [{ p: CC.shapes.ellipse(x + 30, y + 30, 2, 2), c: true }] }, { id: 'q' + k, aci: 1, paths: [{ p: CC.shapes.rect(x + 80, y + 20, 20, 20, 0), c: true }] }];
      const ents = [dot('m1', 10, 10), dot('m2', 10, 300), dot('m3', 600, 10)].concat(part(0, 30, 30), part(1, 450, 30), part(2, 30, 200), part(3, 450, 200));
      const procs = [{ name: 'Cut', proc: 'Cut', power: 80, speed: 20, f: 5000, passes: 1, out: true, aci: [1] }, { ...CC.regProcess(), aci: [5] }];
      for (const inside of ['all', 'part', 'off']) {
        const tl = CC.estimate({ ...pj, regMode: 'linear', repeat: 1, entities: ents, processes: procs, cutOrder: { order: 'speed', inside } }, laser, { timeline: true }).timeline;
        const last = tl.filter((o) => o.kind === 'inspect').pop(), first = tl.find((o) => o.kind === 'op');
        const hop = Math.hypot(first.path.p[0][0] - last.at[0], first.path.p[0][1] - last.at[1]);
        ok(hop < 200, inside + ': print and cut starts cutting next to the last mark read (' + Math.round(hop) + ' mm from it)');
        const read = tl.filter((o) => o.kind === 'inspect').map((o) => o.at.map(Math.round).join(','));
        ok(read.join(' ') === '10,10 10,300 600,10', inside + ': registration marks are read top left, bottom left, top right (' + read.join(' → ') + ')');
      }
      // whatever order the marks were drawn in
      {
        const shuffled = [dot('m3', 600, 10), dot('m1', 10, 10), dot('m2', 10, 300)].concat(part(0, 30, 30), part(1, 450, 30), part(2, 30, 200), part(3, 450, 200));
        const read = CC.estimate({ ...pj, regMode: 'linear', repeat: 1, entities: shuffled, processes: procs, cutOrder: { order: 'speed', inside: 'all' } }, laser, { timeline: true }).timeline.filter((o) => o.kind === 'inspect').map((o) => o.at.map(Math.round).join(','));
        ok(read.join(' ') === '10,10 10,300 600,10', 'marks drawn in another order are still read top left, bottom left, top right (' + read.join(' → ') + ')');
      }
    }
    // open lines inside a part are inside it: cut with its holes, before its outline
    {
      const part = [{ id: 'o', aci: 1, paths: [{ p: CC.shapes.rect(10, 10, 100, 60, 0), c: true }] }, { id: 'h', aci: 1, paths: [{ p: CC.shapes.ellipse(30, 40, 6, 6), c: true }] },
        { id: 'l1', aci: 1, paths: [{ p: [[60, 30], [90, 50]], c: false }] }, { id: 'l2', aci: 1, paths: [{ p: [[60, 50], [90, 30]], c: false }] }];
      for (const inside of ['part', 'all']) {
        const seq = CC.estimate({ ...pj, regMode: 'off', repeat: 1, entities: part, cutOrder: { order: 'speed', inside } }, laser, { timeline: true }).timeline.filter((o) => o.kind === 'op').map((o) => o.ent);
        ok(seq[seq.length - 1] === 'o' && seq.length === 4, inside + ': lines inside a part are cut before its outline (' + seq.join(' ') + ')');
      }
    }
    // closed cuts start and finish along an edge, not on a corner (a corner cut from a standstill twice melts)
    {
      const sqs = [0, 1, 2].map((i) => ({ id: 'q' + i, aci: 1, paths: [{ p: CC.shapes.rect(20 + i * 40, 20, 30, 30, 0), c: true }] }));
      const ops = CC.estimate({ ...pj, regMode: 'off', repeat: 1, entities: sqs, cutOrder: { order: 'speed', inside: 'off' } }, laser, { timeline: true }).timeline.filter((o) => o.kind === 'op');
      const corners = sqs.map((e) => e.paths[0].p);
      const onCorner = ops.filter((o) => corners.some((c) => c.some((v) => Math.hypot(v[0] - o.path.p[0][0], v[1] - o.path.p[0][1]) < 0.05)));
      ok(ops.length === 3 && !onCorner.length, 'squares start along an edge, not on a corner (' + ops.map((o) => o.path.p[0].map((v) => v.toFixed(1)).join(',')).join(' · ') + ')');
      ok(ops.every((o) => Math.abs(CC.polyLen(o.path.p, true) - 120) < 0.01), 'starting along an edge keeps the whole outline (120 mm each)');
    }
    // the start/stop gap from corners is a job setting (Job settings), down to 0
    {
      const sq = [{ id: 'q', aci: 1, paths: [{ p: CC.shapes.rect(40, 40, 30, 30, 0), c: true }] }];
      const startOf = (gap) => CC.estimate({ ...pj, regMode: 'off', repeat: 1, entities: sq, cutOrder: { order: 'speed', inside: 'off' }, ...(gap === undefined ? {} : { startClear: gap }) }, laser, { timeline: true }).timeline.find((o) => o.kind === 'op').path.p[0];
      const toCorner = (q) => Math.min(...sq[0].paths[0].p.map((v) => Math.hypot(v[0] - q[0], v[1] - q[1])));
      ok(Math.abs(toCorner(startOf()) - CC.START_CLEAR) < 1e-6, 'default start/stop gap ' + CC.START_CLEAR + ' mm from the corner');
      ok(Math.abs(toCorner(startOf(0.5)) - 0.5) < 1e-6, 'a job gap of 0.5 mm starts 0.5 mm from the corner (' + toCorner(startOf(0.5)).toFixed(3) + ')');
      ok(toCorner(startOf(0)) < 1e-6, 'a gap of 0 may start right on the corner (' + startOf(0).join(',') + ')');
    }
    // overlapping lines are cut once
    {
      const sq = (x) => ({ p: CC.shapes.rect(x, 0, 50, 50, 0), c: true });
      const a = sq(0), b = sq(50), dup = sq(0);
      const m = CC.commonLines([a, b, dup]);
      const len = (ps) => ps.reduce((s, q) => s + CC.polyLen(q.p, q.c), 0);
      ok(!m.has(a) && Math.abs(len(m.get(b)) - 150) < 0.01, 'shared edge of two squares cut once (' + len(m.get(b)).toFixed(1) + ' mm left of the second)');
      ok(m.get(dup).length === 0, 'an exact duplicate is not cut at all');
      const shared = { ...pj, entities: [{ id: 'a', aci: 1, paths: [a] }, { id: 'b', aci: 1, paths: [b] }, { id: 'd', aci: 1, paths: [dup] }], regMode: 'off' };
      const est = CC.estimate({ ...shared, cutOrder: { inside: 'off', order: 'speed' } }, laser);
      ok(Math.abs(est.cutLen - 350) < 0.5, 'cut length counts shared lines once (' + est.cutLen.toFixed(1) + ' mm)');
      // touching parts with holes: an outline left open by a shared edge is still an outline
      const row = [];
      for (let i = 0; i < 4; i++) row.push({ id: 'p' + i, aci: 1, paths: [{ p: CC.shapes.rect(i * 100, 0, 100, 100, 0), c: true }] }, { id: 'h' + i, aci: 1, paths: [{ p: CC.shapes.ellipse(i * 100 + 50, 50, 18, 18), c: true }] });
      for (const order of ['speed', 'ordered']) {
        const seqOf = (inside) => CC.estimate({ ...shared, entities: row, cutOrder: { inside, order } }, laser, { timeline: true }).timeline.filter((o) => o.kind === 'op').map((o) => o.ent);
        const all = seqOf('all'), part = seqOf('part');
        ok(all.lastIndexOf(all.filter((x) => x[0] === 'h').pop()) < all.findIndex((x) => x[0] === 'p'), order + ', all insides with shared edges: holes first (' + all.join(' ') + ')');
        ok([0, 1, 2, 3].every((i) => part.indexOf('h' + i) < part.indexOf('p' + i)), order + ', per part with shared edges: each hole before its outline (' + part.join(' ') + ')');
      }
    }
    // 2 passes, any order: item 1, 2, 3, 4 once, then 1, 2, 3, 4 again
    const twoPass = { ...pj, entities: grid.slice(0, 4), processes: pj.processes.map((p, i) => (i === 0 ? { ...p, passes: 2 } : p)) };
    const fast = CC.estimate({ ...twoPass, cutOrder: { inside: 'off', order: 'speed' } }, laser, { timeline: true }).timeline.filter((o) => o.kind === 'op');
    const fastSeq = fast.map((o) => o.ent + '/' + o.pass).join(' ');
    ok(fast.length === 8 && fast.every((o, i) => i % 2 === 0 || (o.ent === fast[i - 1].ent && o.pass === 2)), 'fastest: each item\'s passes straight after each other (' + fastSeq + ')');
    const tlFast = CC.estimate({ ...twoPass, cutOrder: { inside: 'off', order: 'speed' } }, laser, { timeline: true }).timeline;
    ok(tlFast.filter((o) => o.kind === 'travel').length === 5, 'fastest: no travel between passes of the same item');
    // engraving islands: two dots far apart are engraved separately, not scanned across the gap
    const dots = { ...pj, entities: [{ id: 'd1', aci: 7, paths: [{ p: CC.shapes.dot(30, 30, 10), c: true }] }, { id: 'd2', aci: 7, paths: [{ p: CC.shapes.dot(330, 30, 10), c: true }] }] };
    const dOps = CC.estimate(dots, laser, { timeline: true }).timeline.filter((o) => o.kind === 'op');
    const oneBlock = CC.rasterSpans(dots.entities.flatMap((e) => e.paths), 500).rows.reduce((s, [, a, b]) => s + (b - a), 0);
    const islands = dOps.reduce((s, o) => s + (o.box.x1 - o.box.x0) * o.rows, 0);
    ok(dOps.length === 2 && dOps.every((o) => o.mode === 'raster' && o.ents.length === 1) && islands < oneBlock / 10, 'separate engraving islands, no scanning across the gap');
    // dwell between passes: the head waits before each later pass
    const dwellJob = { ...twoPass, processes: twoPass.processes.map((p, i) => (i === 0 ? { ...p, dwell: 3 } : p)) };
    const estFile = CC.estimate({ ...dwellJob, cutOrder: { inside: 'off', order: 'file' } }, laser, { timeline: true });
    ok(estFile.timeline.filter((o) => o.kind === 'dwell').length === 1 && near(estFile.dwellTime, 3, 1e-6), 'as drawn: one dwell between the rounds');
    // fastest pays the dwell once per round when that beats once per item
    const estSpeed = CC.estimate({ ...dwellJob, cutOrder: { inside: 'off', order: 'speed' } }, laser, { timeline: true });
    ok(estSpeed.total <= estFile.total + 1e-6 && estSpeed.timeline.filter((o) => o.kind === 'dwell').length === 1, 'fastest with a dwell: whole rounds when quicker (' + estSpeed.total.toFixed(1) + ' s vs ' + estFile.total.toFixed(1) + ' s as drawn)');
    // marks are read top left, bottom left, top right; the job starts at the last one (top right)
    const regJob = { ...pj, regMode: 'linear', processes: pj.processes.concat([{ ...CC.regProcess(), aci: [9] }]), cutOrder: { order: 'speed', inside: 'part' },
      entities: [[45, 55], [140, 55], [55, 485]].flatMap(([x, y], i) => [{ id: 'r' + i, aci: 7, paths: [{ p: CC.shapes.ellipse(x, y, 15, 15), c: true }, { p: CC.shapes.ellipse(x, y, 6, 6), c: true }] }, { id: 'm' + i, aci: 9, paths: [{ p: CC.shapes.ellipse(x, y, 6, 6), c: true }] }]) };
    const regOps = CC.estimate(regJob, laser, { timeline: true }).timeline.filter((o) => o.kind === 'op');
    ok(regOps[0].ents.includes('r1'), 'after reading the marks (top right last), the job starts at the top right (' + regOps.map((o) => o.ents.join('+')).join(' > ') + ')');
    // close together on a slow-accelerating laser: one side-to-side scan is quicker
    const slow = { ...laser, info: { ...laser.info, speed: 600, acc: 8000 } };
    const close = { ...pj, entities: [{ id: 'n1', aci: 7, paths: [{ p: CC.shapes.dot(30, 30, 10), c: true }] }, { id: 'n2', aci: 7, paths: [{ p: CC.shapes.dot(48, 30, 10), c: true }] }] };
    const nOps = CC.estimate(close, slow, { timeline: true }).timeline.filter((o) => o.kind === 'op');
    const sep = CC.rasterIslands(close.entities, 500, 400, 8000).reduce((s, r) => s + r.dur, 0);
    ok(nOps.length === 1 && nOps[0].shared === 2 && nOps[0].dur < sep, 'shared scan across nearby items when faster (' + (nOps[0] && nOps[0].dur.toFixed(1)) + ' s vs ' + sep.toFixed(1) + ' s one by one)');
    const fOps = CC.estimate(dots, slow, { timeline: true }).timeline.filter((o) => o.kind === 'op');
    ok(fOps.length === 2 && fOps.every((o) => !o.shared), 'items far apart stay one by one on the same machine');
    // engrave direction (top down / bottom up / fastest) and one-way scanning
    const engJob = (extra, origin) => {
      const j = { ...pj, entities: [{ id: 'q', aci: 7, paths: [{ p: CC.shapes.rect(100, 100, 50, 50, 0), c: true }] }], processes: pj.processes.map((p) => (p.proc === 'Engrave' && p.aci.includes(7) ? { ...p, ...extra } : p)) };
      return CC.estimate(j, origin ? { ...laser, info: { ...laser.info, origin } } : laser, { timeline: true }).timeline.find((o) => o.kind === 'op');
    };
    ok(engJob({}).dir === 'down' && engJob({ dir: 'up' }).dir === 'up', 'engraving runs top down by default, bottom up when set');
    ok(engJob({ dir: 'fastest' }, 'bl').dir === 'up' && engJob({ dir: 'fastest' }, 'tl').dir === 'down', 'fastest starts from the end nearer the head (bottom up from a bottom origin)');
    ok(engJob({ adv: { Direction: 'Bottom up' } }).dir === 'up', 'older jobs keep their Bottom up direction');
    const bi = engJob({}), uni = engJob({ uni: true });
    ok(uni.uni && !bi.uni && uni.dur > bi.dur * 1.2, 'one-way scanning takes longer (' + uni.dur.toFixed(1) + ' s vs ' + bi.dur.toFixed(1) + ' s both ways)');
    const hUp = CC.headAt([{ ...engJob({ dir: 'up' }), start: 0, end: 1 }], 0.01);
    ok(hUp.y > 140, 'bottom-up engraving starts at the bottom in the simulation (y ' + hUp.y.toFixed(1) + ')');
    for (const order of ['ordered', 'process']) {
      const ops = CC.estimate({ ...twoPass, cutOrder: { inside: 'off', order } }, laser, { timeline: true }).timeline.filter((o) => o.kind === 'op');
      const first = ops.slice(0, 4).map((o) => o.ent).join(), second = ops.slice(4).map((o) => o.ent).join();
      ok(ops.length === 8 && first === second && ops.slice(0, 4).every((o) => o.pass === 1) && ops.slice(4).every((o) => o.pass === 2), order + ': all items once, then all again (' + first + ' | ' + second + ')');
    }
    // two parts each with a hole, 2 passes, all insides first: holes, holes again, outlines, outlines again
    const twoParts = { ...pj, entities: parts, processes: pj.processes.map((p, i) => (i === 0 ? { ...p, passes: 2 } : p)) };
    const seqAll = CC.estimate({ ...twoParts, cutOrder: { inside: 'all', order: 'ordered' } }, laser, { timeline: true }).timeline.filter((o) => o.kind === 'op').map((o) => o.ent.charAt(0) + '/' + o.pass).join(' ');
    ok(seqAll === 'h/1 h/1 h/2 h/2 o/1 o/1 o/2 o/2', 'all insides first, 2 passes: ' + seqAll);
    const seqPart = CC.estimate({ ...twoParts, cutOrder: { inside: 'part', order: 'file' } }, laser, { timeline: true }).timeline.filter((o) => o.kind === 'op').map((o) => o.ent + '/' + o.pass).join(' ');
    ok(seqPart === 'h0/1 h0/2 o0/1 o0/2 h1/1 h1/2 o1/1 o1/2', 'per part, 2 passes: ' + seqPart);
    // engraving and cutting with 2 passes: registration marks, then engraving twice, then cutting
    const both = { ...job, processes: job.processes.map((p) => (CC.isRegProc(p) ? p : { ...p, passes: 2 })), cutOrder: { order: 'speed', inside: 'part' } };
    const tl2 = CC.estimate(both, laser, { timeline: true }).timeline.filter((o) => o.kind === 'op' || o.kind === 'inspect');
    const seqB = tl2.map((o) => (o.kind === 'inspect' ? 'R' : job.processes[o.proc].proc[0] + o.pass));
    ok(seqB.slice(0, 3).join() === 'R,R,R' && seqB.slice(3, 5).join() === 'E1,E2' && seqB.slice(5).every((s) => s[0] === 'C'), 'registration marks, then etching, then cutting: ' + seqB.join(' '));
    const tHeat = CC.estimate({ ...twoPass, cutOrder: { inside: 'off', order: 'heat' } }, laser).perProcess[0].time;
    const tSpeed = CC.estimate({ ...twoPass, cutOrder: { inside: 'off', order: 'speed' } }, laser).perProcess[0].time;
    ok(near(tHeat, tSpeed, 1e-6), 'cutting time is the same either way (only travel changes)');
    // start points: a square entered from its far side should start on an edge near the travel path (never on a corner)
    const squares = [{ id: 's1', aci: 1, paths: [{ p: [[110, 110], [10, 110], [10, 10], [110, 10]], c: true }] }, { id: 's2', aci: 1, paths: [{ p: [[200, 10], [250, 10], [250, 60], [200, 60]], c: true }] }];
    const st = CC.estimate({ ...pj, entities: squares, cutOrder: { inside: 'off', order: 'file' } }, laser, { timeline: true }).timeline.filter((o) => o.kind === 'op');
    // the route travels as little as possible: the corner (110, 10) is on the way to the next part, so the start is beside it
    const isCorner = (q, e) => e.paths[0].p.some((v) => Math.hypot(v[0] - q[0], v[1] - q[1]) < 0.05);
    const s0 = st[0].path.p[0], s1 = st[1].path.p[0];
    ok(!isCorner(s0, squares[0]) && Math.hypot(s0[0] - 110, s0[1] - 10) <= 26, 'cut starts on an edge where the travel is shortest: ' + s0.join(','));
    ok(!isCorner(s1, squares[1]) && Math.hypot(s1[0] - 200, s1[1] - 10) <= 13, 'next cut starts on an edge nearest the previous one: ' + s1.join(','));
    // too many registration marks blocks sending
    const four = { ...job, entities: job.entities.concat({ id: 'r9', aci: 9, paths: [{ p: CC.shapes.dot(400, 300, 5), c: true }] }) };
    ok(CC.checkJob(four, laser).some((c) => c.block), '4 registration marks for a 3-mark mode blocks sending');
    ok(CC.fmtArea(4280) === '4,280 mm²' && CC.fmtArea(2.5e6) === '2.50 m²', 'areas in mm², then m²');
    const h = CC.headAt(est.timeline, est.total / 2);
    ok(Number.isFinite(h.x) && Number.isFinite(h.y), 'head position mid-job');
    const checks = CC.checkJob(job, laser);
    ok(checks.every((c) => c.ok), 'checks pass: ' + checks.map((c) => c.l).join(' · '));
    const broken = { ...job, entities: job.entities.concat({ id: 'x', aci: 1, paths: [{ p: [[0, 0], [10, 0], [10, 10], [0, 0.5]], c: false }] }) };
    ok(CC.checkJob(broken, laser).some((c) => !c.ok && /not quite closed/.test(c.l)), 'flags a contour that is not quite closed');
  }

  console.log('Thermal');
  {
    const { job, laser } = testJob();
    const est = CC.estimate(job, laser, { timeline: true });
    const acr = { name: 'Cast acrylic', g: 'Acrylic', t: 3 };
    const sim = CC.thermalSim(job, laser, acr, est.timeline);
    const mid = sim.to(est.total * 0.6).max();
    const end = sim.to(est.total).max();
    ok(mid > 25 && sim.peak < 2000, 'acrylic heats while cutting (peak ≈ ' + Math.round(sim.peak) + ' °C, cell ' + sim.cellMm.toFixed(1) + ' mm)');
    sim.to(est.total * 0.6);
    ok(Math.abs(sim.max() - mid) < 1e-3, 'rewinding gives the same temperatures');
    const alu = CC.thermalSim(job, laser, { name: 'Aluminium, bare', g: 'Metal', t: 1 }, est.timeline).to(est.total);
    ok(alu.peak < sim.peak / 3, 'bare aluminium barely heats on CO2 (' + Math.round(alu.peak) + ' °C vs ' + Math.round(sim.peak) + ' °C)');
    ok(CC.thermalOf({ name: 'Cast acrylic', g: 'Acrylic', thermal: { limit: 999 } }).limit === 105, 'thermal data comes from the reference table, not the material');
    ok(CC.thermalKey({ name: 'Stainless steel 316', g: 'Metal' }) === 'ss316' && CC.thermalKey({ name: 'Stainless steel 304', g: 'Metal' }) === 'ss304', 'stainless 304 and 316 have their own data');
    ok(CC.thermalOf({ name: 'Mystery sheet', g: 'Other' }) === null && CC.thermalSim(job, laser, { name: 'Mystery sheet', g: 'Other', t: 3 }, est.timeline) === null, 'no thermal map without reference data');
    ok(seed.machines().length === 0 && seed.materials().length === 0, 'ships with no machines or materials');
    // presets per machine: a machine's own list wins, others use the shared list for their type
    const [m1, , m2] = fixtureMachines();
    const pm = { ...acr, presets: { laser: seed.laserPresets(3), [m2.id]: seed.laserPresets(3).map((p) => ({ ...p, power: 70 })) } };
    ok(CC.presetsFor(pm, m1)[0].power === 90 && CC.presetsFor(pm, m2)[0].power === 70, 'each machine can have its own presets for a material');
    void end;
  }

  console.log('Nesting');
  {
    // mixed parts on a 600 × 400 sheet: everything placed, inside the area, no overlaps (with spacing)
    const sizes = [[200, 120], [150, 150], [80, 220], [120, 60], [300, 90], [90, 90], [60, 140], [180, 70], [100, 100], [40, 200]];
    const parts = sizes.map(([w, h], i) => ({ id: 'p' + i, w, h }));
    const r = CC.nestRects(parts, { w: 600, h: 400 }, { spacing: 5, rotate: true, maxAreas: 1 });
    const box = (p) => { const s = sizes[+p.id.slice(1)]; const [w, h] = p.rot ? [s[1], s[0]] : s; return { x0: p.x, y0: p.y, x1: p.x + w, y1: p.y + h }; };
    const bs = r.placed.map(box);
    const inside = bs.every((b) => b.x0 >= -1e-9 && b.y0 >= -1e-9 && b.x1 <= 600 + 1e-9 && b.y1 <= 400 + 1e-9);
    const apart = bs.every((a, i) => bs.every((b, j) => i === j || a.x1 + 5 <= b.x0 + 1e-6 || b.x1 + 5 <= a.x0 + 1e-6 || a.y1 + 5 <= b.y0 + 1e-6 || b.y1 + 5 <= a.y0 + 1e-6));
    ok(r.placed.length === parts.length && inside && apart, 'nesting places every part inside the sheet, spaced apart (' + Math.round(r.util * 100) + ' % of the used material)');
    // long parts only fit when turned
    const long = [{ id: 'a', w: 300, h: 50 }, { id: 'b', w: 300, h: 50 }];
    ok(CC.nestRects(long, { w: 120, h: 400 }, { spacing: 5, rotate: false, maxAreas: 1 }).placed.length === 0 &&
      CC.nestRects(long, { w: 120, h: 400 }, { spacing: 5, rotate: true, maxAreas: 1 }).placed.every((p) => p.rot === 90), 'parts are turned 90° when that is the only way they fit');
    // plotter: more parts than one bed holds go onto more beds; a single sheet leaves the rest out
    const many = Array.from({ length: 30 }, (_, i) => ({ id: 'm' + i, w: 300, h: 200 }));
    const beds = CC.nestRects(many, { w: 1580, h: 980 }, { spacing: 5, rotate: true });
    const one = CC.nestRects(many, { w: 1580, h: 980 }, { spacing: 5, rotate: true, maxAreas: 1 });
    ok(beds.placed.length === 30 && beds.areas === 2 && one.placed.length + one.unplaced.length === 30 && one.unplaced.length > 0, 'plotter nesting adds beds as needed (' + beds.areas + ' beds); a single sheet leaves out what does not fit (' + one.unplaced.length + ')');
  }

  console.log('Release notes');
  {
    const changelog = require('../src/main/changelog');
    const version = require('../package.json').version;
    ok(changelog[0].version === version && changelog.every((c) => c.version && Array.isArray(c.added) && Array.isArray(c.fixed)), 'What\'s new has an entry for this version (' + version + ')');
  }

  console.log('Bug report file');
  {
    // the .zip writer: read the first entry back (local header → deflated data)
    const { zipFiles } = require('../src/main/reports');
    const text = Buffer.from('{"title":"zip test","n":' + '1234567890'.repeat(50) + '}');
    const zip = zipFiles([{ name: 'report.json', data: text }, { name: 'b.txt', data: Buffer.from('second') }]);
    const nameLen = zip.readUInt16LE(26), size = zip.readUInt32LE(18);
    const back = require('zlib').inflateRawSync(zip.slice(30 + nameLen, 30 + nameLen + size));
    const end = zip.length - 22;
    ok(zip.readUInt32LE(0) === 0x04034b50 && zip.readUInt32LE(end) === 0x06054b50 && zip.readUInt16LE(end + 10) === 2 && back.equals(text), 'bug report zip holds the files, readable back (' + zip.length + ' bytes)');
  }

  console.log('Plotter estimate');
  {
    const { job, plotter } = testJob();
    const pj = { ...job, machineId: plotter.id, machineType: 'plotter', processes: seed.plotterPresets(5), entities: job.entities.map((e, i) => ({ ...e, aci: [1, 5, 3, 7][i], bed: i % 2 })) };
    const est = CC.estimate(pj, plotter, { timeline: true });
    ok(est.beds === 2 && est.feeds === 1, 'two beds with one conveyor feed');
    ok(est.toolChanges >= 2, 'tool changes counted (' + est.toolChanges + ')');
  }

  console.log('Importers');
  {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="50mm" viewBox="0 0 100 50"><rect x="0" y="0" width="40" height="20" stroke="#FF0000" fill="none"/><path d="M50 0 l10 0 l0 10 z" stroke="blue"/><g transform="translate(70 10)"><circle r="5" stroke="#00FF00" fill="none"/></g></svg>';
    fs.writeFileSync(path.join(tmp, 'a.svg'), svg);
    const r = await importFile(path.join(tmp, 'a.svg'));
    ok(r.entities.length === 3, 'SVG: 3 shapes');
    ok(near(r.width, 75, 0.01) && near(r.height, 20, 0.01), 'SVG: size in mm (' + r.width.toFixed(2) + ' × ' + r.height.toFixed(2) + ')');
    ok(r.entities.map((e) => e.aci).sort().join() === '1,3,5', 'SVG: colours map to ACI 1, 3, 5');

    // loose LINE segments forming a square must chain into one closed contour
    const dxf = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES']
      .concat(...[[0, 0, 50, 0], [50, 0, 50, 30], [50, 30, 0, 30], [0, 30, 0, 0]].map(([a, b, c, d]) => ['0', 'LINE', '8', '0', '62', '1', '10', a, '20', b, '11', c, '21', d]))
      .concat(['0', 'CIRCLE', '8', '0', '62', '5', '10', '25', '20', '15', '40', '5', '0', 'ENDSEC', '0', 'EOF']).join('\n');
    fs.writeFileSync(path.join(tmp, 'b.dxf'), dxf);
    const d = await importFile(path.join(tmp, 'b.dxf'));
    ok(d.entities.length === 2 && d.entities.every((e) => e.paths[0].c), 'DXF: 4 lines chained into a closed square + circle');
    ok(near(d.width, 50, 0.01) && near(d.height, 30, 0.01), 'DXF: size 50 × 30 mm');

    const plt = 'IN;SP1;PU0,0;PD400,0,400,400,0,400,0,0;SP2;PU800,0;PD1200,0;';
    fs.writeFileSync(path.join(tmp, 'c.plt'), plt);
    const p = await importFile(path.join(tmp, 'c.plt'));
    ok(p.entities.length === 2 && near(p.width, 30, 0.01), 'PLT: pens and 40 units/mm');

    // minimal hand-written vector PDF: a red 72 pt (25.4 mm) square
    const content = '1 0 0 RG 72 72 m 144 72 l 144 144 l 72 144 l h S';
    const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 216 216] /Contents 4 0 R >>', '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream'];
    let pdf = '%PDF-1.4\n';
    const offs = [];
    objs.forEach((o, i) => { offs.push(pdf.length); pdf += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
    const xref = pdf.length;
    pdf += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('') + 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
    fs.writeFileSync(path.join(tmp, 'd.pdf'), pdf);
    const pd = await importFile(path.join(tmp, 'd.pdf'));
    ok(pd.entities.length === 1 && pd.entities[0].aci === 1 && pd.entities[0].paths[0].c, 'PDF: closed red path');
    ok(near(pd.width, 25.4, 0.01), 'PDF: points converted to mm (' + pd.width.toFixed(2) + ')');
  }

  console.log('Exporters');
  {
    const { job, laser } = testJob();
    const dxf = ex.toDxf(job, laser);
    fs.writeFileSync(path.join(tmp, 'out.dxf'), dxf);
    const back = await importFile(path.join(tmp, 'out.dxf'));
    const cut = back.entities.filter((e) => e.aci === 1).map((e) => CC.entityBox(e)).sort((a, b) => CC.boxW(b) - CC.boxW(a));
    ok(cut.length === 2, 'DXF round trip keeps both cut contours');
    ok(near(CC.boxW(cut[0]), 100, 0.01) && near(CC.boxH(cut[0]), 100, 0.01) && near(CC.boxW(cut[1]), 40, 0.05), 'DXF round trip keeps sizes (100 mm square, 40 mm hole)');
    ok(back.entities.filter((e) => e.aci === 3).length === 1 && back.entities.filter((e) => e.aci === 7).length >= 1, 'DXF round trip keeps colours');
    ok(/REGMARKS/.test(dxf), 'DXF includes the reg marks layer');
    const svg = ex.toSvg(job, laser);
    ok(svg.includes('width="813mm"') && svg.includes('id="REGMARKS"'), 'SVG export at bed size with reg marks');
    ok(/8\r\nREGMARKS\r\n62\r\n9/.test(dxf), 'DXF puts reg-mark objects on the REGMARKS layer');
    const est = CC.estimate(job, laser);
    const sheet = ex.jobSheet(job, laser, null, est);
    ok(/ESTIMATED TIME/.test(sheet) && /Cut contour/.test(sheet), 'job sheet lists time and processes');
    const pkg = ex.buildPackage(job, laser, null, est);
    ok(pkg.format === 'lrc-job-package' && pkg.estimate.totalSeconds === Math.round(est.total) && pkg.processes.length === job.processes.filter((p) => p.out !== false && !CC.isRegProc(p)).length, 'job package carries settings and estimate');
    ok(pkg.regMarks.marks.length === 3 && pkg.regMarks.aci.join() === '9', 'job package lists the reg marks and their colour');
    const pkgT = ex.buildPackage(job, laser, null, CC.estimate(job, laser, { timeline: true }));
    ok(pkgT.toolpath.length > 0 && pkgT.toolpath[0].type === 'inspect' && pkgT.toolpath[3].type === 'engrave' && pkgT.toolpath.some((t) => t.type === 'cut' && t.p.length > 2), 'job package carries the toolpath in run order (' + pkgT.toolpath.length + ' steps)');
    const eng = pkgT.toolpath.find((t) => t.type === 'engrave');
    const engProc = pkgT.processes.find((p) => p.proc === 'Engrave');
    ok(eng.direction === 'down' && eng.bidirectional === true && engProc.dir === 'down' && engProc.uni === false, 'engrave steps carry their direction and scan mode');
    ok(pkgT.processes.every((p) => p.ratio === undefined), 'no power ratio in the package');
  }

  console.log('Device protocol (emulator)');
  {
    const port = 18470 + Math.floor(Math.random() * 1000);
    const emu = spawn(process.execPath, [path.join(__dirname, 'device-emulator.js'), '--port', String(port), '--out', path.join(tmp, 'received'), '--speed', '1000'], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((res) => { emu.stdout.once('data', res); setTimeout(res, 2000); });
    const m = { ...testJob().laser, ip: '127.0.0.1', port, timeout: 2000 };
    try {
      const t = await device.test(m);
      ok(t.ok && t.info.bed, 'test connection (' + t.ms + ' ms)');
      const settings = await device.machineSettings(m);
      ok(Array.isArray(settings.bed), 'read machine settings');
      await device.command(m, 'jog', { axis: 'x', distance: 25 });
      await device.command(m, 'jog', { axis: 'y', distance: 10 });
      let st = await device.status(m);
      ok(st.pos.x === 25 && st.pos.y === 10, 'jog moves the head');
      await device.command(m, 'home', {});
      st = await device.status(m);
      ok(st.pos.x === 0 && st.pos.y === 0, 'home');
      const { job } = testJob();
      const est = CC.estimate(job, m);
      const res = await device.sendPackage(m, { ...ex.buildPackage(job, m, null, est), files: { dxf: ex.toDxf(job, m) } });
      ok(res && res.id, 'send job package (' + res.id + ')');
      await device.command(m, 'start', {});
      await new Promise((r) => setTimeout(r, 600));
      st = await device.status(m);
      ok(['running', 'idle'].includes(st.state), 'start job (' + st.state + ')');
      const dir = fs.readdirSync(path.join(tmp, 'received'));
      ok(dir.length === 1 && fs.existsSync(path.join(tmp, 'received', dir[0], 'job.dxf')), 'device stored the job files');
      // the machine's queue: list, reorder, remove
      await new Promise((r) => setTimeout(r, 400));
      const a = await device.sendPackage(m, ex.buildPackage({ ...job, name: 'A' }, m, null, est));
      const b = await device.sendPackage(m, ex.buildPackage({ ...job, name: 'B' }, m, null, est));
      let q = (await device.jobs(m)).filter((j) => j.status === 'queued').map((j) => j.name).join(',');
      ok(q === 'A,B', 'queue lists waiting jobs in order (' + q + ')');
      await device.orderJobs(m, [b.id, a.id]);
      q = (await device.jobs(m)).filter((j) => j.status === 'queued').map((j) => j.name).join(',');
      ok(q === 'B,A', 'queue reorder (' + q + ')');
      await device.removeJob(m, a.id);
      q = (await device.jobs(m)).filter((j) => j.status === 'queued').map((j) => j.name).join(',');
      ok(q === 'B', 'queue remove (' + q + ')');
      // material settings kept on the machine: empty at first, then whatever was put, unchanged
      const none = await device.materials(m);
      ok(none && Array.isArray(none.materials) && none.materials.length === 0, 'machine starts with no materials');
      const doc = { format: 'pathline-materials', version: 1, machine: { id: m.id }, materials: [{ id: 'mat-1', name: 'Acrylic ×3 · 3 mm', t: 3, updatedAt: '2026-11-04T10:00:00.000Z', processes: [{ name: 'Cut', proc: 'Cut', power: 90, speed: 20, extra: { kept: true } }] }] };
      await device.putMaterials(m, doc);
      const back = await device.materials(m);
      ok(JSON.stringify(back.materials) === JSON.stringify(doc.materials), 'materials come back from the machine unchanged');
      let bad = null;
      try { await device.putMaterials(m, { materials: 'no' }); } catch (e) { bad = e; }
      ok(bad && bad.status === 400, 'machine refuses something that is not a materials list (' + (bad && bad.message) + ')');
      let err = null;
      try { await device.test({ ...m, port: port + 1, timeout: 500 }); } catch (e) { err = e; }
      ok(err && err.offline, 'offline machine reported as offline (' + (err && err.message) + ')');
      // finding machines without an IP address (discover.js)
      const hosts = discover.scanHosts({ eth: [{ family: 'IPv4', address: '192.168.1.40', netmask: '255.255.255.0', internal: false }], lo: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }], big: [{ family: 'IPv4', address: '10.20.30.40', netmask: '255.255.0.0', internal: false }] });
      ok(hosts.length === 508 && hosts.includes('192.168.1.1') && hosts.includes('192.168.1.254') && hosts.includes('10.20.30.1') && !hosts.includes('10.20.31.1') && !hosts.some((h) => h.startsWith('127.')), 'scan asks each local /24, never more (' + hosts.length + ' addresses)');
      const scanned = await discover.scan({ hosts: ['127.0.0.1'], port, timeout: 800 });
      const nobody = await discover.scan({ hosts: ['127.0.0.1'], port: port + 1, timeout: 500 });
      ok(nobody.length === 0, 'nothing listed where no machine answers');
      ok(scanned.length === 1 && scanned[0].ip === '127.0.0.1' && scanned[0].type === 'laser' && scanned[0].id === 'emu-' + port, 'network scan finds the machine, with its type and id (' + JSON.stringify(scanned.map((x) => x.name + ' ' + x.ip)) + ')');
      // a machine that announces itself (as Pathline Run does): answers straight back to the question
      const dgram = require('dgram');
      const responder = dgram.createSocket('udp4');
      let asked = null;
      responder.on('message', (msg, rinfo) => {
        const q = discover._packet.decode(msg);
        asked = q;
        if (q && !q.response) responder.send(discover._packet.encodeAnswer({ instance: 'Trotec Q500', host: 'q500.local', ip: '192.168.1.63', port: 8470, txt: { id: 'run-7f3a', name: 'Trotec Q500', type: 'laser', ctrl: 'Trotec', protocol: 1 } }, msg.readUInt16BE(0)), rinfo.port, rinfo.address);
      });
      await new Promise((r) => responder.bind(0, '127.0.0.1', r));
      try {
        const heard = await discover.browse({ to: { address: '127.0.0.1', port: responder.address().port }, timeout: 600 });
        ok(asked && !asked.response, 'asks the network for Pathline machines');
        ok(heard.length === 1 && heard[0].ip === '192.168.1.63' && heard[0].port === 8470 && heard[0].id === 'run-7f3a' && heard[0].name === 'Trotec Q500' && heard[0].type === 'laser', 'hears a machine that announces itself (' + JSON.stringify(heard) + ')');
        const moved = await discover.relocate([{ id: 'm1', deviceId: 'run-7f3a', conn: 'Ethernet', ip: '192.168.1.20', port: 8470 }, { id: 'm2', deviceId: 'other', conn: 'Ethernet', ip: '192.168.1.21' }, { id: 'm3', conn: 'Ethernet', ip: '192.168.1.22' }], { to: { address: '127.0.0.1', port: responder.address().port }, timeout: 600 });
        ok(moved.length === 1 && moved[0].id === 'm1' && moved[0].ip === '192.168.1.63', 'a saved machine whose IP changed is found at its new address (' + JSON.stringify(moved) + ')');
      } finally {
        responder.close();
      }
      const both = discover.merge([{ ip: '10.0.0.5', port: 8470, id: 'a', name: 'Laser', via: ['scan'] }, { ip: '10.0.0.5', port: 8470, id: 'a', name: '', type: 'laser', via: ['announce'] }, { ip: '10.0.0.6', port: 8470, id: null, name: 'Old Run', via: ['scan'] }]);
      ok(both.length === 2 && both.find((x) => x.id === 'a').via.length === 2 && both.find((x) => x.id === 'a').type === 'laser', 'the same machine found both ways is listed once');
    } finally {
      emu.kill();
    }
    ok(device.safeName('TRO-Selftest: 1/2') === 'TRO-Selftest- 1-2', 'saved job folders get a Windows-safe name');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? '\n' + failed + ' check(s) failed' : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

#!/usr/bin/env node
// Self-test: protocol encoders against known bytes (TROTEC_PROTOCOL.md captures,
// Ruida wiki examples), conversion of the example jobs, and the HTTP protocol
// against a simulated machine (with Pathline's own check-hmi.js when available).
//   node tools/selftest.js
'use strict';

// the fake Ruida answers whatever port asked; the real 40200 may be held by Pathline Run itself
process.env.PATHLINE_RUN_RUIDA_PORT_IN = process.env.PATHLINE_RUN_RUIDA_PORT_IN || '41200';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const sf = require('../src/ctrl/trotec/sf');
const rd = require('../src/ctrl/ruida/rd');
const plan = require('../src/job/plan');
const config = require('../src/config');
const validate = require('../src/job/validate');
const trotec = require('../src/ctrl/trotec/compile');
const ruida = require('../src/ctrl/ruida/compile');

let failed = 0;
const ok = (cond, msg, detail) => {
  console.log((cond ? '  ok    ' : '  FAIL  ') + msg + (!cond && detail !== undefined ? '\n          ' + detail : ''));
  if (!cond) failed++;
};
const hex = (b) => Buffer.from(b).toString('hex');
const FIX = path.join(__dirname, '..', 'test', 'fixtures');
const example = JSON.parse(fs.readFileSync(path.join(FIX, 'laser-print-and-cut.json'), 'utf8'));

console.log('Trotec SF packets');
ok(sf.crc16(Buffer.from('123456789')) === 0xbb3d, 'CRC-16/ARC check value 0xBB3D');
ok(hex(sf.packet(1, Buffer.from([0x10]))) === '53460100010000a30110cc01', 'GETSTATUS id 1 matches the worked example');
ok(hex(sf.packet(2, null, sf.TT.moveXY(10000, 5000))) === '5346020000000965d49e00002710000013882 42a'.replace(/ /g, ''), 'MOVEXY(10000, 5000) id 2 matches the worked example');
ok(hex(sf.packet(1, Buffer.from([0x10, 0x2c, 0xf2]))) === '534601000300006 3a0102cf2809c'.replace(/ /g, ''), 'GETSTATUS+GETXYPOSITION+GET_TEMPERATURE matches the live capture');
const rx = Buffer.from('53460180110000a629' + '1103ff0000' + '2d0000000000000000' + 'f30000' + 'bb3f', 'hex');
const got = sf.takePacket(Buffer.concat([Buffer.from('junk'), rx]));
const rep = got && sf.parseReply(got.packet);
ok(rep && rep.status.name === 'idle' && !rep.status.interlock && rep.xy[0] === 0 && rep.temperature === 0, 'reply from the live capture parses (idle, 0,0, safety OK)');
const lid = sf.parseReply({ imm: Buffer.from('1103f00000', 'hex'), data: Buffer.alloc(0) });
ok(lid.status.interlock === true, 'status 03 F0 reads as lid open');

console.log('Trotec job stream');
{
  // the 20 × 20 mm square Ruby cut at 45 % / 22 mm/s (capture 14:52, §4.4)
  const cfg = config.defaults('trotec');
  const x0 = 7196 * 0.010125 - 14.833125, y0 = 31372 * 0.010125 - 9.527625;
  const pkg = {
    format: 'lrc-job-package', version: 1, job: { name: 'square' }, machine: { type: 'laser' },
    processes: [{ index: 0, name: 'Cut', proc: 'Cut', power: 45, speed: 22, f: 5000, passes: 1, air: 'On', adv: { 'Power correction': 15, 'Path planning': 'Accuracy' } }],
    entities: [], toolpath: [{ type: 'cut', process: 0, closed: true, seconds: 4, p: [[x0, y0], [x0 + 20, y0], [x0 + 20, y0 + 20], [x0, y0 + 20]] }]
  };
  const prog = trotec.compile(plan.build(pkg), cfg);
  const cmds = sf.decodeData(prog.segments[0].data);
  const moves = cmds.filter((c) => c.name === 'MOVEXY').map((c) => c.v.join(','));
  ok(moves.join(' ') === '7196,31372 9171,31372 9171,33347 7196,33347 7196,31372', 'square positions match Ruby\'s MOVEXY values', moves.join(' '));
  const vel = cmds.filter((c) => c.name === 'SET_PARAMETER32' && c.v[0] === 218).map((c) => c.v[1]);
  ok(vel.includes(69136) && vel.includes(2173), 'travel 700 mm/s → 69136 and cut 22 mm/s → 2173 units/s', vel.join(', '));
  const lv = cmds.find((c) => c.name === 'DEFINEPOWERLEVELS');
  ok(lv && lv.v.join(',') === '0,0,45', 'power levels {0, 0, 45 %}');
  ok(cmds.some((c) => c.name === 'SET_PARAMETER16' && c.v[0] === 216 && c.v[1] === 1500), 'power correction 15 % → 1500');
  ok(cmds.some((c) => c.name === 'SET_NEW_PARAMETER64' && c.v[0] === 261 && c.v[1] === 100), 'Accuracy planner: tangential acceleration 100 while cutting');
  // the beam on once for the whole square (level 2 before its first side), no power change between
  // sides (off and on round each one made the Trotec stop at every segment), off after the last
  const iMoves = cmds.map((c, i) => (c.name === 'MOVEXY' ? i : -1)).filter((i) => i >= 0);
  const sides = iMoves.slice(1), lvl = (i) => cmds.slice(0, i).filter((c) => c.name === 'SELECTPOWERLEVEL').pop();
  const between = cmds.slice(sides[0], sides[sides.length - 1]).filter((c) => c.name === 'SELECTPOWERLEVEL').length;
  const after = cmds.slice(sides[sides.length - 1]).find((c) => c.name === 'SELECTPOWERLEVEL');
  ok(sides.length === 4 && lvl(sides[0]).v[0] === 2 && between === 0 && after && after.v[0] === 0, 'beam on (level 2) once for the 4 sides, off after the last', JSON.stringify({ sides: sides.length, between, after: after && after.v }));
}
{
  // curves go as ARCXY (Ruby's MoveBezier3AsArc), straight segments and corners stay MOVEXY
  const { fitArcs } = require('../src/ctrl/trotec/arcs');
  const ring = (cx, cy, r, n, a0 = 0, sweep = 2 * Math.PI) => Array.from({ length: n + 1 }, (_, k) => [cx + r * Math.cos(a0 + (sweep * k) / n), cy + r * Math.sin(a0 + (sweep * k) / n)]);
  const kinds = (m) => m.map((x) => (x.c ? 'A' : 'L')).join('');
  const circle = ring(200, 200, 10, 24);
  const fc = fitArcs(circle);
  ok(kinds(fc) === 'AA' && fc.every((a) => Math.abs(a.r - 10) < 1e-6 && Math.abs(Math.abs(a.sweep) - Math.PI) < 1e-6), '24-segment Ø20 circle → 2 arcs of 180°', kinds(fc));
  ok(kinds(fitArcs(ring(50, 50, 1, 24))) === 'AA', 'small hole (24 segments of 0.26 mm, 15° each) → arcs');
  // 40 × 30 rounded rectangle, 3 mm corners as 6 segments each, starting where the top edge begins
  const rr = [];
  const corner = (cx, cy, a0) => ring(cx, cy, 3, 6, a0, Math.PI / 2);
  rr.push(...corner(137, 103, Math.PI), ...corner(137 + 34, 103, -Math.PI / 2), ...corner(137 + 34, 103 + 24, 0), ...corner(137, 103 + 24, Math.PI / 2));
  rr.push(rr[0]);
  ok(kinds(fitArcs(rr)).replace(/^L/, '') === 'ALALALA' || kinds(fitArcs(rr)) === 'ALALALAL', 'rounded rectangle → 4 arcs + 4 lines', kinds(fitArcs(rr)));
  const zig = Array.from({ length: 40 }, (_, k) => [k, k % 2 ? 0.2 : 0]);
  ok(/^L+$/.test(kinds(fitArcs(zig))), 'zig-zag stays as straight segments');
  ok(/^L+$/.test(kinds(fitArcs(ring(300, 300, 20, 8)))) && /^L+$/.test(kinds(fitArcs(ring(300, 300, 20, 6)))), 'octagon and hexagon keep their corners');
  ok(/^L+$/.test(kinds(fitArcs(ring(300, 300, 50, 18)))), '18-gon (20° corners) stays a polygon');
  ok(/^L+$/.test(kinds(fitArcs([[0, 0], [10, 0], [20, 0], [30, 0], [40, 0]]))), 'a straight line split in 4 stays straight');

  // compiled: curves go as CUBIC_BEZIER_ABSOLUTE (E0) in 45° pieces, as Ruby sends them on the
  // Q500 (vision capture 2026-10-28); each must end on the shape and bulge onto its circle
  const cfg = config.defaults('trotec');
  const U = trotec.units(trotec.settings(cfg));
  const pkgOf = (pts, closed) => ({
    format: 'lrc-job-package', version: 1, job: { name: 'arcs' }, machine: { type: 'laser' },
    processes: [{ index: 0, name: 'Cut', proc: 'Cut', power: 45, speed: 22, f: 5000, passes: 1, air: 'On', adv: {} }],
    entities: [], toolpath: [{ type: 'cut', process: 0, closed, seconds: 4, p: pts }]
  });
  const run = (pts, closed) => sf.decodeData(trotec.compile(plan.build(pkgOf(pts, closed)), cfg).segments[0].data);
  // the largest distance from the circle (cx, cy, r in mm) over each Bézier, from where the head is
  const offCircle = (cmds, cx, cy, r) => {
    let at = null, worst = 0, n = 0;
    for (const c of cmds) {
      if (c.name === 'MOVEXY') at = c.v.slice();
      else if (c.name === 'CUBIC_BEZIER_ABS') {
        const v = c.v;
        for (let t = 0.1; t < 1; t += 0.1) {
          const u = 1 - t, b = (i) => u * u * u * at[i] + 3 * u * u * t * v[i] + 3 * u * t * t * v[2 + i] + t * t * t * v[4 + i];
          const mm = U.toMm(b(0), b(1));
          worst = Math.max(worst, Math.abs(Math.hypot(mm[0] - cx, mm[1] - cy) - r));
        }
        at = [v[4], v[5]]; n++;
      }
    }
    return { worst, n, at };
  };
  const ca = run(circle.slice(0, 24), true);
  const cb = offCircle(ca, 200, 200, 10);
  ok(cb.n === 8 && cb.worst < 0.012 && Math.hypot(...U.toMm(cb.at[0], cb.at[1]).map((v, i) => v - [210, 200][i])) < 0.001, 'Ø20 circle: 8 Béziers of 45°, on the circle, back to its start', cb.n + ' pieces, ' + (cb.worst * 1000).toFixed(1) + ' µm off');
  ok(!ca.some((c) => c.name === 'ARCXY'), 'no ARCXY sent (its direction is unconfirmed; Ruby sends Béziers on the Q500)');
  // a quarter arc from (100, 100) about (100, 110) to (110, 110): 2 pieces bulging the right way
  const q = run(ring(100, 110, 10, 12, -Math.PI / 2, Math.PI / 2), false);
  const qb = offCircle(q, 100, 110, 10);
  // (measured from the start MOVEXY, which is in whole position units: up to 14 µm off)
  ok(qb.n === 2 && qb.worst < 0.015 && Math.hypot(...U.toMm(qb.at[0], qb.at[1]).map((v, i) => v - [110, 110][i])) < 0.001, 'quarter arc: 2 Béziers ending at (110, 110), on the circle', qb.n + ' pieces, ' + (qb.worst * 1000).toFixed(1) + ' µm');
  // a 500 mm radius (Prepare: 1.4° segments), 90° of it: 45° pieces stay on the circle
  const big = offCircle(run(ring(600, 600, 500, 64, 0, Math.PI / 2), false), 600, 600, 500);
  ok(big.n === 2 && big.worst < 0.015, 'R500 quarter as 2 Béziers on the circle', big.n + ' pieces, ' + (big.worst * 1000).toFixed(1) + ' µm');
  const rc = run(rr.slice(0, -1), true);
  const names = rc.slice(rc.findIndex((c) => c.name === 'SELECTPOWERLEVEL' && c.v[0] === 2)).filter((c) => c.name === 'MOVEXY' || c.name === 'CUBIC_BEZIER_ABS').map((c) => (c.name === 'MOVEXY' ? 'L' : 'B')).join('');
  ok(/^L?(B{2}L){3}B{2}L?$/.test(names), 'rounded rectangle compiles to its straight sides + 2 Béziers per corner', names);
  const lvls = rc.filter((c) => c.name === 'SELECTPOWERLEVEL').map((c) => c.v[0]).join('');
  ok(/^0+20+$/.test(lvls), 'beam on once through lines and arcs', lvls);
  // one COMMIT per run, at least every 200 moves (Ruby commits per cut item)
  const long = run(Array.from({ length: 1001 }, (_, k) => [10 + k * 0.5, 10 + (k % 2) * 0.5]), false);
  const from = long.findIndex((c) => c.name === 'SELECTPOWERLEVEL' && c.v[0] === 2);
  const to = long.findIndex((c, i) => i > from && c.name === 'SELECTPOWERLEVEL');
  const commits = long.slice(from, to).filter((c) => c.name === 'COMMIT').length;
  ok(commits === 5, '1000-segment cut: a COMMIT every 200 moves, not after each', commits);
  const short = run(rr.slice(0, -1), true);
  const s2 = short.findIndex((c) => c.name === 'SELECTPOWERLEVEL' && c.v[0] === 2);
  const sc = short.slice(s2, short.findIndex((c, i) => i > s2 && c.name === 'SELECTPOWERLEVEL'));
  ok(sc.filter((c) => c.name === 'COMMIT').length === 1 && sc[sc.length - 1].name === 'COMMIT', 'a short cut: one COMMIT, after its last move', sc.map((c) => c.name).join(' '));
  const off = sf.decodeData(trotec.compile(plan.build(pkgOf(circle.slice(0, 24), true)), { ...cfg, trotec: { ...(cfg.trotec || {}), arcs: false } }).segments[0].data);
  ok(!off.some((c) => c.name === 'ARCXY') && off.filter((c) => c.name === 'MOVEXY').length === 25, 'trotec.arcs: false sends segments only');
}
{
  // engrave: 20 × 20 mm box at 500 DPI (capture §4.7: 417 lines, 10 mm run-up, 1975 units on)
  const cfg = config.defaults('trotec');
  const box = [100, 100, 120, 120];
  const pkg = {
    format: 'lrc-job-package', version: 1, job: { name: 'box' }, machine: { type: 'laser' },
    processes: [{ index: 0, name: 'Engrave', proc: 'Engrave', power: 45, speed: 400, f: 500, passes: 1, air: 'Off' }],
    entities: [{ id: 'b', paths: [{ p: [[100, 100], [120, 100], [120, 120], [100, 120]], c: true }] }],
    toolpath: [{ type: 'engrave', process: 0, ents: ['b'], box, dpi: 500, direction: 'up', bidirectional: true, seconds: 30 }]
  };
  const cmds = sf.decodeData(trotec.compile(plan.build(pkg), cfg).segments[0].data);
  const tables = cmds.filter((c) => c.name === 'SWITCHPOINTTABLE_BW');
  ok(Math.abs(tables.length - 417) <= 1, '≈417 scan lines (0.048 mm pitch)', tables.length);
  const t = tables[Math.floor(tables.length / 2)].v;
  ok(t.length === 2 && Math.abs(t[0] - 988) <= 2 && Math.abs(t[1] - 1975) <= 2, 'line = ~988 off, 1975 on (20 mm)', t.join(', '));
  const lens = cmds.filter((c) => c.name === 'MOVEX_PLUS' || c.name === 'MOVEX_MINUS');
  ok(lens.length === tables.length && lens.every((c) => Math.abs(c.v[0] - 3951) <= 2), 'line length 3951 units (box + 10 mm each side)', lens[0] && lens[0].v[0]);
  ok(lens[0].name === 'MOVEX_PLUS' && lens[1].name === 'MOVEX_MINUS', 'bidirectional lines alternate');
  const ys = cmds.filter((c) => c.name === 'MOVEXY').map((c) => c.v[1]);
  ok(ys[0] > ys[ys.length - 1], 'direction "up" starts at the front (largest Y)');
}
{
  // travel between cuts: the planner's S-curve (motion.js), the profiles, and Run's own estimate
  const motion = require('../src/ctrl/trotec/motion');
  const t7 = motion.moveTime(7, 700, 500, 5000);
  ok(Math.abs(t7 - 0.355) < 0.01, 'a 7 mm hop at Standard (500 mm/s², jerk 5000) takes ≈ 0.35 s', t7.toFixed(3));
  ok(Math.abs(motion.moveTime(7, 2000, 500, 5000) - t7) < 1e-9, 'the travel speed doesn\'t change a short hop');
  ok(Math.abs(motion.moveTime(2000, 700, 500, 5000) - (2000 / 700 + 700 / 500 + 500 / 5000)) < 1e-6, 'a long move: cruise at 700 mm/s plus the two ramps (1050 mm of them)');
  const cfg = config.defaults('trotec');
  // 50 small squares 5 mm apart, 22 mm/s, Pathline's 4 s each for the cutting
  const sq = (x, y) => [[x, y], [x + 3, y], [x + 3, y + 3], [x, y + 3]];
  const pkg = {
    format: 'lrc-job-package', version: 1, job: { name: 'squares' }, machine: { type: 'laser' },
    processes: [{ index: 0, name: 'Cut', proc: 'Cut', power: 45, speed: 22, f: 5000, passes: 1, air: 'On', adv: {} }],
    entities: [], toolpath: Array.from({ length: 50 }, (_, k) => ({ type: 'cut', process: 0, closed: true, seconds: 4, p: sq(100 + (k % 10) * 8, 100 + Math.floor(k / 10) * 8) }))
  };
  const std = trotec.compile(plan.build(pkg), cfg);
  const jerks = (p) => sf.decodeData(p.segments[0].data).filter((c) => c.name === 'SET_NEW_PARAMETER64' && c.v[0] === 262).map((c) => c.v[1]);
  // (Pathline's 4 s per square is ignored: on the X8 sheet its cutting time ran ~15 % long)
  const cutS = (50 * 12) / 22;
  ok(std.estimated && std.seconds > cutS + 50 * 0.3 && std.seconds < cutS + 50 * 0.6, 'estimate: each cut at its set speed plus each hop as the planner moves it', std.seconds.toFixed(1) + ' s');
  {
    // the cut's own time: the set speed on a long straight, far slower round a small circle at
    // 400 mm/s (J0053's small shapes took 1.78 × length ÷ speed)
    const prof = trotec.cutProfile(trotec.PLANNER.Standard);
    const line = trotec.runTime([0, 0], [{ to: [500, 0] }], 30, prof);
    const circ = trotec.runTime([5, 0], [{ c: [0, 0], r: 5, sweep: 2 * Math.PI, to: [5, 0] }], 400, prof);
    const sqr = trotec.runTime([0, 0], [{ to: [10, 0] }, { to: [10, 10] }, { to: [0, 10] }, { to: [0, 0] }], 400, prof);
    ok(Math.abs(line - 500 / 30) < 0.05, 'cut time: a 500 mm straight at 30 mm/s takes 500 ÷ 30 s', line.toFixed(3));
    ok(circ > (2 * Math.PI * 5) / 400 * 2 && circ < 1, 'cut time: a 10 mm circle at 400 mm/s is held to the curve\'s speed', circ.toFixed(3) + ' s');
    ok(sqr > 40 / 400 * 2 && sqr < 1, 'cut time: a 10 mm square at 400 mm/s slows at each corner', sqr.toFixed(3) + ' s');
  }
  ok(jerks(std).every((j) => j === 5000), 'Standard travel: Ruby\'s planner values only (jerk 5000)', jerks(std).join(','));
  const fast = trotec.compile(plan.build(pkg), { ...cfg, trotec: { ...cfg.trotec, travel: 'fastest' } });
  const fj = jerks(fast);
  ok(fj.includes(20000) && fj[fj.length - 1] === 5000 && fj.filter((j) => j === 20000).length === 50, 'Fastest: jerk 20000 for each travel, back to 5000 before cutting', fj.slice(0, 4).join(','));
  ok(fast.seconds < std.seconds - 5, 'Fastest travel is estimated quicker', fast.seconds.toFixed(1) + ' vs ' + std.seconds.toFixed(1));
  const mv = config.machineView({ ...cfg, configured: true });
  ok(mv.travelSpeed === 700 && mv.acc > 150 && mv.acc < 400, 'Pathline is told the travel as it really is (700 mm/s, ≈ 260 mm/s² over a short move)', mv.travelSpeed + ' mm/s, ' + mv.acc + ' mm/s²');
  ok(mv.travelAcc === 500 && mv.jerk === 5000, 'and the real travel acceleration and jerk, for Prepare 1.6.0 on (500 mm/s², 5000 mm/s³)', mv.travelAcc + ', ' + mv.jerk);
  const mvF = config.machineView({ ...cfg, configured: true, trotec: { ...cfg.trotec, travel: 'fastest' } });
  ok(mvF.travelSpeed === 1000 && mvF.travelAcc === 1000 && mvF.jerk === 20000, 'Fastest travel: Prepare is told 1000 mm/s, 1000 mm/s², 20000 mm/s³', mvF.travelSpeed + ', ' + mvF.travelAcc + ', ' + mvF.jerk);
  ok(mv.markArea === undefined, 'camera off: no markArea');
  const mvC = config.machineView({ ...cfg, configured: true, bed: [1300, 900], vision: { enabled: true, offset: [-41.735, -12.9854] } });
  ok(JSON.stringify(mvC.markArea) === '[26.9,3.5,1300,900]', 'camera on: Pathline is told where marks can be read (the Q500: 26.9 mm from the left, 3.5 from the back)', JSON.stringify(mvC.markArea));
}

console.log('Ruida encoding');
ok(rd.swizzleByte(0xcc, 0x88) === 0xc6, 'ACK 0xCC swizzles to 0xC6 with magic 0x88');
ok([...Array(256).keys()].every((b) => rd.unswizzleByte(rd.swizzleByte(b, 0x88), 0x88) === b), 'swizzle round-trips every byte');
ok(hex(rd.RD.partSpeed(0, 100)) === 'c904000000060d20', 'speed 100 mm/s matches the wiki example');
ok(hex(rd.RD.moveAbs(281424, 2*128*128 + 0x12*128 + 0x56)) === '8800001116500000021256', 'MOVE_ABS bytes match the wiki example');
ok(Math.abs(rd.dec([0x18, 0x28]) * 100 / 16383 - 19) < 0.1, 'power bytes 18 28 decode to 19 %');
ok(rd.dec(rd.enc(-1234, 2), true) === -1234, 'signed 14-bit relative values round-trip');

console.log('Example job: ' + example.job.name);
{
  const cfgT = { ...config.defaults('trotec'), regMarks: 'ignore' };
  const cfgR = { ...config.defaults('ruida'), bed: [900, 600], regMarks: 'ignore' };
  ok(validate.check(example, cfgT).length === 1, 'validates (with a registration-mark warning)');
  const p = plan.build(example);
  ok(p.steps.length === example.toolpath.length, 'plan has one step per toolpath step');
  const dash = p.steps.find((s) => s.op === 'cut' && s.proc.dash);
  const on = dash.runs.reduce((a, r) => a + Math.hypot(r[r.length - 1][0] - r[0][0], r[r.length - 1][1] - r[0][1]), 0);
  ok(dash.runs.length === 28 && Math.abs(on - 112) < 0.5, 'tear-off line: 140 mm as 28 links of 4 mm (1 mm gaps)', dash.runs.length + ' runs, ' + on.toFixed(1) + ' mm');
  const lab = p.steps.find((s) => s.op === 'engrave' && s.paths[0].ent === 'label');
  const mid = plan.scanLines(lab, 0.1).find((l) => Math.abs(l.y - 162) < 0.06);
  ok(mid && mid.spans.length === 2, 'label with a hole: middle scan line has 2 spans', mid && JSON.stringify(mid.spans));

  const tp = trotec.compile(p, cfgT);
  ok(tp.segments.filter((s) => s.kind === 'dwell').length === 2 && tp.segments.filter((s) => s.kind === 'stream').length === 3, 'Trotec: 3 streams split by the 2 dwells');
  const tx = trotec.exportFiles(p, cfgT);
  ok(tx.bin.length > 1000 && /SWITCHPOINTTABLE_BW/.test(tx.txt), 'Trotec export: ' + tx.bin.length + ' bytes + listing');

  const rp = ruida.compile(p, cfgR);
  ok(rp.segments.filter((s) => s.kind === 'stream').length === 3, 'Ruida: 3 streams split by the 2 dwells');
  const rx2 = ruida.exportFiles(p, cfgR);
  const raw = rd.unswizzle(rx2.bin, 0x88);
  const cmds = rd.commands(raw);
  ok(raw[raw.length - 1] === 0xd7, 'Ruida file ends with EOF (D7)');
  const sumCmd = cmds.find((c) => c[0] === 0xe5 && c[1] === 0x05);
  const sumAt = raw.indexOf(sumCmd);
  const expect = raw.subarray(0, sumAt).reduce((a, b) => a + b, 0) + 0xd7;
  ok(sumCmd && rd.dec(sumCmd.subarray(2)) === expect, 'file sum (E5 05) matches');
  const cuts = cmds.filter((c) => c[0] === 0xa8).map((c) => [rd.dec(c.subarray(1, 6)) / 1000, rd.dec(c.subarray(6, 11)) / 1000]);
  ok(cuts.length > 50 && cuts.every(([x, y]) => x >= 0 && x <= 900 && y >= 0 && y <= 600), cuts.length + ' CUT_ABS, all inside the bed');
  // origin top right: bed x 60 (outline left edge) → controller x 840
  const ox = Math.max(...cuts.map((c) => c[0]));
  ok(Math.abs(ox - 840) < 0.01, 'origin top right mirrors X (bed 60 mm → 840 mm)', ox);
  const scans = cmds.filter((c) => c[0] === 0xaa).length;
  ok(scans > 500, 'engraving as horizontal scan runs (' + scans + ' CUT_REL_X)');
  ok(rx2.notes.length === 2, 'notes say dwells and marks are left out of the file');
}

console.log('Anchor to toolhead');
{
  const anchor = require('../src/job/anchor');
  const plain = { ...example, toolpath: example.toolpath.filter((s) => s.type !== 'inspect') };
  const b0 = anchor.box(plain);
  const moved = anchor.apply(plain, { x: 300, y: 150 });
  const b1 = anchor.box(moved);
  ok(Math.abs(b1[0] - 300) < 1e-6 && Math.abs(b1[1] - 150) < 1e-6, 'job\'s top-left corner moves to the head (300, 150)', b1.join(', '));
  ok(Math.abs((b1[2] - b1[0]) - (b0[2] - b0[0])) < 1e-6, 'size unchanged');
  const dx = 300 - b0[0];
  ok(Math.abs(moved.entities[0].paths[0].p[0][0] - (example.entities[0].paths[0].p[0][0] + dx)) < 1e-3, 'shapes move with it (preview)');
  ok(anchor.box(plain)[0] === b0[0], 'the original package is untouched');
  // print and cut: the top-left registration mark goes to the head (the operator puts the head on
  // it), not the corner of everything, which the cuts can reach past (14 and 17 mm on the X8 sheet)
  const pc = JSON.parse(JSON.stringify(example));
  pc.toolpath.push({ type: 'cut', process: pc.toolpath.find((s) => s.type === 'cut').process, p: [[2, 3], [5, 3]] });
  const tlMark = pc.toolpath.filter((s) => s.type === 'inspect').map((s) => s.at).sort((u, v) => u[0] + u[1] - v[0] - v[1])[0];
  const pcMoved = anchor.apply(pc, { x: 300, y: 150 });
  const tlAfter = pcMoved.toolpath.filter((s) => s.type === 'inspect').map((s) => s.at).sort((u, v) => u[0] + u[1] - v[0] - v[1])[0];
  ok(Math.abs(tlAfter[0] - 300) < 1e-3 && Math.abs(tlAfter[1] - 150) < 1e-3 && anchor.box(pc)[0] < tlMark[0], 'print and cut: the top-left mark goes to the head, with cuts further out than the marks', tlAfter.join(', '));
  let e3 = null; try { anchor.check(example, { x: 700, y: 400 }, [813, 508]); } catch (e) { e3 = e; }
  ok(e3 && e3.code === 409 && /leave the bed/.test(e3.message), 'anchoring where the job would leave the bed is refused', e3 && e3.message);
  // the switch as a job arrives: on for print and cut, off otherwise; back to that after each run
  const Store = require('../src/store');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-anchor-'));
  const st = new Store(tmp);
  const withMarks = { ...example, toolpath: [{ type: 'inspect', mark: 1, of: 3, at: [13, 13], d: 6 }].concat(example.toolpath.filter((s) => s.type !== 'inspect')) };
  const noMarks = { ...example, toolpath: example.toolpath.filter((s) => s.type !== 'inspect') };
  const a = st.add(withMarks, [], 'pathline'), n = st.add(noMarks, [], 'pathline');
  ok(a.anchorAtStart === true && n.anchorAtStart === false, 'Anchor to toolhead starts on for a print and cut job, off for one without marks', a.anchorAtStart + ' / ' + n.anchorAtStart);
  st.setAnchor(a.id, null, false); st.setAnchor(n.id, null, true);
  st.finish(st.get(a.id), 'Completed', new Date().toISOString(), false);
  st.finish(st.get(n.id), 'Completed', new Date().toISOString(), false);
  ok(st.get(a.id).anchorAtStart === true && st.get(n.id).anchorAtStart === false, 'after a run, the switch is back to the job\'s own default (whatever it was set to for that run)');
  const r1 = st.requeue(a.id, false);
  ok(r1.anchorAtStart === true && !r1.anchor, 'run again from History: print and cut starts anchored again, at the head when Start is pressed');
  const st2 = new Store(tmp);
  ok(st2.get(n.id).anchorAtStart === false && st2.get(a.id).anchorAtStart === true, 'restarting the app keeps the defaults');
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('Network address commands (not run)');
{
  const net = require('../src/network');
  const w = net.commands({ adapter: 'Ethernet 2', mode: 'static', ip: '10.42.1.2', mask: '255.255.255.0', gateway: '' }, 'win32')[0];
  ok(w[0] === 'netsh' && w[1].join(' ') === 'interface ipv4 set address name=Ethernet 2 source=static address=10.42.1.2 mask=255.255.255.0 gateway=none', 'Windows static: netsh set address', w[1].join(' '));
  const l = net.commands({ adapter: 'eth0', connection: 'Wired connection 1', mode: 'dhcp' }, 'linux');
  ok(l[0][1].join(' ') === 'connection modify Wired connection 1 ipv4.method auto ipv4.addresses  ipv4.gateway ' && l[1][1][1] === 'up', 'Pi DHCP: nmcli modify + up');
  ok(net.maskToPrefix('255.255.255.0') === 24 && net.prefixToMask(20) === '255.255.240.0' && !net.validMask('255.0.255.0'), 'subnet masks');
  let e4 = null; try { net.commands({ adapter: 'x', mode: 'static', ip: '192.168.1.300', mask: '255.255.255.0' }); } catch (e) { e4 = e; }
  ok(e4 && e4.code === 400, 'a bad IP address is refused');
}

console.log('Ruida plotter');
{
  const plotterPkg = JSON.parse(fs.readFileSync(path.join(FIX, 'plotter-two-beds.json'), 'utf8'));
  const cfgP = { ...config.defaults('ruida'), configured: true, name: 'Plotter', type: 'plotter', bed: [1600, 1000], feedLen: 1000,
    f: { ...config.defaults('ruida').f, conveyor: true }, ruida: { model: 'RD-PLOTTER', magic: 0x88, origin: 'tl' } };
  ok(validate.check(plotterPkg, cfgP).length === 0, 'plotter job accepted by a Ruida plotter');
  let eL = null; try { validate.check(example, cfgP); } catch (e) { eL = e; }
  ok(eL && /laser job/.test(eL.message), 'laser job refused by a plotter', eL && eL.message);
  const prog = ruida.compile(plan.build(plotterPkg), cfgP, { uStart: 250 });
  const cmds = rd.commands(prog.segments[0].data).map(rd.describe);
  ok(cmds.filter((c) => /^MOVE_U/.test(c)).join() === 'MOVE_U 1250.000 mm', 'conveyor feed between beds: U axis from 250 to 1250 mm', cmds.filter((c) => /^MOVE_U/.test(c)).join());
  // first process is the V-cut on T2: output 2 at 100 %, the others at 0 %
  const maxes = cmds.filter((c) => /^MAX_POWER_[1-4] /.test(c)).slice(0, 4).map((c) => c.split(' ')[1]);
  ok(maxes.join(',') === '0.0,100.0,0.0,0.0', 'tool T2 lowers output 2 only', maxes.join(','));
  ok(cmds.some((c) => /^LASER_ON_DELAY/.test(c)), 'tool down/up times in the on/off delays');
}

console.log('RDD6584 knife job (compared with VCutWorks, recorded on a YC-1610)');
{
  const knife = require('../src/ctrl/ruida/knife');
  // the 113.791 × 75.861 mm rectangle VCutWorks cut at 60 mm/s, then fed 500 mm
  const pts = [[62.088, 74.263], [62.088, 150.124], [175.879, 150.124], [175.879, 74.263], [62.088, 74.263]];
  const planK = { name: 'square', warnings: [], seconds: 10, steps: [{ op: 'cut', i: 0, proc: { speed: 60, slot: 'T1' }, runs: [pts], seconds: 9 }, { op: 'feed', i: 1, seconds: 1 }] };
  const progK = knife.compile(planK, { feedLen: 500, timing: {} }, { card: 0x6910 });
  ok(progK.segments.length === 1 && progK.segments[0].kind === 'file', 'one bed → one file to upload and start');
  const h = progK.segments[0].data.toString('hex');
  const recorded = 'ca0000ca0200c9020000035460' +
    '80000003650800000444170000053f10e73a01e73500005231740000631d09ca080000053f10a00000036508000009146c0000053f10ca090000000000' +
    '800000036508000009146c0000000000e73a01e735000052317400005e4c34ca080000000000a000000a5e07000009146c0000000000ca090000000000' +
    '8000000a5e07000009146c0000103d30e73a01e73500005231740000631d09ca080000103d30a000000a5e0700000444170000103d30ca090000000000' +
    '8000000a5e07000004441700000a7e20e73a01e73500005702490000631d09ca0800000a7e20a00000036508000004441700000a7e20ca090000000000' +
    'e7180000000001ebe700da010620000000027b000000027bd7';
  ok(h.endsWith(recorded), 'cuts, knife angles (90°, 0°, 270°, 180°), Y bands and cut length (379 mm) match VCutWorks byte for byte', h.slice(h.indexOf('ca0000ca02')));
  ok(h.includes('e706000000000200001e4220') && h.startsWith('d81000000a5e07000009146c040ce601ca306910f10200d800'), 'feed 500 mm after the job; header as VCutWorks writes it');
  // the pen square VCutWorks drew: one continuous path, no knife plunges, tool code 11
  const penPts = [[53.163, 214.829], [53.163, 960.05], [166.954, 960.05], [166.954, 214.829], [53.163, 214.829]];
  const penFile = knife.bedFile([{ tool: 'pen', speed: 60, runs: [penPts] }], { feed: 500 }).toString('hex');
  const penRec = 'ca0011ca0200c9020000035460800000031f2b00000d0e2d0000053f10ca080000053f10a00000031f2b00003a4c320000053f10' +
    'a000000a182a00003a4c320000000000a000000a182a00000d0e2d0000103d30a00000031f2b00000d0e2d00000a7e20ca090000000000e7180000000001';
  ok(penFile.includes(penRec) && penFile.includes('ca410011') && penFile.includes('f30a000000000000f309000000000001'), 'pen: drawn in one go with tool code 11, as VCutWorks did', penFile);
  // pen + knife + punch in one job: a layer each, in order, tool change marked on layers 2 and 3
  const planT = { name: 'tools', warnings: [], seconds: 3, steps: [
    { op: 'cut', i: 0, proc: { index: 0, speed: 60, tool: 'T3 · Pen' }, runs: [[[10, 10], [60, 10]]], seconds: 1 },
    { op: 'cut', i: 1, proc: { index: 1, speed: 60, tool: 'T1 · Knife' }, runs: [[[10, 20], [60, 20]]], seconds: 1 },
    { op: 'cut', i: 2, proc: { index: 2, speed: 60, tool: 'T2 · Punch' }, runs: [[[10, 30], [30, 30]]], seconds: 1 }] };
  const ht = knife.compile(planT, { bed: [1000, 1600], timing: {} }).segments[0].data;
  const cmds = rd.commands(ht).map((c) => Buffer.from(c).toString('hex'));
  const layerStarts = cmds.filter((h) => /^ca00/.test(h)).join();
  const punches = cmds.filter((h) => h === 'ca0a0000002708').length;
  ok(layerStarts === 'ca0011,ca0040,ca0060' && cmds.filter((h) => /^e718/.test(h)).slice(1).join() === 'e7180000000001,e7180000000002,e7180000000003' &&
    cmds.includes('f30a000000000001') && cmds.includes('f309000000000003') && punches === 5,
  'pen, knife and punch: three layers (11, 40, 60 as VCutWorks marks them), knife flagged, 3 layers counted, a 20 mm punch line = 5 holes 5 mm apart', layerStarts + ' · ' + punches + ' holes');
  // origin top right (YC-1610): a cut near the right of the bed has a small machine X, and a
  // cut running right in Pathline runs towards smaller X (knife at 180°)
  const planR = { name: 'right', warnings: [], seconds: 1, steps: [{ op: 'cut', i: 0, proc: { speed: 60 }, runs: [[[900, 50], [950, 50]]], seconds: 1 }] };
  const hr = knife.compile(planR, { bed: [1000, 1600], ruida: { origin: 'tr' }, timing: {} }).segments[0].data;
  const mv = rd.commands(hr).filter((c) => c[0] === 0x80 || c[0] === 0xa0).map((c) => [rd.dec(c.subarray(1, 6)) / 1000, rd.dec(c.subarray(6, 11)) / 1000, rd.dec(c.subarray(11, 16)) / 1000]);
  ok(JSON.stringify(mv) === '[[100,50,180],[50,50,180]]', 'origin top right: Pathline X 900 → 950 cuts at machine X 100 → 50, knife at 180°', JSON.stringify(mv));
  // jobs run relative to home, by the controller itself: J0005's square (bed X 850–950,
  // Y 50–150) goes in as X 50–150, Y 50–150 from home (taking home off again gave "frame slop")
  const planO = { name: 'sq', warnings: [], seconds: 1, steps: [{ op: 'cut', i: 0, proc: { speed: 60 }, runs: [[[850, 50], [950, 50], [950, 150], [850, 150], [850, 50]]], seconds: 1 }] };
  const ho = knife.compile(planO, { bed: [1000, 1600], ruida: { origin: 'tr' }, timing: {} }).segments[0].data;
  const xy = rd.commands(ho).filter((c) => c[0] === 0xa0).map((c) => [rd.dec(c.subarray(1, 6), true) / 1000, rd.dec(c.subarray(6, 11), true) / 1000]);
  ok(JSON.stringify(xy) === '[[50,50],[50,150],[150,150],[150,50]]', 'top right of the bed → X 50–150, Y 50–150 from home, never past it', JSON.stringify(xy));
  // a Pathline job over two beds: two files, the first feeding the conveyor one bed
  const twoBeds = JSON.parse(fs.readFileSync(path.join(FIX, 'plotter-two-beds.json'), 'utf8'));
  const cfgK = { ...config.defaults('ruida'), configured: true, type: 'plotter', bed: [1600, 1000], feedLen: 1000, f: { ...config.defaults('ruida').f, conveyor: true }, ruida: { model: 'RDD6584G', magic: 0xa1, origin: 'tr' } };
  const prog2 = ruida.compile(plan.build(twoBeds), cfgK, { card: 0x6910 });
  const files = prog2.segments.filter((s) => s.kind === 'file');
  const feeds = files.map((s) => s.data.toString('hex').match(/e706([0-9a-f]{20})/)[1]);
  ok(files.length === 2 && feeds[0] === '0000000002' + Buffer.from(rd.abs(1000000)).toString('hex') && feeds[1] === '0'.repeat(20) && rd.commands(files[1].data).some((c) => c[0] === 0xa0),
    'two-bed job on an RDD6584: two files, a 1000 mm feed after the first, none after the last', feeds.join(' / '));
  const ff = knife.feedFile(300).toString('hex');
  ok(ff.includes('e7060000000002' + '0000122760') && !rd.commands(knife.feedFile(300)).some((c) => c[0] === 0x80 || c[0] === 0xa0), 'Conveyor: a job with no cuts and a 300 mm feed');
}

console.log('Refusals');
{
  const cfg = config.defaults('trotec');
  const plotter = JSON.parse(fs.readFileSync(path.join(FIX, 'plotter-two-beds.json'), 'utf8'));
  let e1 = null; try { validate.check(plotter, cfg); } catch (e) { e1 = e; }
  ok(e1 && e1.code === 400 && /plotter/.test(e1.message), 'plotter job refused with 400', e1 && e1.message);
  const big = JSON.parse(JSON.stringify(example));
  big.toolpath.find((s) => s.type === 'cut').p.push([5000, 10]);
  let e2 = null; try { validate.check(big, cfg); } catch (e) { e2 = e; }
  ok(e2 && /leaves the bed/.test(e2.message), 'path outside the bed refused', e2 && e2.message);
  // the drawing on a colour no process uses: Pathline sends an empty toolpath
  const empty = { ...JSON.parse(JSON.stringify(example)), toolpath: [], checks: [{ ok: false, l: 'No process for ACI 7' }] };
  let e3 = null; try { validate.check(empty, cfg); } catch (e) { e3 = e; }
  ok(e3 && e3.code === 400 && /Nothing to run.*No process for ACI 7/.test(e3.message), 'job with nothing to cut refused, with Pathline\'s reason', e3 && e3.message);
}

console.log('Jog (machine with a stand-in link)');
async function jogTests() {
  const Machine = require('../src/machine');
  const sent = [];
  let pos = { x: -450, y: 31 };
  const link = {
    moveTo: async (x, y) => { sent.push(['move', +x.toFixed(2), +y.toFixed(2)]); pos = { x, y }; },
    poll: async () => ({ state: 'idle', pos: { ...pos, z: 0 } }),
    stopMove: async () => { sent.push(['stop']); }
  };
  const cfgJ = { ...config.defaults('ruida'), configured: true, bed: [1000, 1600] };
  const store = { jobs: [], next: () => null };
  const m = new Machine(cfgJ, store, () => {});
  m.link = link;
  Object.assign(m.st, { link: 'online', pos: { x: -450, y: 31, z: 0 } });
  // head outside the bed set in Setup (bed set smaller than the machine)
  await m.jog({ axis: 'x', distance: 10 });
  ok(sent[0][1] === -440, 'jog X+ 10 from outside the bed (X −450) goes to −440, not across to the bed edge', JSON.stringify(sent[0]));
  m.st.pos = { x: -440, y: 31, z: 0 };
  await m.jog({ axis: 'x', distance: -10 });
  ok(sent.length === 1, 'jog X− (further out of the bed) doesn\'t move, and never the other way', JSON.stringify(sent));
  m.st.pos = { x: 500, y: 31, z: 0 };
  await m.jog({ axis: 'x', distance: -10 });
  ok(sent[1] && sent[1][1] === 490, 'jog X− inside the bed goes the way pressed', JSON.stringify(sent[1]));
  // hold, then let go: the controller is told to stop
  sent.length = 0;
  m.st.pos = { x: 100, y: 100, z: 0 }; pos = { x: 100, y: 100 }; m.posAt = Date.now();
  await m.jogHold({ axis: 'y', dir: 1, speed: 50 });
  await new Promise((r) => setTimeout(r, 350));
  await m.jogHold({ axis: 'y', dir: 1, speed: 50 });
  await new Promise((r) => setTimeout(r, 200));
  const moves = sent.filter((s) => s[0] === 'move');
  ok(moves.length > 1 && moves.every((s, i) => s[1] === 100 && (i === 0 || s[2] > moves[i - 1][2])), 'hold Y+: steps forward in Y only (' + moves.length + ' moves)', JSON.stringify(moves));
  await m.jogRelease();
  ok(sent[sent.length - 1][0] === 'stop', 'let go: stop sent to the controller');
  // another arrow while holding: stop first, then the other way
  sent.length = 0;
  await m.jogHold({ axis: 'x', dir: 1, speed: 50 });
  await new Promise((r) => setTimeout(r, 250));
  await m.jogHold({ axis: 'x', dir: -1, speed: 50 });
  await new Promise((r) => setTimeout(r, 250));
  await m.jogRelease();
  const stopAt = sent.findIndex((s) => s[0] === 'stop');
  const after = sent.slice(stopAt + 1).filter((s) => s[0] === 'move');
  ok(stopAt > 0 && after.length > 0 && after[after.length - 1][1] < after[0][1] + 0.001, 'change of direction: stop, then moves the other way', JSON.stringify(sent));
  // a controller that slows to a stop at the end of every move (RDD6584): one move to the
  // bed edge at the chosen speed, stopped on release
  sent.length = 0;
  link.continuousJog = true;
  link.moveTo = async (x, y, o) => { sent.push(['move', +x.toFixed(2), +y.toFixed(2), o.speed]); };
  m.st.pos = { x: 100, y: 200, z: 0 };
  await m.jogHold({ axis: 'y', dir: 1, speed: 10 });
  await new Promise((r) => setTimeout(r, 300));
  await m.jogHold({ axis: 'y', dir: 1, speed: 10 });
  await new Promise((r) => setTimeout(r, 300));
  await m.jogRelease();
  ok(JSON.stringify(sent) === '[["move",100,1600,10],["stop"]]', 'held arrow on an RDD6584: one move to the bed edge at 10 mm/s, then stop on release', JSON.stringify(sent));

  // A job the laser throws away itself (the Trotec: "FPGA Error Received 57", ignore data, buffers
  // cleared, then idle) is stopped, not done; one it finishes is done
  for (const fault of [true, false]) {
    let polls = 0;
    const tl = {
      send: async () => { if (fault) tl.fault = { at: Date.now(), text: 'FPGA Error Received 57' }; },
      poll: async () => ({ state: ++polls < 3 ? 'busy' : 'idle', pos: { x: 10, y: 10, z: 0 } }),
      abort: async () => {}
    };
    const done = [];
    const ms = new Machine({ ...config.defaults('trotec'), configured: true }, { jobs: [], flush: () => {}, finish: (j, r) => done.push(r), next: () => null }, () => {});
    ms.link = tl;
    Object.assign(ms.st, { link: 'online', pos: { x: 10, y: 10, z: 0 } });
    ms.execute({ id: 'J1', name: 'grid' }, { ctrl: 'trotec', seconds: 4, segments: [{ kind: 'stream', seconds: 4, steps: [{ i: 0, seconds: 4 }] }] });
    for (let i = 0; i < 40 && ms.run; i++) await new Promise((r) => setTimeout(r, 100));
    if (fault) ok(done[0] === 'Stopped' && ms.st.state === 'alarm' && /stopped the job itself \(FPGA Error Received 57\)/.test(ms.st.message), 'the laser throws the job away (FPGA error, buffers cleared): stopped, with its reason, not done', JSON.stringify({ done, state: ms.st.state, msg: ms.st.message }));
    else ok(done[0] === 'Completed' && ms.st.state === 'idle', 'a job the laser finishes: done', JSON.stringify({ done, state: ms.st.state }));
  }
}

// ---------------------------------------------------------------- material settings (HMI-BRIEF §5.3)
// Pathline Prepare keeps each machine's material settings on it: PUT the whole list, GET it back
// byte for byte (fields Run doesn't know, their order, ·×° and the spacing), a non-list refused
// with 400, and the list still there after a restart
async function materialsTests() {
  console.log('Material settings kept for Pathline Prepare');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pathline-run-mat-'));
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ controller: 'trotec', configured: true, name: 'Sim', bed: [813, 508] }));
  const port = 19700 + Math.floor(Math.random() * 200);
  const base = 'http://127.0.0.1:' + port + '/api/v1/materials';
  const startSrv = async () => {
    const s = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js'), '--sim', '--port', String(port), '--data', data], { stdio: ['ignore', 'pipe', 'pipe'] });
    for (let i = 0; i < 50; i++) { try { await fetch(base); break; } catch (e) { await new Promise((r) => setTimeout(r, 100)); } }
    return s;
  };
  const doc = '{"format":"pathline-materials", "version":1,\n "machine":{"id":"m-eth","name":"Trotec Q500 · test","type":"laser"},\n' +
    ' "materials":[{"id":"mat-3k9x2","name":"Cast acrylic","t":3,"g":"Acrylic","sw":"#E1E4E8","notes":"5 × 5 mm, 45°","updatedAt":"2026-11-04T10:02:39.928Z",' +
    '"future":{"2":"b","1":"a"},"processes":[{"name":"Cut contour","proc":"Cut","power":90,"speed":20,"f":5000,"passes":1,"out":true,"aci":[1],"adv":{}}]}]}';
  let srv = await startSrv();
  try {
    const empty = await (await fetch(base)).json();
    ok(empty.format === 'pathline-materials' && empty.version === 1 && Array.isArray(empty.materials) && !empty.materials.length, 'GET /materials before any: the empty list');
    const put = await fetch(base, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: doc });
    const pj = await put.json();
    ok(put.status === 200 && pj.ok === true && pj.count === 1, 'PUT /materials: { ok, count: 1 }', JSON.stringify(pj));
    const back = await (await fetch(base)).text();
    ok(back === doc, 'GET /materials gives it back byte for byte (unknown fields, their order, · × °, spacing)', back.slice(0, 160));
    const bad = await fetch(base, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ format: 'something-else', materials: [] }) });
    const bad2 = await fetch(base, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ format: 'pathline-materials', materials: {} }) });
    ok(bad.status === 400 && (await bad.json()).error === 'Not a materials list' && bad2.status === 400, 'not a materials list → 400 { error: "Not a materials list" }');
    ok((await (await fetch(base)).text()) === doc && !fs.existsSync(path.join(data, 'materials.json.tmp')), 'a refused PUT leaves the list as it was, and no temporary file');
    srv.kill();
    await new Promise((r) => setTimeout(r, 300));
    srv = await startSrv();
    ok((await (await fetch(base)).text()) === doc, 'the list is still there after a restart');
  } catch (e) { ok(false, 'material settings', e.stack); } finally {
    srv.kill();
    fs.rmSync(data, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- server, simulated machine
async function serverTests() {
  console.log('HTTP protocol (simulated machine)');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pathline-run-'));
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ controller: 'trotec', regMarks: 'ignore', bed: [813, 508], sim: { speedup: 400 } }));
  const port = 18470 + Math.floor(Math.random() * 500);
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js'), '--sim', '--port', String(port), '--data', data], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  srv.stdout.on('data', (d) => { out += d; });
  srv.stderr.on('data', (d) => { out += d; });
  const base = 'http://127.0.0.1:' + port + '/api/v1';
  const call = async (m, r, b) => {
    const res = await fetch(base + r, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  try {
    for (let i = 0; i < 50; i++) { try { await call('GET', '/info'); break; } catch (e) { await new Promise((r) => setTimeout(r, 100)); } }
    const info = await call('GET', '/info');
    ok(info.status === 200 && info.data.protocol === 1 && info.data.type === 'laser', 'GET /info');
    const q = await call('POST', '/jobs', example);
    ok(q.status === 200 && q.data.status === 'queued', 'POST /jobs queues the example');
    const pl = await call('POST', '/jobs', JSON.parse(fs.readFileSync(path.join(FIX, 'plotter-two-beds.json'), 'utf8')));
    ok(pl.status === 400 && pl.data.error, 'plotter job → 400 { error }');
    await new Promise((r) => setTimeout(r, 700));
    const st = await call('POST', '/start');
    ok(st.status === 200 && st.data.state === 'running', 'POST /start runs it');
    const jog = await call('POST', '/jog', { axis: 'x', distance: 10 });
    ok(jog.status === 409, 'jog while running → 409');
    let s;
    for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 250)); s = (await call('GET', '/status')).data; if (s.state === 'idle') break; }
    ok(s.state === 'idle' && s.progress === 1, 'job finishes (progress 1)', JSON.stringify(s));
    const jobs = (await call('GET', '/jobs')).data;
    ok(jobs[0] && jobs[0].status === 'done', 'GET /jobs shows it done');
    const ex = await fetch('http://127.0.0.1:' + port + '/api/local/jobs/' + q.data.id + '/export?ctrl=ruida');
    const bin = Buffer.from(await ex.arrayBuffer());
    ok(ex.status === 200 && rd.unswizzle(bin, 0x88).slice(-1)[0] === 0xd7, 'export as Ruida .rd (' + bin.length + ' bytes)');
    const page = await fetch('http://127.0.0.1:' + port + '/');
    ok(page.status === 200 && /Pathline Run/.test(await page.text()), 'HMI page at /');

    // Queue → Select: three jobs queued, the 1st and 3rd ticked: they run one after the other,
    // the 2nd stays in the queue
    const three = [];
    for (let k = 0; k < 3; k++) three.push((await call('POST', '/jobs', example)).data.id);
    await new Promise((r) => setTimeout(r, 700));
    const sb = await call('POST', '/start', { ids: [three[0], three[2]] });
    let js = [];
    for (let i = 0; i < 160; i++) {
      await new Promise((r) => setTimeout(r, 250));
      js = (await call('GET', '/jobs')).data;
      const st3 = (id) => (js.find((j) => j.id === id) || {}).status;
      if (st3(three[0]) === 'done' && st3(three[2]) === 'done' && (await call('GET', '/status')).data.state === 'idle') break;
    }
    const stOf = (id) => (js.find((j) => j.id === id) || {}).status;
    ok(sb.data.job === three[0] && stOf(three[0]) === 'done' && stOf(three[2]) === 'done' && stOf(three[1]) === 'queued',
      'chosen jobs (1st and 3rd of three) run back to back; the 2nd stays queued', three.map(stOf).join(', '));

    // Anchor to toolhead: the head's position when Start is pressed, not when the switch went on;
    // for that run only (run again or from History, the job goes where Pathline placed it)
    {
      const local = async (m, r, b) => {
        const res = await fetch('http://127.0.0.1:' + port + '/api/local' + r, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
        return { status: res.status, data: await res.json().catch(() => null) };
      };
      // idle twice in a row, after a moment for the move to start
      const idle = async () => { let n = 0; await new Promise((r) => setTimeout(r, 400)); for (let i = 0; i < 200; i++) { await new Promise((r) => setTimeout(r, 250)); const s2 = (await call('GET', '/status')).data; n = s2.state === 'idle' ? n + 1 : 0; if (n >= 2) return s2; } return null; };
      const jobOf = async (id) => (await local('GET', '/state')).data.jobs.find((j) => j.id === id) || {};
      // three[1] is still queued
      const id = three[1];
      await local('PUT', '/config', { removeDone: false }); // (kept in the queue, to look at afterwards)
      await call('POST', '/home'); await idle();
      const sw = await local('POST', '/jobs/' + id + '/anchor', {});
      const before = await jobOf(id);
      ok(sw.status === 200 && sw.data.atStart && !before.anchor, 'switching Anchor to toolhead on takes no position yet', JSON.stringify(sw.data));
      await call('POST', '/jog', { axis: 'x', distance: 40 }); await idle();
      await call('POST', '/jog', { axis: 'y', distance: 25 });
      const s0 = await idle();
      const go = await call('POST', '/start', { id });
      const during = await jobOf(id);
      ok(go.status === 200 && during.anchor && Math.abs(during.anchor.x - s0.pos.x) < 0.01 && Math.abs(during.anchor.y - s0.pos.y) < 0.01,
        'Start anchors the job where the head is then', JSON.stringify({ head: s0.pos, anchor: during.anchor, go: go.data }));
      await idle();
      const after = await jobOf(id);
      // (the example is a print and cut job: its switch starts on)
      ok(after.status === 'done' && !after.anchor && after.anchorAtStart === true, 'after the run the job keeps no position, the switch back to its default (on: print and cut)', JSON.stringify(after));
      const home = (await call('GET', '/status')).data.pos;
      ok(home && Math.abs(home.x - s0.pos.x) < 0.05 && Math.abs(home.y - s0.pos.y) < 0.05, 'after a completed job the head goes back to where it was at Start', JSON.stringify({ start: s0.pos, now: home }));
      await local('POST', '/jobs/' + id + '/anchor', { clear: true });
      const re = await local('POST', '/jobs/' + id + '/requeue', {});
      ok(re.status === 200 && !re.data.anchor && re.data.anchorAtStart === true, 'run again from History: no position kept, the switch at its default', JSON.stringify(re.data));
      await local('POST', '/jobs/' + id + '/anchor', {});
      await call('POST', '/stop');
      const kept = await local('POST', '/jobs/' + id + '/requeue', { keepAnchor: true });
      ok(kept.data.anchorAtStart === true, 'Start on a completed job keeps an anchor switched on for it since');
    }

    const checker = path.join(__dirname, '..', '..', 'hmi-handoff', 'tools', 'check-hmi.js');
    if (fs.existsSync(checker)) {
      const res = await new Promise((resolve) => {
        const c = spawn(process.execPath, [checker, '127.0.0.1', '--port', String(port), '--allow-motion', '--run'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let o = '';
        c.stdout.on('data', (d) => { o += d; });
        c.stderr.on('data', (d) => { o += d; });
        c.on('close', (code) => resolve({ code, o }));
      });
      ok(res.code === 0, 'Pathline\'s check-hmi.js --allow-motion --run passes', res.o.split('\n').filter((l) => /FAIL|warn/.test(l)).join('\n          '));
    } else console.log('  skip  check-hmi.js (run "node tools/make-hmi-package.js" in the Pathline folder first)');
  } finally {
    srv.kill();
    if (failed) console.log(out.split('\n').slice(-15).join('\n'));
    fs.rmSync(data, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- links against fake controllers
// These check our own framing, acknowledgements and streaming end to end. They
// can't prove the real controllers agree; that needs the machines.
async function linkTests() {
  const net = require('net');
  const dgram = require('dgram');
  const TrotecLink = require('../src/ctrl/trotec/link');
  const RuidaLink = require('../src/ctrl/ruida/link');

  console.log('Trotec link (fake controller over TCP)');
  // like the Q500: packets with a data section must count up from 0 after TX; (otherwise "invalid id")
  const dev = { pos: [0, 0], packets: 0, data: 0, ids: [], full: 3, abort: false, expect: 0, refused: 0, noData: 0 };
  const fake = net.createServer((s) => {
    let buf = Buffer.alloc(0);
    let binary = false;
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!binary) {
        const t = buf.toString('latin1');
        if (/pg0\r/.test(t)) s.write('Parameter #0: 53\r\n');
        if (/pg250\r/.test(t)) s.write('Parameter #250: 2820\r\n');
        if (/TX;/.test(t)) { s.write('04.02-53.00-11.04\r\n'); binary = true; }
        buf = Buffer.alloc(0);
        return;
      }
      // the connect request is accepted again at any time, and restarts the packet numbering
      if (buf.includes('TX;')) { s.write('04.02-53.00-11.04\r\n'); dev.expect = 0; buf = buf.subarray(buf.indexOf('TX;') + 3); }
      for (let t; (t = sf.takePacket(buf));) {
        buf = Buffer.from(t.rest);
        const p = t.packet;
        if (!p.data.length) dev.noData++;
        if (p.data.length && p.id !== dev.expect) { dev.refused++; s.write(sf.packet(p.id, null, null, 0xa0)); continue; }
        const answers = () => {
          const ans = [];
          for (const op of p.imm) {
            if (op === 0x10) ans.push(0x11, dev.busy ? 4 : 3, 0xff, 0, 0);
            else if (op === 0x2c) { const b = Buffer.alloc(9); b[0] = 0x2d; b.writeInt32BE(dev.pos[0], 1); b.writeInt32BE(dev.pos[1], 5); ans.push(...b); }
            else if (op === 0xa4) ans.push(0xa5, 0, 0);
            else { if (op === 0x02) dev.abort = true; ans.push(op + 1); }
          }
          return Buffer.from(ans);
        };
        // refuse the first few real data packets once with "buffer full", like a busy machine
        // (dev.fullAnswers: the refusal answers the immediate section, the head moving meanwhile)
        if (p.data.length > 1 && dev.full > 0) {
          dev.full--;
          if (dev.fullAnswers) dev.pos = [dev.pos[0] + 1000, dev.pos[1]];
          s.write(sf.packet(p.id, dev.fullAnswers ? answers() : null, null, 0x90));
          continue;
        }
        if (p.data.length) dev.expect = (dev.expect + 1) & 0xff;
        dev.packets++; dev.ids.push(p.id); dev.data += p.data.length;
        for (const c of sf.decodeData(p.data)) if (c.name === 'MOVEXY') dev.pos = c.v;
        s.write(sf.packet(p.id, answers(), null, 0x80));
      }
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const cfgT = { ...config.defaults('trotec'), connection: { mode: 'tcp', host: '127.0.0.1', tcpPort: fake.address().port } };
  const tl = new TrotecLink(cfgT, () => {});
  try {
    const info = await tl.connect();
    ok(/53/.test(info.model) && /04\.02-53/.test(info.firmware), 'handshake: model 53, ' + info.firmware);
    const p0 = await tl.poll();
    ok(p0.state === 'idle' && !p0.interlock, 'poll: idle, lid closed');
    for (let i = 0; i < 40; i++) await tl.poll(); // status checks between commands, as the app does
    const before0 = dev.data;
    await tl.moveTo(100, 50);
    const p1 = await tl.poll();
    ok(Math.abs(p1.pos.x - 100) < 0.011 && Math.abs(p1.pos.y - 50) < 0.011, 'move to 100, 50 mm reads back', JSON.stringify(p1.pos));
    ok(dev.data > before0 && dev.refused === 0 && dev.noData === 0, 'a move after 40 status checks is accepted: every packet has data (NOP), ids in step', 'refused ' + dev.refused + ', without data ' + dev.noData);
    // the laser expecting another id (e.g. after a hiccup): TX; restarts the numbering and the packet goes again
    dev.expect = 200;
    await tl.moveTo(10, 10);
    const p2 = await tl.poll();
    ok(Math.abs(p2.pos.x - 10) < 0.011, 'an "invalid id" refusal recovers by starting the numbering again', JSON.stringify(p2.pos));
    const prog = trotec.compile(plan.build(example), { ...cfgT, regMarks: 'ignore' });
    const before = dev.data;
    for (const s of prog.segments.filter((x) => x.kind === 'stream')) await tl.send(s, {});
    const total = prog.segments.filter((x) => x.kind === 'stream').reduce((a, s) => a + s.data.length, 0);
    ok(dev.data - before === total, 'whole example streamed (' + total + ' bytes), after 3 "buffer full" retries', (dev.data - before) + ' bytes');
    ok(dev.ids.every((id, i) => i === 0 || id === ((dev.ids[i - 1] + 1) & 0xff) || id === 0), 'packet ids count up without gaps, apart from the restart at 0 (' + dev.packets + ' packets)');
    // a "buffer full" refusal that answers status and position: each one is a fresh head position
    const seen = [];
    tl.onPoll = (v) => seen.push(v);
    Object.assign(dev, { full: 3, fullAnswers: true, busy: true });
    const t0 = Date.now();
    await tl.moveTo(20, 20);
    ok(seen.length >= 3 && seen.every((v) => v.state === 'busy' && v.at >= t0) && new Set(seen.map((v) => v.pos.x)).size === seen.length,
      'buffer full with answers: the head position from each refusal, stamped when it came', seen.length + ' positions: ' + seen.map((v) => v.pos.x.toFixed(1)).join(', '));
    // a status check refused for buffer room gets the last answer, with that answer's own time
    Object.assign(dev, { full: 0, fullAnswers: false, busy: false });
    const last = tl.lastReply;
    const old = tl.view({ ...last, at: last.at - 5000 });
    ok(old.at === last.at - 5000, 'a repeated answer keeps its own time (the screen doesn\'t take it as news)');
    tl.onPoll = null;
    await tl.abort();
    ok(dev.abort, 'abort reaches the controller');
  } catch (e) { ok(false, 'Trotec link', e.stack); }
  await tl.close();
  fake.close();

  console.log('Ruida link (fake controller over UDP)');
  let magic = 0x88; // the fake controller's own swizzle magic
  const rdev = { sumOk: true, bytes: 0, cmds: [] };
  const sock = dgram.createSocket('udp4');
  sock.on('message', (m, from) => {
    const body = m.subarray(2);
    const sum = body.reduce((a, b) => a + b, 0) & 0xffff;
    if (m.readUInt16BE(0) !== sum) { rdev.sumOk = false; sock.send(Buffer.from([rd.swizzleByte(0xcf, magic)]), from.port, from.address); return; }
    sock.send(Buffer.from([rd.swizzleByte(0xcc, magic)]), from.port, from.address);
    const raw = rd.unswizzle(body, magic);
    rdev.bytes += raw.length;
    for (const c of rd.commands(raw)) {
      // an RDD6584's file memory: E8 01 n name, E8 00 a b delete, E8 02 + E7 01 name add, E8 03 n run
      rdev.files = rdev.files || ['L100R80', 'START', 'X1'];
      if (c[0] === 0xe8 && c[1] === 0x01) { const n = (c[2] << 7) | c[3]; sock.send(rd.swizzle(Buffer.from([0xe8, 0x01, c[2], c[3], ...Buffer.from((rdev.files[n - 1] || '') + '\0', 'latin1')]), magic), from.port, from.address); }
      if (c[0] === 0xe8 && c[1] === 0x00) { const a = (c[2] << 7) | c[3], b = (c[4] << 7) | c[5]; rdev.files.splice(a - 1, b - a + 1); }
      if (c[0] === 0xe7 && c[1] === 0x01 && rdev.keys && rdev.keys[rdev.keys.length - 1] === 'e802') rdev.files.push(Buffer.from(c.subarray(2, c.indexOf(0, 2))).toString('latin1'));
      if (c[0] === 0xe8 && c[1] === 0x03) rdev.ran = (c[2] << 7) | c[3];
      rdev.cmds.push(c[0]);
      rdev.keys = (rdev.keys || []).concat(hex(c.subarray(0, 2)));
      rdev.raw = (rdev.raw || []).concat(hex(c));
      if (c[0] === 0xda && c[1] === 0x00) {
        const addr = (c[2] << 8) | c[3];
        const v = { 0x0405: (rdev.files || []).length, 0x057e: rdev.card || 0x6445, 0x0400: 0, 0x0421: 850000, 0x0431: 20000, 0x0026: 900000, 0x0036: 600000, 0x0023: 400000, 0x0033: 300000, 0x0025: 3000000, 0x0035: 2500000 }[addr] || 0;
        sock.send(rd.swizzle(Buffer.from([0xda, 0x01, c[2], c[3], ...rd.enc(v, 5), ...rd.enc(0, 5)]), magic), from.port, from.address);
      }
    }
  });
  await new Promise((r) => sock.bind(50200, '127.0.0.1', r)).catch(() => null);
  const cfgR = { ...config.defaults('ruida'), bed: [900, 600], regMarks: 'ignore', connection: { mode: 'udp', ip: '127.0.0.1' } };
  const rl = new RuidaLink(cfgR, () => {});
  try {
    const info = await rl.connect();
    ok(/6445/.test(info.model), 'card id query answered (' + info.model + ')');
    const p = await rl.poll();
    ok(p.state === 'idle' && Math.abs(p.pos.x - 50) < 0.01 && Math.abs(p.pos.y - 20) < 0.01, 'poll: idle at 50, 20 mm (controller 850, 20 with origin top right)', JSON.stringify(p.pos));
    // moves by hand: one axis at a time (D9 00 X, D9 01 Y), never the two-axis D9 10
    rdev.keys = [];
    await rl.moveTo(50, 30, { axis: 'y' });
    await rl.moveTo(0, 0);
    ok(rdev.keys.filter((k) => k.startsWith('d9')).join() === 'd901,d900,d901', 'jog Y sends D9 01 only; go to 0, 0 sends D9 00 then D9 01 (no D9 10)', rdev.keys.join());
    const prog = ruida.compile(plan.build(example), cfgR);
    const before = rdev.bytes;
    for (const s of prog.segments.filter((x) => x.kind === 'stream')) await rl.send(s, {});
    const total = prog.segments.filter((x) => x.kind === 'stream').reduce((a, s) => a + s.data.length, 0);
    ok(rdev.bytes - before === total && rdev.sumOk, 'whole example sent in checked packets (' + total + ' bytes)');
    const rb = require('../src/ctrl/ruida/readback').interpret(await rl.readSettings());
    ok(JSON.stringify(rb.suggest.bed) === '[900,600]' && rb.suggest.speed === 300 && rb.suggest.acc === 2500, 'settings read from the controller: work area 900 × 600 mm, 300 mm/s, 2500 mm/s²', JSON.stringify(rb.suggest));
    await rl.abort();
    ok(rdev.cmds[rdev.cmds.length - 1] === 0xd8, 'stop (D8 01) reaches the controller');
  } catch (e) { ok(false, 'Ruida link', e.stack); }
  await rl.close();

  // a 634x-family controller (magic 0x11) set up as a 6442 (0x88): the link works out the magic
  magic = 0x11;
  const rl2 = new RuidaLink({ ...cfgR, ruida: { ...cfgR.ruida, magic: 0x88 } }, () => {});
  try {
    const info2 = await rl2.connect();
    ok(rl2.magic === 0x11 && /detected/.test(info2.firmware), 'wrong swizzle magic in Setup: detected 0x11 from the first reply and connected', info2.firmware);
  } catch (e) { ok(false, 'magic detection', e.message); }
  await rl2.close();

  // an RDD6584 knife controller (card 0x6910, magic 0xA1) moves BY the D9 value: as VCutWorks,
  // speed (C9 02) then the distance, two's complement for minus (captured on a YC-1610)
  magic = 0xa1;
  rdev.card = 0x6910;
  const rk = new RuidaLink({ ...cfgR, knifeHome: { x: 0, y: 0 }, ruida: { ...cfgR.ruida, model: 'RDD6584G', magic: 0xa1 } }, () => {});
  try {
    await rk.connect();
    rdev.keys = []; rdev.raw = [];
    await rk.moveTo(50, 30, { axis: 'y' });   // controller Y 20 mm → 30 mm: +10
    await rk.moveTo(40, 10, { axis: 'x' });   // controller X 850 mm → 860 mm (origin top right): +10
    await rk.moveTo(50, 10, { axis: 'y' });   // controller Y 20 mm → 10 mm: −10
    const moves = rdev.raw.filter((h) => /^(c902|d90)/.test(h));
    const want = ['speed', 'd901020000004e10', 'speed', 'd900020000004e10', 'speed', 'd901027f7f7f3170'];
    ok(moves.length === want.length && want.every((w, i) => (w === 'speed' ? moves[i].startsWith('c902') : moves[i] === w)) && !rdev.keys.includes('d910'),
    'RDD6584: jog Y +10, X +10, Y −10 sent as speed + move-by, as VCutWorks does', moves.join(' '));
    // Conveyor: the old START file is replaced (only that one), the feed job uploaded and started
    rdev.raw = []; rdev.files = ['L100R80', 'START', 'X1']; rdev.ran = null;
    await rk.feed(100);
    ok(rdev.files.join() === 'L100R80,X1,START' && rdev.ran === 3 && rdev.raw.some((h) => h === 'e70600000000020000060d20'),
      'RDD6584 Conveyor: START replaced (other files kept), feed-only job with 100 mm uploaded and started', rdev.files.join() + ' ran ' + rdev.ran);
    ok(rk.continuousJog, 'RDD6584: a held arrow is one long move (no judder between steps)');
    // the head parked at home (controller X 850, Y 20): it reads 0, 0, the bed's top right
    // corner; then going to bed X 100 (origin top right, 900 mm bed) is 800 mm to the left
    const homes = [];
    rk.onHome = (h) => homes.push(h);
    await rk.learnHome();
    const ph = await rk.poll();
    rdev.raw = [];
    await rk.moveTo(100, 0, { axis: 'x' });
    const dx = rdev.raw.find((h) => h.startsWith('d900'));
    ok(ph.mpos.x === 0 && ph.mpos.y === 0 && ph.pos.x === 900 && ph.pos.y === 0 && dx && rd.dec(Buffer.from(dx.slice(6), 'hex'), true) === 800000 && JSON.stringify(homes) === '[{"x":850,"y":20}]',
      'RDD6584: parked at home reads 0, 0 (and home is kept); going to bed X 100 moves 800 mm', JSON.stringify(ph.mpos) + ' ' + dx + ' ' + JSON.stringify(homes));
  } catch (e) { ok(false, 'RDD6584 moves', e.stack); }
  await rk.close();
  rdev.card = 0;

  // Setup → Find on network: the controller answers and gives away its magic and card ID
  try {
    const found = await RuidaLink.find(null, ['127.0.0.1']);
    ok(found.length === 1 && found[0].magic === 0xa1 && found[0].card === '0x6445', 'Find on network: controller at 127.0.0.1, magic 0xA1, card 0x6445', JSON.stringify(found));
  } catch (e) { ok(false, 'Find on network', e.message); }

  // another program holding UDP 40200 (LightBurn, RDWorks…): a clear message, no fallback port
  const squatter = dgram.createSocket('udp4');
  await new Promise((r) => squatter.bind(Number(process.env.PATHLINE_RUN_RUIDA_PORT_IN), r));
  const rl3 = new RuidaLink(cfgR, () => {});
  try { await rl3.connect(); ok(false, 'UDP 40200 in use', 'connected anyway'); } catch (e) { ok(/UDP port \d+ is in use by another program/.test(e.message), 'UDP 40200 in use by another program: says so', e.message); }
  await rl3.close().catch(() => {});
  squatter.close();
  sock.close();

  // settings a controller doesn't have come back as 0xF2390000 (RDD6584): not shown as values
  const na = require('../src/ctrl/ruida/readback').interpret({ rangeX: 1450000, rangeY: 1520000, maxVelX: 0xf2390000, maxVelY: 0xf2390000, cardId: 0x69106910 });
  ok(JSON.stringify(na.suggest) === '{"bed":[1450,1520]}' && na.rows.some((r) => r.value === '0x6910'), 'Read from controller: "not available" settings left out, card shown as 0x6910', JSON.stringify(na));
}

// ---------------------------------------------------------------- head camera, simulated
// The server's --sim camera hides its own truth (offset 41.2 / 12.9 mm, 80 µm pixels turned 90°,
// a machine 1.5 mm/m long in X and 0.03° out of square, a checkerboard at 1.5°, the example's
// marks on a sheet shifted 0.8 / −0.5 mm and turned 0.3°): calibration has to find it.
async function visionTests() {
  console.log('Head camera (simulated)');
  {
    // camera reach, checked at Start: the X28 sheet (J0052), marks 1 and 3 at X 28 with the camera
    // 41.7 mm right of the laser
    const { reach, reachInfo, reachMessage } = require('../src/vision/vision');
    const job = (pts) => ({ toolpath: pts.map((at, i) => ({ type: 'inspect', mark: i + 1, of: pts.length, at, d: 3 })) });
    const off = [-41.735, -12.9854], bed = [1300, 900];
    const x28 = reachMessage(reach(job([[28, 28], [1269.57, 28], [28, 844.354]]), off, bed), false);
    ok(x28 === 'Move the sheet 20 mm to the right. Marks 1 and 3 are 28 mm from the left edge; the camera can only see from 42 mm. Then switch Anchor to toolhead on, put the laser (not the camera) over the top-left dot and press Start. Or move the marks in Prepare.',
      'Start: marks too near the left edge for the camera: which way to move the sheet first, to the next 10 mm (14 → 20)', x28);
    const anch = reachInfo(reach(job([[28, 28], [1269.57, 28], [28, 844.354]]), off, bed), true);
    ok(anch.kind === 'reach' && anch.moves.length === 1 && anch.moves[0].dir === 'right' && anch.moves[0].mm === 20 && /put the laser \(not the camera\) back over the top-left dot and press Start/.test(anch.then),
      'anchored: the move for the dialog, then the laser (not the camera) back over the dot', JSON.stringify(anch));
    ok(reachMessage(reach(job([[42, 13], [1283.6, 13], [42, 829.4]]), off, bed), false) === null, 'marks 42 mm from the left, 13 mm from the back: all reachable');
    const back = reachInfo(reach(job([[50, 5], [1200, 5], [50, 800]]), off, bed), false);
    ok(back.moves.length === 1 && back.moves[0].dir === 'front' && back.moves[0].mm === 10 && /^Marks 1 and 2 are 5 mm from the back edge; the camera can only see from 13 mm\.$/.test(back.why[0]),
      'too near the back edge: move it 10 mm to the front (8 needed)', JSON.stringify(back));
    const both = reachInfo(reach(job([[30, 5], [1200, 5], [30, 800]]), off, bed), false);
    ok(both.moves.map((m) => m.dir + ' ' + m.mm).join(', ') === 'right 20, front 10' && /^Move the sheet 20 mm to the right and 10 mm to the front\./.test(both.text), 'too near two edges: both moves', both.text);
    const wide = reachInfo(reach(job([[20, 30], [1350, 30], [20, 800]]), off, bed), false);
    ok(!wide.moves.length && /1330 mm apart across, but the camera can only reach 1300 mm\. Move the marks closer together in Prepare/.test(wide.wide), 'marks further apart than the camera reaches: no move offered', wide.text);
    // past the bed's right end the camera still sees (the head goes right up to it): J0064 read its
    // top-right mark at X 1322.9 on the 1300 mm bed
    ok(reachMessage(reach(job([[81.5, 77.2], [1322.9, 81.1], [78.6, 893.5]]), off, bed), false) === null, 'a mark 23 mm past the bed\'s right end: the camera reaches it (J0064)');
    const past = reachInfo(reach(job([[100, 50], [1360, 50], [100, 800]]), off, bed), false);
    ok(past && /Mark 2 is 60 mm past the right edge; the camera can only see up to 41 mm past it\./.test(past.why[0]) && past.moves[0].dir === 'left' && past.moves[0].mm === 20, 'a mark beyond what the camera sees past the right edge: said so, move 20 mm left', past && past.text);
    // print and cut whose cuts go past the bed, with the laser on the dot (J0065: the X28 sheet,
    // dot at X 80.5, cuts to 1315): move the sheet, not the head; marks don't count towards fitting
    const anchorM = require('../src/job/anchor');
    const { fitInfo } = require('../src/vision/vision');
    const pc = { toolpath: [{ type: 'inspect', mark: 1, of: 3, at: [43, 23] }, { type: 'inspect', mark: 2, of: 3, at: [1284.57, 23] }, { type: 'inspect', mark: 3, of: 3, at: [43, 839.35] },
      { type: 'cut', process: 0, p: [[51.12, 31.16], [1277.67, 31.16], [1277.67, 831.16], [51.12, 831.16]] }] };
    let ov = null; try { anchorM.check(pc, { x: 80.494, y: 78.297 }, bed); } catch (e) { ov = e.over; }
    const fi = fitInfo(ov, bed, true);
    ok(fi && fi.moves.length === 1 && fi.moves[0].dir === 'left' && fi.moves[0].mm === 20 && /^Move the sheet 20 mm to the left\. The cuts reach X 1315, 16 mm past the right end of the bed \(1300 mm\)\. Then put the laser \(not the camera\) back over the top-left dot/.test(fi.text),
      'print and cut, laser on the dot, cuts past the bed: move the sheet 20 mm to the left', fi && fi.text);
    let fits = true; try { anchorM.check(pc, { x: 60, y: 78.3 }, bed); } catch (e) { fits = false; }
    ok(fits, 'moved 20 mm left (dot at X 60) it fits: the top-right mark 1302 is past the bed, but only the cuts count');
    const big = fitInfo({ left: 5, right: 5, back: 0, front: 0, box: [-5, 0, 1305, 100] }, bed, true);
    ok(big && !big.moves.length && /bigger than the bed/.test(big.wide), 'cuts past both ends: bigger than the bed, no move offered', big && big.text);
    // a Trotec's head may go past the bed's corner to its own zero (factory offset 14.8, 9.5 mm),
    // beam off: the camera then reaches 26.9 mm from the left and 3.5 mm from the back
    const Machine = require('../src/machine');
    const tm = Object.create(Machine.prototype);
    tm.cfg = { controller: 'trotec', bed, trotec: { offset: [14.833125, 9.527625] } };
    const tv = tm.travel();
    ok(tv[0] === -14.833125 && tv[1] === -9.527625 && tv[2] === 1300 && tv[3] === 900, 'Trotec travel: the bed and the strip to the machine\'s zero', JSON.stringify(tv));
    tm.st = { pos: { x: 100, y: 0 } };
    ok(tm.jogRange('y')[0] === -9.527625 && tm.clampTravel(-50, -50).join() === '-14.833125,-9.527625', 'Trotec jog may go behind and left of the bed, never past the machine\'s zero');
    const rm = Object.create(Machine.prototype); rm.cfg = { controller: 'ruida', bed: [900, 600] };
    ok(rm.travel().join() === '0,0,900,600', 'other controllers: travel is the bed');
    ok(reachMessage(reach(job([[28, 28], [1269.57, 28], [28, 844.354]]), off, bed, tv), false) === null, 'with the Trotec\'s travel the X28 sheet\'s marks (28 mm in) can be read');
    const x13 = reachMessage(reach(job([[13, 13], [1254.57, 13], [13, 829.354]]), off, bed, tv), false);
    ok(/^Move the sheet 20 mm to the right\. Marks 1 and 3 are 13 mm from the left edge; the camera can only see from 27 mm\./.test(x13), 'marks 13 mm in: still too near the left edge', x13);
    const j21 = reachInfo(reach(job([[21.5, 51.5], [1263, 51.5], [21.5, 867.9]]), off, bed, tv), true);
    ok(j21.moves[0].mm === 10, 'the X28 sheet anchored at X 21.5 (J0064\'s 2nd try): 6 mm short, so move it 10', JSON.stringify(j21.moves));
    ok(reachMessage(reach(job([[30, 4], [1200, 4], [30, 800]]), off, bed, tv), false) === null, '4 mm from the back: readable with the travel behind the bed');
  }
  {
    // a checkerboard corner at an angle the board needn't be square: found, and its angle read
    const { SimCamera } = require('../src/vision/camera');
    const detect = require('../src/vision/detect');
    const sc = new SimCamera({ truth: { offset: [0, 0], pixel: 0.08, rotation: 0 }, scene: { board: { x: 500, y: 400, angle: 25, square: 50, nx: 6, ny: 6 } }, headAt: () => ({ x: 502, y: 399 }) });
    const c = detect.findCorner(await sc.grab());
    // the corner is 2 mm left of and 1 mm below the picture's middle: 25 px, 12.5 px at 80 µm
    // registration marks sit in plain white: a dot against dark artwork, nearer the middle, is
    // passed over for the clean one
    const art = new SimCamera({ truth: { offset: [0, 0], pixel: 0.08, rotation: 0 }, scene: { dots: [{ x: 100, y: 80, d: 5 }, { x: 107, y: 80, d: 5 }], rects: [{ x0: 88, y0: 74, x1: 96.4, y1: 86 }] }, headAt: () => ({ x: 100.5, y: 80 }) });
    const ai = await art.grab();
    const plain = detect.findDots(ai, { minD: 30, maxD: 100 })[0], clean = detect.findDots(ai, { minD: 30, maxD: 100, whiteRing: true })[0];
    // the clean dot (107, 80) is 6.5 mm right of the middle: 81 px
    ok(plain && clean && Math.abs(clean.x - (239.5 + 81.25)) < 1 && Math.abs(plain.x - (239.5 + 81.25)) > 20, 'marks sit in white: a dot against dark artwork is passed over for the clean one', JSON.stringify({ plain, clean }));
    // (the angle only aims the scan at the next corner; the board's angle comes from the corners found)
    ok(c && Math.abs(c.x - (239.5 - 25)) < 0.5 && Math.abs(c.y - (239.5 + 12.5)) < 0.5 && Math.abs(c.angle - 25) < 3, 'checkerboard corner at 25°: found to a fraction of a pixel, angle ' + (c && c.angle.toFixed(1)) + '° (a hint, within 3°)', JSON.stringify(c));
  }
  {
    // the real camera on Ruby's Trotec over the 10 mm board (972 px, as the camera view gets it): under
    // 3 squares across, light from one side, soft edges. Only the 4 real corners, no false ones on
    // the edges or the shadow, and a 2 × 2 grid from them
    const detect = require('../src/vision/detect');
    const b = zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', 'camera-10mm-board.bin.gz')));
    const img = { w: b.readUInt16BE(0), h: b.readUInt16BE(2), data: new Uint8Array(b.subarray(4)) };
    const cs = detect.findCorners(img);
    const L = detect.fitLattice(cs);
    const real = [[652, 609], [287, 608], [657, 236], [287, 238]];
    const square = L && Math.sqrt(Math.abs(L.a[0] * L.b[1] - L.a[1] * L.b[0]));
    ok(cs.length === 4 && real.every(([x, y]) => cs.some((c) => Math.hypot(c.x - x, c.y - y) < 8)) && L && L.n === 4 && Math.abs(square - 369) < 10,
      'real camera, 10 mm board in uneven light: ' + cs.length + ' corners (4), a 2 × 2 grid, ' + (square || 0).toFixed(0) + ' px a square', JSON.stringify({ cs, L }).slice(0, 400));
    // the same at full size (1944 px, as calibration sees it), with the paper's texture: ±30 % per
    // pixel. Refined at full size, the texture pulled every corner off into a white square (0.7.7)
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
    const W = img.w * 2, H = img.h * 2, big = { w: W, h: H, data: new Uint8Array(W * H) };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) big.data[y * W + x] = Math.max(0, Math.min(255, Math.round(img.data[(y >> 1) * img.w + (x >> 1)] * (1 + 0.6 * rnd()))));
    const cb = detect.findCorners(big), Lb = detect.fitLattice(cb);
    const sb = Lb && Math.sqrt(Math.abs(Lb.a[0] * Lb.b[1] - Lb.a[1] * Lb.b[0]));
    ok(cb.length === 4 && real.every(([x, y]) => cb.some((c) => Math.hypot(c.x - 2 * x, c.y - 2 * y) < 16)) && Lb && Lb.n === 4 && Math.abs(sb - 738) < 20,
      'the same at full size with the paper\'s texture: ' + cb.length + ' corners (4), ' + (sb || 0).toFixed(0) + ' px a square', JSON.stringify(cb).slice(0, 300));
    // the real camera again, the board where only the lower half of the view is lit: at the
    // exposure in use the top two corners are lost in the shadow; at 3× and 9× (a linear sensor:
    // times k, clipped) they show, and the corners of all three make the 2 × 2 grid
    const bs = zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', 'camera-10mm-board-shadow.bin.gz')));
    const sh = { w: bs.readUInt16BE(0), h: bs.readUInt16BE(2), data: new Uint8Array(bs.subarray(4)) };
    const at = (k) => ({ w: sh.w, h: sh.h, data: sh.data.map((v) => Math.min(255, Math.round(v * k))) });
    const one = detect.findCorners(sh), Ls = detect.fitLattice(detect.findCornersIn([1, 3, 9].map(at)));
    const shReal = [[645, 348], [277, 349], [645, 716], [274, 715]];
    ok(one.length === 2 && Ls && Ls.n === 4 && shReal.every(([x, y]) => Ls.points.some((c) => Math.hypot(c.x - x, c.y - y) < 8)),
      'real camera, board half in shadow: ' + one.length + ' corners at one exposure, ' + (Ls ? Ls.n : 0) + ' on the grid with the exposure stepped 1×, 3×, 9×', JSON.stringify(Ls && Ls.points).slice(0, 300));
  }
  {
    // a real printed mark (6 mm, black on a printed white disc, on clear acrylic) from the Q500's
    // camera at a third of full size, 9 mm off centre, the lamp lighting the disc 135 on one side and
    // 68 on the other. Pathline Run 0.7.10 never found it: its dark-mask box was 90 % of the picture,
    // and its white-ring test wanted the ring within 30 % of its brightest
    const detect = require('../src/vision/detect');
    const mb = zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', 'camera-mark-clear-acrylic.bin.gz')));
    const mk = { w: mb.readUInt16BE(0), h: mb.readUInt16BE(2), data: new Uint8Array(mb.subarray(4)) };
    const px3 = 0.0136 * 3, d6 = 6;
    const hit = detect.findDots(mk, { minD: (d6 * 0.5) / px3, maxD: (d6 * 1.6) / px3, whiteRing: true })[0];
    ok(hit && Math.hypot(hit.x - 652, hit.y - 304) < 3 && Math.abs(hit.d * px3 - 6.5) < 0.5, 'real mark on clear acrylic, unevenly lit: found with its white ring (' + (hit ? (hit.d * px3).toFixed(2) + ' mm across' : 'NOT FOUND') + ')', JSON.stringify(hit));
  }
  {
    // the laser's calibration mark as the Trotec cuts it: three thin rings (r 1, 1.5, 2 mm at
    // 13.6 µm a pixel), not a filled disc, on grey scrap in uneven light. As rings they're no dot;
    // with their holes filled they're the 4 mm disc, centred on the rings
    const detect = require('../src/vision/detect');
    const W = 900, H = 700, px = 0.0136, cx = 431.3, cy = 377.8, img = { w: W, h: H, data: new Uint8Array(W * H) };
    let seed = 3;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const r = Math.hypot(x - cx, y - cy) * px, ring = [1, 1.5, 2].some((R) => Math.abs(r - R) < 0.06);
      img.data[y * W + x] = Math.round((ring ? 35 : 150) * (0.55 + (0.45 * x) / W) + 10 * rnd());
    }
    const opts = { minD: 2 / px, maxD: 6.4 / px };
    const none = detect.findDots(img, opts), ring = detect.findDots(img, { ...opts, fillHoles: true })[0];
    // (its centre is what's used; the size reported after refining counts only the dark rings)
    ok(none.length === 0 && ring && Math.hypot(ring.x - cx, ring.y - cy) < 1,
      'laser mark of three rings: ' + none.length + ' dots as rings, with the holes filled one, ' + (ring ? Math.hypot(ring.x - cx, ring.y - cy).toFixed(2) + ' px from the middle' : 'NOT FOUND'), JSON.stringify(ring));
  }
  {
    // the camera's process runs on Electron's own Node in the installed app, where some koffi calls
    // abort the process (koffi.view, Pathline Run 0.7.5): copy a frame out of native memory there
    let electron = null;
    try { electron = require('electron'); } catch (e) { /* not installed */ }
    if (typeof electron === 'string' && fs.existsSync(electron)) {
      const js = "const k = require('koffi'); const { frameBytes } = require(" + JSON.stringify(path.join(__dirname, '..', 'src', 'vision', 'camera.js')) + ");" +
        "const p = k.alloc('uint8', 4096); k.encode(p, k.array('uint8', 4), [1, 2, 3, 4]); const b = frameBytes(k, p, 4096);" +
        "console.log(b instanceof Uint8Array && b.length === 4096 && b[3] === 4 ? 'copied' : 'wrong')";
      const r = await new Promise((resolve) => {
        const ch = spawn(electron, ['-e', js], { cwd: path.join(__dirname, '..'), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
        let o = '';
        ch.stdout.on('data', (d) => { o += d; });
        ch.stderr.on('data', (d) => { o += d; });
        ch.on('exit', (code) => resolve({ code, o }));
      });
      ok(r.code === 0 && /copied/.test(r.o), 'a camera frame copied out under Electron\'s own Node, as the installed app\'s camera process does', r.o.slice(0, 400));
    } else console.log('  skip  frame copy under Electron (Electron isn\'t installed: npm install on Node 22)');
  }
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pathline-run-cam-'));
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ controller: 'trotec', configured: true, name: 'Sim', bed: [1300, 900], sim: { speedup: 2000 },
    vision: { enabled: true, source: 'sim', matrix: [0, 0.07, 0.07, 0], board: { square: 50, across: 19, down: 9, every: 3 } } }));
  const port = 19100 + Math.floor(Math.random() * 500);
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js'), '--sim', '--port', String(port), '--data', data], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  srv.stdout.on('data', (d) => { out += d; });
  srv.stderr.on('data', (d) => { out += d; });
  srv.on('exit', (code, sig) => { out += '\n[server ended: ' + code + ' ' + (sig || '') + ']'; });
  const call = async (m, r, b) => {
    const res = await fetch('http://127.0.0.1:' + port + '/api/' + r, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  const jogTo = async (x, y) => { await call('POST', 'v1/jog', { x, y }); await new Promise((r) => setTimeout(r, 400)); };
  try {
    for (let i = 0; i < 50; i++) { try { await call('GET', 'v1/info'); break; } catch (e) { await new Promise((r) => setTimeout(r, 100)); } }
    // stage 1, camera: the camera over the small 10 mm board (laid at 7°, unevenly lit), where it
    // is: the head at the board's middle (745, 145) plus the camera's true offset (41.2, 12.9)
    await jogTo(786.2, 157.9);
    const px = await call('POST', 'local/camera/calibrate');
    ok(px.status === 200 && Math.abs(px.data.pixel - 0.08) < 0.0002 && Math.abs(Math.abs(px.data.rotation) - 90) < 0.2 && !px.data.mirrored,
      'stage 1, camera on the 10 mm board: ' + (px.data && px.data.corners) + ' corners, ' + (px.data && (px.data.pixel * 1000).toFixed(2)) + ' µm, picture turned ' + (px.data && px.data.rotation.toFixed(2)) + '° (80 µm, 90°)', JSON.stringify(px.data));
    await new Promise((r) => setTimeout(r, 400));
    const back = (await call('GET', 'v1/status')).data.pos;
    ok(Math.hypot(back.x - 786.2, back.y - 157.9) < 0.01, 'the camera over the board to start with (not moved to the laser\'s spot), and the head back there afterwards', JSON.stringify(back));
    // stage 2, offset: the laser cuts its mark on scrap at a clear spot, the camera finds it, then checks
    await jogTo(900, 150);
    const of = await call('POST', 'local/camera/offset', { power: 20, speed: 50 });
    ok(of.status === 200 && Math.abs(of.data.offset[0] - 41.2) < 0.2 && Math.abs(of.data.offset[1] - 12.9) < 0.2 && of.data.check < 0.05,
      'stage 2, offset from the cut: ' + (of.data && of.data.offset.join(', ')) + ' mm (41.2, 12.9), cut check ' + (of.data && (of.data.check * 1000).toFixed(0)) + ' µm off', JSON.stringify(of.data));
    // again with the stored offset's sign the other way (camera − laser, as Ruby's turned out to
    // be on the Trotec): the head first goes the wrong way, then looks where the flipped one puts it
    await call('PUT', 'local/config', { vision: { offset: [-41.437, -12.731] } });
    await jogTo(960, 150);
    const fl = await call('POST', 'local/camera/offset', { power: 20, speed: 50 });
    ok(fl.status === 200 && Math.abs(fl.data.offset[0] - 41.2) < 0.2 && Math.abs(fl.data.offset[1] - 12.9) < 0.2 && fl.data.check < 0.05,
      'stage 2 with the offset stored the other way round: found, ' + (fl.data && fl.data.offset && fl.data.offset.join(', ')) + ' mm (41.2, 12.9)', JSON.stringify(fl.data));
    // checkerboard: the laser head over its first corner (100, 300); calibrate, then check with the map on
    await jogTo(100, 300);
    const cal = await call('POST', 'local/camera/board', { mode: 'calibrate', board: { model: 'linear' } });
    ok(cal.status === 200 && cal.data.points.length >= 15 && Math.abs(cal.data.boardAngle - 1.5) < 0.1 && Math.abs(cal.data.scaleX - 1.5) < 0.15 && Math.abs(cal.data.squareness - 0.03) < 0.015,
      'bumpy checkerboard at 1.5°, uneven light: ' + (cal.data.points && cal.data.points.length) + ' corners, ' + cal.data.bumps + ' left out as bumps; X travel ' + (cal.data.scaleX || 0).toFixed(2) + ' mm/m (+1.5), Y leans ' + (cal.data.squareness || 0).toFixed(3) + '° (0.03)', JSON.stringify(cal.data).slice(0, 300));
    await jogTo(100, 300);
    const chk = await call('POST', 'local/camera/board', { mode: 'check', board: { model: 'linear' } });
    // (corners on the bump stay where the bump put them: the machine error is what's checked)
    const worstIn = (r) => Math.max(...r.points.filter((p) => !p.out).map((p) => Math.hypot(p.res[0], p.res[1])));
    ok(chk.status === 200 && worstIn(chk.data) < worstIn(cal.data) / 3 && Math.abs(chk.data.scaleX) < 0.2, 'with the bed map on: worst ' + worstIn(chk.data).toFixed(3) + ' mm off the bump (was ' + worstIn(cal.data).toFixed(3) + '), X travel ' + (chk.data.scaleX || 0).toFixed(2) + ' mm/m', JSON.stringify(chk.data).slice(0, 200));
    // print and cut jobs arrive with Anchor to toolhead on; these look for the marks where the job
    // has them, so it's switched off
    const unanchored = async (pkg) => {
      const r = await call('POST', 'v1/jobs', pkg);
      await call('POST', 'local/jobs/' + r.data.id + '/anchor', { clear: true });
      return r;
    };
    // print and cut: the example job's marks read, the job moved onto them and run
    const q = await unanchored(example);
    await new Promise((r) => setTimeout(r, 500));
    const st = await call('POST', 'v1/start', { id: q.data.id });
    let s;
    for (let i = 0; i < 200; i++) { await new Promise((r) => setTimeout(r, 250)); s = (await call('GET', 'v1/status')).data; if (s.state === 'idle' || s.state === 'alarm') break; }
    const log = (await call('GET', 'local/log')).data.join('\n');
    const fitLine = (log.match(/print and cut: .*/) || [''])[0];
    const rot = Number((fitLine.match(/rotation (-?[\d.]+)°/) || [])[1]);
    ok(st.status === 200 && s.state === 'idle' && s.progress === 1 && Math.abs(rot - 0.3) < 0.1, 'print and cut: 3 marks read, sheet turned ' + rot + '° (0.3), job run', fitLine + ' / ' + JSON.stringify(s));

    // the sheet laid 40 mm away from where the job expects it: mark 1 isn't found, the job waits,
    // the camera is jogged over the real mark by hand (jogs and the camera picture allowed
    // meanwhile), Accept, the dot finder takes it from there, and marks 2 and 3 follow by themselves
    // where the sim's sheet puts a design point (server.js: shifted 0.8, −0.5 mm and turned 0.3°)
    const sheet2 = (p) => { const a = (0.3 * Math.PI) / 180; return [0.8 + p[0] * Math.cos(a) - p[1] * Math.sin(a), -0.5 + p[0] * Math.sin(a) + p[1] * Math.cos(a)]; };
    const moved = JSON.parse(JSON.stringify(example));
    for (const t of moved.toolpath) if (t.type === 'inspect') t.at = [t.at[0] - 40, t.at[1]];
    const waitFor = async (fn, n = 200) => { let x; for (let i = 0; i < n; i++) { await new Promise((r) => setTimeout(r, 100)); x = (await call('GET', 'v1/status')).data; if (fn(x)) break; } return x; };
    const q2 = await unanchored(moved);
    await new Promise((r) => setTimeout(r, 300));
    await call('POST', 'v1/start', { id: q2.data.id });
    let w = await waitFor((x) => x.markWait || x.state === 'idle' || x.state === 'alarm');
    ok(w.markWait && w.markWait.mark === 1 && w.state === 'running' && /jog the camera over it/.test(w.message), 'sheet 40 mm off: mark 1 not found, the job waits for it to be found by hand', JSON.stringify(w));
    const offNow = (await call('GET', 'local/state')).data.config.vision.offset;
    const real = sheet2(example.toolpath.find((t) => t.type === 'inspect' && t.mark === 1).at);
    const jg = await call('POST', 'v1/jog', { x: real[0] + offNow[0] + 2, y: real[1] + offNow[1] - 1.5 }); // near it, not exactly on it
    const fr = await fetch('http://127.0.0.1:' + port + '/api/local/camera/frame?size=240');
    ok(jg.status === 200 && fr.status === 200, 'while it waits: jog allowed (' + jg.status + '), camera picture shown (' + fr.status + ')', JSON.stringify(jg.data));
    await new Promise((r) => setTimeout(r, 400));
    const acc = await call('POST', 'v1/marks/accept');
    w = await waitFor((x) => x.state === 'idle' || x.state === 'alarm');
    const log2 = (await call('GET', 'local/log')).data.join('\n');
    const byHand = (log2.match(/mark 1: found by hand, ([\d.]+) mm/) || [])[1];
    ok(acc.status === 200 && w.state === 'idle' && w.progress === 1 && Math.abs(Number(byHand) - 40) < 1.5, 'Accept: the dot finder found mark 1 from there (' + byHand + ' mm from where expected), 2 and 3 by themselves, the job ran', JSON.stringify(acc.data) + ' / ' + JSON.stringify(w));
    const late = await call('POST', 'v1/marks/accept');
    ok(late.status === 409, 'Accept with no mark waiting is refused', JSON.stringify(late.data));
    // Stop while waiting: stopped, not an alarm
    const q3 = await unanchored(moved);
    await new Promise((r) => setTimeout(r, 300));
    await call('POST', 'v1/start', { id: q3.data.id });
    w = await waitFor((x) => x.markWait || x.state === 'idle' || x.state === 'alarm');
    await call('POST', 'v1/stop');
    const after = await waitFor((x) => x.state === 'idle' || x.state === 'alarm');
    const jogAfter = await call('POST', 'v1/jog', { x: 500, y: 300 });
    ok(!!w.markWait && after.state === 'idle' && after.message === 'Stopped' && !after.markWait && jogAfter.status === 200, 'Stop while a mark waits: the job stops (no alarm), the machine is free again', JSON.stringify(after));
    // as it arrives (Anchor to toolhead on): the laser head put over the job's top-left corner on
    // the sheet, Start, the job moved there, and the camera finds all three marks by itself
    const q5 = await call('POST', 'v1/jobs', example);
    const j5 = (await call('GET', 'local/state')).data.jobs.find((j) => j.id === q5.data.id);
    const tl = require('../src/job/anchor').ref(example); // (its top-left mark)
    const onSheet = sheet2([tl[0], tl[1]]);
    await jogTo(onSheet[0], onSheet[1]);
    await call('POST', 'v1/start', { id: q5.data.id });
    const w5 = await waitFor((x) => x.markWait || x.state === 'idle' || x.state === 'alarm');
    if (w5.markWait) await call('POST', 'v1/stop');
    ok(j5 && j5.anchorAtStart === true && w5.state === 'idle' && w5.progress === 1 && !w5.markWait, 'print and cut anchored at the head (on as it arrives): the marks found by themselves, the job ran', JSON.stringify({ atStart: j5 && j5.anchorAtStart, w5 }));
    // the camera, not the laser, put over the top-left dot (J0064: every mark one camera offset
    // off): the first mark is looked for one offset over, found, and the job runs without a hand jog
    const q6 = await call('POST', 'v1/jobs', example);
    const offV = (await call('GET', 'local/state')).data.config.vision.offset;
    await jogTo(onSheet[0] + offV[0], onSheet[1] + offV[1]);
    await call('POST', 'v1/start', { id: q6.data.id });
    const w6 = await waitFor((x) => x.markWait || x.state === 'idle' || x.state === 'alarm');
    if (w6.markWait) await call('POST', 'v1/stop');
    const log6 = (await call('GET', 'local/log')).data || [];
    ok(w6.state === 'idle' && w6.progress === 1 && !w6.markWait && log6.some((l) => /the camera, not the laser, was put over the dot/.test(l)),
      'anchored with the camera over the dot in place of the laser: found one camera offset over, no hand jog, the job ran', JSON.stringify({ w6, start: [onSheet[0] + offV[0], onSheet[1] + offV[1]], last: log6.slice(-6) }));
    // a sheet that doesn't match the job (mark 3 printed 10 mm nearer than the job has it): the
    // marks are found, but they're not as far apart as the job's, so it stops before cutting
    const wrong = JSON.parse(JSON.stringify(example));
    const m3 = wrong.toolpath.find((t) => t.type === 'inspect' && t.mark === 3);
    m3.at = [m3.at[0] + 10, m3.at[1]];
    const q4 = await unanchored(wrong);
    await new Promise((r) => setTimeout(r, 300));
    await call('POST', 'v1/start', { id: q4.data.id });
    const ws = await waitFor((x) => x.markWait || x.state === 'idle' || x.state === 'alarm');
    if (ws.markWait) await call('POST', 'v1/stop');
    ok(ws.state === 'alarm' && /found [\d.]+ mm apart, but they are [\d.]+ mm apart in the job.*Nothing was cut/.test(ws.message) && !ws.progress, 'marks not as far apart as the job\'s: stopped before cutting', JSON.stringify(ws));
    const kept = fs.existsSync(path.join(data, 'marks', 'mark1.bin.gz')) && fs.existsSync(path.join(data, 'marks', 'mark3.json'));
    ok(kept, 'the pictures looked at for the marks are kept (data/marks)', fs.existsSync(path.join(data, 'marks')) ? fs.readdirSync(path.join(data, 'marks')).join(', ') : 'no marks folder');
    await call('POST', 'v1/alarm/clear');
  } catch (e) { ok(false, 'head camera', e.stack + '\n' + out.slice(-1500)); }
  srv.kill();
}

// ---------------------------------------------------------------- found on the network
// Run's mDNS answers, as Pathline Prepare asks for them (its own discover.js when it's in this
// repo): a question from an ordinary port is answered straight back, with id, name, port, IP
async function discoveryTests() {
  console.log('Found on the network (mDNS)');
  const disc = require('../src/discovery');
  const { _packet: P } = disc;
  const ifs = () => ({ eth: [{ family: 'IPv4', address: '192.168.5.20', netmask: '255.255.255.0' }], lab: [{ family: 'IPv4', address: '10.1.2.3', netmask: '255.255.0.0' }], lo: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }] });
  ok(disc.addresses(ifs()).map((a) => a.address).join() === '192.168.5.20,10.1.2.3', 'announced addresses leave out 127.x');
  ok(P.ordered(disc.addresses(ifs()), '10.1.9.9')[0] === '10.1.2.3', 'the address on the asker\'s network comes first');
  const rec = P.records({ id: 'run-0a1b2c3d', name: 'Q500 v2.1', type: 'laser', ctrl: 'Trotec', model: 'Q500', app: 'Pathline Run 0.7.12', port: 8470, hostname: 'SHOP PC_1', ips: ['10.1.2.3'] });
  ok(rec.instance === 'Q500 v2 1._pathline._tcp.local' && rec.host === 'SHOP-PC-1.local', 'instance and host names are single labels', rec.instance + ' / ' + rec.host);
  ok(!P.asksForUs({ name: '_printer._tcp.local', type: 12 }, rec) && P.asksForUs({ name: '_PATHLINE._tcp.local', type: 12 }, rec), 'answers _pathline._tcp.local only (any case)');

  let prep = null;
  try { prep = require('../../src/main/discover'); } catch (e) { /* Run on its own */ }
  let info = { id: 'run-0a1b2c3d', name: 'Shop Q500', type: 'laser', ctrl: 'Trotec', model: 'Speedy Q500', app: 'Pathline Run 0.7.12', port: 8471 };
  const r = disc.start(() => info, { port: 0, interfaces: () => ({ lo: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0' }] }) });
  await r.ready;
  try {
    if (prep) {
      const found = await prep.browse({ to: { address: '127.0.0.1', port: r.port() }, timeout: 600 });
      const m = found[0] || {};
      ok(found.length === 1 && m.id === 'run-0a1b2c3d' && m.name === 'Shop Q500' && m.port === 8471 && m.type === 'laser' && m.ctrl === 'Trotec' && m.via.includes('announce'), 'Prepare\'s browse() finds the machine (id, name, port, type)', JSON.stringify(found));
      info = { ...info, name: 'Shop Q500 renamed' };
      const again = await prep.browse({ to: { address: '127.0.0.1', port: r.port() }, timeout: 600 });
      ok(again[0] && again[0].name === 'Shop Q500 renamed' && again[0].id === 'run-0a1b2c3d', 'renamed: same id, new name');
    } else {
      // no Prepare here: ask by hand and read the answer back
      const dgram = require('dgram');
      const q = Buffer.concat([Buffer.from([0x12, 0x34, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]), Buffer.from('\x09_pathline\x04_tcp\x05local\x00', 'binary'), Buffer.from([0, 12, 0x80, 1])]);
      const ans = await new Promise((resolve) => { const s = dgram.createSocket('udp4'); s.on('message', (b) => { s.close(); resolve(b); }); s.bind(0, () => s.send(q, r.port(), '127.0.0.1')); setTimeout(() => { try { s.close(); } catch (e) { /* closed */ } resolve(null); }, 600); });
      ok(ans && ans.readUInt16BE(0) === 0x1234 && ans.includes(Buffer.from('id=run-0a1b2c3d')), 'a question from an ordinary port is answered straight back');
    }
    info = null;
    if (prep) ok((await prep.browse({ to: { address: '127.0.0.1', port: r.port() }, timeout: 400 })).length === 0, 'no machine set up: nothing is answered');
  } finally { await r.close(); }

  // the id in GET /info: made once, kept across restarts
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pathline-run-'));
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ controller: 'trotec', bed: [813, 508] }));
  const ids = [];
  for (let k = 0; k < 2; k++) {
    const port = 18970 + Math.floor(Math.random() * 400);
    const srv = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js'), '--sim', '--port', String(port), '--data', data], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      let inf = null;
      for (let i = 0; i < 60 && !inf; i++) { try { inf = await (await fetch('http://127.0.0.1:' + port + '/api/v1/info')).json(); } catch (e) { await new Promise((res) => setTimeout(res, 100)); } }
      ids.push(inf && inf.id);
    } finally { srv.kill(); await new Promise((res) => setTimeout(res, 300)); }
  }
  ok(/^run-[0-9a-f]{8}$/.test(ids[0] || '') && ids[0] === ids[1], 'GET /info has a stable id (' + ids[0] + ', the same after a restart)', JSON.stringify(ids));
}

jogTests().then(linkTests).then(serverTests).then(discoveryTests).then(materialsTests).then(visionTests).then(() => {
  console.log(failed ? '\n' + failed + ' FAILED' : '\nAll passed');
  process.exit(failed ? 1 : 0);
});

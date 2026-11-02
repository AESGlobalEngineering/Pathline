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
  const fires = cmds.filter((c, i) => c.name === 'SELECTPOWERLEVEL' && c.v[0] === 2 && cmds[i + 1].name === 'MOVEXY').length;
  ok(fires === 4, 'beam on (level 2) for each of the 4 sides', fires);
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
  const b0 = anchor.box(example);
  const moved = anchor.apply(example, { x: 300, y: 150 });
  const b1 = anchor.box(moved);
  ok(Math.abs(b1[0] - 300) < 1e-6 && Math.abs(b1[1] - 150) < 1e-6, 'job\'s top-left corner moves to the head (300, 150)', b1.join(', '));
  ok(Math.abs((b1[2] - b1[0]) - (b0[2] - b0[0])) < 1e-6, 'size unchanged');
  const dx = 300 - b0[0];
  ok(Math.abs(moved.entities[0].paths[0].p[0][0] - (example.entities[0].paths[0].p[0][0] + dx)) < 1e-3, 'shapes move with it (preview)');
  ok(example.toolpath[3].p === undefined || anchor.box(example)[0] === b0[0], 'the original package is untouched');
  let e3 = null; try { anchor.check(example, { x: 700, y: 400 }, [813, 508]); } catch (e) { e3 = e; }
  ok(e3 && e3.code === 409 && /leave the bed/.test(e3.message), 'anchoring where the job would leave the bed is refused', e3 && e3.message);
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
        // refuse the first few real data packets once with "buffer full", like a busy machine
        if (p.data.length > 1 && dev.full > 0) { dev.full--; s.write(sf.packet(p.id, null, null, 0x90)); continue; }
        if (p.data.length) dev.expect = (dev.expect + 1) & 0xff;
        dev.packets++; dev.ids.push(p.id); dev.data += p.data.length;
        for (const c of sf.decodeData(p.data)) if (c.name === 'MOVEXY') dev.pos = c.v;
        const ans = [];
        for (const op of p.imm) {
          if (op === 0x10) ans.push(0x11, 3, 0xff, 0, 0);
          else if (op === 0x2c) { const b = Buffer.alloc(9); b[0] = 0x2d; b.writeInt32BE(dev.pos[0], 1); b.writeInt32BE(dev.pos[1], 5); ans.push(...b); }
          else if (op === 0xa4) ans.push(0xa5, 0, 0);
          else { if (op === 0x02) dev.abort = true; ans.push(op + 1); }
        }
        s.write(sf.packet(p.id, Buffer.from(ans), null, 0x80));
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
    // a checkerboard corner at an angle the board needn't be square: found, and its angle read
    const { SimCamera } = require('../src/vision/camera');
    const detect = require('../src/vision/detect');
    const sc = new SimCamera({ truth: { offset: [0, 0], pixel: 0.08, rotation: 0 }, scene: { board: { x: 500, y: 400, angle: 25, square: 50, nx: 6, ny: 6 } }, headAt: () => ({ x: 502, y: 399 }) });
    const c = detect.findCorner(await sc.grab());
    // the corner is 2 mm left of and 1 mm below the picture's middle: 25 px, 12.5 px at 80 µm
    // (the angle only aims the scan at the next corner; the board's angle comes from the corners found)
    ok(c && Math.abs(c.x - (239.5 - 25)) < 0.5 && Math.abs(c.y - (239.5 + 12.5)) < 0.5 && Math.abs(c.angle - 25) < 3, 'checkerboard corner at 25°: found to a fraction of a pixel, angle ' + (c && c.angle.toFixed(1)) + '° (a hint, within 3°)', JSON.stringify(c));
  }
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pathline-run-cam-'));
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ controller: 'trotec', configured: true, name: 'Sim', bed: [1300, 900], sim: { speedup: 2000 },
    vision: { enabled: true, source: 'sim', matrix: [0, 0.07, 0.07, 0], board: { square: 50, across: 19, down: 9, every: 3 } } }));
  const port = 19100 + Math.floor(Math.random() * 500);
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js'), '--sim', '--port', String(port), '--data', data], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  srv.stdout.on('data', (d) => { out += d; });
  srv.stderr.on('data', (d) => { out += d; });
  const call = async (m, r, b) => {
    const res = await fetch('http://127.0.0.1:' + port + '/api/' + r, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  const jogTo = async (x, y) => { await call('POST', 'v1/jog', { x, y }); await new Promise((r) => setTimeout(r, 400)); };
  try {
    for (let i = 0; i < 50; i++) { try { await call('GET', 'v1/info'); break; } catch (e) { await new Promise((r) => setTimeout(r, 100)); } }
    // pixel size: the camera over the first mark (sheet ≈ 40.7, 24.7), head = camera + offset
    await jogTo(40.7 + 41.4, 24.7 + 12.7);
    const px = await call('POST', 'local/camera/pixels');
    ok(px.status === 200 && Math.abs(px.data.pixel - 0.08) < 0.0005 && Math.abs(Math.abs(px.data.rotation) - 90) < 0.5, 'pixel size and rotation: ' + (px.data && (px.data.pixel * 1000).toFixed(2)) + ' µm, ' + (px.data && px.data.rotation.toFixed(2)) + '° (80 µm, 90°)', JSON.stringify(px.data));
    // offset: the laser marks scrap at a clear spot, the camera finds it
    await jogTo(900, 150);
    const of = await call('POST', 'local/camera/offset', { power: 20, speed: 50 });
    ok(of.status === 200 && Math.abs(of.data.offset[0] - 41.2) < 0.2 && Math.abs(of.data.offset[1] - 12.9) < 0.2, 'camera offset from a laser mark: ' + (of.data && of.data.offset.join(', ')) + ' mm (41.2, 12.9)', JSON.stringify(of.data));
    // checkerboard: camera over its first corner (100, 300); calibrate, then check with the map on
    const off = of.data.offset;
    await jogTo(100 + off[0], 300 + off[1]);
    const cal = await call('POST', 'local/camera/board', { mode: 'calibrate' });
    ok(cal.status === 200 && cal.data.points.length >= 15 && Math.abs(cal.data.boardAngle - 1.5) < 0.1 && Math.abs(cal.data.scaleX + 1.5) < 0.3,
      'checkerboard at 1.5°: ' + (cal.data.points && cal.data.points.length) + ' corners, board at ' + (cal.data.boardAngle || 0).toFixed(2) + '°, machine X ' + (cal.data.scaleX || 0).toFixed(2) + ' mm/m (−1.5), worst ' + (cal.data.worst || 0).toFixed(3) + ' mm', JSON.stringify(cal.data).slice(0, 300));
    await jogTo(100 + off[0], 300 + off[1]);
    const chk = await call('POST', 'local/camera/board', { mode: 'check' });
    ok(chk.status === 200 && chk.data.worst < cal.data.worst / 3, 'with the bed map on: worst ' + (chk.data.worst || 0).toFixed(3) + ' mm (was ' + (cal.data.worst || 0).toFixed(3) + ')', JSON.stringify(chk.data).slice(0, 200));
    // print and cut: the example job's marks read, the job moved onto them and run
    const q = await call('POST', 'v1/jobs', example);
    await new Promise((r) => setTimeout(r, 500));
    const st = await call('POST', 'v1/start', { id: q.data.id });
    let s;
    for (let i = 0; i < 200; i++) { await new Promise((r) => setTimeout(r, 250)); s = (await call('GET', 'v1/status')).data; if (s.state === 'idle' || s.state === 'alarm') break; }
    const log = (await call('GET', 'local/log')).data.join('\n');
    const fitLine = (log.match(/print and cut: .*/) || [''])[0];
    const rot = Number((fitLine.match(/rotation (-?[\d.]+)°/) || [])[1]);
    ok(st.status === 200 && s.state === 'idle' && s.progress === 1 && Math.abs(rot - 0.3) < 0.1, 'print and cut: 3 marks read, sheet turned ' + rot + '° (0.3), job run', fitLine + ' / ' + JSON.stringify(s));
  } catch (e) { ok(false, 'head camera', e.stack + '\n' + out.slice(-1500)); }
  srv.kill();
}

jogTests().then(linkTests).then(serverTests).then(visionTests).then(() => {
  console.log(failed ? '\n' + failed + ' FAILED' : '\nAll passed');
  process.exit(failed ? 1 : 0);
});

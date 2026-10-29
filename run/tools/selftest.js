#!/usr/bin/env node
// Self-test: protocol encoders against known bytes (TROTEC_PROTOCOL.md captures,
// Ruida wiki examples), conversion of the example jobs, and the HTTP protocol
// against a simulated machine (with Pathline's own check-hmi.js when available).
//   node tools/selftest.js
'use strict';

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
  const magic = 0x88;
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
      rdev.cmds.push(c[0]);
      if (c[0] === 0xda && c[1] === 0x00) {
        const addr = (c[2] << 8) | c[3];
        const v = addr === 0x057e ? 0x6445 : addr === 0x0400 ? 0 : addr === 0x0421 ? 850000 : addr === 0x0431 ? 20000 : 0;
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
    const prog = ruida.compile(plan.build(example), cfgR);
    const before = rdev.bytes;
    for (const s of prog.segments.filter((x) => x.kind === 'stream')) await rl.send(s, {});
    const total = prog.segments.filter((x) => x.kind === 'stream').reduce((a, s) => a + s.data.length, 0);
    ok(rdev.bytes - before === total && rdev.sumOk, 'whole example sent in checked packets (' + total + ' bytes)');
    await rl.abort();
    ok(rdev.cmds[rdev.cmds.length - 1] === 0xd8, 'stop (D8 01) reaches the controller');
  } catch (e) { ok(false, 'Ruida link', e.stack); }
  await rl.close();
  sock.close();
}

linkTests().then(serverTests).then(() => {
  console.log(failed ? '\n' + failed + ' FAILED' : '\nAll passed');
  process.exit(failed ? 1 : 0);
});

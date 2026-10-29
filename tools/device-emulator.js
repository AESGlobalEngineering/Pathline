#!/usr/bin/env node
// Stand-in for the controller device (HMI) that runs the machine. Implements
// the protocol in PROTOCOL.md so the app can be tested end to end without
// hardware. Nothing here moves a real machine.
//
//   node tools/device-emulator.js [--port 8470] [--type laser|plotter] [--name "Trotec Speedy 360"] [--speed 20]
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const PORT = Number(arg('port', 8470));
const TYPE = arg('type', 'laser');
const SPEEDUP = Number(arg('speed', 20)); // run received jobs this many times faster than real time
const OUT = path.resolve(arg('out', path.join(__dirname, '..', 'received-jobs')));

const machine = TYPE === 'plotter'
  ? {
    name: arg('name', 'Flatbed 1'), type: 'plotter', ctrl: 'Ruida', bed: [1600, 1000], speed: 1000, acc: 8000, origin: 'tl', units: 'mm', home: true, prefix: 'FLT-',
    heads: [{ slot: 'T1', tool: 'Knife', x: '0.00', y: '0.00', loaded: true }, { slot: 'T2', tool: 'V-cut 45°', x: '24.50', y: '0.00', loaded: true }, { slot: 'T3', tool: 'Crease wheel', x: '49.00', y: '0.00', loaded: true }, { slot: 'T4', tool: 'Pen', x: '73.50', y: '0.00', loaded: true }],
    feedLen: 1000, f: { conveyor: true, vacuum: true, pointer: true, camera: false, detect: true }
  }
  : {
    name: arg('name', 'Trotec Speedy 360'), type: 'laser', ctrl: 'Trotec', bed: [813, 508], speed: 3550, acc: 50000, origin: 'tl', units: 'mm', home: true, prefix: 'TRO-',
    source: 'CO2', power: 80, lens: '2.0"', pwm: 5000, minPower: 8, f: { camera: true, autofocus: true, rotary: false, air: true, pass: false, interlock: true }
  };

const st = {
  state: 'idle', pos: { x: 0, y: 0, z: 0 },
  io: { air: false, pointer: false, vacuum: false, exhaust: true }, interlocks: { lid: true, exhaust: true },
  job: null, progress: 0, message: 'Ready'
};
const jobs = [];
let runTimer = null;

function log(...a) { console.log(new Date().toLocaleTimeString(), ...a); }
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function startNext() {
  if (st.state !== 'idle') return;
  const next = jobs.find((j) => j.status === 'queued');
  if (!next) return;
  next.status = 'running';
  st.state = 'running';
  st.job = next.id;
  st.progress = 0;
  st.message = 'Running ' + next.name;
  const total = Math.max(1, next.seconds);
  const t0 = Date.now();
  log('run', next.name, '(' + total + ' s estimated, simulated ' + SPEEDUP + '× faster)');
  runTimer = setInterval(() => {
    if (st.state === 'paused') return;
    const el = ((Date.now() - t0) / 1000) * SPEEDUP;
    st.progress = Math.min(1, el / total);
    const b = next.bbox;
    if (b) {
      const k = (el * 7) % 1;
      st.pos.x = +(b[0] + (b[2] - b[0]) * k).toFixed(2);
      st.pos.y = +(b[1] + (b[3] - b[1]) * ((el * 0.37) % 1)).toFixed(2);
    }
    if (st.progress >= 1) {
      clearInterval(runTimer);
      next.status = 'done';
      next.finishedAt = new Date().toISOString();
      st.state = 'idle'; st.job = null; st.message = 'Finished ' + next.name;
      log('done', next.name);
      setTimeout(startNext, 500);
    }
  }, 250);
}

function body(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => { n += c.length; if (n > 200 * 1024 * 1024) { reject(new Error('Too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8');
      try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(new Error('Body is not JSON')); }
    });
  });
}

function send(res, code, data) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

const busy = () => st.state === 'running' || st.state === 'framing';
const routes = {
  'GET /info': () => ({ name: machine.name, type: machine.type, ctrl: machine.ctrl, model: machine.name, firmware: 'emulator 1.0', protocol: 1, bed: machine.bed }),
  'GET /machine': () => machine,
  'GET /status': () => ({ ...st, pos: { ...st.pos }, queued: jobs.filter((j) => j.status === 'queued').length }),
  'GET /jobs': () => jobs.map(({ id, name, status, seconds, receivedAt, finishedAt }) => ({ id, name, status, seconds, receivedAt, finishedAt, progress: id === st.job ? st.progress : status === 'done' ? 1 : 0 })),
  // reorder waiting jobs: { ids: [...] } in the new order
  'POST /jobs/order': (b) => {
    const ids = Array.isArray(b.ids) ? b.ids : [];
    const rank = (j) => { const k = ids.indexOf(j.id); return k < 0 ? Infinity : k; };
    const queued = jobs.filter((j) => j.status === 'queued').sort((a, c) => rank(a) - rank(c));
    let k = 0;
    for (let i = 0; i < jobs.length; i++) if (jobs[i].status === 'queued') jobs[i] = queued[k++];
    log('queue order', jobs.filter((j) => j.status === 'queued').map((j) => j.id).join(', '));
    return { ok: true };
  },
  'POST /jobs': (b) => {
    if (b.format !== 'lrc-job-package') throw Object.assign(new Error('Not a job package'), { code: 400 });
    const id = 'J' + String(jobs.length + 1).padStart(4, '0');
    const bb = [Infinity, Infinity, -Infinity, -Infinity];
    (b.entities || []).forEach((e) => e.paths.forEach((p) => p.p.forEach(([x, y]) => {
      bb[0] = Math.min(bb[0], x); bb[1] = Math.min(bb[1], y); bb[2] = Math.max(bb[2], x); bb[3] = Math.max(bb[3], y);
    })));
    const job = {
      id, name: (b.job && b.job.name) || id, status: 'queued', seconds: (b.estimate && b.estimate.totalSeconds) || 60,
      receivedAt: new Date().toISOString(), bbox: Number.isFinite(bb[0]) ? bb : null
    };
    jobs.push(job);
    fs.mkdirSync(OUT, { recursive: true });
    const dir = path.join(OUT, id + ' ' + job.name.replace(/[\\/:*?"<>|]+/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    const files = b.files || {};
    delete b.files;
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(b, null, 2));
    if (files.dxf) fs.writeFileSync(path.join(dir, 'job.dxf'), files.dxf);
    if (files.svg) fs.writeFileSync(path.join(dir, 'job.svg'), files.svg);
    if (files.sheet) fs.writeFileSync(path.join(dir, 'job-sheet.txt'), files.sheet);
    log('received', job.name, '·', (b.processes || []).length, 'processes ·', b.estimate && b.estimate.total, '→', dir);
    return { id, status: 'queued' };
  },
  'POST /start': () => { startNext(); return { state: st.state }; },
  'POST /pause': () => { if (st.state === 'running') st.state = 'paused'; return { state: st.state }; },
  'POST /resume': () => { if (st.state === 'paused') st.state = 'running'; return { state: st.state }; },
  'POST /stop': () => {
    clearInterval(runTimer);
    const j = jobs.find((x) => x.id === st.job);
    if (j) j.status = 'stopped';
    st.state = 'idle'; st.job = null; st.message = 'Stopped';
    log('STOP');
    return { state: st.state };
  },
  'POST /jog': (b) => {
    if (busy()) throw Object.assign(new Error('Machine is busy'), { code: 409 });
    if (b.x !== undefined || b.y !== undefined) {
      // absolute move
      if (b.x !== undefined) st.pos.x = clamp(Number(b.x), 0, machine.bed[0]);
      if (b.y !== undefined) st.pos.y = clamp(Number(b.y), 0, machine.bed[1]);
    } else {
      const d = Number(b.distance) || 0;
      if (b.axis === 'x') st.pos.x = clamp(st.pos.x + d, 0, machine.bed[0]);
      else if (b.axis === 'y') st.pos.y = clamp(st.pos.y + d, 0, machine.bed[1]);
      else if (b.axis === 'z') st.pos.z = clamp(st.pos.z + d, -50, 50);
      else throw Object.assign(new Error('axis must be x, y or z'), { code: 400 });
    }
    st.pos.x = +st.pos.x.toFixed(3); st.pos.y = +st.pos.y.toFixed(3); st.pos.z = +st.pos.z.toFixed(3);
    log('jog', JSON.stringify(b), '→', st.pos.x, st.pos.y);
    return { pos: st.pos };
  },
  'POST /home': () => { if (busy()) throw Object.assign(new Error('Machine is busy'), { code: 409 }); st.pos = { x: 0, y: 0, z: 0 }; log('home'); return { pos: st.pos }; },
  'POST /frame': (b) => {
    if (busy()) throw Object.assign(new Error('Machine is busy'), { code: 409 });
    const box = b.box || [0, 0, 100, 100];
    log('frame', box.map((v) => Number(v).toFixed(1)).join(', '));
    st.state = 'framing';
    const corners = [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]], [box[0], box[1]]];
    let k = 0;
    const t = setInterval(() => {
      [st.pos.x, st.pos.y] = corners[k++];
      if (k >= corners.length) { clearInterval(t); st.state = 'idle'; }
    }, 400);
    return { state: 'framing' };
  },
  'POST /io': (b) => { for (const k of Object.keys(b)) if (k in st.io) st.io[k] = !!b[k]; log('io', JSON.stringify(st.io)); return { io: st.io }; },
  'POST /autofocus': () => { log('autofocus'); st.pos.z = 0; return { z: 0 }; },
  'POST /testfire': (b) => { log('test fire', JSON.stringify(b)); return { fired: true }; },
  'POST /feed': (b) => { log('conveyor feed', b.length || machine.feedLen, 'mm'); return { fed: b.length || machine.feedLen }; },
  'POST /toolchange': (b) => { log('tool change', b.slot); return { slot: b.slot }; }
};

const page = () => `<!doctype html><meta charset="utf-8"><title>${machine.name} · emulator</title>
<style>body{font:14px system-ui;margin:24px;color:#15181E}code{background:#F0F1F4;padding:2px 6px;border-radius:4px}td{padding:4px 12px 4px 0}</style>
<h2>${machine.name} — device emulator</h2><p>State <b id="s"></b> · position <code id="p"></code> · <span id="m"></span></p>
<h3>Jobs</h3><table id="j"></table>
<script>async function t(){const s=await (await fetch('/api/v1/status')).json();document.getElementById('s').textContent=s.state+(s.state==='running'?' '+Math.round(s.progress*100)+'%':'');document.getElementById('p').textContent='X '+s.pos.x+'  Y '+s.pos.y+'  Z '+s.pos.z;document.getElementById('m').textContent=s.message;const j=await (await fetch('/api/v1/jobs')).json();document.getElementById('j').innerHTML=j.map(x=>'<tr><td>'+x.id+'</td><td>'+x.name+'</td><td>'+x.status+'</td><td>'+Math.round(x.seconds)+' s</td></tr>').join('')}setInterval(t,700);t()</script>`;

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/hmi')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(page());
  }
  const route = req.method + ' ' + url.pathname.replace(/^\/api\/v1/, '');
  // DELETE /jobs/<id>: remove a job that hasn't started
  const del = route.match(/^DELETE \/jobs\/(.+)$/);
  if (del) {
    const id = decodeURIComponent(del[1]);
    const i = jobs.findIndex((j) => j.id === id);
    if (i < 0) return send(res, 404, { error: 'No job ' + id });
    if (jobs[i].status === 'running') return send(res, 409, { error: 'Job is running — stop it first' });
    jobs.splice(i, 1);
    log('removed', id);
    return send(res, 200, { ok: true });
  }
  const fn = routes[route];
  if (!fn) return send(res, 404, { error: 'No route ' + route });
  try {
    const b = req.method === 'POST' ? await body(req) : {};
    send(res, 200, fn(b) || {});
  } catch (err) {
    send(res, err.code || 500, { error: err.message });
  }
}).listen(PORT, () => {
  log(machine.name + ' emulator (' + machine.type + ') on http://localhost:' + PORT + '  — received jobs go to ' + OUT);
});

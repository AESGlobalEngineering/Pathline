#!/usr/bin/env node
// Self-test for Pathline Monitor's watcher: a stand-in Pathline Run is put through each case and
// the alerts that come out are checked (which send one, which don't).
//   node test.js
'use strict';
const http = require('http');
const { Watcher } = require('./lib/watch');

let failed = 0;
const ok = (c, msg) => { console.log((c ? '  ok    ' : '  FAIL  ') + msg); if (!c) failed++; };

// a stand-in Run: what /api/local/state and /api/v1/info answer is set by the test
const run = { up: true, info: { name: 'Laser T', type: 'laser', ctrl: 'Trotec', model: 'Speedy 400' }, state: null };
const base = () => ({ status: { state: 'idle', link: 'online', progress: 0, job: null, message: '', interlock: false }, jobs: [], history: [], config: { name: 'Laser T', controller: 'trotec' } });
run.state = base();
const server = http.createServer((req, res) => {
  if (!run.up) { req.socket.destroy(); return; }
  const v = req.url === '/api/v1/info' ? run.info : req.url === '/api/local/state' ? run.state : null;
  res.writeHead(v ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify(v || { error: 'no' }));
});

server.listen(0, async () => {
  const port = server.address().port;
  let clock = Date.parse('2026-11-10T10:00:00');
  const alerts = [];
  const w = new Watcher([{ name: 'Laser T', host: '127.0.0.1', port }], { now: () => clock, onAlert: (a) => alerts.push(a) });
  const m = w.list[0];
  const step = async (ms = 2000) => { clock += ms; await w.poll(m); };
  const took = () => alerts.splice(0);
  const job = (id, name, extra) => ({ id, name, status: 'queued', progress: 0, seconds: 600, material: 'Birch ply 3 mm', ...extra });

  console.log('Pathline Monitor watcher');
  await step();
  ok(m.view.state === 'idle' && !took().length, 'first look: idle, nothing sent');

  run.state.jobs = [job('J1', 'Coasters'), job('J2', 'Name badges')];
  run.state.status = { ...run.state.status, state: 'running', job: 'J1', progress: 0.25 };
  run.state.jobs[0].status = 'running';
  await step();
  ok(m.view.state === 'running' && m.view.job.name === 'Coasters' && m.view.queue.length === 1, 'running: the job, and one queued after it');
  ok(Math.round(m.view.job.seconds * (1 - m.view.job.progress)) === 450, 'running: 450 s left of 600');
  ok(!took().length, 'starting a job sends nothing');

  run.state.status = { ...run.state.status, interlock: true };
  await step();
  ok(m.view.state === 'lid' && !took().length, 'lid opened at the machine: shown, no alert');
  run.state.status = { ...run.state.status, interlock: false, state: 'paused' };
  await step();
  ok(m.view.state === 'paused' && !took().length, 'paused at the machine: shown, no alert');

  run.state.status = { ...run.state.status, state: 'running', markWait: { mark: 2, of: 3, near: [10, 10] } };
  await step();
  let a = took();
  ok(m.view.state === 'mark' && a.length === 1 && a[0].kind === 'attn' && /mark 2 of 3/.test(a[0].body), 'registration mark not found: one "needs you" alert');
  await step();
  ok(!took().length, 'still waiting: no second alert');

  // J1 finishes with J2 still queued
  run.state.status = { ...run.state.status, state: 'idle', job: null, markWait: null, progress: 0 };
  run.state.jobs[0].status = 'done';
  run.state.history = [{ id: 'J1', name: 'Coasters', material: 'Birch ply 3 mm', startedAt: new Date(clock - 600000).toISOString(), finishedAt: new Date(clock).toISOString(), seconds: 602, result: 'Completed' }];
  await step();
  a = took();
  ok(a.length === 1 && a[0].kind === 'done' && a[0].title === 'Laser T finished Coasters' && /1 job waiting: press Start/.test(a[0].body), 'finished with a job queued: one alert, saying what\'s waiting');
  ok(a[0] && a[0].tags.join() === 'done', 'that alert is a "finished" alert only (the queue isn\'t empty)');
  ok(m.view.state === 'done' && m.view.lastDone === 'Coasters', 'shown as Finished, waiting for Start');

  // J2 runs and is stopped
  run.state.jobs[1].status = 'running';
  run.state.status = { ...run.state.status, state: 'running', job: 'J2', progress: 0.1 };
  await step();
  run.state.status = { ...run.state.status, state: 'idle', job: null };
  run.state.jobs[1].status = 'stopped';
  run.state.history.unshift({ id: 'J2', name: 'Name badges', startedAt: new Date(clock - 60000).toISOString(), finishedAt: new Date(clock).toISOString(), seconds: 61, result: 'Stopped' });
  await step();
  a = took();
  ok(a.length === 1 && a[0].kind === 'err' && /stopped Name badges/.test(a[0].title), 'a stopped job: one "stopped" alert');
  ok(m.view.state === 'idle' && m.view.today.length === 2, 'idle, with both jobs in today\'s list');

  // the last job finishing empties the queue: the alert carries both tags
  run.state.jobs.push(job('J3', 'Keyrings', { status: 'running' }));
  run.state.status = { ...run.state.status, state: 'running', job: 'J3', progress: 0.9 };
  await step();
  run.state.status = { ...run.state.status, state: 'idle', job: null };
  run.state.jobs[2].status = 'done';
  run.state.history.unshift({ id: 'J3', name: 'Keyrings', startedAt: new Date(clock - 60000).toISOString(), finishedAt: new Date(clock).toISOString(), seconds: 64, result: 'Completed' });
  await step();
  a = took();
  ok(a.length === 1 && a[0].tags.join() === 'done,queue' && /queue empty/.test(a[0].body), 'the queue running out: one alert, as finished and queue empty');

  // the controller has an error
  run.state.status = { ...run.state.status, state: 'alarm', message: 'Lid interlock tripped during the job' };
  await step();
  a = took();
  ok(a.length === 1 && a[0].kind === 'err' && /has an error/.test(a[0].title), 'an error: one alert');
  run.state.status = { ...run.state.status, state: 'idle', message: '' };
  await step(); took();

  // Run stops answering: nothing for a blip, an alert once it's been 20 s, then "back"
  run.up = false;
  await step();
  ok(m.view.state === 'idle' && !took().length, 'one missed answer: still shown as it was, nothing sent');
  await step(25000);
  a = took();
  ok(m.view.state === 'offline' && a.length === 1 && /stopped answering/.test(a[0].title), 'not answering for 20 s: offline, one alert');
  run.up = true;
  await step();
  a = took();
  ok(m.view.state !== 'offline' && a.length === 1 && a[0].kind === 'info' && !a[0].tags.length, 'answering again: a "back" note that isn\'t pushed');

  // Run answers but has lost the laser
  run.state.status = { ...run.state.status, link: 'connecting' };
  await step(); await step(25000);
  a = took();
  ok(m.view.state === 'offline' && /lost its laser/.test((a[0] || {}).title || ''), 'Run up but the laser lost: offline, one alert');

  // ---- Pathline Run 0.7.12 and later: GET /api/v1/monitor and the /api/v1/events stream
  console.log('Pathline Run 0.7.12+ (watcher answer and live stream)');
  const iso = (t) => new Date(t).toISOString();
  const mon = {
    id: 'run-3f9c2a71', name: 'Plotter P', type: 'plotter', ctrl: 'Ruida', model: 'RDC6445', app: 'Pathline Run 0.7.12',
    link: 'online', state: 'running', since: iso(Date.now() - 300000), message: '', interlock: false, interlockSince: null, markWait: null,
    job: { id: 'P1', name: 'Foam signs', material: 'Foam board 5 mm', seconds: 1200, progress: 0.5, elapsed: 650, remaining: 480, startedAt: iso(Date.now() - 650000), beds: [2, 3] },
    queue: [{ id: 'P2', name: 'Window decals', material: 'Vinyl', seconds: 540, autoStart: true }, { id: 'P3', name: 'Stickers', material: 'Vinyl', seconds: 300, autoStart: false }],
    today: [],
  };
  const sse = new Set();
  const push = () => { for (const r of sse) r.write('data: ' + JSON.stringify(mon) + '\n\n'); };
  const run2 = http.createServer((req, res) => {
    if (req.url === '/api/v1/monitor') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(mon)); }
    if (req.url === '/api/v1/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('retry: 2000\n\ndata: ' + JSON.stringify(mon) + '\n\n'); sse.add(res); req.on('close', () => sse.delete(res)); return; }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"No route"}');
  });
  await new Promise((r) => run2.listen(0, r));
  const alerts2 = [];
  let changes = 0;
  const w2 = new Watcher([{ host: '127.0.0.1', port: run2.address().port, found: true }], { onAlert: (x) => alerts2.push(x), onChange: () => changes++ });
  const p = w2.list[0];
  await w2.poll(p);
  ok(p.api === 'monitor' && p.view.source === 'monitor', 'it reads /api/v1/monitor, not the screen\'s data');
  ok(p.view.name === 'Plotter P' && p.view.kind === 'plotter' && p.conf.deviceId === 'run-3f9c2a71', 'name, kind and Run\'s id from the answer');
  ok(p.view.job.remaining === 480 && p.view.job.beds.join() === '2,3', 'Run\'s own time left (480 s, not 600) and the bed it\'s on');
  ok(p.view.queue[0].autoStart && !p.view.queue[1].autoStart, 'which queued job starts by itself');
  // the stream: changes arrive without asking
  const waitFor = async (f, t = 3000) => { const end = Date.now() + t; while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 20)); return f(); };
  ok(await waitFor(() => sse.size === 1), 'it opens the live stream');
  mon.state = 'running'; mon.markWait = { mark: 2, of: 3, since: iso(Date.now() - 120000) };
  push();
  ok(await waitFor(() => alerts2.length === 1), 'a mark not found arrives over the stream, without a poll');
  ok(p.view.state === 'mark' && Math.abs(p.view.since - (Date.now() - 120000)) < 2000, 'waiting since Run\'s own time (2 min ago), not since the hub saw it');
  alerts2.splice(0);
  // P1 finishes; P2 starts by itself (a plotter's Select run)
  mon.markWait = null; mon.state = 'idle'; mon.job = null;
  mon.today = [{ id: 'P1', name: 'Foam signs', material: 'Foam board 5 mm', seconds: 1207, result: 'Completed', startedAt: iso(Date.now() - 1207000), finishedAt: iso(Date.now()) }];
  push();
  ok(await waitFor(() => alerts2.length === 1), 'the finished job arrives over the stream');
  ok(/starts next by itself/.test(alerts2[0].body) && !/press Start/.test(alerts2[0].body), 'the alert says the next job starts by itself, not "press Start"');
  ok(p.view.state === 'idle', 'not shown as waiting for Start');
  push();
  await new Promise((r) => setTimeout(r, 150));
  ok(alerts2.length === 1, 'the same answer again: no second alert');
  ok(changes > 0, 'each change goes on to the phones');
  // the stream drops: it's asked again, and listened to again
  for (const r of sse) r.destroy();
  ok(await waitFor(() => !p.live), 'a dropped stream is noticed');
  await w2.poll(p);
  ok(await waitFor(() => sse.size === 1) && p.view.state === 'idle', 'asked again, and the stream reopened');
  w2.stop();
  for (const r of sse) r.destroy();
  run2.close();

  // the workshop certificate (lib/certs.js)
  console.log('Workshop certificate');
  const certs = require('./lib/certs');
  const crypto = require('crypto');
  const fs = require('fs');
  const dir = fs.mkdtempSync(require('path').join(require('os').tmpdir(), 'pm-certs-'));
  const c1 = certs.ensure(dir, ['192.168.1.54', '203.0.113.9']);
  const leaf = new crypto.X509Certificate(c1.cert);
  const auth = new crypto.X509Certificate(c1.ca.pem);
  ok(auth.ca && leaf.checkIssued(auth) && leaf.verify(auth.publicKey), 'this computer\'s certificate is signed by the workshop authority');
  ok(leaf.checkIP('192.168.1.54') && leaf.checkIP('127.0.0.1') && !leaf.checkIP('203.0.113.9'), 'it covers the private address, not the public one');
  ok(Date.parse(leaf.validTo) - Date.now() <= 398 * 864e5, 'it lasts no more than 398 days (phones refuse longer)');
  ok(require('node-forge').pki.certificateFromPem(c1.ca.pem).extensions.some((e) => e.id === '2.5.29.30' && e.critical), 'the authority is limited to private networks (name constraints)');
  ok(certs.ensure(dir, ['192.168.1.54', '203.0.113.9']).cert === c1.cert, 'started again: the same certificate');
  const c2 = certs.ensure(dir, ['192.168.1.77']);
  ok(c2.cert !== c1.cert && new crypto.X509Certificate(c2.cert).checkIP('192.168.1.77') && c2.ca.pem === c1.ca.pem, 'a new address: a new certificate from the same authority');
  ok(/com\.apple\.security\.root/.test(certs.mobileconfig(c1.ca)), 'the iPhone profile carries the authority');
  fs.rmSync(dir, { recursive: true, force: true });

  console.log(failed ? '\n' + failed + ' failed' : '\nAll passed');
  server.close();
  process.exit(failed ? 1 : 0);
});

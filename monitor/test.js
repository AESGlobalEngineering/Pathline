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

  console.log(failed ? '\n' + failed + ' failed' : '\nAll passed');
  server.close();
  process.exit(failed ? 1 : 0);
});

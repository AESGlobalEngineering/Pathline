#!/usr/bin/env node
// Protocol check for a Pathline controller/HMI. Talks to the device the way
// Pathline does (see PROTOCOL.md) and reports what doesn't match.
//
//   node tools/check-hmi.js <host> [--port 8470] [--allow-motion] [--run]
//
// By default it only reads, and queues/removes two test jobs. Nothing moves.
//   --allow-motion  also home, jog and frame (the machine WILL move)
//   --run           also start a test job, pause, resume and stop it (the machine WILL run it)
// Needs Node.js 18 or newer (built-in fetch). No other dependencies.
'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const flag = (k) => args.includes('--' + k);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const host = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--port');
if (!host) {
  console.log('Usage: node tools/check-hmi.js <host> [--port 8470] [--allow-motion] [--run]');
  process.exit(2);
}
const PORT = Number(opt('port', 8470));
const BASE = 'http://' + host + ':' + PORT + '/api/v1';
const TIMEOUT = 3000; // Pathline's default per-machine timeout
const EXAMPLES = path.join(__dirname, '..', 'examples');

let failed = 0, warned = 0;
const ok = (cond, msg, detail) => {
  console.log((cond ? '  ok    ' : '  FAIL  ') + msg + (!cond && detail ? '\n          ' + detail : ''));
  if (!cond) failed++;
  return cond;
};
const warn = (msg) => { console.log('  warn  ' + msg); warned++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => typeof v === 'number' && Number.isFinite(v);

async function call(method, route, body) {
  const t0 = Date.now();
  const res = await fetch(BASE + route, {
    method, headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(method === 'POST' && route === '/jobs' ? 30000 : TIMEOUT)
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = undefined; }
  return { status: res.status, ok: res.ok, data, text, ms: Date.now() - t0, type: res.headers.get('content-type') || '' };
}
// every error must be non-2xx with { error: "message" } (Pathline shows the message)
const isError = (r) => !r.ok && r.data && typeof r.data.error === 'string' && r.data.error.length > 0;

async function main() {
  console.log('Checking ' + BASE + '\n');

  console.log('Read');
  let info;
  try { info = await call('GET', '/info'); } catch (e) {
    ok(false, 'GET /info answers', e.name === 'TimeoutError' ? 'no answer after ' + TIMEOUT + ' ms' : (e.cause && e.cause.code) || e.message);
    return;
  }
  ok(info.ok && info.data, 'GET /info answers with JSON (' + info.ms + ' ms)', info.status + ' ' + info.text.slice(0, 200));
  const I = info.data || {};
  ok(I.protocol === 1, 'protocol is 1', 'got ' + JSON.stringify(I.protocol));
  ok(I.type === 'laser' || I.type === 'plotter', 'type is "laser" or "plotter"', 'got ' + JSON.stringify(I.type));
  ok(typeof I.name === 'string' && I.name, 'name is set');
  ok(Array.isArray(I.bed) && I.bed.length === 2 && I.bed.every((v) => num(v) && v > 0), 'bed is [width, height] in mm', 'got ' + JSON.stringify(I.bed));
  if (!/json/i.test(info.type)) warn('content-type should be application/json (got "' + info.type + '")');

  const mach = await call('GET', '/machine');
  ok(mach.ok && mach.data && typeof mach.data === 'object' && !Array.isArray(mach.data), 'GET /machine returns an object');
  const M = mach.data || {};
  if (M.bed !== undefined) ok(Array.isArray(M.bed) && M.bed.length === 2, '/machine bed is [w, h]');
  ['speed', 'acc', 'power', 'feedLen'].forEach((k) => { if (M[k] !== undefined) ok(num(M[k]), '/machine ' + k + ' is a number', 'got ' + JSON.stringify(M[k])); });
  if (M.speed === undefined || M.acc === undefined) warn('/machine has no speed/acc: Pathline\'s time estimate falls back to defaults');
  if (M.f !== undefined) ok(typeof M.f === 'object' && Object.values(M.f).every((v) => typeof v === 'boolean'), '/machine f (features) are true/false');
  if (I.type === 'plotter' && M.timing) ok(['toolDown', 'toolUp', 'toolChange', 'feedSpeed', 'feedSettle'].every((k) => M.timing[k] === undefined || num(M.timing[k])), '/machine timing values are numbers');

  const st = await call('GET', '/status');
  const S = st.data || {};
  ok(st.ok, 'GET /status answers (' + st.ms + ' ms)');
  if (st.ms > 1500) warn('/status took ' + st.ms + ' ms; Pathline polls it every 1.5 s');
  ok(['idle', 'running', 'paused', 'framing', 'alarm'].includes(S.state), 'state is idle/running/paused/framing/alarm', 'got ' + JSON.stringify(S.state));
  ok(S.pos && num(S.pos.x) && num(S.pos.y) && num(S.pos.z), 'pos has numeric x, y, z');
  ok(num(S.progress) && S.progress >= 0 && S.progress <= 1, 'progress is 0–1');
  ok(S.io && typeof S.io === 'object', 'io is an object');

  const jl = await call('GET', '/jobs');
  ok(jl.ok && Array.isArray(jl.data), 'GET /jobs returns an array');
  const jobShape = (j) => j && typeof j.id === 'string' && typeof j.name === 'string' && ['queued', 'running', 'done', 'stopped'].includes(j.status) && num(j.progress);
  if (Array.isArray(jl.data) && jl.data.length) ok(jl.data.every(jobShape), 'every queue entry has id, name, status, progress', JSON.stringify(jl.data.find((j) => !jobShape(j))));

  console.log('\nErrors');
  const nf = await call('GET', '/no-such-route');
  ok(isError(nf), 'unknown route gives a non-2xx status with { error }', nf.status + ' ' + nf.text.slice(0, 120));
  const bad = await call('POST', '/jobs', { hello: 'not a package' });
  ok(isError(bad), 'POST /jobs with a non-package body is refused with { error }', bad.status + ' ' + bad.text.slice(0, 120));

  console.log('\nQueue');
  const pkgFile = path.join(EXAMPLES, I.type === 'plotter' ? 'plotter-two-beds' : 'laser-print-and-cut', 'post-jobs-body.json');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  if (S.state === 'running' || S.state === 'paused') warn('the machine is ' + S.state + '; queue checks still run, nothing is started');
  const send = (name) => call('POST', '/jobs', { ...pkg, job: { ...pkg.job, name } });
  const a = await send('check-hmi A');
  ok(a.ok && a.data && typeof a.data.id === 'string' && a.data.status === 'queued', 'POST /jobs accepts the example package → { id, status: "queued" }', a.status + ' ' + a.text.slice(0, 200));
  const b = await send('check-hmi B');
  ok(b.ok && b.data && b.data.id && b.data.id !== (a.data && a.data.id), 'a second job gets its own id');
  const ids = [a.data && a.data.id, b.data && b.data.id];
  const queued = async () => ((await call('GET', '/jobs')).data || []).filter((j) => j.status === 'queued' && ids.includes(j.id)).map((j) => j.id);
  let q = await queued();
  ok(q.join() === ids.join(), 'both are queued in the order sent', 'queued: ' + q.join(', '));
  const ord = await call('POST', '/jobs/order', { ids: [ids[1], ids[0]] });
  ok(ord.ok, 'POST /jobs/order answers');
  q = await queued();
  ok(q.join() === [ids[1], ids[0]].join(), 'the new order is applied (B before A)', 'queued: ' + q.join(', '));
  const del = await call('DELETE', '/jobs/' + encodeURIComponent(ids[0]));
  ok(del.ok, 'DELETE /jobs/{id} removes a waiting job');
  q = await queued();
  ok(!q.includes(ids[0]), 'the removed job is gone from /jobs');
  const del404 = await call('DELETE', '/jobs/no-such-job');
  ok(isError(del404), 'removing an unknown job gives { error }', del404.status + ' ' + del404.text.slice(0, 120));

  console.log('\nCommands');
  const stop = await call('POST', '/stop', {});
  ok(stop.ok, 'POST /stop is accepted (it must always be)');

  if (flag('allow-motion')) {
    const home = await call('POST', '/home', {});
    ok(home.ok || isError(home), 'POST /home answers', home.status + ' ' + home.text.slice(0, 120));
    const before = (await call('GET', '/status')).data.pos;
    const jog = await call('POST', '/jog', { axis: 'x', distance: 10 });
    ok(jog.ok, 'POST /jog { axis: "x", distance: 10 } answers');
    await sleep(1500);
    const after = (await call('GET', '/status')).data.pos;
    ok(Math.abs(after.x - before.x - 10) < 0.5, 'status pos.x moved by 10 mm', 'before ' + before.x + ', after ' + after.x);
    const absMove = await call('POST', '/jog', { x: 20, y: 20 });
    ok(absMove.ok, 'POST /jog { x, y } (absolute move) answers');
    await sleep(1500);
    const fr = await call('POST', '/frame', { box: [20, 20, 60, 50] });
    ok(fr.ok, 'POST /frame { box } answers');
    const busy = await call('POST', '/jog', { axis: 'x', distance: 1 });
    if (busy.ok) warn('jog during framing was accepted; motion should be refused with 409 while framing or running');
    else ok(busy.status === 409 && isError(busy), 'motion while framing is refused with 409 { error }', busy.status + ' ' + busy.text.slice(0, 120));
    await sleep(4000);
  } else console.log('  skip  motion (home, jog, frame): add --allow-motion');

  if (flag('run')) {
    const st0 = await call('POST', '/start', {});
    ok(st0.ok, 'POST /start answers');
    let s = null;
    for (let i = 0; i < 20 && (!s || s.state !== 'running'); i++) { await sleep(500); s = (await call('GET', '/status')).data; }
    ok(s && s.state === 'running' && s.job === ids[1], 'the queued job starts running and /status names it', JSON.stringify(s && { state: s.state, job: s.job }));
    const running = ((await call('GET', '/jobs')).data || []).find((j) => j.id === ids[1]);
    ok(running && running.status === 'running', '/jobs shows it as running');
    const busyDel = await call('DELETE', '/jobs/' + encodeURIComponent(ids[1]));
    ok(busyDel.status === 409 && isError(busyDel), 'a running job can\'t be removed (409)', busyDel.status + ' ' + busyDel.text.slice(0, 120));
    await call('POST', '/pause', {});
    await sleep(700);
    ok((await call('GET', '/status')).data.state === 'paused', 'POST /pause → state paused');
    await call('POST', '/resume', {});
    await sleep(700);
    ok((await call('GET', '/status')).data.state === 'running', 'POST /resume → state running');
    await call('POST', '/stop', {});
    await sleep(700);
    const end = (await call('GET', '/status')).data;
    ok(end.state === 'idle', 'POST /stop → state idle');
    const stopped = ((await call('GET', '/jobs')).data || []).find((j) => j.id === ids[1]);
    ok(!stopped || stopped.status === 'stopped', 'the stopped job shows status "stopped"', JSON.stringify(stopped));
  } else {
    console.log('  skip  running a job (start, pause, resume, stop): add --run');
    await call('DELETE', '/jobs/' + encodeURIComponent(ids[1]));
  }

  console.log('\n' + (failed ? failed + ' check(s) failed' : 'All checks passed') + (warned ? ', ' + warned + ' warning(s)' : ''));
}

main().then(() => process.exit(failed ? 1 : 0)).catch((e) => { console.error('\nCheck stopped: ' + (e.cause && e.cause.code || e.message)); process.exit(1); });

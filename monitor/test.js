#!/usr/bin/env node
// Self-test for Pathline Monitor: the alerts each kind of report makes (and the ones it
// doesn't), the notification encryption, and the server itself with a stand-in Pathline Run
// and a stand-in phone.
//   node test.js            node test.js --demo [port]   (a server with pretend machines, to look at)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Machines } = require('./lib/machines');
const push = require('./lib/push');

let failed = 0;
const ok = (c, msg) => { console.log((c ? '  ok    ' : '  FAIL  ') + msg); if (!c) failed++; };
const iso = (t) => new Date(t).toISOString();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, t = 4000) => { const end = Date.now() + t; while (!f() && Date.now() < end) await wait(20); return f(); };

// what a Pathline Run reports: its GET /api/v1/monitor answer
const report = (extra) => ({ id: 'run-3f9c2a71', name: 'Laser T', type: 'laser', ctrl: 'Trotec', model: 'Speedy 400', app: 'Pathline Run 0.7.13', link: 'online', state: 'idle', since: null, message: '', interlock: false, interlockSince: null, markWait: null, job: null, queue: [], today: [], ...extra });
const job = (id, name, extra) => ({ id, name, material: 'Birch ply 3 mm', seconds: 600, ...extra });

// ---------------------------------------------------------------- reports → views and alerts
function alertRules() {
  console.log('Reports to alerts');
  let clock = Date.parse('2026-11-16T10:00:00Z');
  const alerts = [];
  let told = 0;
  const M = new Machines({ onAlert: (a) => alerts.push(a), onChange: () => told++, now: clock });
  const took = () => alerts.splice(0);
  const view = (id = 'a') => M.list.get(id).view;
  let r = report();
  const step = (ms = 10000, id = 'a') => { clock += ms; M.report(id, r, clock); M.tick(clock); };
  const done = (id, name, result, seconds) => ({ id, name, material: 'Birch ply 3 mm', seconds, result, finishedAt: iso(clock) });

  M.add('a', 'Laser T', clock);
  ok(view().state === 'offline' && view().since === null, 'added, not heard from yet: shown as not reporting');
  step();
  ok(view().state === 'idle' && view().name === 'Laser T' && view().model === 'Trotec · Speedy 400' && !took().length, 'first report: idle, nothing sent (not "back")');

  r = report({ state: 'running', job: job('J1', 'Coasters', { progress: 0.25, remaining: 440 }), queue: [job('J2', 'Name badges')] });
  step();
  ok(view().state === 'running' && view().job.remaining === 440 && view().queue.length === 1 && !took().length, 'running: Run\'s own time left, one queued, nothing sent');
  told = 0;
  r = { ...r, job: { ...r.job, progress: 0.26, remaining: 430 } }; step(5000);
  ok(told === 0, 'only the progress moved: phones aren\'t told (they count down themselves)');
  r = { ...r, job: { ...r.job, progress: 0.28, remaining: 420 } }; step(10000);
  ok(told === 1 && view().job.remaining === 420, 'after 15 s of a running job they are, to stay in step');

  r = { ...r, interlock: true, interlockSince: iso(clock) }; step();
  ok(view().state === 'lid' && !took().length, 'lid opened at the machine: shown, no alert');
  r = { ...r, interlock: false, state: 'paused', since: iso(clock) }; step();
  ok(view().state === 'paused' && !took().length, 'paused at the machine: shown, no alert');

  r = { ...r, state: 'running', markWait: { mark: 2, of: 3, since: iso(clock - 120000) } }; step();
  let a = took();
  ok(view().state === 'mark' && a.length === 1 && a[0].kind === 'attn' && /mark 2 of 3/.test(a[0].body), 'registration mark not found: one "needs you" alert');
  ok(view().since === clock - 10000 - 120000, 'waiting since Run\'s own time, not since this server saw it');
  step();
  ok(!took().length, 'still waiting: no second alert');

  r = report({ queue: [job('J2', 'Name badges')], today: [done('J1', 'Coasters', 'Completed', 602)] }); step();
  a = took();
  ok(a.length === 1 && a[0].kind === 'done' && a[0].title === 'Laser T finished Coasters' && /1 job waiting: press Start/.test(a[0].body) && a[0].tags.join() === 'done', 'finished with a job queued: one alert, saying what\'s waiting');
  ok(view().state === 'done' && view().lastDone === 'Coasters', 'shown as Finished, waiting for Start');
  step();
  ok(!took().length, 'the same report again: no second alert');

  r = report({ today: [done('J2', 'Name badges', 'Stopped', 61), ...r.today] }); step();
  a = took();
  ok(a.length === 1 && a[0].kind === 'err' && /stopped Name badges/.test(a[0].title) && view().today.length === 2, 'a stopped job: one "stopped" alert');

  r = report({ today: [done('J3', 'Keyrings', 'Completed', 64), ...r.today] }); step();
  a = took();
  ok(a.length === 1 && a[0].tags.join() === 'done,queue' && /queue empty/.test(a[0].body), 'the queue running out: one alert, as finished and queue empty');

  r = report({ queue: [job('J5', 'Decals', { autoStart: true })], today: [done('J4', 'Foam signs', 'Completed', 1207), ...r.today] }); step();
  a = took();
  ok(a.length === 1 && /Decals starts next by itself/.test(a[0].body) && view().state === 'idle', 'the next job starts by itself: the alert says so, and it isn\'t waiting for Start');

  r = report({ state: 'alarm', message: 'Lid interlock tripped during the job', today: r.today }); step();
  a = took();
  ok(a.length === 1 && a[0].kind === 'err' && /has an error/.test(a[0].title), 'an error: one alert');
  r = report({ today: r.today }); step(); took();

  // it stops reporting
  clock += 20000; M.tick(clock);
  ok(view().state === 'idle' && !took().length, 'two missed reports: still shown as it was');
  clock += 20000; M.tick(clock);
  ok(view().state === 'offline' && view().why === 'Not reporting' && !took().length, 'quiet for 35 s: shown as not reporting, the alert waits a moment');
  clock += 15000; M.tick(clock);
  a = took();
  ok(a.length === 1 && a[0].title === 'Laser T stopped reporting', 'still quiet: one "stopped reporting" alert');
  step();
  a = took();
  ok(view().state === 'idle' && a.length === 1 && a[0].kind === 'info' && !a[0].tags.length, 'reporting again: a "back" note that isn\'t pushed');
  clock += 40000; M.tick(clock); step(5000);
  ok(view().state === 'idle' && !took().length, 'a short gap, back before the alert went: nothing sent at all');

  r = report({ link: 'connecting', today: r.today }); step(); step(15000); step(10000);
  a = took();
  ok(view().state === 'offline' && a.length === 1 && a[0].title === 'Laser T lost its laser', 'Run reports but has lost the laser: one alert');
  r = report({ today: r.today }); step(); took();

  // two machines, and the workshop's internet
  M.add('b', 'Plotter P', clock);
  M.report('b', report({ name: 'Plotter P', type: 'plotter' }), clock);
  step(); took();
  clock += 5000; M.report('b', report({ name: 'Plotter P', type: 'plotter' }), clock);
  for (let i = 0; i < 14; i++) { clock += 5000; M.tick(clock); }
  a = took();
  ok(a.length === 1 && a[0].title === 'The workshop stopped reporting' && a[0].machine === null && /2 machines/.test(a[0].body), 'every machine quiet together: one alert for the workshop, not one each');
  step(); M.report('b', report({ name: 'Plotter P', type: 'plotter' }), clock); took();
  for (let i = 0; i < 14; i++) { clock += 5000; M.report('a', r, clock); M.tick(clock); }
  a = took();
  ok(a.length === 1 && a[0].title === 'Plotter P stopped reporting' && view('b').kind === 'plotter', 'one of two quiet: an alert for that machine');

  // a report can't break the server, whatever is in it
  M.report('a', { name: 'x'.repeat(500), job: { name: 7, progress: 'half', beds: 'two' }, queue: 'none', today: [{ finishedAt: 'never' }, null].filter(Boolean), markWait: 'yes' }, clock);
  ok(view().name.length === 60 && view().queue.length === 0, 'a malformed report is cut down to size, not trusted');

  // this server restarted: what it knew is kept, so a job that finished meanwhile still alerts
  const saved = Object.fromEntries(M.views().map((v) => [v.id, v]));
  saved.a = { ...saved.a, state: 'running', job: job('J9', 'Signs', { progress: 0.9, remaining: 60 }), today: [] };
  saved.b = { ...saved.b, state: 'idle' };
  const alerts2 = [];
  const M2 = new Machines({ saved, onAlert: (x) => alerts2.push(x), now: clock });
  M2.add('a', 'Laser T', clock); M2.add('b', 'Plotter P', clock);
  M2.tick(clock + 5000);
  ok(M2.list.get('a').view.state === 'running' && !alerts2.length, 'after a restart: machines show what they did, nothing sent');
  M2.report('a', report({ today: [{ ...job('J9', 'Signs'), result: 'Completed', finishedAt: iso(clock + 2000) }] }), clock + 8000);
  ok(alerts2.length === 1 && alerts2[0].title === 'Laser T finished Signs', 'a job that finished during the restart still alerts');
  for (let t = 10000; t <= 70000; t += 5000) { M2.report('a', report({ today: M2.list.get('a').rep.today.map((h) => ({ ...h, result: 'Completed', finishedAt: iso(h.finishedAt) })) }), clock + t); M2.tick(clock + t); }
  ok(alerts2.length === 2 && alerts2[1].title === 'Plotter P stopped reporting', 'a machine that never reports after the restart is noticed');
}

// ---------------------------------------------------------------- notifications
// what a phone does with a message (RFC 8291), written from the phone's side
function decrypt(priv, pub, auth, buf) {
  const hk = (ikm, salt, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));
  const salt = buf.subarray(0, 16);
  const sender = buf.subarray(21, 21 + buf[20]);
  const text = buf.subarray(21 + buf[20]);
  const me = crypto.createECDH('prime256v1');
  me.setPrivateKey(priv);
  const ikm = hk(me.computeSecret(sender), auth, Buffer.concat([Buffer.from('WebPush: info\0'), pub, sender]), 32);
  const d = crypto.createDecipheriv('aes-128-gcm', hk(ikm, salt, 'Content-Encoding: aes128gcm\0', 16), hk(ikm, salt, 'Content-Encoding: nonce\0', 12));
  d.setAuthTag(text.subarray(-16));
  const out = Buffer.concat([d.update(text.subarray(0, -16)), d.final()]);
  return out.subarray(0, out.lastIndexOf(2)).toString();
}
function notifications() {
  console.log('Notifications (Web Push)');
  const un = (s) => Buffer.from(s, 'base64url');
  // a message encrypted by the web-push library (3.6.7), to prove the phone's side above
  const ref = { priv: 'wkBbzuycozuKDUrBAgKcxstPHQPitw20S_W39iKKyNo', pub: 'BNqsjw1i9x6VDFV7JjuFujHsV3c9opwEuGYJ7Y77HsI6f5fkHATflBXWhJr64sh3FdWGBuednYGnJTyUarUAjjY', auth: 'p5tmYmzz_4mjzldbnApkBw', cipher: '_EBxEAWF7l5fg1MiTDpaswAAEABBBMVHs_SxeeFjfLZImKYv5HqQldIaKxodA-loYa_Hvy1_TiX473-uQDnUSGjqCoepioS72PRzECJ7j27471AcU8aWnHO8RV8KAlNJDk9TiHRLSKWDbQKJmFeFJX4_lKwr3Wp0PG7YkMD4pAonCtItBN-048w3IguEm6vdR42xf0cpXOoQDKrTKabxmTg' };
  ok(JSON.parse(decrypt(un(ref.priv), un(ref.pub), un(ref.auth), un(ref.cipher))).title === 'Laser A finished Coasters', 'the reference message (made by the web-push library) reads back');
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: ref.pub, auth: ref.auth } };
  const text = JSON.stringify({ title: 'Plotter P needs you', body: 'Registration mark 2 of 3 not found. ✓ é' });
  const mine = push.encrypt(sub, text);
  ok(decrypt(un(ref.priv), un(ref.pub), un(ref.auth), mine) === text, 'a message encrypted here reads back on the phone\'s side');
  ok(!push.encrypt(sub, text).equals(mine), 'each message is encrypted afresh');
  const keys = push.newKeys();
  ok(un(keys.publicKey).length === 65 && un(keys.privateKey).length === 32, 'the server\'s push keys are the right shape');
  const t = push.token(keys, 'https://fcm.googleapis.com', 'https://monitor.example.com').split('.');
  const pub = un(keys.publicKey);
  const key = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') } });
  const claims = JSON.parse(un(t[1]));
  ok(crypto.verify('sha256', Buffer.from(t[0] + '.' + t[1]), { key, dsaEncoding: 'ieee-p1363' }, un(t[2])) && claims.aud === 'https://fcm.googleapis.com' && claims.exp - Date.now() / 1000 < 24 * 3600, 'the server\'s signature checks out, for that push service, for under a day');
  ok(push.valid(sub) && push.valid({ ...sub, endpoint: 'https://web.push.apple.com/abc' }), 'Google\'s and Apple\'s push services are accepted');
  ok(!push.valid({ ...sub, endpoint: 'https://evil.example.com/x' }) && !push.valid({ ...sub, endpoint: 'http://fcm.googleapis.com/x' }) && !push.valid({ ...sub, endpoint: 'https://googleapis.com.evil.net/x' }) && !push.valid({ endpoint: sub.endpoint, keys: {} }), 'a subscription pointing anywhere else is refused');
}

// ---------------------------------------------------------------- the server
function start(dir, password, port = 0) {
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js'), '--config', path.join(dir, 'config.json'), '--data', path.join(dir, 'data'), '--port', String(port)], { env: { ...process.env, MONITOR_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const exited = new Promise((r) => child.on('exit', r));
  return { child, exited, log: () => out, base: async () => { await until(() => /on http:\/\/[\d.]+:(\d+)/.test(out) || child.exitCode !== null); const m = /on (http:\/\/[\d.]+:\d+)/.exec(out); return m && m[1]; }, stop: async () => { child.kill(); await exited; } };
}
// a stand-in phone: keeps its cookie, and listens to the live stream
function phone(base, id = 'phone-' + crypto.randomBytes(6).toString('hex')) {
  const p = { id, cookie: '', got: [], res: null };
  p.call = async (route, data, headers = {}) => {
    const r = await fetch(base + route, { method: data === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie: p.cookie, ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
    const set = r.headers.get('set-cookie');
    if (set) { p.setCookie = set; p.cookie = set.split(';')[0]; }
    const text = await r.text();
    return { status: r.status, headers: r.headers, text, json: text ? JSON.parse(text) : null };
  };
  p.signIn = (password) => p.call('/api/login', { id, password });
  p.listen = async () => {
    const ac = new AbortController();
    const r = await fetch(base + '/api/events', { headers: { cookie: p.cookie }, signal: ac.signal });
    p.close = () => ac.abort();
    if (r.status !== 200) return r.status;
    (async () => { let buf = ''; try { for await (const c of r.body) { buf += Buffer.from(c).toString(); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: ')); buf = buf.slice(i + 2); if (line) p.got.push(JSON.parse(line.slice(6))); } } } catch (e) { /* closed */ } })();
    await until(() => p.got.length);
    return 200;
  };
  return p;
}
const send = (base, key, body) => fetch(base + '/api/v1/report', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify(body) });

async function theServer() {
  console.log('The server');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-test-'));
  const none = start(dir, '');
  ok((await none.exited) === 1 && /password/i.test(none.log()), 'it won\'t start without a workshop password');

  let s = start(dir, 'correct horse battery');
  let base = await s.base();
  ok(!!base, 'it starts, with no packages installed');
  let r = await fetch(base + '/');
  ok(r.status === 200 && /Pathline Monitor/.test(await r.text()) && /frame-ancestors 'none'/.test(r.headers.get('content-security-policy')) && r.headers.get('x-content-type-options') === 'nosniff', 'the app is served, with its security headers');
  ok((await fetch(base + '/../server.js')).status === 404 && (await fetch(base + '/%2e%2e/config.json')).status === 404, 'nothing outside the app folder is served');

  const p = phone(base);
  ok((await p.call('/api/device')).status === 401 && (await p.listen()) === 401 && (await p.call('/api/machine-code', {})).status === 401, 'not signed in: no machines, no settings, no codes');
  ok((await p.signIn('wrong password')).status === 403 && !p.cookie, 'a wrong password is refused');
  r = await p.signIn('correct horse battery');
  ok(r.status === 200 && /HttpOnly/.test(p.setCookie) && /SameSite=Lax/.test(p.setCookie) && !r.text.includes('correct'), 'the workshop password signs the phone in, with a cookie scripts can\'t read');
  ok((await phone(base, p.id).call('/api/device', undefined, { cookie: p.cookie.replace(/.$/, 'x') })).status === 401, 'a tampered cookie is refused');
  ok((await p.listen()) === 200 && p.got[0].machines.length === 0 && p.got[0].pushKey.length === 87, 'signed in: the live stream opens with everything');

  // adding a machine
  ok((await fetch(base + '/api/v1/enrol', { method: 'POST', body: JSON.stringify({ code: 'AAAAAA', id: 'run-3f9c2a71' }) })).status === 403, 'a made-up code doesn\'t add a machine');
  const code = (await p.call('/api/machine-code', {})).json.code;
  ok(/^[A-HJ-NP-Z2-9]{6}$/.test(code), 'a signed-in phone gets a 6-character code');
  r = await fetch(base + '/api/v1/enrol', { method: 'POST', body: JSON.stringify({ code: code.slice(0, 3).toLowerCase() + '-' + code.slice(3), id: 'run-3f9c2a71', name: 'Laser T' }) });
  const key = (await r.json()).key;
  ok(r.status === 200 && key.length === 43, 'typed with a dash and in small letters, it gives the machine its own key');
  ok((await fetch(base + '/api/v1/enrol', { method: 'POST', body: JSON.stringify({ code, id: 'run-99999999' }) })).status === 403, 'the code works once');
  ok(await until(() => p.got.some((v) => v.m && v.m.id === 'run-3f9c2a71')), 'the phone sees the new machine straight away');
  ok(!fs.readFileSync(path.join(dir, 'data', 'machines.json'), 'utf8').includes(key), 'the key itself isn\'t kept on the server, only its fingerprint');

  // reporting
  r = await send(base, key, report({ state: 'running', job: job('J1', 'Coasters', { progress: 0.5, remaining: 300 }) }));
  ok(r.status === 204 && (await r.text()) === '', 'a report is taken, and nothing is sent back');
  ok(await until(() => p.got.some((v) => v.m && v.m.state === 'running' && v.m.job.name === 'Coasters')), 'the phone sees it running');
  ok((await send(base, 'not-the-key', report())).status === 401 && (await send(base, '', report())).status === 401, 'a report with the wrong key, or none, is refused');
  ok((await fetch(base + '/api/v1/report', { method: 'POST', headers: { authorization: 'Bearer ' + key }, body: '{"name":"' + 'x'.repeat(70000) + '"}' }).then((x) => x.status, () => 400)) === 400, 'an oversized report is refused');
  await send(base, key, report({ today: [{ ...job('J1', 'Coasters'), seconds: 602, result: 'Completed', finishedAt: iso(Date.now()) }] }));
  ok(await until(() => p.got.some((v) => v.alert && v.alert.title === 'Laser T finished Coasters')), 'the job finishing reaches the phone as an alert');

  // this phone's settings
  r = await p.call('/api/device', { prefs: { done: false, mute: { 'run-3f9c2a71': true } }, subscription: { endpoint: 'https://evil.example.com/x', keys: { p256dh: 'a', auth: 'b' } } });
  ok(r.json.prefs.done === false && r.json.prefs.err === true && r.json.notifications === false, 'settings are kept; a subscription that isn\'t a push service is not');
  ok((await p.call('/api/test-push', {})).status === 409, 'no test notification without a subscription');

  // restarting keeps everything; a new password signs every phone out
  p.close(); await s.stop();
  s = start(dir, 'correct horse battery'); base = await s.base();
  const p2 = phone(base, p.id); p2.cookie = p.cookie;
  r = await p2.call('/api/device');
  ok(r.status === 200 && r.json.prefs.done === false, 'after a restart the phone is still signed in, with its settings');
  ok((await p2.listen()) === 200 && p2.got[0].machines.length === 1 && p2.got[0].alerts.length === 1, 'and the machine and its alert are still there');
  ok((await send(base, key, report())).status === 204, 'and the machine\'s key still works');

  // removing a machine
  ok((await p2.call('/api/machine-remove', { id: 'run-3f9c2a71' })).status === 200 && await until(() => p2.got.some((v) => v.gone === 'run-3f9c2a71')), 'a phone removes the machine, and every phone is told');
  ok((await send(base, key, report())).status === 401, 'its key stops working');
  ok((await p2.call('/api/logout', {})).status === 200 && (await p2.call('/api/device')).status === 401, 'signing out ends the phone\'s access');
  p2.close(); await s.stop();

  s = start(dir, 'a different password'); base = await s.base();
  const p3 = phone(base, p.id); p3.cookie = p.cookie;
  ok((await p3.call('/api/device')).status === 401, 'the password changed: phones signed in with the old one are out');
  // too many wrong passwords
  for (let i = 0; i < 5; i++) await p3.signIn('guess number ' + i);
  ok((await p3.signIn('a different password')).status === 429, 'five wrong passwords from one address: sign-in pauses, even for the right one');
  ok((await fetch(base + '/api/v1/enrol', { method: 'POST', body: '{"code":"AAAAAA"}' })).status === 429, 'and so does guessing machine codes');
  await s.stop();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- a server to look at
async function demo(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-demo-'));
  const s = start(dir, 'workshop demo', port);
  const base = await s.base();
  const p = phone(base);
  await p.signIn('workshop demo');
  const add = async (id, name) => { const code = (await p.call('/api/machine-code', {})).json.code; return (await (await fetch(base + '/api/v1/enrol', { method: 'POST', body: JSON.stringify({ code, id, name }) })).json()).key; };
  const t0 = Date.now();
  const sims = [
    { key: await add('run-aaaa0001', 'Laser A'), make: (t) => { const total = 240, e = t % (total + 20); return e < total ? report({ name: 'Laser A', state: 'running', job: job('J1', 'Coasters', { seconds: total, progress: e / total, remaining: total - e }), queue: [job('J2', 'Name badges', { seconds: 1080 }), job('J3', 'Keyrings', { seconds: 742 })] }) : report({ name: 'Laser A', queue: [job('J2', 'Name badges', { seconds: 1080 })], today: [{ ...job('J1', 'Coasters'), seconds: total, result: 'Completed', finishedAt: iso(t0 + (t - e + total) * 1000) }] }); } },
    { key: await add('run-aaaa0002', 'Laser B'), make: () => report({ name: 'Laser B', ctrl: 'Ruida', model: 'RDC6445', today: [{ ...job('K1', 'Acrylic signs'), seconds: 1500, result: 'Completed', finishedAt: iso(t0 - 3600000) }] }) },
    { key: await add('run-aaaa0003', 'Plotter P'), make: (t) => report({ name: 'Plotter P', type: 'plotter', ctrl: 'Ruida', model: 'RDC6445', state: 'running', markWait: t % 120 > 60 ? { mark: 2, of: 3, since: iso(t0 + (t - (t % 120) + 60) * 1000) } : null, job: job('P1', 'Foam signs', { material: 'Foam board 5 mm', seconds: 1200, progress: 0.5, remaining: 600, beds: [2, 3] }), queue: [job('P2', 'Window decals', { material: 'Vinyl', seconds: 540, autoStart: true })] }) },
  ];
  setInterval(() => { const t = Math.floor((Date.now() - t0) / 1000); for (const m of sims) send(base, m.key, m.make(t)).catch(() => {}); }, 5000);
  console.log('Pathline Monitor with pretend machines: ' + base + '  (password: workshop demo)');
}

(async () => {
  if (process.argv[2] === '--demo') return demo(Number(process.argv[3]) || 8480);
  alertRules();
  notifications();
  await theServer();
  console.log(failed ? '\n' + failed + ' failed' : '\nAll passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

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

// ---------------------------------------------------------------- pulls (lib/pulls.js)
// The pull token asks a machine for one thing; the machine, waiting on GET /api/v1/asks, answers;
// the answer is collected once and forgotten. Nothing about a pull is written to disk.
async function pulls() {
  console.log('Pulls');
  const { Pulls, checkAsk } = require('./lib/pulls');
  const throws = (f) => { try { f(); return null; } catch (e) { return e; } };
  ok(checkAsk({ what: 'log', day: '2026-11-20', job: 'J1' }).job === null && checkAsk({ what: 'job', job: 'j0123' }).job === 'J0123' && checkAsk({ what: 'runs', day: '2026-11-20' }).day === '2026-11-20',
    'asks are checked: a log has a day, a job a job number (in any case), and nothing that isn\'t needed is passed on');
  ok(['exec', '', '../config'].every((w) => throws(() => checkAsk({ what: w })).code === 400) && throws(() => checkAsk({ what: 'log', day: '../../etc' })).code === 400 && throws(() => checkAsk({ what: 'job', job: '../x' })).code === 400 && throws(() => checkAsk({ what: 'log' })).code === 400,
    'anything not on the list, a day or job that isn\'t one, or a missing one, is refused');

  // times in lib/pulls.js, swept by hand
  const P = new Pulls({ scale: 0.001, maxHeld: 100 });
  const a1 = P.add('m1', checkAsk({ what: 'health' }), 0);
  P.sweep(86400000 * 0.001 + 1);
  ok((await P.collect(a1.id)).state === 'failed' && !P.asks.size, 'an ask nobody takes in a day (the machine is off) is given up, said once, then forgotten');
  const a2 = P.add('m1', checkAsk({ what: 'health' }), Date.now());
  const got = await P.next('m1');
  ok(got.length === 1 && got[0].id === a2.id && !('machine' in got[0]), 'the machine is given its ask (id, what, day, job: nothing else)');
  P.sweep(Date.now() + 600000 * 0.001 + 5);
  ok((await P.collect(a2.id)).ask.error.includes('never answered'), 'taken and never answered: given up');
  const a3 = P.add('m1', checkAsk({ what: 'health' }));
  await P.next('m1');
  ok(throws(() => P.answer('m1', a3.id, { status: 200, type: 'x', name: '', body: Buffer.alloc(101) })).code === 507 && P.asks.get(a3.id).state === 'taken', 'more than it may hold: the answer is refused, the ask still open');
  P.answer('m1', a3.id, { status: 200, type: 'x', name: '', body: Buffer.alloc(10) });
  P.sweep(Date.now() + 3600000 * 0.001 + 5);
  ok(!P.asks.size && P.held === 0, 'an answer nobody collects is dropped after the hour');
  ok(throws(() => { for (let i = 0; i < 21; i++) P.add('m2', checkAsk({ what: 'list' })); }).code === 429, 'at most 20 asks wait for one machine');
  P.close();

  // the server
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-pull-'));
  const TOKEN = 'pull-token-for-the-test-0123456789';
  // no token: pulling is off
  let s = start(dir, 'correct horse battery');
  let base = await s.base();
  let r = await fetch(base + '/api/pull/machines', { headers: { authorization: 'Bearer ' + TOKEN } });
  ok(r.status === 404 && /isn't set up/.test((await r.json()).error), 'no pull token on the server: pulling is off');
  await s.stop();
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js'), '--config', path.join(dir, 'config.json'), '--data', path.join(dir, 'data'), '--port', '0'], { env: { ...process.env, MONITOR_PASSWORD: 'correct horse battery', MONITOR_PULL_TOKEN: TOKEN, MONITOR_PULL_SCALE: '0.02' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { out += c; });
  await until(() => /on http:\/\/[\d.]+:(\d+)/.test(out));
  base = /on (http:\/\/[\d.]+:\d+)/.exec(out)[1];
  try {
    const p = phone(base);
    await p.signIn('correct horse battery');
    const enrol = async (id, name) => { const code = (await p.call('/api/machine-code', {})).json.code; return (await (await fetch(base + '/api/v1/enrol', { method: 'POST', body: JSON.stringify({ code, id, name }) })).json()).key; };
    const key = await enrol('run-aaaa0001', 'Laser A');
    const key2 = await enrol('run-bbbb0002', 'Laser B');
    const pull = (route, data, token = TOKEN) => fetch(base + route, { method: data ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: data ? JSON.stringify(data) : undefined });
    const asks = (k) => fetch(base + '/api/v1/asks', { headers: { authorization: 'Bearer ' + k } });
    const answer = (k, id, bodyBuf, headers = {}) => fetch(base + '/api/v1/answer/' + id, { method: 'POST', headers: { authorization: 'Bearer ' + k, 'content-type': 'application/gzip', ...headers }, body: bodyBuf });

    ok((await pull('/api/pull/machines', undefined, 'wrong-token-wrong-token-wrong')).status === 401 && (await fetch(base + '/api/pull/machines')).status === 401, 'the wrong pull token, or none, gets nothing');
    ok((await fetch(base + '/api/pull/machines', { headers: { cookie: p.cookie } })).status === 401 && (await fetch(base + '/api/device', { headers: { authorization: 'Bearer ' + TOKEN } })).status === 401, 'a signed-in phone can\'t pull, and the pull token can\'t open the phones\' side');
    ok((await asks('not-a-key')).status === 401, 'a machine\'s asks need its key');
    // listening: the machine's GET /api/v1/asks waits, then says nothing (204)
    const t0 = Date.now();
    r = await asks(key);
    ok(r.status === 204 && Date.now() - t0 >= 400, 'nothing asked: the machine\'s wait ends with nothing (' + (Date.now() - t0) + ' ms, 25 s scaled)');
    let list = (await (await pull('/api/pull/machines')).json()).machines;
    ok(list.length === 2 && list.find((m) => m.name === 'Laser A').listening && !list.find((m) => m.name === 'Laser B').listening, 'the machines, and which is listening');
    ok((await pull('/api/pull', { machine: 'Laser A', what: 'exec' })).status === 400 && (await pull('/api/pull', { machine: 'Laser Z', what: 'list' })).status === 404, 'an ask not on the list, or for a machine that isn\'t there, is refused');

    // an ask while the machine waits: it hears it at once
    const waiting = asks(key);
    await wait(50);
    r = await pull('/api/pull', { machine: 'laser a', what: 'log', day: '2026-11-20', path: '/etc/passwd' });
    const a = await r.json();
    ok(r.status === 202 && a.machine.id === 'run-aaaa0001' && a.listening, 'asked by name (any case): taken, and the machine is listening');
    const heard = await (await waiting).json();
    ok(heard.length === 1 && heard[0].id === a.id && heard[0].what === 'log' && heard[0].day === '2026-11-20' && !JSON.stringify(heard).includes('passwd'), 'the waiting machine hears it straight away, without anything that isn\'t on the list');
    ok((await answer(key2, a.id, Buffer.from('x'))).status === 404, 'another machine can\'t answer it');
    // collecting before the answer: "not yet"
    r = await pull('/api/pull/' + a.id);
    ok(r.status === 202 && (await r.json()).state === 'taken', 'collected before it\'s answered: not yet');
    const secret = 'MARKER-' + crypto.randomBytes(8).toString('hex');
    const gz = require('zlib').gzipSync(JSON.stringify({ format: 'pathline-run-pull', files: [{ name: 'run-2026-11-20.log', data: Buffer.from(secret).toString('base64') }] }));
    const collecting = pull('/api/pull/' + a.id);
    await wait(50);
    ok((await answer(key, a.id, gz, { 'x-pathline-name': 'Laser-A-log.pull.json.gz' })).status === 204, 'the machine answers');
    r = await collecting;
    const back = Buffer.from(await r.arrayBuffer());
    ok(r.status === 200 && back.equals(gz) && r.headers.get('x-pathline-name') === 'Laser-A-log.pull.json.gz', 'a collector waiting gets the answer as the machine sent it');
    ok((await pull('/api/pull/' + a.id)).status === 404, 'and once collected it\'s gone');
    ok(!fs.readdirSync(path.join(dir, 'data')).some((f) => fs.readFileSync(path.join(dir, 'data', f)).includes(secret) || fs.readFileSync(path.join(dir, 'data', f), 'utf8').includes(a.id)), 'nothing about the pull was written to disk');
    // the machine's own error goes through as it is
    const b = await (await pull('/api/pull', { machine: 'run-aaaa0001', what: 'job', job: 'J0099' })).json();
    await (await asks(key)).json();
    await answer(key, b.id, JSON.stringify({ error: 'No files for J0099' }), { 'content-type': 'application/json', 'x-pathline-status': '404' });
    r = await pull('/api/pull/' + b.id);
    ok(r.status === 404 && (await r.json()).error === 'No files for J0099', 'the machine\'s "not there" reaches the collector');
    ok((await answer(key, 'nosuchask0', Buffer.from('x'))).status === 404, 'an answer to no ask is refused');
    // removed from Monitor: its asks are given up
    const c = await (await pull('/api/pull', { machine: 'Laser B', what: 'health' })).json();
    await p.call('/api/machine-remove', { id: 'run-bbbb0002' });
    r = await pull('/api/pull/' + c.id);
    ok(r.status === 404 || r.status === 410, 'a machine removed from Pathline Monitor: its asks go with it');
    ok((await asks(key2)).status === 401, 'and its key no longer waits for asks');
    // too many wrong tokens: paused like wrong passwords
    for (let i = 0; i < 5; i++) await pull('/api/pull/machines', undefined, 'guess-' + i + '-xxxxxxxxxxxxxxxxxxxxxxx');
    ok((await pull('/api/pull/machines')).status === 429, 'five wrong pull tokens from one address: pulling pauses for it, even with the right one');
  } finally {
    child.kill();
    await new Promise((res) => child.on('exit', res));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- Pathline Prepare (Monitor 0.7)
// A computer signs in with the workshop password and an authenticator app code (set up on a
// phone), gets its own key, and calls machines: only the calls on the list, passed to the machine
// over its own GET /api/v1/asks, its answer handed straight back. Never Start or the head.
async function prepare() {
  console.log('Pathline Prepare');
  const totp = require('./lib/totp');
  const QR = require('./app/qr.js');
  const { Pulls, callOk } = require('./lib/pulls');
  // the authenticator codes (RFC 6238's own test values) and the spare codes
  const sec = totp.toBase32(Buffer.from('12345678901234567890'));
  ok(totp.code(sec, Math.floor(59 / 30)) === '287082' && totp.code(sec, Math.floor(1111111109 / 30)) === '081804' && totp.code(sec, Math.floor(2000000000 / 30)) === '279037', 'authenticator codes match the standard\'s test values (Google and Microsoft Authenticator make the same)');
  const now = 1700000000000, s = totp.stepAt(now);
  ok(totp.check(sec, totp.code(sec, s), now) === s && totp.check(sec, totp.code(sec, s - 1), now) === s - 1 && totp.check(sec, totp.code(sec, s - 2), now) === -1 && totp.check(sec, totp.code(sec, s), now, s) === -1 && totp.check(sec, '12345', now) === -1,
    'a code counts for its 30 s and one either side, never once used, and only as 6 digits');
  const sp = totp.newSpares();
  ok(sp.length === 10 && new Set(sp).size === 10 && sp.every((c) => /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/.test(c)) && totp.hashSpare(sp[0].toLowerCase().replace('-', ' ')) === totp.hashSpare(sp[0]), 'ten spare codes, typed any way');
  const uri = totp.uri(totp.newSecret(), 'monitor.example.com');
  const q = QR.encode(uri);
  ok(/^otpauth:\/\/totp\/Pathline%20Monitor:monitor\.example\.com\?secret=[A-Z2-7]{32}&issuer=Pathline%20Monitor/.test(uri) && q.modules.length === 17 + 4 * q.version && q.modules[0].slice(0, 7).every(Boolean) && !q.modules[1][1] && q.modules[3][3],
    'the setup link authenticator apps take, as a QR code (version ' + q.version + ')');
  // what may go to a machine
  ok(['GET /info', 'GET /status', 'GET /machine', 'GET /jobs', 'GET /materials', 'POST /jobs', 'POST /jobs/order', 'DELETE /jobs/J0042', 'PUT /materials'].every(callOk), 'reading, queuing, reordering and removing jobs, and the materials list pass');
  ok(!['POST /start', 'POST /jog', 'POST /home', 'POST /frame', 'POST /io', 'POST /stop', 'POST /marks/accept', 'POST /feed', 'GET /monitor-report', 'PUT /config', 'DELETE /jobs/../x', 'GET /jobs/J1/package', 'GET /info ', ''].some(callOk), 'Start, the head, framing, outputs, marks, settings and anything else don\'t');
  // a call, start to finish (lib/pulls.js)
  const P = new Pulls({ scale: 0.01 });
  const c1 = P.call('m1', { call: 'POST /jobs', from: { id: 'p', name: 'Office PC' }, body: Buffer.from('{"job":1}') }, 2000);
  const got = await P.next('m1');
  ok(got.length === 1 && got[0].kind === 'call' && got[0].call === 'POST /jobs' && got[0].size === 9 && !('body' in got[0]) && P.bodyOf('m1', got[0].id).body.toString() === '{"job":1}', 'the machine is told the call, and fetches its body on its own');
  P.answer('m1', got[0].id, { status: 200, type: 'application/json', name: '', body: Buffer.from('{"id":"J0001"}') });
  ok((await c1).body.toString() === '{"id":"J0001"}' && !P.asks.size && P.held === 0, 'its answer goes back to the caller, and nothing is kept');
  const c2 = P.call('m1', { call: 'GET /status', from: { id: 'p', name: 'Office PC' } }, 60).catch((e) => e);
  const g2 = await P.next('m1');
  ok((await c2).code === 504, 'no answer in time: the caller is told so');
  P.answer('m1', g2[0].id, { status: 200, type: 'x', name: '', body: Buffer.from('late') });
  ok(!P.asks.size && P.held === 0, 'an answer that comes too late is dropped');
  P.close();

  // the server
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-prep-'));
  const run = (password) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'server.js'), '--config', path.join(dir, 'config.json'), '--data', path.join(dir, 'data'), '--port', '0'], { env: { ...process.env, MONITOR_PASSWORD: password, MONITOR_PULL_SCALE: '0.02' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { out += c; });
    return { child, out: () => out, base: async () => { await until(() => /on http:\/\/[\d.]+:(\d+)/.test(out)); return /on (http:\/\/[\d.]+:\d+)/.exec(out)[1]; }, stop: () => new Promise((res) => { child.on('exit', res); child.kill(); }) };
  };
  let srv = run('correct horse battery');
  try {
    let base = await srv.base();
    const p = phone(base);
    await p.signIn('correct horse battery');
    await p.listen();
    const code = (await p.call('/api/machine-code', {})).json.code;
    const key = (await (await fetch(base + '/api/v1/enrol', { method: 'POST', body: JSON.stringify({ code, id: 'run-aaaa0001', name: 'Laser A' }) })).json()).key;
    const join = (b) => fetch(base + '/api/v1/prepare/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'prep-0123456789abcdef', name: 'Office PC', password: 'correct horse battery', ...b }) }).then(async (r) => ({ status: r.status, json: await r.json() }));
    const prep = (k, route, call, body, type = 'application/json') => fetch(base + route, { method: call === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + k, ...(call ? { 'x-pathline-call': call, 'content-type': type } : {}) }, body });
    const asks = (k) => fetch(base + '/api/v1/asks', { headers: { authorization: 'Bearer ' + k } });

    let r = await p.call('/api/prepare');
    ok(r.status === 200 && r.json.twoStep.on === false && r.json.computers.length === 0, 'a phone sees Pathline Prepare\'s sign-in isn\'t set up yet');
    ok((await fetch(base + '/api/prepare')).status === 401, 'and only a signed-in phone sees it');
    let j = await join({ password: 'not the password' });
    ok(j.status === 403 && j.json.need === 'password', 'Prepare: a wrong workshop password is refused');
    j = await join({});
    ok(j.status === 409 && j.json.need === 'setup' && !j.json.key, 'the right password, but no authenticator app set up yet: no sign-in at all');

    // setting up the authenticator app on the phone
    r = await p.call('/api/prepare/two-step', {});
    const secret = r.json.secret;
    ok(r.status === 200 && /^[A-Z2-7]{32}$/.test(secret) && r.json.uri.startsWith('otpauth://totp/Pathline%20Monitor:') && r.json.uri.includes('secret=' + secret), 'the phone gets the secret and the setup link for the app');
    ok((await p.call('/api/prepare/two-step/confirm', { code: '000000' === totp.code(secret, totp.stepAt(Date.now())) ? '111111' : '000000' })).status === 403 && !fs.existsSync(path.join(dir, 'data', 'two-step.json')), 'a code that doesn\'t match doesn\'t turn it on');
    r = await p.call('/api/prepare/two-step/confirm', { code: totp.code(secret, totp.stepAt(Date.now())) });
    const spare = r.json && r.json.spare;
    ok(r.status === 200 && r.json.twoStep.on && spare.length === 10 && !fs.readFileSync(path.join(dir, 'data', 'two-step.json'), 'utf8').includes(spare[0]), 'the app\'s code turns it on, with ten spare codes shown once (kept only as fingerprints)');
    ok((await p.call('/api/prepare/two-step', {})).status === 403, 'set up: setting it up again takes a code from the app first');

    // signing Prepare in
    j = await join({});
    ok(j.status === 401 && j.json.need === 'code', 'Prepare: the password alone isn\'t enough, a code is asked for');
    const cur = totp.code(secret, totp.stepAt(Date.now()));
    j = await join({ code: cur === '123456' ? '654321' : '123456' });
    ok(j.status === 403 && j.json.need === 'code' && !j.json.key, 'a wrong code is refused');
    const used = totp.code(secret, totp.stepAt(Date.now()));
    j = await join({ code: used });
    const pkey = j.json.key;
    ok(j.status === 200 && pkey.length === 43 && j.json.machines.length === 1 && j.json.machines[0].name === 'Laser A', 'password and code: the computer gets its own key, and the machines');
    ok((await join({ code: used })).status === 403, 'the same code doesn\'t work twice');
    j = await join({ id: 'prep-fedcba9876543210', name: 'Laptop', code: spare[3].toLowerCase() });
    const pkey2 = j.json.key;
    ok(j.status === 200 && !!pkey2, 'a spare code works instead (typed in small letters)');
    ok((await join({ id: 'prep-fedcba9876543210', code: spare[3] })).status === 403 && (await p.call('/api/prepare')).json.twoStep.spareLeft === 9, 'once: it\'s used up');
    ok(await until(() => p.got.some((v) => v.alert && v.alert.title === 'Pathline Prepare signed in on Office PC' && !v.alert.tags.length)), 'every phone\'s Alerts list says a computer signed in');
    ok(!fs.readFileSync(path.join(dir, 'data', 'prepare.json'), 'utf8').includes(pkey), 'its key isn\'t kept on the server, only its fingerprint');
    r = await p.call('/api/prepare');
    ok(r.json.computers.length === 2 && r.json.computers.some((c) => c.name === 'Office PC'), 'the phone lists the computers signed in');

    // calls
    ok((await prep('wrong-key-wrong-key', '/api/v1/prepare/machines')).status === 401 && (await prep(key, '/api/v1/prepare/machines')).status === 401, 'without its key (a machine\'s won\'t do), nothing');
    r = await prep(pkey, '/api/v1/prepare/call/run-aaaa0001', 'GET /status');
    ok(r.status === 503 && (await r.json()).offline === true, 'a machine that isn\'t listening: told so at once');
    for (const c of ['POST /start', 'POST /jog', 'POST /frame', 'GET /monitor-report', 'PUT /config']) {
      r = await prep(pkey, '/api/v1/prepare/call/run-aaaa0001', c, '{}');
      if (r.status !== 403) { ok(false, c + ' got ' + r.status); break; }
    }
    ok(true, 'Start, the head, framing and settings are refused before the machine hears of them');
    // the machine listening: a job is queued through it
    const pkg = JSON.stringify({ job: { name: 'Coasters' }, big: 'x'.repeat(200000) });
    const hear = asks(key);
    await wait(60);
    const sending = prep(pkey, '/api/v1/prepare/call/run-aaaa0001', 'POST /jobs', pkg);
    const list = await (await hear).json();
    const a = list[0];
    ok(list.length === 1 && a.kind === 'call' && a.call === 'POST /jobs' && a.from.name === 'Office PC' && a.size === pkg.length && JSON.stringify(list).length < 1000, 'the machine hears the call and who sent it, without the job in it');
    r = await fetch(base + '/api/v1/asks/' + a.id + '/body', { headers: { authorization: 'Bearer ' + key } });
    ok(r.status === 200 && (await r.text()) === pkg, 'it fetches the job itself');
    await fetch(base + '/api/v1/answer/' + a.id, { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json', 'x-pathline-status': '200' }, body: '{"id":"J0007","status":"queued"}' });
    r = await sending;
    ok(r.status === 200 && (await r.json()).id === 'J0007' && r.headers.get('x-pathline-via') === 'monitor', 'and its answer comes back to Prepare');
    // the machine's refusal goes back as it is
    const hear2 = asks(key);
    await wait(60);
    const del = prep(pkey, '/api/v1/prepare/call/run-aaaa0001', 'DELETE /jobs/J0007');
    const b = (await (await hear2).json())[0];
    await fetch(base + '/api/v1/answer/' + b.id, { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json', 'x-pathline-status': '409' }, body: '{"error":"Job is running — stop it first"}' });
    r = await del;
    ok(r.status === 409 && /running/.test((await r.json()).error), 'the machine\'s "no" reaches Prepare');
    // no answer in time (60 s, scaled)
    const hear3 = asks(key);
    await wait(60);
    r = await prep(pkey, '/api/v1/prepare/call/run-aaaa0001', 'GET /status');
    await hear3;
    ok(r.status === 504, 'a machine that doesn\'t answer in time: Prepare is told');
    ok(!fs.readdirSync(path.join(dir, 'data')).some((f) => fs.readFileSync(path.join(dir, 'data', f), 'utf8').includes('Coasters')), 'nothing a call carried was written to disk');
    // removing a computer; changing the password
    r = await p.call('/api/prepare/remove', { id: 'prep-fedcba9876543210' });
    ok(r.status === 200 && r.json.computers.length === 1 && (await prep(pkey2, '/api/v1/prepare/machines')).status === 401, 'removed on a phone: that computer\'s key stops working');
    ok((await prep(pkey, '/api/v1/prepare/machines')).status === 200 && (await p.signIn('correct horse battery')).status === 200, 'the other keeps working, and wrong keys didn\'t lock the workshop out');
    p.close();
    await srv.stop();
    srv = run('a new workshop password');
    base = await srv.base();
    ok((await fetch(base + '/api/v1/prepare/machines', { headers: { authorization: 'Bearer ' + pkey } })).status === 401, 'a new workshop password: every computer signs in again');
  } finally {
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
  await pulls();
  await prepare();
  console.log(failed ? '\n' + failed + ' failed' : '\nAll passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

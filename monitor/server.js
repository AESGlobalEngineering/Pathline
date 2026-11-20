#!/usr/bin/env node
// Pathline Monitor: one small server that every Pathline Run reports to and every phone opens.
// Nothing to install but Node.js 18 or newer: there are no packages.
//
//   node server.js [--config config.json] [--port 8480] [--host 127.0.0.1] [--data data]
//
// config.json (next to this file), all of it optional:
//   { "password": "the workshop's password for phones",
//     "tls": { "cert": "fullchain.pem", "key": "privkey.pem" },
//     "port": 8480, "host": "127.0.0.1", "address": "https://monitor.example.com" }
// With a certificate it serves https itself (port 443); without, plain http on 127.0.0.1:8480
// for a web server in front (nginx, Caddy) that has the certificate.
// As a systemd service (install.sh) there's no config.json: the password and the certificate
// are handed over as credentials (LoadCredential: password, fullchain.pem, privkey.pem).
//
// Machines:  POST /api/v1/enrol   a one-time code from the app → that machine's own key
//            POST /api/v1/report  Run's GET /api/v1/monitor answer, with the key. Answers 204:
//                                 nothing ever goes back to a machine in a report's answer.
//            GET  /api/v1/asks    waits for asks for data (pulls, below); POST /api/v1/answer/<id>
// Phones:    the app (app/), signed in with the workshop password; live over GET /api/events.
// Pulls:     with the pull token ("pullToken" in config.json; /etc/pathline-monitor/pull-token as
//            a service): GET /api/pull/machines, POST /api/pull { machine, what, day, job } →
//            { id }, GET /api/pull/<id> → the machine's answer once it's sent (lib/pulls.js).
//            Nothing about a pull is kept on disk.
// Prepare:   a Pathline Prepare computer signs in once with the workshop password and a code from
//            the authenticator app (set up on a phone: Settings, Pathline Prepare) and gets its own
//            key: POST /api/v1/prepare/join. Then GET /api/v1/prepare/machines, and
//            POST /api/v1/prepare/call/<machine> (x-pathline-call: "POST /jobs" …) passes one of
//            the calls in lib/pulls.js CALLS to that machine and hands back its answer. Never
//            Start, the head or outputs. Removed in Settings, its key stops working.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const push = require('./lib/push');
const totp = require('./lib/totp');
const { Machines } = require('./lib/machines');
const { Pulls, checkAsk, WHAT, callOk } = require('./lib/pulls');
const pkg = require('./package.json');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const confPath = path.resolve(arg('config', path.join(__dirname, 'config.json')));
const conf = fs.existsSync(confPath) ? JSON.parse(fs.readFileSync(confPath, 'utf8')) : {};
const beside = (f) => path.resolve(path.dirname(confPath), f);
const DATA = beside(arg('data', conf.data || 'data'));
// what systemd hands over (LoadCredential), if anything
const cred = (n) => { const f = path.join(process.env.CREDENTIALS_DIRECTORY || '', n); return process.env.CREDENTIALS_DIRECTORY && fs.existsSync(f) ? f : null; };
const PASSWORD = String(process.env.MONITOR_PASSWORD || conf.password || (cred('password') ? fs.readFileSync(cred('password'), 'utf8').trim() : ''));
// the pull token: whoever has it can ask machines for their logs, drawings and camera pictures
// (read only). None, or shorter than 24 characters: pulling is off
const PULL_TOKEN = (() => { const t = String(process.env.MONITOR_PULL_TOKEN || conf.pullToken || (cred('pull-token') ? fs.readFileSync(cred('pull-token'), 'utf8').trim() : '')); return t.length >= 24 ? t : ''; })();
const tlsFiles = conf.tls ? { cert: beside(conf.tls.cert), key: beside(conf.tls.key) } : cred('privkey.pem') ? { cert: cred('fullchain.pem'), key: cred('privkey.pem') } : null;
const tls = tlsFiles ? { cert: fs.readFileSync(tlsFiles.cert), key: fs.readFileSync(tlsFiles.key) } : null;
const PORT = Number(arg('port', process.env.PORT || conf.port || (tls ? 443 : 8480)));
const HOST = arg('host', conf.host || (tls ? '0.0.0.0' : '127.0.0.1'));
const log = (s) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' ') + '  ' + s);
if (PASSWORD.length < 8) { console.error('Set the workshop password first (8 characters or more): "password" in ' + confPath + '.'); process.exit(1); }
fs.mkdirSync(DATA, { recursive: true });

// ---------------------------------------------------------------- kept on disk (data/)
const file = (n) => path.join(DATA, n);
const load = (n, d) => { try { return JSON.parse(fs.readFileSync(file(n), 'utf8')); } catch (e) { return d; } };
const save = (n, v) => { fs.writeFileSync(file(n) + '.tmp', JSON.stringify(v), { mode: 0o600 }); fs.renameSync(file(n) + '.tmp', file(n)); };
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (key, s) => crypto.createHmac('sha256', key).update(s).digest();
const same = (a, b) => crypto.timingSafeEqual(Buffer.from(hash(String(a)), 'hex'), Buffer.from(hash(String(b)), 'hex'));

// keys.json: the push keys and this server's secret, made once. Keep it: without it every
// phone signs in and turns notifications on again.
let keys = load('keys.json', null);
if (!keys) { keys = { ...push.newKeys(), secret: crypto.randomBytes(32).toString('base64url') }; save('keys.json', keys); }
// a phone's sign-in is tied to the password: change the password and every phone signs in again
const sessionKey = hmac(keys.secret, PASSWORD);
const pw = hash(sessionKey).slice(0, 12);

// devices.json: one entry per signed-in phone { id, name, pw, subscription, prefs, seenAt }
const DEFAULT_PREFS = { done: true, queue: true, attn: true, err: true, quiet: false, sound: true, mute: {} };
const devices = Object.fromEntries(Object.entries(load('devices.json', {})).filter(([, d]) => d.pw === pw));
const saveDevices = () => save('devices.json', devices);

// machines.json: the enrolled machines { id, name, key (its hash), addedAt }
const enrolled = load('machines.json', {});
const byKey = new Map(Object.values(enrolled).map((m) => [m.key, m.id]));

// prepare.json: the signed-in Pathline Prepare computers { id, name, key (its hash), pw, addedAt,
// seenAt }. Like phones, they're tied to the password: change it and each signs in again
const computers = Object.fromEntries(Object.entries(load('prepare.json', {})).filter(([, c]) => c.pw === pw));
const byPrepKey = new Map(Object.values(computers).map((c) => [c.key, c.id]));
const saveComputers = () => save('prepare.json', computers);
// two-step.json: the authenticator app's secret, the spare codes (as hashes) and the last code's
// step (a code works once). Gone (deleted on the server): set up again on a phone
let twoStep = load('two-step.json', null);
const saveTwoStep = () => save('two-step.json', twoStep);

// alerts.json: newest first, the last 300 or the last 14 days
let alerts = load('alerts.json', []);
const keepAlerts = () => { const cut = Date.now() - 14 * 864e5; alerts = alerts.filter((a) => a.at > cut).slice(0, 300); save('alerts.json', alerts); };

// ---------------------------------------------------------------- machines, alerts, phones
const streams = new Set();
const tell = (v) => { const msg = 'data: ' + JSON.stringify({ now: Date.now(), ...v }) + '\n\n'; for (const res of streams) res.write(msg); };
let saving = null;
const saveState = () => { clearTimeout(saving); saving = null; save('state.json', Object.fromEntries(machines.views().map((v) => [v.id, v]))); };
function raise(a) {
  a.id = crypto.randomBytes(6).toString('hex');
  alerts.unshift(a);
  keepAlerts();
  log('alert: ' + a.title + ' · ' + a.body);
  tell({ alert: a });
  notify(a);
}
const machines = new Machines({
  saved: load('state.json', {}),
  onChange: (m) => { tell({ m }); saving = saving || setTimeout(saveState, 2000); },
  onAlert: raise,
});
for (const m of Object.values(enrolled)) machines.add(m.id, m.name);
// asks for data and their answers, in memory only; each machine's Run version from its reports
const pulls = new Pulls({ log, scale: Number(process.env.MONITOR_PULL_SCALE) || 1 });
const apps = new Map();
// how long a Prepare computer's call waits for the machine's answer (queuing a big job takes a while)
const CALL_MS = 60000 * (Number(process.env.MONITOR_PULL_SCALE) || 1);
const nameOf = (e) => { const m = machines.list.get(e.id); return (m && m.view && m.view.name) || e.name; };
// the machines as a Prepare computer sees them
const machineList = (now) => Object.values(enrolled).map((e) => {
  const v = (machines.list.get(e.id) || {}).view || {};
  return { id: e.id, name: nameOf(e), kind: v.kind || 'laser', model: v.model || '', state: v.state || 'offline', listening: pulls.listening(e.id, now), app: apps.get(e.id) || null };
});
// what a phone shows under Settings, Pathline Prepare
const prepareView = () => ({
  twoStep: twoStep ? { on: true, setAt: twoStep.setAt, spareLeft: twoStep.spare.length } : { on: false },
  computers: Object.values(computers).sort((a, b) => b.seenAt - a.seenAt).map((c) => ({ id: c.id, name: c.name, addedAt: c.addedAt, seenAt: c.seenAt })),
});
const snapshot = () => ({ app: pkg.version, now: Date.now(), machines: machines.views(), alerts: alerts.slice(0, 100), pushKey: keys.publicKey });

// quiet hours (18:00 to 07:00 by the phone's own clock, given with its settings): no sound
function quietNow(prefs) {
  if (!prefs.quiet) return false;
  const h = new Date(Date.now() - (Number(prefs.tzOffset) || 0) * 60000).getUTCHours();
  return h >= 18 || h < 7;
}
let origin = conf.address || '';
const subject = () => (conf.contact ? 'mailto:' + conf.contact : origin || 'https://pathline.invalid');
async function pushTo(d, payload, urgent) {
  try {
    const r = await push.send(keys, subject(), d.subscription, JSON.stringify(payload), { urgent });
    // the phone unsubscribed or the browser dropped it: forget the subscription
    if (r.gone) { d.subscription = null; saveDevices(); } else if (!r.ok) log('push to ' + d.id.slice(0, 8) + ' failed: ' + r.status);
    return r.ok;
  } catch (e) { log('push failed: ' + e.message); return false; }
}
function notify(a) {
  for (const d of Object.values(devices)) {
    const p = { ...DEFAULT_PREFS, ...d.prefs };
    if (!d.subscription || (p.mute && p.mute[a.machine]) || !a.tags.some((t) => p[t])) continue;
    pushTo(d, { title: a.title, body: a.body, machine: a.machine, id: a.id, kind: a.kind, silent: quietNow(p) }, a.kind !== 'done');
  }
}

// ---------------------------------------------------------------- who's asking
// behind a web server on this computer, the caller's address is the one it passes on
const ipOf = (req) => { const a = req.socket.remoteAddress || ''; const f = req.headers['x-forwarded-for']; return f && /^(::ffff:)?127\.|^::1$/.test(a) ? String(f).split(',').pop().trim() : a; };
// wrong passwords and codes: 5 from one address, then a wait that doubles (1 min to 1 h); and
// 50 from anywhere in 10 minutes closes sign-in for the rest of those 10 minutes
const fails = new Map();
let recent = [];
const blocked = (ip, now) => (fails.get(ip) || {}).until > now || recent.filter((t) => now - t < 600000).length >= 50;
function failed(ip, now) {
  const f = fails.get(ip) || { n: 0, until: 0 };
  f.n++;
  if (f.n >= 5) f.until = now + Math.min(3600000, 60000 * 2 ** (f.n - 5));
  fails.set(ip, f);
  recent = recent.filter((t) => now - t < 600000).concat(now);
}
setInterval(() => { const now = Date.now(); for (const [ip, f] of fails) if (f.until < now - 3600000) fails.delete(ip); }, 3600000).unref();
// wrong authenticator codes from anywhere: 10 in 10 minutes closes two-step sign-in for the rest
// of those 10 minutes (a 6-digit code can't be guessed at that rate)
let stepFails = [];
const stepBlocked = (now) => stepFails.filter((t) => now - t < 600000).length >= 10;
function stepFailed(ip, now) { failed(ip, now); stepFails = stepFails.filter((t) => now - t < 600000).concat(now); }
// a code from the authenticator app (each one works once) or a spare code (used up): true when right
function codeOk(typed, now) {
  if (!twoStep) return false;
  if (totp.isSpare(typed)) {
    const i = twoStep.spare.indexOf(totp.hashSpare(typed));
    if (i < 0) return false;
    twoStep.spare.splice(i, 1);
    saveTwoStep();
    log('two-step: a spare code was used (' + twoStep.spare.length + ' left)');
    return true;
  }
  const step = totp.check(twoStep.secret, typed, now, Number.isFinite(twoStep.lastStep) ? twoStep.lastStep : -1);
  if (step < 0) return false;
  twoStep.lastStep = step;
  saveTwoStep();
  return true;
}
// a setup started on a phone, until its first code confirms it (phone id → { secret, until })
const pendingSteps = new Map();
// the name the authenticator app lists it under: this server's address
const accountOf = (req) => (origin || 'https://' + (req.headers.host || 'pathline-monitor')).replace(/^https?:\/\//, '').replace(/\/.*$/, '');

// a signed-in phone: the cookie is its id and that id signed with the session key
const validId = (s) => typeof s === 'string' && /^[a-z0-9-]{8,64}$/i.test(s);
const sign = (id) => hmac(sessionKey, id).toString('base64url');
function phone(req) {
  const m = /(?:^|;\s*)pm=([a-z0-9-]+)\.([\w-]+)/i.exec(req.headers.cookie || '');
  return m && same(sign(m[1]), m[2]) ? devices[m[1]] || null : null;
}
const cookie = (req, v, age) => 'pm=' + v + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + age + (tls || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '');

// one-time codes for adding a machine: 6 letters and digits (none that look alike), 10 minutes
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const codes = new Map();
function newCode(now) {
  for (const [c, until] of codes) if (until < now) codes.delete(c);
  const c = Array.from({ length: 6 }, () => LETTERS[crypto.randomInt(32)]).join('');
  codes.set(c, now + 600000);
  return c;
}

// ---------------------------------------------------------------- http
const APP = path.join(__dirname, 'app');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const SAFE = {
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'strict-transport-security': 'max-age=31536000',
  'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'",
};
function body(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 64 * 1024) { reject(new Error('Too large')); req.destroy(); } });
    req.on('end', () => { try { const v = s ? JSON.parse(s) : {}; resolve(v && typeof v === 'object' ? v : {}); } catch (e) { reject(new Error('Not JSON')); } });
  });
}
// a machine's answer to an ask, as sent (up to `max` bytes)
function raw(req, max) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let n = 0;
    req.on('data', (c) => { n += c.length; if (n > max) { reject(Object.assign(new Error('Too large'), { code: 413 })); req.destroy(); } else parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}
const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
const machineOf = (req) => byKey.get(hash(bearer(req)));
const send = (res, code, v, extra) => { res.writeHead(code, { ...SAFE, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra }); res.end(v === undefined ? '' : JSON.stringify(v)); };

async function handle(req, res) {
  const p = new URL(req.url, 'http://x').pathname;
  const post = req.method === 'POST';
  const now = Date.now();
  try {
    // ---- machines
    if (p === '/api/v1/report' && post) {
      const id = machineOf(req);
      // 401: this machine was removed from Monitor (Run stops reporting and says so)
      if (!id) return send(res, 401, { error: 'This machine isn\'t connected to Pathline Monitor' });
      const b = await body(req);
      apps.set(id, String(b.app || '').slice(0, 40));
      machines.report(id, b, now);
      return send(res, 204);
    }
    // a machine waiting for asks for data: answered with them as they come, or 204 after a while
    if (p === '/api/v1/asks' && req.method === 'GET') {
      const id = machineOf(req);
      if (!id) return send(res, 401, { error: 'This machine isn\'t connected to Pathline Monitor' });
      const list = await pulls.next(id, (f) => res.on('close', f));
      if (res.writableEnded || res.destroyed) return;
      return list.length ? send(res, 200, list) : send(res, 204);
    }
    // a machine's answer to one: the file bundle it made (or its error), held until collected
    if (p.startsWith('/api/v1/answer/') && post) {
      const id = machineOf(req);
      if (!id) return send(res, 401, { error: 'This machine isn\'t connected to Pathline Monitor' });
      let data;
      try { data = await raw(req, pulls.maxAnswer); } catch (e) { return send(res, e.code === 413 ? 413 : 400, { error: e.code === 413 ? 'Too large: ' + Math.round(pulls.maxAnswer / 1048576) + ' MB at most' : e.message }); }
      const status = Number(req.headers['x-pathline-status']) || 200;
      try {
        pulls.answer(id, decodeURIComponent(p.slice('/api/v1/answer/'.length)), {
          status: status >= 200 && status < 600 ? status : 500,
          type: String(req.headers['content-type'] || 'application/octet-stream').slice(0, 100),
          name: String(req.headers['x-pathline-name'] || '').replace(/[^\w.@-]/g, '_').slice(0, 120),
          body: data,
        }, now);
      } catch (e) { return send(res, e.code || 500, { error: e.message }); }
      return send(res, 204);
    }
    // a Prepare computer's call carries a body (a job package, the materials list): the machine
    // fetches it here once it has taken the call
    const ab = /^\/api\/v1\/asks\/([\w-]{8,40})\/body$/.exec(p);
    if (ab && req.method === 'GET') {
      const id = machineOf(req);
      if (!id) return send(res, 401, { error: 'This machine isn\'t connected to Pathline Monitor' });
      let b;
      try { b = pulls.bodyOf(id, ab[1]); } catch (e) { return send(res, e.code || 500, { error: e.message }); }
      res.writeHead(200, { ...SAFE, 'content-type': b.type, 'cache-control': 'no-store', 'content-length': b.body.length });
      return res.end(b.body);
    }

    // ---- Pathline Prepare: signs in once (workshop password + authenticator code), then calls machines
    if (p === '/api/v1/prepare/join' && post) {
      const ip = ipOf(req);
      if (blocked(ip, now)) return send(res, 429, { error: 'Too many tries. Wait a few minutes and try again.' });
      const b = await body(req);
      if (!validId(b.id)) return send(res, 400, { error: 'Bad computer id' });
      if (!same(b.password, PASSWORD)) { failed(ip, now); return send(res, 403, { need: 'password', error: 'That isn\'t the workshop password.' }); }
      if (!twoStep) return send(res, 409, { need: 'setup', error: 'Two-step sign-in isn\'t set up yet. On a phone signed in to Pathline Monitor, open Settings, Pathline Prepare, and set up the authenticator app first.' });
      if (!String(b.code || '').trim()) return send(res, 401, { need: 'code', error: 'Type the 6-digit code from the authenticator app.' });
      if (stepBlocked(now)) return send(res, 429, { error: 'Too many wrong codes. Wait 10 minutes and try again.' });
      if (!codeOk(b.code, now)) { stepFailed(ip, now); return send(res, 403, { need: 'code', error: 'That code isn\'t right, or it was used already. Type the code the app shows now.' }); }
      fails.delete(ip);
      const key = crypto.randomBytes(32).toString('base64url');
      const old = computers[b.id];
      if (old) byPrepKey.delete(old.key);
      computers[b.id] = { id: b.id, name: String(b.name || 'Pathline Prepare').replace(/[\r\n]+/g, ' ').slice(0, 60), key: hash(key), pw, addedAt: old ? old.addedAt : now, seenAt: now };
      byPrepKey.set(hash(key), b.id);
      saveComputers();
      log('Pathline Prepare signed in: ' + computers[b.id].name + ' (' + b.id + ')');
      // in every phone's Alerts list (not a notification): who can now send jobs to the machines
      if (!old) raise({ kind: 'info', tags: [], machine: null, title: 'Pathline Prepare signed in on ' + computers[b.id].name, body: 'It can send jobs to the machines\' queues. Remove it in Settings, Pathline Prepare, if that wasn\'t you.', at: now });
      return send(res, 200, { key, name: computers[b.id].name, machines: machineList(now) });
    }
    if (p.startsWith('/api/v1/prepare/')) {
      const c = computers[byPrepKey.get(hash(bearer(req)))];
      if (!c) return send(res, 401, { error: 'This computer isn\'t signed in to Pathline Monitor any more. Sign in again in Pathline Prepare: Setup, Machines, Add machine, Machines in your workshop.' });
      if (now - (c.seenAt || 0) > 60000) { c.seenAt = now; saveComputers(); }
      if (p === '/api/v1/prepare/machines' && req.method === 'GET') return send(res, 200, { machines: machineList(now) });
      if (p === '/api/v1/prepare/leave' && post) {
        byPrepKey.delete(c.key);
        delete computers[c.id];
        saveComputers();
        log('Pathline Prepare signed out: ' + c.name + ' (' + c.id + ')');
        return send(res, 200, { ok: true });
      }
      const cm = /^\/api\/v1\/prepare\/call\/([a-z0-9-]{8,64})$/i.exec(p);
      if (cm && post) {
        const e = enrolled[cm[1]];
        if (!e) return send(res, 404, { error: 'That machine isn\'t in Pathline Monitor any more' });
        const call = String(req.headers['x-pathline-call'] || '').trim();
        if (!callOk(call)) return send(res, 403, { error: 'Not through Pathline Monitor. Start, moving the head and the machine\'s outputs are only at the machine, or from Pathline Prepare on the workshop network.' });
        if (!pulls.listening(e.id, now)) return send(res, 503, { offline: true, error: nameOf(e) + ' isn\'t connected to Pathline Monitor right now: its computer is off, Pathline Run is closed, or Run has this turned off.' });
        let data = Buffer.alloc(0);
        if (/^(POST|PUT) /.test(call)) {
          try { data = await raw(req, pulls.maxAnswer); } catch (err) { return send(res, err.code === 413 ? 413 : 400, { error: err.code === 413 ? 'Too large: ' + Math.round(pulls.maxAnswer / 1048576) + ' MB at most' : err.message }); }
        }
        let r;
        try { r = await pulls.call(e.id, { call, from: { id: c.id, name: c.name }, body: data, type: String(req.headers['content-type'] || 'application/json').slice(0, 100) }, CALL_MS, (f) => res.on('close', f)); } catch (err) {
          if (res.writableEnded || res.destroyed) return;
          return send(res, err.code === 504 ? 504 : err.code || 503, { offline: err.code !== 507, error: nameOf(e) + ': ' + err.message });
        }
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(r.status, { ...SAFE, 'content-type': r.type, 'cache-control': 'no-store', 'content-length': r.body.length, 'x-pathline-via': 'monitor' });
        return res.end(r.body);
      }
      return send(res, 404, { error: 'No route ' + p });
    }

    // ---- pulls: the pull token asks a machine for data, then collects its answer
    if (p === '/api/pull' || p.startsWith('/api/pull/')) {
      if (!PULL_TOKEN) return send(res, 404, { error: 'Pulling isn\'t set up on this server. install.sh makes a pull token in /etc/pathline-monitor/pull-token' });
      const ip = ipOf(req);
      if (blocked(ip, now)) return send(res, 429, { error: 'Too many tries. Wait a few minutes.' });
      if (!same(bearer(req), PULL_TOKEN)) { failed(ip, now); return send(res, 401, { error: 'That isn\'t the pull token' }); }
      if (p === '/api/pull/machines' && req.method === 'GET') {
        return send(res, 200, { what: WHAT, machines: Object.values(enrolled).map((e) => { const m = machines.list.get(e.id); return { id: e.id, name: nameOf(e), reporting: !!m && now - m.at < 35000, listening: pulls.listening(e.id, now), app: apps.get(e.id) || null }; }) });
      }
      if (p === '/api/pull' && post) {
        const b = await body(req);
        const want = String(b.machine || '').trim().toLowerCase();
        const e = enrolled[b.machine] || Object.values(enrolled).find((x) => x.id.toLowerCase() === want || nameOf(x).toLowerCase() === want);
        if (!e) return send(res, 404, { error: 'No machine "' + String(b.machine || '').slice(0, 60) + '" in Pathline Monitor' });
        let a;
        try { a = pulls.add(e.id, checkAsk(b), now); } catch (err) { return send(res, err.code || 400, { error: err.message }); }
        log('pull: asked ' + nameOf(e) + ' for ' + a.what + (a.day ? ' ' + a.day : '') + (a.job ? ' ' + a.job : ''));
        return send(res, 202, { id: a.id, machine: { id: e.id, name: nameOf(e) }, what: a.what, day: a.day, job: a.job, listening: pulls.listening(e.id, now) });
      }
      const m = /^\/api\/pull\/([\w-]{8,40})$/.exec(p);
      if (m && req.method === 'GET') {
        const r = await pulls.collect(m[1], (f) => res.on('close', f));
        if (res.writableEnded || res.destroyed) return;
        if (!r) return send(res, 404, { error: 'No such pull: it was collected already, or has run out' });
        if (r.state === 'failed') return send(res, 410, { error: r.ask.error || 'Given up' });
        if (r.state !== 'answered') return send(res, 202, { state: r.state, listening: pulls.listening(r.ask.machine) });
        const reply = r.ask.reply;
        res.writeHead(reply.status, { ...SAFE, 'content-type': reply.type, 'cache-control': 'no-store', 'content-length': reply.body.length, ...(reply.name ? { 'x-pathline-name': reply.name } : {}) });
        return res.end(reply.body);
      }
      return send(res, 404, { error: 'No route ' + p });
    }
    if (p === '/api/v1/enrol' && post) {
      const ip = ipOf(req);
      if (blocked(ip, now)) return send(res, 429, { error: 'Too many tries. Wait a few minutes.' });
      const b = await body(req);
      const code = String(b.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!(codes.get(code) > now)) { failed(ip, now); return send(res, 403, { error: 'That code isn\'t right, or it has run out. Get a new one in Pathline Monitor: Settings, Add a machine.' }); }
      if (!validId(b.id)) return send(res, 400, { error: 'Bad machine id' });
      codes.delete(code);
      const key = crypto.randomBytes(32).toString('base64url');
      const old = enrolled[b.id];
      if (old) byKey.delete(old.key);
      enrolled[b.id] = { id: b.id, name: String(b.name || b.id).slice(0, 60), key: hash(key), addedAt: old ? old.addedAt : now };
      byKey.set(hash(key), b.id);
      save('machines.json', enrolled);
      if (!old) machines.add(b.id, enrolled[b.id].name, now);
      log('machine ' + (old ? 'connected again: ' : 'added: ') + enrolled[b.id].name + ' (' + b.id + ')');
      return send(res, 200, { key });
    }

    // ---- phones
    if (p === '/api/login' && post) {
      const ip = ipOf(req);
      if (blocked(ip, now)) return send(res, 429, { error: 'Too many tries. Wait a few minutes and try again.' });
      const b = await body(req);
      if (!validId(b.id)) return send(res, 400, { error: 'Bad device id' });
      if (!same(b.password, PASSWORD)) { failed(ip, now); return send(res, 403, { error: 'That isn\'t the workshop password.' }); }
      fails.delete(ip);
      devices[b.id] = { prefs: { ...DEFAULT_PREFS }, ...devices[b.id], id: b.id, pw, seenAt: now };
      saveDevices();
      if (!origin && req.headers.host) origin = 'https://' + req.headers.host;
      return send(res, 200, { ok: true }, { 'set-cookie': cookie(req, b.id + '.' + sign(b.id), 400 * 86400) });
    }
    if (p.startsWith('/api/')) {
      const d = phone(req);
      if (!d) return send(res, 401, { error: 'Sign in' });
      if (p === '/api/events') {
        res.writeHead(200, { ...SAFE, 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
        res.write('retry: 3000\n\ndata: ' + JSON.stringify(snapshot()) + '\n\n');
        streams.add(res);
        req.on('close', () => streams.delete(res));
        return;
      }
      const state = () => ({ prefs: { ...DEFAULT_PREFS, ...d.prefs }, notifications: !!d.subscription });
      // this phone's settings; asking also keeps it signed in for another 400 days
      if (p === '/api/device' && !post) { d.seenAt = now; return send(res, 200, state(), { 'set-cookie': cookie(req, d.id + '.' + sign(d.id), 400 * 86400) }); }
      if (p === '/api/device' && post) {
        const b = await body(req);
        if (b.prefs && typeof b.prefs === 'object') d.prefs = { ...DEFAULT_PREFS, ...b.prefs, mute: { ...(b.prefs.mute || {}) } };
        if ('subscription' in b) d.subscription = b.subscription && push.valid(b.subscription) ? { endpoint: b.subscription.endpoint, keys: { p256dh: b.subscription.keys.p256dh, auth: b.subscription.keys.auth } } : null;
        if (typeof b.name === 'string') d.name = b.name.slice(0, 80);
        saveDevices();
        return send(res, 200, state());
      }
      if (p === '/api/test-push' && post) {
        if (!d.subscription) return send(res, 409, { error: 'Notifications aren\'t on for this phone yet' });
        return (await pushTo(d, { title: 'Pathline Monitor', body: 'Notifications are working on this phone.', kind: 'info', silent: false }, true)) ? send(res, 200, { ok: true }) : send(res, 502, { error: 'The phone\'s notification service didn\'t take it. Turn notifications off and on again.' });
      }
      if (p === '/api/logout' && post) { delete devices[d.id]; saveDevices(); return send(res, 200, { ok: true }, { 'set-cookie': cookie(req, '', 0) }); }
      if (p === '/api/machine-code' && post) return send(res, 200, { code: newCode(now), minutes: 10 });
      // Settings, Pathline Prepare: the authenticator app's setup, and the computers signed in
      if (p === '/api/prepare' && !post) return send(res, 200, prepareView());
      if (p === '/api/prepare/two-step' && post) {
        const b = await body(req);
        const ip = ipOf(req);
        // set up already: replacing it takes a code from the app as it is now (or a spare)
        if (twoStep) {
          if (blocked(ip, now) || stepBlocked(now)) return send(res, 429, { error: 'Too many wrong codes. Wait 10 minutes and try again.' });
          if (!codeOk(b.code, now)) { stepFailed(ip, now); return send(res, 403, { need: 'code', error: 'To set it up again, first type a code from the authenticator app as it is now, or a spare code.' }); }
        }
        const secret = totp.newSecret();
        pendingSteps.set(d.id, { secret, until: now + 600000 });
        return send(res, 200, { secret, uri: totp.uri(secret, accountOf(req)), account: accountOf(req), minutes: 10 });
      }
      if (p === '/api/prepare/two-step/confirm' && post) {
        const b = await body(req);
        const ip = ipOf(req);
        if (blocked(ip, now)) return send(res, 429, { error: 'Too many tries. Wait a few minutes and try again.' });
        const pd = pendingSteps.get(d.id);
        if (!pd || pd.until < now) return send(res, 409, { error: 'Start again: a setup lasts 10 minutes.' });
        const step = totp.check(pd.secret, b.code, now);
        if (step < 0) { failed(ip, now); return send(res, 403, { error: 'That code doesn\'t match. Type the code the app shows now, and check the phone sets its clock automatically.' }); }
        pendingSteps.delete(d.id);
        const spare = totp.newSpares();
        const again = !!twoStep;
        // (the code that confirmed it may still sign in a computer within its 30 s)
        twoStep = { secret: pd.secret, setAt: now, lastStep: -1, spare: spare.map(totp.hashSpare) };
        saveTwoStep();
        log('two-step sign-in for Pathline Prepare ' + (again ? 'set up again' : 'set up'));
        return send(res, 200, { ...prepareView(), spare });
      }
      if (p === '/api/prepare/spare' && post) {
        const b = await body(req);
        const ip = ipOf(req);
        if (!twoStep) return send(res, 409, { error: 'Set up the authenticator app first' });
        if (blocked(ip, now) || stepBlocked(now)) return send(res, 429, { error: 'Too many wrong codes. Wait 10 minutes and try again.' });
        if (!codeOk(b.code, now)) { stepFailed(ip, now); return send(res, 403, { need: 'code', error: 'Type a code from the authenticator app first.' }); }
        const spare = totp.newSpares();
        twoStep.spare = spare.map(totp.hashSpare);
        saveTwoStep();
        log('two-step: new spare codes made (the old ones no longer work)');
        return send(res, 200, { ...prepareView(), spare });
      }
      if (p === '/api/prepare/remove' && post) {
        const c = computers[(await body(req)).id];
        if (!c) return send(res, 404, { error: 'No such computer' });
        byPrepKey.delete(c.key);
        delete computers[c.id];
        saveComputers();
        log('Pathline Prepare removed: ' + c.name + ' (' + c.id + ')');
        return send(res, 200, prepareView());
      }
      if (p === '/api/machine-remove' && post) {
        const m = enrolled[(await body(req)).id];
        if (!m) return send(res, 404, { error: 'No such machine' });
        byKey.delete(m.key);
        delete enrolled[m.id];
        machines.remove(m.id);
        pulls.dropMachine(m.id);
        save('machines.json', enrolled);
        saveState();
        tell({ gone: m.id });
        log('machine removed: ' + m.name + ' (' + m.id + ')');
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'No route ' + p });
    }

    // ---- the app's own files
    const full = path.join(APP, p === '/' ? 'index.html' : decodeURIComponent(p.slice(1)));
    if (!full.startsWith(APP + path.sep) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404, SAFE); return res.end('Not found'); }
    // the service worker and the page are always checked for a newer copy; icons can be kept
    const ext = path.extname(full);
    res.writeHead(200, { ...SAFE, 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': ext === '.png' || ext === '.svg' ? 'max-age=86400' : 'no-cache' });
    fs.createReadStream(full).pipe(res);
  } catch (e) {
    if (!res.headersSent) send(res, e.message === 'Not JSON' || e.message === 'Too large' ? 400 : 500, { error: e.message });
  }
}

const server = tls ? require('https').createServer(tls, handle) : require('http').createServer(handle);
server.listen(PORT, HOST, () => log('Pathline Monitor ' + pkg.version + ' on ' + (tls ? 'https' : 'http') + '://' + HOST + ':' + server.address().port + ' · ' + machines.list.size + ' machines · data in ' + DATA + ' · pulls ' + (PULL_TOKEN ? 'on' : 'off (no pull token)') + ' · Pathline Prepare ' + (twoStep ? 'on (' + Object.keys(computers).length + ' signed in)' : 'off until the authenticator app is set up')));
// a machine waiting on GET /api/v1/asks holds its request open for up to 25 s
server.requestTimeout = 0;
// who has gone quiet; and a comment line every 25 s keeps live connections open through
// web servers in front and phone sleep
setInterval(() => machines.tick(), 5000);
setInterval(() => { for (const res of streams) res.write(': keep-alive\n\n'); }, 25000);
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { saveState(); process.exit(0); });

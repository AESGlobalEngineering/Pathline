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
//                                 nothing ever goes back to a machine.
// Phones:    the app (app/), signed in with the workshop password; live over GET /api/events.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const push = require('./lib/push');
const { Machines } = require('./lib/machines');
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

// alerts.json: newest first, the last 300 or the last 14 days
let alerts = load('alerts.json', []);
const keepAlerts = () => { const cut = Date.now() - 14 * 864e5; alerts = alerts.filter((a) => a.at > cut).slice(0, 300); save('alerts.json', alerts); };

// ---------------------------------------------------------------- machines, alerts, phones
const streams = new Set();
const tell = (v) => { const msg = 'data: ' + JSON.stringify({ now: Date.now(), ...v }) + '\n\n'; for (const res of streams) res.write(msg); };
let saving = null;
const saveState = () => { clearTimeout(saving); saving = null; save('state.json', Object.fromEntries(machines.views().map((v) => [v.id, v]))); };
const machines = new Machines({
  saved: load('state.json', {}),
  onChange: (m) => { tell({ m }); saving = saving || setTimeout(saveState, 2000); },
  onAlert: (a) => {
    a.id = crypto.randomBytes(6).toString('hex');
    alerts.unshift(a);
    keepAlerts();
    log('alert: ' + a.title + ' · ' + a.body);
    tell({ alert: a });
    notify(a);
  },
});
for (const m of Object.values(enrolled)) machines.add(m.id, m.name);
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
const send = (res, code, v, extra) => { res.writeHead(code, { ...SAFE, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra }); res.end(v === undefined ? '' : JSON.stringify(v)); };

async function handle(req, res) {
  const p = new URL(req.url, 'http://x').pathname;
  const post = req.method === 'POST';
  const now = Date.now();
  try {
    // ---- machines
    if (p === '/api/v1/report' && post) {
      const id = byKey.get(hash((req.headers.authorization || '').replace(/^Bearer\s+/i, '')));
      // 401: this machine was removed from Monitor (Run stops reporting and says so)
      if (!id) return send(res, 401, { error: 'This machine isn\'t connected to Pathline Monitor' });
      machines.report(id, await body(req), now);
      return send(res, 204);
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
      if (p === '/api/machine-remove' && post) {
        const m = enrolled[(await body(req)).id];
        if (!m) return send(res, 404, { error: 'No such machine' });
        byKey.delete(m.key);
        delete enrolled[m.id];
        machines.remove(m.id);
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
    send(res, e.message === 'Not JSON' || e.message === 'Too large' ? 400 : 500, { error: e.message });
  }
}

const server = tls ? require('https').createServer(tls, handle) : require('http').createServer(handle);
server.listen(PORT, HOST, () => log('Pathline Monitor ' + pkg.version + ' on ' + (tls ? 'https' : 'http') + '://' + HOST + ':' + server.address().port + ' · ' + machines.list.size + ' machines · data in ' + DATA));
// who has gone quiet; and a comment line every 25 s keeps live connections open through
// web servers in front and phone sleep
setInterval(() => machines.tick(), 5000);
setInterval(() => { for (const res of streams) res.write(': keep-alive\n\n'); }, 25000);
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { saveState(); process.exit(0); });

#!/usr/bin/env node
// Pathline Monitor: watches every Pathline Run machine on the workshop network, keeps the
// alerts, and serves the phone app (app/) on the local network.
//
//   node server.js [--config config.json] [--port 8480] [--https-port 8443] [--data data]
//
// Machines are found on the network the way Pathline Prepare finds them (src/main/discover.js:
// Run's mDNS announcement and a scan of this computer's networks for port 8470), and kept in
// data/found.json. config.json is optional:
//   { "port": 8480, "httpsPort": 8443, "find": true, "machines": [{ "name": "Laser A", "host": "192.168.1.40" }],
//     "tls": { "cert": "cert.pem", "key": "key.pem" }, "https": true }
// Two addresses: http on 8480 (any phone, and the setup page) and https on 8443, the full app
// (installable, offline, notifications with the app closed). The https certificate is the
// workshop's own (lib/certs.js), made here; each phone trusts it once from the setup page.
// "tls" uses a certificate from IT instead; "https": false turns https off.
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const webpush = require('web-push');
const { Watcher } = require('./lib/watch');
const pkg = require('./package.json');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const confPath = path.resolve(arg('config', path.join(__dirname, 'config.json')));
const conf = fs.existsSync(confPath) ? JSON.parse(fs.readFileSync(confPath, 'utf8')) : {};
const DATA = path.resolve(path.dirname(confPath), arg('data', conf.data || 'data'));
const PORT = Number(arg('port', conf.port || 8480));
const HTTPS_PORT = Number(arg('https-port', conf.httpsPort || 8443));
fs.mkdirSync(DATA, { recursive: true });
const log = (s) => console.log(new Date().toTimeString().slice(0, 8) + '  ' + s);


// this computer's own addresses, for phones to open
// (virtual adapters last: Hyper-V, WSL, VirtualBox, VPNs, so the first is usually the Wi-Fi or Ethernet one)
const addresses = () => {
  const out = [];
  for (const [name, list] of Object.entries(require('os').networkInterfaces())) {
    for (const a of list || []) {
      if (!(a.family === 'IPv4' || a.family === 4) || a.internal || /^169\.254\./.test(a.address)) continue;
      out.push({ ip: a.address, virtual: /vethernet|virtual|vmware|vbox|hyper-v|wsl|docker|tailscale|zerotier|vpn|loopback/i.test(name) });
    }
  }
  return out.sort((a, b) => a.virtual - b.virtual).map((a) => a.ip);
};

// https: a certificate from IT ("tls"), else the workshop's own (made or renewed here)
const certs = require('./lib/certs');
let ca = null;
function loadTls() {
  if (conf.tls && conf.tls.cert && conf.tls.key) return { cert: fs.readFileSync(path.resolve(path.dirname(confPath), conf.tls.cert)), key: fs.readFileSync(path.resolve(path.dirname(confPath), conf.tls.key)) };
  if (conf.https === false) return null;
  const c = certs.ensure(DATA, addresses(), log);
  ca = c.ca;
  return { cert: c.cert, key: c.key };
}
let tls = null;
try { tls = loadTls(); } catch (e) { log('https unavailable: ' + e.message); }

// ---------------------------------------------------------------- kept on disk
const file = (n) => path.join(DATA, n);
const load = (n, d) => { try { return JSON.parse(fs.readFileSync(file(n), 'utf8')); } catch (e) { return d; } };
const save = (n, v) => { fs.writeFileSync(file(n) + '.tmp', JSON.stringify(v, null, 1)); fs.renameSync(file(n) + '.tmp', file(n)); };

// the push keys: made once, kept, so phones stay subscribed across restarts
let vapid = load('vapid.json', null);
if (!vapid) { vapid = webpush.generateVAPIDKeys(); save('vapid.json', vapid); }
webpush.setVapidDetails(conf.contact || 'mailto:workshop@localhost', vapid.publicKey, vapid.privateKey);

// alerts, newest first, the last 300 or the last 14 days
let alerts = load('alerts.json', []);
const keepAlerts = () => { const cut = Date.now() - 14 * 864e5; alerts = alerts.filter((a) => a.at > cut).slice(0, 300); save('alerts.json', alerts); };

// one entry per phone: its push subscription (if it turned notifications on) and what it wants
//   { id, name, subscription, prefs: { done, queue, attn, err, quiet, mute: { machineId: true } }, seenAt }
let devices = load('devices.json', {});
const DEFAULT_PREFS = { done: true, queue: true, attn: true, err: true, quiet: false, sound: true, mute: {} };
const saveDevices = () => save('devices.json', devices);

// quiet hours (18:00 to 07:00, the phone's own clock is given with the prefs): delivered without a sound
function quietNow(prefs) {
  if (!prefs.quiet) return false;
  const off = Number.isFinite(prefs.tzOffset) ? prefs.tzOffset : new Date().getTimezoneOffset();
  const local = new Date(Date.now() - off * 60000);
  const h = local.getUTCHours();
  return h >= 18 || h < 7;
}

async function push(alert) {
  for (const d of Object.values(devices)) {
    if (!d.subscription) continue;
    const p = { ...DEFAULT_PREFS, ...d.prefs };
    if (p.mute && p.mute[alert.machine]) continue;
    if (!alert.tags.some((t) => p[t])) continue;
    const payload = JSON.stringify({ title: alert.title, body: alert.body, machine: alert.machine, id: alert.id, kind: alert.kind, silent: quietNow(p) });
    try {
      await webpush.sendNotification(d.subscription, payload, { TTL: 3600, urgency: alert.kind === 'done' ? 'normal' : 'high' });
    } catch (e) {
      // the phone unsubscribed or the browser dropped it: forget the subscription
      if (e.statusCode === 404 || e.statusCode === 410) { d.subscription = null; saveDevices(); log('push: ' + (d.name || d.id) + ' unsubscribed'); }
      else log('push to ' + (d.name || d.id) + ' failed: ' + (e.body || e.message));
    }
  }
}

// ---------------------------------------------------------------- the machines
let machines = [];
const streams = new Set();
const snapshot = () => ({ app: pkg.version, now: Date.now(), machines, alerts: alerts.slice(0, 100), finding: !!finding, lastFind, canFind: !!discover && conf.find !== false, push: !!tls });
function broadcast() {
  const msg = 'data: ' + JSON.stringify(snapshot()) + '\n\n';
  for (const res of streams) res.write(msg);
}
const found = load('found.json', []);
const watcher = new Watcher([...(conf.machines || []), ...found.map((m) => ({ ...m, found: true }))], {
  log,
  onAlert: (a) => {
    a.id = crypto.randomBytes(6).toString('hex');
    alerts.unshift(a);
    keepAlerts();
    log('alert: ' + a.title + ' · ' + a.body);
    push(a);
  },
  onChange: (v) => { machines = v; broadcast(); },
});

// Prepare's network search (src/main/discover.js), on start, every 10 min and when a phone asks
let discover = null;
try { discover = require('../src/main/discover.js'); } catch (e) { log('Network search unavailable (' + e.message + '): list machines in config.json'); }
let finding = null;
let lastFind = 0;
function findMachines() {
  if (!discover || conf.find === false) return Promise.resolve({ added: 0 });
  if (finding) return finding;
  finding = discover.find({ timeout: 1500 }).then((list) => {
    let added = 0;
    for (const f of list) {
      const known = watcher.find(f.ip, f.port, f.id);
      if (known) {
        // the same Run (its id), somewhere new
        if (f.id && known.conf.deviceId === f.id && (known.conf.host !== f.ip || known.conf.port !== f.port)) { log(known.id + ' moved to ' + f.ip + ':' + f.port); watcher.moveTo(known, f.ip, f.port); }
        continue;
      }
      if (watcher.add({ name: f.name || f.ip, host: f.ip, port: f.port, deviceId: f.id || undefined, found: true })) { added++; log('found ' + (f.name || f.ip) + ' at ' + f.ip + ':' + f.port); }
    }
    save('found.json', watcher.list.filter((m) => m.conf.found).map((m) => ({ name: m.conf.name, host: m.conf.host, port: m.conf.port, deviceId: m.conf.deviceId })));
    lastFind = Date.now();
    return { added, seen: list.length };
  }).catch((e) => { log('network search failed: ' + e.message); return { added: 0, error: e.message }; })
    .finally(() => { finding = null; broadcast(); });
  broadcast();
  return finding;
}
setInterval(findMachines, 10 * 60 * 1000);

const phoneUrls = () => addresses().map((ip) => 'http://' + ip + ':' + PORT + '/');
const appUrls = () => (tls ? addresses().filter((ip) => !ca || certs.isPrivate(ip)).map((ip) => 'https://' + ip + ':' + HTTPS_PORT + '/') : []);
// the address phones open, and the same as a QR code for a phone's camera
const qrcode = require('qrcode-generator');
function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

// ---------------------------------------------------------------- http
const APP = path.join(__dirname, 'app');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

function body(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 64 * 1024) { reject(new Error('Too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(new Error('Not JSON')); } });
  });
}
const send = (res, code, v) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(v)); };
const validId = (s) => typeof s === 'string' && /^[a-z0-9-]{8,64}$/i.test(s);

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/api/state') return send(res, 200, snapshot());
    if (p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 3000\n\ndata: ' + JSON.stringify(snapshot()) + '\n\n');
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return;
    }
    if (p === '/api/push-key') return send(res, 200, { key: vapid.publicKey });
    // the addresses phones open; the QR code is the setup page (it walks a phone through the rest)
    if (p === '/api/phone') { const urls = phoneUrls(); return send(res, 200, { urls, app: appUrls(), httpsPort: tls ? HTTPS_PORT : null, own: !!ca, qr: urls[0] ? qrSvg(urls[0] + 'setup') : null }); }
    // reached over https by the setup page (which is on http): only answers if the phone trusts us
    if (p === '/api/ping') { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' }); return res.end('{"ok":true}'); }
    // the workshop certificate: a profile for iPhone, the certificate itself for Android
    if (p === '/workshop.mobileconfig' && ca) { res.writeHead(200, { 'content-type': 'application/x-apple-aspen-config', 'content-disposition': 'attachment; filename="Pathline Monitor workshop.mobileconfig"', 'cache-control': 'no-store' }); return res.end(certs.mobileconfig(ca)); }
    if (p === '/workshop-ca.crt' && ca) { res.writeHead(200, { 'content-type': 'application/x-x509-ca-cert', 'content-disposition': 'attachment; filename="pathline-monitor-workshop.crt"', 'cache-control': 'no-store' }); return res.end(ca.der); }
    if (p === '/api/find' && req.method === 'POST') return send(res, 200, await findMachines());
    // a phone's settings, and its push subscription once notifications are turned on
    if (p === '/api/device' && req.method === 'POST') {
      const b = await body(req);
      if (!validId(b.id)) return send(res, 400, { error: 'Bad device id' });
      const d = devices[b.id] || { id: b.id, prefs: { ...DEFAULT_PREFS } };
      if (b.prefs && typeof b.prefs === 'object') d.prefs = { ...DEFAULT_PREFS, ...b.prefs, mute: { ...(b.prefs.mute || {}) } };
      if ('subscription' in b) d.subscription = b.subscription && b.subscription.endpoint ? b.subscription : null;
      if (typeof b.name === 'string') d.name = b.name.slice(0, 80);
      d.seenAt = Date.now();
      devices[b.id] = d;
      saveDevices();
      return send(res, 200, { prefs: d.prefs, notifications: !!d.subscription });
    }
    if (p === '/api/device' && req.method === 'GET') {
      const d = devices[url.searchParams.get('id')];
      return send(res, 200, d ? { prefs: { ...DEFAULT_PREFS, ...d.prefs }, notifications: !!d.subscription } : { prefs: DEFAULT_PREFS, notifications: false });
    }
    // a test notification to this phone only
    if (p === '/api/test-push' && req.method === 'POST') {
      const b = await body(req);
      const d = devices[b.id];
      if (!d || !d.subscription) return send(res, 409, { error: 'Notifications aren\'t on for this phone yet' });
      await webpush.sendNotification(d.subscription, JSON.stringify({ title: 'Pathline Monitor', body: 'Notifications are working on this phone.', kind: 'info', silent: false }));
      return send(res, 200, { ok: true });
    }
    if (p.startsWith('/api/')) return send(res, 404, { error: 'No route ' + p });

    // the app
    let f = p === '/' ? 'index.html' : p === '/setup' ? 'setup.html' : decodeURIComponent(p.slice(1));
    const full = path.join(APP, f);
    if (!full.startsWith(APP + path.sep) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    // the service worker and the page are always checked for a newer copy; icons can be kept
    const ext = path.extname(full);
    res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': ext === '.png' || ext === '.svg' ? 'max-age=86400' : 'no-cache' });
    fs.createReadStream(full).pipe(res);
  } catch (e) {
    send(res, 500, { error: e.message });
  }
}

// http (any phone, and the setup page) and, when there's a certificate, https (the full app)
const server = http.createServer(handle);
const secure = tls ? https.createServer(tls, handle) : null;
server.listen(PORT, () => {
  log('Pathline Monitor ' + pkg.version + ' · ' + watcher.list.length + ' machines so far · data in ' + DATA);
  const urls = phoneUrls();
  if (urls.length) log('  phones: scan the QR code on http://localhost:' + PORT + ' (on this PC), or open ' + urls[0] + 'setup');
  if (secure) secure.listen(HTTPS_PORT, () => { const a = appUrls(); if (a.length) log('  the full app (once a phone trusts the workshop certificate): ' + a[0]); });
  else log('No https: the app works, and alerts show while it\'s open (README.md).');
  watcher.start();
  findMachines();
});
// the workshop certificate follows this computer's addresses (and is renewed before it runs out)
if (secure && ca) setInterval(() => { try { const t = loadTls(); secure.setSecureContext(t); } catch (e) { log('certificate: ' + e.message); } }, 6 * 3600 * 1000);
// a comment line every 25 s keeps the live connection open through proxies and phone sleep
setInterval(() => { for (const res of streams) res.write(': keep-alive\n\n'); }, 25000);

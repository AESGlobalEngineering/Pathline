// Setup → Pathline Monitor: this machine reports its status to the workshop's Pathline Monitor
// server (hmi/RUN-REPORT-BRIEF.md), so phones see it from anywhere.
//
// It's one way. Run sends what GET /api/v1/monitor answers, and reads back only:
//   - the key, once, when the machine is added (POST /api/v1/enrol with the code from the app);
//   - a report's status code: 2xx sent, 401 removed in Pathline Monitor, anything else a failure.
// A report's answer body is never read. Nothing the server says changes the machine, a job, the
// settings or how often Run reports.
//
// It never gets in the machine's way: its own timer, one request at a time (8 s at most), every
// failure caught and shown only in the panel. The key lives in data/monitor-report.json, apart
// from the config (which is shown and exported); it isn't logged or shown.
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const MAX_BODY = 64 * 1024;

const fail = (msg, code = 400) => Object.assign(new Error(msg), { code });

// "monitor.example.com", "https://monitor.example.com/" → https://monitor.example.com.
// Plain http:// only for this computer (testing).
function address(s) {
  let a = String(s || '').trim();
  if (!a) throw fail('Type the Pathline Monitor address, such as monitor.example.com');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(a)) a = 'https://' + a;
  let u;
  try { u = new URL(a); } catch (e) { throw fail('"' + String(s).trim() + '" isn\'t an address. Type it as the app shows it, such as monitor.example.com'); }
  if (u.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(u.hostname)) throw fail('Pathline Monitor is reached over https only. Type the address without http:// (plain http works only for localhost, for testing)');
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw fail('Pathline Monitor\'s address starts https://');
  if (u.username || u.password || u.search || u.hash) throw fail('Type only the address, such as monitor.example.com');
  const base = u.origin + u.pathname.replace(/\/+$/, '');
  return { base, label: base.replace(/^https:\/\//, '') };
}

// "k7m-2qx", "K7M 2QX" → K7M2QX
function code(s) {
  const c = String(s || '').toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-Z0-9]{6}$/.test(c)) throw fail('The code is 6 letters and digits, such as K7M-2QX. Get one in the Pathline Monitor app: Settings, Add a machine');
  return c;
}

// o: { dataDir, view() (GET /api/v1/monitor's answer), onChange(fn), running(), info() → { id, name },
//      log, scale (shorter times, self-tests only) }
function createReporter(o) {
  const file = path.join(o.dataDir, 'monitor-report.json');
  const k = Number(o.scale) > 0 ? Number(o.scale) : 1;
  const T = { idle: 10000 * k, running: 5000 * k, gap: 1000 * k, timeout: 8000 * k };
  const log = (s) => { try { o.log('Pathline Monitor: ' + s); } catch (e) { /* never in the way */ } };

  // { address, key } as saved: the address is kept after Disconnect, to fill the field in again
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { /* not set up */ }
  const save = () => {
    try {
      require('./safefile').write(file, JSON.stringify(saved));
    } catch (e) { log('couldn\'t save the connection (' + e.message + ')'); }
  };
  const st = { lastSent: null, failingSince: null, failure: null, removed: !!saved.removed };

  // https, the certificate checked as usual; one connection, kept open between reports
  const agents = { 'http:': new http.Agent({ keepAlive: true, maxSockets: 1 }), 'https:': new https.Agent({ keepAlive: true, maxSockets: 1 }) };
  // POST json; resolves { status, body (only when read: enrol) } or { error }
  function post(url, data, headers, readBody) {
    return new Promise((resolve) => {
      let done = false, timer = null;
      const end = (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
      let u;
      try { u = new URL(url); } catch (e) { return end({ error: 'bad address' }); }
      const body = Buffer.from(JSON.stringify(data));
      const lib = u.protocol === 'https:' ? https : http;
      let req;
      try {
        req = lib.request(u, { method: 'POST', agent: agents[u.protocol], headers: { 'content-type': 'application/json', 'content-length': body.length, accept: 'application/json', ...headers } }, (res) => {
          if (!readBody) { res.resume(); res.on('end', () => end({ status: res.statusCode })); res.on('error', () => end({ status: res.statusCode })); return; }
          let s = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { s += c; if (s.length > MAX_BODY) req.destroy(); });
          res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (e) { /* not json */ } end({ status: res.statusCode, body: j }); });
          res.on('error', (e) => end({ error: e.message }));
        });
      } catch (e) { return end({ error: e.message }); }
      timer = setTimeout(() => { end({ error: 'no answer in ' + Math.round(T.timeout / 1000) + ' s' }); try { req.destroy(); } catch (e) { /* gone */ } }, T.timeout);
      req.on('error', (e) => end({ error: e.code || e.message }));
      req.end(body);
    });
  }

  // ---- reporting
  let inFlight = false, lastAttempt = 0, changed = true;
  try { o.onChange(() => { changed = true; }); } catch (e) { /* the timer still reports */ }

  // the newest state, under 64 KB (the server reads the first 20 of today and 100 of the queue)
  function body() {
    const v = o.view();
    if (Buffer.byteLength(JSON.stringify(v)) <= MAX_BODY) return v;
    return { ...v, today: (v.today || []).slice(0, 20), queue: (v.queue || []).slice(0, 100) };
  }

  async function report() {
    const key = saved.key, base = saved.address;
    inFlight = true; changed = false; lastAttempt = Date.now();
    let r;
    try { r = await post(base + '/api/v1/report', body(), { authorization: 'Bearer ' + key }, false); } catch (e) { r = { error: e.message }; }
    inFlight = false;
    // disconnected (or connected again) while it was on its way
    if (saved.key !== key) return;
    const now = Date.now();
    if (r.status >= 200 && r.status < 300) {
      if (st.failingSince) log('reaching ' + address(base).label + ' again');
      st.lastSent = now; st.failingSince = null; st.failure = null;
    } else if (r.status === 401) {
      log('this machine was removed in Pathline Monitor: reporting stopped');
      saved = { address: base, removed: true };
      save();
      Object.assign(st, { lastSent: null, failingSince: null, failure: null, removed: true });
    } else {
      if (!st.failingSince) { st.failingSince = now; log('can\'t reach ' + address(base).label + ' (' + (r.error || 'it answered ' + r.status) + '), still trying'); }
      st.failure = r.error || 'it answered ' + r.status;
    }
  }

  // every 10 s, every 5 s while a job runs, and straight away (at most once a second) when
  // something changed; while it can't be reached, only on the schedule
  function tick() {
    try {
      if (!saved.key || inFlight) return;
      const now = Date.now(), since = now - lastAttempt;
      const every = o.running() ? T.running : T.idle;
      if (since >= every || (changed && !st.failingSince && since >= T.gap)) report().catch(() => { inFlight = false; });
    } catch (e) { inFlight = false; }
  }
  const timer = setInterval(tick, Math.max(20, Math.min(100, T.gap / 4)));
  if (timer.unref) timer.unref();
  if (saved.key) log('reporting to ' + address(saved.address).label);

  // ---- Setup → Pathline Monitor
  async function connect(b) {
    const a = address(b && b.address), c = code(b && b.code);
    const me = o.info();
    const r = await post(a.base + '/api/v1/enrol', { code: c, id: me.id, name: me.name || me.id }, {}, true);
    const err = r.body && typeof r.body.error === 'string' ? r.body.error.slice(0, 300) : '';
    if (r.status === 200 && r.body && typeof r.body.key === 'string' && r.body.key) {
      saved = { address: a.base, key: r.body.key };
      save();
      Object.assign(st, { lastSent: null, failingSince: null, failure: null, removed: false });
      lastAttempt = 0; changed = true;
      log('connected: reporting to ' + a.label);
      tick();
      return status();
    }
    if ((r.status === 403 || r.status === 429) && err) throw fail(err);
    throw fail('Can\'t reach Pathline Monitor at ' + a.label + '. Check the address and this PC\'s internet.');
  }
  function disconnect() {
    if (saved.key) log('disconnected from ' + address(saved.address).label);
    saved = saved.address ? { address: saved.address } : {};
    save();
    Object.assign(st, { lastSent: null, failingSince: null, failure: null, removed: false });
    return status();
  }
  // for the panel (never the key)
  function status() {
    let label = null;
    try { label = saved.address ? address(saved.address).label : null; } catch (e) { /* kept as typed */ }
    return { connected: !!saved.key, address: label, lastSent: st.lastSent, failingSince: st.failingSince, failure: st.failure, removed: !saved.key && st.removed };
  }

  return { connect, disconnect, status, tick, close: () => { clearInterval(timer); for (const a of Object.values(agents)) a.destroy(); }, _T: T };
}

module.exports = { createReporter, address, code };

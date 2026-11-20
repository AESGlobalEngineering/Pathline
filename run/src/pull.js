// Pulls (Pathline Monitor 0.6): someone at the company asks Pathline Monitor for one thing from
// this machine (a day's diagnostics log, a job's drawings, the camera's pictures of its marks,
// its health …) and Run sends just that. Run hears the ask over its own outgoing connection to
// the Monitor server: it waits on GET /api/v1/asks the way a browser waits for a page, so nothing
// is opened at the workshop. Monitor hands the answer over and keeps nothing.
//
// It only ever reads. Each ask is checked against the list below (and its day and job against
// their patterns), and only the files that list names are read: an ask can't name a file, change
// a setting, or touch the machine or a job. Anything else in an ask is ignored. Every ask goes in
// the diagnostics log, and Setup → Pathline Monitor has a switch that turns pulls off.
//
// It never gets in a job's way: one ask at a time, on its own connection, and files are read and
// packed in small steps so the job's stream to the laser carries on in between.
//
// An answer is one gzipped JSON bundle: { format: 'pathline-run-pull', version: 1, machine, what,
// day, job, at, app, files: [{ name, size, mtime, data (base64) }] } (monitor/tools/pull.js
// unpacks it), or { error } with the status as x-pathline-status.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { execFile } = require('child_process');

const WHAT = ['list', 'log', 'job', 'marks', 'runs', 'fit', 'settings', 'health'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const JOB = /^J\d{1,8}$/;
const MAX_RAW = 48 * 1048576;   // the files of one answer, before packing (Monitor takes 64 MB packed)
const CHUNK = 3 * 262144;       // packed 768 KB at a time (a multiple of 3: base64 joins up)

const fail = (code, msg) => Object.assign(new Error(msg), { code });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kb = (n) => (n < 1048576 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
const dayOf = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

// an ask as Run will act on it, or a 400 with why not
function check(a) {
  const what = String((a && a.what) || '');
  if (!WHAT.includes(what)) throw fail(400, 'Pathline Run doesn\'t send "' + what.slice(0, 40) + '"');
  const day = a.day == null || a.day === '' ? null : String(a.day);
  const job = a.job == null || a.job === '' ? null : String(a.job).toUpperCase();
  if (day !== null && !DAY.test(day)) throw fail(400, 'A day is YYYY-MM-DD');
  if (job !== null && !JOB.test(job)) throw fail(400, 'A job is J and its number, such as J0123');
  if (what === 'log' && !day) throw fail(400, 'Which day?');
  if ((what === 'job' || what === 'marks') && !job) throw fail(400, 'Which job?');
  if (what === 'runs' && !job && !day) throw fail(400, 'Which job or day?');
  return { what, day: what === 'log' || what === 'runs' ? day : null, job: what === 'job' || what === 'marks' || what === 'runs' ? job : null };
}
const label = (a) => {
  const d = a.day ? new Date(a.day + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
  return { list: 'what it has', log: 'the ' + d + ' log', job: a.job + '\'s drawings', marks: a.job + '\'s mark pictures', runs: (a.job || 'the ' + d) + ' run records', fit: 'the head drawing fit and bed maps', settings: 'the settings', health: 'its health' }[a.what] || a.what;
};

// o: { dataDir, connection() → { base, key } | null, enabled() → bool, log, info() → { id, name },
//      jobs() → [{ id, name, status, receivedAt, finishedAt }], machine() → status, version, scale }
function createPuller(o) {
  const k = Number(o.scale) > 0 ? Number(o.scale) : 1;
  const T = { off: 5000 * k, retry: 10000 * k, old: 300000 * k, wait: 40000 * k, upload: 600000 * k };
  const DATA = path.resolve(o.dataDir);
  const log = (s) => { try { o.log(s); } catch (e) { /* never in the way */ } };
  const st = { listening: false, last: null };
  let stopped = false, current = null;
  // its own connections: a report never waits behind an ask
  const agents = { 'http:': new http.Agent({ keepAlive: true, maxSockets: 2 }), 'https:': new https.Agent({ keepAlive: true, maxSockets: 2 }) };

  // one request; resolves { status, body: Buffer } or { error }
  function request(method, url, headers, body, ms) {
    return new Promise((resolve) => {
      let done = false, timer = null, req = null;
      const end = (v) => { if (done) return; done = true; clearTimeout(timer); if (current === req) current = null; resolve(v); };
      let u;
      try { u = new URL(url); } catch (e) { return end({ error: 'bad address' }); }
      try {
        req = (u.protocol === 'https:' ? https : http).request(u, { method, agent: agents[u.protocol], headers }, (res) => {
          const parts = [];
          let n = 0;
          res.on('data', (c) => { n += c.length; if (n <= 65536) parts.push(c); else req.destroy(); });
          res.on('end', () => end({ status: res.statusCode, body: Buffer.concat(parts) }));
          res.on('error', (e) => end({ error: e.message }));
        });
      } catch (e) { return end({ error: e.message }); }
      current = req;
      timer = setTimeout(() => { end({ error: 'no answer in ' + Math.round(ms / 1000) + ' s' }); try { req.destroy(); } catch (e) { /* gone */ } }, ms);
      req.on('error', (e) => end({ error: e.code || e.message }));
      req.end(body || undefined);
    });
  }

  // ---- reading what an ask names (nothing else: every path is built here from checked parts)
  const inData = (...p) => { const f = path.resolve(DATA, ...p); if (f !== DATA && !f.startsWith(DATA + path.sep)) throw fail(400, 'Not in the data folder'); return f; };
  async function readFile(rel, name) {
    const f = inData(...rel);
    const [data, s] = await Promise.all([fs.promises.readFile(f), fs.promises.stat(f)]);
    return { name, data, mtime: s.mtime.toISOString() };
  }
  async function exists(...rel) { try { await fs.promises.access(inData(...rel)); return true; } catch (e) { return false; } }
  // a folder's files, two levels down at most
  async function folder(rel, prefix, depth = 0) {
    let names;
    try { names = await fs.promises.readdir(inData(...rel), { withFileTypes: true }); } catch (e) { return null; }
    const out = [];
    for (const d of names) {
      if (d.isFile()) out.push(await readFile([...rel, d.name], prefix + d.name));
      else if (d.isDirectory() && depth < 1) out.push(...((await folder([...rel, d.name], prefix + d.name + '/', depth + 1)) || []));
    }
    return out;
  }
  const json = (name, v) => ({ name, data: Buffer.from(JSON.stringify(v, null, 1)), mtime: new Date().toISOString() });
  async function dir(sub) { try { return await fs.promises.readdir(inData(sub)); } catch (e) { return []; } }

  async function gather(a) {
    if (a.what === 'list') {
      const logs = (await dir('logs')).map((f) => (f.match(/^run-(\d{4}-\d{2}-\d{2})\.log$/) || [])[1]).filter(Boolean).sort().reverse();
      const runs = await dir('runs');
      const marks = new Set(await dir('marks'));
      const jobs = [];
      for (const j of (o.jobs() || [])) {
        jobs.push({ id: j.id, name: j.name, status: j.status, receivedAt: j.receivedAt || null, finishedAt: j.finishedAt || null, files: await exists('jobs', j.id), marks: marks.has(j.id), runs: runs.filter((f) => f.startsWith(j.id + '-')).length });
      }
      return [json('list.json', { today: dayOf(new Date()), logs, jobs, runDays: [...new Set(runs.map((f) => (f.match(/-(\d{4}-\d{2}-\d{2})T/) || [])[1]).filter(Boolean))].sort().reverse() })];
    }
    if (a.what === 'log') {
      try { return [await readFile(['logs', 'run-' + a.day + '.log'], 'run-' + a.day + '.log')]; } catch (e) { throw fail(404, 'No log for ' + a.day + ' (the last 30 days are kept)'); }
    }
    if (a.what === 'job') {
      const files = await folder(['jobs', a.job], a.job + '/');
      if (!files || !files.length) throw fail(404, 'No files for ' + a.job + ' (a finished job\'s files are kept 30 days)');
      return files;
    }
    if (a.what === 'marks') {
      const files = await folder(['marks', a.job], a.job + '/');
      if (!files || !files.length) throw fail(404, 'No mark pictures for ' + a.job + ' (they\'re kept for the last 5 jobs)');
      return files;
    }
    if (a.what === 'runs') {
      const names = (await dir('runs')).filter((f) => /\.json$/.test(f) && (a.job ? f.startsWith(a.job + '-') : (f.match(/-(\d{4}-\d{2}-\d{2})T/) || [])[1] === a.day));
      if (!names.length) throw fail(404, 'No run records for ' + (a.job || a.day));
      const out = [];
      for (const f of names) out.push(await readFile(['runs', f], 'runs/' + f));
      return out;
    }
    const some = async (list) => { const out = []; for (const f of list) { try { out.push(await readFile([f], f)); } catch (e) { /* not there */ } } return out; };
    if (a.what === 'fit') return some(['follow.json', 'bedmaps.json']);
    // the settings: never monitor-report.json (the key)
    if (a.what === 'settings') return some(['config.json', 'materials.json', 'app.json']);
    if (a.what === 'health') return [json('health.json', await health())];
    throw fail(400, 'Pathline Run doesn\'t send that');
  }

  // ---- this computer's health: what a machine left alone in a workshop (a Pi above all) needs looked at
  const readText = (f) => fs.promises.readFile(f, 'utf8').then((s) => s.replace(/\0/g, '').trim(), () => null);
  const run = (cmd, args) => new Promise((r) => { try { execFile(cmd, args, { timeout: 3000, windowsHide: true }, (e, out) => r(e ? null : String(out).trim())); } catch (e) { r(null); } });
  async function health() {
    const now = Date.now();
    const h = {
      at: new Date(now).toISOString(), app: o.version || null, electron: process.versions.electron || null, node: process.version,
      platform: process.platform, arch: process.arch, os: os.release(), hostname: os.hostname(),
      bootedAt: new Date(now - os.uptime() * 1000).toISOString(), runStartedAt: new Date(now - process.uptime() * 1000).toISOString(),
      memory: { totalMB: Math.round(os.totalmem() / 1048576), freeMB: Math.round(os.freemem() / 1048576), runMB: Math.round(process.memoryUsage().rss / 1048576) },
      load: os.loadavg().map((x) => Math.round(x * 100) / 100), cpus: os.cpus().length,
    };
    try { const s = await fs.promises.statfs(DATA); h.disk = { freeMB: Math.round(s.bavail * s.bsize / 1048576), totalMB: Math.round(s.blocks * s.bsize / 1048576) }; } catch (e) { h.disk = null; }
    // how many times Pathline Run started today (its log says so at each start)
    try { h.startsToday = ((await fs.promises.readFile(inData('logs', 'run-' + dayOf(new Date()) + '.log'), 'utf8')).match(/Pathline Run \d+\.\d+\.\d+ on http/g) || []).length; } catch (e) { h.startsToday = null; }
    if (process.platform === 'linux') {
      h.osName = ((await readText('/etc/os-release')) || '').match(/^PRETTY_NAME="?([^"\n]*)/m)?.[1] || null;
      h.model = await readText('/proc/device-tree/model');
      const t = Number(await readText('/sys/class/thermal/thermal_zone0/temp'));
      h.temperatureC = Number.isFinite(t) && t > 0 ? Math.round(t / 100) / 10 : null;
      // a Raspberry Pi's power and heat flags (vcgencmd get_throttled): now, and since it started
      const thr = await run('vcgencmd', ['get_throttled']);
      const bits = thr && /0x([0-9a-f]+)/i.test(thr) ? parseInt(thr.match(/0x([0-9a-f]+)/i)[1], 16) : null;
      h.power = bits === null ? null : {
        raw: '0x' + bits.toString(16),
        underVoltageNow: !!(bits & 0x1), slowedNow: !!(bits & 0x2), throttledNow: !!(bits & 0x4), hotNow: !!(bits & 0x8),
        underVoltageSinceBoot: !!(bits & 0x10000), slowedSinceBoot: !!(bits & 0x20000), throttledSinceBoot: !!(bits & 0x40000), hotSinceBoot: !!(bits & 0x80000),
      };
    }
    try { const m = o.machine ? o.machine() : null; h.machine = m ? { state: m.state, link: m.link, message: m.message || '' } : null; } catch (e) { h.machine = null; }
    return h;
  }

  // ---- packing: gzipped JSON, a slice at a time
  async function pack(head, files) {
    const gz = zlib.createGzip({ level: 6 });
    const out = [];
    gz.on('data', (c) => out.push(c));
    const ended = new Promise((resolve, reject) => { gz.on('end', resolve); gz.on('error', reject); });
    const write = (s) => new Promise((resolve) => { if (gz.write(s)) setImmediate(resolve); else gz.once('drain', resolve); });
    const h = JSON.stringify(head);
    await write(h.slice(0, -1) + ',"files":[');
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      await write((i ? ',' : '') + '{"name":' + JSON.stringify(f.name) + ',"size":' + f.data.length + ',"mtime":' + JSON.stringify(f.mtime) + ',"data":"');
      for (let p = 0; p < f.data.length; p += CHUNK) await write(f.data.subarray(p, p + CHUNK).toString('base64'));
      await write('"}');
    }
    await write(']}');
    gz.end();
    await ended;
    return Buffer.concat(out);
  }

  async function answer(c, a) {
    const id = String((a && a.id) || '');
    if (!/^[\w-]{8,40}$/.test(id)) return;
    let ask = null, status = 200, type = 'application/gzip', name = '', payload, why = '';
    try {
      ask = check(a);
      const files = await gather(ask);
      const size = files.reduce((n, f) => n + f.data.length, 0);
      if (size > MAX_RAW) throw fail(413, 'Too big to send in one go (' + kb(size) + ')');
      const me = o.info();
      payload = await pack({ format: 'pathline-run-pull', version: 1, machine: { id: me.id, name: me.name || '' }, what: ask.what, day: ask.day, job: ask.job, at: new Date().toISOString(), app: o.version || null }, files);
      name = String(me.name || me.id).replace(/[^\w.-]+/g, '-') + '-' + ask.what + (ask.day ? '-' + ask.day : '') + (ask.job ? '-' + ask.job : '') + '.pull.json.gz';
      why = files.length + (files.length === 1 ? ' file, ' : ' files, ') + kb(payload.length);
    } catch (e) {
      status = typeof e.code === 'number' ? e.code : 500;
      type = 'application/json';
      why = e.message;
      payload = Buffer.from(JSON.stringify({ error: e.message }));
    }
    const r = await request('POST', c.base + '/api/v1/answer/' + encodeURIComponent(id), {
      authorization: 'Bearer ' + c.key, 'content-type': type, 'content-length': payload.length, 'x-pathline-status': String(status), ...(name ? { 'x-pathline-name': name } : {}),
    }, payload, T.upload);
    const sent = r.status === 204;
    st.last = { at: Date.now(), what: ask ? ask.what : String((a && a.what) || '').slice(0, 20), ok: sent && status === 200 };
    log('Pathline Monitor asked for ' + (ask ? label(ask) : '"' + String((a && a.what) || '').slice(0, 40) + '"') + ': ' +
      (status === 200 ? (sent ? 'sent (' + why + ')' : 'not sent (' + (r.error || 'it answered ' + r.status) + ')') : 'refused (' + why + ')'));
  }

  // ---- listening: one GET /api/v1/asks after another while connected with pulls on
  (async function listen() {
    while (!stopped) {
      const c = o.connection();
      if (!c || !o.enabled()) { st.listening = false; await sleep(T.off); continue; }
      const r = await request('GET', c.base + '/api/v1/asks', { authorization: 'Bearer ' + c.key, accept: 'application/json' }, null, T.wait);
      if (stopped) break;
      const now = o.connection();
      if (!now || now.key !== c.key || !o.enabled()) continue;
      if (r.status === 200 || r.status === 204) {
        st.listening = true;
        let list = [];
        if (r.status === 200) { try { list = JSON.parse(r.body.toString('utf8')); } catch (e) { list = []; } }
        for (const a of (Array.isArray(list) ? list : []).slice(0, 5)) {
          if (stopped || !o.enabled()) break;
          try { await answer(c, a); } catch (e) { log('Pathline Monitor ask: ' + e.message); }
        }
        continue;
      }
      st.listening = false;
      // a Pathline Monitor older than 0.6 has no asks: look again now and then
      await sleep(r.status === 404 ? T.old : T.retry);
    }
  })().catch((e) => log('Pathline Monitor asks stopped: ' + e.message));

  return {
    status: () => ({ listening: st.listening && !!o.connection() && o.enabled(), last: st.last }),
    close: () => { stopped = true; try { if (current) current.destroy(); } catch (e) { /* gone */ } for (const a of Object.values(agents)) a.destroy(); },
    _check: check,
  };
}

module.exports = { createPuller, check, WHAT };

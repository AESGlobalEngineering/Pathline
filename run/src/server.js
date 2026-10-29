#!/usr/bin/env node
// Pathline Run: the HMI that runs next to the machine.
//   /api/v1/…     the protocol Pathline talks (PROTOCOL.md)
//   /api/local/…  extra calls for this HMI's own screen
//   /             the touchscreen UI (ui/)
//
//   node src/server.js [--port 8470] [--data <folder>] [--sim] [--controller trotec|ruida] [--open]
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const Store = require('./store');
const Machine = require('./machine');
const validate = require('./job/validate');
const plan = require('./job/plan');
const { controller, CONTROLLERS } = require('./ctrl');
const pkgJson = require('../package.json');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const flag = (k) => argv.includes('--' + k);

const DATA = config.dataDir(arg('data'));
fs.mkdirSync(DATA, { recursive: true });
const overrides = {};
if (arg('controller')) overrides.controller = arg('controller');
let cfg = config.load(DATA, overrides);
if (flag('sim')) cfg.connection = { ...cfg.connection, mode: 'sim' };
const PORT = Number(arg('port', cfg.httpPort || 8470));
const UI = path.join(__dirname, '..', 'ui');

const logLines = [];
function log(msg) {
  const line = new Date().toLocaleTimeString() + '  ' + msg;
  console.log(line);
  logLines.push(line);
  if (logLines.length > 300) logLines.shift();
}

const store = new Store(DATA);
const machine = new Machine(cfg, store, log);

const err = (code, msg) => Object.assign(new Error(msg), { code });

function body(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(err(413, 'The job is too large (over ' + Math.round(limit / 1048576) + ' MB)')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8');
      try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(err(400, 'Body is not JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res, code, data) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

const jobsView = () => store.jobs.map((j) => ({
  id: j.id, name: j.name, status: j.status, progress: j.id === machine.st.job ? machine.st.progress : j.status === 'done' ? 1 : j.progress || 0,
  seconds: j.seconds, receivedAt: j.receivedAt, finishedAt: j.finishedAt
}));

function queueJob(pkg, source) {
  const warnings = validate.check(pkg, cfg);
  // convert now, so a job the controller can't take is refused at send time
  try { controller(cfg.controller).compile(plan.build(pkg), cfg); } catch (e) { throw err(400, 'Can\'t convert this job for ' + CONTROLLERS[cfg.controller].label + ': ' + e.message); }
  const job = store.add(pkg, warnings, source);
  log('received ' + job.name + ' · ' + (pkg.processes || []).length + ' processes · ' + ((pkg.estimate && pkg.estimate.total) || '?') + (warnings.length ? ' · ' + warnings.join('; ') : ''));
  return job;
}

// ---------------------------------------------------------------- Pathline protocol
const api = {
  'GET /info': () => ({
    name: cfg.name, type: 'laser', ctrl: CONTROLLERS[cfg.controller].label, model: machine.info.model || cfg.name,
    firmware: machine.info.firmware || '', protocol: 1, bed: cfg.bed, app: 'Pathline Run ' + pkgJson.version
  }),
  'GET /machine': () => config.machineView(cfg),
  'GET /status': () => machine.status(),
  'GET /jobs': () => jobsView(),
  'POST /jobs/order': (b) => { store.order(Array.isArray(b.ids) ? b.ids : []); return { ok: true }; },
  'POST /jobs': (b) => { const j = queueJob(b, 'pathline'); return { id: j.id, status: 'queued' }; },
  'POST /start': () => machine.start(),
  'POST /pause': () => machine.pause(),
  'POST /resume': () => machine.resume(),
  'POST /stop': () => machine.stop(),
  'POST /jog': (b) => machine.jog(b),
  'POST /home': () => machine.home(),
  'POST /frame': (b) => machine.frame(b.box),
  'POST /io': (b) => machine.io(b),
  'POST /autofocus': () => { throw err(409, 'This machine has no auto-focus'); },
  'POST /testfire': () => { throw err(409, 'Test fire isn\'t supported by Pathline Run yet'); },
  'POST /feed': () => { throw err(409, 'This machine has no conveyor'); },
  'POST /toolchange': () => { throw err(409, 'This machine has no tool changer'); }
};

// ---------------------------------------------------------------- HMI screen
function exportJob(id, format, ctrlName) {
  const pkg = store.pkg(id);
  const c = controller(ctrlName || cfg.controller);
  const out = c.exportFiles(plan.build(pkg), { ...cfg, controller: ctrlName || cfg.controller });
  const job = store.get(id) || store.history.find((h) => h.id === id) || { name: id };
  const base = ((cfg.prefix || '') + job.name).replace(/[\\/:*?"<>|]+/g, '-').trim() || id;
  return format === 'txt' ? { name: base + out.ext + '.txt', type: 'text/plain; charset=utf-8', data: Buffer.from(out.txt, 'utf8') } : { name: base + out.ext, type: 'application/octet-stream', data: out.bin };
}

const local = {
  'GET /state': () => ({
    app: pkgJson.version, config: cfg, status: machine.status(), info: machine.info,
    jobs: store.jobs.filter((j) => !j.hidden), history: store.history.slice(0, 100), controllers: Object.keys(CONTROLLERS)
  }),
  'GET /log': () => logLines,
  'GET /ports': async () => {
    try {
      const { SerialPort } = require('serialport');
      return (await SerialPort.list()).map((p) => ({ path: p.path, label: [p.manufacturer, p.vendorId && p.vendorId + ':' + p.productId].filter(Boolean).join(' · ') }));
    } catch (e) { return []; }
  },
  'PUT /config': async (b) => {
    const next = config.merge(cfg, b);
    if (!CONTROLLERS[next.controller]) throw err(400, 'Unknown controller');
    if (!Array.isArray(next.bed) || next.bed.length !== 2 || !next.bed.every((v) => Number.isFinite(v) && v > 0)) throw err(400, 'Bed size must be two numbers above 0');
    await machine.reconfigure(next);
    cfg = next;
    config.save(DATA, cfg);
    log('setup saved (' + cfg.controller + ', ' + cfg.connection.mode + ')');
    return { config: cfg };
  },
  'GET /presets': () => ({ trotec: config.defaults('trotec'), ruida: config.defaults('ruida') }),
  'POST /import': (b) => { const j = queueJob(validate.fromCjob(b), 'import'); return { id: j.id }; },
  'POST /alarm/clear': () => machine.clearAlarm(),
  'POST /reconnect': () => { machine.connect(); return { ok: true }; },
  'POST /sim/lid': (b) => {
    if (!machine.link || !('lidOpen' in machine.link)) throw err(409, 'Only in simulation');
    machine.link.lidOpen = !!b.open;
    return { open: machine.link.lidOpen };
  }
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p.startsWith('/api/v1/') || p.startsWith('/api/local/')) {
      const isLocal = p.startsWith('/api/local/');
      const route = req.method + ' ' + p.replace(/^\/api\/(v1|local)/, '');
      let m;
      if (!isLocal && (m = route.match(/^DELETE \/jobs\/(.+)$/))) {
        const id = decodeURIComponent(m[1]);
        const j = store.get(id);
        if (!j) return send(res, 404, { error: 'No job ' + id });
        if (j.status === 'running') return send(res, 409, { error: 'Job is running — stop it first' });
        store.remove(id);
        log('removed ' + id);
        return send(res, 200, { ok: true });
      }
      if (isLocal && (m = route.match(/^GET \/jobs\/([^/]+)\/package$/))) return send(res, 200, store.pkg(decodeURIComponent(m[1])));
      if (isLocal && (m = route.match(/^GET \/jobs\/([^/]+)\/export$/))) {
        const f = exportJob(decodeURIComponent(m[1]), url.searchParams.get('format'), url.searchParams.get('ctrl'));
        res.writeHead(200, { 'content-type': f.type, 'content-disposition': 'attachment; filename="' + encodeURIComponent(f.name) + '"; filename*=UTF-8\'\'' + encodeURIComponent(f.name) });
        return res.end(f.data);
      }
      if (isLocal && (m = route.match(/^POST \/jobs\/([^/]+)\/requeue$/))) return send(res, 200, store.requeue(decodeURIComponent(m[1])));
      const fn = (isLocal ? local : api)[route];
      if (!fn) return send(res, 404, { error: 'No route ' + route });
      const b = req.method === 'POST' || req.method === 'PUT' ? await body(req, 200 * 1024 * 1024) : {};
      return send(res, 200, (await fn(b)) || {});
    }
    if (req.method !== 'GET') return send(res, 404, { error: 'Not found' });
    const file = path.normalize(path.join(UI, p === '/' || p === '/hmi' ? 'index.html' : p));
    if (!file.startsWith(UI) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    if (!e.code || typeof e.code !== 'number') log('error ' + req.method + ' ' + p + ': ' + (e.stack || e.message));
    send(res, typeof e.code === 'number' ? e.code : 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  log('Pathline Run ' + pkgJson.version + ' on http://localhost:' + PORT + ' · ' + CONTROLLERS[cfg.controller].label + ' · ' + cfg.connection.mode + ' · data in ' + DATA);
  machine.connect().then(() => machine.startPolling());
  if (flag('open')) {
    const u = 'http://localhost:' + PORT + '/';
    const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', u]] : process.platform === 'darwin' ? ['open', [u]] : ['xdg-open', [u]];
    require('child_process').spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).unref();
  }
});
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? 'Port ' + PORT + ' is in use (is Pathline Run or the emulator already running?)' : e.message);
  process.exit(1);
});

const quit = async () => { try { await machine.stop(); } catch (e) { /* closing anyway */ } process.exit(0); };
process.on('SIGINT', quit);
process.on('SIGTERM', quit);

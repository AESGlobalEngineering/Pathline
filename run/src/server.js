#!/usr/bin/env node
// Pathline Run: the HMI that runs next to the machine.
//   /api/v1/…     the protocol Pathline talks (PROTOCOL.md)
//   /api/local/…  extra calls for this HMI's own screen
//   /             the touchscreen UI (ui/)
//
// The installed app (electron/main.js) starts this inside its main process and
// shows the UI in its window. It also runs on its own, without a window:
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
const changelog = require('./changelog');
const network = require('./network');
const ruidaModels = require('./ctrl/ruida/models');
const anchor = require('./job/anchor');
const fitting = require('./vision/fit');
const { DEFAULTS: VisionDefaults } = require('./vision/vision');
const { controller, CONTROLLERS } = require('./ctrl');
const pkgJson = require('../package.json');

const UI = path.join(__dirname, '..', 'ui');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const err = (code, msg) => Object.assign(new Error(msg), { code });

const newer = (a, b) => {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

// Updates are handled by the installed app (electron/updates.js). Without it, they're off.
const NO_UPDATES = {
  status: () => ({ state: 'off', current: pkgJson.version }),
  check: async () => ({ state: 'off', version: pkgJson.version }),
  download: () => ({ state: 'off', current: pkgJson.version }),
  install: () => { throw err(409, 'This copy runs from the source folder: update it with git pull'); }
};

// opts: { dataDir, port, sim, controller, updates, log }
// Resolves with { port, close } once listening.
function start(opts = {}) {
  const DATA = opts.dataDir || config.dataDir();
  fs.mkdirSync(DATA, { recursive: true });
  let cfg = config.load(DATA, opts.controller ? { controller: opts.controller } : undefined);
  // the head camera's settings, every one present (Setup → Camera shows them all)
  cfg.vision = { ...VisionDefaults, ...(cfg.vision || {}), mark: { ...VisionDefaults.mark, ...((cfg.vision || {}).mark || {}) }, board: { ...VisionDefaults.board, ...((cfg.vision || {}).board || {}) } };
  if (opts.sim) {
    cfg.connection = { ...cfg.connection, mode: 'sim' };
    if (!cfg.configured) Object.assign(cfg, { configured: true, name: cfg.name || 'Simulated laser' });
  }
  const PORT = Number(opts.port || cfg.httpPort || 8470);
  const updates = opts.updates || NO_UPDATES;
  const isLocalReq = (req) => /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress || '');

  const logLines = [];
  function log(msg) {
    const line = new Date().toLocaleTimeString() + '  ' + msg;
    console.log(line);
    logLines.push(line);
    if (logLines.length > 300) logLines.shift();
    if (opts.log) opts.log(msg);
  }

  const store = new Store(DATA);
  // --sim: the head camera is simulated too, over a made-up bed: a 50 mm checkerboard laid at
  // 1.5° with a bump in it, and the example job's three registration marks printed on a sheet
  // that's shifted and turned a little, all lit unevenly (25 … 100 % across the picture); the
  // machine itself is 1.5 mm/m long in X and 0.03° out of square
  const sheet = (p) => { const a = (0.3 * Math.PI) / 180; return [0.8 + p[0] * Math.cos(a) - p[1] * Math.sin(a), -0.5 + p[0] * Math.sin(a) + p[1] * Math.cos(a)]; };
  const simVision = opts.sim ? {
    forceSim: true,
    sim: {
      truth: { offset: [41.2, 12.9], pixel: 0.08, rotation: 90, error: (p) => [p[0] * 1.0015 + p[1] * 0.0005236, p[1]] },
      scene: {
        dots: [[40, 25], [340, 25], [40, 215]].map((p) => { const q = sheet(p); return { x: q[0], y: q[1], d: 5 }; }),
        board: {
          x: 100, y: 300, angle: 1.5, square: 50, nx: 20, ny: 10,
          // a bump round board point (450, 150): the pattern pushed outward up to 0.3 mm
          bump: (u, v) => { const dx = u - 450, dy = v - 150, r = Math.hypot(dx, dy); if (r < 1) return [0, 0]; const k = 0.3 * Math.exp(-(r * r) / 4050); return [(k * dx) / r, (k * dy) / r]; }
        }
      },
      light: (ix, iy) => 0.25 + 0.75 * Math.exp(-((ix - 14) ** 2 + (iy + 8) ** 2) / 648)
    }
  } : {};
  const machine = new Machine(cfg, store, log, { vision: simVision });

  // settings the machine finds out for itself: saved like Setup's, without a restart
  async function learnt(patch, why) {
    const next = config.merge(cfg, patch);
    if (JSON.stringify(next) === JSON.stringify(cfg)) return;
    try { await machine.reconfigure(next); cfg = next; config.save(DATA, cfg); log(why); } catch (e) { log('not saved (' + why + '): ' + e.message); }
  }
  machine.onHome = (h) => learnt({ knifeHome: { x: +h.x.toFixed(3), y: +h.y.toFixed(3) } }, 'home kept: X ' + h.x.toFixed(3) + ', Y ' + h.y.toFixed(3) + ' mm (controller)');
  // the controller's own settings fill in Setup, except where they've been typed over
  machine.onController = (vals) => {
    const manual = cfg.manual || [];
    const use = (p) => vals[p] !== undefined && !manual.includes(p);
    const patch = {};
    if (use('bed.0') || use('bed.1')) patch.bed = [use('bed.0') ? vals['bed.0'] : cfg.bed[0], use('bed.1') ? vals['bed.1'] : cfg.bed[1]];
    if (use('speed')) patch.speed = vals.speed;
    if (use('acc')) patch.acc = vals.acc;
    if (use('timing.feedSpeed')) patch.timing = { feedSpeed: vals['timing.feedSpeed'] };
    return learnt(patch, 'setup filled in from the controller: ' + Object.entries(vals).filter(([p]) => use(p)).map(([p, v]) => p + ' ' + v).join(', '));
  };
  // which of the controller's settings a Setup save types over
  const valueAt = (c, p) => p.split('.').reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), c);
  const manualOf = (next) => (machine.ctrl ? Object.keys(machine.ctrl).filter((p) => Number(valueAt(next, p)) !== machine.ctrl[p]) : next.manual || []);

  // after an update: the changes since the version that last ran (shown once by the screen)
  let whatsNew = [];
  {
    const f = path.join(DATA, 'app.json');
    let s = {};
    try { s = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { /* first run */ }
    const prev = s.lastRunVersion;
    if (prev && newer(pkgJson.version, prev)) whatsNew = changelog.filter((c) => newer(c.version, prev) && !newer(c.version, pkgJson.version));
    if (prev !== pkgJson.version) fs.writeFileSync(f, JSON.stringify({ ...s, lastRunVersion: pkgJson.version }, null, 2));
  }

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

  // what Pathline is told while no machine has been added
  const needMachine = () => { if (!cfg.configured) throw err(409, 'No machine is set up in Pathline Run yet. Add one on its screen: Setup → Add machine.'); };

  function queueJob(pkg, source) {
    needMachine();
    const warnings = validate.check(pkg, cfg);
    // convert now, so a job the controller can't take is refused at send time
    try { controller(cfg.controller).compile(plan.build(pkg), cfg); } catch (e) { throw err(400, 'Can\'t convert this job for ' + CONTROLLERS[cfg.controller].label + ': ' + e.message); }
    const job = store.add(pkg, warnings, source);
    log('received ' + job.name + ' · ' + (pkg.processes || []).length + ' processes · ' + ((pkg.estimate && pkg.estimate.total) || '?') + (warnings.length ? ' · ' + warnings.join('; ') : ''));
    return job;
  }

  // ---------------------------------------------------------------- Pathline protocol
  const api = {
    'GET /info': () => (needMachine(), {
      name: cfg.name, type: config.machineType(cfg), ctrl: CONTROLLERS[cfg.controller].label, model: machine.info.model || cfg.name,
      firmware: machine.info.firmware || '', protocol: 1, bed: cfg.bed, app: 'Pathline Run ' + pkgJson.version
    }),
    'GET /machine': () => (needMachine(), config.machineView(cfg)),
    'GET /status': () => machine.status(),
    'GET /jobs': () => jobsView(),
    'POST /jobs/order': (b) => { store.order(Array.isArray(b.ids) ? b.ids : []); return { ok: true }; },
    'POST /jobs': (b) => { const j = queueJob(b, 'pathline'); return { id: j.id, status: 'queued' }; },
    'POST /start': (b) => machine.start(b || {}),
    'POST /pause': () => machine.pause(),
    'POST /resume': () => machine.resume(),
    'POST /stop': () => machine.stop(),
    'POST /jog': (b) => machine.jog(b),
    'POST /home': () => machine.home(),
    'POST /frame': (b) => machine.frame(b.box),
    'POST /io': (b) => machine.io(b),
    'POST /autofocus': () => { throw err(409, 'This machine has no auto-focus'); },
    'POST /testfire': () => { throw err(409, 'Test fire isn\'t supported by Pathline Run yet'); },
    'POST /feed': (b) => machine.feed(b.length),
    // tools are chosen by each job's processes (each tool has its own output)
    'POST /toolchange': () => { throw err(409, 'Tools are chosen by the job: each tool has its own output on the controller'); }
  };

  // ---------------------------------------------------------------- HMI screen
  function exportJob(id, format, ctrlName) {
    const pkg = store.get(id) ? store.runPkg(id) : store.pkg(id);
    const c = controller(ctrlName || cfg.controller);
    const out = c.exportFiles(plan.build(pkg), { ...cfg, controller: ctrlName || cfg.controller });
    const job = store.get(id) || store.history.find((h) => h.id === id) || { name: id };
    const base = ((cfg.prefix || '') + job.name).replace(/[\\/:*?"<>|]+/g, '-').trim() || id;
    return format === 'txt' ? { name: base + out.ext + '.txt', type: 'text/plain; charset=utf-8', data: Buffer.from(out.txt, 'utf8') } : { name: base + out.ext, type: 'application/octet-stream', data: out.bin };
  }

  // A Ruida only answers to UDP port 40200, so only one link can talk to it at a time. Use the
  // machine's own link when it's connected to this controller; otherwise borrow the port: close
  // the machine's link, use a link for `draft`, then reconnect the machine.
  async function withRuidaPort(draft, fn) {
    const RuidaLink = require('./ctrl/ruida/link');
    const live = machine.link instanceof RuidaLink && machine.st.link === 'online' && cfg.connection.ip === draft.connection.ip;
    if (live) return fn(machine.link);
    const hadLink = machine.link instanceof RuidaLink;
    if (hadLink) {
      // pause the machine's link (no polling, no reconnect attempts) while we borrow the port
      clearTimeout(machine.retry);
      machine.st.link = 'connecting';
      await machine.link.close().catch(() => {});
    }
    const link = new RuidaLink(draft, log);
    try {
      await link.connect();
      return await fn(link);
    } finally {
      await link.close();
      if (hadLink) machine.connect();
    }
  }

  // updates are only for the machine's own screen, not for browsers elsewhere on the network
  const onlyHere = (req) => { if (!isLocalReq(req)) throw err(403, 'Updates can only be installed on the machine\'s own screen'); };

  const local = {
    'GET /state': (b, req) => ({
      app: pkgJson.version, update: updates.status(), here: isLocalReq(req), config: cfg, status: machine.status(), info: machine.info, ruidaModels: ruidaModels.MODELS,
      fromController: machine.ctrl || null,
      camera: { open: !!machine.vision.camera, info: machine.vision.camera ? machine.vision.camera.info || null : null, busy: machine.camBusy || null, exposure: machine.vision.exposureNow(), defaults: VisionDefaults },
      jobs: store.jobs.filter((j) => !j.hidden), history: store.history.slice(0, 100), controllers: Object.keys(CONTROLLERS)
    }),
    'GET /log': () => logLines,
    'GET /ports': async () => {
      try {
        const ports = await require('./ctrl/trotec/link').listPorts();
        return ports.map((p) => ({ path: p.path, trotec: p.trotec, label: p.trotec ? 'Trotec laser' : (p.friendlyName || p.manufacturer || '').replace(/\s*\(COM\d+\)$/, '') }));
      } catch (e) { return []; }
    },
    'PUT /config': async (b) => {
      const next = config.merge(cfg, b);
      if (!CONTROLLERS[next.controller]) throw err(400, 'Unknown controller');
      // the model decides laser or plotter (a Trotec is always a laser)
      next.type = next.controller === 'ruida' ? ruidaModels.byId(next.ruida.model).kind : 'laser';
      if (!Array.isArray(next.bed) || next.bed.length !== 2 || !next.bed.every((v) => Number.isFinite(v) && v > 0)) throw err(400, 'Bed size must be two numbers above 0');
      if (next.configured) {
        // adding or changing a machine: it needs a name and somewhere to connect
        const c = next.connection;
        if (!String(next.name || '').trim()) throw err(400, 'Give the machine a name');
        if (c.mode === 'tcp' && !String(c.host || '').trim()) throw err(400, 'Enter the laser\'s host or IP address');
        if (c.mode === 'udp' && !/^\d{1,3}(\.\d{1,3}){3}$/.test(String(c.ip || '').trim())) throw err(400, 'Enter the Ruida controller\'s IP address, for example 192.168.1.100');
      }
      if (next.configured && !cfg.configured) log('machine added: ' + next.name + ' (' + next.controller + ', ' + next.connection.mode + ')');
      next.manual = manualOf(next);
      // camera turned off, or another source: let go of it (it opens again when next needed)
      const camChanged = JSON.stringify([next.vision && next.vision.enabled, next.vision && next.vision.source]) !== JSON.stringify([cfg.vision && cfg.vision.enabled, cfg.vision && cfg.vision.source]);
      await machine.reconfigure(next);
      if (camChanged) await machine.vision.close();
      cfg = next;
      config.save(DATA, cfg);
      log('setup saved (' + cfg.controller + ', ' + cfg.connection.mode + ')');
      return { config: cfg };
    },
    'GET /presets': () => ({ trotec: config.defaults('trotec'), ruida: config.defaults('ruida'), ruidaModels: ruidaModels.MODELS }),
    // Setup → Read from controller: the controller's own settings (read only). Takes the setup
    // being edited, so it also works while adding a machine, before it's saved.
    'POST /machine/read': async (b) => {
      const draft = config.merge(cfg, b || {});
      if (draft.controller !== 'ruida') throw err(409, 'Reading settings works with Ruida controllers');
      let raw;
      if (draft.connection.mode === 'sim') {
        // simulated: what a controller of this setup would report
        raw = { rangeX: draft.bed[0] * 1000, rangeY: draft.bed[1] * 1000, rangeU: 99999000, maxVelX: draft.speed * 1000, maxVelY: draft.speed * 1000, maxVelU: 200000,
          maxAccX: draft.acc * 1000, maxAccY: draft.acc * 1000, g0Vel: draft.speed * 1000, uWorkVel: 200000, out1Min: 0, out1Max: 16383, out2Min: 0, out2Max: 16383,
          out3Min: null, out3Max: null, out4Min: null, out4Max: null, machineType: 0x1155, mainboard: 0, cardId: 0x6445 };
      } else {
        raw = await withRuidaPort(draft, async (link) => link.readSettings());
      }
      log('read settings from the controller');
      return { raw, ...require('./ctrl/ruida/readback').interpret(raw) };
    },
    // ---- the Trotec's head camera (Setup → Camera, Jog → Camera)
    // pixel size and rotation: a dot or checkerboard corner under the camera, the head moves a little
    'POST /camera/pixels': async () => {
      const r = await machine.cameraTask('Calibrating the camera\'s pixel size', () => machine.vision.calibratePixels());
      await learnt({ vision: { ...(cfg.vision || {}), matrix: r.matrix, calibrated: new Date().toISOString() } }, 'camera: pixel size ' + (r.pixel * 1000).toFixed(3) + ' µm, turned ' + r.rotation.toFixed(2) + '° saved');
      return r;
    },
    // camera offset: the laser marks scrap where the head is, the camera finds the mark
    'POST /camera/offset': async (b) => {
      if (machine.st.interlock) throw err(409, 'Close the lid: the laser fires to make the mark');
      const r = await machine.cameraTask('Calibrating the camera offset', (ctl) => machine.vision.calibrateOffset(b || {}, ctl));
      await learnt({ vision: { ...(cfg.vision || {}), offset: r.offset, calibrated: new Date().toISOString() } }, 'camera: offset ' + r.offset.join(', ') + ' mm saved');
      return r;
    },
    // checkerboard: check (with the bed map on) or calibrate (measure as it is, save the map)
    'POST /camera/board': async (b) => {
      const calibrate = b && b.mode === 'calibrate';
      const r = await machine.cameraTask(calibrate ? 'Calibrating the bed with the checkerboard' : 'Checking the bed with the checkerboard', (ctl, status) => machine.vision.scanBoard({ raw: calibrate, board: b && b.board }, ctl, status));
      if (calibrate) {
        const map = r.map || fitting.bedMap(r.points, r.step, cfg.bed);
        await learnt({ vision: { ...(cfg.vision || {}), map, mapOn: true, mapAt: r.at } }, 'camera: bed map saved (' + r.points.length + ' corners, worst ' + r.worst.toFixed(3) + ' mm before correcting)');
      }
      return r;
    },
    'GET /camera/board': () => machine.vision.lastDrift || {},
    // put the camera where the laser is (to look at it), or the laser where the camera looks
    'POST /camera/goto': async (b) => {
      const o = machine.vision.cfg.offset;
      const p = machine.st.pos;
      const to = b && b.to === 'laser' ? [p.x - o[0], p.y - o[1]] : [p.x + o[0], p.y + o[1]];
      return machine.jog({ x: to[0], y: to[1] });
    },
    // Setup → Find on network: Ruida controllers that answer, with their IP, magic and card ID
    'POST /ruida/find': async () => {
      const RuidaLink = require('./ctrl/ruida/link');
      if (machine.run) throw err(409, 'Wait until the job has finished');
      const hadLink = machine.link instanceof RuidaLink;
      if (hadLink) { clearTimeout(machine.retry); machine.st.link = 'connecting'; await machine.link.close().catch(() => {}); }
      try { return { found: await RuidaLink.find(log) }; } finally { if (hadLink) machine.connect(); }
    },
    // ☰ → Remove machine (the screen asks twice first): forgets the machine's setup.
    // Queued jobs and history stay.
    'POST /machine/remove': async (b, req) => {
      if (!isLocalReq(req)) throw err(403, 'The machine can only be removed on its own screen');
      if (machine.run || machine.busy()) throw err(409, 'Stop the running job first');
      if (!cfg.configured) return { config: cfg };
      const name = cfg.name;
      const next = config.withoutMachine(cfg);
      await machine.reconfigure(next);
      cfg = next;
      config.save(DATA, cfg);
      log('machine removed: ' + name);
      return { config: cfg };
    },
    // this computer's network adapters and addresses (what Pathline connects to)
    'GET /network': async () => ({ port: PORT, adapters: await network.list(), canSet: process.platform === 'win32' || process.platform === 'linux' }),
    'POST /network': async (b, req) => {
      if (!isLocalReq(req)) throw err(403, 'The IP address can only be changed on the machine\'s own screen');
      if (machine.run) throw err(409, 'Wait until the job has finished');
      log('network: setting ' + b.adapter + ' to ' + (b.mode === 'static' ? b.ip + ' / ' + b.mask + (b.gateway ? ' via ' + b.gateway : '') : 'DHCP'));
      const adapters = await network.apply(b);
      log('network: done');
      return { port: PORT, adapters };
    },
    'POST /import': (b) => { const j = queueJob(validate.fromCjob(b), 'import'); return { id: j.id }; },
    // what's new: once after an update (then forgotten), and the whole list for ☰ → What's new
    'GET /whatsnew': () => { const w = whatsNew; whatsNew = []; return w; },
    'GET /changelog': () => changelog,
    'POST /update/check': (b, req) => { onlyHere(req); return updates.check(); },
    'POST /update/download': (b, req) => { onlyHere(req); return updates.download(); },
    'POST /update/install': (b, req) => {
      onlyHere(req);
      if (machine.run || machine.busy()) throw err(409, 'Wait until the job has finished');
      log('restarting to install the update');
      setTimeout(() => updates.install(), 300);
      return { restarting: true };
    },
    // press and hold on the Jog page: { axis, dir: 1 | -1, speed mm/s }, repeated while held
    'POST /jog/hold': (b) => machine.jogHold(b),
    'POST /jog/release': () => machine.jogRelease(),
    'POST /alarm/clear': () => machine.clearAlarm(),
    'POST /reconnect': () => { machine.connect(); return { ok: true }; },
    'POST /sim/lid': (b) => {
      if (!machine.link || !('lidOpen' in machine.link)) throw err(409, 'Only in simulation');
      machine.link.lidOpen = !!b.open;
      return { open: machine.link.lidOpen };
    }
  };

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
        if (isLocal && (m = route.match(/^GET \/jobs\/([^/]+)\/package$/))) {
          const id = decodeURIComponent(m[1]);
          return send(res, 200, store.get(id) ? store.runPkg(id) : store.pkg(id));
        }
        // anchor the job's top-left corner to where the head is now ({ clear: true } puts it back)
        if (isLocal && (m = route.match(/^POST \/jobs\/([^/]+)\/anchor$/))) {
          const id = decodeURIComponent(m[1]);
          const j = store.get(id);
          if (!j) return send(res, 404, { error: 'No job ' + id });
          if (j.status === 'running') return send(res, 409, { error: 'The job is running' });
          const b = await body(req, 1024);
          if (b.clear) { store.setAnchor(id, null); log('anchor cleared for ' + j.name); return send(res, 200, { anchor: null }); }
          if (machine.st.link !== 'online') return send(res, 409, { error: 'The machine isn\'t connected, so the head position isn\'t known' });
          const at = { x: +machine.st.pos.x.toFixed(3), y: +machine.st.pos.y.toFixed(3) };
          anchor.check(store.pkg(id), at, cfg.bed);
          store.setAnchor(id, at);
          log('anchored ' + j.name + ' at the head, X ' + at.x + ' Y ' + at.y);
          return send(res, 200, { anchor: at });
        }
        if (isLocal && (m = route.match(/^GET \/jobs\/([^/]+)\/export$/))) {
          const f = exportJob(decodeURIComponent(m[1]), url.searchParams.get('format'), url.searchParams.get('ctrl'));
          res.writeHead(200, { 'content-type': f.type, 'content-disposition': 'attachment; filename="' + encodeURIComponent(f.name) + '"; filename*=UTF-8\'\'' + encodeURIComponent(f.name) });
          return res.end(f.data);
        }
        if (isLocal && (m = route.match(/^POST \/jobs\/([^/]+)\/requeue$/))) return send(res, 200, store.requeue(decodeURIComponent(m[1])));
        // the head camera's picture for the screen: 4 bytes (width, height as 16-bit), then grey bytes
        if (isLocal && route === 'GET /camera/frame') {
          if (machine.camBusy || machine.run) return send(res, 409, { error: 'The camera is busy' });
          const f = await machine.vision.preview(Math.min(960, Number(url.searchParams.get('size')) || 480));
          const head = Buffer.alloc(4);
          head.writeUInt16BE(f.w, 0); head.writeUInt16BE(f.h, 2);
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
          return res.end(Buffer.concat([head, Buffer.from(f.data)]));
        }
        const fn = (isLocal ? local : api)[route];
        if (!fn) return send(res, 404, { error: 'No route ' + route });
        const b = req.method === 'POST' || req.method === 'PUT' ? await body(req, 200 * 1024 * 1024) : {};
        return send(res, 200, (await fn(b, req)) || {});
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

  return new Promise((resolve, reject) => {
    server.once('error', (e) => reject(e.code === 'EADDRINUSE' ? new Error('Port ' + PORT + ' is in use. Is Pathline Run (or the emulator) already running?') : e));
    server.listen(PORT, () => {
      log('Pathline Run ' + pkgJson.version + ' on http://localhost:' + PORT + ' · ' + CONTROLLERS[cfg.controller].label + ' · ' + cfg.connection.mode + ' · data in ' + DATA);
      machine.connect().then(() => machine.startPolling());
      resolve({
        port: PORT,
        machine,
        log,
        // stops the machine safely, then closes the server
        close: async () => {
          try { await machine.stop(); } catch (e) { /* closing anyway */ }
          try { if (machine.link) await machine.link.close(); } catch (e) { /* closing anyway */ }
          server.close();
        }
      });
    });
  });
}

module.exports = { start };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
  const flag = (k) => argv.includes('--' + k);
  start({ dataDir: config.dataDir(arg('data')), port: arg('port'), sim: flag('sim'), controller: arg('controller') }).then((s) => {
    if (flag('open')) {
      const u = 'http://localhost:' + s.port + '/';
      const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', u]] : process.platform === 'darwin' ? ['open', [u]] : ['xdg-open', [u]];
      require('child_process').spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).unref();
    }
    const quit = async () => { await s.close(); process.exit(0); };
    process.on('SIGINT', quit);
    process.on('SIGTERM', quit);
  }, (e) => { console.error(e.message); process.exit(1); });
}

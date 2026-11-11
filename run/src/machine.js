// The machine: one link to the controller, the live status Pathline polls,
// manual control with the safety rules from HMI-BRIEF.md §7, and the job
// runner (convert → stream segment by segment → wait until the controller is
// idle → next segment).
'use strict';

const { makeLink, controller } = require('./ctrl');
const plan = require('./job/plan');
const validate = require('./job/validate');
const anchorJob = require('./job/anchor');
const fitting = require('./vision/fit');
const config = require('./config');
const { Vision, reach, reachInfo, fitInfo } = require('./vision/vision');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const busyErr = (msg) => Object.assign(new Error(msg), { code: 409 });

class Machine {
  // opts.vision: options for the head camera (sim: the simulated camera's scene, for --sim)
  constructor(cfg, store, log, opts = {}) {
    this.cfg = cfg;
    this.store = store;
    this.log = log;
    this.vision = new Vision(this, opts.vision || {});
    this.st = {
      state: 'idle', pos: { x: 0, y: 0, z: 0 }, progress: 0, job: null, message: 'Connecting…',
      io: { air: false, pointer: false, vacuum: false, exhaust: true }, link: 'connecting', interlock: false
    };
    this.info = { model: '', firmware: '' };
    this.run = null;
  }

  // ------------------------------------------------------------ link
  async connect() {
    if (this.link) await this.link.close().catch(() => {});
    clearTimeout(this.retry);
    // no machine added yet: nothing to connect to
    if (!this.cfg.configured) {
      this.link = null;
      Object.assign(this.st, { link: 'none', message: 'No machine set up', interlock: false });
      if (this.st.state === 'alarm') this.st.state = 'idle';
      return;
    }
    this.st.link = 'connecting';
    this.st.message = 'Connecting…';
    this.ctrl = null; // the controller's settings: read again once connected
    const link = makeLink(this.cfg, this.log);
    this.link = link;
    // when each reported position was true, as fitted to the jobs run (follow-fit.js)
    link.stamp = (this.learnt && this.learnt.stamp) || null;
    // status the link reads on its own (e.g. while a Trotec's buffer is full during a job)
    link.onPoll = (p) => { if (this.link === link) { this.apply(p); if (this.onPos) this.onPos(p); } };
    // where an RDD6584's head homes and parks: the server keeps it in the setup
    link.onHome = (h) => { if (this.onHome) this.onHome(h); };
    try {
      this.info = await link.connect();
      if (this.link !== link) return;
      this.st.link = 'online';
      this.st.message = 'Ready';
      this.lastConnectError = null;
      if (this.st.state === 'alarm') this.st.state = 'idle';
      this.readController(link);
    } catch (e) {
      // let go of the port, or the next attempt finds it "in use" by this failed one
      await link.close().catch(() => {});
      if (this.link !== link) return;
      this.st.link = 'offline';
      this.st.message = e.message;
      // retried every 10 s: log it once, not every time (it would bury the rest of the log)
      if (e.message !== this.lastConnectError) this.log('connect failed: ' + e.message + ' (retrying every 10 s)');
      this.lastConnectError = e.message;
      clearTimeout(this.retry);
      this.retry = setTimeout(() => { if (this.link === link) this.connect(); }, 10000);
    }
  }

  // The controller's own settings (Ruida), read once per connection: Setup shows them, and
  // uses them wherever they haven't been typed over (server: onController)
  async readController(link) {
    if (!link.readSettings) return;
    try {
      const s = require('./ctrl/ruida/readback').interpret(await link.readSettings()).suggest;
      const vals = {};
      if (s.bed) { vals['bed.0'] = s.bed[0]; vals['bed.1'] = s.bed[1]; }
      if (s.speed) vals.speed = s.speed;
      if (s.acc) vals.acc = s.acc;
      if (s.feedSpeed) vals['timing.feedSpeed'] = s.feedSpeed;
      if (this.link !== link) return;
      this.ctrl = vals;
      if (this.onController) await this.onController(vals);
    } catch (e) { this.log('controller settings not read: ' + e.message); }
  }

  // reconnects only when something the link depends on changed
  async reconfigure(cfg) {
    const linkKeys = (c) => JSON.stringify([c.configured, c.controller, c.connection, c.trotec, c.ruida, c.sim, c.bed]);
    const relink = linkKeys(cfg) !== linkKeys(this.cfg);
    if (relink && this.run) throw busyErr('Stop the running job before changing the controller setup');
    this.cfg = cfg;
    if (relink) await this.connect();
  }

  startPolling() {
    const loop = async () => {
      // (while an arrow is held, the jog reads the position itself)
      if (this.st.link === 'online' && !this.run && !this.hold) {
        try { this.apply(await this.link.poll()); } catch (e) { this.lost(e); }
      }
      this.pollTimer = setTimeout(loop, this.run ? 1000 : 500);
    };
    loop();
  }

  apply(p) {
    // (when the controller reported it: a Trotec repeats its last answer while its buffer is full)
    if (p.pos && Number.isFinite(p.pos.x)) { this.st.pos = p.pos; this.posAt = p.at || Date.now(); }
    if (p.mpos) this.st.mpos = p.mpos;
    this.st.interlock = !!p.interlock;
    // (camera work keeps its own progress message)
    if (!this.run && this.st.state !== 'alarm' && !this.camBusy) {
      this.st.state = this.framing ? 'framing' : 'idle';
      this.st.message = p.interlock ? 'Lid open' : this.st.link === 'online' ? 'Ready' : this.st.message;
    }
    return p;
  }

  lost(e) {
    this.log('link lost: ' + e.message);
    this.st.link = 'offline';
    this.st.message = 'Lost the controller: ' + e.message;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => this.connect(), 3000);
  }

  // ------------------------------------------------------------ manual control
  busy() { return !!this.run || this.st.state === 'framing' || !!this.framing || !!this.hold || !!this.camBusy; }

  // opts.lidOpenOk: moves with the beam off (jog, hold, home) are allowed with the lid open
  // opts.markJog: a jog, allowed while a print-and-cut job waits for a mark to be found by hand
  guard(opts = {}) {
    if (!this.cfg.configured) throw busyErr('No machine is set up in Pathline Run yet');
    if (this.st.link !== 'online') throw busyErr('The machine isn\'t connected: ' + this.st.message);
    if (this.run && !(opts.markJog && this.markWait)) throw busyErr('A job is running');
    if (this.hold) throw busyErr('The head is being jogged');
    if (this.camBusy) throw busyErr('The camera is busy: ' + this.camBusy);
    if (this.st.state === 'framing' || this.framing) throw busyErr('The machine is framing');
    if (this.st.state === 'alarm') throw busyErr('Alarm: ' + this.st.message + '. Clear it on the HMI first.');
    if (this.st.interlock && !opts.lidOpenOk) throw busyErr('Lid is open');
  }

  clampX(x) { return Math.max(0, Math.min(this.cfg.bed[0], x)); }
  clampY(y) { return Math.max(0, Math.min(this.cfg.bed[1], y)); }

  // where the head may go with the beam off (config.travelBox: a Trotec's strip to its zero too)
  travel() { return config.travelBox(this.cfg); }
  clampTravel(x, y) {
    const t = this.travel();
    return [Math.max(t[0], Math.min(t[2], x)), Math.max(t[1], Math.min(t[3], y))];
  }

  // How far a jog may go along an axis: the travel (the bed, and a Trotec's strip behind and left
  // of it), widened to wherever the head is now. A head outside the bed set in Setup (bed set
  // smaller than the machine) is never pulled back across to the bed edge: that was a long rapid,
  // in whichever direction was pressed.
  jogRange(axis) {
    const t = this.travel();
    const [min, max] = axis === 'x' ? [t[0], t[2]] : [t[1], t[3]];
    const cur = this.st.pos[axis];
    return Number.isFinite(cur) ? [Math.min(min, cur), Math.max(max, cur)] : [min, max];
  }

  async jog(b) {
    this.guard({ lidOpenOk: true, markJog: true }); // beam off: the head may move with the lid open
    let x = this.st.pos.x, y = this.st.pos.y;
    if (b.x !== undefined || b.y !== undefined) {
      if (b.x !== undefined) x = Number(b.x);
      if (b.y !== undefined) y = Number(b.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw Object.assign(new Error('x and y must be numbers'), { code: 400 });
      [x, y] = this.clampTravel(x, y);
    } else {
      const d = Number(b.distance);
      if (!Number.isFinite(d)) throw Object.assign(new Error('distance must be a number'), { code: 400 });
      if (b.axis === 'z') throw busyErr('This machine has no Z axis');
      if (b.axis !== 'x' && b.axis !== 'y') throw Object.assign(new Error('axis must be x, y or z'), { code: 400 });
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw busyErr('The head position isn\'t known yet');
      // a step along one axis: only that axis moves, and never the other way from the arrow
      const [lo, hi] = this.jogRange(b.axis);
      const to = Math.max(lo, Math.min(hi, this.st.pos[b.axis] + d));
      if (b.axis === 'x') x = to; else y = to;
      if (Math.abs(to - this.st.pos[b.axis]) < 0.001) return { pos: this.st.pos };
    }
    const before = { ...this.st.pos };
    await this.link.moveTo(x, y, b.axis ? { axis: b.axis } : {});
    // A Trotec may refuse to move with its lid open: then say so, rather than silently not moving
    if (this.cfg.controller === 'trotec' && this.st.interlock && Math.hypot(x - before.x, y - before.y) > 0.05) {
      await sleep(700);
      const p = this.apply(await this.link.poll());
      if (Math.hypot(p.pos.x - before.x, p.pos.y - before.y) < 0.01) throw busyErr('The laser didn\'t move: the Trotec ignores moves while its lid is open. Close the lid to jog.');
      return { pos: this.st.pos };
    }
    this.st.pos = { ...this.st.pos, x: +x.toFixed(3), y: +y.toFixed(3) };
    return { pos: this.st.pos };
  }

  // ------------------------------------------------------------ press and hold
  // The screen sends this every ~200 ms while a jog arrow is held. The head moves in short
  // steps at `speed` mm/s, never more than ~0.3 s ahead of where it is, and stops at the bed
  // edge, when the lid opens, when anything else needs the machine, or when the screen goes
  // quiet for 0.6 s (released, or the connection dropped).
  async jogHold(b) {
    const axis = b.axis;
    const dir = Math.sign(Number(b.dir));
    const speed = Math.max(0.1, Math.min(Number(b.speed) || 1, (this.cfg.trotec && this.cfg.trotec.maxSpeed) || 500, 500));
    if ((axis !== 'x' && axis !== 'y') || !dir) throw Object.assign(new Error('axis must be x or y, dir 1 or -1'), { code: 400 });
    const until = Date.now() + 450;
    if (this.hold && this.hold.axis === axis && this.hold.dir === dir) {
      Object.assign(this.hold, { until, speed });
      // a Trotec with its lid open may not move at all: after a second, say so and stop trying
      const h = this.hold;
      if (this.cfg.controller === 'trotec' && this.st.interlock && h.moved && Date.now() - h.t0 > 1000 && Math.abs(this.st.pos[axis] - h.start) < 0.01) {
        await this.jogRelease();
        throw busyErr('The laser didn\'t move: the Trotec ignores moves while its lid is open. Close the lid to jog.');
      }
      return { holding: true };
    }
    if (this.hold) await this.jogRelease(); // another arrow: stop this move first
    this.guard({ lidOpenOk: true, markJog: true });
    if (!Number.isFinite(this.st.pos.x) || !Number.isFinite(this.st.pos.y)) throw busyErr('The head position isn\'t known yet');
    const at = { x: this.st.pos.x, y: this.st.pos.y };
    const h = { axis, dir, speed, until, at, range: this.jogRange(axis), ideal: at[axis], last: Date.now(), busy: false, moved: false, t0: Date.now(), start: at[axis] };
    this.hold = h;
    if (!this.holdTimer) this.holdTimer = setInterval(() => this.holdTick(), 100);
    // one move to the edge of the bed at this speed, stopped when the arrow is let go
    if (this.link.continuousJog) {
      h.continuous = true;
      const to = { ...at, [axis]: dir > 0 ? h.range[1] : h.range[0] };
      if (Math.abs(to[axis] - at[axis]) < 0.01) return { holding: true }; // at the edge already
      h.busy = true;
      h.moved = true;
      try { await this.link.moveTo(to.x, to.y, { axis, speed }); } catch (e) { this.log('jog: ' + e.message); await this.jogRelease(); throw e; } finally { h.busy = false; }
    }
    return { holding: true };
  }

  // Let go: no more steps, and a controller that finishes the move it has (Ruida: every
  // move is a full-speed rapid) is told to stop where it is.
  async jogRelease() {
    const h = this.hold;
    this.hold = null;
    clearInterval(this.holdTimer);
    this.holdTimer = null;
    if (h && h.moved && this.link && this.link.stopMove) {
      try { await this.link.stopMove(); } catch (e) { this.log('jog stop: ' + e.message); }
    }
    return { holding: false };
  }

  async holdTick() {
    const h = this.hold;
    if (!h || h.busy) return;
    if (Date.now() > h.until || (this.run && !this.markWait) || this.framing || this.st.link !== 'online' || this.st.state === 'alarm') { this.jogRelease(); return; }
    // one long move under way: only follow where the head is
    if (h.continuous) {
      h.busy = true;
      try { this.apply(await this.link.poll()); } catch (e) { /* busy controller: ask again next tick */ } finally { h.busy = false; }
      return;
    }
    // where the head should be by now at this speed, but never more than ~0.15 s ahead of
    // where it is, so it stops close to where the arrow was let go
    const now = Date.now();
    const [min, max] = h.range;
    h.ideal += h.dir * h.speed * ((now - h.last) / 1000);
    h.last = now;
    const lead = h.speed * 0.15 + 0.05;
    // the reported position is a moment old: allow for how far the head has moved since
    const age = Math.min(0.3, (now - (this.posAt || now)) / 1000);
    const cur = this.st.pos[h.axis] + h.dir * h.speed * age;
    const target = Math.max(min, Math.min(max, h.dir > 0 ? Math.min(h.ideal, cur + lead) : Math.max(h.ideal, cur - lead)));
    h.ideal = target;
    if (h.dir * (target - h.at[h.axis]) < 0.005) return; // nothing new to send (or at the bed edge)
    h.at[h.axis] = target;
    h.busy = true;
    try {
      h.moved = true;
      await this.link.moveTo(h.at.x, h.at.y, { speed: h.speed, axis: h.axis });
      if (this.hold !== h) return; // let go meanwhile
      this.apply(await this.link.poll());
    } catch (e) {
      this.log('jog: ' + e.message);
      this.jogRelease();
    } finally { h.busy = false; }
  }

  // plotter conveyor: advance the material by one bed (or `length` mm)
  async feed(length) {
    if (!(this.cfg.controller === 'ruida' && this.cfg.type === 'plotter' && this.cfg.f.conveyor)) throw busyErr('This machine has no conveyor');
    this.guard({ lidOpenOk: true });
    const mm = Number(length) > 0 ? Number(length) : this.cfg.feedLen || 1000;
    if (!this.link.feed) throw busyErr('This controller can\'t feed by hand');
    await this.link.feed(mm);
    this.log('conveyor fed ' + mm + ' mm');
    return { fed: mm };
  }

  async home() {
    this.guard({ lidOpenOk: true });
    await this.link.home();
    // RDD6584: once it has homed, the head is at home: measure from there
    if (this.link.learnHome) {
      const link = this.link;
      (async () => {
        try { await this.waitIdle(180000, 1000); if (this.link === link && !this.run) await link.learnHome(); } catch (e) { this.log('home: ' + e.message); }
      })();
    }
    return { ok: true };
  }

  async frame(box) {
    this.guard();
    if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite)) throw Object.assign(new Error('box must be [x0, y0, x1, y1]'), { code: 400 });
    const [x0, y0, x1, y1] = [this.clampX(box[0]), this.clampY(box[1]), this.clampX(box[2]), this.clampY(box[3])];
    const start = { x: this.st.pos.x, y: this.st.pos.y };
    this.framing = true;
    this.st.state = 'framing';
    this.st.message = 'Framing';
    (async () => {
      try {
        for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]) {
          if (!this.framing) break;
          const [cx, cy] = this.corrected([x, y]);
          await this.link.moveTo(cx, cy, { light: true });
          await this.waitIdle(30000, 150);
        }
        // then back to where the head was
        if (this.framing && Number.isFinite(start.x) && Number.isFinite(start.y)) {
          await this.link.moveTo(start.x, start.y);
          await this.waitIdle(30000, 150);
        }
      } catch (e) { this.log('frame: ' + e.message); }
      this.framing = false;
      if (this.st.state === 'framing') { this.st.state = 'idle'; this.st.message = 'Ready'; }
    })();
    return { state: 'framing' };
  }

  // true once the machine is idle, false if it still isn't after ms
  async waitIdle(ms, minMs) {
    const t0 = Date.now();
    await sleep(minMs || 0);
    while (Date.now() - t0 < ms) {
      const p = this.apply(await this.link.poll());
      if (p.state === 'idle') return true;
      await sleep(150);
    }
    return false;
  }

  async io(b) {
    for (const k of Object.keys(b)) {
      if (!(k in this.st.io)) continue;
      if (k === 'air' || k === 'pointer') {
        if (this.st.link !== 'online') throw busyErr('The machine isn\'t connected');
        await this.link.setIo(k, !!b[k]);
        this.st.io[k] = !!b[k];
      } else if (k === 'vacuum' && this.cfg.f.vacuum) {
        // a plotter's vacuum table, by hand (Jog page)
        if (this.st.link !== 'online') throw busyErr('The machine isn\'t connected');
        if (!this.link.setVacuum) throw busyErr('This controller can\'t switch the vacuum by hand');
        await this.link.setVacuum(!!b[k]);
        this.st.io[k] = !!b[k];
        this.log('vacuum ' + (b[k] ? 'on' : 'off'));
      } else throw busyErr('This machine has no ' + k + ' output');
    }
    return { io: this.st.io };
  }

  // ------------------------------------------------------------ jobs
  compile(pkg, opts) {
    // the Trotec's bed correction map (Setup → Camera → checkerboard): every point goes where
    // the head really needs to be sent
    const v = this.cfg.vision;
    if (this.cfg.controller === 'trotec' && v && v.enabled && v.mapOn !== false && v.map) pkg = fitting.transformPkg(pkg, (q) => fitting.correct(v.map, q));
    const p = plan.build(pkg);
    return controller(this.cfg.controller).compile(p, this.cfg, opts);
  }

  // a bed point through the Trotec's bed correction map (where to send the head to reach it)
  corrected(p) {
    const v = this.cfg.vision;
    return this.cfg.controller === 'trotec' && v && v.enabled && v.mapOn !== false && v.map ? fitting.correct(v.map, p) : p;
  }

  // Camera calibration: the laser marks three circles (r 1, 1.5, 2 mm) round `at` with the given
  // power and speed, as an ordinary job outside the queue; returns the mark's diameter (mm).
  // Tighter circles (r 0.3 … 1.5) didn't burn on the Trotec, only the outer one: the camera looks
  // for the rings as one disc (their holes filled)
  async fireMark(at, mark, ctl = {}) {
    const rings = [1, 1.5, 2];
    const p = [];
    for (const r of rings) {
      const pts = [];
      for (let k = 0; k <= 36; k++) pts.push([at[0] + r * Math.cos((k * Math.PI) / 18), at[1] + r * Math.sin((k * Math.PI) / 18)]);
      p.push({ type: 'cut', process: 0, name: 'Calibration mark', p: pts, closed: true, seconds: 0.5 });
    }
    const pkg = {
      format: 'lrc-job-package', version: 1, job: { name: 'Camera calibration mark' },
      processes: [{ index: 0, name: 'Calibration mark', proc: 'Cut', power: Number(mark.power) || 20, speed: Number(mark.speed) || 50, f: 5000, passes: 1, aci: [1] }],
      toolpath: p, entities: []
    };
    const program = this.compile(pkg);
    this.log('camera: laser mark at ' + at.map((v) => v.toFixed(2)).join(', ') + ' mm (' + mark.power + ' %, ' + mark.speed + ' mm/s)');
    for (const seg of program.segments) {
      if (ctl.aborted) return;
      if (seg.kind !== 'stream') continue;
      await this.link.send(seg, ctl);
      await this.waitIdle(60000, 500);
    }
    return 2 * Math.max(...rings);
  }

  // Camera work (calibration, checkerboard) as one job at a time: blocks the other controls
  // while it runs, Stop ends it
  async cameraTask(what, fn) {
    if (this.cfg.controller !== 'trotec') throw busyErr('The head camera is on the Trotec');
    this.guard({ lidOpenOk: true });
    const ctl = { aborted: false };
    this.camBusy = what;
    this.camCtl = ctl;
    this.st.message = what;
    try { return await fn(ctl, (msg) => { this.st.message = msg; }); } finally {
      this.camBusy = null; this.camCtl = null;
      if (this.st.state !== 'alarm') this.st.message = this.st.link === 'online' ? 'Ready' : this.st.message;
    }
  }

  // b.id: run that job; b.ids: run those jobs one after another (Queue → Select), in queue
  // order; neither: the first job in the queue (Pathline's Start)
  async start(b = {}) {
    if (this.run) return { state: this.st.state };
    this.guard();
    const want = Array.isArray(b.ids) ? b.ids : b.id ? [b.id] : null;
    let job;
    if (want) {
      const queued = this.store.jobs.filter((j) => j.status === 'queued' && want.includes(j.id));
      if (!queued.length) return { state: this.st.state, message: 'None of those jobs are queued' };
      job = queued[0];
      this.batch = queued.slice(1).map((j) => j.id);
    } else {
      job = this.store.next();
      this.batch = [];
    }
    if (!job) return { state: this.st.state, message: 'Nothing queued' };
    // the head Z axis: focus set, the sheet scanned, the axis ready (before anything moves)
    if (this.zaxis) { try { this.zaxis.check(); } catch (e) { throw busyErr('"' + job.name + '": ' + e.message); } }
    // where the head is as Start is pressed: the anchor (if on), and where it goes back to after
    if (this.st.link === 'online') { try { this.apply(await this.link.poll()); } catch (e) { /* the last position */ } }
    const p0 = this.st.pos;
    const back = p0 && Number.isFinite(p0.x) && Number.isFinite(p0.y) ? { x: p0.x, y: p0.y } : null;
    // Anchor to toolhead switched on: the job's top-left corner goes where the head is now, as
    // Start is pressed (not where it was when the switch was turned on)
    if (job.anchorAtStart) {
      const pos = this.st.pos;
      if (this.st.link !== 'online' || !pos || !Number.isFinite(pos.x)) throw busyErr('"' + job.name + '" is anchored to the toolhead, but the head position isn\'t known');
      const at = { x: +pos.x.toFixed(3), y: +pos.y.toFixed(3) };
      const raw = this.store.pkg(job.id);
      try { anchorJob.check(raw, at, this.cfg.bed); } catch (e) {
        // print and cut: the laser is on the dot, so it's the sheet that has to move (the general
        // message said to move the head; J0065's laser was rightly on the dot, the sheet 15 mm too far right)
        const fit = e.over && (raw.toolpath || []).some((s) => s.type === 'inspect') ? fitInfo(e.over, this.cfg.bed, true) : null;
        if (fit) {
          this.log(job.name + ': ' + fit.text);
          throw Object.assign(busyErr('"' + job.name + '": ' + fit.text), { detail: { ...fit, job: job.name } });
        }
        throw busyErr('"' + job.name + '": ' + e.message);
      }
      this.store.setAnchor(job.id, at);
      this.log('anchored ' + job.name + ' at the head, X ' + at.x + ' Y ' + at.y);
    }
    // as placed: moved to the head if the operator anchored it there
    const pkg = this.store.runPkg(job.id);
    // queued before Pathline Run checked for this: don't "complete" a job that does nothing
    if (!(pkg.toolpath || []).some((s) => s.type === 'cut' || s.type === 'engrave')) throw busyErr('"' + job.name + '": ' + validate.nothingToRun(pkg));
    if (job.anchor) {
      try { validate.check(pkg, this.cfg); } catch (e) { throw busyErr('"' + job.name + '" anchored at the head: ' + e.message); }
    }
    let program;
    // a plotter's conveyor moves on from where it stopped last time
    const opts = { card: this.info && this.info.cardId ? this.info.cardId & 0xffff : undefined };
    if (pkg.toolpath.some((s) => s.type === 'feed') && this.link && this.link.readU && !this.link.relMoves) opts.uStart = await this.link.readU().catch(() => 0);
    // RDD6584: jobs run relative to home (the controller's origin, where the head parks): the
    // job's coordinates are Pathline's, measured from the bed's top right corner, as they are
    try { program = this.compile(pkg, opts); } catch (e) { throw Object.assign(new Error('Couldn\'t convert "' + job.name + '": ' + e.message), { code: 409 }); }
    // print and cut: the Trotec's head camera reads the marks first, then the job is moved onto them
    const marks = program.segments.some((s) => s.kind === 'inspect');
    const camera = marks && this.cfg.controller === 'trotec' && this.cfg.vision && this.cfg.vision.enabled;
    if (marks && !camera && this.cfg.regMarks !== 'ignore') {
      throw busyErr('"' + job.name + '" uses registration marks. Turn the camera on in Setup → Camera, or set Registration marks to "Skip" in Setup to run it uncorrected.');
    }
    if (camera) {
      // every mark where the camera can look, before the head moves at all
      const far = reachInfo(reach(pkg, this.vision.cfg.offset, this.cfg.bed, this.travel()), !!job.anchor);
      if (far) {
        this.log(job.name + ': registration marks out of the camera\'s reach: ' + far.text);
        // (detail: the screen shows it as a dialog, not a passing message)
        throw Object.assign(busyErr('"' + job.name + '": ' + far.text), { detail: { ...far, job: job.name } });
      }
      this.execute(job, null, async (ctl, status) => {
        const r = await this.vision.readMarks(pkg, ctl, status, { anchored: !!job.anchor });
        this.st.marks = r.found;
        // kept with the run: where the marks were expected and found (follow-fit.js rebuilds the job as cut)
        if (this.run && this.run.job === job) this.run.placement = { ...(this.run.placement || {}), marks: { expected: r.expected, found: r.found, type: r.info && r.info.type } };
        // the job as moved onto the marks: the screen follows the head along this one (the
        // package as sent sat ~150 mm away on the X8 sheet: no position fitted it, the head jumped)
        const placed = Vision.corrected(pkg, r.f);
        // where the marks were found, the cuts must still be on the bed: checked at Start where the
        // job was expected, it wasn't checked again (J0064 was expected 42 mm left of its marks, and
        // then cut out to X 1313 on the 1300 mm bed)
        const fit = fitInfo(anchorJob.overBed(placed, this.cfg.bed), this.cfg.bed, !!job.anchor, true);
        if (fit) { this.log(job.name + ': after reading the marks: ' + fit.text); throw new Error(fit.text); }
        if (this.run && this.run.job === job) {
          const sh = pkg.sheet;
          const shown = { ...placed };
          if (sh && [sh.x, sh.y, sh.w, sh.h].every(Number.isFinite)) {
            const c = [[sh.x, sh.y], [sh.x + sh.w, sh.y], [sh.x + sh.w, sh.y + sh.h], [sh.x, sh.y + sh.h]].map((q) => r.f(q));
            const xs = c.map((q) => q[0]), ys = c.map((q) => q[1]);
            shown.sheet = { ...sh, x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
          }
          this.run.placed = shown;
          this.st.placed = job.id + ':' + Date.now();
          // the head Z axis: the nozzle's height along the job as it now lies
          if (this.zaxis) this.run.z = this.zaxis.prepare(placed);
        }
        try { return this.compile(placed, opts); } catch (e) { throw new Error('Couldn\'t convert "' + job.name + '" after reading its marks: ' + e.message); }
      }, back);
      return { state: 'running', job: job.id };
    }
    // the head Z axis: the nozzle's height along the job (or why it can't be followed)
    let z = null;
    if (this.zaxis) { try { z = this.zaxis.prepare(pkg); } catch (e) { throw busyErr('"' + job.name + '": ' + e.message); } }
    this.execute(job, program, null, back, z);
    return { state: 'running', job: job.id };
  }

  // prepare(ctl, status): work done before the job is sent (reading registration marks), giving
  // the program to send; back: where the head was at Start (it goes back there once the job is done)
  execute(job, program, prepare, back, z) {
    const ctl = { aborted: false, paused: false };
    const startedAt = new Date().toISOString();
    // placement: where the job was put (anchored at the head; print and cut adds its marks), kept
    // with the run so the follow fit replays the job exactly where it was cut
    this.run = { job, program, ctl, startedAt, z: z || null, placement: { anchor: job.anchor ? { x: job.anchor.x, y: job.anchor.y } : null } };
    const runRef = this.run;
    job.status = 'running';
    job.progress = 0;
    this.store.flush();
    this.st.marks = null;
    Object.assign(this.st, { state: 'running', job: job.id, progress: 0, marker: null, message: prepare ? 'Reading registration marks' : 'Running ' + job.name });
    let total = 1;
    let doneSec = 0;
    // [ms since the stream started, x, y, marker, state, 'p' for a status check while the buffer
    // was full, and (Trotec) ms when the asking packet went out, the reply's kind ('ok', 'full'),
    // the packet's data bytes, ms when the reply came in]: the last four let follow-fit.js find
    // when the laser really read each position
    const timeline = [];
    let since = Date.now();
    const rel = (v) => (Number.isFinite(v) ? v - since : null);
    const record = (p, how) => {
      if (timeline.length < 20000) timeline.push([(p.at || Date.now()) - since, p.pos ? p.pos.x : null, p.pos ? p.pos.y : null, p.marker === undefined ? null : p.marker, p.state, how, rel(p.sent), p.kind || null, Number.isFinite(p.len) ? p.len : null, rel(p.rx)]);
    };
    this.onPos = (p) => { record(p, 'p'); if (this.zaxis) this.zaxis.position(p, this.st.progress); };
    const setProgress = (sec) => {
      this.st.progress = Math.max(this.st.progress, Math.min(0.999, sec / total));
      job.progress = this.st.progress;
    };

    (async () => {
      let result = 'Completed';
      try {
        if (prepare) {
          program = await prepare(ctl, (msg) => { this.st.message = msg; });
          this.run.program = program;
          this.st.message = 'Running ' + job.name;
        }
        this.log('run ' + job.name + ' (' + program.ctrl + ', ' + program.segments.length + ' segments, ' + Math.round(program.seconds) + ' s estimated)');
        total = Math.max(0.001, program.seconds);
        // the controller's own estimate (as converted, after any registration marks) is the one shown
        if (program.estimated) job.seconds = Math.round(program.seconds);
        since = Date.now();
        // the head Z axis follows the job from here
        if (this.zaxis && this.run.z) this.zaxis.begin(this.run.z, job, since);
        // the laser threw the job away itself (Trotec: an FPGA error, then its buffers cleared):
        // that's not a finished job, whatever state it's left in
        const thrownAway = () => {
          const f = this.link.fault;
          if (!ctl.aborted && f && f.at >= since) throw new Error('The laser stopped the job itself (' + f.text + ') at ' + Math.round(this.st.progress * 100) + ' %. Check the laser, then start the job again.');
        };
        for (const seg of program.segments) {
          if (ctl.aborted) break;
          if (seg.kind === 'inspect') { doneSec += seg.seconds; continue; } // only reached with regMarks = ignore
          if (seg.kind === 'dwell') {
            let left = seg.seconds * 1000;
            this.st.message = 'Dwell ' + seg.seconds + ' s';
            while (left > 0 && !ctl.aborted) {
              await sleep(100);
              if (!ctl.paused) { left -= 100; setProgress(doneSec + seg.seconds - left / 1000); }
            }
            doneSec += seg.seconds;
            this.st.message = 'Running ' + job.name;
            continue;
          }
          // stream: hand the data to the controller, then follow it until it is idle again
          let active = 0;   // seconds the controller has been working on this segment
          let last = Date.now();
          let sawBusy = false;
          const markerSec = (m) => seg.steps.filter((s) => s.i + 1 <= m).reduce((a, s) => a + s.seconds, 0);
          const stepSec = (m) => { const s = seg.steps.find((x) => x.marker === m); return s ? s.seconds : 0; };
          let mark = null; // the last marker reported, and the working time when it came
          // The Trotec reports the last marker it passed until it passes another, so a new job
          // starts with the previous job's last marker still showing. Taken as this job's, it
          // put a job run after one as long (J0067 after J0066, both 966 parts; J0068 run five
          // times) at 100 % from the start: progress, Remaining and the head drawn all at the end.
          // So the marker showing before this job is sent is ignored until another one shows.
          let stale;
          try { const p0 = await this.link.poll(); this.apply(p0); stale = p0.marker; } catch (e) { stale = this.link.lastReply ? this.link.lastReply.marker : undefined; }
          let fresh = !stale;
          const follow = (p) => {
            if (!fresh && p.marker !== undefined && p.marker !== stale) fresh = true;
            if (!fresh) p = { ...p, marker: undefined };
            this.apply(p);
            const now = Date.now();
            if (p.state === 'busy') { sawBusy = true; active += ((now - last) / 1000) * (this.link.timeScale || 1); }
            last = now;
            // Progress: the marker set after each step is reported as the head finishes that step
            // (the positions saved in data/runs, 5 Nov: the head is at the next step's start when a
            // marker first shows). So the steps done, then the time since, up to the next step's own
            // time. Before the first marker: the time worked, up to the first step's time
            if (p.marker && seg.steps.some((s) => s.marker === p.marker)) {
              if (!mark || mark.m !== p.marker) mark = { m: p.marker, at: active };
            }
            // the last part the laser reported done: the screen looks for the head on the next one
            this.st.marker = mark ? mark.m : null;
            const est = mark ? markerSec(mark.m) + Math.min(active - mark.at, stepSec(mark.m + 1)) : Math.min(active, seg.steps.length ? seg.steps[0].seconds : seg.seconds);
            setProgress(doneSec + Math.min(est, seg.seconds));
            record(p, '');
            if (this.zaxis) this.zaxis.position(p, this.st.progress);
            if (p.state === 'paused' && !ctl.paused) this.st.message = p.interlock ? 'Paused: lid open' : 'Paused on the machine';
          };
          await this.link.send(seg, { ...ctl, get aborted() { return ctl.aborted; }, onReply: follow });
          const sentAt = Date.now();
          let idle = 0, idleSince = null;
          // the wait between status checks (cfg.trotec.pollMs, 300 ms; a test setting): the laser
          // answers a check in 20–500 ms while it works, 1 ms when idle
          const pv = this.cfg.trotec && this.cfg.trotec.pollMs;
          const pollMs = typeof pv === 'number' && pv >= 0 ? pv : 300;
          while (!ctl.aborted) {
            await sleep(pollMs);
            const p = await this.link.poll();
            follow(p);
            if (p.state === 'paused') this.st.state = 'paused';
            else if (this.st.state === 'paused' && !ctl.paused) this.st.state = 'running';
            idle = p.state === 'idle' ? idle + 1 : 0;
            idleSince = p.state === 'idle' ? idleSince || Date.now() : null;
            // done once idle twice in a row and for 0.6 s, after it was seen busy (or a moment has passed)
            if (idle >= 2 && Date.now() - idleSince >= 600 && (sawBusy || Date.now() - sentAt > 3000)) break;
          }
          thrownAway();
          // idle before the last part was reported done: the laser ended the job itself (J0055 went
          // idle at part 14 of 188 after 15 s, and was kept as Completed). Every job that really
          // finished was idle on its last marker
          const lastMarker = seg.steps.length ? seg.steps[seg.steps.length - 1].marker : null;
          if (!ctl.aborted && mark && lastMarker !== null && mark.m < lastMarker) {
            const n = seg.steps.filter((s) => s.marker <= mark.m).length;
            throw new Error('The laser stopped the job itself after part ' + n + ' of ' + seg.steps.length + ' (' + Math.round(this.st.progress * 100) + ' %). Check the laser, then start the job again.');
          }
          doneSec += seg.seconds;
          setProgress(doneSec);
        }
        if (ctl.aborted) result = 'Stopped';
      } catch (e) {
        result = 'Stopped';
        this.log((ctl.aborted ? 'job stopped: ' : 'job failed: ') + e.message);
        await this.link.abort().catch(() => {});
        // Stop pressed (while reading marks, say) is not an alarm
        if (!ctl.aborted) {
          this.st.state = 'alarm';
          this.st.message = e.message;
        }
      }
      // the head Z axis: the nozzle up before the head goes anywhere else
      const zRun = this.zaxis ? this.zaxis.end() : null;
      // RDD6584: after a job the head parks at home, so measure from there
      if (result === 'Completed' && program && program.knife && this.link.learnHome) await this.link.learnHome().catch(() => {});
      // Setup → Jobs → Return head to start: done, the head goes back to where it was at Start
      // (a plotter parks at home itself). Stopped jobs stay put, to look at where it stopped
      else if (result === 'Completed' && back && this.cfg.returnHead !== false && this.cfg.type !== 'plotter' && !ctl.aborted && this.st.link === 'online') {
        try {
          this.st.progress = 1; job.progress = 1;
          this.st.message = 'Returning to the start position';
          await this.link.moveTo(...this.clampTravel(back.x, back.y));
          await this.waitIdle(60000, 300);
          this.log('back to the start position, X ' + back.x.toFixed(1) + ' Y ' + back.y.toFixed(1));
        } catch (e) { this.log('return to start: ' + e.message); }
      }
      this.store.finish(job, result, startedAt, this.cfg.removeDone);
      if (timeline.length && this.store.saveRun) this.store.saveRun(job, { startedAt, result, estimate: program ? program.seconds : null, steps: program ? program.segments.filter((s) => s.kind === 'stream').flatMap((s) => s.steps) : [], timeline, placement: runRef.placement, ...(zRun ? { z: { dry: zRun.dry, log: zRun.log.map((e) => [e[0] - since, e[1], e[2], e[3]]) } } : {}) });
      // a run saved: the server fits the screen's head drawing to it (follow-fit.js)
      if (timeline.length && this.onRunSaved) { try { this.onRunSaved(job, result); } catch (e) { /* never stops the run ending */ } }
      this.run = null;
      this.onPos = null;
      this.st.job = null;
      this.st.placed = null;
      this.st.marker = null;
      // the registration marks found belong to this run: off the bed view with it
      this.st.marks = null;
      if (this.st.state !== 'alarm') {
        this.st.state = 'idle';
        this.st.message = result === 'Completed' ? 'Finished ' + job.name : 'Stopped';
        if (result === 'Completed') this.st.progress = 1;
      }
      this.log((result === 'Completed' ? 'done ' : 'stopped ') + job.name);
      // Queue → Select: the next of the chosen jobs follows a completed one; anything else ends the run
      const rest = result === 'Completed' ? (this.batch || []) : [];
      this.batch = [];
      if (rest.length) {
        setTimeout(() => {
          if (this.run) return;
          this.start({ ids: rest }).then((r) => { if (r.job) this.log('next chosen job (' + rest.length + ' left)'); else if (r.message) this.st.message = r.message; })
            .catch((e) => { this.log('chosen jobs stopped: ' + e.message); this.st.message = 'Stopped before the next job: ' + e.message; });
        }, 2000);
      }
    })();
  }

  async pause() {
    if (!this.run) return { state: this.st.state };
    this.run.ctl.paused = true;
    await this.link.pause();
    this.st.state = 'paused';
    this.st.message = 'Paused';
    return { state: 'paused' };
  }

  async resume() {
    if (!this.run) return { state: this.st.state };
    if (this.st.interlock) throw busyErr('Lid is open');
    await this.link.resume();
    this.run.ctl.paused = false;
    this.st.state = 'running';
    this.st.message = 'Running ' + this.run.job.name;
    return { state: 'running' };
  }

  // ------------------------------------------------------------ print and cut by hand
  // A registration mark wasn't found where it should be. The job waits, beam off: the screen opens
  // Jog with the camera picture, the user jogs the camera over the mark and presses Accept, and the
  // dot finder takes over from there. Resolves with where the camera then looks (bed mm); Stop ends it.
  async waitForMark(info, ctl) {
    const w = { accepted: false, at: null };
    this.markWait = w;
    this.st.markWait = { mark: info.mark, of: info.of, near: info.near.map((v) => +v.toFixed(2)), again: !!info.again };
    this.st.message = 'Mark ' + info.mark + ' of ' + info.of + (info.again ? ' still not found' : ' not found') + ': jog the camera over it, then Accept';
    try {
      while (!w.accepted) {
        if (ctl.aborted) throw busyErr('Stopped');
        await sleep(150);
      }
    } finally {
      this.markWait = null;
      this.st.markWait = null;
    }
    await this.jogRelease();
    return w.at;
  }

  // Accept (Jog page): the mark is under the camera's crosshair
  async markAccept() {
    const w = this.markWait;
    if (!w) throw busyErr('No registration mark is waiting to be found');
    if (this.hold) await this.jogRelease();
    await this.waitIdle(10000, 150);
    const p = this.st.pos;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw busyErr('The head position isn\'t known yet');
    w.at = this.vision.cameraAt([p.x, p.y]);
    w.accepted = true;
    return { accepted: true, at: w.at };
  }

  // always accepted, in every state
  async stop() {
    this.jogRelease();
    this.framing = false;
    this.batch = []; // Stop also ends a run of chosen jobs
    if (this.camCtl) this.camCtl.aborted = true; // and camera work
    if (this.run) this.run.ctl.aborted = true;
    // the head Z axis: the nozzle up at once
    if (this.zaxis && this.zaxis.link) this.zaxis.link.up().catch(() => {});
    try { if (this.link) await this.link.abort(); } catch (e) { this.log('stop: ' + e.message); }
    if (!this.run && this.st.state !== 'alarm') { this.st.state = 'idle'; this.st.message = 'Stopped'; }
    return { state: this.run ? 'stopping' : this.st.state };
  }

  clearAlarm() {
    if (this.st.state === 'alarm') { this.st.state = 'idle'; this.st.message = this.st.link === 'online' ? 'Ready' : this.st.message; }
    if (this.st.link !== 'online') this.connect();
    return { state: this.st.state };
  }

  // posAge: how long ago (ms) the controller reported the head there (the screen follows a running
  // job from it: a position can be over a second old by the time it's drawn)
  status() {
    return { ...this.st, pos: { ...this.st.pos }, io: { ...this.st.io }, queued: this.store.jobs.filter((j) => j.status === 'queued').length, posAge: this.posAt ? Date.now() - this.posAt : null };
  }
}

module.exports = Machine;

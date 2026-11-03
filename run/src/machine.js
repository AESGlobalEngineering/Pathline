// The machine: one link to the controller, the live status Pathline polls,
// manual control with the safety rules from HMI-BRIEF.md §7, and the job
// runner (convert → stream segment by segment → wait until the controller is
// idle → next segment).
'use strict';

const { makeLink, controller } = require('./ctrl');
const plan = require('./job/plan');
const validate = require('./job/validate');
const fitting = require('./vision/fit');
const { Vision } = require('./vision/vision');

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
    // status the link reads on its own (e.g. while a Trotec's buffer is full during a job)
    link.onPoll = (p) => { if (this.link === link) this.apply(p); };
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
    if (p.pos && Number.isFinite(p.pos.x)) { this.st.pos = p.pos; this.posAt = Date.now(); }
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
  guard(opts = {}) {
    if (!this.cfg.configured) throw busyErr('No machine is set up in Pathline Run yet');
    if (this.st.link !== 'online') throw busyErr('The machine isn\'t connected: ' + this.st.message);
    if (this.run) throw busyErr('A job is running');
    if (this.hold) throw busyErr('The head is being jogged');
    if (this.camBusy) throw busyErr('The camera is busy: ' + this.camBusy);
    if (this.busy()) throw busyErr('The machine is framing');
    if (this.st.state === 'alarm') throw busyErr('Alarm: ' + this.st.message + '. Clear it on the HMI first.');
    if (this.st.interlock && !opts.lidOpenOk) throw busyErr('Lid is open');
  }

  clampX(x) { return Math.max(0, Math.min(this.cfg.bed[0], x)); }
  clampY(y) { return Math.max(0, Math.min(this.cfg.bed[1], y)); }

  // How far a jog may go along an axis: the bed, widened to wherever the head is now. A head
  // outside the bed set in Setup (bed set smaller than the machine) is never pulled back
  // across to the bed edge: that was a long rapid, in whichever direction was pressed.
  jogRange(axis) {
    const max = axis === 'x' ? this.cfg.bed[0] : this.cfg.bed[1];
    const cur = this.st.pos[axis];
    return Number.isFinite(cur) ? [Math.min(0, cur), Math.max(max, cur)] : [0, max];
  }

  async jog(b) {
    this.guard({ lidOpenOk: true }); // beam off: the head may move with the lid open
    let x = this.st.pos.x, y = this.st.pos.y;
    if (b.x !== undefined || b.y !== undefined) {
      if (b.x !== undefined) x = Number(b.x);
      if (b.y !== undefined) y = Number(b.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw Object.assign(new Error('x and y must be numbers'), { code: 400 });
      x = this.clampX(x); y = this.clampY(y);
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
    this.guard({ lidOpenOk: true });
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
    if (Date.now() > h.until || this.run || this.framing || this.st.link !== 'online' || this.st.state === 'alarm') { this.jogRelease(); return; }
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
      this.execute(job, null, async (ctl, status) => {
        const r = await this.vision.readMarks(pkg, ctl, status);
        this.st.marks = r.found;
        try { return this.compile(Vision.corrected(pkg, r.f), opts); } catch (e) { throw new Error('Couldn\'t convert "' + job.name + '" after reading its marks: ' + e.message); }
      });
      return { state: 'running', job: job.id };
    }
    this.execute(job, program);
    return { state: 'running', job: job.id };
  }

  // prepare(ctl, status): work done before the job is sent (reading registration marks), giving
  // the program to send
  execute(job, program, prepare) {
    const ctl = { aborted: false, paused: false };
    const startedAt = new Date().toISOString();
    this.run = { job, program, ctl };
    job.status = 'running';
    job.progress = 0;
    this.store.flush();
    this.st.marks = null;
    Object.assign(this.st, { state: 'running', job: job.id, progress: 0, message: prepare ? 'Reading registration marks' : 'Running ' + job.name });
    let total = 1;
    let doneSec = 0;
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
          const follow = (p) => {
            this.apply(p);
            const now = Date.now();
            if (p.state === 'busy') { sawBusy = true; active += ((now - last) / 1000) * (this.link.timeScale || 1); }
            last = now;
            const est = p.marker ? Math.max(markerSec(p.marker), Math.min(active, seg.seconds)) : Math.min(active, seg.seconds);
            setProgress(doneSec + est);
            if (p.state === 'paused' && !ctl.paused) this.st.message = p.interlock ? 'Paused: lid open' : 'Paused on the machine';
          };
          await this.link.send(seg, { ...ctl, get aborted() { return ctl.aborted; }, onReply: follow });
          const sentAt = Date.now();
          let idle = 0;
          while (!ctl.aborted) {
            await sleep(300);
            const p = await this.link.poll();
            follow(p);
            if (p.state === 'paused') this.st.state = 'paused';
            else if (this.st.state === 'paused' && !ctl.paused) this.st.state = 'running';
            idle = p.state === 'idle' ? idle + 1 : 0;
            // done once idle twice in a row, after it was seen busy (or a moment has passed)
            if (idle >= 2 && (sawBusy || Date.now() - sentAt > 3000)) break;
          }
          doneSec += seg.seconds;
          setProgress(doneSec);
        }
        if (ctl.aborted) result = 'Stopped';
      } catch (e) {
        result = 'Stopped';
        this.log('job failed: ' + e.message);
        await this.link.abort().catch(() => {});
        this.st.state = 'alarm';
        this.st.message = e.message;
      }
      // RDD6584: after a job the head parks at home, so measure from there
      if (result === 'Completed' && program && program.knife && this.link.learnHome) await this.link.learnHome().catch(() => {});
      this.store.finish(job, result, startedAt, this.cfg.removeDone);
      this.run = null;
      this.st.job = null;
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

  // always accepted, in every state
  async stop() {
    this.jogRelease();
    this.framing = false;
    this.batch = []; // Stop also ends a run of chosen jobs
    if (this.camCtl) this.camCtl.aborted = true; // and camera work
    if (this.run) this.run.ctl.aborted = true;
    try { if (this.link) await this.link.abort(); } catch (e) { this.log('stop: ' + e.message); }
    if (!this.run && this.st.state !== 'alarm') { this.st.state = 'idle'; this.st.message = 'Stopped'; }
    return { state: this.run ? 'stopping' : this.st.state };
  }

  clearAlarm() {
    if (this.st.state === 'alarm') { this.st.state = 'idle'; this.st.message = this.st.link === 'online' ? 'Ready' : this.st.message; }
    if (this.st.link !== 'online') this.connect();
    return { state: this.st.state };
  }

  status() {
    return { ...this.st, pos: { ...this.st.pos }, io: { ...this.st.io }, queued: this.store.jobs.filter((j) => j.status === 'queued').length };
  }
}

module.exports = Machine;

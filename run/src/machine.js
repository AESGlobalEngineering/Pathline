// The machine: one link to the controller, the live status Pathline polls,
// manual control with the safety rules from HMI-BRIEF.md §7, and the job
// runner (convert → stream segment by segment → wait until the controller is
// idle → next segment).
'use strict';

const { makeLink, controller } = require('./ctrl');
const plan = require('./job/plan');
const validate = require('./job/validate');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const busyErr = (msg) => Object.assign(new Error(msg), { code: 409 });

class Machine {
  constructor(cfg, store, log) {
    this.cfg = cfg;
    this.store = store;
    this.log = log;
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
    const link = makeLink(this.cfg, this.log);
    this.link = link;
    // status the link reads on its own (e.g. while a Trotec's buffer is full during a job)
    link.onPoll = (p) => { if (this.link === link) this.apply(p); };
    try {
      this.info = await link.connect();
      if (this.link !== link) return;
      this.st.link = 'online';
      this.st.message = 'Ready';
      this.lastConnectError = null;
      if (this.st.state === 'alarm') this.st.state = 'idle';
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
      if (this.st.link === 'online' && !this.run) {
        try { this.apply(await this.link.poll()); } catch (e) { this.lost(e); }
      }
      this.pollTimer = setTimeout(loop, this.run ? 1000 : 500);
    };
    loop();
  }

  apply(p) {
    if (p.pos && Number.isFinite(p.pos.x)) { this.st.pos = p.pos; this.posAt = Date.now(); }
    this.st.interlock = !!p.interlock;
    if (!this.run && this.st.state !== 'alarm') {
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
  busy() { return !!this.run || this.st.state === 'framing' || !!this.framing || !!this.hold; }

  // opts.lidOpenOk: moves with the beam off (jog, hold, home) are allowed with the lid open
  guard(opts = {}) {
    if (!this.cfg.configured) throw busyErr('No machine is set up in Pathline Run yet');
    if (this.st.link !== 'online') throw busyErr('The machine isn\'t connected: ' + this.st.message);
    if (this.run) throw busyErr('A job is running');
    if (this.hold) throw busyErr('The head is being jogged');
    if (this.busy()) throw busyErr('The machine is framing');
    if (this.st.state === 'alarm') throw busyErr('Alarm: ' + this.st.message + '. Clear it on the HMI first.');
    if (this.st.interlock && !opts.lidOpenOk) throw busyErr('Lid is open');
  }

  clampX(x) { return Math.max(0, Math.min(this.cfg.bed[0], x)); }
  clampY(y) { return Math.max(0, Math.min(this.cfg.bed[1], y)); }

  async jog(b) {
    this.guard({ lidOpenOk: true }); // beam off: the head may move with the lid open
    let x = this.st.pos.x, y = this.st.pos.y;
    if (b.x !== undefined || b.y !== undefined) {
      if (b.x !== undefined) x = Number(b.x);
      if (b.y !== undefined) y = Number(b.y);
    } else {
      const d = Number(b.distance);
      if (!Number.isFinite(d)) throw Object.assign(new Error('distance must be a number'), { code: 400 });
      if (b.axis === 'x') x += d;
      else if (b.axis === 'y') y += d;
      else if (b.axis === 'z') throw busyErr('This machine has no Z axis');
      else throw Object.assign(new Error('axis must be x, y or z'), { code: 400 });
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw Object.assign(new Error('x and y must be numbers'), { code: 400 });
    x = this.clampX(x); y = this.clampY(y);
    await this.link.moveTo(x, y);
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
      return { holding: true };
    }
    if (!this.hold) this.guard({ lidOpenOk: true });
    const at = { x: this.st.pos.x, y: this.st.pos.y };
    this.hold = { axis, dir, speed, until, at, ideal: at[axis], last: Date.now(), busy: false };
    if (!this.holdTimer) this.holdTimer = setInterval(() => this.holdTick(), 100);
    return { holding: true };
  }

  jogRelease() {
    this.hold = null;
    clearInterval(this.holdTimer);
    this.holdTimer = null;
    return { holding: false };
  }

  async holdTick() {
    const h = this.hold;
    if (!h || h.busy) return;
    if (Date.now() > h.until || this.run || this.framing || this.st.link !== 'online' || this.st.state === 'alarm') { this.jogRelease(); return; }
    // where the head should be by now at this speed, but never more than ~0.15 s ahead of
    // where it is, so it stops close to where the arrow was let go
    const now = Date.now();
    const max = h.axis === 'x' ? this.cfg.bed[0] : this.cfg.bed[1];
    h.ideal += h.dir * h.speed * ((now - h.last) / 1000);
    h.last = now;
    const lead = h.speed * 0.15 + 0.05;
    // the reported position is a moment old: allow for how far the head has moved since
    const age = Math.min(0.3, (now - (this.posAt || now)) / 1000);
    const cur = this.st.pos[h.axis] + h.dir * h.speed * age;
    const target = Math.max(0, Math.min(max, h.dir > 0 ? Math.min(h.ideal, cur + lead) : Math.max(h.ideal, cur - lead)));
    h.ideal = target;
    if (h.dir * (target - h.at[h.axis]) < 0.005) return; // nothing new to send (or at the bed edge)
    h.at[h.axis] = target;
    h.busy = true;
    try {
      await this.link.moveTo(h.at.x, h.at.y, { speed: h.speed });
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
    return { ok: true };
  }

  async frame(box) {
    this.guard();
    if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite)) throw Object.assign(new Error('box must be [x0, y0, x1, y1]'), { code: 400 });
    const [x0, y0, x1, y1] = [this.clampX(box[0]), this.clampY(box[1]), this.clampX(box[2]), this.clampY(box[3])];
    this.framing = true;
    this.st.state = 'framing';
    this.st.message = 'Framing';
    (async () => {
      try {
        for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]) {
          if (!this.framing) break;
          await this.link.moveTo(x, y, { light: true });
          await this.waitIdle(30000, 150);
        }
      } catch (e) { this.log('frame: ' + e.message); }
      this.framing = false;
      if (this.st.state === 'framing') { this.st.state = 'idle'; this.st.message = 'Ready'; }
    })();
    return { state: 'framing' };
  }

  async waitIdle(ms, minMs) {
    const t0 = Date.now();
    await sleep(minMs || 0);
    while (Date.now() - t0 < ms) {
      const p = this.apply(await this.link.poll());
      if (p.state === 'idle') return;
      await sleep(150);
    }
  }

  async io(b) {
    for (const k of Object.keys(b)) {
      if (!(k in this.st.io)) continue;
      if (k === 'air' || k === 'pointer') {
        if (this.st.link !== 'online') throw busyErr('The machine isn\'t connected');
        await this.link.setIo(k, !!b[k]);
        this.st.io[k] = !!b[k];
      } else throw busyErr('This machine has no ' + k + ' output');
    }
    return { io: this.st.io };
  }

  // ------------------------------------------------------------ jobs
  compile(pkg, opts) {
    const p = plan.build(pkg);
    return controller(this.cfg.controller).compile(p, this.cfg, opts);
  }

  async start() {
    if (this.run) return { state: this.st.state };
    this.guard();
    const job = this.store.next();
    if (!job) return { state: this.st.state, message: 'Nothing queued' };
    // as placed: moved to the head if the operator anchored it there
    const pkg = this.store.runPkg(job.id);
    if (job.anchor) {
      try { validate.check(pkg, this.cfg); } catch (e) { throw busyErr('"' + job.name + '" anchored at the head: ' + e.message); }
    }
    let program;
    // a plotter's conveyor moves on from where it stopped last time
    const opts = {};
    if (pkg.toolpath.some((s) => s.type === 'feed') && this.link && this.link.readU) opts.uStart = await this.link.readU().catch(() => 0);
    try { program = this.compile(pkg, opts); } catch (e) { throw Object.assign(new Error('Couldn\'t convert "' + job.name + '": ' + e.message), { code: 409 }); }
    if (program.segments.some((s) => s.kind === 'inspect') && this.cfg.regMarks !== 'ignore') {
      throw busyErr('"' + job.name + '" uses registration marks, and Pathline Run has no camera yet. Set Registration marks to "Skip" in Setup to run it uncorrected.');
    }
    this.execute(job, program);
    return { state: 'running', job: job.id };
  }

  execute(job, program) {
    const ctl = { aborted: false, paused: false };
    const startedAt = new Date().toISOString();
    this.run = { job, program, ctl };
    job.status = 'running';
    job.progress = 0;
    this.store.flush();
    Object.assign(this.st, { state: 'running', job: job.id, progress: 0, message: 'Running ' + job.name });
    this.log('run ' + job.name + ' (' + program.ctrl + ', ' + program.segments.length + ' segments, ' + Math.round(program.seconds) + ' s estimated)');
    const total = Math.max(0.001, program.seconds);
    let doneSec = 0;
    const setProgress = (sec) => {
      this.st.progress = Math.max(this.st.progress, Math.min(0.999, sec / total));
      job.progress = this.st.progress;
    };

    (async () => {
      let result = 'Completed';
      try {
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
      this.store.finish(job, result, startedAt, this.cfg.removeDone);
      this.run = null;
      this.st.job = null;
      if (this.st.state !== 'alarm') {
        this.st.state = 'idle';
        this.st.message = result === 'Completed' ? 'Finished ' + job.name : 'Stopped';
        if (result === 'Completed') this.st.progress = 1;
      }
      this.log((result === 'Completed' ? 'done ' : 'stopped ') + job.name);
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

// Simulated controller link, for testing on a PC without the machine. The job
// is still converted for the configured controller (so conversion errors show
// up), but "running" just replays each segment's estimated time and moves the
// head along its path.
//
// Every link (sim, trotec, ruida) has the same shape:
//   connect() → { model, firmware }      close()
//   poll() → { state: idle|busy|paused, pos: {x, y, z}, interlock, marker?, text? }
//   moveTo(x, y, { light })  home()  setIo(name, on)
//   send(segment, ctl)  transmits one stream segment; ctl.aborted stops it
//   pause()  resume()  abort()
'use strict';

const SPEEDUP_DEFAULT = 20;

class SimLink {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log;
    this.speedup = (cfg.sim && cfg.sim.speedup) || SPEEDUP_DEFAULT;
    this.timeScale = this.speedup; // job seconds per real second, for progress
    this.pos = { x: 0, y: 0, z: 0 };
    this.run = null;   // { seg, t, paused }
    this.move = null;  // { from, to, t0, ms }
    this.lidOpen = false;
    this.supports = { air: true, pointer: true };
  }

  async connect() {
    this.timer = setInterval(() => this.tick(), 100);
    return { model: 'Simulated ' + (this.cfg.controller === 'ruida' ? 'Ruida' : 'Trotec'), firmware: 'sim' };
  }

  async close() { clearInterval(this.timer); }

  tick() {
    const now = Date.now();
    if (this.move) {
      const k = Math.min(1, (now - this.move.t0) / this.move.ms);
      this.pos.x = this.move.from.x + (this.move.to.x - this.move.from.x) * k;
      this.pos.y = this.move.from.y + (this.move.to.y - this.move.from.y) * k;
      if (k >= 1) this.move = null;
    }
    const r = this.run;
    if (!r || r.paused || this.lidOpen) { if (r) r.last = now; return; }
    r.t += ((now - r.last) / 1000) * this.speedup;
    r.last = now;
    const tr = r.seg.trace || [];
    if (tr.length) {
      const k = Math.min(tr.length - 1, Math.floor((r.t / Math.max(0.001, r.seg.seconds)) * tr.length));
      [this.pos.x, this.pos.y] = tr[Math.max(0, k)];
    }
    // markers: steps finished so far
    let acc = 0;
    for (const s of r.seg.steps || []) { acc += s.seconds; if (acc <= r.t) r.marker = s.i + 1; }
    if (r.t >= r.seg.seconds) this.run = null;
  }

  async poll() {
    const state = this.run ? (this.run.paused || this.lidOpen ? 'paused' : 'busy') : this.move ? 'busy' : 'idle';
    return { state, pos: { ...this.pos }, interlock: this.lidOpen, marker: this.run ? this.run.marker : undefined };
  }

  async moveTo(x, y, opts = {}) {
    // start from where the head is right now, not where the last 100 ms tick left it
    if (this.move) {
      const k = Math.min(1, (Date.now() - this.move.t0) / this.move.ms);
      this.pos.x = this.move.from.x + (this.move.to.x - this.move.from.x) * k;
      this.pos.y = this.move.from.y + (this.move.to.y - this.move.from.y) * k;
    }
    const d = Math.hypot(x - this.pos.x, y - this.pos.y);
    const ms = opts.speed ? (d / opts.speed) * 1000 : Math.max(150, (d / (this.cfg.speed || 500)) * 1000);
    this.move = { from: { ...this.pos }, to: { x, y }, t0: Date.now(), ms: Math.max(1, ms) };
  }

  async home() { return this.moveTo(0, 0); }
  async feed() { this.u = (this.u || 0) + (this.cfg.feedLen || 1000); }
  async readU() { return this.u || 0; }
  async setIo() {}
  async send(seg) { this.run = { seg, t: 0, last: Date.now(), paused: false, marker: 0 }; }
  async pause() { if (this.run) this.run.paused = true; }
  async resume() { if (this.run) this.run.paused = false; }
  async abort() { this.run = null; this.move = null; }
}

module.exports = SimLink;

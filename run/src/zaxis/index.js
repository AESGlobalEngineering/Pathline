// The head Z axis (ESP32 + TMC2209 moving the whole nozzle, an ultrasonic sensor beside it):
// connect and home, scan the sheet's height, set focus, and follow a job with the nozzle focused
// on the sheet as it lies. Setup → Z axis (cfg.zaxis):
//   enabled, sim (a simulated axis), port, dry (work it all out and log it, move nothing),
//   sensorOffset [dx, dy] (mm from the beam to the sensor), sensorOnZ (the sensor moves with the
//   nozzle), ref (pos focused, set by Set focus) and dRef (the sensor's distance there),
//   bottom (deepest pos allowed), gap (nozzle to sheet at focus), gapMin, lift, vmax and amax (the
//   axis), planVmax, grid and margin (the scan), tol (scan outliers)
'use strict';

const fs = require('fs');
const path = require('path');
const ZLink = require('./link');
const mesh = require('./mesh');
const P = require('./planner');
const { ZFollow } = require('./follow');
const F = require('../../ui/follow');

const DEFAULTS = {
  enabled: false, sim: false, port: '', dry: true, sensorOffset: [0, 45], sensorOnZ: false,
  ref: 4, dRef: null, bottom: 8, gap: 2, gapMin: 0.8, lift: 1, vmax: 15, amax: 1000, planVmax: 10,
  grid: 40, margin: 15, tol: 0.6
};

const err = (code, msg) => Object.assign(new Error(msg), { code });

class ZAxis {
  // m: the machine; o: { dataDir, log, motion() → the server's Trotec motion (with motion.follow) }
  constructor(m, o) {
    this.m = m;
    this.o = o;
    this.log = o.log || (() => {});
    this.link = null;
    this.state = 'off';
    this.info = null;
    this.file = path.join(o.dataDir, 'zmesh.json');
    try { this.mesh = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { this.mesh = null; }
    this.run = null;
  }

  get cfg() { return { ...DEFAULTS, ...(this.m.cfg.zaxis || {}) }; }
  enabled() { return !!this.cfg.enabled; }

  // ------------------------------------------------------------ the axis
  async connect() {
    await this.close();
    const c = this.cfg;
    if (!c.enabled) { this.state = 'off'; return null; }
    this.state = 'connecting';
    const link = new ZLink({ port: c.port, sim: c.sim || this.o.sim }, {
      log: this.log,
      // the simulated axis: a sheet bowed 1.5 mm, the sensor beside the beam
      sim: { surface: (x, y) => 1.5 * Math.sin((Math.PI * x) / 1300) * Math.sin((Math.PI * y) / 900), headPos: () => this.m.st.pos || { x: 0, y: 0 }, sensorOffset: c.sensorOffset, dRef: 90 }
    });
    try {
      this.info = await link.open();
      await link.limits(c.bottom, c.vmax, c.amax);
      this.link = link;
      link.onFault = (f) => { this.state = 'fault'; this.fault = f.text; };
      await link.home();
      this.state = 'ready';
      this.fault = null;
      this.log('z axis: ' + this.info + ', homed');
      this.syncTimer = setInterval(() => { if (this.link && !this.link.closed) this.link.sync().catch(() => {}); }, 2000);
      return this.info;
    } catch (e) {
      this.state = 'offline';
      this.fault = e.message;
      this.log('z axis: ' + e.message);
      await link.close().catch(() => {});
      throw e;
    }
  }

  async close() {
    clearInterval(this.syncTimer);
    if (this.link) { try { await this.link.up(); } catch (e) { /* closing anyway */ } await this.link.close().catch(() => {}); }
    this.link = null;
    if (this.state !== 'off') this.state = 'offline';
  }

  need() {
    if (!this.enabled()) throw err(409, 'The Z axis is off (Setup → Z axis)');
    if (!this.link || this.state !== 'ready') throw err(409, 'The Z axis isn\'t ready' + (this.fault ? ': ' + this.fault : ''));
  }

  async home() { if (!this.link) await this.connect(); else { await this.link.home(); this.state = 'ready'; this.fault = null; } return this.status(); }
  async up() { this.need(); await this.link.up(); return this.status(); }
  async jog(b) {
    this.need();
    if (this.m.run) throw err(409, 'A job is running');
    const s = await this.link.status();
    const to = Number.isFinite(b.pos) ? b.pos : s.pos + (Number(b.delta) || 0);
    await this.link.go(Math.max(0, Math.min(this.cfg.bottom, to)), Math.min(5, this.cfg.vmax));
    return this.status();
  }
  async read(n = 16) {
    this.need();
    const r = await this.link.read(n);
    if (this.cfg.sensorOnZ) { const s = await this.link.status(); r.mm += s.pos; }
    return r;
  }
  async status() {
    const out = { enabled: this.enabled(), state: this.state, info: this.info, fault: this.fault || null };
    if (this.link && !this.link.closed) { try { Object.assign(out, await this.link.status()); } catch (e) { out.error = e.message; } }
    return out;
  }

  // ------------------------------------------------------------ focus and the height map
  // Set focus: the nozzle has been focused (with the Trotec's focus gauge, Z jogged) over the point
  // under the beam. That pos is ref; the sensor is then brought over the same point to read dRef.
  async setFocus() {
    this.need();
    const c = this.cfg;
    return this.m.cameraTask('Setting the Z axis focus', async (ctl, say) => {
      // the axis at rest where it was focused (a jog may still be finishing)
      let s = await this.link.status();
      const moving = (q) => Math.abs(q.v) > 0.05 || Math.abs(q.tgt - q.pos) > 0.02;
      for (let i = 0; i < 40 && moving(s); i++) { await new Promise((r) => setTimeout(r, 100)); s = await this.link.status(); }
      if (moving(s)) throw err(409, 'The Z axis is still moving: try again once it has stopped');
      const at = { ...this.m.st.pos };
      say('Reading the height where the nozzle was focused');
      // the nozzle up before the head moves (it's at focus, 2 mm over the sheet), back after
      await this.link.up();
      await this.moveSensorTo(at.x, at.y);
      const r = await this.read(32);
      await this.m.link.moveTo(...this.m.clampTravel(at.x, at.y));
      await this.m.waitIdle(30000, 200);
      await this.link.go(s.pos, 3);
      if (r.spread > 1) throw err(409, 'The sensor\'s readings there were too spread out (' + r.spread.toFixed(1) + ' mm): move to the middle of the sheet, away from edges and holes');
      this.log('z axis: focus set at pos ' + s.pos.toFixed(2) + ' mm, sensor ' + r.mm.toFixed(2) + ' mm (X ' + at.x.toFixed(1) + ' Y ' + at.y.toFixed(1) + ')');
      // a new focus: an old height map was measured against the old one
      this.mesh = null;
      try { fs.unlinkSync(this.file); } catch (e) { /* none */ }
      return { ref: +s.pos.toFixed(3), dRef: +r.mm.toFixed(3) };
    });
  }

  // the head moved so the sensor is over bed point (x, y)
  async moveSensorTo(x, y) {
    const [dx, dy] = this.cfg.sensorOffset;
    await this.m.link.moveTo(...this.m.clampTravel(x - dx, y - dy));
    await this.m.waitIdle(60000, 100);
  }

  // Scan the sheet under box [x0, y0, x1, y1] (bed mm): the sensor visits a grid, the nozzle up
  async scan(box) {
    this.need();
    const c = this.cfg;
    if (!Number.isFinite(c.dRef)) throw err(409, 'Set the Z axis focus first (Z axis → Set focus)');
    const t = this.m.travel(), [dx, dy] = c.sensorOffset;
    // where the sensor can be: the head's travel, shifted by the sensor's offset
    const reach = [t[0] + dx, t[1] + dy, t[2] + dx, t[3] + dy];
    const grid = mesh.gridFor(box, c.grid, c.margin, reach);
    const order = mesh.scanOrder(grid);
    return this.m.cameraTask('Scanning the sheet\'s height', async (ctl, say) => {
      await this.link.up();
      const pts = [];
      const t0 = Date.now();
      // the head goes back where it was (on the top-left dot, say, for a job anchored there)
      const home = { ...this.m.st.pos };
      const back = async () => { if (Number.isFinite(home.x)) { await this.m.link.moveTo(...this.m.clampTravel(home.x, home.y)); await this.m.waitIdle(60000, 100); } };
      try {
        for (let k = 0; k < order.length; k++) {
          if (ctl.aborted) throw err(409, 'Scan stopped');
          const g = order[k];
          say('Scanning the sheet\'s height: ' + (k + 1) + ' of ' + order.length);
          await this.moveSensorTo(g.x, g.y);
          await new Promise((r) => setTimeout(r, 120));
          const r = await this.read(12);
          pts.push({ x: g.x, y: g.y, d: r.spread > 2 ? NaN : r.mm });
        }
      } finally { if (!ctl.aborted) await back().catch(() => {}); }
      const m = mesh.build(pts, grid, { dRef: c.dRef, tol: c.tol });
      m.box = box;
      m.seconds = Math.round((Date.now() - t0) / 1000);
      this.mesh = m;
      fs.writeFileSync(this.file, JSON.stringify(m));
      this.log('z axis: sheet scanned, ' + m.nx + ' × ' + m.ny + ' points in ' + m.seconds + ' s: height ' + m.min.toFixed(2) + ' to ' + m.max.toFixed(2) + ' mm, steepest ' + (m.slope * 100).toFixed(1) + ' %' + (m.dropped.length ? ', ' + m.dropped.length + ' readings dropped (edges or holes)' : ''));
      return this.meshView();
    });
  }

  clearMesh() { this.mesh = null; try { fs.unlinkSync(this.file); } catch (e) { /* none */ } }
  meshView() { const m = this.mesh; return m ? { x0: m.x0, y0: m.y0, dx: m.dx, dy: m.dy, nx: m.nx, ny: m.ny, h: m.h, min: m.min, max: m.max, slope: m.slope, dropped: m.dropped.length, at: m.at, box: m.box } : null; }

  // ------------------------------------------------------------ a job
  // At Start, before the head moves: what a followed job needs (the job's own check comes once it's
  // placed, prepare())
  check() {
    if (!this.enabled()) return;
    const c = this.cfg;
    if (!c.dry) this.need();
    if (!Number.isFinite(c.dRef)) throw err(409, 'Set the Z axis focus first (Z axis → Set focus)');
    if (!this.mesh) throw err(409, 'The Z axis has no height map of this sheet: Z axis → Scan first (or switch the Z axis off in Setup)');
  }

  // Before a job starts (pkg as it will be cut): the plan, or why it can't be followed
  prepare(pkg) {
    if (!this.enabled()) return null;
    const c = this.cfg;
    if (!c.dry) this.need();
    if (!this.mesh) throw err(409, 'The Z axis has no height map of this sheet: Z axis → Scan first (or switch the Z axis off in Setup)');
    if (!Number.isFinite(c.dRef)) throw err(409, 'Set the Z axis focus first (Z axis → Set focus)');
    const M = F.motionFor(this.o.motion(), this.m.cfg);
    // a Trotec's engraving as it's sent (its lines and their time), as the screen draws it
    if (this.m.cfg.controller === 'trotec' && (pkg.toolpath || []).some((s) => s.type === 'engrave')) pkg = { ...pkg, rows: require('../ctrl/trotec/compile').engraveRows(pkg, this.m.cfg) };
    const route = F.routeOf(pkg, M);
    const plan = P.plan(route, this.mesh, { ref: c.ref, gap: c.gap, gapMin: c.gapMin, lift: c.lift, vmax: c.planVmax, bottom: c.bottom });
    const why = P.refusal(plan);
    if (why) throw err(409, why);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < plan.n; i++) if (plan.kind[i] === 1) { lo = Math.min(lo, plan.pos[i]); hi = Math.max(hi, plan.pos[i]); }
    this.log('z axis: planned ' + Math.round(route.end) + ' s of the job, the nozzle between pos ' + lo.toFixed(2) + ' and ' + hi.toFixed(2) + ' mm while cutting');
    return { plan, pkg, M };
  }

  // the job's stream has been handed over (since: then)
  begin(z, job, since) {
    if (!z) return;
    const c = this.cfg;
    const zf = new ZFollow({ sink: c.dry ? null : this.link, plan: z.plan, pkg: z.pkg, M: z.M, job: job.id, dry: c.dry, startAt: since, say: this.log });
    this.run = { zf, job, timer: setInterval(() => zf.tick(this.m.st.state === 'running' && !this.m.st.interlock), 50) };
    this.log('z axis: following ' + job.name + (c.dry ? ' (dry run: nothing moves)' : ''));
  }
  position(p, progress) { if (this.run) this.run.zf.position(p, progress, this.m.st.marker); }
  // the job ended: the nozzle up, and what was done (for the run's record)
  end() {
    const r = this.run;
    if (!r) return null;
    clearInterval(r.timer);
    this.run = null;
    if (this.link && !this.cfg.dry) this.link.up().catch(() => {});
    const log = r.zf.log;
    const followed = log.filter((x) => x[3] === 'f').length;
    this.log('z axis: ' + r.job.name + ' done: followed ' + Math.round((100 * followed) / Math.max(1, log.length)) + ' % of the time, held ' + Math.round((100 * log.filter((x) => x[3] === 'h').length) / Math.max(1, log.length)) + ' %, up ' + Math.round((100 * log.filter((x) => x[3] === 'u').length) / Math.max(1, log.length)) + ' %');
    return { dry: this.cfg.dry, log };
  }
}

module.exports = { ZAxis, DEFAULTS };

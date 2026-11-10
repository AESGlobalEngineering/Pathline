// A simulated head Z axis that answers the protocol in PROTOCOL.md as the firmware does (the same
// trajectory follower), over a simulated sheet for the ultrasonic sensor: for --sim and the tests.
// opts: { travel, surface(x, y) → sheet height (mm, + up), headPos() → { x, y } of the beam,
//         sensorOffset: [dx, dy], dRef (sensor distance at height 0), noise (mm), latency (ms) }
'use strict';

const POS_MAX = 8;

class ZDeviceSim {
  constructor(opts = {}) {
    this.o = { travel: 10, sensorOffset: [30, 0], dRef: 90, noise: 0.1, latency: 2, ...opts };
    this.t0 = Date.now();
    this.clock = opts.clock || (() => Date.now() - this.t0);
    this.pos = 0; this.v = 0; this.homed = false; this.err = 0;
    this.lim = { bottom: POS_MAX, vmax: 15, amax: 300 };
    this.traj = []; this.hold = 0; this.lastRx = 0; this.mode = 'hold';
    this.listeners = [];
    this.seed = 11;
    // in real time: a timer fires every 1–15 ms (Windows), each firing catches up 1 ms at a time
    if (!opts.manual) {
      let last = this.clock();
      this.timer = setInterval(() => { const now = this.clock(); for (let k = 0; k < Math.min(100, now - last); k++) this.step(1); last = now; }, 1);
    }
  }

  onLine(fn) { this.listeners.push(fn); }
  emit(s) { setTimeout(() => this.listeners.forEach((f) => f(s)), this.o.latency); }
  rnd() { this.seed = (this.seed * 16807) % 2147483647; return this.seed / 2147483647; }

  // one line from Run
  write(line) {
    setTimeout(() => this.handle(String(line).trim()), this.o.latency);
  }

  handle(line) {
    this.lastRx = this.clock();
    const [cmd, ...a] = line.split(/\s+/);
    const n = a.map(Number);
    const deep = () => Math.min(POS_MAX, this.lim.bottom);
    if (cmd === '?') return this.emit('PZ sim-0.1 travel=' + this.o.travel + ' spm=1600 homed=' + (this.homed ? 1 : 0));
    if (cmd === 'HOME') { this.pos = 0; this.v = 0; this.homed = true; this.err = 0; this.traj = []; this.mode = 'hold'; this.hold = 0; return this.emit('HOMED 900'); }
    if (cmd === 'T') return this.emit('T ' + Math.round(this.clock()));
    if (cmd === 'LIM') { this.lim = { bottom: n[0], vmax: n[1], amax: n[2] }; return this.emit('OK'); }
    if (cmd === 'P') {
      if (!this.homed || this.err) return;
      const pts = [];
      for (let i = 0; i + 1 < n.length; i += 2) pts.push([n[i], Math.max(0, Math.min(deep(), n[i + 1]))]);
      if (!pts.length) return;
      this.traj = this.traj.filter((p) => p[0] < pts[0][0]).concat(pts);
      this.mode = 'traj';
      return;
    }
    if (cmd === 'GO') { if (!this.homed || this.err) return this.emit('E notready home first'); this.traj = []; this.mode = 'hold'; this.hold = Math.max(0, Math.min(deep(), n[0])); return this.emit('OK'); }
    if (cmd === 'UP') { this.traj = []; this.mode = 'hold'; this.hold = 0; return this.emit('OK'); }
    if (cmd === 'R') {
      const k = Math.max(1, Math.min(64, n[0] || 8));
      const vals = [];
      for (let i = 0; i < k; i++) vals.push(this.distance() + (this.rnd() - 0.5) * 2 * this.o.noise);
      vals.sort((x, y) => x - y);
      return this.emit('R ' + vals[k >> 1].toFixed(3) + ' ' + k + ' ' + (vals[Math.floor(k * 0.9)] - vals[Math.floor(k * 0.1)]).toFixed(3));
    }
    if (cmd === 'S') return this.emit('S ' + Math.round(this.clock()) + ' pos=' + this.pos.toFixed(3) + ' tgt=' + this.target().toFixed(3) + ' v=' + this.v.toFixed(2) + ' homed=' + (this.homed ? 1 : 0) + ' q=' + this.traj.length + ' err=' + this.err);
  }

  // what the sensor sees: the sheet under it (sensor on the fixed part of the head)
  distance() {
    const h = this.o.headPos ? this.o.headPos() : { x: 0, y: 0 };
    const s = this.o.surface ? this.o.surface(h.x + this.o.sensorOffset[0], h.y + this.o.sensorOffset[1]) : 0;
    return this.o.dRef - s;
  }

  // the trajectory's target now (and its speed): linear between points, held after the last
  target(at) {
    const t = at === undefined ? this.clock() : at;
    if (this.mode !== 'traj' || !this.traj.length) return this.mode === 'traj' ? this.pos : this.hold;
    const q = this.traj;
    if (t <= q[0][0]) return q[0][1];
    for (let i = 1; i < q.length; i++) if (q[i][0] >= t) { const [t0, p0] = q[i - 1], [t1, p1] = q[i]; return p0 + ((p1 - p0) * (t - t0)) / Math.max(1, t1 - t0); }
    return q[q.length - 1][1];
  }

  // 1 ms of motion: feed-forward of the target's speed plus 20/s × the error, limited
  step(ms) {
    const now = this.clock();
    if (this.mode === 'traj' && now - this.lastRx > 1000) { this.traj = []; this.mode = 'hold'; this.hold = 0; this.emit('E watchdog no line for 1 s'); }
    // points well past: dropped (the last one kept to hold)
    while (this.traj.length > 1 && this.traj[1][0] < now - 50) this.traj.shift();
    const dt = ms / 1000;
    const tgt = this.target(now), ff = (this.target(now + 20) - tgt) / 0.02;
    let v = ff + 20 * (tgt - this.pos);
    v = Math.max(-this.lim.vmax, Math.min(this.lim.vmax, v));
    const dv = Math.max(-this.lim.amax * dt, Math.min(this.lim.amax * dt, v - this.v));
    this.v += dv;
    this.pos = Math.max(0, Math.min(Math.min(POS_MAX, this.lim.bottom), this.pos + this.v * dt));
  }

  close() { clearInterval(this.timer); }
}

module.exports = { ZDeviceSim, POS_MAX };

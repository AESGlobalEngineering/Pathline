// The head Z axis over USB serial (PROTOCOL.md), or the simulated one. One line per command;
// replies are matched to requests in order. The ESP32's clock is tracked against ours (the
// round trip with the shortest time of the last few gives the offset), so trajectory points can be
// sent in its time.
'use strict';

class ZLink {
  // cfg: the zaxis setup ({ port, sim }); opts: { log, sim: ZDeviceSim options }
  constructor(cfg, opts = {}) {
    this.cfg = cfg || {};
    this.log = opts.log || (() => {});
    this.simOpts = opts.sim || {};
    this.waiting = [];
    this.buf = '';
    this.syncs = [];
    this.off = null;      // ESP32 ms − our ms
    this.onFault = null;
    this.closed = true;
  }

  async open() {
    if (this.cfg.sim) {
      const { ZDeviceSim } = require('./device-sim');
      this.dev = new ZDeviceSim(this.simOpts);
      this.dev.onLine((l) => this.line(l));
      this.send = (s) => this.dev.write(s);
    } else {
      if (!this.cfg.port) throw new Error('Choose the Z axis\'s USB port in Setup → Z axis');
      const { SerialPort } = require('serialport');
      this.io = await new Promise((resolve, reject) => {
        const p = new SerialPort({ path: this.cfg.port, baudRate: 115200, autoOpen: false });
        p.open((e) => (e ? reject(new Error('Can\'t open ' + this.cfg.port + ' for the Z axis: ' + e.message)) : resolve(p)));
      });
      this.io.on('data', (d) => { this.buf += d.toString('latin1'); let i; while ((i = this.buf.indexOf('\n')) >= 0) { const l = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1); if (l) this.line(l); } });
      this.io.on('close', () => { this.closed = true; });
      this.io.on('error', (e) => this.log('z axis link: ' + e.message));
      this.send = (s) => this.io.write(s + '\n');
    }
    this.closed = false;
    // a fresh ESP32 may print a banner: give it a moment
    await new Promise((r) => setTimeout(r, this.cfg.sim ? 5 : 300));
    const who = await this.ask('?', /^PZ /, 2000);
    this.info = who;
    await this.sync();
    return who;
  }

  line(l) {
    if (l.startsWith('E ')) {
      this.fault = { at: Date.now(), text: l.slice(2) };
      this.log('z axis: ' + l.slice(2));
      if (this.onFault) this.onFault(this.fault);
      // a reply that was waiting gets the fault
      const w = this.waiting.shift();
      if (w) { clearTimeout(w.t); w.reject(new Error('Z axis: ' + l.slice(2))); }
      return;
    }
    const i = this.waiting.findIndex((w) => w.re.test(l));
    if (i < 0) return;
    const [w] = this.waiting.splice(i, 1);
    clearTimeout(w.t);
    w.resolve(l);
  }

  ask(cmd, re, ms = 1000) {
    if (this.closed) return Promise.reject(new Error('The Z axis isn\'t connected'));
    return new Promise((resolve, reject) => {
      const w = { re, resolve, reject };
      w.t = setTimeout(() => { const k = this.waiting.indexOf(w); if (k >= 0) this.waiting.splice(k, 1); reject(new Error('No answer from the Z axis to ' + cmd.split(' ')[0])); }, ms);
      this.waiting.push(w);
      this.send(cmd);
    });
  }

  // our clock against the ESP32's: the shortest round trip of the last 8
  async sync() {
    const a = Date.now();
    const r = await this.ask('T', /^T \d+/, 500);
    const b = Date.now();
    const esp = Number(r.split(' ')[1]);
    this.syncs.push({ rtt: b - a, off: esp - (a + b) / 2 });
    if (this.syncs.length > 8) this.syncs.shift();
    const best = this.syncs.reduce((x, y) => (y.rtt < x.rtt ? y : x));
    this.off = best.off;
    return best;
  }
  espTime(ms) { return Math.round(ms + (this.off || 0)); }

  home() { return this.ask('HOME', /^HOMED/, 30000); }
  limits(bottom, vmax, amax) { return this.ask('LIM ' + bottom.toFixed(3) + ' ' + vmax + ' ' + amax, /^OK/); }
  go(pos, v) { return this.ask('GO ' + pos.toFixed(3) + ' ' + (v || 5), /^OK/); }
  up() { return this.ask('UP', /^OK/); }
  // pts: [[our ms, pos], ...] → sent in the ESP32's time, no reply
  trajectory(pts) {
    if (this.closed || !pts.length) return;
    this.send('P ' + pts.map(([t, p]) => this.espTime(t) + ' ' + p.toFixed(3)).join(' '));
  }
  async read(n = 16) {
    const r = await this.ask('R ' + n, /^R /, 3000);
    const [, mm, k, spread] = r.split(' ');
    return { mm: Number(mm), n: Number(k), spread: Number(spread) };
  }
  async status() {
    const r = await this.ask('S', /^S /, 800);
    const out = { esp: Number(r.split(' ')[1]) };
    for (const m of r.matchAll(/(\w+)=(-?[\d.]+)/g)) out[m[1]] = Number(m[2]);
    return out;
  }

  async close() {
    this.closed = true;
    if (this.dev) this.dev.close();
    if (this.io) await new Promise((r) => { try { this.io.close(() => r()); } catch (e) { r(); } });
  }
}

module.exports = ZLink;

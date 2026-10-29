// Talks to a classic Trotec controller over USB serial (CDC, e.g. COM4 or
// /dev/ttyACM0) or a raw TCP byte stream (host:port). Text handshake first
// (pg0 … TX;), then SF packets, one in flight at a time (stop-and-wait).
// Every packet asks for status, XY position and the progress marker, so data
// packets double as status polls, as Ruby does.
'use strict';

const net = require('net');
const { packet, takePacket, parseReply, IM, TT, KEY } = require('./sf');
const { settings, units } = require('./compile');

const POLL = Buffer.from([IM.GETSTATUS, IM.GETXYPOSITION, IM.GET_PROGRESS_MARKER]);
const MAX_DATA = 1024;
const REPLY_MS = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class TrotecLink {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log || (() => {});
    this.S = settings(cfg);
    this.U = units(this.S);
    this.rx = Buffer.alloc(0);
    this.waiter = null;
    this.chain = Promise.resolve();
    this.id = 0;
    this.binary = false;
    this.urgent = [];
    this.supports = { air: true, pointer: false };
  }

  // ------------------------------------------------------------ transport
  async open() {
    const c = this.cfg.connection;
    if (c.mode === 'tcp') {
      this.io = await new Promise((resolve, reject) => {
        const s = net.connect({ host: c.host, port: Number(c.tcpPort) || 4713 }, () => resolve(s));
        s.once('error', reject);
        s.setTimeout(5000, () => s.destroy(new Error('No answer from ' + c.host)));
      });
      this.io.setTimeout(0);
      this.write = (b) => this.io.write(b);
      this.io.on('data', (d) => this.onData(d));
      this.io.on('close', () => { this.closed = true; });
      this.io.on('error', (e) => this.log('trotec link error: ' + e.message));
      return;
    }
    let SerialPort;
    try { ({ SerialPort } = require('serialport')); } catch (e) {
      throw new Error('USB serial support is not installed. Run "npm install" in the run folder.');
    }
    this.io = await new Promise((resolve, reject) => {
      const p = new SerialPort({ path: c.port, baudRate: 19200, autoOpen: false });
      p.open((err) => (err ? reject(new Error('Can\'t open ' + c.port + ': ' + err.message)) : resolve(p)));
    });
    this.write = (b) => this.io.write(b);
    this.io.on('data', (d) => this.onData(d));
    this.io.on('close', () => { this.closed = true; });
    this.io.on('error', (e) => this.log('trotec link error: ' + e.message));
  }

  onData(d) {
    this.rx = Buffer.concat([this.rx, d]);
    if (this.waiter) this.waiter();
  }

  // resolves when test(rx) returns something, or rejects after ms
  waitFor(test, ms) {
    return new Promise((resolve, reject) => {
      const check = () => {
        const r = test();
        if (r) { clearTimeout(t); this.waiter = null; resolve(r); }
      };
      const t = setTimeout(() => { this.waiter = null; reject(new Error('timeout')); }, ms);
      this.waiter = check;
      check();
    });
  }

  async textQuery(cmd, re, ms = 1500) {
    this.rx = Buffer.alloc(0);
    this.write(Buffer.from(cmd, 'latin1'));
    const m = await this.waitFor(() => re.exec(this.rx.toString('latin1')), ms);
    return m;
  }

  async connect() {
    await this.open();
    // after an interrupted session the first query may go unanswered: wake it up and retry once
    this.write(Buffer.from('\r\n\r\n'));
    await sleep(500);
    let model;
    try { model = await this.textQuery('pg0\r', /Parameter #0:\s*(\d+)/); } catch (e) {
      this.write(Buffer.from('\r\n\r\n'));
      await sleep(500);
      model = await this.textQuery('pg0\r', /Parameter #0:\s*(\d+)/).catch(() => { throw new Error('The laser didn\'t answer. Is it on, and is Ruby/JobDispatcher closed?'); });
    }
    const cpu = await this.textQuery('pg250\r', /Parameter #250:\s*([\d.]+)/).catch(() => null);
    const conn = await this.textQuery('\n\n\nTX;', /(\d\d\.\d\d-\d\d\.\d\d-\d\d\.\d\d)/, 3000);
    if (this.cfg.connection.mode !== 'tcp' && this.io.update) await new Promise((r) => this.io.update({ baudRate: 460800 }, () => r()));
    this.rx = Buffer.alloc(0);
    this.binary = true;
    this.id = 0;
    this.info = { model: 'Trotec model ' + model[1], firmware: conn[1] + (cpu ? ' · CPU ' + cpu[1] : '') };
    this.log('trotec connected: ' + this.info.model + ', ' + this.info.firmware);
    return this.info;
  }

  async close() {
    this.closed = true;
    if (!this.io) return;
    await new Promise((r) => { try { if (this.io.close) this.io.close(() => r()); else { this.io.end(); r(); } } catch (e) { r(); } });
  }

  // ------------------------------------------------------------ packets
  // One packet out, its reply back. Serialised: callers queue behind each other.
  exchange(imm, data) {
    const run = this.chain.then(() => this.exchangeNow(imm, data));
    this.chain = run.catch(() => {});
    return run;
  }

  async exchangeNow(imm, data) {
    if (this.closed) throw new Error('Laser disconnected');
    const id = this.id;
    let timeouts = 0;
    let crcErrors = 0;
    for (;;) {
      this.write(packet(id, imm, data));
      let got;
      try {
        got = await this.waitFor(() => {
          for (;;) {
            const t = takePacket(this.rx);
            if (!t) return null;
            this.rx = Buffer.from(t.rest);
            if (t.packet.id === id) return t.packet;
          }
        }, REPLY_MS);
      } catch (e) {
        if (++timeouts > 3) throw new Error('No reply from the laser');
        continue;
      }
      if (got.kind === 'ok') {
        this.id = (id + 1) & 0xff;
        const r = parseReply(got);
        if (r.text) this.log('trotec: ' + r.text.trim().replace(/\s*\r?\n\s*/g, ' | '));
        return r;
      }
      // buffer full is normal while a long job runs: the job stream is far ahead of the
      // machine. Keep offering the packet until there is room, unless we're stopping.
      if (got.kind === 'bufferFull') {
        if (this.aborting && data && data.length) throw new Error('aborted');
        await sleep(200);
        // pause/resume can't wait for buffer room: send them in between, with this id
        if (this.urgent.length) {
          const u = this.urgent.shift();
          try { u.resolve(await this.exchangeNow(u.imm)); } catch (e) { u.reject(e); }
          return this.exchangeNow(imm, data);
        }
        continue;
      }
      if (got.kind === 'invalidCrc' && ++crcErrors <= 5) continue;
      throw new Error('Laser refused the packet (' + got.kind + ')');
    }
  }

  view(r) {
    const s = r.status || {};
    const pos = r.xy ? this.U.toMm(r.xy[0], r.xy[1]) : [NaN, NaN];
    const state = s.name === 'busy' ? 'busy' : s.name === 'pause' || s.name === 'hardwarePause' ? 'paused' : s.name === 'service' ? 'alarm' : 'idle';
    return { state, pos: { x: +pos[0].toFixed(3), y: +pos[1].toFixed(3), z: 0 }, interlock: !!s.interlock, marker: r.marker, raw: s.raw };
  }

  async poll() { return this.view(await this.exchange(POLL)); }

  // data-lane commands, packed into packets on command boundaries
  async sendCmds(cmds, ctl = {}) {
    let chunk = [];
    let size = 0;
    const flush = async () => {
      if (!chunk.length) return;
      const r = await this.exchange(POLL, Buffer.concat(chunk));
      chunk = []; size = 0;
      if (ctl.onReply) ctl.onReply(this.view(r));
    };
    for (const c of cmds) {
      if (ctl.aborted) return;
      if (size + c.length > MAX_DATA) await flush();
      chunk.push(c); size += c.length;
    }
    if (!ctl.aborted) await flush();
  }

  send(seg, ctl) { return this.sendCmds(seg.cmds, ctl); }

  async moveTo(x, y) {
    await this.sendCmds([
      TT.definePowerLevels([0]), TT.selectPowerLevel(0), TT.commit(),
      TT.setParam32(KEY.CutVelocity, this.U.v(this.S.travel)), TT.commit(),
      TT.moveXY(this.U.x(x), this.U.y(y)), TT.commit()
    ]);
  }

  // Ruby's "return home" is an absolute move to machine 0,0
  async home() {
    await this.sendCmds([TT.definePowerLevels([0]), TT.selectPowerLevel(0), TT.commit(), TT.setParam32(KEY.CutVelocity, this.U.v(this.S.travel)), TT.commit(), TT.moveXY(0, 0), TT.commit()]);
  }

  async setIo(name, on) {
    if (name !== 'air') throw Object.assign(new Error('This laser has no ' + name + ' output'), { code: 409 });
    await this.exchange(Buffer.from([on ? IM.SETOUTPUT : IM.RESOUTPUT, this.S.airOut]));
  }

  // goes straight in while a data packet waits for buffer room, otherwise in turn
  immediate(imm) {
    const p = new Promise((resolve, reject) => {
      const u = { imm, resolve, reject };
      this.urgent.push(u);
      this.chain = this.chain.then(async () => {
        const i = this.urgent.indexOf(u);
        if (i < 0) return;
        this.urgent.splice(i, 1);
        try { resolve(await this.exchangeNow(imm)); } catch (e) { reject(e); }
      }).catch(() => {});
    });
    return p;
  }

  async pause() { await this.immediate(Buffer.from([IM.PAUSE])); }
  async resume() { await this.immediate(Buffer.from([IM.CONTINUE])); }
  async abort() {
    this.aborting = true; // lets a data packet waiting for buffer room give up first
    try { await this.exchange(Buffer.from([IM.ABORT])); } finally { this.aborting = false; }
  }
}

module.exports = TrotecLink;

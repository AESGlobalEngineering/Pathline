// Talks to a Ruida controller over UDP: we send from port 40200 to the
// controller's port 50200. Each packet is a 16-bit big-endian checksum (sum of
// the swizzled bytes) followed by swizzled command bytes, cut on command
// boundaries. The controller answers every packet with one swizzled byte:
// 0xCC accepted, 0xCF checksum error (resend). Query answers (DA 01 …) arrive
// as separate packets after the ACK.
'use strict';

const dgram = require('dgram');
const { swizzle, unswizzle, swizzleByte, commands, dec, RD, MEM } = require('./rd');
const { settings, mapper } = require('./compile');
const MODELS = require('./models');

// which swizzle magic turns 0xCC (ACK) into this byte?
function magicFromAck(b) {
  for (let m = 0; m < 256; m++) if (swizzleByte(0xcc, m) === b) return m;
  return null;
}

const PORT_OUT = 50200;
const PORT_IN = 40200;
const MAX_PACKET = 1000;
const ACK_MS = 4000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class RuidaLink {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log || (() => {});
    this.S = settings(cfg);
    this.M = mapper(this.S);
    this.magic = this.S.magic;
    this.ACK = swizzleByte(0xcc, this.magic);
    this.NAK = swizzleByte(0xcf, this.magic);
    this.chain = Promise.resolve();
    this.pending = null;   // waiting for an ACK
    this.answers = [];     // waiting for DA 01 replies
    this.supports = { air: false, pointer: false };
  }

  async connect() {
    this.host = this.cfg.connection.ip;
    if (!this.host) throw new Error('Set the controller\'s IP address in Setup');
    this.sock = dgram.createSocket('udp4');
    this.sock.on('message', (m) => this.onMessage(m));
    this.sock.on('error', (e) => this.log('ruida link error: ' + e.message));
    await new Promise((resolve) => {
      this.sock.once('error', () => this.sock.bind(0, resolve)); // 40200 taken (e.g. LightBurn running): any port
      this.sock.bind(PORT_IN, resolve);
    });
    const id = await this.query(MEM.cardId).catch(() => { throw new Error('No answer from the Ruida controller at ' + this.host); });
    const model = MODELS.byId((this.cfg.ruida || {}).model);
    this.info = {
      model: 'Ruida card ' + id.toString(16).toUpperCase() + (model.id !== 'OTHER' ? ' · set up as ' + model.label : ''),
      firmware: 'swizzle magic 0x' + this.magic.toString(16) + (this.magicFixed ? ' (detected)' : ''),
      cardId: id, magic: this.magic
    };
    this.log('ruida connected: card ' + id.toString(16) + ', magic 0x' + this.magic.toString(16));
    return this.info;
  }

  async close() { try { this.sock.close(); } catch (e) { /* already closed */ } }

  onMessage(m) {
    if (m.length === 1) {
      if (this.pending) this.pending(m[0]);
      return;
    }
    const d = unswizzle(m, this.magic);
    if (d[0] === 0xda && d[1] === 0x01 && d.length >= 9) {
      const addr = (d[2] << 8) | d[3];
      const value = dec(d.subarray(4, 9));
      const i = this.answers.findIndex((a) => a.addr === addr);
      if (i >= 0) this.answers.splice(i, 1)[0].resolve(value);
    }
  }

  serial(fn) {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => {});
    return run;
  }

  // one UDP packet, waits for its ACK (resends on NAK or timeout)
  async packetNow(raw) {
    const sw = swizzle(raw, this.magic);
    let sum = 0;
    for (const b of sw) sum += b;
    const pkt = Buffer.concat([Buffer.from([(sum >> 8) & 0xff, sum & 0xff]), sw]);
    for (let attempt = 0; attempt < 3; attempt++) {
      const ack = new Promise((resolve) => {
        const t = setTimeout(() => { this.pending = null; resolve(null); }, ACK_MS);
        this.pending = (b) => { clearTimeout(t); this.pending = null; resolve(b); };
      });
      this.sock.send(pkt, PORT_OUT, this.host);
      const b = await ack;
      if (b === this.ACK) return;
      if (b === null && attempt === 2) throw new Error('No answer from the Ruida controller');
      // The ACK (0xCC) comes back scrambled with the controller's own magic. Anything other
      // than our ACK/NAK means a different magic: work it out and send again with it.
      if (b !== null && b !== this.NAK && !this.magicFixed) {
        const m = magicFromAck(b);
        if (m !== null && m !== this.magic) {
          this.log('ruida: the controller uses swizzle magic 0x' + m.toString(16) + ' (set 0x' + this.magic.toString(16) + '): switching');
          this.setMagic(m);
          this.magicFixed = true;
          return this.packetNow(raw);
        }
      }
    }
    throw new Error('The Ruida controller rejected the data (checksum)');
  }

  setMagic(m) {
    this.magic = m;
    this.ACK = swizzleByte(0xcc, m);
    this.NAK = swizzleByte(0xcf, m);
  }

  // splits raw commands into packets on command boundaries
  async sendRaw(raw, ctl = {}) {
    const cmds = commands(raw);
    let chunk = [];
    let size = 0;
    for (const c of cmds) {
      if (ctl.aborted) return;
      if (size + c.length > MAX_PACKET && chunk.length) {
        const b = Buffer.concat(chunk);
        await this.serial(() => this.packetNow(b));
        chunk = []; size = 0;
      }
      chunk.push(c); size += c.length;
    }
    if (chunk.length && !ctl.aborted) {
      const b = Buffer.concat(chunk);
      await this.serial(() => this.packetNow(b));
    }
  }

  query(addr) {
    return this.serial(async () => {
      const answer = new Promise((resolve, reject) => {
        const a = { addr, resolve };
        this.answers.push(a);
        a.start = () => setTimeout(() => { const i = this.answers.indexOf(a); if (i >= 0) { this.answers.splice(i, 1); reject(new Error('No answer')); } }, 1500);
      });
      try {
        await this.packetNow(Buffer.from(RD.getSetting(addr)));
      } catch (e) {
        this.answers = this.answers.filter((x) => x.addr !== addr);
        throw e;
      }
      // the answer packet follows the ACK; give it 1.5 s from here
      const a = this.answers.find((x) => x.addr === addr);
      if (a) a.start();
      return answer;
    });
  }

  async poll() {
    const st = await this.query(MEM.status);
    const x = await this.query(MEM.x);
    const y = await this.query(MEM.y);
    const [mx, my] = this.M.toMm(x, y);
    // status bits (MeerK40t): 0x01000000 moving, 0x01 job running
    const busy = !!(st & 0x01000000) || !!(st & 0x01);
    return { state: busy ? 'busy' : 'idle', pos: { x: +mx.toFixed(3), y: +my.toFixed(3), z: 0 }, interlock: false, raw: st.toString(16) };
  }

  send(seg, ctl) { return this.sendRaw(seg.data, ctl); }
  moveTo(x, y, o = {}) { return this.sendRaw(Buffer.from(RD.rapidXY(this.M.x(x), this.M.y(y), o.light))); }
  home() { return this.sendRaw(Buffer.from(RD.homeXY())); }

  // plotter conveyor on the U axis: where it is (mm), and advance it by hand
  async readU() { return (await this.query(MEM.u)) / 1000; }

  // The controller's own settings (read only), for Setup → Read from controller.
  // Addresses from the EduTech wiki (two 7-bit bytes); lengths in µm, speeds in µm/s.
  async readSettings() {
    const ADDR = {
      rangeX: 0x0026, rangeY: 0x0036, rangeU: 0x0056,
      maxVelX: 0x0023, maxVelY: 0x0033, maxVelU: 0x0053,
      maxAccX: 0x0025, maxAccY: 0x0035,
      g0Vel: 0x0005, uWorkVel: 0x022d,
      out1Min: 0x0012, out1Max: 0x0013, out2Min: 0x0018, out2Max: 0x0019,
      out3Min: 0x0063, out3Max: 0x0064, out4Min: 0x0068, out4Max: 0x0069,
      machineType: 0x0060, mainboard: 0x057f, cardId: MEM.cardId
    };
    const raw = {};
    for (const [k, a] of Object.entries(ADDR)) {
      try { raw[k] = await this.query(a); } catch (e) { raw[k] = null; }
    }
    return raw;
  }
  async feed(mm) {
    const u = await this.readU();
    await this.sendRaw(Buffer.from(RD.rapidU(Math.round((u + mm) * 1000))));
  }
  async setIo(name) { throw Object.assign(new Error('Ruida switches ' + name + ' from the job, not by hand'), { code: 409 }); }
  pause() { return this.sendRaw(Buffer.from(RD.pause())); }
  resume() { return this.sendRaw(Buffer.from(RD.resume())); }
  async abort() { await this.sendRaw(Buffer.from(RD.stop())); await sleep(50); }
}

module.exports = RuidaLink;

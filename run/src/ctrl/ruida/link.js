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
const { cardText } = require('./readback');

// which swizzle magic turns 0xCC (ACK) into this byte?
function magicFromAck(b) {
  for (let m = 0; m < 256; m++) if (swizzleByte(0xcc, m) === b) return m;
  return null;
}

const PORT_OUT = 50200;
// (the self-test uses another port, so it runs while Pathline Run is connected to a machine)
const PORT_IN = Number(process.env.PATHLINE_RUN_RUIDA_PORT_IN) || 40200;
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
    this.names = [];       // waiting for E8 01 replies (file names)
    this.supports = { air: false, pointer: false };
  }

  async connect() {
    this.host = this.cfg.connection.ip;
    if (!this.host) throw new Error('Set the controller\'s IP address in Setup');
    this.sock = dgram.createSocket('udp4');
    this.sock.on('message', (m) => this.onMessage(m));
    this.sock.on('error', (e) => this.log('ruida link error: ' + e.message));
    // Ruida controllers answer to port 40200 only (seen on an RDD6584), whatever port we send
    // from, so we must have that port: no falling back to another one
    await new Promise((resolve, reject) => {
      this.sock.once('error', (e) => reject(new Error(e.code === 'EADDRINUSE'
        ? 'UDP port ' + PORT_IN + ' is in use by another program (LightBurn, RDWorks or RDCutting?). Close it, then Reconnect.'
        : 'Can\'t open UDP port ' + PORT_IN + ': ' + e.message)));
      this.sock.bind(PORT_IN, resolve);
    });
    const id = await this.query(MEM.cardId).catch(() => { throw new Error('No answer from the Ruida controller at ' + this.host); });
    const model = MODELS.byId((this.cfg.ruida || {}).model);
    // knife controllers (RDD6584, card 0x69xx) move BY the D9 value, not TO it (see moveTo)
    this.relMoves = /^RDD/.test(model.id) || ((id & 0xff00) === 0x6900);
    this.cmd = null;
    this.info = {
      model: 'Ruida card ' + cardText(id) + (model.id !== 'OTHER' ? ' · set up as ' + model.label : ''),
      firmware: 'swizzle magic 0x' + this.magic.toString(16) + (this.magicFixed ? ' (detected)' : ''),
      cardId: id, magic: this.magic
    };
    this.log('ruida connected: card ' + id.toString(16) + ', magic 0x' + this.magic.toString(16));
    return this.info;
  }

  async close() {
    if (!this.sock) return;
    await new Promise((r) => { try { this.sock.close(r); } catch (e) { r(); } });
    this.sock = null;
  }

  onMessage(m) {
    if (m.length === 1) {
      if (this.pending) this.pending(m[0]);
      return;
    }
    const d = unswizzle(m, this.magic);
    // E8 01 n → the name of file n in the controller's memory
    if (d[0] === 0xe8 && d[1] === 0x01 && d.length >= 4) {
      const n = (d[2] << 7) | d[3];
      const end = d.indexOf(0, 4);
      const i = this.names.findIndex((a) => a.n === n);
      if (i >= 0) this.names.splice(i, 1)[0].resolve(d.subarray(4, end < 0 ? d.length : end).toString('latin1'));
      return;
    }
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
    // mpos: the controller's own coordinates, as its panel shows them (for the X/Y readouts)
    return { state: busy ? 'busy' : 'idle', pos: { x: +mx.toFixed(3), y: +my.toFixed(3), z: 0 }, mpos: { x: x / 1000, y: y / 1000 }, interlock: false, raw: st.toString(16) };
  }

  send(seg, ctl) { return seg.kind === 'file' ? this.runFile(seg.data, ctl) : this.sendRaw(seg.data, ctl); }

  // name of file n in the controller's memory (E8 01 n)
  fileName(n) {
    return this.serial(async () => {
      const answer = new Promise((resolve, reject) => {
        const a = { n, resolve };
        this.names.push(a);
        setTimeout(() => { const i = this.names.indexOf(a); if (i >= 0) { this.names.splice(i, 1); reject(new Error('No answer')); } }, 4000);
      });
      await this.packetNow(Buffer.from([0xe8, 0x01, (n >> 7) & 0x7f, n & 0x7f]));
      return answer;
    });
  }

  // RDD6584 knife job (knife.js): as VCutWorks does it, replace the file called START in the
  // controller's memory with this one, then start it. Only a file named exactly START is
  // ever deleted: the operator's own stored files are left alone.
  async runFile(body, ctl = {}) {
    const NAME = 'START';
    const idx = (n) => [(n >> 7) & 0x7f, n & 0x7f];
    await this.sendRaw(Buffer.from([0xd8, 0x6b]));
    await this.sendRaw(Buffer.from([0xd8, 0x6a]));
    const count = await this.query(MEM.files);
    for (let n = count; n >= 1; n--) {
      if ((await this.fileName(n)) !== NAME) continue;
      await this.sendRaw(Buffer.from([0xe8, 0x00, ...idx(n), ...idx(n)]));
      this.log('ruida: replaced file ' + n + ' (' + NAME + ')');
      break;
    }
    if (ctl.aborted) return;
    await this.sendRaw(Buffer.from([0xe8, 0x02, 0xe7, 0x01, ...Buffer.from(NAME + '\0', 'latin1')]));
    await this.sendRaw(body, ctl);
    await this.sendRaw(Buffer.from([0xe7, 0x00, 0xda, 0x01, 0x06, 0x20, ...new Array(10).fill(0), 0xd7]));
    // it's the last file now: check its name before starting it
    const n = await this.query(MEM.files);
    if ((await this.fileName(n)) !== NAME) throw new Error('The job didn\'t arrive in the controller\'s memory (file ' + n + ' isn\'t ' + NAME + ')');
    if (ctl.aborted) return;
    await this.sendRaw(Buffer.from([0xe8, 0x03, ...idx(n)]));
  }
  // Moves by hand go one axis at a time (D9 00 / D9 01): the two-axis D9 10 isn't the same
  // command on every controller (see rd.js). o.axis: only that axis moves (jogging).
  async moveTo(x, y, o = {}) {
    const to = { x: this.M.x(x), y: this.M.y(y) }; // controller µm
    const axes = o.axis ? [o.axis] : ['x', 'y'];
    for (const [i, a] of axes.entries()) {
      if (i > 0) await this.waitStill();
      if (!this.relMoves) { await this.sendRaw(Buffer.from(a === 'x' ? RD.rapidX(to.x, o.light) : RD.rapidY(to.y, o.light))); continue; }
      // RDD6584: speed, then the distance from where the head is (or is already going)
      const from = await this.movingFrom(a);
      const d = Math.round(to[a] - from);
      if (Math.abs(d) < 1) continue;
      const mm = Math.max(1, Math.min(this.cfg.speed || 200, o.speed || 100));
      await this.sendRaw(Buffer.from([...RD.speed(mm), ...(a === 'x' ? RD.rapidX(d, o.light) : RD.rapidY(d, o.light))]));
      this.cmd = { ...(this.cmd || {}), [a]: to[a], at: Date.now() };
    }
  }

  // Where a relative move starts from (controller µm): the target of the move still under
  // way (a new move adds to it), else where the controller says the head is.
  async movingFrom(a) {
    const st = await this.query(MEM.status).catch(() => 0);
    if (this.cmd && this.cmd[a] !== undefined && (st & 0x01000000)) return this.cmd[a];
    if (this.cmd) delete this.cmd[a];
    return this.query(a === 'x' ? MEM.x : MEM.y);
  }

  // until the controller says it isn't moving (it may not answer while it moves)
  async waitStill(ms = 60000) {
    const t0 = Date.now();
    await sleep(100);
    while (Date.now() - t0 < ms) {
      try { if (!(await this.query(MEM.status) & 0x01000000)) return; } catch (e) { /* busy: ask again */ }
      await sleep(100);
    }
  }
  home() { return this.sendRaw(Buffer.from(RD.homeXY())); }
  // a held jog arrow: one long move, stopped on release (RDD6584: every move slows to a
  // stop at its end, so short steps one after another judder)
  get continuousJog() { return !!this.relMoves; }
  // a jog arrow let go: every move is a rapid at the controller's own travel speed, which it
  // would otherwise finish, so stop it where it is
  stopMove() { return this.sendRaw(Buffer.from(RD.stop())); }

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
    // RDD6584: the controller feeds itself (clamp, pull along Y, release) after a job with a
    // feed in it, so the button runs a job with no cuts and that feed
    if (this.relMoves) return this.runFile(require('./knife').feedFile(mm, { card: this.info.cardId & 0xffff }));
    const u = await this.readU();
    await this.sendRaw(Buffer.from(RD.rapidU(Math.round((u + mm) * 1000))));
  }
  async setIo(name) { throw Object.assign(new Error('Ruida switches ' + name + ' from the job, not by hand'), { code: 409 }); }
  pause() { return this.sendRaw(Buffer.from(RD.pause())); }
  resume() { return this.sendRaw(Buffer.from(RD.resume())); }
  async abort() { await this.sendRaw(Buffer.from(RD.stop())); await sleep(50); }
}

// Setup → Find on network: ask every network this computer is on "which Ruida is there?"
// (a card ID query, broadcast). Any controller ACKs, and its ACK byte gives away its swizzle
// magic, whatever magic the question was sent with. Then each one is asked its card ID.
// Needs UDP port 40200 free (the caller closes the machine's link first).
// targets: addresses to ask instead of the networks' broadcast addresses (the self-test uses it)
async function find(log, targets) {
  const os = require('os');
  const sock = dgram.createSocket('udp4');
  await new Promise((resolve, reject) => {
    sock.once('error', (e) => reject(new Error(e.code === 'EADDRINUSE' ? 'UDP port ' + PORT_IN + ' is in use by another program (LightBurn, RDWorks or RDCutting?)' : e.message)));
    sock.bind(PORT_IN, resolve);
  });
  sock.setBroadcast(true);
  const found = new Map(); // ip → { ip, magic, cardId, via }
  const nets = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = a.address.split('.').map(Number), mask = a.netmask.split('.').map(Number);
      nets.push({ name, address: a.address, broadcast: ip.map((o, i) => (o | (~mask[i] & 255))).join('.') });
    }
  }
  const viaFor = (ip) => {
    const n = nets.find((x) => x.broadcast.split('.').slice(0, 3).join('.') === ip.split('.').slice(0, 3).join('.'));
    return n ? n.name + ' (' + n.address + ')' : '';
  };
  sock.on('message', (m, r) => {
    const f = found.get(r.address) || { ip: r.address, magic: null, cardId: null, via: viaFor(r.address) };
    if (m.length === 1 && f.magic === null) f.magic = magicFromAck(m[0]);
    else if (m.length > 1 && f.magic !== null) {
      const d = unswizzle(m, f.magic);
      if (d.length >= 9 && d[0] === 0xda && d[1] === 0x01 && ((d[2] << 8) | d[3]) === MEM.cardId) f.cardId = dec(d.subarray(4, 9));
    }
    found.set(r.address, f);
  });
  const ask = (ip, magic) => {
    const sw = swizzle(Buffer.from(RD.getSetting(MEM.cardId)), magic);
    let sum = 0;
    for (const b of sw) sum += b;
    sock.send(Buffer.concat([Buffer.from([(sum >> 8) & 0xff, sum & 0xff]), sw]), PORT_OUT, ip);
  };
  for (const ip of targets || [...nets.map((n) => n.broadcast), '255.255.255.255']) ask(ip, 0x88);
  await sleep(1500);
  // now ask each one again in its own magic, for its card ID
  for (const f of found.values()) if (f.magic !== null) ask(f.ip, f.magic);
  await sleep(1000);
  await new Promise((r) => sock.close(r));
  const list = [...found.values()].filter((f) => f.magic !== null).map((f) => ({ ...f, card: f.cardId !== null ? cardText(f.cardId) : '' }));
  if (log) log('find: ' + (list.length ? list.map((f) => f.ip + ' (magic 0x' + f.magic.toString(16) + (f.card ? ', card ' + f.card : '') + ')').join(', ') : 'no Ruida controller answered'));
  return list;
}

module.exports = RuidaLink;
module.exports.find = find;

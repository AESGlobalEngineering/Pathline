// Trotec "SF" packet protocol (classic Electronics2000/2015 controllers).
// Reference: TROTEC_PROTOCOL.md (decompiled Ruby JobDispatcher + captures on a Q500).
// Integers are big-endian. Two lanes per packet: the immediate section
// (IMCMD_*, executed now, answered in the reply) and the data section
// (TTCMD_*, the queued job stream, executed on COMMIT).
'use strict';

// CRC-16/ARC: reflected poly 0xA001, init 0, no final XOR. "123456789" → 0xBB3D.
const CRC_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc16(buf, start = 0, end = buf.length) {
  let c = 0;
  for (let i = start; i < end; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return c;
}

const TYPE = { 0x00: 'client', 0x80: 'ok', 0x90: 'bufferFull', 0xa0: 'invalidId', 0xb0: 'invalidCrc', 0xc0: 'tooLarge' };

// header: "SF" id type immLen dataLen(u16) crc(u16), then each non-empty section followed by its CRC
function packet(id, imm, data, type) {
  imm = imm || Buffer.alloc(0);
  data = data || Buffer.alloc(0);
  if (imm.length > 255) throw new Error('Immediate section too long');
  if (data.length > 0xffff) throw new Error('Data section too long');
  const parts = [];
  const h = Buffer.from([0x53, 0x46, id & 0xff, type || 0x00, imm.length, data.length >> 8, data.length & 0xff, 0, 0]);
  h.writeUInt16BE(crc16(h, 0, 7), 7);
  parts.push(h);
  for (const sec of [imm, data]) {
    if (!sec.length) continue;
    const c = Buffer.alloc(2);
    c.writeUInt16BE(crc16(sec));
    parts.push(sec, c);
  }
  return Buffer.concat(parts);
}

// Finds one complete packet at the start of `buf` (skipping junk before "SF").
// Returns { packet, rest } or null when more bytes are needed.
function takePacket(buf) {
  let i = buf.indexOf('SF');
  while (i >= 0) {
    if (buf.length - i < 9) return null;
    if (crc16(buf, i, i + 7) !== buf.readUInt16BE(i + 7)) { i = buf.indexOf('SF', i + 1); continue; }
    const imm = buf[i + 4];
    const dl = buf.readUInt16BE(i + 5);
    const total = 9 + imm + (imm ? 2 : 0) + dl + (dl ? 2 : 0);
    if (buf.length - i < total) return null;
    let o = i + 9;
    const immB = buf.subarray(o, o + imm);
    o += imm + (imm ? 2 : 0);
    const dataB = buf.subarray(o, o + dl);
    return { packet: { id: buf[i + 2], type: buf[i + 3], kind: TYPE[buf[i + 3]] || 'unknown', imm: Buffer.from(immB), data: Buffer.from(dataB) }, rest: buf.subarray(i + total) };
  }
  return null;
}

// ---------------------------------------------------------------- immediate lane
const IM = {
  NOP: 0x00, ABORT: 0x02, PAUSE: 0x04, CONTINUE: 0x06, SETOUTPUT: 0x0a, RESOUTPUT: 0x0c,
  GETSTATUS: 0x10, GETXYPOSITION: 0x2c, GETZPOSITION: 0x2e, GET_PROGRESS_MARKER: 0xa4, GET_TEMPERATURE: 0xf2
};
// payload bytes after each IMANS_* opcode in a reply (unknown → stop parsing)
const ANS_SIZE = {
  0x01: 0, 0x03: 0, 0x05: 0, 0x07: 0, 0x09: 0, 0x0b: 0, 0x0d: 0, 0x0f: 2, 0x11: 4, 0x13: 2, 0x15: 3, 0x17: 0,
  0x1b: 0, 0x1d: 0, 0x1f: 0, 0x21: 9, 0x2d: 8, 0x2f: 4, 0x31: 4, 0x43: 0, 0x45: 0, 0x47: 0, 0x49: 0, 0x4b: 10,
  0x4d: 0, 0x4f: 0, 0x51: 0, 0x53: 0, 0x86: 0, 0x88: 10, 0x9f: 0, 0xa1: 0, 0xa5: 2, 0xab: 5, 0xad: 0, 0xaf: 0,
  0xd2: 0, 0xd4: 0, 0xd6: 0, 0xe1: 0, 0xe3: 2, 0xe5: 2, 0xe7: 0, 0xe9: 0, 0xeb: 0, 0xec: 0, 0xf1: 2, 0xf3: 2,
  0xf5: 4, 0xf7: 4, 0xfb: 0, 0xfd: 0, 0xff: 17
};
const DEVICE_STATUS = { 0: 'abort', 1: 'pause', 2: 'standby', 3: 'idle', 4: 'busy', 5: 'service', 6: 'hardwarePause' };

// Walks the immediate section of a reply opcode by opcode.
function parseReply(p) {
  const out = { events: [] };
  const b = p.imm;
  let o = 0;
  while (o < b.length) {
    const op = b[o++];
    const n = ANS_SIZE[op];
    if (n === undefined || o + n > b.length) { out.unparsed = b.subarray(o - 1); break; }
    const v = b.subarray(o, o + n);
    o += n;
    if (op === 0x11) {
      out.status = { code: v[0], name: DEVICE_STATUS[v[0]] || 'unknown', safety: v[1], raw: v.toString('hex') };
      // byte 1 = safety circuits, 0xFF all OK; the lid clears bits in the low nibble
      out.status.interlock = (v[1] & 0x0f) !== 0x0f;
    } else if (op === 0x2d) out.xy = [v.readInt32BE(0), v.readInt32BE(4)];
    else if (op === 0x2f) out.z = v.readInt32BE(0);
    else if (op === 0xa5) out.marker = v.readUInt16BE(0);
    else if (op === 0xf3) out.temperature = v.readInt16BE(0);
    else if (op === 0xad || op === 0xa1 || op === 0x43 || op === 0xe3 || op === 0xe5) out.events.push(op);
  }
  // the device pushes its console log in the data section as DOWNLOADPACKET (BE + u32 len + text)
  if (p.data.length > 5 && p.data[0] === 0xbe) {
    const n = Math.min(p.data.readUInt32BE(1), p.data.length - 5);
    out.text = p.data.subarray(5, 5 + n).toString('latin1');
  }
  return out;
}

// ---------------------------------------------------------------- data lane (TTCMD_*)
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v & 0xffff); return b; };
const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32BE(v | 0); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };
const f64 = (v) => { const b = Buffer.alloc(8); b.writeDoubleBE(v); return b; };
const cmd = (op, ...parts) => Buffer.concat([Buffer.from([op]), ...parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p)))]);

// FRAM parameter keys used in jobs
const KEY = {
  CameraActive: 186, AccelX: 197, AccelY: 200, AccelXY: 207, LaserSource: 223,
  PowerCorrection: 216, CutVelocity: 218, RasterVelocity: 221,
  MaxCentrifugalAccArc: 256, MaxCentrifugalAccBezier: 257, MaxCentrifugalAccVector: 258, MaxChordError: 259,
  KappaThreshold: 260, MaxTangentialAcc: 261, MaxTangentialJerk: 262, MaxVectorInterpolationError: 263
};

const TT = {
  commit: () => cmd(0x86),
  setOutput: (n) => cmd(0x0a, [n]),
  clrOutput: (n) => cmd(0x0c, [n]),
  setParam8: (k, v) => cmd(0x1e, [k, v & 0xff]),
  setParam16: (k, v) => cmd(0x1c, [k], u16(v)),
  setParam32: (k, v) => cmd(0x1a, [k], u32(v)),
  setParam64: (k, v) => cmd(0xd8, u16(k), f64(v)),
  // power levels in % → centi-percent; level 0 must be 0 %
  definePowerLevels: (levels) => cmd(0x44, [levels.length], ...levels.map((p) => u16(Math.round(p * 100)))),
  selectPowerLevel: (n) => cmd(0x46, [n]),
  frequency: (hz) => cmd(0x80, u16(Math.max(0, Math.min(65535, Math.round(hz))))),
  powerCorrectionOn: () => cmd(0x94),
  moveXY: (x, y) => cmd(0x9e, i32(x), i32(y)),
  moveZ: (z) => cmd(0xa6, i32(z)),
  moveXPlus: (n) => cmd(0x8c, i32(n)),
  moveXMinus: (n) => cmd(0x8a, i32(n)),
  ppiMode: (n) => cmd(0xae, u16(n)),
  favoriteDistances: (list) => cmd(0xac, [list.length], ...list.map(u32)),
  // b/w switch table: alternating off/on run lengths from the start of the move.
  // We always use the 3-byte raw form (bit 23 set, 23-bit length in position units).
  switchTableBW: (runs) => {
    const body = Buffer.alloc(4 + runs.length * 3);
    body.writeUInt32BE(runs.length, 0);
    runs.forEach((r, i) => {
      const v = 0x800000 | Math.max(0, Math.min(0x7fffff, r));
      body[4 + i * 3] = v >> 16; body[5 + i * 3] = (v >> 8) & 0xff; body[6 + i * 3] = v & 0xff;
    });
    return cmd(0xab, u32(body.length), body);
  },
  progressMarker: (n) => cmd(0xd2, u16(n))
};

// ---------------------------------------------------------------- decoding (listings and tests)
const TT_NAMES = {
  0x00: ['NOP', 0], 0x0a: ['SET_OUTPUT', 1], 0x0c: ['CLR_OUTPUT', 1], 0x16: ['SET_ANALOGOUTPUT', 3],
  0x1a: ['SET_PARAMETER32', 5], 0x1c: ['SET_PARAMETER16', 3], 0x1e: ['SET_PARAMETER8', 2],
  0x44: ['DEFINEPOWERLEVELS', 'levels'], 0x46: ['SELECTPOWERLEVEL', 1], 0x80: ['ACTIVATEFREQUENCEMODE', 2],
  0x85: ['SAVE_TO_CONFIG', 0], 0x86: ['COMMIT', 0], 0x8a: ['MOVEX_MINUS', 4], 0x8c: ['MOVEX_PLUS', 4],
  0x8e: ['MOVEY_MINUS', 4], 0x90: ['MOVEY_PLUS', 4], 0x94: ['POWERCORRECTION_ON', 0], 0x96: ['POWERCORRECTION_OFF', 0],
  0x9e: ['MOVEXY', 8], 0x9f: ['EMPTY_MOVEXY', 8], 0xa0: ['RMOVEXY', 8], 0xa6: ['MOVEZ', 4], 0xa8: ['RMOVEZ', 4],
  0xab: ['SWITCHPOINTTABLE_BW', 'u32len'], 0xaa: ['SWITCHPOINTTABLE_GRAY', 'u32len'], 0xac: ['FAVORITDISTANCES', 'fav'],
  0xae: ['ACTIVATEPPIMODE', 2], 0xb8: ['WAIT', 2], 0xd2: ['SET_PROGRESS_MARKER', 2], 0xd3: ['SOFTWARE_FEATURES', 4],
  0xd8: ['SET_NEW_PARAMETER64', 10]
};

function decodeData(buf) {
  const out = [];
  let o = 0;
  while (o < buf.length) {
    const op = buf[o];
    const def = TT_NAMES[op];
    if (!def) { out.push({ op, name: '??', hex: buf.subarray(o).toString('hex') }); break; }
    let n = def[1];
    if (n === 'levels') n = 1 + buf[o + 1] * 2;
    else if (n === 'u32len') n = 4 + buf.readUInt32BE(o + 1);
    else if (n === 'fav') n = 1 + buf[o + 1] * 4;
    const a = buf.subarray(o + 1, o + 1 + n);
    const c = { op, name: def[0], args: a };
    if (op === 0x9e || op === 0x9f || op === 0xa0) c.v = [a.readInt32BE(0), a.readInt32BE(4)];
    else if (op === 0x8a || op === 0x8c || op === 0xa6) c.v = [a.readInt32BE(0)];
    else if (op === 0x1a) c.v = [a[0], a.readUInt32BE(1)];
    else if (op === 0x1c) c.v = [a[0], a.readUInt16BE(1)];
    else if (op === 0x1e) c.v = [a[0], a[1]];
    else if (op === 0xd8) c.v = [a.readUInt16BE(0), a.readDoubleBE(2)];
    else if (op === 0x44) c.v = Array.from({ length: a[0] }, (_, i) => a.readUInt16BE(1 + i * 2) / 100);
    else if (op === 0x46 || op === 0x0a || op === 0x0c) c.v = [a[0]];
    else if (op === 0x80 || op === 0xae || op === 0xd2) c.v = [a.readUInt16BE(0)];
    else if (op === 0xab) {
      const count = a.readUInt32BE(4);
      c.v = [];
      for (let i = 0; i < count; i++) c.v.push(((a[8 + i * 3] << 16) | (a[9 + i * 3] << 8) | a[10 + i * 3]) & 0x7fffff);
    }
    out.push(c);
    o += 1 + n;
  }
  return out;
}

function listing(buf) {
  return decodeData(buf).map((c) => {
    const v = c.v ? ' ' + c.v.map((x) => (typeof x === 'number' && !Number.isInteger(x) ? +x.toFixed(6) : x)).join(', ') : c.args && c.args.length ? ' ' + c.args.toString('hex') : '';
    return c.name + v;
  }).join('\n');
}

module.exports = { crc16, packet, takePacket, parseReply, IM, TT, KEY, decodeData, listing, DEVICE_STATUS };

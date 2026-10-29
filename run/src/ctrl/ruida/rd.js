// Ruida (RDC644x/654x/634x…) command encoding. Public references:
//   https://edutechwiki.unige.ch/en/Ruida (protocol notes, swizzle magic per card)
//   https://github.com/meerk40t/meerk40t/blob/main/meerk40t/ruida/rdjob.py (encoder)
// Opcodes are bytes ≥ 0x80; every argument byte carries 7 bits. The file and
// the UDP payload are the same byte stream, "swizzled" with a per-model magic.
'use strict';

function swizzleByte(b, magic) {
  b ^= (b >> 7) & 0xff;
  b ^= (b << 7) & 0xff;
  b ^= (b >> 7) & 0xff;
  b ^= magic;
  return (b + 1) & 0xff;
}
function unswizzleByte(b, magic) {
  b = (b - 1) & 0xff;
  b ^= magic;
  b ^= (b >> 7) & 0xff;
  b ^= (b << 7) & 0xff;
  b ^= (b >> 7) & 0xff;
  return b;
}
const tables = new Map();
function table(magic) {
  if (!tables.has(magic)) {
    const sw = new Uint8Array(256), un = new Uint8Array(256);
    for (let i = 0; i < 256; i++) { sw[i] = swizzleByte(i, magic); un[sw[i]] = i; }
    tables.set(magic, { sw, un });
  }
  return tables.get(magic);
}
const swizzle = (buf, magic) => { const t = table(magic).sw; return Buffer.from(buf.map((b) => t[b])); };
const unswizzle = (buf, magic) => { const t = table(magic).un; return Buffer.from(buf.map((b) => t[b])); };

// n bytes of 7 bits, most significant first (two's complement for negatives)
function enc(v, n) {
  let x = BigInt(Math.round(v));
  const bits = BigInt(7 * n);
  if (x < 0n) x += 1n << bits;
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(Number((x >> BigInt(7 * i)) & 0x7fn));
  return out;
}
function dec(bytes, signed) {
  let x = 0n;
  for (const b of bytes) x = (x << 7n) | BigInt(b & 0x7f);
  const bits = BigInt(7 * bytes.length);
  if (signed && x >= 1n << (bits - 1n)) x -= 1n << bits;
  return Number(x);
}
const abs = (um) => enc(um, 5);                 // absolute coordinate, µm
const rel = (um) => enc(um, 2);                 // relative coordinate, µm (±8191)
const power = (pct) => enc(Math.round(Math.max(0, Math.min(100, pct)) * 16383 / 100), 2);
const speed = (mmps) => enc(mmps * 1000, 5);    // µm/s
const time = (s) => enc(s * 1e6, 5);            // µs
const color = (rgb) => enc(rgb, 5);             // 0xBBGGRR

const RD = {
  moveAbs: (x, y) => [0x88, ...abs(x), ...abs(y)],
  cutAbs: (x, y) => [0xa8, ...abs(x), ...abs(y)],
  speed: (mmps) => [0xc9, 0x02, ...speed(mmps)],
  partSpeed: (part, mmps) => [0xc9, 0x04, part, ...speed(mmps)],
  minPower1: (p) => [0xc6, 0x01, ...power(p)],
  maxPower1: (p) => [0xc6, 0x02, ...power(p)],
  minPower2: (p) => [0xc6, 0x21, ...power(p)],
  maxPower2: (p) => [0xc6, 0x22, ...power(p)],
  // outputs 3 and 4 (lasers 3/4; on a plotter, tools 3/4)
  minPower3: (p) => [0xc6, 0x05, ...power(p)],
  maxPower3: (p) => [0xc6, 0x06, ...power(p)],
  minPower4: (p) => [0xc6, 0x07, ...power(p)],
  maxPower4: (p) => [0xc6, 0x08, ...power(p)],
  partMinPower3: (part, p) => [0xc6, 0x35, part, ...power(p)],
  partMaxPower3: (part, p) => [0xc6, 0x36, part, ...power(p)],
  partMinPower4: (part, p) => [0xc6, 0x37, part, ...power(p)],
  partMaxPower4: (part, p) => [0xc6, 0x38, part, ...power(p)],
  // U axis (a plotter's conveyor): absolute move in a job, rapid move by hand
  moveU: (u) => [0xa0, 0x08, ...abs(u)],
  rapidU: (u) => [0xd9, 0x03, 0x02, ...abs(u)],
  partMinPower1: (part, p) => [0xc6, 0x31, part, ...power(p)],
  partMaxPower1: (part, p) => [0xc6, 0x32, part, ...power(p)],
  partMinPower2: (part, p) => [0xc6, 0x41, part, ...power(p)],
  partMaxPower2: (part, p) => [0xc6, 0x42, part, ...power(p)],
  laserOnDelay: (s) => [0xc6, 0x12, ...time(s)],
  laserOffDelay: (s) => [0xc6, 0x13, ...time(s)],
  partColor: (part, rgb) => [0xca, 0x06, part, ...color(rgb)],
  partWorkMode: (part, m) => [0xca, 0x41, part, m],
  layerNumber: (part) => [0xca, 0x02, part],
  laserDevice0: () => [0xca, 0x01, 0x10],
  airOff: () => [0xca, 0x01, 0x12],
  airOn: () => [0xca, 0x01, 0x13],
  enLaserTubeStart: () => [0xca, 0x03, 0x01],
  layerEnd: () => [0xe7, 0x00, 0xca, 0x01, 0x00, 0xca, 0x01, 0x30],
  maxLayerPart: (part) => [0xca, 0x22, part],
  // realtime
  start: () => [0xd8, 0x00], stop: () => [0xd8, 0x01], pause: () => [0xd8, 0x02], resume: () => [0xd8, 0x03],
  homeXY: () => [0xd8, 0x2a],
  // rapid move XY; option 0x02 = plain move, 0x03 = with the red light
  rapidXY: (x, y, light) => [0xd9, 0x10, light ? 0x03 : 0x02, ...abs(x), ...abs(y)],
  getSetting: (addr) => [0xda, 0x00, addr >> 8, addr & 0xff]
};
const MEM = { cardId: 0x057e, status: 0x0400, x: 0x0421, y: 0x0431, z: 0x0441, u: 0x0451, bedX: 0x0026, bedY: 0x0036 };

// ---------------------------------------------------------------- decoding (listings and tests)
const NAMES = {
  0x88: 'MOVE_ABS', 0x89: 'MOVE_REL', 0x8a: 'MOVE_REL_X', 0x8b: 'MOVE_REL_Y', 0xa8: 'CUT_ABS', 0xa9: 'CUT_REL', 0xaa: 'CUT_REL_X', 0xab: 'CUT_REL_Y',
  'c9 02': 'SPEED', 'c9 04': 'PART_SPEED', 'c6 01': 'MIN_POWER_1', 'c6 02': 'MAX_POWER_1', 'c6 21': 'MIN_POWER_2', 'c6 22': 'MAX_POWER_2',
  'c6 31': 'PART_MIN_POWER_1', 'c6 32': 'PART_MAX_POWER_1', 'c6 41': 'PART_MIN_POWER_2', 'c6 42': 'PART_MAX_POWER_2',
  'c6 05': 'MIN_POWER_3', 'c6 06': 'MAX_POWER_3', 'c6 07': 'MIN_POWER_4', 'c6 08': 'MAX_POWER_4',
  'c6 35': 'PART_MIN_POWER_3', 'c6 36': 'PART_MAX_POWER_3', 'c6 37': 'PART_MIN_POWER_4', 'c6 38': 'PART_MAX_POWER_4',
  'a0 08': 'MOVE_U', 'd9 03': 'RAPID_U',
  'c6 12': 'LASER_ON_DELAY', 'c6 13': 'LASER_OFF_DELAY', 'ca 06': 'PART_COLOR', 'ca 41': 'PART_WORK_MODE', 'ca 02': 'LAYER_NUMBER',
  'ca 01': 'LAYER_FLAG', 'ca 03': 'EN_LASER_TUBE_START', 'ca 22': 'MAX_LAYER_PART', 'd8 00': 'START_PROCESS', 'd8 01': 'STOP',
  'd8 02': 'PAUSE', 'd8 03': 'RESUME', 'd8 10': 'REF_POINT_MODE_2', 'd8 2a': 'HOME_XY', 0xd7: 'EOF', 0xf0: 'REF_POINT_SET',
  'e6 01': 'SET_ABSOLUTE', 'f1 02': 'ENABLE_BLOCK_CUTTING', 'f1 03': 'DISPLAY_OFFSET', 'e7 00': 'BLOCK_END', 'e7 03': 'PROCESS_TOP_LEFT',
  'e7 07': 'PROCESS_BOTTOM_RIGHT', 'e7 50': 'DOCUMENT_MIN', 'e7 51': 'DOCUMENT_MAX', 'e7 52': 'PART_MIN', 'e7 53': 'PART_MAX',
  'e7 61': 'PART_MIN_EX', 'e7 62': 'PART_MAX_EX', 'e7 04': 'PROCESS_REPEAT', 'e7 05': 'ARRAY_DIRECTION', 'e7 06': 'FEED_REPEAT',
  'e7 08': 'ARRAY_REPEAT', 'e7 0a': 'FEED_INFO', 'e7 0b': 'ARRAY_EN_MIRROR_CUT', 'e7 13': 'ARRAY_MIN', 'e7 17': 'ARRAY_MAX',
  'e7 23': 'ARRAY_ADD', 'e7 24': 'ARRAY_MIRROR', 'e7 38': 'FEED_AUTO_PAUSE', 'e7 54': 'PEN_OFFSET', 'e7 55': 'LAYER_OFFSET',
  'e7 60': 'CURRENT_ELEMENT', 0xea: 'ARRAY_START', 0xeb: 'ARRAY_END', 'e5 05': 'SET_FILE_SUM', 'd9 10': 'RAPID_XY', 'da 00': 'GET_SETTING', 'da 01': 'SETTING'
};

// Split an unswizzled stream into commands (each starts at a byte ≥ 0x80).
function commands(buf) {
  const out = [];
  let s = 0;
  for (let i = 1; i <= buf.length; i++) {
    if (i === buf.length || buf[i] >= 0x80) { out.push(buf.subarray(s, i)); s = i; }
  }
  return out;
}

function describe(c) {
  const key2 = c.length > 1 ? c[0].toString(16).padStart(2, '0') + ' ' + c[1].toString(16).padStart(2, '0') : null;
  const name = (key2 && NAMES[key2]) || NAMES[c[0]] || 'CMD_' + c[0].toString(16);
  let a = '';
  if (c[0] === 0x88 || c[0] === 0xa8) a = (dec(c.subarray(1, 6)) / 1000).toFixed(3) + ', ' + (dec(c.subarray(6, 11)) / 1000).toFixed(3) + ' mm';
  else if (key2 === 'c9 02') a = dec(c.subarray(2)) / 1000 + ' mm/s';
  else if (key2 === 'c9 04') a = 'part ' + c[2] + ', ' + dec(c.subarray(3)) / 1000 + ' mm/s';
  else if (/^c6 0[1-8]|^c6 2[12]/.test(key2)) a = (dec(c.subarray(2)) * 100 / 16383).toFixed(1) + ' %';
  else if (/^c6 3[1-8]|^c6 4[12]/.test(key2)) a = 'part ' + c[2] + ', ' + (dec(c.subarray(3)) * 100 / 16383).toFixed(1) + ' %';
  else if (key2 === 'a0 08') a = (dec(c.subarray(2, 7)) / 1000).toFixed(3) + ' mm';
  else if (key2 === 'd9 10') a = 'opt ' + c[2] + ', ' + (dec(c.subarray(3, 8)) / 1000).toFixed(3) + ', ' + (dec(c.subarray(8, 13)) / 1000).toFixed(3) + ' mm';
  else if (c.length > 2) a = Buffer.from(c.subarray(key2 && NAMES[key2] ? 2 : 1)).toString('hex');
  return name + (a ? ' ' + a : '');
}

const listing = (unswizzled) => commands(unswizzled).map(describe).join('\n');

module.exports = { swizzle, unswizzle, swizzleByte, unswizzleByte, enc, dec, abs, rel, power, speed, RD, MEM, commands, describe, listing };

// The Trotec's head camera at work: reading registration marks (print and cut), calibrating
// the camera, and checking / correcting the machine's accuracy with a checkerboard.
//
// Coordinates are Pathline's bed mm. The camera sits off the beam: laser = camera + offset
// (Ruby's convention, TROTEC_PROTOCOL.md §7.1). A frame's pixel (u, v) from its centre is
// (dx, dy) mm on the bed through the 2×2 matrix vision.matrix [a, b, c, d]:
//   dx = a·u + b·v,  dy = c·u + d·v   (pixel size and rotation, from calibration)
// Mark reading follows Ruby's workflow (§7.4): send the camera to where the mark should be,
// grab, find it; more than `tolerance` mm off centre → re-centre and grab again (lens distortion
// at the edges then doesn't matter), up to `recentre` times; predict each next mark from the
// ones found so far.
'use strict';

const detect = require('./detect');
const fitting = require('./fit');
const { makeCamera } = require('./camera');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const err = (msg, code) => Object.assign(new Error(msg), { code: code || 409 });

// the camera settings, with their defaults (Setup → Camera)
const DEFAULTS = {
  enabled: false, source: 'vimba', exposure: 100000, light: false, // µs: 20 ms was nearly black with the light off
  offset: [41.437, 12.731],            // laser − camera, mm (this machine's, from Ruby)
  matrix: [0, 0.02, 0.02, 0],          // mm per pixel; frames come rotated 90° (§7.8)
  tolerance: 1.0, recentre: 3,         // Ruby's AcceptableDistanceToCenterMm, MaxRepositionCount
  mark: { power: 20, speed: 50 },      // calibration mark: a small dark disc of tight circles
  board: { square: 50, across: 25, down: 17, every: 2 },
  map: null, mapOn: true, calibrated: ''
};

class Vision {
  // machine: the Machine (moves, waits, link); opts.sim: SimCamera options (tests, --sim)
  constructor(machine, opts = {}) {
    this.m = machine;
    this.opts = opts;
    this.camera = null;
    this.last = null;      // the last frame (Camera view)
    this.lastDrift = null; // the last checkerboard result (bed view)
  }

  get cfg() { return { ...DEFAULTS, ...(this.m.cfg.vision || {}) }; }
  log(msg) { this.m.log('camera: ' + msg); }

  async cam() {
    const v = { ...this.cfg, ...(this.opts.forceSim ? { source: 'sim' } : {}) };
    if (!v.enabled) throw err('The camera is off (Setup → Camera)');
    if (this.camera && this.cameraKey === v.source) return this.camera;
    await this.close();
    const c = makeCamera(v, { log: (m) => this.m.log(m), sim: { ...(this.opts.sim || {}), headAt: () => this.m.st.pos } });
    await c.open();
    this.camera = c;
    this.cameraKey = v.source;
    if (v.light && this.m.link && this.m.link.setCameraLight) await this.m.link.setCameraLight(true).catch(() => {});
    return c;
  }

  async close() { if (this.camera) { await this.camera.close().catch(() => {}); this.camera = null; } }

  async grab() {
    const c = await this.cam();
    await sleep(50); // Ruby's CameraTriggerDelayMs: let the head settle
    const img = await c.grab();
    this.last = { img, at: { ...this.m.st.pos }, t: Date.now() };
    return img;
  }

  // a frame for the screen (grey bytes), about `size` px across
  async preview(size) {
    const img = await this.grab();
    return detect.preview(img, size || 480);
  }

  // pixel offset from the frame centre → mm on the bed
  toBed(img, p) {
    const [a, b, c, d] = this.cfg.matrix;
    const u = p.x - (img.w - 1) / 2, v = p.y - (img.h - 1) / 2;
    return [a * u + b * v, c * u + d * v];
  }

  pixelSize() { const [a, b, c, d] = this.cfg.matrix; return Math.sqrt(Math.abs(a * d - b * c)); }

  // head (laser) position that puts the camera over p, through the bed correction map
  laserFor(p, raw) {
    const o = this.cfg.offset;
    const l = [p[0] + o[0], p[1] + o[1]];
    return raw || !this.cfg.mapOn ? l : fitting.correct(this.cfg.map, l);
  }

  async moveCamera(p, opts = {}) {
    const [x, y] = this.laserFor(p, opts.raw);
    const [W, H] = this.m.cfg.bed;
    if (x < -0.5 || y < -0.5 || x > W + 0.5 || y > H + 0.5) throw err('The camera can\'t reach ' + p.map((v) => v.toFixed(1)).join(', ') + ' mm: the head would leave the bed');
    await this.m.link.moveTo(x, y);
    await this.m.waitIdle(30000, 150);
  }

  // the thing nearest the middle of the frame: kind 'dot' (d mm across) or 'corner'
  find(img, kind, d) {
    if (kind === 'corner') return detect.findCorner(img);
    const px = this.pixelSize();
    const dots = detect.findDots(img, d ? { minD: (d * 0.5) / px, maxD: (d * 1.6) / px } : {});
    return dots[0] || null;
  }

  // where the thing really is, near p: camera over p, find, re-centre if needed
  async measure(p, kind, opts = {}) {
    const v = this.cfg;
    let at = p.slice();
    for (let k = 0; k <= v.recentre; k++) {
      if (opts.ctl && opts.ctl.aborted) throw err('Stopped');
      await this.moveCamera(at, opts);
      const img = await this.grab();
      const hit = this.find(img, kind, opts.d);
      if (!hit) return null;
      const off = this.toBed(img, hit);
      const found = [at[0] + off[0], at[1] + off[1]];
      if (Math.hypot(off[0], off[1]) <= v.tolerance || k === v.recentre) return { found, off, tries: k + 1, hit };
      at = found;
    }
    return null;
  }

  // ---------------------------------------------------------------- print and cut
  // Reads the job's registration marks in Pathline's order; returns the fit (design → found).
  async readMarks(pkg, ctl = {}, status = () => {}) {
    const steps = (pkg.toolpath || []).filter((s) => s.type === 'inspect');
    const E = [], D = [];
    for (const s of steps) {
      // predict from the marks found so far (shift with one, + rotation and scale with more)
      const pred = E.length ? fitting.fit(E, D, E.length === 1 ? 'shift' : 'similar')(s.at) : s.at;
      status('Reading mark ' + s.mark + ' of ' + s.of);
      const r = await this.measure(pred, 'dot', { d: s.d, ctl });
      if (!r) throw err('Registration mark ' + s.mark + ' not found near ' + pred.map((v) => v.toFixed(1)).join(', ') + ' mm. Check the sheet, the light and Setup → Camera.');
      E.push(s.at); D.push(r.found);
      this.log('mark ' + s.mark + ': expected ' + s.at.map((v) => v.toFixed(2)).join(', ') + ', found ' + r.found.map((v) => v.toFixed(3)).join(', ') + ' (' + r.tries + ' frame' + (r.tries > 1 ? 's' : '') + ')');
    }
    const type = fitting.typeFor(pkg.regMarks && pkg.regMarks.mode, E.length);
    const f = fitting.fit(E, D, type);
    const i = f.info;
    this.log('print and cut: ' + i.type + ', shift ' + i.shift.map((v) => v.toFixed(3)).join(', ') + ' mm, rotation ' + i.rotation.toFixed(3) + '°, scale ' + ((i.scaleX - 1) * 1000).toFixed(2) + ' / ' + ((i.scaleY - 1) * 1000).toFixed(2) + ' mm/m');
    return { f, expected: E, found: D, info: i };
  }

  // the job without its inspect steps, moved onto the marks found
  static corrected(pkg, f) {
    const out = fitting.transformPkg({ ...pkg, toolpath: (pkg.toolpath || []).filter((s) => s.type !== 'inspect') }, f);
    return out;
  }

  // ---------------------------------------------------------------- calibration
  // Pixel size and rotation: with any dot or checkerboard corner under the camera, move the head
  // a few mm along X, then Y, and see how far it moves in the frame.
  async calibratePixels() {
    await this.m.waitIdle(30000, 150); // the head may still be on its way here
    const start = { x: this.m.st.pos.x, y: this.m.st.pos.y };
    const look = async () => { await this.m.waitIdle(30000, 150); const img = await this.grab(); return { img, hit: this.find(img, 'dot') || this.find(img, 'corner') }; };
    const a = await look();
    if (!a.hit) throw err('Put a dark dot or a checkerboard corner under the camera first');
    const fov = Math.min(a.img.w, a.img.h) * this.pixelSize();
    const d = Math.max(1, Math.min(4, fov * 0.12));
    const near = (img) => { const h = [this.find(img, 'dot'), this.find(img, 'corner')].filter(Boolean); return h.sort((p, q) => Math.hypot(p.x - a.hit.x, p.y - a.hit.y) - Math.hypot(q.x - a.hit.x, q.y - a.hit.y))[0]; };
    await this.m.link.moveTo(start.x + d, start.y);
    const bx = await look(); const hx = near(bx.img);
    await this.m.link.moveTo(start.x, start.y + d);
    const by = await look(); const hy = near(by.img);
    await this.m.link.moveTo(start.x, start.y);
    await this.m.waitIdle(30000, 150);
    if (!hx || !hy) throw err('Lost the dot while moving: put it near the middle of the picture and try again');
    // the head moves +d → the thing moves u px in the frame, and A·u = −d along that axis
    const u1 = [hx.x - a.hit.x, hx.y - a.hit.y], u2 = [hy.x - a.hit.x, hy.y - a.hit.y];
    const det = u1[0] * u2[1] - u1[1] * u2[0];
    if (Math.abs(det) < 1) throw err('The picture hardly moved: is the camera on?');
    // A = −d · [u1 u2]⁻¹
    const inv = [u2[1] / det, -u2[0] / det, -u1[1] / det, u1[0] / det];
    const m = [-d * inv[0], -d * inv[1], -d * inv[2], -d * inv[3]].map((v) => +v.toPrecision(8));
    const px = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
    const rot = (Math.atan2(m[2], m[0]) * 180) / Math.PI;
    this.log('pixel size ' + (px * 1000).toFixed(3) + ' µm, picture turned ' + rot.toFixed(2) + '°');
    return { matrix: m, pixel: px, rotation: rot };
  }

  // Camera offset: the laser marks a small dark disc on scrap where the head is now, the camera
  // looks for it, and the offset is corrected by how far from where it should be it shows up.
  async calibrateOffset({ power, speed } = {}, ctl = {}) {
    await this.m.waitIdle(30000, 150);
    const at = [this.m.st.pos.x, this.m.st.pos.y];
    const mark = { ...this.cfg.mark, ...(power !== undefined ? { power } : {}), ...(speed !== undefined ? { speed } : {}) };
    await this.m.fireMark(at, mark, ctl);
    if (this.camera && this.camera.laserMark) this.camera.laserMark(at[0], at[1], 3); // simulated laser
    let o = this.cfg.offset.slice();
    let r = null;
    for (let k = 0; k < 2; k++) {
      r = await this.measure(at, 'dot', { d: 3, ctl });
      if (!r) throw err('Couldn\'t see the laser\'s mark. Raise the power, or check the light, then try again.');
      // found = at + (true offset − assumed offset)
      o = [o[0] + (r.found[0] - at[0]), o[1] + (r.found[1] - at[1])];
      this.m.cfg.vision = { ...this.m.cfg.vision, offset: o };
    }
    this.log('offset laser − camera: ' + o.map((v) => v.toFixed(3)).join(', ') + ' mm');
    return { offset: o.map((v) => +v.toFixed(4)), mark: at };
  }

  // ---------------------------------------------------------------- checkerboard
  // Scan the board's corners from the one under the camera now (its top-left inner corner as
  // the bed view shows it), every `every`-th corner, `across` × `down` inner corners. The board
  // can sit anywhere, at any angle: its own position and angle are fitted from the corners
  // (rigid: the board is the length reference), and what's left over is the machine's error.
  // raw: true measures the machine as it is (calibrate); false with the bed map on (check).
  async scanBoard(opts = {}, ctl = {}, status = () => {}) {
    const b = { ...this.cfg.board, ...(opts.board || {}) };
    const raw = !!opts.raw;
    const step = b.square * b.every;
    const ni = Math.floor((b.across - 1) / b.every) + 1, nj = Math.floor((b.down - 1) / b.every) + 1;
    await this.m.waitIdle(30000, 150);
    const cam0 = [this.m.st.pos.x - this.cfg.offset[0], this.m.st.pos.y - this.cfg.offset[1]];
    const first = await this.measure(cam0, 'corner', { raw, ctl });
    if (!first) throw err('No checkerboard corner under the camera. Jog the camera over the board\'s top-left corner, then start again.');
    // which way the board's lines run: the corner's angle in the frame, turned onto the bed
    const [a, bm, c, dm] = this.cfg.matrix;
    const ai = ((first.hit.angle || 0) * Math.PI) / 180;
    let th = Math.atan2(c * Math.cos(ai) + dm * Math.sin(ai), a * Math.cos(ai) + bm * Math.sin(ai));
    // of the board's two line directions, u is the one nearest +X, v nearest +Y
    th = Math.atan2(Math.sin(th * 4), Math.cos(th * 4)) / 4; // fold into −45…45°
    const u = [Math.cos(th), Math.sin(th)], v = [-Math.sin(th), Math.cos(th)];
    const grid = [], found = [];
    const order = [];
    for (let j = 0; j < nj; j++) for (let k = 0; k < ni; k++) order.push([j % 2 ? ni - 1 - k : k, j]); // back and forth
    let missed = 0;
    for (const [i, j] of order) {
      if (ctl.aborted) throw err('Stopped');
      const g = [i * step, j * step];
      // predict from the corners found so far (board → bed, rotation + shift)
      const pred = grid.length >= 2 ? fitting.fit(grid, found, 'rigid')(g) : [first.found[0] + g[0] * u[0] + g[1] * v[0], first.found[1] + g[0] * u[1] + g[1] * v[1]];
      status('Corner ' + (grid.length + missed + 1) + ' of ' + order.length);
      let r = null;
      try { r = await this.measure(pred, 'corner', { raw, ctl }); } catch (e) { if (ctl.aborted) throw e; this.log('corner ' + i + ', ' + j + ': ' + e.message); }
      if (!r) { missed++; continue; }
      grid.push(g); found.push(r.found);
    }
    if (grid.length < 4) throw err('Only ' + grid.length + ' corners found: check the board size in Setup → Camera');
    const T = fitting.fit(grid, found, 'rigid');
    const A = fitting.fit(grid, found, 'affine');
    const points = grid.map((g, k) => {
      const ideal = T(g);
      const r = [found[k][0] - ideal[0], found[k][1] - ideal[1]];
      // where the head was (laser coordinates), and how far off it really was
      return { grid: g, at: [found[k][0] + this.cfg.offset[0], found[k][1] + this.cfg.offset[1]], res: r, err: [-r[0], -r[1]] };
    });
    const d = points.map((p) => Math.hypot(p.res[0], p.res[1]));
    // squareness: the angle between the board's X and Y lines as the machine draws them
    const sq = squareness(grid, found);
    const result = {
      at: new Date().toISOString(), raw, step, points, missed,
      worst: Math.max(...d), rms: Math.sqrt(d.reduce((s, x) => s + x * x, 0) / d.length),
      boardAngle: T.info.rotation, scaleX: (A.info.scaleX - 1) * 1000, scaleY: (A.info.scaleY - 1) * 1000, squareness: sq
    };
    this.lastDrift = result;
    this.log('checkerboard: ' + points.length + ' corners (' + missed + ' missed), worst ' + result.worst.toFixed(3) + ' mm, rms ' + result.rms.toFixed(3) + ' mm, scale X ' + result.scaleX.toFixed(2) + ' / Y ' + result.scaleY.toFixed(2) + ' mm/m, squareness ' + sq.toFixed(3) + '°, board at ' + result.boardAngle.toFixed(2) + '°');
    return result;
  }
}

// angle (deg) between the machine's images of the board's X and Y lines, minus 90°
function squareness(grid, found) {
  const A = fitting.affine(grid, found).m; // [a b tx c d ty]
  const ax = Math.atan2(A[3], A[0]), ay = Math.atan2(A[4], A[1]);
  let d = ((ay - ax) * 180) / Math.PI - 90;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

module.exports = { Vision, DEFAULTS };

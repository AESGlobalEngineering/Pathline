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
const { makeCamera, MAX_EXPOSURE } = require('./camera');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const err = (msg, code) => Object.assign(new Error(msg), { code: code || 409 });

// the camera settings, with their defaults (Setup → Camera)
const DEFAULTS = {
  enabled: false, source: 'vimba', exposure: 'auto', light: false, // or µs (20 ms was nearly black with the light off)
  offset: [41.437, 12.731],            // laser − camera, mm (this machine's, from Ruby)
  matrix: [0, 0.02, 0.02, 0],          // mm per pixel; frames come rotated 90° (§7.8)
  tolerance: 1.0, recentre: 3,         // Ruby's AcceptableDistanceToCenterMm, MaxRepositionCount
  mark: { power: 20, speed: 50 },      // calibration mark: a small dark disc of tight circles
  board: { square: 50, across: 25, down: 17, every: 2, model: 'linear' }, // model: linear / smooth / full
  camBoard: { square: 10 },            // stage 1: the small checkerboard under the camera
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
    // one that didn't open is closed (its process ended), not left running beside the next try
    try { await c.open(); } catch (e) { await c.close().catch(() => {}); throw e; }
    this.camera = c;
    this.cameraKey = v.source;
    if (v.light && this.m.link && this.m.link.setCameraLight) await this.m.link.setCameraLight(true).catch(() => {});
    return c;
  }

  async close() { if (this.camera) { await this.camera.close().catch(() => {}); this.camera = null; } }

  // One frame. Exposure 'auto': aim the brightest part of the view (the 95th percentile: the white
  // paper or board, whatever the light does elsewhere) at about 190 of 255, a few tries at most,
  // and keep the exposure found for the next frame (so usually one grab).
  async grab() {
    const c = await this.cam();
    await sleep(50); // Ruby's CameraTriggerDelayMs: let the head settle
    const v = this.cfg;
    let img;
    if (v.exposure !== 'auto' && Number(v.exposure) > 0) {
      if (this.expSet !== Number(v.exposure)) { await c.setExposure(Number(v.exposure)); this.expSet = Number(v.exposure); }
      img = await c.grab();
    } else {
      if (!this.exp) this.exp = 50000;
      for (let k = 0; k < 6; k++) {
        if (this.expSet !== this.exp) { await c.setExposure(this.exp); this.expSet = this.exp; }
        img = await c.grab();
        const b = brightest(img);
        if (b >= 150 && b <= 230) break;
        const next = Math.max(100, Math.min(MAX_EXPOSURE, Math.round(b >= 250 ? this.exp * 0.4 : this.exp * Math.max(0.3, Math.min(4, 190 / Math.max(1, b))))));
        if (next === this.exp) break; // at the limit: the best there is
        this.exp = next;
      }
    }
    this.last = { img, at: { ...this.m.st.pos }, t: Date.now() };
    return img;
  }

  exposureNow() { return this.cfg.exposure === 'auto' ? this.exp || null : Number(this.cfg.exposure); }

  // The same view at the exposure in use, then at each step times it: where the light is uneven
  // (the Trotec's lights one band of the view, the rest in shadow) corners in the dark part only
  // show at a longer exposure. The next grab() goes back to the exposure in use.
  async grabSteps(steps = [1, 3, 9]) {
    const out = [await this.grab()];
    for (const k of steps.slice(1)) out.push(await this.grabTimes(k));
    return out;
  }

  // the same view at k times the exposure in use (MAX_EXPOSURE at most)
  async grabTimes(k) {
    const e = Math.min(MAX_EXPOSURE, Math.round((this.exposureNow() || 50000) * k)), c = await this.cam();
    await c.setExposure(e);
    this.expSet = e;
    return c.grab();
  }

  // A picture and the thing looked for in it; where it isn't there, the same view at 3× and then
  // 9× the exposure, as the Trotec's light covers only part of the view (only when needed: the
  // bed checkerboard takes over a hundred of these)
  async grabFind(kind, d, opts) {
    let img = await this.grab();
    let hit = this.find(img, kind, d, opts);
    for (const k of [3, 9]) {
      if (hit) break;
      img = await this.grabTimes(k);
      hit = this.find(img, kind, d, opts);
    }
    return { img, hit };
  }

  // a frame for the screen (grey bytes), about `size` px across
  // Never while the head moves: the camera rides on it, and pictures taken while jogging got the
  // camera stuck (its USB link drops out as the cable flexes). It waits for the head to stop; if
  // it's still moving (an arrow held down), the last picture is shown again
  async preview(size) {
    if (!(await this.m.waitIdle(10000, 0)) && this.lastPreview) return this.lastPreview;
    const img = await this.grab();
    this.lastPreview = detect.preview(img, size || 480);
    return this.lastPreview;
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

  // where the camera looks with the head (laser) at `head`: laserFor the other way round (the bed
  // map's correction is small and smooth, so a few rounds settle it)
  cameraAt(head) {
    const o = this.cfg.offset;
    let p = [head[0] - o[0], head[1] - o[1]];
    for (let k = 0; k < 4; k++) {
      const l = this.laserFor(p);
      p = [p[0] + head[0] - l[0], p[1] + head[1] - l[1]];
    }
    return p;
  }

  async moveCamera(p, opts = {}) {
    const [x, y] = this.laserFor(p, opts.raw);
    // beam off: the head may use the travel past the bed's corner (Machine.travel)
    const t = this.m.travel ? this.m.travel() : [0, 0, ...this.m.cfg.bed];
    if (x < t[0] - 0.5 || y < t[1] - 0.5 || x > t[2] + 0.5 || y > t[3] + 0.5) throw err('The camera can\'t reach ' + p.map((v) => v.toFixed(1)).join(', ') + ' mm: the head would leave the bed');
    // (within the half mm allowed: to the edge of the travel, never past the machine's zero)
    await this.m.link.moveTo(Math.max(t[0], Math.min(t[2], x)), Math.max(t[1], Math.min(t[3], y)));
    await this.m.waitIdle(30000, 150);
  }

  // the thing nearest the middle of the frame: kind 'dot' (d mm across) or 'corner'
  find(img, kind, d, opts = {}) {
    if (kind === 'corner') return detect.findCorner(img);
    const px = this.pixelSize();
    // registration marks (d given) sit in plain white: only those count; calibration targets
    // (the cut mark on scrap, a dot under the camera) may have darker surroundings
    const dots = detect.findDots(img, d ? { minD: (d * 0.5) / px, maxD: (d * 1.6) / px, whiteRing: !!opts.whiteRing, fillHoles: !!opts.fillHoles } : {});
    return dots[0] || null;
  }

  // where the thing really is, near p: camera over p, find, re-centre if needed
  async measure(p, kind, opts = {}) {
    const v = this.cfg;
    let at = p.slice();
    for (let k = 0; k <= v.recentre; k++) {
      if (opts.ctl && opts.ctl.aborted) throw err('Stopped');
      await this.moveCamera(at, opts);
      const { img, hit } = await this.grabFind(kind, opts.d, opts);
      if (!hit) return null;
      const off = this.toBed(img, hit);
      const found = [at[0] + off[0], at[1] + off[1]];
      if (Math.hypot(off[0], off[1]) <= v.tolerance || k === v.recentre) return { found, off, tries: k + 1, hit };
      at = found;
    }
    return null;
  }

  // The last picture looked at for a mark, kept for finding out why a mark was missed: half size,
  // grey bytes after a 4-byte header (width, height as 16-bit), gzipped, in the data folder's
  // marks/ (the last job's only), with what was looked for and found beside it
  saveMarkFrame(name, info) {
    try {
      const dir = this.m.store && this.m.store.dir && require('path').join(this.m.store.dir, 'marks');
      if (!dir || !this.last) return;
      const fs = require('fs');
      fs.mkdirSync(dir, { recursive: true });
      const s = detect.shrink(this.last.img, Math.max(this.last.img.w, this.last.img.h) / 2);
      const b = Buffer.alloc(4 + s.w * s.h);
      b.writeUInt16BE(s.w, 0); b.writeUInt16BE(s.h, 2);
      for (let i = 0; i < s.w * s.h; i++) b[4 + i] = Math.round(s.data[i]);
      fs.writeFileSync(require('path').join(dir, name + '.bin.gz'), require('zlib').gzipSync(b));
      fs.writeFileSync(require('path').join(dir, name + '.json'), JSON.stringify({ ...info, head: this.last.at, exposure: this.exposureNow(), pixel: this.pixelSize(), half: true }, null, 1));
    } catch (e) { this.log('mark picture not kept: ' + e.message); }
  }

  clearMarkFrames() {
    try {
      const dir = this.m.store && this.m.store.dir && require('path').join(this.m.store.dir, 'marks');
      if (dir) require('fs').rmSync(dir, { recursive: true, force: true });
    } catch (e) { /* nothing to clear */ }
  }

  // ---------------------------------------------------------------- print and cut
  // Reads the job's registration marks in Pathline's order; returns the fit (design → found).
  // opts.anchored: the job was put at the laser as Start was pressed
  async readMarks(pkg, ctl = {}, status = () => {}, opts = {}) {
    const steps = (pkg.toolpath || []).filter((s) => s.type === 'inspect');
    const E = [], D = [];
    this.clearMarkFrames();
    for (const s of steps) {
      // predict from the marks found so far: the shift from one; shift and rotation from two (their
      // scale is one distance, and carried 740 mm out to the third mark it put a 6 % stretch's
      // worth, 45 mm, into the prediction); the full fit from three
      const pred = E.length ? fitting.fit(E, D, E.length === 1 ? 'shift' : E.length === 2 ? 'rigid' : 'affine')(s.at) : s.at;
      status('Reading mark ' + s.mark + ' of ' + s.of);
      let r = await this.measure(pred, 'dot', { d: s.d, ctl, whiteRing: true });
      this.saveMarkFrame('mark' + s.mark, { mark: s.mark, design: s.at, expected: pred, d: s.d, found: r ? r.found : null, hit: r ? r.hit : null });
      // Anchored, and the first mark isn't there: the camera may have been put over the dot at
      // Start in place of the laser (J0064: every mark 42, 19 mm off, the camera's offset). Look
      // one offset over before asking for the camera to be jogged by hand
      if (!r && !E.length && opts.anchored) {
        const o = this.cfg.offset, alt = [pred[0] - o[0], pred[1] - o[1]];
        status('Reading mark ' + s.mark + ' of ' + s.of + ' (as if the camera was put over the dot)');
        r = await this.measure(alt, 'dot', { d: s.d, ctl, whiteRing: true }).catch((e) => { if (ctl.aborted) throw e; return null; });
        if (r) this.log('mark ' + s.mark + ': found one camera offset from where it should be: the camera, not the laser, was put over the dot at Start. Put the laser over it next time');
      }
      // not where it should be: the job waits while the user jogs the camera over it (Jog page),
      // then the dot finder looks again from there. Put there by hand, the dot nearest the
      // crosshair counts even without clean white round it (artwork close by may be why it was missed)
      for (let again = false; !r; again = true) {
        this.log('mark ' + s.mark + (again ? ' still not found' : ' not found near ' + pred.map((v) => v.toFixed(1)).join(', ') + ' mm') + ': waiting for the camera to be jogged over it');
        const at = await this.m.waitForMark({ mark: s.mark, of: s.of, near: pred, again }, ctl);
        status('Reading mark ' + s.mark + ' of ' + s.of + ' where the camera was put');
        r = await this.measure(at, 'dot', { d: s.d, ctl, whiteRing: false });
        this.saveMarkFrame('mark' + s.mark + '-hand' + (again ? '2' : ''), { mark: s.mark, design: s.at, expected: pred, camera: at, d: s.d, found: r ? r.found : null, hit: r ? r.hit : null });
        if (r) this.log('mark ' + s.mark + ': found by hand, ' + Math.hypot(r.found[0] - pred[0], r.found[1] - pred[1]).toFixed(2) + ' mm from where it was expected; the camera was put ' + Math.hypot(r.found[0] - at[0], r.found[1] - at[1]).toFixed(2) + ' mm from it');
      }
      E.push(s.at); D.push(r.found);
      this.log('mark ' + s.mark + ': expected ' + s.at.map((v) => v.toFixed(2)).join(', ') + ', found ' + r.found.map((v) => v.toFixed(3)).join(', ') + ' (' + r.tries + ' frame' + (r.tries > 1 ? 's' : '') + ')');
    }
    // the marks found must be as far apart as the job's: a dot that isn't the mark (a hole in the
    // bed through clear acrylic, artwork) bent the job 5 % one way and 6 % the other, and it was cut
    // off the print. Over 1 % (2 mm at least) out: stop before anything is cut
    for (let i = 0; i < E.length; i++) {
      for (let j = i + 1; j < E.length; j++) {
        const de = Math.hypot(E[j][0] - E[i][0], E[j][1] - E[i][1]), dd = Math.hypot(D[j][0] - D[i][0], D[j][1] - D[i][1]);
        if (Math.abs(dd - de) > Math.max(2, 0.01 * de)) {
          this.log('print and cut: marks ' + steps[i].mark + ' and ' + steps[j].mark + ' found ' + dd.toFixed(1) + ' mm apart, ' + de.toFixed(1) + ' mm in the job: stopped');
          throw err('Registration marks ' + steps[i].mark + ' and ' + steps[j].mark + ' were found ' + dd.toFixed(1) + ' mm apart, but they are ' + de.toFixed(1) + ' mm apart in the job. One of them wasn\'t the mark (or the sheet isn\'t this job\'s). Nothing was cut.');
        }
      }
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
  // Stage 1, camera: a small checkerboard (10 mm squares) under the camera, filling the picture.
  // Its corners give the pixel size: the squares are a known size, so it doesn't depend on how
  // accurately the machine moves; how far its corners stray from a perfect grid shows how much
  // the lens bends straight lines. Then the head moves a little along X, then Y (under half a
  // square, so the corner followed can't be mistaken for its neighbour): that gives which way the
  // picture is turned and whether it's mirrored, relative to the machine. The board itself can
  // lie at any angle.
  // The board goes under the camera, where it is now: this stage needs no offset (stage 2 finds
  // it), so the camera isn't moved over the laser's spot first. The head goes back where it was.
  async calibrateCamera(opts = {}) {
    await this.m.waitIdle(30000, 150);
    const square = Number(opts.square || (this.cfg.camBoard || {}).square || 10);
    return this.cameraOnBoard(square);
  }

  async cameraOnBoard(square) {
    const start = { x: this.m.st.pos.x, y: this.m.st.pos.y };
    // each view at stepped exposures, corners from all of them: the light covers only part of it
    const cs0 = detect.findCornersIn(await this.grabSteps());
    const L = detect.fitLattice(cs0);
    if (!L) throw err('Put the ' + square + ' mm checkerboard under the camera, flat, filling the camera view (' + cs0.length + ' corners seen)');
    const spacing = Math.sqrt(Math.abs(L.a[0] * L.b[1] - L.a[1] * L.b[0])); // px per square
    const pixel = square / spacing;
    // only corners on the board's grid: a false one (a soft edge, a shadow) could be nearer
    const c0 = L.points[0];
    const d = square * 0.3;
    const follow = async (x, y) => {
      await this.m.link.moveTo(x, y);
      await this.m.waitIdle(30000, 150);
      const Lk = detect.fitLattice(detect.findCornersIn(await this.grabSteps()));
      const cs = Lk ? Lk.points : [];
      const near = cs.sort((p, q) => Math.hypot(p.x - c0.x, p.y - c0.y) - Math.hypot(q.x - c0.x, q.y - c0.y))[0];
      if (!near || Math.hypot(near.x - c0.x, near.y - c0.y) > (d / pixel) * 1.6) throw err('Lost the board while moving: keep it flat under the camera and try again');
      return [near.x - c0.x, near.y - c0.y];
    };
    let u1, u2;
    try { u1 = await follow(start.x + d, start.y); u2 = await follow(start.x, start.y + d); } finally {
      await this.m.link.moveTo(start.x, start.y);
      await this.m.waitIdle(30000, 150);
    }
    // the head moves +d → the board moves u px in the picture: A·u = −d along that axis
    const det = u1[0] * u2[1] - u1[1] * u2[0];
    if (Math.abs(det) < 1) throw err('The picture hardly moved: is the camera on?');
    const inv = [u2[1] / det, -u2[0] / det, -u1[1] / det, u1[0] / det];
    const motion = inv.map((v) => -d * v);
    const motionPx = Math.sqrt(Math.abs(motion[0] * motion[3] - motion[1] * motion[2]));
    // direction from the move, size from the board
    const matrix = motion.map((v) => +((v * pixel) / motionPx).toPrecision(8));
    const rotation = (Math.atan2(matrix[2], matrix[0]) * 180) / Math.PI;
    const mirrored = matrix[0] * matrix[3] - matrix[1] * matrix[2] < 0;
    const r = {
      matrix, pixel, rotation, mirrored, corners: L.n,
      // how far the corners stray from a perfect grid (lens), and how the head's moves compare
      // with the board (the machine's own length error, roughly: the checkerboard bed check says more)
      lens: L.worst * pixel, moveVsBoard: (motionPx / pixel - 1) * 1000
    };
    this.log('camera calibrated on the ' + square + ' mm board: ' + L.n + ' corners, pixel size ' + (pixel * 1000).toFixed(3) + ' µm, picture turned ' + rotation.toFixed(2) + '°' + (mirrored ? ' (mirrored)' : '') + ', lens bends lines up to ' + (r.lens * 1000).toFixed(0) + ' µm');
    return r;
  }

  // Pixel size and rotation without the small board: with any dot or checkerboard corner under
  // the camera, move the head a few mm along X, then Y, and see how far it moves in the frame
  // (the size then rests on the machine's own accuracy).
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

  // Stage 2, offset (cut check): the laser cuts a small dark disc on scrap where the head is
  // now, the camera looks for it, and the offset is corrected by how far from where it should be
  // it shows up; then one more picture checks it (`check`: how far off the cut still is, mm).
  async calibrateOffset(o = {}, ctl = {}) {
    await this.m.waitIdle(30000, 150);
    const laser = { x: this.m.st.pos.x, y: this.m.st.pos.y };
    // the cut goes where the laser head is; the head goes back there at the end
    try { return await this.cutCheck(o, ctl); } finally {
      await this.m.link.moveTo(laser.x, laser.y).catch(() => {});
      await this.m.waitIdle(30000, 150).catch(() => {});
    }
  }

  async cutCheck({ power, speed } = {}, ctl = {}) {
    const at = [this.m.st.pos.x, this.m.st.pos.y];
    const mark = { ...this.cfg.mark, ...(power !== undefined ? { power } : {}), ...(speed !== undefined ? { speed } : {}) };
    const d = (await this.m.fireMark(at, mark, ctl)) || 4;
    if (this.camera && this.camera.laserMark) this.camera.laserMark(at[0], at[1], d); // simulated laser
    const look = { d, ctl, fillHoles: true }; // the mark is rings: their holes count as the disc
    // The stored offset (Ruby's) can have the other sign convention, camera − laser, on either axis:
    // the head then goes the wrong way to look. Where the mark isn't, look where each other sign
    // would put it; the one that sees it gives the offset
    const o0 = this.cfg.offset.slice();
    let o = o0, r = null;
    for (const [sx, sy] of [[1, 1], [-1, -1], [-1, 1], [1, -1]]) {
      o = [o0[0] * sx, o0[1] * sy];
      this.m.cfg.vision = { ...this.m.cfg.vision, offset: o };
      r = await this.measure(at, 'dot', look).catch((e) => { if (/Stopped/.test(e.message)) throw e; return null; }); // (off the bed: next)
      if (r) { if (sx < 0 || sy < 0) this.log('the mark was where offset ' + o.map((v) => v.toFixed(3)).join(', ') + ' puts it: the stored one had the other sign' + (sx < 0 && sy < 0 ? '' : sx < 0 ? ' in X' : ' in Y')); break; }
    }
    if (!r) {
      this.m.cfg.vision = { ...this.m.cfg.vision, offset: o0 };
      throw err('Couldn\'t see the laser\'s mark (looked with the stored camera offset, and with it flipped). Check the mark is cut on the scrap, raise the power if it\'s faint, then try again.');
    }
    for (let k = 0; k < 2; k++) {
      if (k) r = await this.measure(at, 'dot', look);
      if (!r) throw err('Lost the laser\'s mark while measuring it: check the light, then try again.');
      // found = at + (true offset − assumed offset)
      o = [o[0] + (r.found[0] - at[0]), o[1] + (r.found[1] - at[1])];
      this.m.cfg.vision = { ...this.m.cfg.vision, offset: o };
    }
    // the check: with the new offset, the camera sent to the cut should see it in the middle
    const c = await this.measure(at, 'dot', look);
    const check = c ? Math.hypot(c.found[0] - at[0], c.found[1] - at[1]) : null;
    this.log('offset laser − camera: ' + o.map((v) => v.toFixed(3)).join(', ') + ' mm' + (check !== null ? '; cut check: ' + (check * 1000).toFixed(0) + ' µm off' : ''));
    return { offset: o.map((v) => +v.toFixed(4)), mark: at, check };
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
    // the board's first corner is where the laser head is now: the camera goes there to start,
    // and the head comes back there at the end
    const laser = { x: this.m.st.pos.x, y: this.m.st.pos.y };
    try { return await this.scanFrom([laser.x, laser.y], { b, raw, step, ni, nj }, ctl, status); } finally {
      await this.m.link.moveTo(laser.x, laser.y).catch(() => {});
      await this.m.waitIdle(30000, 150).catch(() => {});
    }
  }

  async scanFrom(cam0, { b, raw, step, ni, nj }, ctl, status) {
    const first = await this.measure(cam0, 'corner', { raw, ctl });
    if (!first) throw err('No checkerboard corner under the laser head. Jog the laser head over the board\'s top-left corner, then start again.');
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
    // The board's own position and angle (rigid: the board is the length reference) come out
    // first; what's left is the machine's error, plus wherever the board isn't flat. The
    // machine's part is the smooth model (Setup: scale and squareness / smooth / every corner);
    // corners a bump moved don't fit it and are left out, then the board is fitted again.
    const model = b.model || 'linear';
    const resid = (T) => grid.map((g, k) => { const i = T(g); return [found[k][0] - i[0], found[k][1] - i[1]]; });
    let T = fitting.fit(grid, found, 'rigid');
    let res = resid(T);
    let em = fitting.errorModel(found.map((f, k) => ({ p: f, r: res[k] })), model);
    if (em.out.length) {
      const keep = (a) => a.filter((_, k) => !em.out.includes(k));
      T = fitting.fit(keep(grid), keep(found), 'rigid');
      res = resid(T);
      const out = em.out;
      em = fitting.errorModel(found.map((f, k) => ({ p: f, r: res[k] })), model);
      em.out = [...new Set(out.concat(em.out))];
    }
    const inG = grid.filter((_, k) => !em.out.includes(k)), inF = found.filter((_, k) => !em.out.includes(k));
    const A = fitting.fit(inG, inF, 'affine');
    const points = grid.map((g, k) => {
      const m = em.f(found[k]);
      const out = em.out.includes(k);
      // the correction: the model, or (every corner, on a flat board) the corner itself
      const use = model === 'full' && !out ? res[k] : m;
      // where the head was (laser coordinates), and how far off it really was
      return { grid: g, at: [found[k][0] + this.cfg.offset[0], found[k][1] + this.cfg.offset[1]], res: res[k], model: m, out, err: [-use[0], -use[1]] };
    });
    const d = points.map((p) => Math.hypot(p.res[0], p.res[1]));
    // squareness: the angle between the board's X and Y lines as the machine draws them
    const sq = squareness(inG, inF);
    // (scaleX, scaleY, squareness are replaced below by the anchored machine numbers)
    const result = {
      at: new Date().toISOString(), raw, step, points, missed, model,
      worst: Math.max(...d), rms: Math.sqrt(d.reduce((s, x) => s + x * x, 0) / d.length),
      // how much the board itself wanders off the machine's model (bumps, and reading noise)
      noise: em.noise, bumps: em.out.length,
      boardAngle: T.info.rotation, scaleX: (A.info.scaleX - 1) * 1000, scaleY: (A.info.scaleY - 1) * 1000, squareness: sq
    };
    // the bed map this would save: the model over the whole bed (a straight-line model carries on
    // past the board; a curve is held at the board's edge), or every corner as measured. Anchored
    // at home and to the X axis (fit.anchorError): the board can't show where the machine as a
    // whole sits, and it mustn't move jobs.
    const off = this.cfg.offset;
    const bed = this.m.cfg.bed;
    // Everywhere: the straight-line model (scale and squareness carry on across the bed). Where
    // the board was: plus the smooth model's curve, or each corner's own difference (every
    // corner), fading out within one step past the board's edge.
    const bx = [Math.min(...inF.map((p) => p[0])), Math.max(...inF.map((p) => p[0]))], by = [Math.min(...inF.map((p) => p[1])), Math.max(...inF.map((p) => p[1]))];
    const clampP = (p) => [Math.max(bx[0], Math.min(bx[1], p[0])), Math.max(by[0], Math.min(by[1], p[1]))];
    const lin = model === 'linear' ? em : fitting.errorModel(found.map((f, k) => ({ p: f, r: res[k] })).filter((_, k) => !em.out.includes(k)), 'linear');
    const inside = points.filter((p) => !p.out).map((p) => { const q = [p.at[0] - off[0], p.at[1] - off[1]], l = lin.f(q); return { q, d: [p.res[0] - l[0], p.res[1] - l[1]] }; });
    const extra = (p) => {
      if (model === 'smooth') { const c = clampP(p), s = em.f(c), l = lin.f(c); return [s[0] - l[0], s[1] - l[1]]; }
      if (model !== 'full') return [0, 0];
      const near = inside.map((o) => ({ o, d: Math.hypot(o.q[0] - p[0], o.q[1] - p[1]) })).sort((a, b) => a.d - b.d).slice(0, 4);
      let sw = 0, sx = 0, sy = 0;
      for (const { o, d } of near) { const wgt = 1 / Math.max(1e-6, d) ** 2; sw += wgt; sx += wgt * o.d[0]; sy += wgt * o.d[1]; }
      const fade = Math.min(1, (step / Math.max(step, near[0].d)) ** 2);
      return [(fade * sx) / sw, (fade * sy) / sw];
    };
    const errAt = (L) => { const p = [L[0] - off[0], L[1] - off[1]], b0 = lin.f(p), x = extra(p); return [-(b0[0] + x[0]), -(b0[1] + x[1])]; };
    const anchored = fitting.anchorError(errAt, bed);
    result.map = fitting.gridMap(anchored.f, Math.min(step, 50), bed);
    // the machine's own numbers (+ = the head goes further than told; Y's lean from square)
    result.scaleX = anchored.scaleX; result.scaleY = anchored.scaleY; result.squareness = anchored.lean;
    this.lastDrift = result;
    this.log('checkerboard: ' + points.length + ' corners (' + missed + ' missed, ' + em.out.length + ' left out as bumps), worst ' + result.worst.toFixed(3) + ' mm, rms ' + result.rms.toFixed(3) + ' mm, X ' + result.scaleX.toFixed(2) + ' / Y ' + result.scaleY.toFixed(2) + ' mm/m, Y leans ' + result.squareness.toFixed(3) + '°, board at ' + result.boardAngle.toFixed(2) + '°, board misfit ' + em.noise.toFixed(3) + ' mm (' + model + ')');
    return result;
  }
}

// the grey level the brightest 5 % of the picture reaches (sampled)
function brightest(img) {
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < img.data.length; i += 7) { hist[img.data[i]]++; n++; }
  let acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n * 0.05) return v; }
  return 0;
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

// Where the head camera can look. The laser must stay within its travel (moveCamera: the bed, and
// on a Trotec the strip to its zero), so the camera only reaches that shifted by the offset: on the
// Q500, camera 41.7 mm right of the laser and 14.8 mm of travel left of the bed, nothing nearer
// than 26.9 mm to the left edge. Checked at Start, before the head moves (the X28 sheet's marks
// 1 and 3 sat 28 mm from the left edge: "the head would leave the bed" after Start)
const SLACK = 0.5; // as moveCamera allows
// travel: where the head may go, beam off ([x0, y0, x1, y1], Machine.travel; the bed if not given)
// (where the camera can physically look: past the bed's far edges too, as the head can go right up
// to them; J0064 read its top-right mark at X 1322.9 on the 1300 mm bed. Pathline's markArea keeps
// marks on the bed)
function reach(pkg, offset, bed, travel) {
  const [W, H] = bed, [ox, oy] = offset;
  const t = travel || [0, 0, W, H];
  const lim = { x0: Math.max(0, t[0] - ox), y0: Math.max(0, t[1] - oy), x1: t[2] - ox, y1: t[3] - oy };
  const marks = (pkg.toolpath || []).filter((s) => s.type === 'inspect' && Array.isArray(s.at));
  const out = [];
  for (const s of marks) {
    const [x, y] = s.at, edges = [];
    if (x < lim.x0 - SLACK) edges.push('left');
    if (x > lim.x1 + SLACK) edges.push('right');
    if (y < lim.y0 - SLACK) edges.push('back');
    if (y > lim.y1 + SLACK) edges.push('front');
    if (edges.length) out.push({ mark: s.mark, at: s.at, edges });
  }
  return { W, H, lim, marks, out };
}

// What to tell the operator when marks are out of reach (null when all can be read), for the
// screen's dialog: moves [{ dir: 'right' | 'left' | 'front' | 'back', mm }] (each rounded up to the
// next 10 mm: an amount to slide a sheet by, not a measurement), why (one line per edge), then
// (what to do after), wide (marks further apart than the camera reaches: moving can't help), text
// (all of it, as one message). anchored: the job is put at the head as Start is pressed
function reachInfo(r, anchored) {
  if (!r.out.length) return null;
  const names = (l) => (l.length === 1 ? 'Mark ' + l[0] + ' is' : 'Marks ' + l.slice(0, -1).join(', ') + ' and ' + l[l.length - 1] + ' are');
  const mm = (v) => Math.max(0, Math.round(v));
  const E = {
    left: { from: (p) => p[0], see: r.lim.x0, dir: 'right' },
    right: { from: (p) => r.W - p[0], see: r.W - r.lim.x1, dir: 'left' },
    back: { from: (p) => p[1], see: r.lim.y0, dir: 'front' },
    front: { from: (p) => r.H - p[1], see: r.H - r.lim.y1, dir: 'back' }
  };
  const why = [], moves = [];
  for (const edge of ['left', 'right', 'back', 'front']) {
    const hit = r.out.filter((o) => o.edges.includes(edge));
    if (!hit.length) continue;
    const e = E[edge];
    // (past the far edges the distances are negative: "past the right edge")
    const ds = hit.map((o) => Math.round(e.from(o.at)));
    const near = Math.min(...ds);
    const where = near >= 0 ? (ds.every((d) => d === near) ? '' : 'as little as ') + near + ' mm from the ' + edge + ' edge' : -near + ' mm past the ' + edge + ' edge';
    why.push(names(hit.map((o) => o.mark)) + ' ' + where + '; the camera can only see ' + (e.see >= 0 ? 'from ' + Math.ceil(e.see) + ' mm' : 'up to ' + Math.floor(-e.see) + ' mm past it') + '.');
    const need = Math.max(...hit.map((o) => e.see - e.from(o.at)));
    moves.push({ dir: e.dir, mm: Math.max(10, Math.ceil((need + 1e-6) / 10) * 10) });
  }
  // marks further apart than the camera reaches: moving the sheet can't help
  const xs = r.marks.map((s) => s.at[0]), ys = r.marks.map((s) => s.at[1]);
  const spanX = Math.max(...xs) - Math.min(...xs), spanY = Math.max(...ys) - Math.min(...ys);
  const wideX = r.lim.x1 - r.lim.x0, wideY = r.lim.y1 - r.lim.y0;
  if (spanX > wideX + 2 * SLACK || spanY > wideY + 2 * SLACK) {
    const across = spanX > wideX + 2 * SLACK ? [spanX, wideX, 'across'] : [spanY, wideY, 'front to back'];
    const wide = 'The marks are ' + mm(across[0]) + ' mm apart ' + across[2] + ', but the camera can only reach ' + Math.floor(across[1]) + ' mm. Move the marks closer together in Prepare.';
    return { kind: 'reach', moves: [], why, wide, then: '', text: why.join(' ') + ' ' + wide };
  }
  const head = 'Move the sheet ' + moves.map((m) => m.mm + ' mm to the ' + m.dir).join(' and ') + '.';
  // (J0064: the camera was put over the dot, 42 mm from where the laser needed to be)
  const then = (anchored ? 'Then put the laser (not the camera) back over the top-left dot and press Start.'
    : 'Then switch Anchor to toolhead on, put the laser (not the camera) over the top-left dot and press Start.') + ' Or move the marks in Prepare.';
  return { kind: 'reach', moves, why, wide: '', then, text: head + ' ' + why.join(' ') + ' ' + then };
}
function reachMessage(r, anchored) { const i = reachInfo(r, anchored); return i ? i.text : null; }

// The same for a print and cut job whose cuts would go past the bed (anchor.overBed's answer), as
// it lies on the bed: the sheet is to be moved, not the head (which belongs on the dot). after:
// found once the marks were read (nothing cut yet). J0065: the X28 sheet's cuts reached X 1315
function fitInfo(ov, bed, anchored, after) {
  if (!ov || !(ov.left || ov.right || ov.back || ov.front)) return null;
  const [W, H] = bed, b = ov.box;
  const ten = (v) => Math.max(10, Math.ceil((v + 1e-6) / 10) * 10);
  const E = [
    ['right', ov.right, 'left', 'The cuts reach X ' + b[2].toFixed(0) + ', ' + Math.ceil(ov.right) + ' mm past the right end of the bed (' + W + ' mm).'],
    ['left', ov.left, 'right', 'The cuts reach ' + Math.ceil(ov.left) + ' mm past the left edge of the bed.'],
    ['back', ov.back, 'front', 'The cuts reach ' + Math.ceil(ov.back) + ' mm past the back of the bed.'],
    ['front', ov.front, 'back', 'The cuts reach Y ' + b[3].toFixed(0) + ', ' + Math.ceil(ov.front) + ' mm past the front of the bed (' + H + ' mm).']
  ].filter((e) => e[1]);
  const moves = E.map((e) => ({ dir: e[2], mm: ten(e[1]) }));
  const why = E.map((e) => e[3]);
  if ((ov.left && ov.right) || (ov.back && ov.front)) {
    const wide = 'The job is bigger than the bed. Make it smaller in Prepare.';
    return { kind: 'reach', title: 'The job doesn\'t fit on the bed', moves: [], why, wide, then: '', text: why.join(' ') + ' ' + wide };
  }
  const head = 'Move the sheet ' + moves.map((m) => m.mm + ' mm to the ' + m.dir).join(' and ') + '.';
  const then = (after ? 'Nothing was cut. ' : '') + (anchored ? 'Then put the laser (not the camera) back over the top-left dot and press Start.' : 'Then switch Anchor to toolhead on, put the laser (not the camera) over the top-left dot and press Start.');
  return { kind: 'reach', title: 'The job doesn\'t fit on the bed where the sheet is', moves, why, wide: '', then, text: head + ' ' + why.join(' ') + ' ' + then };
}

module.exports = { Vision, DEFAULTS, reach, reachInfo, reachMessage, fitInfo };

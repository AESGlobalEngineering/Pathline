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
const outline = require('./outline');
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
    const t0 = Date.now();
    await this.m.link.moveTo(Math.max(t[0], Math.min(t[2], x)), Math.max(t[1], Math.min(t[3], y)));
    const t1 = Date.now();
    await this.m.waitIdle(30000, 150, 40);
    if (opts.times) { opts.times.send += t1 - t0; opts.times.travel += Date.now() - t1; }
  }

  // the thing nearest the middle of the frame: kind 'dot' (d mm across) or 'corner'
  // kind 'hole': a hole in a plate with white under it, so a light dot in a darker surround (or,
  // where the steel shines brighter than the card, a dark one); 'plate': a plate's corner on a white
  // background (opts.toward: which way the plate lies from it, [±1, ±1] in bed X and Y).
  // opts.alsoLight: a registration mark not found as a dark dot is looked for as a hole too
  find(img, kind, d, opts = {}) {
    if (kind === 'corner') return detect.findCorner(img);
    if (kind === 'plate') return detect.findPlateCorner(img, { M: this.cfg.matrix, toward: opts.toward || [1, 1], r: opts.r || 0, c0: opts.expect, why: opts.why, printed: !!opts.printed });
    const px = this.pixelSize();
    // registration marks (d given) sit in plain white: only those count; calibration targets
    // (the cut mark on scrap, a dot under the camera) may have darker surroundings
    const o = d ? { minD: (d * 0.5) / px, maxD: (d * 1.6) / px, whiteRing: !!opts.whiteRing, fillHoles: !!opts.fillHoles } : {};
    if (kind === 'hole') return detect.findDots(img, { ...o, light: true })[0] || detect.findDots(img, o)[0] || null;
    const dots = detect.findDots(img, o);
    if (!dots.length && opts.alsoLight && d) return detect.findDots(img, { ...o, light: true })[0] || null;
    return dots[0] || null;
  }

  // where the thing really is, near p: camera over p, find, re-centre if needed
  // opts.times: { send, travel, look } ms added up (registration marks log them)
  // opts.aim [dx, dy] mm: the camera looks that far from p, with the thing expected that far from
  // the picture's middle (inside a rounded plate corner, so more of its straight edges are in view)
  async measure(p, kind, opts = {}) {
    const v = this.cfg;
    const aim = opts.aim || [0, 0];
    const o = { ...opts, expect: [-aim[0], -aim[1]] };
    let at = p.slice();
    for (let k = 0; k <= v.recentre; k++) {
      if (opts.ctl && opts.ctl.aborted) throw err('Stopped');
      const look = [at[0] + aim[0], at[1] + aim[1]];
      await this.moveCamera(look, opts);
      const tl = Date.now();
      const { img, hit } = await this.grabFind(kind, opts.d, o);
      if (opts.times) opts.times.look += Date.now() - tl;
      if (!hit) return null;
      const seen = this.toBed(img, hit);
      const found = [look[0] + seen[0], look[1] + seen[1]];
      const off = [found[0] - at[0], found[1] - at[1]];
      // a dot's size as the camera's calibration measures it (mm): against the size printed it
      // shows whether the sheet is at the height the camera was calibrated at
      const dotMm = (kind === 'dot' || kind === 'hole') && hit.d ? hit.d * this.pixelSize() : null;
      if (Math.hypot(off[0], off[1]) <= v.tolerance || k === v.recentre) return { found, off, tries: k + 1, hit, dotMm };
      at = found;
    }
    return null;
  }

  // A printed part's corner (Part edges), near p (outline.js): the camera looks from inside the
  // corner (cornerAim) and the corner is located in the picture from its outline, wherever it is;
  // not where it should be in the picture (the head put 12 mm off the job's first corner on J0115),
  // the camera is aimed again on it, up to 3 times. The outline fitted there gives the edges' turn;
  // then the camera is put right over the corner and it's read again there, where the camera's
  // scale on the print (1–6 % off on J0115) and the small turn of its calibration can't move it.
  // That picture is kept (frame) for readMarks to read once more with the turn all the job's
  // corners agree on. opts: { r, toward, dark (the job's print, once known), times, ctl, why }.
  // Returns { found, off, tries, hit, frame } or null.
  async measurePart(p, opts = {}) {
    const r = Math.max(0, Number(opts.r) || 0), toward = opts.toward || [1, 1];
    const why = opts.why || {};
    const M = this.cfg.matrix;
    const shot = async (look) => {
      if (opts.ctl && opts.ctl.aborted) throw err('Stopped');
      await this.moveCamera(look, opts);
      const tl = Date.now();
      let img = await this.grab();
      let q = outline.locate(img, M, toward, r, { dark: opts.dark });
      // (the Trotec's lamp lights part of the view: a print in its shadow shows at a longer exposure)
      for (const k of [3, 9]) { if (q && q.value >= 0.15) break; img = await this.grabTimes(k); q = outline.locate(img, M, toward, r, { dark: opts.dark }); }
      if (opts.times) opts.times.look += Date.now() - tl;
      return { img, q: q && q.value >= 0.15 ? q : null, cam: this.cameraAt([this.last.at.x, this.last.at.y]) };
    };
    let aim = this.cornerAim(r, toward);
    let at = p.slice(), s = null, tries = 0;
    for (let k = 0; k < 4; k++) {
      tries++;
      s = await shot([at[0] + aim[0], at[1] + aim[1]]);
      if (!s.q) { why.reason = 'no printed corner of this part in view'; return null; }
      if (k === 0) aim = this.cornerAim(r, toward); // (the picture's size known now)
      const seen = [s.cam[0] + s.q.c[0], s.cam[1] + s.q.c[1]];
      const off = Math.hypot(seen[0] - (at[0]), seen[1] - (at[1]));
      at = seen;
      if (s.q.seen > 0.9 && off < 2) break;
      if (k === 3) { why.reason = 'the corner kept moving as the camera was aimed on it'; return null; }
    }
    const f1 = outline.fit(s.img, M, toward, r, { c: [at[0] - s.cam[0], at[1] - s.cam[1]], dark: s.q.dark }, { fitR: true });
    if (!f1.bed) { why.reason = f1.fail; return null; }
    const c1 = [s.cam[0] + f1.bed[0], s.cam[1] + f1.bed[1]];
    // right over the corner, with the turn just found held
    tries++;
    if (opts.ctl && opts.ctl.aborted) throw err('Stopped');
    await this.moveCamera(c1, opts);
    const tl = Date.now();
    const img = await this.grab();
    if (opts.times) opts.times.look += Date.now() - tl;
    const cam = this.cameraAt([this.last.at.x, this.last.at.y]);
    const fr = { img, cam, toward, r, dark: s.q.dark, theta: f1.theta };
    // (held at the turn the job's corners so far agree on, once there are some: steadier than one's own)
    const hold = Number.isFinite(opts.theta) ? opts.theta : f1.theta;
    const f2 = outline.fit(img, M, toward, r, { c: [c1[0] - cam[0], c1[1] - cam[1]], dark: s.q.dark }, { fitR: true, theta: hold, mustSettle: true });
    if (!f2.bed) { why.reason = f2.fail; return null; }
    const found = [cam[0] + f2.bed[0], cam[1] + f2.bed[1]];
    // more than a mm from where the first picture had it: not the same corner
    if (Math.hypot(found[0] - c1[0], found[1] - c1[1]) > 1) { why.reason = 'read ' + Math.hypot(found[0] - c1[0], found[1] - c1[1]).toFixed(1) + ' mm apart from two places'; return null; }
    const [u, v] = outline.frame(img, M).toPx(f2.bed[0], f2.bed[1]);
    const hit = { x: u, y: v, bed: f2.bed, r, angles: [f1.theta, f1.theta], rotation: f1.theta, squareness: 0, plateBrighter: !s.q.dark, printed: true, outline: true, radius: f2.r, spread: f2.spread, points: f2.points, rms: f2.spread };
    return { found, off: [found[0] - p[0], found[1] - p[1]], tries, hit, frame: fr };
  }

  // how far the last picture reaches from its middle along bed X and Y (mm); null before the first
  fieldHalf() {
    const img = this.last && this.last.img;
    if (!img) return null;
    const [a, b, c, d] = this.cfg.matrix;
    return [(Math.abs(a) * img.w + Math.abs(b) * img.h) / 2, (Math.abs(c) * img.w + Math.abs(d) * img.h) / 2];
  }

  // where to aim the camera from a rounded corner (radius r, plate toward [sx, sy]): inside the
  // plate by r along both, so the straight edges past the rounding fill the picture; never so far
  // that an edge leaves it (2.5 mm in from the picture's side at least)
  cornerAim(r, toward) {
    if (!(r > 0)) return [0, 0];
    const fh = this.fieldHalf() || [12, 12];
    const k = Math.max(0, Math.min(r, Math.min(fh[0], fh[1]) - 2.5));
    return [toward[0] * k, toward[1] * k];
  }

  // The last picture looked at for a mark, kept for finding out why a mark was missed: half size,
  // grey bytes after a 4-byte header (width, height as 16-bit), gzipped, in the data folder's
  // marks/<job>/ (the last few jobs': a job's own pictures were gone once the next job read its
  // marks, J0112's part edges among them), with what was looked for and found beside it
  // (shrinking and packing a 5 MP picture takes a moment: done once the head is on its way to
  // the next mark, not before it sets off)
  saveMarkFrame(name, info) {
    const dir = this.markDir;
    const last = this.last;
    if (!dir || !last) return;
    const extra = { head: last.at, exposure: this.exposureNow(), pixel: this.pixelSize(), half: true };
    setTimeout(() => {
      try {
        const fs = require('fs');
        fs.mkdirSync(dir, { recursive: true });
        const s = detect.shrink(last.img, Math.max(last.img.w, last.img.h) / 2);
        const b = Buffer.alloc(4 + s.w * s.h);
        b.writeUInt16BE(s.w, 0); b.writeUInt16BE(s.h, 2);
        for (let i = 0; i < s.w * s.h; i++) b[4 + i] = Math.round(s.data[i]);
        fs.writeFileSync(require('path').join(dir, name + '.bin.gz'), require('zlib').gzipSync(b));
        fs.writeFileSync(require('path').join(dir, name + '.json'), JSON.stringify({ ...info, ...extra }, null, 1));
      } catch (e) { this.log('mark picture not kept: ' + e.message); }
    }, 30);
  }

  // a job's pictures go in marks/<job> (emptied first: the job read again); the 5 jobs read most
  // recently are kept, older ones (and pictures loose in marks/, kept before 0.7.17) removed
  clearMarkFrames(job) {
    const fs = require('fs'), path = require('path');
    const root = this.m.store && this.m.store.dir && path.join(this.m.store.dir, 'marks');
    this.markDir = null;
    if (!root) return;
    const name = String(job || 'job').replace(/[^A-Za-z0-9_-]/g, '') || 'job';
    try {
      this.markDir = path.join(root, name);
      fs.rmSync(this.markDir, { recursive: true, force: true });
      fs.mkdirSync(this.markDir, { recursive: true });
      const all = fs.readdirSync(root, { withFileTypes: true });
      for (const e of all) if (!e.isDirectory()) fs.rmSync(path.join(root, e.name), { force: true });
      const dirs = all.filter((e) => e.isDirectory() && e.name !== name).map((e) => ({ n: e.name, t: fs.statSync(path.join(root, e.name)).mtimeMs })).sort((a, b) => b.t - a.t);
      for (const d of dirs.slice(4)) fs.rmSync(path.join(root, d.n), { recursive: true, force: true });
    } catch (e) { /* kept as far as it went */ }
  }

  // ---------------------------------------------------------------- print and cut
  // Reads the job's registration marks in Pathline's order; returns the fit (design → found).
  // opts.anchored: the job was put at the laser as Start was pressed
  async readMarks(pkg, ctl = {}, status = () => {}, opts = {}) {
    const steps = (pkg.toolpath || []).filter((s) => s.type === 'inspect');
    const E = [], D = [];
    const sizes = []; // each mark's measured diameter against the printed one
    const turns = []; // each plate corner's edges: how the plate lies (degrees)
    const squares = []; // each plate corner: its radius and how far its edges are off square
    let byHand = false;
    // Part edges (regMarks.kind 'edge'): each corner is a printed part's, on its own cut line (the
    // part is cut as normal). Found from the print's edges, and the job fitted to the corners like
    // marks: printed sheets stretch, so it's stretched to them too (Full linear from three corners)
    const edges = (pkg.regMarks && pkg.regMarks.kind === 'edge') || steps.some((s) => s.kind === 'corner' && s.part);
    let partDark; // (part edges: the print against what's past it, from the first corner)
    const frames = []; // (part edges: each corner's picture with it in the middle, read again below)
    this.clearMarkFrames(opts.job);
    for (const s of steps) {
      // what the mark is (PROTOCOL.md): a printed dot (the default), a hole in the plate (white under
      // it), or the plate's corner on a white background
      const kind = s.kind === 'corner' ? 'plate' : s.kind === 'hole' ? 'hole' : 'dot';
      // a rounded plate corner: r, its radius (mm); `at` is where the straight edges meet. The
      // camera looks from inside the plate (cornerAim: worked out from the picture's size, known
      // once the camera has taken one), and why says what the corner finder last missed
      const rad = kind === 'plate' ? Math.max(0, Number(s.r) || 0) : 0;
      const why = {};
      const what = () => ({ kind, toward: s.toward, alsoLight: kind === 'dot', r: rad, why, printed: kind === 'plate' && edges, ...(kind === 'plate' ? { aim: this.cornerAim(rad, s.toward || [1, 1]) } : {}) });
      // predict from the marks found so far: the shift from one; shift and rotation from two (their
      // scale is one distance, and carried 740 mm out to the third mark it put a 6 % stretch's
      // worth, 45 mm, into the prediction); the full fit from three
      // (after one corner: turned as its edges lie, as well as moved; a sheet turned 0.5° puts the
      // corner diagonally across it 13 mm from where a shift alone would look)
      const pred = E.length === 1 && turns.length === 1 ? fitting.pose(E[0], D[0], turns[0])(s.at)
        : E.length ? fitting.fit(E, D, E.length === 1 ? 'shift' : E.length === 2 ? 'rigid' : 'affine')(s.at) : s.at;
      status('Reading mark ' + s.mark + ' of ' + s.of);
      // where each mark's time goes (logged): sending the move, the head travelling and settling,
      // the pictures and finding the dot
      const times = { send: 0, travel: 0, look: 0 }, tm0 = Date.now();
      // printed part corners: read as their outline, with the corner in the middle of the picture
      // (measurePart); the print's darker or lighter than past it as the job's first corner showed
      const part = kind === 'plate' && edges;
      const thSoFar = frames.length ? frames.map((q) => q.theta).sort((a, b) => a - b)[(frames.length - 1) >> 1] : undefined;
      const read = (p, extra = {}) => (part ? this.measurePart(p, { r: rad, toward: s.toward || [1, 1], dark: partDark, theta: thSoFar, why, ctl, ...extra }) : this.measure(p, kind, { d: s.d, ctl, whiteRing: true, ...what(), ...extra }));
      let r = await read(pred, { times });
      this.saveMarkFrame('mark' + s.mark, { mark: s.mark, kind, toward: s.toward, design: s.at, expected: pred, d: s.d, found: r ? r.found : null, hit: r ? r.hit : null });
      // Anchored, and the first mark isn't there: the camera may have been put over the dot at
      // Start in place of the laser (J0064: every mark 42, 19 mm off, the camera's offset). Look
      // one offset over before asking for the camera to be jogged by hand
      if (!r && !E.length && opts.anchored) {
        const o = this.cfg.offset, alt = [pred[0] - o[0], pred[1] - o[1]];
        status('Reading mark ' + s.mark + ' of ' + s.of + ' (as if the camera was put over the dot)');
        r = await read(alt).catch((e) => { if (ctl.aborted) throw e; return null; });
        if (r) this.log('mark ' + s.mark + ': found one camera offset from where it should be: the camera, not the laser, was put over the dot at Start. Put the laser over it next time');
      }
      // not where it should be: the job waits while the user jogs the camera over it (Jog page),
      // then the dot finder looks again from there. Put there by hand, the dot nearest the
      // crosshair counts even without clean white round it (artwork close by may be why it was missed)
      for (let again = false; !r; again = true) {
        byHand = true;
        this.log('mark ' + s.mark + (again ? ' still not found' : ' not found near ' + pred.map((v) => v.toFixed(1)).join(', ') + ' mm') + (why.reason ? ' (' + why.reason + ')' : '') + ': waiting for the camera to be jogged over it');
        const at = await this.m.waitForMark({ mark: s.mark, of: s.of, near: pred, again, kind: s.kind === 'corner' || s.kind === 'hole' ? s.kind : 'dot', r: rad, why: why.view ? why.reason : null, part: kind === 'plate' && edges, toward: s.toward }, ctl);
        delete why.reason; delete why.view;
        status('Reading mark ' + s.mark + ' of ' + s.of + ' where the camera was put');
        r = await read(at, { whiteRing: false });
        this.saveMarkFrame('mark' + s.mark + '-hand' + (again ? '2' : ''), { mark: s.mark, kind, toward: s.toward, design: s.at, expected: pred, camera: at, d: s.d, found: r ? r.found : null, hit: r ? r.hit : null });
        if (r) this.log('mark ' + s.mark + ': found by hand, ' + Math.hypot(r.found[0] - pred[0], r.found[1] - pred[1]).toFixed(2) + ' mm from where it was expected; the camera was put ' + Math.hypot(r.found[0] - at[0], r.found[1] - at[1]).toFixed(2) + ' mm from it');
      }
      E.push(s.at); D.push(r.found);
      if (part) { partDark = !r.hit.plateBrighter; frames.push({ i: D.length - 1, mark: s.mark, ...r.frame }); }
      // (printed dots only: a hole's size is the cut's, not the camera's height)
      if (kind === 'dot' && !r.hit.light && r.dotMm && s.d) sizes.push(r.dotMm / s.d);
      if (kind === 'plate') { turns.push(r.hit.rotation); squares.push({ r: rad, sq: r.hit.squareness }); }
      const sec = (ms) => (ms / 1000).toFixed(2) + ' s';
      const seen = part && r.hit.outline
        ? '; printed corner of part ' + (s.part || '?') + ', r ' + rad + ' mm (where its straight edges meet), read with it in the middle of the picture: edges at ' + r.hit.rotation.toFixed(2) + '°' + (rad ? ', rounding read ' + r.hit.radius.toFixed(2) + ' mm (the camera\'s scale there ' + ((r.hit.radius / rad - 1) * 100).toFixed(1) + ' %)' : '') + ', outline within ' + (r.hit.spread * 1000).toFixed(0) + ' µm, print ' + (r.hit.plateBrighter ? 'lighter' : 'darker') + ' than past it'
        : kind === 'plate' && edges
        ? '; printed corner of part ' + (s.part || '?') + ', r ' + rad + ' mm (where its straight edges meet), edges at ' + r.hit.angles.map((v) => v.toFixed(2) + '°').join(' and ') + ' (' + Math.abs(r.hit.squareness).toFixed(2) + '° off square), print ' + (r.hit.plateBrighter ? 'lighter' : 'darker') + ' than past it' + (r.hit.sharp ? ', edges ' + r.hit.sharp.map((v) => v.toFixed(2)).join(' / ') + ' mm sharp' : '')
        : kind === 'plate'
        ? '; plate corner' + (rad ? ' (rounded, r ' + rad + ' mm: where its straight edges meet)' : '') + ', edges at ' + r.hit.angles.map((v) => v.toFixed(2) + '°').join(' and ') + ' (' + Math.abs(r.hit.squareness).toFixed(2) + '° off square), plate ' + (r.hit.plateBrighter ? 'lighter' : 'darker') + ' than the background'
        : r.dotMm ? '; ' + (r.hit.light ? (kind === 'hole' ? 'hole ' : 'found as a hole (light, in a darker surround) ') : kind === 'hole' ? 'hole (darker than the plate round it) ' : 'dot ') + r.dotMm.toFixed(2) + ' mm across (' + s.d + ' expected)' : '';
      this.log('mark ' + s.mark + ': expected ' + s.at.map((v) => v.toFixed(2)).join(', ') + ', found ' + r.found.map((v) => v.toFixed(3)).join(', ') + ' (' + r.tries + ' frame' + (r.tries > 1 ? 's' : '') + '); ' +
        sec(Date.now() - tm0) + ': sending ' + sec(times.send) + ', travel and settle ' + sec(times.travel) + ', pictures ' + sec(times.look) + seen);
    }
    // Part edges, two or more corners: each read once more from its picture, with the edges' turn
    // held at what the corners say together (their middle value), not each its own: a few mm of
    // straight edge past a rounding give the turn to a degree at best (J0115's corner 4 read 1.55°
    // in its picture, the other three 0.84–0.91°), and with the corner in the middle the turn
    // carries the corner sideways, 0.17 mm a degree over a 10 mm rounding. The parts are printed
    // square to the sheet, and the camera's own small turn is the same in every picture.
    if (frames.length >= 2) {
      const th = frames.map((q) => q.theta).sort((a, b) => a - b);
      const mid = th.length % 2 ? th[th.length >> 1] : (th[th.length / 2 - 1] + th[th.length / 2]) / 2;
      const moved = [];
      for (const q of frames) {
        const f = outline.fit(q.img, this.cfg.matrix, q.toward, q.r, { c: [D[q.i][0] - q.cam[0], D[q.i][1] - q.cam[1]], dark: q.dark }, { fitR: true, theta: mid, mustSettle: true });
        if (!f.bed) { moved.push(q.mark + ' kept (' + f.fail + ')'); continue; }
        const now = [q.cam[0] + f.bed[0], q.cam[1] + f.bed[1]];
        moved.push(q.mark + ' ' + (Math.hypot(now[0] - D[q.i][0], now[1] - D[q.i][1]) * 1000).toFixed(0) + ' µm');
        D[q.i] = now;
      }
      this.log('part corners read again with their edges at ' + mid.toFixed(2) + '° in the picture (each corner\'s own: ' + frames.map((q) => q.theta.toFixed(2) + '°').join(', ') + '): moved ' + moved.join(', ') + '; now ' + frames.map((q) => q.mark + ' at ' + D[q.i].map((v) => v.toFixed(3)).join(', ')).join(', '));
    }
    // the marks found must be as far apart as the job's: a dot that isn't the mark (a hole in the
    // bed through clear acrylic, artwork) bent the job 5 % one way and 6 % the other, and it was cut
    // off the print. Over 1 % (2 mm at least) out: stop before anything is cut.
    // Not with Non-linear: it's chosen for a print that has stretched (or shrunk) unevenly, and it
    // bends the job to the marks wherever they're found, so the difference is only logged
    const bends = pkg.regMarks && pkg.regMarks.mode === 'nonlinear';
    for (let i = 0; i < E.length; i++) {
      for (let j = i + 1; j < E.length; j++) {
        const de = Math.hypot(E[j][0] - E[i][0], E[j][1] - E[i][1]), dd = Math.hypot(D[j][0] - D[i][0], D[j][1] - D[i][1]);
        if (Math.abs(dd - de) > Math.max(2, 0.01 * de)) {
          if (bends) {
            this.log('print and cut: marks ' + steps[i].mark + ' and ' + steps[j].mark + ' found ' + dd.toFixed(1) + ' mm apart, ' + de.toFixed(1) + ' mm in the job (' + ((dd / de - 1) * 100).toFixed(1) + ' %): Non-linear, so the job follows the marks');
            continue;
          }
          this.log('print and cut: marks ' + steps[i].mark + ' and ' + steps[j].mark + ' found ' + dd.toFixed(1) + ' mm apart, ' + de.toFixed(1) + ' mm in the job: stopped');
          throw err('Registration marks ' + steps[i].mark + ' and ' + steps[j].mark + ' were found ' + dd.toFixed(1) + ' mm apart, but they are ' + de.toFixed(1) + ' mm apart in the job. One of them wasn\'t the mark (or the sheet isn\'t this job\'s). Nothing was cut.');
        }
      }
    }
    // a plate's corners: the plate is its own size, so it's only moved and turned (never stretched
    // to the corners, whatever the job's mode); one corner gives the turn from its edges
    let type = fitting.typeFor(pkg.regMarks && pkg.regMarks.mode, E.length);
    // Printed part corners are fitted like marks, stretch and all: Full linear from three (the
    // job's Non-linear kept with four or more), shift, turn and one scale from two
    if (turns.length) {
      if (E.length === 1) type = 'corner';
      else if (!edges) type = 'rigid';
      else if (E.length === 2) type = 'similar';
      else if (type !== 'nonlinear') type = 'affine';
    }
    const f = type === 'corner' ? fitting.pose(E[0], D[0], turns[0]) : fitting.fit(E, D, type);
    const i = f.info;
    // (plate corners: their radius, and the angle between each corner's two edges; four or more
    // printed corners: how far the worst lies from the fit, as the print may not be straight)
    const cornerNote = turns.length ? ', ' + (edges ? 'part' : 'plate') + ' corners r ' + [...new Set(squares.map((q) => q.r))].join(' / ') + ' mm, edges off square by ' + squares.map((q) => Math.abs(q.sq).toFixed(2) + '°').join(', ') +
      (edges && E.length >= 4 && type !== 'nonlinear' ? ', residual ' + i.residual.toFixed(3) + ' mm' : '') : '';
    this.log('print and cut: ' + i.type + ', shift ' + i.shift.map((v) => v.toFixed(3)).join(', ') + ' mm, rotation ' + i.rotation.toFixed(3) + '°, scale ' + ((i.scaleX - 1) * 1000).toFixed(2) + ' / ' + ((i.scaleY - 1) * 1000).toFixed(2) + ' mm/m' + cornerNote);
    // the plate's edges against the corners' positions: more than 1° apart, a corner found may be
    // something else's edge, or the plate isn't straight-sided (only logged)
    if (turns.length && E.length > 1) {
      const off = turns.map((t) => t - i.rotation), worst = Math.max(...off.map(Math.abs));
      const what = edges ? 'part' : 'plate';
      if (worst > 1) this.log('print and cut: the ' + what + 's\' edges lie ' + turns.map((t) => t.toFixed(2) + '°').join(', ') + ', the corners together ' + i.rotation.toFixed(2) + '°: a corner may not be the ' + what + '\'s, or its edges aren\'t straight');
    }
    const height = await this.heightCheck(sizes);
    return { f, expected: E, found: D, info: i, byHand, height };
  }

  // The camera measures right only at the height it was calibrated at: the picture's scale goes
  // with the distance to the surface (the 3 Nov calibration, on a board the table wasn't focused
  // on, was 4 % out). Two checks, each only a warning in the log:
  //   - the marks' size: printed dots measured more than 5 % larger (nearer the camera) or smaller
  //     than printed. (Printers spread a dot a little, so a few % is normal.)
  //   - with the head Z axis: its sensor's distance against what it read at camera calibration.
  async heightCheck(sizes) {
    const out = {};
    const ok = sizes.filter((s) => Number.isFinite(s) && s > 0).sort((a, b) => a - b);
    if (ok.length) {
      out.dots = +ok[ok.length >> 1].toFixed(3);
      if (Math.abs(out.dots - 1) > 0.05) this.log('camera: the marks measure ' + Math.abs((out.dots - 1) * 100).toFixed(0) + ' % ' + (out.dots > 1 ? 'larger' : 'smaller') + ' than printed: the sheet is ' + (out.dots > 1 ? 'nearer the camera' : 'further from the camera') + ' than the board was when the camera was calibrated (is the table focused on the sheet?), or the print was scaled');
    }
    const z = await this.sensorNow();
    if (Number.isFinite(z) && Number.isFinite(this.cfg.cameraSensor)) {
      out.sensor = +(z - this.cfg.cameraSensor).toFixed(2);
      if (Math.abs(out.sensor) > 1.5) this.log('camera: the sheet is ' + Math.abs(out.sensor).toFixed(1) + ' mm ' + (out.sensor < 0 ? 'nearer' : 'further') + ' than the board was at camera calibration (Z axis sensor); its measurements scale with that');
    }
    return out;
  }

  // the head Z axis sensor's distance now (mm), when it's on and ready
  async sensorNow() {
    const z = this.m.zaxis;
    try { if (z && z.enabled && z.enabled() && z.state === 'ready') return (await z.read(8)).mm; } catch (e) { /* not available */ }
    return null;
  }

  // the job without its inspect steps, moved onto the marks found
  static corrected(pkg, f) {
    const out = fitting.transformPkg({ ...pkg, toolpath: (pkg.toolpath || []).filter((s) => s.type !== 'inspect') }, f);
    return out;
  }

  // ---------------------------------------------------------------- calibration
  // Stage 1, camera: a small checkerboard (10 mm squares) under the camera, filling the picture.
  // Its corners are something sharp to follow; how far they stray from a perfect grid shows how
  // much the lens bends straight lines. The head moves a little along X, then Y (under half a
  // square, so a corner followed can't be mistaken for its neighbour), and how far the corners
  // move gives the pixel size along X and Y, which way the picture is turned and whether it's
  // mirrored. A printed board is seldom quite to scale, so its own size is only reported. The
  // board can lie at any angle.
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
    const detA = L.a[0] * L.b[1] - L.a[1] * L.b[0]; // px² per square
    const boardPixel = square / Math.sqrt(Math.abs(detA)); // as printed: only a first guess
    // The head moves a little along X, then Y, and the board's corners follow in the picture.
    // Every corner on the grid is followed (a false one, a soft edge or a shadow, could be
    // nearer), and the steps averaged: one corner, near the edge where the lens bends most, was
    // off by a pixel or two, and the X and Y sizes came out up to 0.8 % apart.
    const d = square * 0.3;
    const reach = (d / boardPixel) * 1.6;
    const follow = async (x, y) => {
      await this.m.link.moveTo(x, y);
      await this.m.waitIdle(30000, 150);
      const Lk = detect.fitLattice(detect.findCornersIn(await this.grabSteps()));
      const cs = Lk ? Lk.points : [];
      const steps = [];
      for (const c0 of L.points) {
        let near = null, best = Infinity;
        for (const c of cs) { const g = Math.hypot(c.x - c0.x, c.y - c0.y); if (g < best) { best = g; near = c; } }
        if (near && best <= reach) steps.push([near.x - c0.x, near.y - c0.y]);
      }
      if (!steps.length) throw err('Lost the board while moving: keep it flat under the camera and try again');
      // the step most corners agree on (a corner matched to its neighbour would stray): the
      // median, then the mean of those near it
      const med = [0, 1].map((k) => steps.map((s) => s[k]).sort((p, q) => p - q)[steps.length >> 1]);
      const near = steps.filter((s) => Math.hypot(s[0] - med[0], s[1] - med[1]) < 2);
      return [0, 1].map((k) => near.reduce((t, s) => t + s[k], 0) / near.length);
    };
    let u1, u2;
    try { u1 = await follow(start.x + d, start.y); u2 = await follow(start.x, start.y + d); } finally {
      await this.m.link.moveTo(start.x, start.y);
      await this.m.waitIdle(30000, 150);
    }
    // the head moves +d → the board moves u px in the picture: A·u = −d along that axis. The size
    // and shape come from these moves, not from the board's print: on Ruby a printed 10 mm board
    // measured 10.12 × 10.07 mm by the head's moves (a printer's scaling), which would have put
    // the size 1 % out and the pixels 0.5 % from square. The machine itself is within 0.2 %
    // (the bed checkerboard map), and averaged over the corners the moves repeat to 0.05 %.
    const det = u1[0] * u2[1] - u1[1] * u2[0];
    if (Math.abs(det) < 1) throw err('The picture hardly moved: is the camera on?');
    const inv = [u2[1] / det, -u2[0] / det, -u1[1] / det, u1[0] / det];
    const matrix = inv.map((v) => +(-d * v).toPrecision(8));
    const pixel = Math.sqrt(Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2]));
    const rotation = (Math.atan2(matrix[2], matrix[0]) * 180) / Math.PI;
    const mirrored = matrix[0] * matrix[3] - matrix[1] * matrix[2] < 0;
    // the board's squares as the head's moves measure them (mm): how true its print is
    // (mm), the one nearer the machine's X first
    const mmOf = (v) => [matrix[0] * v[0] + matrix[1] * v[1], matrix[2] * v[0] + matrix[3] * v[1]];
    const ma = mmOf(L.a), mb = mmOf(L.b);
    const squares = (Math.abs(ma[0]) >= Math.abs(mb[0]) ? [ma, mb] : [mb, ma]).map((v) => +Math.hypot(v[0], v[1]).toFixed(3));
    const r = {
      matrix, pixel, rotation, mirrored, corners: L.n,
      lens: L.worst * pixel, squares,
      // the picture's X and Y pixel sizes: the same on a camera looking straight down
      pixelXY: [Math.hypot(matrix[0], matrix[1]), Math.hypot(matrix[2], matrix[3])],
      // how far the board's print is from its size (‰, the mean of across and down)
      moveVsBoard: ((squares[0] + squares[1]) / (2 * square) - 1) * 1000
    };
    // the head Z axis sensor's distance here, when there is one: jobs compare against it
    r.sensor = await this.sensorNow();
    const off = squares.some((s) => Math.abs(s / square - 1) > 0.005);
    this.log('camera calibrated on the ' + square + ' mm board: ' + L.n + ' corners, pixel size ' + (pixel * 1000).toFixed(3) + ' µm (X ' + (r.pixelXY[0] * 1000).toFixed(3) + ', Y ' + (r.pixelXY[1] * 1000).toFixed(3) + '), picture turned ' + rotation.toFixed(2) + '°' + (mirrored ? ' (mirrored)' : '') + ', lens bends lines up to ' + (r.lens * 1000).toFixed(0) + ' µm; the board\'s squares measure ' + squares[0].toFixed(2) + ' × ' + squares[1].toFixed(2) + ' mm' + (off ? ' (printed off scale: the size is taken from the head\'s moves, so it doesn\'t matter here)' : ''));
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
    // The first corner may be out of the camera's reach (the camera sits beside the laser, so a
    // board reaching the bed's edge has corners only the laser can get over) or not seen: like
    // any other corner it's then left out, and the scan goes on from where the head is, along the
    // machine's axes, until it finds one. A board doesn't need every corner of every row seen.
    let first = null;
    try { first = await this.measure(cam0, 'corner', { raw, ctl }); } catch (e) { if (ctl.aborted) throw e; this.log('first corner: ' + e.message); }
    // which way the board's lines run: a corner's angle in the frame, turned onto the bed
    let u = [1, 0], v = [0, 1];
    const lines = (hit) => {
      const [a, bm, c, dm] = this.cfg.matrix;
      const ai = ((hit.angle || 0) * Math.PI) / 180;
      let th = Math.atan2(c * Math.cos(ai) + dm * Math.sin(ai), a * Math.cos(ai) + bm * Math.sin(ai));
      // of the board's two line directions, u is the one nearest +X, v nearest +Y
      th = Math.atan2(Math.sin(th * 4), Math.cos(th * 4)) / 4; // fold into −45…45°
      u = [Math.cos(th), Math.sin(th)]; v = [-Math.sin(th), Math.cos(th)];
    };
    if (first) lines(first.hit);
    const grid = [], found = [];
    const order = [];
    for (let j = 0; j < nj; j++) for (let k = 0; k < ni; k++) order.push([j % 2 ? ni - 1 - k : k, j]); // back and forth
    let missed = 0, unreachable = 0;
    for (const [i, j] of order) {
      if (ctl.aborted) throw err('Stopped');
      const g = [i * step, j * step];
      // predict from the corners found so far (board → bed, rotation + shift); from one corner,
      // or none yet (from the first corner's place under the laser), along the board's lines
      const o = grid.length ? [found[0], grid[0]] : [first ? first.found : cam0, [0, 0]];
      const dg = [g[0] - o[1][0], g[1] - o[1][1]];
      const pred = grid.length >= 2 ? fitting.fit(grid, found, 'rigid')(g) : [o[0][0] + dg[0] * u[0] + dg[1] * v[0], o[0][1] + dg[0] * u[1] + dg[1] * v[1]];
      status('Corner ' + (grid.length + missed + 1) + ' of ' + order.length);
      let r = null;
      try { r = await this.measure(pred, 'corner', { raw, ctl }); } catch (e) {
        if (ctl.aborted) throw e;
        if (/can't reach/.test(e.message)) unreachable++; else this.log('corner ' + i + ', ' + j + ': ' + e.message);
      }
      if (!r) { missed++; continue; }
      if (!grid.length && !first) lines(r.hit);
      grid.push(g); found.push(r.found);
    }
    if (unreachable) this.log('checkerboard: ' + unreachable + ' corners out of the camera\'s reach (it sits beside the laser), left out');
    if (grid.length < 4) {
      if (!first && grid.length === 0) throw err('No checkerboard corners found. Jog the laser head over the board\'s top-left corner, then start again.');
      throw err('Only ' + grid.length + ' corners found: check the board size in Setup → Camera');
    }
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

// How far the sheet lies turned from the job as drawn, from the marks' fit (rotation, ° from +X
// towards +Y: Y runs to the front, so seen from above a positive angle is clockwise), against
// cfg.placementAngle. Only for a job that engraves: the engraving lines run along the bed's X
// whatever way the sheet lies, so a sheet turned 45° (J0094) engraves its lines 45° across the
// part, and parts placed at different angles come out with their lines different ways.
//   → { act: 'run' | 'ask' | 'stop', angle (°, signed), text }
function placementCheck(info, pkg, cfg) {
  const lim = { ask: 5, stop: 10, ...((cfg && cfg.placementAngle) || {}) };
  let a = info && Number.isFinite(info.rotation) ? info.rotation : 0;
  a = ((((a + 180) % 360) + 360) % 360) - 180;
  const engraves = (pkg.toolpath || []).some((s) => s.type === 'engrave');
  const by = Math.abs(a);
  const turned = by.toFixed(1) + '° ' + (a > 0 ? 'clockwise' : 'anticlockwise');
  if (!engraves || !(by > lim.ask)) return { act: 'run', angle: a, text: '' };
  if (by <= lim.stop) {
    return { act: 'ask', angle: a, text: 'The sheet is turned ' + turned + ' from the job as drawn, so the engraving lines will cross the parts at ' + by.toFixed(1) + '° to the usual direction. Up to ' + lim.ask + '° runs without asking.' };
  }
  return { act: 'stop', angle: a, text: 'The sheet is turned ' + turned + ' from the job as drawn (more than ' + lim.stop + '°): the engraving lines would cross the parts ' + by.toFixed(0) + '° from the usual direction. Turn the sheet so it lies within ' + lim.ask + '° of the job, then start again. Nothing was cut.' };
}

module.exports = { Vision, DEFAULTS, reach, reachInfo, reachMessage, fitInfo, placementCheck };

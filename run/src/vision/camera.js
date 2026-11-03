// The head camera. Every camera has the same shape:
//   open() → { model, serial, width, height }   grab() → { w, h, data: Uint8Array grey }   close()
//   setExposure(µs | 'auto')
//
// VimbaCamera: the Trotec's Allied Vision Alvium (1800 U-500c, USB3 Vision, TROTEC_PROTOCOL.md
// §7.1) through Allied Vision's Vimba X SDK (VmbC), called with koffi: no compiling. Install
// Vimba X (free from alliedvision.com) on the PC or Pi; it plugs straight into the computer.
// Only one program can hold the camera: close Ruby / JobDispatcher first.
//
// SimCamera: draws what a head camera would see over a made-up bed (printed dots, a checkerboard
// at any angle, laser marks), for testing everything without the machine. It has its own
// "true" camera offset, pixel size and machine error, so calibration has something to find.
'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- Vimba X (VmbC)
function vmbLibrary() {
  const tried = [];
  const add = (p) => { if (p && !tried.includes(p)) tried.push(p); };
  const home = process.env.VIMBA_X_HOME;
  if (process.platform === 'win32') {
    if (home) add(path.join(home, 'bin', 'VmbC.dll'));
    add('C:\\Program Files\\Allied Vision\\Vimba X\\bin\\VmbC.dll');
  } else {
    if (home) add(path.join(home, 'api', 'lib', 'libVmbC.so'));
    for (const base of ['/opt', process.env.HOME || '/root']) {
      try { for (const d of fs.readdirSync(base)) if (/^VimbaX/i.test(d)) add(path.join(base, d, 'api', 'lib', 'libVmbC.so')); } catch (e) { /* no folder */ }
    }
  }
  return { file: tried.find((p) => fs.existsSync(p)), tried };
}

// The USB transport layer (GenTL .cti) to load, one only. Vimba X otherwise loads its own and
// every other one it's pointed at (GENICAM_GENTL64_PATH: Ruby's VimbaUSBTL 1.4), and two USB
// transports driving one camera locked up the camera's driver (Pathline Run 0.7.4). Vimba X's own
// is the one: on Ruby's PC it took 220 pictures in a row without a miss, as Ruby's 1.4 did, and
// it reads the camera's serial (1.4 says N/A). Ruby's 1.4 only where Vimba X's own is missing.
// opts: 'auto' or a file path.
function usbTransport(choice) {
  if (choice && choice !== 'auto') return fs.existsSync(choice) ? choice : null;
  const found = [];
  for (const dir of String(process.env.GENICAM_GENTL64_PATH || '').split(path.delimiter).filter(Boolean)) {
    try { for (const f of fs.readdirSync(dir)) if (/usb.*\.cti$/i.test(f)) found.push(path.join(dir, f)); } catch (e) { /* not there */ }
  }
  const home = process.env.VIMBA_X_HOME;
  const own = [home && path.join(home, 'cti', 'VimbaUSBTL.cti'), 'C:\\Program Files\\Allied Vision\\Vimba X\\cti\\VimbaUSBTL.cti'];
  const ruby = found.find((f) => /VimbaUSBTL_1\.4/i.test(f));
  return own.find((f) => f && fs.existsSync(f)) || ruby || found[0] || null;
}

const PIX = { Mono8: 0x01080001, BayerGR8: 0x01080008, BayerRG8: 0x01080009, BayerGB8: 0x0108000a, BayerBG8: 0x0108000b, RGB8: 0x02180014, BGR8: 0x02180015 };

const VMB_BUSY = -24; // VmbErrorBusy: another program (or one just ended) still holds the camera
const MAX_EXPOSURE = 600000; // µs: the longest exposure used (auto and stepped)

// Vimba X VmbC (VmbCTypeDefinitions.h): the structs and calls used here, once per process: koffi
// takes a struct name only once, so opening the camera a second time in the same process failed
// ("Duplicate type name 'VmbCameraInfo_t'")
let api = null;
function vmbApi(file) {
  if (api) return api;
  const koffi = require('koffi');
  const lib = koffi.load(file);
  const CameraInfo = koffi.struct('VmbCameraInfo_t', {
    cameraIdString: 'const char *', cameraIdExtended: 'const char *', cameraName: 'const char *', modelName: 'const char *',
    serialString: 'const char *', transportLayerHandle: 'void *', interfaceHandle: 'void *', localDeviceHandle: 'void *',
    streamHandles: 'void *', streamCount: 'uint32', permittedAccess: 'uint32'
  });
  const Frame = koffi.struct('VmbFrame_t', {
    buffer: 'void *', bufferSize: 'uint32', context: koffi.array('void *', 4),
    receiveStatus: 'int32', frameID: 'uint64', timestamp: 'uint64', imageData: 'void *',
    receiveFlags: 'uint32', pixelFormat: 'uint32', width: 'uint32', height: 'uint32',
    offsetX: 'uint32', offsetY: 'uint32', payloadType: 'uint32', chunkDataPresent: 'uint8'
  });
  const f = (sig) => lib.func(sig);
  // VmbStartup's path is wide characters on Windows
  const pathType = process.platform === 'win32' ? 'const char16_t *' : 'const char *';
  const vmb = {
    startup: f('int32 VmbStartup(' + pathType + ' path)'),
    shutdown: f('void VmbShutdown()'),
    list: f('int32 VmbCamerasList(void *info, uint32 len, _Out_ uint32 *found, uint32 size)'),
    open: f('int32 VmbCameraOpen(const char *id, uint32 mode, _Out_ void **handle)'),
    close: f('int32 VmbCameraClose(void *handle)'),
    enumSet: f('int32 VmbFeatureEnumSet(void *handle, const char *name, const char *value)'),
    floatSet: f('int32 VmbFeatureFloatSet(void *handle, const char *name, double value)'),
    floatGet: f('int32 VmbFeatureFloatGet(void *handle, const char *name, _Out_ double *value)'),
    intGet: f('int32 VmbFeatureIntGet(void *handle, const char *name, _Out_ int64 *value)'),
    intSet: f('int32 VmbFeatureIntSet(void *handle, const char *name, int64 value)'),
    enumGet: f('int32 VmbFeatureEnumGet(void *handle, const char *name, _Out_ const char **value)'),
    command: f('int32 VmbFeatureCommandRun(void *handle, const char *name)'),
    payload: f('int32 VmbPayloadSizeGet(void *handle, _Out_ uint32 *size)'),
    announce: f('int32 VmbFrameAnnounce(void *handle, void *frame, uint32 size)'),
    revokeAll: f('int32 VmbFrameRevokeAll(void *handle)'),
    captureStart: f('int32 VmbCaptureStart(void *handle)'),
    captureEnd: f('int32 VmbCaptureEnd(void *handle)'),
    queue: f('int32 VmbCaptureFrameQueue(void *handle, void *frame, void *callback)'),
    wait: f('int32 VmbCaptureFrameWait(void *handle, void *frame, uint32 timeout)'),
    flush: f('int32 VmbCaptureQueueFlush(void *handle)')
  };
  api = { koffi, CameraInfo, Frame, vmb };
  return api;
}

class VimbaCamera {
  // step(name): called before each Vimba X call that can stall, so a stuck one can be named
  constructor(opts = {}, log, step) { this.opts = opts; this.log = log || (() => {}); this.step = step || (() => {}); }

  // opts.reset: the camera got stuck (a picture that never came, a call that never returned, and
  // then no pictures at all until it's unplugged): reboot it first with its own DeviceReset, as
  // unplugging would, then open it again once it's back
  async open() {
    if (!this.opts.reset) return this.openOnce();
    // the camera process left behind a moment ago can still hold it (busy, or Vimba X's -22):
    // try again from a fresh start for up to 25 s before giving up on the reset
    const until = Date.now() + 25000;
    for (;;) {
      try { await this.openOnce(); break; } catch (e) {
        await this.close();
        if (Date.now() > until) throw e;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    this.log('camera: resetting it (DeviceReset), as it got stuck');
    this.step('DeviceReset');
    this.vmb.command(this.h, 'DeviceReset');
    await this.close();
    // it leaves the USB bus and is back a few seconds later
    let last = null;
    for (let k = 0; k < 15; k++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (k < 2) continue;
      try { return await this.openOnce(); } catch (e) { last = e; await this.close(); }
    }
    throw last;
  }

  async openOnce() {
    const { file, tried } = vmbLibrary();
    if (!file) throw new Error('Vimba X isn\'t installed (looked for ' + tried.join(', ') + '). Install Allied Vision\'s Vimba X, then try again.');
    const api = vmbApi(file);
    const { koffi, CameraInfo } = api;
    this.k = koffi;
    this.Frame = api.Frame;
    this.vmb = api.vmb;
    const tl = usbTransport(this.opts.transport);
    this.log('camera: USB transport ' + (tl || 'Vimba X\'s defaults (none found)'));
    this.step('VmbStartup');
    this.check(this.vmb.startup(tl), 'start Vimba X' + (tl ? ' with ' + tl : ''));
    this.started = true;
    const found = [0];
    this.step('VmbCamerasList');
    this.vmb.list(null, 0, found, koffi.sizeof(CameraInfo));
    if (!found[0]) throw new Error('No Allied Vision camera found. Check its USB cable, and that Ruby / JobDispatcher are closed.');
    // the same camera can be listed once per USB driver (Vimba X's own, and Ruby's VimbaUSBTL):
    // read the whole list, then open the first entry that lets us in
    const n = found[0];
    const mem = koffi.alloc(CameraInfo, n);
    this.check(this.vmb.list(mem, n, found, koffi.sizeof(CameraInfo)), 'list cameras');
    const list = koffi.decode(mem, koffi.array(CameraInfo, Math.min(n, found[0])));
    this.log('camera: ' + list.map((c) => c.modelName + ' ' + c.serialString + ' (' + c.cameraIdString + ')').join(', '));
    const h = [null];
    let info = null, last = 0;
    // Vimba X also lists its own "Camera Simulator" devices: real cameras first, never those
    const real = list.filter((c) => !/simulator/i.test(String(c.cameraName) + ' ' + String(c.modelName)));
    if (!real.length) throw new Error('No Allied Vision camera found (only Vimba X\'s simulators). Check its USB cable, and that Ruby / JobDispatcher are closed.');
    // busy: a camera process that was just left behind (stuck) can hold it for a few seconds more
    for (let k = 0; k < 10 && !info; k++) {
      if (k) await new Promise((r) => setTimeout(r, 1000));
      for (const c of real) {
        this.step('VmbCameraOpen');
        last = this.vmb.open(c.cameraIdString, 1 /* full access */, h);
        if (last === 0) { info = c; break; }
      }
      if (last !== VMB_BUSY) break;
      if (!k) this.log('camera: busy, trying again for 10 s');
    }
    if (!info) this.check(last, 'open the camera' + (last === VMB_BUSY ? ': it\'s still busy. Unplug the camera\'s USB cable for a few seconds, or close Ruby / JobDispatcher if they\'re open' : ' (is Ruby / JobDispatcher using it?)'));
    this.h = h[0];
    // grey frames: Mono8 where the camera has it (Alvium colour models do), else colour → grey here
    if (this.vmb.enumSet(this.h, 'PixelFormat', 'Mono8') !== 0) this.vmb.enumSet(this.h, 'PixelFormat', 'BayerRG8');
    this.vmb.enumSet(this.h, 'AcquisitionMode', 'SingleFrame');
    // the whole sensor, every time: a crop left on the camera (Ruby left a square 1944 × 1944 one)
    // moves the picture's middle, and with it every position the camera measures
    const wm = [0], hm = [0], W = [0], H = [0];
    if (this.vmb.intGet(this.h, 'WidthMax', wm) === 0 && this.vmb.intGet(this.h, 'HeightMax', hm) === 0) {
      this.vmb.intSet(this.h, 'OffsetX', 0);
      this.vmb.intSet(this.h, 'OffsetY', 0);
      this.vmb.intSet(this.h, 'Width', Number(wm[0]));
      this.vmb.intSet(this.h, 'Height', Number(hm[0]));
    }
    if (this.vmb.intGet(this.h, 'Width', W) === 0 && this.vmb.intGet(this.h, 'Height', H) === 0) this.log('camera: picture ' + Number(W[0]) + ' × ' + Number(H[0]) + ' (the whole sensor)');
    // On a USB 2 link (or a slow cable / hub) the camera's default throughput limit is far more
    // than the link carries, and every frame arrives incomplete: keep to 80 % of the link speed
    const speed = [0];
    if (this.vmb.intGet(this.h, 'DeviceLinkSpeed', speed) === 0 && Number(speed[0]) > 0) {
      const limit = Math.floor(Number(speed[0]) * 0.8);
      this.vmb.enumSet(this.h, 'DeviceLinkThroughputLimitMode', 'On');
      if (this.vmb.intSet(this.h, 'DeviceLinkThroughputLimit', limit) === 0) this.log('camera: USB link ' + Math.round(Number(speed[0]) / 1e6) + ' MB/s' + (Number(speed[0]) < 100e6 ? ' (USB 2: a USB 3 port and cable are faster)' : '') + ', streaming at ' + Math.round(limit / 1e6) + ' MB/s');
    }
    if (this.opts.exposure) await this.setExposure(this.opts.exposure);
    const size = [0];
    this.check(this.vmb.payload(this.h, size), 'read the frame size');
    this.size = size[0];
    this.buf = koffi.alloc('uint8', this.size);
    this.frame = koffi.alloc(this.Frame, 1);
    this.info = { model: info.modelName, serial: info.serialString, id: info.cameraIdString };
    this.log('camera: ' + info.modelName + ' (' + info.serialString + ')');
    return this.info;
  }

  check(code, what) { if (code !== 0) throw new Error('Camera: couldn\'t ' + what + ' (Vimba error ' + code + ')'); }

  async setExposure(us) {
    if (!this.h) return;
    if (us === 'auto') { this.vmb.enumSet(this.h, 'ExposureAuto', 'Once'); this.expUs = MAX_EXPOSURE; return; }
    this.vmb.enumSet(this.h, 'ExposureAuto', 'Off');
    this.check(this.vmb.floatSet(this.h, 'ExposureTime', Number(us)), 'set the exposure');
    this.expUs = Number(us);
  }

  // one frame; an incomplete one (USB hiccup, or the first after starting) is grabbed again.
  // timeout: on top of the exposure (a long one on a USB 2 link left little of a fixed 2 s)
  async grab(timeout = 2000) {
    const t = timeout + Math.ceil((this.expUs || 0) / 1000);
    let last;
    for (let k = 0; k < 3; k++) {
      try { return await this.grabOnce(t); } catch (e) { last = e; if (!/incomplete/.test(e.message)) throw e; }
    }
    throw last;
  }

  // announce, queue, start, wait (on a worker thread), stop
  async grabOnce(timeout) {
    const { k, vmb, h, step } = this;
    k.encode(this.frame, this.Frame, { buffer: this.buf, bufferSize: this.size, context: [null, null, null, null] });
    step('VmbFrameAnnounce');
    this.check(vmb.announce(h, this.frame, k.sizeof(this.Frame)), 'prepare a frame');
    try {
      step('VmbCaptureStart');
      this.check(vmb.captureStart(h), 'start capturing');
      step('VmbCaptureFrameQueue');
      this.check(vmb.queue(h, this.frame, null), 'queue a frame');
      step('AcquisitionStart');
      this.check(vmb.command(h, 'AcquisitionStart'), 'start the exposure');
      step('VmbCaptureFrameWait');
      const code = await new Promise((resolve, reject) => vmb.wait.async(h, this.frame, timeout, (err, r) => (err ? reject(err) : resolve(r))));
      // a frame that didn't come: stopping the acquisition then is where the camera got stuck (no
      // answer, then busy until it was reset). The frame is dropped instead (below), the camera
      // process stays, and the camera is reset as it's opened again
      if (code !== 0) throw new Error('Camera: couldn\'t get a frame (timed out?) (Vimba error ' + code + ')');
      // (single frame: the camera has stopped by itself; this only makes sure)
      step('AcquisitionStop');
      vmb.command(h, 'AcquisitionStop');
      const fr = k.decode(this.frame, this.Frame);
      if (process.env.PLR_CAMERA_DEBUG) console.log('frame record', JSON.stringify(fr, (key, v) => (typeof v === 'bigint' ? v.toString() : v)), 'payload', this.size);
      if (fr.receiveStatus !== 0) throw new Error('Camera: the frame was incomplete (status ' + fr.receiveStatus + ')');
      const raw = frameBytes(k, fr.imageData, fr.width * fr.height * (fr.pixelFormat === PIX.RGB8 || fr.pixelFormat === PIX.BGR8 ? 3 : 1));
      return toGrey(raw, fr.width, fr.height, fr.pixelFormat);
    } finally {
      step('VmbCaptureEnd'); vmb.captureEnd(h);
      step('VmbCaptureQueueFlush'); vmb.flush(h);
      step('VmbFrameRevokeAll'); vmb.revokeAll(h);
      step(null);
    }
  }

  async close() {
    if (this.h) { try { this.vmb.close(this.h); } catch (e) { /* gone */ } this.h = null; }
    if (this.started) { this.vmb.shutdown(); this.started = false; }
  }
}

// the frame's bytes, copied out of Vimba X's buffer. Not koffi.view: in the installed app this
// process runs on Electron's own Node, which aborts on an ArrayBuffer over outside memory (V8's
// memory cage) — every picture stopped the camera process (Pathline Run 0.7.5)
function frameBytes(k, ptr, n) { return k.decode(ptr, k.array('uint8', n, 'Typed')); }

// camera bytes → grey (Bayer: 2×2 average, half size)
function toGrey(raw, w, h, fmt) {
  if (fmt === PIX.Mono8) return { w, h, data: new Uint8Array(raw) };
  if (fmt === PIX.RGB8 || fmt === PIX.BGR8) {
    const data = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) data[i] = (raw[i * 3] + raw[i * 3 + 1] * 2 + raw[i * 3 + 2]) >> 2;
    return { w, h, data };
  }
  const W = w >> 1, H = h >> 1, data = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = 2 * y * w + 2 * x;
    data[y * W + x] = (raw[i] + raw[i + 1] + raw[i + w] + raw[i + w + 1]) >> 2;
  }
  return { w: W, h: H, data, half: true };
}

// ---------------------------------------------------------------- simulated
// opts.truth: the real camera, as calibration should find it:
//   { offset: [x, y] laser − camera (mm), pixel (mm/px), rotation (deg, image vs bed),
//     error(p) → where the head really is when sent to p (machine inaccuracy) }
// opts.scene: { dots: [{ x, y, d }], board: { x, y, angle, square, nx, ny } (first corner,
//   degrees, square size mm, squares across × down), marks: [{ x, y, d }] laser marks }
// opts.headAt(): where the machine says the head (laser) is.
class SimCamera {
  // opts.light(ix, iy): how much light reaches a spot (mm from the picture's middle), 0 … 1:
  // uneven light; opts.scene.board.bump(u, v): how far a bumpy board moves its pattern at board
  // point (u, v) mm, as [du, dv] mm. Brightness follows the exposure (50 ms = as drawn).
  constructor(opts = {}) {
    this.size = opts.size || 480;
    this.truth = { offset: [41.437, 12.731], pixel: 0.08, rotation: 90, error: (p) => p, ...(opts.truth || {}) };
    this.scene = { dots: [], board: null, marks: [], ...(opts.scene || {}) };
    this.headAt = opts.headAt || (() => ({ x: 0, y: 0 }));
    this.noise = opts.noise === undefined ? 4 : opts.noise;
    this.light = opts.light || null;
    this.exp = 50000;
  }

  async open() { return { model: 'Simulated head camera', serial: 'sim' }; }
  async close() {}
  async setExposure(us) { if (Number(us) > 0) this.exp = Number(us); }

  // the laser fired here (calibration marks); where it really landed follows the machine error
  laserMark(x, y, d) { const p = this.truth.error([x, y]); this.scene.marks.push({ x: p[0], y: p[1], d }); }

  // grey level of the bed at p (mm)
  shade(p) {
    for (const m of this.scene.dots.concat(this.scene.marks)) if (Math.hypot(p[0] - m.x, p[1] - m.y) <= m.d / 2) return 25;
    // printed artwork: dark rectangles { x0, y0, x1, y1 }
    for (const r of this.scene.rects || []) if (p[0] >= r.x0 && p[0] <= r.x1 && p[1] >= r.y0 && p[1] <= r.y1) return 40;
    // the bed checkerboard, and any others (scene.boards: e.g. the small 10 mm one for stage 1)
    for (const b of [this.scene.board].concat(this.scene.boards || [])) {
      if (!b) continue;
      const a = (-b.angle * Math.PI) / 180, dx = p[0] - b.x, dy = p[1] - b.y;
      let bu = dx * Math.cos(a) - dy * Math.sin(a), bv = dx * Math.sin(a) + dy * Math.cos(a);
      if (b.bump) { const d = b.bump(bu, bv); bu -= d[0]; bv -= d[1]; }
      const u = bu / b.square, v = bv / b.square;
      if (u >= -1 && v >= -1 && u < (b.nx || 30) - 1 && v < (b.ny || 20) - 1) return (Math.floor(u) + Math.floor(v)) % 2 === 0 ? 30 : 220;
    }
    return 225;
  }

  async grab() {
    const head = this.headAt();
    const real = this.truth.error([head.x, head.y]);
    const cam = [real[0] - this.truth.offset[0], real[1] - this.truth.offset[1]];
    const n = this.size, c = (n - 1) / 2, s = this.truth.pixel;
    const a = (this.truth.rotation * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
    const data = new Uint8Array(n * n);
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
    const gain = this.exp / 50000;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        // 2×2 samples per pixel: soft edges, like a real lens
        let v = 0;
        for (const [ox, oy] of [[-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]]) {
          const ix = (x + ox - c) * s, iy = (y + oy - c) * s;
          v += this.shade([cam[0] + ca * ix - sa * iy, cam[1] + sa * ix + ca * iy]);
        }
        const lit = this.light ? this.light((x - c) * s, (y - c) * s) : 1;
        data[y * n + x] = Math.max(0, Math.min(255, Math.round((v / 4) * lit * gain + this.noise * rnd())));
      }
    }
    return { w: n, h: n, data };
  }
}

// ---------------------------------------------------------------- the camera's own process
// VimbaCamera run in a separate process (camera-worker.js; in the installed app, Electron's own
// program as plain Node), with a time limit on every call: the app's main thread (screen, laser
// link) never waits on Vimba X. A call that runs out of time gives an error and the process is
// left behind (killed; if the USB driver holds it, Windows lets it go once the camera is
// unplugged); the next use starts a fresh one.
class ProcessCamera {
  constructor(opts = {}, log) { this.opts = opts; this.log = log || (() => {}); this.seq = 0; this.wait = new Map(); }

  start() {
    const { fork } = require('child_process');
    const w = fork(path.join(__dirname, 'camera-worker.js'), [], {
      execPath: process.execPath, serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    });
    this.w = w;
    this.at = null;
    w.on('message', (m) => {
      if (m.log) return this.log(m.log);
      if ('step' in m) { this.at = m.step; return; }
      const p = this.wait.get(m.id);
      if (!p) return;
      this.wait.delete(m.id);
      clearTimeout(p.t);
      if (m.ok) p.resolve(m.r); else p.reject(new Error(m.error));
    });
    w.on('error', (e) => { if (this.w === w) this.fail(new Error('Camera process: ' + e.message)); });
    w.on('exit', () => { if (this.w === w) { this.w = null; this.fail(new Error('The camera process stopped')); } });
  }

  // leave the process behind: never wait for it
  drop() {
    const w = this.w;
    this.w = null;
    this.opened = false;
    if (!w) return;
    try { w.disconnect(); } catch (e) { /* gone */ }
    try { w.kill('SIGKILL'); } catch (e) { /* gone */ }
  }

  fail(e) { for (const p of this.wait.values()) { clearTimeout(p.t); p.reject(e); } this.wait.clear(); }

  call(cmd, args, ms, what) {
    if (!this.w) this.start();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.wait.delete(id);
        reject(new Error('The camera didn\'t answer (' + what + ', ' + Math.round(ms / 1000) + ' s' + (this.at ? ', stuck in Vimba X\'s ' + this.at : '') + '). If it keeps happening, unplug the camera\'s USB cable for a few seconds; close Ruby / JobDispatcher too.'));
        // a stuck process is no use: leave it behind (the next call starts a fresh one)
        this.drop();
      }, ms);
      this.wait.set(id, { resolve, reject, t });
      this.w.send({ id, cmd, args });
    });
  }

  // after a stuck picture the camera is reset (DeviceReset) as it opens
  async open() {
    this.opened = false;
    const reset = !!this.stuck;
    this.info = await this.call('open', [{ ...this.opts, reset }], reset ? 60000 : 30000, reset ? 'resetting and opening it' : 'opening it');
    this.stuck = false;
    this.opened = true;
    return this.info;
  }
  // after a process was left behind, or an open that failed (busy), open the camera again first
  async again() { if (!this.opened && this.info) await this.open(); }
  // a picture that never came, or a call that never returned: the camera is stuck (and stays so
  // until it's unplugged). It's reset and the picture taken once more
  async grab(timeout = 2000) {
    for (let k = 0; ; k++) {
      await this.again();
      try {
        // the camera's own wait is the exposure plus `timeout`: the time limit here grows with it
        const exp = this.opts.exposure === 'auto' ? MAX_EXPOSURE : Number(this.opts.exposure) || 0;
        const r = await this.call('grab', [timeout], (timeout + exp / 1000) * 3 + 8000, 'taking a picture');
        return { w: r.w, h: r.h, half: r.half, data: new Uint8Array(r.data) };
      } catch (e) {
        if (k || !/didn't answer|couldn't get a frame|incomplete|camera process stopped/.test(e.message)) throw e;
        this.log('camera: ' + e.message.split('. If')[0] + ': resetting the camera');
        this.stuck = true;
        this.opened = false;
      }
    }
  }
  async setExposure(us) { await this.again(); this.opts.exposure = us; return this.call('exposure', [us], 5000, 'setting the exposure'); }
  async close() {
    if (!this.w) return;
    await this.call('close', [], 5000, 'closing it').catch(() => {});
    this.drop();
  }
}

function makeCamera(vision, opts = {}) {
  return vision.source === 'sim' ? new SimCamera(opts.sim || {}) : new ProcessCamera({ exposure: Number(vision.exposure) > 0 ? Number(vision.exposure) : null, transport: vision.transport || 'auto' }, opts.log);
}

module.exports = { VimbaCamera, ProcessCamera, SimCamera, makeCamera, vmbLibrary, usbTransport, toGrey, frameBytes, MAX_EXPOSURE };

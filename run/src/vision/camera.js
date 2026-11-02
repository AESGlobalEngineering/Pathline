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

const PIX = { Mono8: 0x01080001, BayerGR8: 0x01080008, BayerRG8: 0x01080009, BayerGB8: 0x0108000a, BayerBG8: 0x0108000b, RGB8: 0x02180014, BGR8: 0x02180015 };

class VimbaCamera {
  constructor(opts = {}, log) { this.opts = opts; this.log = log || (() => {}); }

  async open() {
    const { file, tried } = vmbLibrary();
    if (!file) throw new Error('Vimba X isn\'t installed (looked for ' + tried.join(', ') + '). Install Allied Vision\'s Vimba X, then try again.');
    const koffi = require('koffi');
    const lib = koffi.load(file);
    this.k = koffi;
    // Vimba X VmbC (VmbCTypeDefinitions.h): structs and calls used here
    const CameraInfo = koffi.struct('VmbCameraInfo_t', {
      cameraIdString: 'const char *', cameraIdExtended: 'const char *', cameraName: 'const char *', modelName: 'const char *',
      serialString: 'const char *', transportLayerHandle: 'void *', interfaceHandle: 'void *', localDeviceHandle: 'void *',
      streamHandles: 'void *', streamCount: 'uint32', permittedAccess: 'uint32'
    });
    this.Frame = koffi.struct('VmbFrame_t', {
      buffer: 'void *', bufferSize: 'uint32', context: koffi.array('void *', 4),
      receiveStatus: 'int32', frameID: 'uint64', timestamp: 'uint64', imageData: 'void *',
      receiveFlags: 'uint32', pixelFormat: 'uint32', width: 'uint32', height: 'uint32',
      offsetX: 'uint32', offsetY: 'uint32', payloadType: 'uint32', chunkDataPresent: 'uint8'
    });
    const f = (sig) => lib.func(sig);
    this.vmb = {
      startup: f('int32 VmbStartup(void *path)'),
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
    this.check(this.vmb.startup(null), 'start Vimba X');
    this.started = true;
    const found = [0];
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
    for (const c of real) {
      last = this.vmb.open(c.cameraIdString, 1 /* full access */, h);
      if (last === 0) { info = c; break; }
    }
    if (!info) this.check(last, 'open the camera (is Ruby / JobDispatcher using it?)');
    this.h = h[0];
    // grey frames: Mono8 where the camera has it (Alvium colour models do), else colour → grey here
    if (this.vmb.enumSet(this.h, 'PixelFormat', 'Mono8') !== 0) this.vmb.enumSet(this.h, 'PixelFormat', 'BayerRG8');
    this.vmb.enumSet(this.h, 'AcquisitionMode', 'SingleFrame');
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
    if (us === 'auto') { this.vmb.enumSet(this.h, 'ExposureAuto', 'Once'); return; }
    this.vmb.enumSet(this.h, 'ExposureAuto', 'Off');
    this.check(this.vmb.floatSet(this.h, 'ExposureTime', Number(us)), 'set the exposure');
  }

  // one frame; an incomplete one (USB hiccup, or the first after starting) is grabbed again
  async grab(timeout = 2000) {
    let last;
    for (let k = 0; k < 3; k++) {
      try { return await this.grabOnce(timeout); } catch (e) { last = e; if (!/incomplete/.test(e.message)) throw e; }
    }
    throw last;
  }

  // announce, queue, start, wait (on a worker thread), stop
  async grabOnce(timeout) {
    const { k, vmb, h } = this;
    k.encode(this.frame, this.Frame, { buffer: this.buf, bufferSize: this.size, context: [null, null, null, null] });
    this.check(vmb.announce(h, this.frame, k.sizeof(this.Frame)), 'prepare a frame');
    try {
      this.check(vmb.captureStart(h), 'start capturing');
      this.check(vmb.queue(h, this.frame, null), 'queue a frame');
      this.check(vmb.command(h, 'AcquisitionStart'), 'start the exposure');
      const code = await new Promise((resolve, reject) => vmb.wait.async(h, this.frame, timeout, (err, r) => (err ? reject(err) : resolve(r))));
      vmb.command(h, 'AcquisitionStop');
      this.check(code, 'get a frame (timed out?)');
      const fr = k.decode(this.frame, this.Frame);
      if (process.env.PLR_CAMERA_DEBUG) console.log('frame record', JSON.stringify(fr, (key, v) => (typeof v === 'bigint' ? v.toString() : v)), 'payload', this.size);
      if (fr.receiveStatus !== 0) throw new Error('Camera: the frame was incomplete (status ' + fr.receiveStatus + ')');
      const raw = new Uint8Array(k.view(fr.imageData, fr.width * fr.height * (fr.pixelFormat === PIX.RGB8 || fr.pixelFormat === PIX.BGR8 ? 3 : 1)));
      return toGrey(raw, fr.width, fr.height, fr.pixelFormat);
    } finally {
      vmb.captureEnd(h); vmb.flush(h); vmb.revokeAll(h);
    }
  }

  async close() {
    if (this.h) { try { this.vmb.close(this.h); } catch (e) { /* gone */ } this.h = null; }
    if (this.started) { this.vmb.shutdown(); this.started = false; }
  }
}

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

function makeCamera(vision, opts = {}) {
  return vision.source === 'sim' ? new SimCamera(opts.sim || {}) : new VimbaCamera({ exposure: Number(vision.exposure) > 0 ? Number(vision.exposure) : null }, opts.log);
}

module.exports = { VimbaCamera, SimCamera, makeCamera, vmbLibrary, toGrey };

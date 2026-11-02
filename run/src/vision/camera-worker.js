// The Allied Vision camera in a thread of its own: Vimba X's calls (finding the camera,
// opening it, starting a capture) can take seconds or stall, and on the main thread that froze
// the whole app ("Pathline Run stopped interacting with Windows"). Messages in: { id, cmd, args };
// out: { id, ok, r | error } and { log }.
'use strict';

const { parentPort } = require('worker_threads');
const { VimbaCamera } = require('./camera');

let cam = null;

parentPort.on('message', async ({ id, cmd, args }) => {
  try {
    let r = null;
    const transfer = [];
    if (cmd === 'open') {
      cam = new VimbaCamera(args[0] || {}, (m) => parentPort.postMessage({ log: m }));
      r = await cam.open();
    } else if (!cam) {
      throw new Error('The camera isn\'t open');
    } else if (cmd === 'grab') {
      const img = await cam.grab(args[0]);
      r = { w: img.w, h: img.h, half: !!img.half, data: img.data };
      transfer.push(img.data.buffer);
    } else if (cmd === 'exposure') {
      await cam.setExposure(args[0]);
    } else if (cmd === 'close') {
      await cam.close();
      cam = null;
    }
    parentPort.postMessage({ id, ok: true, r }, transfer);
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: e.message });
  }
});

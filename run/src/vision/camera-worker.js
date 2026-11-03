// The Allied Vision camera in a process of its own (camera.js → ProcessCamera): Vimba X's calls
// (finding the camera, opening it, taking a picture) can take seconds, or get stuck in the USB
// driver for good. On the app's main thread that froze Pathline Run; in a thread, ending the
// stuck thread still made the main thread wait for it. A separate process can always be left
// behind. Messages in: { id, cmd, args }; out: { id, ok, r | error } and { log }.
'use strict';

const { VimbaCamera } = require('./camera');

const send = (m) => process.send(m);
let cam = null;

process.on('message', async ({ id, cmd, args }) => {
  try {
    let r = null;
    if (cmd === 'open') {
      cam = new VimbaCamera(args[0] || {}, (m) => send({ log: m }));
      r = await cam.open();
    } else if (!cam) {
      throw new Error('The camera isn\'t open');
    } else if (cmd === 'grab') {
      const img = await cam.grab(args[0]);
      r = { w: img.w, h: img.h, half: !!img.half, data: img.data };
    } else if (cmd === 'exposure') {
      await cam.setExposure(args[0]);
    } else if (cmd === 'close') {
      await cam.close();
      cam = null;
    }
    send({ id, ok: true, r });
  } catch (e) {
    send({ id, ok: false, error: e.message });
  }
});

// the app went away: close the camera and go too
process.on('disconnect', async () => { try { if (cam) await cam.close(); } catch (e) { /* gone */ } process.exit(0); });

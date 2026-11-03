// The Allied Vision camera in a process of its own (camera.js → ProcessCamera): Vimba X's calls
// (finding the camera, opening it, taking a picture) can take seconds, or get stuck in the USB
// driver for good. On the app's main thread that froze Pathline Run; in a thread, ending the
// stuck thread still made the main thread wait for it. A separate process can always be left
// behind. Messages in: { id, cmd, args }; out: { id, ok, r | error } and { log }.
'use strict';

const { VimbaCamera } = require('./camera');

const send = (m) => process.send(m);
let cam = null;

// one request at a time, in order: two picture sequences at once on one camera would trip it up
let queue = Promise.resolve();
process.on('message', (m) => { queue = queue.then(() => handle(m)); });

async function handle({ id, cmd, args }) {
  try {
    let r = null;
    if (cmd === 'open') {
      if (cam) { await cam.close().catch(() => {}); cam = null; }
      const c = new VimbaCamera(args[0] || {}, (m) => send({ log: m }), (step) => send({ step }));
      // a camera that didn't open is closed again (Vimba X shut down), never half kept
      try { r = await c.open(); } catch (e) { await c.close().catch(() => {}); throw e; }
      cam = c;
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
}

// the app went away: close the camera and go too
process.on('disconnect', async () => { try { if (cam) await cam.close(); } catch (e) { /* gone */ } process.exit(0); });

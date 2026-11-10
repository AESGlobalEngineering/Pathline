// Runs follow-fit.js off the main thread (it replays several jobs, about a minute of work), so
// the machine and the screen never wait for it. workerData: { dataDir, current, cfg, motion }
'use strict';

const { parentPort, workerData } = require('worker_threads');
const ff = require('./follow-fit');

try {
  const r = ff.fit(workerData.dataDir, workerData.current || {}, { cfg: workerData.cfg, motion: workerData.motion, log: (m) => parentPort.postMessage({ log: m }) });
  parentPort.postMessage({ result: r });
} catch (e) {
  parentPort.postMessage({ error: e.message });
}

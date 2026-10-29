#!/usr/bin/env node
// Starts the installed version of Pathline Run and keeps it running.
// An installed copy looks like this (the downloads are built by tools/package.js):
//
//   <root>/launcher.js          this file (never replaced by updates)
//   <root>/runtime/node.exe     Windows only: Node.js
//   <root>/app/<version>/       the app
//   <root>/app/current          the version to run
//   <root>/app/previous         the version before the last update
//   <root>/app/updated          present right after an update, until it has run for a while
//
// The app exits with code 75 to be restarted (after installing an update).
// If a freshly updated version stops with an error within 30 s, the previous
// version is put back.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const APP = path.join(ROOT, 'app');
const RESTART = 75;
const SETTLE_MS = 30000;
const read = (f) => { try { return fs.readFileSync(path.join(APP, f), 'utf8').trim(); } catch (e) { return ''; } };
const log = (m) => console.log(new Date().toLocaleTimeString() + '  launcher: ' + m);

let child = null;
let quitting = false;
let fastFails = 0;
let args = process.argv.slice(2);

function start() {
  const version = read('current');
  const server = path.join(APP, version, 'src', 'server.js');
  if (!version || !fs.existsSync(server)) {
    console.error('Pathline Run is not installed correctly: ' + path.join(APP, 'current') + ' does not name an app folder.');
    process.exit(1);
  }
  const t0 = Date.now();
  const settle = setTimeout(() => { fs.rmSync(path.join(APP, 'updated'), { force: true }); fastFails = 0; }, SETTLE_MS);
  child = spawn(process.execPath, [server].concat(args), {
    stdio: 'inherit',
    env: { ...process.env, PATHLINE_RUN_ROOT: ROOT }
  });
  args = args.filter((a) => a !== '--open'); // open the browser on the first start only
  child.on('exit', (code, signal) => {
    clearTimeout(settle);
    if (quitting) process.exit(0);
    if (code === RESTART) { log('restarting'); return start(); }
    const quick = Date.now() - t0 < SETTLE_MS;
    const prev = read('previous');
    if (quick && fs.existsSync(path.join(APP, 'updated')) && prev && fs.existsSync(path.join(APP, prev, 'src', 'server.js'))) {
      log('version ' + version + ' stopped right after the update (' + (signal || 'code ' + code) + '): going back to ' + prev);
      fs.writeFileSync(path.join(APP, 'current'), prev);
      fs.writeFileSync(path.join(APP, 'previous'), version);
      fs.writeFileSync(path.join(APP, 'skip'), version); // don't install this version again
      fs.rmSync(path.join(APP, 'updated'), { force: true });
      return start();
    }
    if (code === 0) process.exit(0);
    // crashed: start again, slowing down if it keeps failing at once
    fastFails = quick ? fastFails + 1 : 0;
    const wait = Math.min(30000, 1000 * 2 ** Math.min(fastFails, 5));
    log('stopped (' + (signal || 'code ' + code) + '), starting again in ' + wait / 1000 + ' s');
    setTimeout(start, wait);
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { quitting = true; if (child) child.kill(sig); else process.exit(0); });
}
start();

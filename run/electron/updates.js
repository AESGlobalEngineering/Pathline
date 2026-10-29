// Update checks, the same way Pathline does them (src/main/updates.js there).
// Releases come from the pathlinerun release on GitHub (build.publish in
// package.json, a "generic" feed so Pathline's own releases never mix in).
// electron-builder writes that address into the installed app as
// resources\app-update.yml; without it (development) updates are off.
// Nothing downloads or installs by itself: a found update is offered to the
// operator, downloads only when they choose to (with progress), and installs
// only when they choose Restart and install.
'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

let updater = null;
let log = () => {};
let offered = null; // version already offered to the operator this session
let seq = 0;        // counts state changes, so the screen (which polls) notices each one
// idle | available | downloading | ready | error
let now = { state: 'idle' };
const set = (s) => { now = { ...s, current: app.getVersion(), seq: ++seq }; return now; };

// where this copy looks for updates (from resources\app-update.yml)
function feedUrl() {
  if (process.env.PATHLINE_RUN_UPDATE_URL) return process.env.PATHLINE_RUN_UPDATE_URL;
  try { return (fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8').match(/^url:\s*(.+)$/m) || [])[1].trim() + '/latest.yml'; } catch (e) { return '(not set)'; }
}

function configured() {
  return app.isPackaged && fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'));
}

function setup(logFn) {
  log = logFn || log;
  if (updater || process.env.PORTABLE_EXECUTABLE_DIR) return;
  if (!configured() && !process.env.PATHLINE_RUN_UPDATE_URL) return;
  updater = require('electron-updater').autoUpdater;
  // for testing against a local copy of the release files
  if (process.env.PATHLINE_RUN_UPDATE_URL) updater.setFeedURL({ provider: 'generic', url: process.env.PATHLINE_RUN_UPDATE_URL });
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.logger = { info: () => {}, warn: (m) => log('update: ' + m), error: (m) => log('update: ' + m), debug: () => {} };
  updater.on('download-progress', (p) => set({ state: 'downloading', version: now.version, percent: p.percent, transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond }));
  updater.on('update-downloaded', (i) => { log('update: Pathline Run ' + i.version + ' downloaded'); set({ state: 'ready', version: i.version }); });
  updater.on('error', (e) => {
    log('update: ' + (e && e.message));
    if (now.state === 'downloading') set({ state: 'error', version: now.version, message: ((e && e.message) || 'Download failed').split('\n')[0] });
  });
}

// Asks GitHub. Returns { state: 'current' | 'available' | 'downloading' | 'ready' | 'none' | 'off' | 'portable' | 'error', version, ... }
// opts.periodic: the background check — a version already offered this session
// isn't offered again (the operator said Later), only a newer one is.
async function check(opts) {
  if (now.state === 'downloading' || now.state === 'ready') return status();
  if (process.env.PORTABLE_EXECUTABLE_DIR) return { state: 'portable', version: app.getVersion() };
  if (!updater) return { state: 'off', version: app.getVersion() };
  try {
    const r = await updater.checkForUpdates();
    if (r && r.isUpdateAvailable) {
      const v = r.updateInfo.version;
      if (opts && opts.periodic && offered === v) return { state: 'available', version: v, current: app.getVersion() };
      offered = v;
      log('update: Pathline Run ' + v + ' is available');
      return set({ state: 'available', version: v });
    }
    return { state: 'current', version: app.getVersion() };
  } catch (e) {
    // no update information where this copy looks: say where, so a moved release is easy to spot
    if (/unable to find latest version|no published versions|\b404\b/i.test(e.message)) {
      log('update: no update information at ' + feedUrl());
      return { state: 'none', version: app.getVersion(), message: feedUrl() };
    }
    log('update: check failed: ' + e.message.split('\n')[0]);
    return { state: 'error', version: app.getVersion(), message: e.message.split('\n')[0] };
  }
}

// what is known already, without asking the server
const status = () => ({ ...now, current: app.getVersion(), seq });

// the operator chose Download and install
function download() {
  if (!updater || (now.state !== 'available' && now.state !== 'error')) return status();
  set({ state: 'downloading', version: now.version, percent: 0, transferred: 0, total: 0 });
  updater.downloadUpdate().catch(() => { /* reported through the 'error' event */ });
  return status();
}

// the operator chose Restart and install
function install() {
  if (updater && now.state === 'ready') updater.quitAndInstall(false, true);
}

module.exports = { setup, check, status, download, install, configured };

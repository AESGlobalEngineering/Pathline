// Update checks against the GitHub releases named in package.json
// (build.publish). electron-builder writes that address into the installed app
// as resources\app-update.yml; without it (development, or a build made
// before the repository was set) updates are reported as not set up.
// Nothing downloads or installs by itself: a found update is offered to the
// operator, downloads only when they choose to (with progress sent to the
// window), and installs only when they choose Restart and install.
'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

let updater = null;
let send = () => {};
// what the window needs to show: idle | available | downloading | ready | error
let now = { state: 'idle' };
const set = (s) => { now = { ...s, current: app.getVersion() }; send(now); return now; };

function configured() {
  return app.isPackaged && fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'));
}

// toWindow(state): pushes { state, version, percent, transferred, total, bytesPerSecond, message }
function setup(log, toWindow) {
  send = toWindow;
  if (updater || !configured() || process.env.PORTABLE_EXECUTABLE_DIR) return;
  updater = require('electron-updater').autoUpdater;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.logger = { info: () => {}, warn: (m) => log('update', m), error: (m) => log('update', m), debug: () => {} };
  updater.on('download-progress', (p) => set({ state: 'downloading', version: now.version, percent: p.percent, transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond }));
  updater.on('update-downloaded', (i) => set({ state: 'ready', version: i.version }));
  updater.on('error', (e) => {
    log('update', e && e.message);
    if (now.state === 'downloading') set({ state: 'error', version: now.version, message: (e && e.message || 'Download failed').split('\n')[0] });
  });
}

// Asks GitHub. Returns { state: 'current' | 'available' | 'downloading' | 'ready' | 'none' | 'off' | 'portable' | 'error', version, ... }
async function check() {
  if (now.state === 'downloading' || now.state === 'ready') return now;
  if (process.env.PORTABLE_EXECUTABLE_DIR) return { state: 'portable', version: app.getVersion() };
  if (!updater) return { state: 'off', version: app.getVersion() };
  try {
    const r = await updater.checkForUpdates();
    if (r && r.isUpdateAvailable) return set({ state: 'available', version: r.updateInfo.version });
    return { state: 'current', version: app.getVersion() };
  } catch (e) {
    // a repository with no published release yet is not an error for the operator
    if (/unable to find latest version|no published versions|\b404\b/i.test(e.message)) return { state: 'none', version: app.getVersion() };
    return { state: 'error', version: app.getVersion(), message: e.message.split('\n')[0] };
  }
}

// what is known already, without asking the server
const status = () => ({ ...now, current: app.getVersion() });

// the operator chose Download and install
function download() {
  if (!updater || now.state !== 'available' && now.state !== 'error') return status();
  set({ state: 'downloading', version: now.version, percent: 0, transferred: 0, total: 0 });
  updater.downloadUpdate().catch(() => { /* reported through the 'error' event */ });
  return status();
}

// the operator chose Restart and install
function install() {
  if (updater && now.state === 'ready') updater.quitAndInstall(false, true);
}

module.exports = { setup, check, status, download, install, configured };

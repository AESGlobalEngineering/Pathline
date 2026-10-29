// Update checks against the GitHub releases named in package.json
// (build.publish). electron-builder writes that address into the installed app
// as resources\app-update.yml; without it (development, or a build made
// before the repository was set) updates are reported as not set up.
// A found update downloads in the background and installs when the app is
// closed, or straight away from "Restart and install".
'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

let updater = null;
let ready = null; // version downloaded and waiting to install

function configured() {
  return app.isPackaged && fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'));
}

// send(state): pushes { state, version, message } to the window
function setup(log, send) {
  if (!configured() || process.env.PORTABLE_EXECUTABLE_DIR) return;
  updater = require('electron-updater').autoUpdater;
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.logger = { info: () => {}, warn: (m) => log('update', m), error: (m) => log('update', m), debug: () => {} };
  updater.on('update-available', (i) => send({ state: 'downloading', version: i.version }));
  updater.on('update-downloaded', (i) => { ready = i.version; send({ state: 'ready', version: i.version }); });
  updater.on('error', (e) => log('update', e && e.message));
}

// Returns { state: 'current' | 'downloading' | 'ready' | 'none' | 'off' | 'portable' | 'error', version, message }
async function check() {
  if (ready) return { state: 'ready', version: ready };
  if (process.env.PORTABLE_EXECUTABLE_DIR) return { state: 'portable', version: app.getVersion() };
  if (!updater) return { state: 'off', version: app.getVersion() };
  try {
    const r = await updater.checkForUpdates();
    if (r && r.isUpdateAvailable) return { state: 'downloading', version: r.updateInfo.version };
    return { state: 'current', version: app.getVersion() };
  } catch (e) {
    // a repository with no published release yet is not an error for the operator
    if (/unable to find latest version|no published versions|\b404\b/i.test(e.message)) return { state: 'none', version: app.getVersion() };
    return { state: 'error', version: app.getVersion(), message: e.message.split('\n')[0] };
  }
}

// what is known already, without asking the server
const status = () => (ready ? { state: 'ready', version: ready } : { state: 'idle', version: app.getVersion() });

function install() {
  if (updater && ready) updater.quitAndInstall(false, true);
}

module.exports = { setup, check, status, install, configured };

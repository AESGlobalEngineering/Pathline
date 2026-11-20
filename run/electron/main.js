// Pathline Run, the installed app: runs the HMI server (src/server.js) and
// shows its screen in a window, full screen with --kiosk (the Raspberry Pi
// touchscreen). Checks for updates the way Pathline does.
//   Pathline Run.exe [--kiosk] [--sim] [--keyboard | --no-keyboard] [--hide-cursor]
// On the Raspberry Pi (deploy/pi) it is the only thing on the screen: started full screen at boot
// by a systemd service, which starts it again if it ever stops.
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Menu, dialog, shell, powerSaveBlocker } = require('electron');
const updates = require('./updates');
const server = require('../src/server');

// each check reads only latest.yml (under 1 KB), so once a minute is cheap
// (PATHLINE_RUN_UPDATE_EVERY_MS overrides, for testing)
const UPDATE_EVERY_MS = 60 * 1000;
const kiosk = process.argv.includes('--kiosk');
const sim = process.argv.includes('--sim');
// The screen's own on-screen keyboard: a Linux kiosk (the Pi) has no system one to pop up, so it's
// on there; Windows brings its own touch keyboard. --keyboard / --no-keyboard decide either way.
const keyboard = process.argv.includes('--keyboard') || (kiosk && process.platform === 'linux' && !process.argv.includes('--no-keyboard'));
// --hide-cursor: no mouse pointer at all (touch screens that pretend to be a mouse); otherwise the
// kiosk hides it while fingers are used and shows it again when a mouse moves
const hideCursor = process.argv.includes('--hide-cursor');

let win = null;
let srv = null;
let quitting = false;

// Pathline Run 0.1.0 kept its data straight in the app's folder (and on Linux
// in ~/.config/pathline-run): bring it into data/ once.
function migrate(dataDir) {
  if (fs.existsSync(dataDir)) return;
  const homes = [app.getPath('userData'), path.join(app.getPath('appData'), 'pathline-run')];
  for (const from of homes) {
    if (!fs.existsSync(path.join(from, 'config.json'))) continue;
    fs.mkdirSync(dataDir, { recursive: true });
    for (const f of ['config.json', 'queue.json', 'history.json', 'app.json', 'jobs']) {
      try { if (fs.existsSync(path.join(from, f))) fs.cpSync(path.join(from, f), path.join(dataDir, f), { recursive: true }); } catch (e) { /* start fresh */ }
    }
    return;
  }
}

function createWindow(port) {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 800, minHeight: 560,
    backgroundColor: '#0E0F11', title: 'Pathline Run', show: false,
    kiosk, fullscreen: kiosk, autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'ui', 'icon-512.png'),
    webPreferences: { contextIsolation: true, sandbox: true }
  });
  win.once('ready-to-show', () => { if (!kiosk) win.maximize(); win.show(); });
  // links that open a new window (help, GitHub) go to the browser
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('close', (e) => {
    if (quitting || !srv || !srv.machine.run) return;
    const r = dialog.showMessageBoxSync(win, {
      type: 'warning', title: 'Pathline Run', message: 'A job is running.',
      detail: 'Closing Pathline Run stops the job.', buttons: ['Keep running', 'Stop the job and close'], defaultId: 0, cancelId: 0
    });
    if (r === 0) e.preventDefault();
  });
  win.on('closed', () => { win = null; });
  // the screen's page crashed or was killed (out of memory on a small Pi): show it again. The
  // server and a running job live in this process, not the page, so they carry on regardless
  win.webContents.on('render-process-gone', (e, d) => {
    if (srv) srv.log('screen: the page stopped (' + d.reason + '), reloading it');
    if (!quitting && d.reason !== 'clean-exit') setTimeout(() => { if (win && !win.isDestroyed()) win.loadURL(url); }, 1000);
  });
  const q = [kiosk ? 'kiosk=1' : '', keyboard ? 'osk=1' : '', hideCursor ? 'cursor=0' : ''].filter(Boolean).join('&');
  const url = 'http://127.0.0.1:' + port + '/' + (q ? '?' + q : '');
  win.loadURL(url);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId('com.pathline.run');
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    const dataDir = process.env.PATHLINE_RUN_DATA || path.join(app.getPath('userData'), 'data');
    migrate(dataDir);
    // update messages go to ☰ → Diagnostics log once the server is up
    updates.setup((m) => (srv ? srv.log(m) : console.log(m)));
    try {
      srv = await server.start({ dataDir, sim, updates });
    } catch (e) {
      dialog.showErrorBox('Pathline Run', 'Pathline Run couldn\'t start.\n\n' + e.message);
      app.quit();
      return;
    }
    createWindow(srv.port);
    // a machine's screen stays on: no blanking or sleep while Pathline Run is up full screen
    if (kiosk) powerSaveBlocker.start('prevent-display-sleep');
    // check when the app opens and every few minutes while it runs;
    // a found update is offered on the screen, which asks the operator first
    setTimeout(() => updates.check(), 3000);
    setInterval(() => updates.check({ periodic: true }), Number(process.env.PATHLINE_RUN_UPDATE_EVERY_MS) || UPDATE_EVERY_MS);
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', async (e) => {
    if (quitting || !srv) return;
    // stop the machine safely before the server goes away
    e.preventDefault();
    quitting = true;
    await srv.close().catch(() => {});
    app.quit();
  });
}

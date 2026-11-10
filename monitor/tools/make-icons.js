// Draws the app icons (app/*.png) from the Pathline mark. Run with Electron:
//   <electron> monitor/tools/make-icons.js
// (Pathline Run's copy works: run/node_modules/electron/dist/electron.exe)
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const OUT = path.join(__dirname, '..', 'app');

// the mark: Pathline's kerf (two halves of a square, a cut between), red and black on white
const mark = (x, y, s, red, black) => '<g transform="translate(' + x + ' ' + y + ') scale(' + s / 64 + ')" stroke-width="6" stroke-linejoin="round"><polygon points="6,6 50,6 6,50" fill="' + red + '" stroke="' + red + '"/><polygon points="58,14 58,58 14,58" fill="' + black + '" stroke="' + black + '"/></g>';
const ICONS = {
  // the tile, as on the page (transparent round the corners)
  'icon-192.png': [192, '<rect x="1.5" y="1.5" width="189" height="189" rx="43" fill="#FFFFFF" stroke="#D5D9DF" stroke-width="3"/>' + mark(42, 42, 108, '#D62828', '#111214')],
  'icon-512.png': [512, '<rect x="4" y="4" width="504" height="504" rx="115" fill="#FFFFFF" stroke="#D5D9DF" stroke-width="8"/>' + mark(112, 112, 288, '#D62828', '#111214')],
  // Android crops this to its own shape: white to every edge, the mark inside the safe circle
  'icon-maskable-512.png': [512, '<rect width="512" height="512" fill="#FFFFFF"/>' + mark(146, 146, 220, '#D62828', '#111214')],
  // iPhone rounds its own corners
  'apple-touch-icon.png': [180, '<rect width="180" height="180" fill="#FFFFFF"/>' + mark(42, 42, 96, '#D62828', '#111214')],
  // Android's status bar badge: a white shape on nothing
  'badge-72.png': [72, mark(8, 8, 56, '#FFFFFF', '#FFFFFF')],
};

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.setPath('userData', path.join(os.tmpdir(), 'pathline-icons-' + process.pid));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 300, height: 300, show: false });
  await win.loadURL('data:text/html,<html><body></body></html>');
  for (const [name, [size, inner]] of Object.entries(ICONS)) {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">' + inner + '</svg>';
    // drawn on a canvas in the page, so the corners stay transparent
    const url = await win.webContents.executeJavaScript('new Promise((ok, no) => { const img = new Image(); img.onload = () => { const c = document.createElement("canvas"); c.width = c.height = ' + size + '; c.getContext("2d").drawImage(img, 0, 0); ok(c.toDataURL("image/png")); }; img.onerror = () => no(new Error("svg")); img.src = ' + JSON.stringify('data:image/svg+xml,' + encodeURIComponent(svg)) + '; })');
    fs.writeFileSync(path.join(OUT, name), Buffer.from(url.split(',')[1], 'base64'));
    console.log(name, size);
  }
  app.quit();
}).catch((e) => { console.error(e); app.exit(1); });

// Renders build/icon.png (512 px) from the app's logo mark. Run with:
//   npx electron tools/make-icon.js
'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const html = `<!doctype html><html><head><style>html,body{margin:0;overflow:hidden;background:transparent}svg{display:block}</style></head><body>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect x="16" y="16" width="480" height="480" rx="104" fill="#15181E"/>
  <rect x="16" y="16" width="480" height="480" rx="104" fill="none" stroke="#2457D6" stroke-width="10" opacity="0.9"/>
  <g fill="none" stroke="#FFFFFF" stroke-width="40" stroke-linecap="round" stroke-linejoin="round" transform="translate(256 256) scale(12) translate(-12 -12)">
    <path d="M4 20 20 4 M13 4h7v7" stroke-width="2.2"/>
  </g>
</svg></body></html>`;

app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 512, height: 512, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 300));
  const img = await w.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  const out = path.join(__dirname, '..', 'build', 'icon.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, img.resize({ width: 512, height: 512 }).toPNG());
  console.log('wrote ' + out);
  app.quit();
});

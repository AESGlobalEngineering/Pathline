// Screenshots one page of src\ui with the design sample data (design\mock-api.js),
// in light and/or dark, optionally after running some steps. For checking design
// work quickly; the full set is tools\shoot-design.js.
//
//   npx electron tools/shoot-ui.js --page MainDetailed [--scenario sample|empty]
//       [--theme light|dark|both] [--out .shots\ui] [--name job] [--wait 1500]
//       [--step "js expression"]...   (each step runs in order, 700 ms apart)
//
// Prints the PNG paths and any page errors. Exit code 1 if the page failed.
'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const UI = path.join(ROOT, 'src', 'ui');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const steps = args.reduce((a, v, i) => (v === '--step' ? a.concat(args[i + 1]) : a), []);
const page = opt('page', 'MainDetailed').replace(/\.dc\.html$/, '');
const scenario = opt('scenario', 'sample');
const themes = opt('theme', 'both') === 'both' ? ['light', 'dark'] : [opt('theme')];
const out = path.resolve(ROOT, opt('out', path.join('.shots', 'ui')));
const name = opt('name', page + (scenario === 'sample' ? '' : '-' + scenario));
const W = Number(opt('w', 1440)), H = Number(opt('h', 900));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// a temporary copy of the page beside the original, with the mock bridge added
const tag = '<script src="../shared/core.js"></script>';
const html = fs.readFileSync(path.join(UI, page + '.dc.html'), 'utf8');
if (!html.includes(tag)) { console.error('core.js script tag not found in ' + page); process.exit(1); }
const tmp = path.join(UI, '__preview-' + page + '-' + process.pid + '.dc.html');
fs.writeFileSync(tmp, html.replace(tag, tag + '\n<script src="../../design/mock-api.js"></script>'));
const cleanup = () => { try { fs.unlinkSync(tmp); } catch (e) { /* already gone */ } };
process.on('exit', cleanup);

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.setPath('userData', path.join(os.tmpdir(), 'pathline-shoot-ui-' + process.pid));
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  let bad = 0;
  for (const theme of themes) {
    const w = new BrowserWindow({ width: W, height: H, useContentSize: true, show: false, paintWhenInitiallyHidden: true, webPreferences: { sandbox: true, contextIsolation: true } });
    const errs = [];
    w.webContents.on('console-message', (e) => {
      const lvl = e.level;
      if ((lvl === 'error' || lvl === 3) && !/Expected moveto/.test(e.message)) errs.push(e.message);
    });
    // set the theme before the page paints
    await w.webContents.session.clearStorageData();
    try { await w.loadURL('file:///' + tmp.replace(/\\/g, '/') + '?scenario=' + scenario); } catch (err) { errs.push('load: ' + err.message); }
    await w.webContents.executeJavaScript("window.LRC && window.LRC.theme ? (LRC.theme.set('" + theme + "', false), 'ok') : 'no LRC.theme'", true).catch((e) => errs.push(e.message));
    await delay(Number(opt('wait', 1500)));
    for (const js of steps) {
      try { const r = await w.webContents.executeJavaScript(js, true); if (r !== undefined) console.log('  step: ' + String(r).slice(0, 200)); } catch (err) { errs.push('step: ' + err.message); }
      await delay(700);
    }
    // a hidden window can hand back a stale frame: force a repaint and let it land
    if (steps.length) { w.webContents.invalidate(); await delay(1200); }
    const ok = await w.webContents.executeJavaScript("!!window.__page && !document.body.innerText.includes('Something went wrong')", true).catch(() => false);
    if (!ok) errs.push('page did not start');
    const file = path.join(out, name + '-' + theme + '.png');
    fs.writeFileSync(file, (await w.webContents.capturePage()).toPNG());
    console.log((errs.length ? 'FAIL ' : 'ok   ') + file + (errs.length ? '\n       ' + errs.join('\n       ') : ''));
    bad += errs.length ? 1 : 0;
    w.destroy();
  }
  cleanup();
  app.exit(bad ? 1 : 0);
});

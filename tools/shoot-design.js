// Opens every page of design-handoff\ in a plain browser window (no app
// bridge, so design\mock-api.js supplies the data), reports page errors, and
// saves screenshots of each screen, dialog and state to design\screenshots\.
// Run: npx electron tools/shoot-design.js
'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const UI = path.join(ROOT, 'design-handoff', 'src', 'ui');
const OUT = path.join(ROOT, 'design', 'screenshots');
const page = (p, scenario) => 'file:///' + path.join(UI, p + '.dc.html').replace(/\\/g, '/') + '?scenario=' + scenario;
const J = 'MainDetailed', S = 'SimulationDetailed', MA = 'MaterialsDetailed', MC = 'MachineSetupDetailed';
const clickText = (t) => `(() => { const b = [...document.querySelectorAll('button, [role=menuitem], a')].find((x) => x.textContent.trim() === ${JSON.stringify(t)}); if (!b) return 'missing ${t}'; b.click(); return 'clicked ${t}'; })()`;

const SHOTS = [
  { name: 'job', url: page(J, 'sample') },
  { name: 'job-menu', url: page(J, 'sample'), steps: [clickText('Arrange')] },
  { name: 'job-context-menu', url: page(J, 'sample'), steps: ["(() => { window.__page.setState({ sel: ['r2'] }); window.__page.contextMenu(760, 220, ['r2'], { lx: 220, ly: 60, bed: 0 }); return 'menu'; })()"] },
  { name: 'job-move', url: page(J, 'sample'), steps: ["(() => { window.__page.setState({ tab: 'Move' }); return 'move'; })()"] },
  { name: 'job-queue', url: page(J, 'sample'), steps: ["(() => { window.__page.setState({ tab: 'Queue' }); return 'queue'; })()"] },
  { name: 'send-dialog', url: page(J, 'sample'), wait: 1800, steps: ["(() => { window.__page.sendDialog(false); return 'send'; })()"] },
  { name: 'override-dialog', url: page(J, 'sample'), steps: ["(() => { const P = window.__page, j = P.state.job; P.commit({ ...j, processes: j.processes.map((p, i) => (i === 0 ? { ...p, power: 70, src: 'job' } : p)) }, { record: true }); setTimeout(() => P.sendDialog(false), 100); return 'override'; })()"] },
  { name: 'simulation', url: page(S, 'sample') },
  { name: 'simulation-thermal', url: page(S, 'sample'), steps: ["(() => { const P = window.__page; P.setState({ vis: { ...P.state.vis, heat: true }, t: P.sim.total * 0.7 }); return 'heat'; })()"] },
  { name: 'machines', url: page(MC, 'sample') },
  { name: 'materials', url: page(MA, 'sample') },
  { name: 'new-material-dialog', url: page(MA, 'sample'), steps: ["(() => { window.__page.newMaterial(); return 'dialog'; })()"] },
  { name: 'job-empty', url: page(J, 'empty') },
  { name: 'simulation-empty', url: page(S, 'empty') },
  { name: 'machines-empty', url: page(MC, 'empty') },
  { name: 'materials-empty', url: page(MA, 'empty') }
];

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.setPath('userData', path.join(require('os').tmpdir(), 'pathline-design-shots'));
// one window per screen: don't quit when each one closes
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  let problems = 0;
  for (const s of SHOTS) {
    const w = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, paintWhenInitiallyHidden: true, webPreferences: { sandbox: true, contextIsolation: true } });
    const errs = [];
    w.webContents.on('console-message', (e) => {
      const msg = e.message, lvl = e.level;
      // the template runtime logs unresolved {{bindings}} in SVG attributes while parsing; harmless
      if ((lvl === 'error' || lvl === 3) && !/Expected moveto/.test(msg)) errs.push(msg);
    });
    try { await w.loadURL(s.url); } catch (err) { errs.push('load: ' + err.message); }
    await delay(s.wait || 1500);
    const out = [];
    for (const js of s.steps || []) {
      try { out.push(await w.webContents.executeJavaScript(js, true)); } catch (err) { errs.push(err.message); }
      await delay(700);
    }
    const ok = await w.webContents.executeJavaScript("!!window.api && !!window.__page && !document.body.innerText.includes('Something went wrong')", true);
    if (!ok) errs.push('page did not start');
    fs.writeFileSync(path.join(OUT, s.name + '.png'), (await w.webContents.capturePage()).toPNG());
    console.log((errs.length ? 'FAIL ' : 'ok   ') + s.name + (out.length ? ' · ' + out.join(', ') : '') + (errs.length ? '\n       ' + errs.join('\n       ') : ''));
    problems += errs.length ? 1 : 0;
    w.destroy();
  }
  console.log(problems ? problems + ' screen(s) with problems' : 'All screens rendered');
  app.exit(problems ? 1 : 0);
});

// Electron main process: window, data store, files and the device link.
'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, crashReporter } = require('electron');
const fs = require('fs');
const path = require('path');
const Store = require('./store');
const seed = require('./seed');
const CC = require('../shared/core');
const { importFile, EXTENSIONS } = require('./importers');
const ex = require('./exporters');
const device = require('./device');
const { Reports } = require('./reports');
const updates = require('./updates');

const UI = path.join(__dirname, '..', 'ui');
let store;
let win;
let reports = null;
const clone = (o) => JSON.parse(JSON.stringify(o));

// Crash reports: errors in this process and crashed pages are written to the
// reports folder (see reports.js); native crash dumps go in reports\dumps.
function reportCrash(what, detail) {
  if (reports) return reports.crash(what, detail);
  try { console.error(what, detail); } catch (e) { /* no console */ }
  return null;
}
process.on('uncaughtException', (err) => {
  const folder = reportCrash('main-error', err);
  if (win && !win.isDestroyed()) win.webContents.send('report:crashed', { folder });
});
process.on('unhandledRejection', (err) => { if (reports) reports.log('main', (err && err.stack) || String(err)); });

// ------------------------------------------------------------------ jobs
// Until a machine is added under Setup → Machines, jobs are laid out on this
// stand-in laser bed. It is never stored and can't be sent to.
const NO_MACHINE = Object.freeze({ ...seed.machineTemplate('laser'), id: '', name: 'No machine', kind: 'Add one under Setup → Machines', conn: 'Local', placeholder: true });
function machineById(id) {
  const list = store.get('machines');
  return list.find((m) => m.id === id) || list[0] || clone(NO_MACHINE);
}
function materialFor(type, id) {
  const mats = store.get('materials');
  return mats.find((m) => m.id === id && m.m.includes(type)) || mats.find((m) => m.m.includes(type)) || null;
}
// the material's presets for this machine (its own tab, else the shared ones for
// its type); with no material, or none set up, a job starts with no processes
function presetsFor(material, machine) {
  return clone(CC.presetsFor(material, machine));
}
function newJob(machineId) {
  const settings = store.get('settings');
  const m = machineById(machineId || settings.currentMachine);
  const mat = materialFor(m.type, settings.currentMaterial && settings.currentMaterial[m.type]);
  const bed = (m.info && m.info.bed) || [813, 508];
  return {
    format: 'cjob', version: 2, id: CC.uid('j'),
    name: 'Untitled job', path: null, dirty: false,
    machineId: m.id, machineType: m.type, materialId: mat ? mat.id : null,
    sheet: m.type === 'laser'
      ? { on: false, w: Math.min(600, bed[0]), h: Math.min(400, bed[1]), x: 0, y: 0 }
      : { on: false, w: Math.min(1220, bed[0]), h: Math.min(800, bed[1]), x: 0, y: 0 },
    regMode: m.type === 'laser' && m.info && m.info.f && m.info.f.camera ? 'linear' : 'off',
    processes: presetsFor(mat, m).map((p) => ({ ...p, src: 'preset' })),
    entities: [], beds: 1, cutOrder: { ...CC.CUT_ORDER_DEFAULT },
    createdAt: new Date().toISOString()
  };
}

// The job being edited lives in memory so it survives moving between pages.
// It is not kept between runs: every launch starts with a clean job.
const session = { job: null, undo: [], redo: [] };
function setJob(job, opts) {
  if (opts && opts.record && session.job) {
    session.undo.push(session.job);
    if (session.undo.length > 60) session.undo.shift();
    session.redo = [];
  }
  session.job = job;
  return job;
}
function currentJob() {
  if (!session.job) session.job = newJob();
  return session.job;
}

function addRecent(file, name) {
  const s = store.get('settings');
  const recent = [{ path: file, name }].concat((s.recent || []).filter((r) => r.path !== file)).slice(0, 8);
  store.set('settings', { ...s, recent });
}

// One job file (.cjob) for Save, Save to computer and Save locally. It holds
// everything needed to run the job as set up: the editable job (geometry,
// processes, sheet, registration marks, cut order), the material and machine
// it was set up for, and `run` — the job package with settings in run order,
// the toolpath as simulated and the time estimate.
function jobFileContent(job) {
  const m = machineById(job.machineId);
  const mat = materialFor(m.type, job.materialId);
  const est = CC.estimate(job, m, { timeline: true });
  const run = ex.buildPackage(job, m, mat, est);
  delete run.entities; // the same geometry is in the job itself
  const clean = { ...job };
  delete clean.path;
  delete clean.dirty;
  delete clean.optimise;
  return { ...clean, format: 'cjob', version: 3, savedAt: new Date().toISOString(), material: mat, machine: m, run };
}
function writeJobFile(job, file) {
  fs.writeFileSync(file, JSON.stringify(jobFileContent(job), null, 2));
}

function readJobFile(file) {
  const job = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (job.format !== 'cjob') throw new Error('Not a job file');
  // bring an embedded material and machine into the library if they aren't there yet
  if (job.material && !store.find('materials', job.material.id)) store.upsert('materials', job.material);
  if (job.machine && job.machine.id && !store.find('machines', job.machine.id)) store.upsert('machines', job.machine);
  delete job.material;
  delete job.machine;
  delete job.run;
  delete job.estimate;
  if (!store.find('machines', job.machineId)) {
    const alt = store.get('machines').find((m) => m.type === (job.machineType || 'laser'));
    if (alt) job.machineId = alt.id;
  }
  job.entities = job.entities || [];
  job.processes = (job.processes || []).filter((p) => p.proc !== 'Mark');
  job.path = file;
  job.dirty = false;
  return job;
}

// ------------------------------------------------------------------ exports
async function svgToPdf(svg, wMm, hMm, file) {
  const pdfWin = new BrowserWindow({ show: false, webPreferences: { offscreen: true, javascript: false } });
  const html = '<!doctype html><html><head><style>@page{size:' + wMm + 'mm ' + hMm + 'mm;margin:0}html,body{margin:0}svg{display:block;width:' + wMm + 'mm;height:' + hMm + 'mm}</style></head><body>' + svg.replace(/^<\?xml[^>]*>/, '') + '</body></html>';
  await pdfWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  const data = await pdfWin.webContents.printToPDF({ pageSize: { width: wMm / 25.4, height: hMm / 25.4 }, margins: { marginType: 'none' }, printBackground: true, preferCSSPageSize: true });
  pdfWin.destroy();
  fs.writeFileSync(file, data);
}

// Things that stop a job being sent (e.g. too many registration marks).
function assertSendable(job, m) {
  const blocked = CC.checkJob(job, m).filter((c) => c.block);
  if (blocked.length) throw new Error(blocked.map((c) => c.l).join(' · '));
}

function bumpMaterialUsage(mat) {
  if (!mat) return;
  const fresh = store.find('materials', mat.id);
  if (!fresh) return;
  store.upsert('materials', { ...fresh, jobs: (fresh.jobs || 0) + 1, last: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) });
}

// Pick a .cjob file name with the Save window (remembering the last folder).
async function askJobFile(job, title) {
  const s = store.get('settings');
  const m = machineById(job.machineId);
  const name = device.safeName(((m.info && m.info.prefix) || '') + (job.name || 'job')) + '.cjob';
  const r = await dialog.showSaveDialog(win, {
    title, defaultPath: path.join(s.lastSaveDir || app.getPath('documents'), name),
    filters: [{ name: 'Pathline job', extensions: ['cjob'] }], properties: ['createDirectory', 'showOverwriteConfirmation']
  });
  if (r.canceled) return null;
  store.set('settings', { ...store.get('settings'), lastSaveDir: path.dirname(r.filePath) });
  return r.filePath;
}

// Send a job over Ethernet, or save it locally as a .cjob wherever the user
// picks. Returns where it went, or null when the save window is cancelled.
async function deliver(job, via) {
  const m = machineById(job.machineId);
  if (m.placeholder) throw new Error('Add a machine under Setup → Machines first');
  assertSendable(job, m);
  const mat = materialFor(m.type, job.materialId);
  // a simulated machine has nothing to connect to: its jobs are always saved as files
  const conn = !m.sim && (via || m.conn) === 'Ethernet' ? 'Ethernet' : 'Local';
  let where, total;
  if (conn === 'Ethernet') {
    const est = CC.estimate(job, m, { timeline: true });
    const pkg = ex.buildPackage(job, m, mat, est);
    total = pkg.estimate.total;
    const res = await device.sendPackage(m, { ...pkg, files: { dxf: ex.toDxf(job, m, { onlyOutput: true }), svg: ex.toSvg(job, m), sheet: ex.jobSheet(job, m, mat, est), cjob: jobFileContent(job) } });
    where = m.name + ' (' + m.ip + ')' + (res && res.id ? ' · device job ' + res.id : '');
  } else {
    const file = await askJobFile(job, 'Save job for ' + m.name);
    if (!file) return null;
    const content = jobFileContent(job);
    fs.writeFileSync(file, JSON.stringify(content, null, 2));
    where = file;
    total = content.run.estimate.total;
  }
  bumpMaterialUsage(mat);
  return { ok: true, where, conn, total };
}

// ------------------------------------------------------------------ IPC
function handle(name, fn) {
  ipcMain.handle(name, async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err), offline: !!(err && err.offline) };
    }
  });
}

function registerIpc() {
  handle('app:info', () => ({ version: app.getVersion(), dataDir: store.dir, reportsDir: reports.dir, platform: process.platform, updates: updates.configured() }));

  // bug and crash reports (saved in the reports folder, never sent)
  handle('report:error', (e) => { reports.log('page', (e.page || '') + ' ' + (e.stack || e.message)); });
  handle('report:pending', () => reports.takePending());
  handle('report:openFolder', (folder) => shell.openPath(folder && folder.startsWith(reports.dir) ? folder : reports.dir));
  handle('report:bug', async (fields) => {
    const files = {};
    if (fields.screenshot && win) {
      try { files['screenshot.png'] = (await win.webContents.capturePage()).toPNG(); } catch (e) { /* window hidden */ }
    }
    if (fields.includeJob && session.job) {
      try { files['job.cjob'] = JSON.stringify(jobFileContent(session.job), null, 2); } catch (e) { files['job-error.txt'] = e.stack; }
    }
    const m = session.job ? machineById(session.job.machineId) : null;
    return reports.bug({
      title: fields.title || '', description: fields.description || '', steps: fields.steps || '', page: fields.page || '',
      machine: m ? { name: m.name, type: m.type, ctrl: m.ctrl, conn: m.conn } : null,
      job: session.job ? { name: session.job.name, objects: (session.job.entities || []).length, processes: (session.job.processes || []).length } : null
    }, files);
  });

  // updates (GitHub releases)
  handle('update:check', () => updates.check());
  handle('update:status', () => updates.status());
  handle('update:download', () => updates.download());
  handle('update:install', () => updates.install());
  handle('app:openExternal', (url) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('Only web links can be opened');
    return shell.openExternal(url);
  });
  handle('app:showItem', (p) => shell.showItemInFolder(p));
  handle('app:confirm', async (opts) => {
    const r = await dialog.showMessageBox(win, {
      type: opts.type || 'question', buttons: opts.buttons || ['OK', 'Cancel'], defaultId: 0, cancelId: (opts.buttons || ['OK', 'Cancel']).length - 1,
      title: opts.title || 'Pathline', message: opts.message, detail: opts.detail || ''
    });
    return r.response;
  });
  handle('app:pickFolder', async (title) => {
    const r = await dialog.showOpenDialog(win, { title: title || 'Choose folder', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  handle('settings:get', () => store.get('settings'));
  handle('settings:set', (patch) => store.set('settings', { ...store.get('settings'), ...patch }));

  // machines
  handle('machines:list', () => store.get('machines'));
  handle('machines:save', (m) => store.upsert('machines', m));
  handle('machines:saveAll', (list) => {
    if (!Array.isArray(list)) throw new Error('Not a machine list');
    return store.set('machines', list.filter((m) => !m.placeholder));
  });
  handle('machines:remove', (id) => {
    store.remove('machines', id);
    return store.get('machines');
  });
  handle('machines:create', (type) => {
    const m = { ...seed.machineTemplate(type), id: CC.uid('m'), name: type === 'plotter' ? 'New plotter' : 'New laser' };
    return store.upsert('machines', m);
  });
  // the stand-in shown while no machine is set up
  handle('machines:placeholder', () => clone(NO_MACHINE));
  handle('machines:duplicate', (id) => {
    const src = store.find('machines', id);
    if (!src) throw new Error('Machine not found');
    return store.upsert('machines', { ...clone(src), id: CC.uid('m'), name: src.name + ' copy', syncedAt: null });
  });

  // materials
  handle('materials:list', () => store.get('materials'));
  handle('materials:save', (mat) => store.upsert('materials', { ...mat, edited: 'Edited ' + new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) }));
  handle('materials:saveAll', (list) => store.set('materials', list));
  handle('materials:remove', (id) => { store.remove('materials', id); return store.get('materials'); });
  handle('materials:create', (type) => {
    const t = 3;
    const mat = { id: CC.uid('mat'), g: 'Other', name: 'New material', t, sw: '#E1E4E8', m: [type || 'laser'], notes: '', locked: false, edited: null, jobs: 0, last: null, presets: { laser: type === 'plotter' ? [] : seed.laserPresets(t), plotter: type === 'plotter' ? seed.plotterPresets(t) : [] } };
    return store.upsert('materials', mat);
  });
  handle('materials:duplicate', (id) => {
    const src = store.find('materials', id);
    if (!src) throw new Error('Material not found');
    return store.upsert('materials', { ...clone(src), id: CC.uid('mat'), name: src.name + ' copy', locked: false, jobs: 0, last: null });
  });
  // ids: export just these materials (default: the whole library)
  handle('materials:export', async (ids) => {
    const all = store.get('materials');
    const list = ids && ids.length ? all.filter((m) => ids.includes(m.id)) : all;
    const name = list.length === 1 ? device.safeName(list[0].name + ' ' + list[0].t + 'mm') + '.json' : 'materials.json';
    const r = await dialog.showSaveDialog(win, { title: list.length === 1 ? 'Export material' : 'Export material library', defaultPath: name, filters: [{ name: 'Material library', extensions: ['json'] }] });
    if (r.canceled) return null;
    fs.writeFileSync(r.filePath, JSON.stringify({ format: 'lrc-materials', version: 1, materials: list }, null, 2));
    return r.filePath;
  });
  handle('materials:import', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Import material library', filters: [{ name: 'Material library', extensions: ['json'] }], properties: ['openFile'] });
    if (r.canceled) return null;
    const data = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    const incoming = Array.isArray(data) ? data : data.materials;
    if (!Array.isArray(incoming)) throw new Error('No materials in that file');
    let added = 0, updated = 0;
    for (const mat of incoming) {
      if (!mat || !mat.id || !mat.name) continue;
      if (store.find('materials', mat.id)) updated++; else added++;
      store.upsert('materials', mat);
    }
    return { added, updated };
  });

  // current job
  handle('job:current', () => currentJob());
  handle('job:update', (job, opts) => setJob({ ...job, dirty: true }, opts));
  handle('job:undo', () => {
    if (!session.undo.length) return null;
    session.redo.push(session.job);
    return setJob(session.undo.pop());
  });
  handle('job:redo', () => {
    if (!session.redo.length) return null;
    session.undo.push(session.job);
    return setJob(session.redo.pop());
  });
  handle('job:history', () => ({ undo: session.undo.length, redo: session.redo.length }));
  handle('job:new', async (machineId) => {
    session.undo = []; session.redo = [];
    return setJob(newJob(machineId || (session.job && session.job.machineId)));
  });
  handle('job:replace', (job) => { session.undo = []; session.redo = []; return setJob(job); });
  handle('job:open', async (file) => {
    if (!file) {
      const r = await dialog.showOpenDialog(win, { title: 'Open job', filters: [{ name: 'Job file', extensions: ['cjob'] }], properties: ['openFile'] });
      if (r.canceled) return null;
      file = r.filePaths[0];
    }
    const job = readJobFile(file);
    addRecent(file, job.name);
    session.undo = []; session.redo = [];
    return setJob(job);
  });
  handle('job:save', async (job, as) => {
    const file = (!as && job.path) || (await askJobFile(job, 'Save job'));
    if (!file) return null;
    writeJobFile(job, file);
    addRecent(file, job.name);
    return setJob({ ...job, path: file, dirty: false });
  });
  // Save a copy as the same .cjob file (the open job keeps its own file)
  handle('job:saveToComputer', async (job) => {
    const file = await askJobFile(job, 'Save to computer');
    if (!file) return null;
    writeJobFile(job, file);
    addRecent(file, job.name);
    return file;
  });
  handle('job:export', async (job, fmt) => {
    const m = machineById(job.machineId);
    const isPrint = fmt === 'print';
    const ext = isPrint ? 'pdf' : fmt;
    const r = await dialog.showSaveDialog(win, { title: isPrint ? 'Export print sheet' : 'Export ' + fmt.toUpperCase(), defaultPath: device.safeName(job.name) + (isPrint ? '-print' : '') + '.' + ext, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (r.canceled) return null;
    const bed = (m.info && m.info.bed) || [813, 508];
    if (fmt === 'dxf') fs.writeFileSync(r.filePath, ex.toDxf(job, m));
    else if (fmt === 'svg') fs.writeFileSync(r.filePath, ex.toSvg(job, m));
    else if (fmt === 'sheet') fs.writeFileSync(r.filePath, ex.jobSheet(job, m, materialFor(m.type, job.materialId), CC.estimate(job, m)));
    else if (fmt === 'pdf') await svgToPdf(ex.toSvg(job, m), bed[0], bed[1], r.filePath);
    else if (isPrint) {
      const box = job.sheet && job.sheet.on ? job.sheet : { w: bed[0], h: bed[1] };
      await svgToPdf(ex.toSvg(job, m, { print: true }), box.w, box.h, r.filePath);
    }
    return r.filePath;
  });
  handle('job:importDialog', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Import drawing',
      filters: [{ name: 'Drawings', extensions: EXTENSIONS }, { name: 'DXF', extensions: ['dxf'] }, { name: 'PDF', extensions: ['pdf'] }, { name: 'SVG', extensions: ['svg'] }, { name: 'HPGL / PLT', extensions: ['plt', 'hpgl', 'hpg'] }],
      properties: ['openFile', 'multiSelections']
    });
    if (r.canceled) return [];
    const out = [];
    for (const f of r.filePaths) out.push(await importFile(f));
    return out;
  });
  handle('job:importPath', (file) => importFile(file));
  handle('job:recent', () => (store.get('settings').recent || []).filter((r) => fs.existsSync(r.path)));

  // device (the queue lives on the machine's controller)
  handle('device:jobs', (id) => device.jobs(machineById(id)));
  handle('device:removeJob', (id, jobId) => device.removeJob(machineById(id), jobId));
  handle('device:orderJobs', (id, ids) => device.orderJobs(machineById(id), ids));
  handle('device:test', (m) => device.test(m));
  handle('device:sync', async (id) => {
    const m = machineById(id);
    if (m.sim) throw new Error(m.name + ' is simulated — set its settings on the Machines page');
    if (m.conn !== 'Ethernet') throw new Error(m.name + ' uses ' + m.conn + ' transfer — settings can only be read over Ethernet');
    const info = await device.machineSettings(m);
    const { name: _n, type, ctrl, ...settings } = info || {};
    const merged = {
      ...m, ctrl: ctrl || m.ctrl, type: type === 'laser' || type === 'plotter' ? type : m.type,
      info: { ...(m.info || {}), ...settings, f: { ...((m.info && m.info.f) || {}), ...(settings.f || {}) } },
      syncedAt: new Date().toISOString()
    };
    return store.upsert('machines', merged);
  });
  handle('device:status', (id) => device.status(machineById(id)));
  handle('device:command', (id, cmd, args) => device.command(machineById(id), cmd, args));
  handle('device:send', (job, via) => deliver(job, via));
}

// ------------------------------------------------------------------ window
function createWindow() {
  // match the page background (theme.css --bg) so there's no flash before it paints
  const pref = (store.get('settings') || {}).theme;
  const dark = pref === 'dark' || (pref !== 'light' && nativeTheme.shouldUseDarkColors);
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1024, minHeight: 680,
    title: 'Pathline',
    backgroundColor: dark ? '#0E0F11' : '#F3F4F6',
    autoHideMenuBar: true,
    icon: path.join(UI, 'brand', 'pathline-256.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // keep navigation inside the app's own pages
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  win.on('close', async (e) => {
    if (win.forceClose) return;
    const job = session.job;
    if (job && job.dirty && job.entities && job.entities.length) {
      e.preventDefault();
      const r = await dialog.showMessageBox(win, { type: 'question', buttons: ['Save', "Don't save", 'Cancel'], defaultId: 0, cancelId: 2, message: 'Save changes to "' + job.name + '"?', detail: 'The app starts with a new job next time, so unsaved changes are lost.' });
      if (r.response === 2) return;
      if (r.response === 0) {
        const file = job.path || (await askJobFile(job, 'Save job'));
        if (!file) return;
        writeJobFile(job, file);
      }
      win.forceClose = true;
      win.close();
    }
  });
  // closing the window closes the app
  win.on('closed', () => { win = null; app.quit(); });
  // a crashed page is reported and reloaded
  win.webContents.on('render-process-gone', async (_e, d) => {
    if (d.reason === 'clean-exit' || win.forceClose) return;
    const folder = reportCrash('page-crash', { reason: d.reason, exitCode: d.exitCode, url: win.webContents.getURL() });
    const r = await dialog.showMessageBox(win, { type: 'error', buttons: ['Reload', 'Show report', 'Close Pathline'], defaultId: 0, cancelId: 0, message: 'Pathline stopped working', detail: 'A crash report was saved' + (folder ? ' in ' + folder : '') + '. Unsaved changes to the job are kept in memory; reload to carry on.' });
    if (r.response === 1 && folder) shell.openPath(folder);
    if (r.response === 2) { win.forceClose = true; win.close(); return; }
    win.loadFile(path.join(UI, 'MainDetailed.dc.html'));
  });
  win.webContents.on('unresponsive', () => reports && reports.log('page', 'window not responding'));
  // check for updates each time the app opens; the page asks before anything downloads
  win.webContents.once('did-finish-load', () => {
    // test runs skip update checks unless LRC_UPDATES=1
    if (process.env.LRC_SHOT && process.env.LRC_UPDATES !== '1') return;
    updates.setup((k, m) => reports.log(k, m), (s) => { if (win && !win.isDestroyed()) win.webContents.send('update:state', s); });
    // a found update is sent to the window as 'available', which asks the operator
    setTimeout(() => updates.check(), 3000);
  });
  if (process.env.LRC_SHOT) attachTestHarness(win);
  win.loadFile(path.join(UI, process.env.LRC_PAGE || 'MainDetailed.dc.html'));
}

// Development aid: LRC_SHOT=<dir> logs the console, runs the steps in
// LRC_STEPS (a JSON file of {js, wait, shot}) and saves screenshots, then quits.
function attachTestHarness(w) {
  const dir = process.env.LRC_SHOT;
  fs.mkdirSync(dir, { recursive: true });
  w.webContents.on('console-message', (e, level, message) => {
    console.log('[page:' + (e.level !== undefined ? e.level : level) + '] ' + (e.message !== undefined ? e.message : message));
  });
  w.webContents.on('render-process-gone', (_e, d) => console.log('[renderer gone] ' + d.reason));
  let ran = false;
  w.webContents.on('did-finish-load', async () => {
    if (ran) return;
    ran = true;
    console.log('[harness] ' + w.webContents.getURL());
    const steps = process.env.LRC_STEPS ? JSON.parse(fs.readFileSync(process.env.LRC_STEPS, 'utf8').replace(/^﻿/, '')) : [{ wait: 1500, shot: 'page' }];
    for (const s of steps) {
      if (s.wait) await new Promise((r) => setTimeout(r, s.wait));
      if (s.js) {
        try { console.log('[step] ' + JSON.stringify(await w.webContents.executeJavaScript(s.js, true))); } catch (err) { console.log('[step error] ' + err.message); }
      }
      if (s.shot) fs.writeFileSync(path.join(dir, s.shot + '.png'), (await w.webContents.capturePage()).toPNG());
    }
    w.forceClose = true;
    app.quit();
  });
}

function openFromArgs(argv) {
  const f = argv.find((a) => /\.cjob$/i.test(a) && fs.existsSync(a));
  if (!f) return false;
  try {
    const job = readJobFile(f);
    addRecent(f, job.name);
    session.undo = []; session.redo = [];
    setJob(job);
    return true;
  } catch (e) { return false; }
}

// test runs (LRC_SHOT) get their own profile and may run beside an open copy of the app
const testRun = !!process.env.LRC_SHOT;
if (testRun) {
  app.setPath('userData', path.join(require('os').tmpdir(), 'lrc-test-profile'));
  // keep painting even when the test window is covered by other windows
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
}
// native crash dumps (renderer/GPU/main) are kept locally in the reports folder
if (!testRun) {
  try {
    app.setPath('crashDumps', path.join(app.getPath('userData'), 'reports', 'dumps'));
    crashReporter.start({ uploadToServer: false, compress: true });
  } catch (e) { /* crash dumps unavailable */ }
}
if (!testRun && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (openFromArgs(argv) && win) win.loadFile(path.join(UI, 'MainDetailed.dc.html'));
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(() => {
    const dataDir = process.env.LRC_DATA_DIR || path.join(app.getPath('userData'), 'data');
    // renamed from "Laser & Router Control": bring its machines and materials across once
    const oldDir = path.join(app.getPath('appData'), 'Laser & Router Control', 'data');
    if (!process.env.LRC_DATA_DIR && !fs.existsSync(dataDir) && fs.existsSync(oldDir)) {
      try { fs.cpSync(oldDir, dataDir, { recursive: true }); } catch (e) { /* start fresh */ }
    }
    store = new Store(dataDir);
    // bug and crash reports live beside the data folder
    reports = new Reports(path.join(path.dirname(dataDir), 'reports'), () => ({ version: app.getVersion(), packaged: app.isPackaged }));
    reports.startSession();
    app.on('child-process-gone', (_e, d) => { if (d.reason !== 'clean-exit' && d.reason !== 'killed') reportCrash('process-crash', { type: d.type, reason: d.reason, exitCode: d.exitCode, name: d.name }); });
    // USB-drive and folder connections were replaced by "Save locally"
    const ms = store.get('machines');
    if (ms.some((m) => m.conn !== 'Ethernet' && m.conn !== 'Local')) store.set('machines', ms.map((m) => (m.conn === 'Ethernet' ? m : { ...m, conn: 'Local' })));
    // the low-power "Mark" process type was removed: drop it from presets and the open job
    const isMark = (p) => p && p.proc === 'Mark';
    const mats = store.get('materials');
    if (mats.some((m) => (m.presets.laser || []).some(isMark))) {
      store.set('materials', mats.map((m) => ({ ...m, presets: { ...m.presets, laser: (m.presets.laser || []).filter((p) => !isMark(p)) } })));
    }
    // thermal data now comes only from the reference table: drop per-material copies
    const lib = store.get('materials');
    if (lib.some((m) => m.thermal)) store.set('materials', lib.map((m) => { const { thermal, ...rest } = m; return rest; }));
    // earlier builds seeded sample machines and materials: remove them once, by
    // their ids (anything the operator added keeps its own id and stays)
    const prefs = store.get('settings');
    if (!prefs.samplesRemoved) {
      const SAMPLE_MACHINES = ['trotec', 'flatbed', 'laser2'];
      const SAMPLE_MATERIALS = ['acr-print-3', 'acr-clear-3', 'acr-clear-5', 'acr-white-3', 'birch-3', 'birch-6', 'mdf-6', 'foam-5', 'corr-3', 'grey-2', 'pet-025', 'mag-08',
        'ss304-1', 'ss316-1', 'ms-1.5', 'alu-anod-1', 'alu-1', 'brass-1'];
      store.set('machines', store.get('machines').filter((m) => !SAMPLE_MACHINES.includes(m.id)));
      store.set('materials', store.get('materials').filter((m) => !SAMPLE_MATERIALS.includes(m.id)));
      const keep = (id, list) => (list.some((x) => x.id === id) ? id : null);
      const cur = prefs.currentMaterial || {};
      store.set('settings', {
        ...prefs, samplesRemoved: true,
        currentMachine: keep(prefs.currentMachine, store.get('machines')),
        currentMaterial: { laser: keep(cur.laser, store.get('materials')), plotter: keep(cur.plotter, store.get('materials')) }
      });
    }
    // the job is no longer restored between runs: drop the old autosave file
    try { fs.unlinkSync(store.file('session')); } catch (e) { /* not there */ }
    registerIpc();
    currentJob();
    openFromArgs(process.argv);
    // hidden menu that only carries the developer shortcuts
    // (page shortcuts like Ctrl+R and F5 belong to the app, so no reload/zoom roles here)
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'View', submenu: [{ role: 'toggleDevTools' }, { role: 'togglefullscreen' }] }]));
    createWindow();
  });
  // make sure nothing (a slow network request, a hidden export window) keeps
  // the app running in the background after it is closed
  app.on('will-quit', () => {
    if (reports) reports.endSession();
    setTimeout(() => app.exit(0), 3000);
  });
  app.on('window-all-closed', () => app.quit());
}

module.exports = { newJob };

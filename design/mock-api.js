// Stand-in for the Electron bridge (window.api) so the pages open on their own
// in a browser or design tool, filled with sample data. Nothing is saved to
// disk: state lives in sessionStorage so moving between pages keeps the job.
//
// ?scenario=sample (default) or ?scenario=empty on any page resets the data.
// Inside the real app window.api already exists and this file does nothing.
(function () {
  'use strict';
  if (window.api) return;
  const CC = window.CC;
  const KEY = 'pathline-design-mock';
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const wait = (v, ms) => new Promise((r) => setTimeout(() => r(clone(v === undefined ? null : v)), ms || 30));
  const toast = (msg) => { if (window.LRC && window.LRC.toast) window.LRC.toast(msg + ' (design preview)'); };

  // ---------------------------------------------------------------- sample data
  const laserInfo = {
    bed: [813, 508], speed: 3000, acc: 40000, origin: 'tl', units: 'mm', home: true, prefix: 'LA-',
    source: 'CO2', power: 80, lens: '2.0"', pwm: 5000, minPower: 8, focus: '0.0', airDefault: 'High',
    markType: 'Dot', markD: '5.0', camX: '-42.15', camY: '18.60', calibrated: '12 Oct 2026', lid: true, exhaust: '10',
    f: { camera: true, autofocus: true, rotary: false, air: true, pass: false, interlock: true }
  };
  const plotterInfo = {
    bed: [1600, 1000], speed: 1000, acc: 8000, origin: 'tl', units: 'mm', home: true, prefix: 'PB-',
    vacStart: true, vacEnd: true, vacDelay: '3',
    heads: [['T1', 'Knife'], ['T2', 'V-cut 45°'], ['T3', 'Crease wheel'], ['T4', 'Pen']].map(([slot, tool], i) => ({ slot, tool, x: (i * 24.5).toFixed(2), y: '0.00', loaded: true })),
    ptrX: '-31.20', ptrY: '12.75', measured: '21 Oct 2026', headStop: true,
    feedLen: 1000, feedOver: '5.0', autoFeed: true, feedVac: true,
    timing: { toolDown: 0.15, toolUp: 0.12, toolChange: 8, feedSpeed: 200, feedSettle: 3 },
    f: { conveyor: true, vacuum: true, pointer: true, camera: false, detect: true }
  };
  const machines = () => [
    { id: 'laser-a', name: 'Laser A', type: 'laser', kind: 'Laser · CO2', ctrl: 'Trotec', conn: 'Ethernet', ip: '192.168.1.40', port: 8470, timeout: 3000, info: laserInfo, syncedAt: '2026-10-28T09:12:00Z' },
    { id: 'plotter-b', name: 'Plotter B', type: 'plotter', kind: 'Plotter · 4 heads', ctrl: 'Ruida', conn: 'Ethernet', ip: '192.168.1.52', port: 8470, timeout: 3000, info: plotterInfo, syncedAt: null },
    { id: 'laser-c', name: 'Laser C', type: 'laser', kind: 'Laser · CO2', ctrl: 'Ruida', conn: 'Local', ip: '', port: 8470, timeout: 3000,
      info: { ...laserInfo, bed: [1300, 900], speed: 600, acc: 8000, power: 100, f: { camera: false, autofocus: false, rotary: true, air: true } }, syncedAt: null }
  ];
  const mat = (id, g, name, t, sw, m, notes, extra) => ({
    id, g, name, t, sw, m, notes, locked: false, edited: null, jobs: 0, last: null,
    presets: { laser: m.includes('laser') ? CC.defaultPresets('laser', t) : [], plotter: m.includes('plotter') ? CC.defaultPresets('plotter', t) : [] },
    ...extra
  });
  const materials = () => [
    mat('acr-3', 'Acrylic', 'Cast acrylic, clear', 3, '#E3EEF3', ['laser'], 'Remove film both sides', { jobs: 14, last: '27 Oct 2026' }),
    mat('acr-print-3', 'Acrylic', 'Printed acrylic', 3, '#DCE3EC', ['laser'], 'Print side up'),
    mat('birch-3', 'Wood', 'Birch ply', 3, '#E9D9BC', ['laser'], 'B/BB grade', { locked: true }),
    mat('foam-5', 'Board & card', 'Foam board', 5, '#F1EDE4', ['plotter'], ''),
    mat('corr-3', 'Board & card', 'Corrugated board', 3, '#D8B98C', ['laser', 'plotter'], 'Flute direction along X'),
    { ...mat('ss304-1', 'Metal', 'Stainless steel 304', 1, '#C9CCD1', ['laser'], 'Mark with marking spray on CO2'), presets: { laser: CC.metalPresets(1), plotter: [] } }
  ];
  // the sample part: rounded outline with a slot, three rings with a registration mark in each
  function sampleEntities() {
    const E = (x, y, r) => CC.shapes.ellipse(x, y, r, r);
    const ring = (id, name, x, y) => ({ id, name, type: 'Path', aci: 7, paths: [{ p: E(x, y, 15), c: true }, { p: E(x, y, 6), c: true }], group: null, bed: 0 });
    const mark = (id, name, x, y) => ({ id, name, type: 'Path', aci: 9, paths: [{ p: E(x, y, 6), c: true }], group: null, bed: 0 });
    return [
      { id: 'outline', name: 'Outline', type: 'Path', aci: 1, paths: [{ p: CC.shapes.rect(60, 40, 150, 420, 20), c: true }], group: null, bed: 0 },
      { id: 'slot', name: 'Slot', type: 'Path', aci: 1, paths: [{ p: CC.shapes.rect(120, 100, 30, 300, 4), c: true }], group: null, bed: 0 },
      ring('r1', 'Ring', 85, 75), ring('r2', 'Ring 2', 185, 75), ring('r3', 'Ring 3', 95, 425),
      mark('m1', 'Mark', 85, 75), mark('m2', 'Mark 2', 185, 75), mark('m3', 'Mark 3', 95, 425),
      { id: 'label', name: 'Label', type: 'Path', aci: 5, paths: [{ p: CC.shapes.rect(300, 60, 160, 40, 6), c: true }], group: null, bed: 0 },
      { id: 'tear', name: 'Tear line', type: 'Line', aci: 3, paths: [{ p: [[300, 200], [520, 200]], c: false }], group: null, bed: 0 }
    ];
  }

  const NO_MACHINE = { id: '', name: 'No machine', type: 'laser', kind: 'Add one under Setup → Machines', ctrl: '', conn: 'Local', placeholder: true, info: { bed: [800, 500], speed: 1000, acc: 10000, origin: 'tl', f: {} } };

  function newJob(st, machineId) {
    const m = st.machines.find((x) => x.id === machineId) || st.machines[0] || NO_MACHINE;
    const want = st.settings.currentMaterial && st.settings.currentMaterial[m.type];
    const mt = st.materials.find((x) => x.id === want && x.m.includes(m.type)) || st.materials.find((x) => x.m.includes(m.type)) || null;
    const bed = m.info.bed;
    const pre = (mt && CC.presetsFor(mt, m)) || [];
    return {
      format: 'cjob', version: 2, id: CC.uid('j'), name: 'Untitled job', path: null, dirty: false,
      machineId: m.id, machineType: m.type, materialId: mt ? mt.id : null,
      sheet: { on: false, w: Math.min(600, bed[0]), h: Math.min(400, bed[1]), x: 0, y: 0 },
      regMode: m.type === 'laser' && m.info.f && m.info.f.camera ? 'linear' : 'off',
      processes: (pre.length ? pre : CC.defaultPresets(m.type, mt ? mt.t : 3)).map((p) => ({ ...p, src: 'preset' })),
      entities: [], beds: 1, cutOrder: { ...CC.CUT_ORDER_DEFAULT }, createdAt: new Date().toISOString()
    };
  }

  function fresh(scenario) {
    const empty = scenario === 'empty';
    const st = {
      scenario,
      machines: empty ? [] : machines(),
      materials: empty ? [] : materials(),
      settings: { currentMachine: empty ? null : 'laser-a', currentMaterial: empty ? {} : { laser: 'acr-3', plotter: 'foam-5' }, recent: empty ? [] : [{ path: 'C:\\Jobs\\window-signs.cjob', name: 'window signs' }, { path: 'C:\\Jobs\\batch-14.cjob', name: 'batch 14' }], autosave: true, accent: '#2457D6' },
      undo: [], redo: [],
      queue: empty ? [] : [
        { id: 'J0012', name: 'batch-14 · window signs', status: 'running', progress: 0.42, seconds: 1820, receivedAt: '2026-10-28T09:40:00Z', finishedAt: null },
        { id: 'J0013', name: 'Rings ×3', status: 'queued', progress: 0, seconds: 183, receivedAt: '2026-10-28T09:52:00Z', finishedAt: null },
        { id: 'J0011', name: 'Test grid · acrylic', status: 'done', progress: 1, seconds: 410, receivedAt: '2026-10-28T08:10:00Z', finishedAt: '2026-10-28T08:17:00Z' }
      ]
    };
    st.job = newJob(st);
    if (!empty) {
      st.job.name = 'Rings with registration marks';
      st.job.entities = sampleEntities();
      st.job.processes = st.job.processes.filter((p) => !CC.isRegProc(p)).concat({ ...CC.regProcess(), aci: [9] });
      st.job.sheet = { on: true, w: 600, h: 480, x: 30, y: 15 };
    }
    return st;
  }

  // ---------------------------------------------------------------- state
  const q = new URLSearchParams(location.search).get('scenario');
  let st = null;
  try { st = q ? null : JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) { st = null; }
  if (!st) st = fresh(q || 'sample');
  const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { /* storage unavailable */ } };
  save();
  const machine = (id) => st.machines.find((m) => m.id === id) || st.machines[0] || NO_MACHINE;
  const upsert = (list, item) => { const i = st[list].findIndex((x) => x.id === item.id); if (i >= 0) st[list][i] = item; else st[list].push(item); save(); return item; };
  const setJob = (job, opts) => {
    if (opts && opts.record && st.job) { st.undo.push(st.job); if (st.undo.length > 30) st.undo.shift(); st.redo = []; }
    st.job = job; save(); return job;
  };
  const sampleImport = () => {
    const ents = sampleEntities().filter((e) => e.id === 'outline' || e.id === 'slot').map((e) => ({ ...e, id: CC.uid('e'), name: 'Imported ' + e.name }));
    const b = CC.boxOf(ents);
    return { file: 'sample.dxf', name: 'sample.dxf', ext: 'dxf', entities: ents, width: CC.boxW(b), height: CC.boxH(b), pieces: ents.length, skipped: {}, units: 'mm' };
  };

  // ---------------------------------------------------------------- api
  window.api = {
    app: {
      info: () => wait({ version: '1.0.0 (design preview)', dataDir: '(not saved in the design preview)', platform: 'win32' }),
      openExternal: () => { toast('Opens a web page in the browser'); return wait(null); },
      showItem: () => wait(null),
      confirm: () => wait(0),
      pickFolder: () => wait('C:\\Jobs')
    },
    settings: {
      get: () => wait(st.settings),
      set: (patch) => { st.settings = { ...st.settings, ...patch }; save(); return wait(st.settings); }
    },
    machines: {
      list: () => wait(st.machines),
      save: (m) => wait(upsert('machines', m)),
      saveAll: (list) => { st.machines = list.filter((m) => !m.placeholder); save(); return wait(st.machines); },
      remove: (id) => { st.machines = st.machines.filter((m) => m.id !== id); save(); return wait(st.machines); },
      create: (type) => wait(upsert('machines', { ...clone(type === 'plotter' ? machines()[1] : machines()[0]), id: CC.uid('m'), name: type === 'plotter' ? 'New plotter' : 'New laser', ip: '', syncedAt: null })),
      duplicate: (id) => { const s = machine(id); return wait(upsert('machines', { ...clone(s), id: CC.uid('m'), name: s.name + ' copy', syncedAt: null })); },
      placeholder: () => wait(NO_MACHINE)
    },
    materials: {
      list: () => wait(st.materials),
      save: (m) => wait(upsert('materials', m)),
      saveAll: (list) => { st.materials = list; save(); return wait(st.materials); },
      remove: (id) => { st.materials = st.materials.filter((m) => m.id !== id); save(); return wait(st.materials); },
      create: (type) => wait(upsert('materials', mat(CC.uid('mat'), 'Other', 'New material', 3, '#E1E4E8', [type || 'laser'], ''))),
      duplicate: (id) => { const s = st.materials.find((m) => m.id === id); return wait(upsert('materials', { ...clone(s), id: CC.uid('mat'), name: s.name + ' copy', locked: false })); },
      exportLib: () => wait('C:\\Jobs\\materials.json'),
      importLib: () => { toast('Imports a material library file'); return wait(null); }
    },
    job: {
      current: () => wait(st.job),
      update: (job, opts) => wait(setJob({ ...job, dirty: true }, opts), 0),
      undo: () => { if (!st.undo.length) return wait(null); st.redo.push(st.job); return wait(setJob(st.undo.pop())); },
      redo: () => { if (!st.redo.length) return wait(null); st.undo.push(st.job); return wait(setJob(st.redo.pop())); },
      history: () => wait({ undo: st.undo.length, redo: st.redo.length }),
      create: (machineId) => { st.undo = []; st.redo = []; return wait(setJob(newJob(st, machineId || st.job.machineId))); },
      replace: (job) => { st.undo = []; st.redo = []; return wait(setJob(job)); },
      open: () => { toast('Opens a .cjob file'); return wait(null); },
      save: (job) => wait(setJob({ ...job, path: 'C:\\Jobs\\' + (job.name || 'job') + '.cjob', dirty: false })),
      saveToComputer: (job) => wait('C:\\Jobs\\' + (job.name || 'job') + '.cjob'),
      exportAs: (job, fmt) => wait('C:\\Jobs\\' + (job.name || 'job') + '.' + (fmt === 'print' ? 'pdf' : fmt)),
      importDialog: () => wait([sampleImport()], 200),
      importPath: () => wait(sampleImport(), 200),
      recent: () => wait(st.settings.recent || [])
    },
    device: {
      test: (m) => (m.conn === 'Ethernet' && m.ip ? wait({ ok: true, ms: 12, info: { model: 'Sample controller' } }, 400) : Promise.reject(new Error('No IP address set for ' + m.name))),
      sync: (id) => wait(upsert('machines', { ...machine(id), syncedAt: new Date().toISOString() }), 500),
      status: (id) => {
        const m = machine(id);
        if (m.conn !== 'Ethernet' || !m.ip) { const e = new Error('No IP address set for ' + m.name); e.offline = true; return Promise.reject(e); }
        return wait({ state: 'idle', pos: { x: 120.5, y: 84.25, z: 0 }, progress: 0, job: null, message: '', io: { air: false, pointer: false, vacuum: false, exhaust: true } });
      },
      command: () => wait({ ok: true }),
      send: (job) => {
        const m = machine(job.machineId);
        if (m.placeholder) return Promise.reject(new Error('Add a machine under Setup → Machines first'));
        const total = CC.fmtDuration(CC.estimate(job, m).total);
        return wait(m.conn === 'Ethernet' ? { ok: true, where: m.name + ' (' + m.ip + ') · device job J0014', conn: 'Ethernet', total } : { ok: true, where: 'C:\\Jobs\\' + job.name + '.cjob', conn: 'Local', total }, 1200);
      },
      jobs: () => wait(st.queue),
      removeJob: (id, jobId) => { st.queue = st.queue.filter((j) => j.id !== jobId); save(); return wait({ ok: true }); },
      orderJobs: (id, ids) => { const rank = new Map(ids.map((x, i) => [x, i])); st.queue.sort((a, b) => (rank.has(a.id) && rank.has(b.id) ? rank.get(a.id) - rank.get(b.id) : 0)); save(); return wait({ ok: true }); }
    },
    report: {
      bug: () => { toast('Saves a bug report folder'); return wait('C:\\Users\\you\\AppData\\Roaming\\Pathline\\reports\\bug-sample'); },
      error: () => wait(null), pending: () => wait(null), openFolder: () => wait(null), crashed: () => {}
    },
    update: { check: () => wait({ state: 'current', version: '1.1.0' }, 400), status: () => wait({ state: 'idle', version: '1.1.0' }), install: () => wait(null), onState: () => {} },
    pathOf: (file) => file.name
  };
})();

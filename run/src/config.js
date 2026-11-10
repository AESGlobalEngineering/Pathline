// Machine settings, kept on the HMI (GET /machine reports them to Pathline).
// Stored as config.json in the data folder. The installed app uses
// %APPDATA%\Pathline Run\data (Windows) or ~/.config/Pathline Run/data (Pi);
// src/server.js run on its own uses the folders below.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function dataDir(override) {
  if (override) return path.resolve(override);
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Pathline Run');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'pathline-run');
}

// Starting values per controller when a machine is added (no name, port or IP: the operator sets those).
// Trotec values are from the Q500 in TROTEC_PROTOCOL.md.
const PRESETS = {
  trotec: {
    name: '', bed: [1300, 900], speed: 2000, acc: 20000, power: 130, source: 'CO2', lens: '2.0"', minPower: 0,
    connection: { mode: 'serial', port: 'auto', host: '', tcpPort: 4713, ip: '' }, // auto: find the Trotec by its USB id
    f: { air: true, pointer: false, camera: false, autofocus: false, rotary: false, interlock: true }
  },
  ruida: {
    name: '', bed: [900, 600], speed: 500, acc: 3000, power: 100, source: 'CO2', lens: '2.0"', minPower: 10,
    connection: { mode: 'udp', port: '', host: '', tcpPort: 4713, ip: '' },
    f: { air: false, pointer: false, camera: false, autofocus: false, rotary: false, interlock: false, conveyor: false, vacuum: false }
  }
};

// a plotter's tools: slot → the Ruida output (1–4) that lowers it
const PLOTTER_HEADS = [
  { slot: 'T1', tool: 'Knife', output: 1 },
  { slot: 'T2', tool: 'V-cut 45°', output: 2 },
  { slot: 'T3', tool: 'Crease wheel', output: 3 },
  { slot: 'T4', tool: 'Pen', output: 4 }
];

const BASE = {
  configured: false,             // true once a machine has been added in Setup
  controller: 'trotec',
  httpPort: 8470,
  origin: 'tl', units: 'mm', home: true, prefix: '',
  regMarks: 'refuse',            // 'refuse' or 'ignore' (run without print-and-cut correction)
  removeDone: true,              // completed jobs leave the queue for History
  returnHead: true,              // after a completed job the head goes back to where it was at Start
  manual: [],                    // settings typed in Setup over the controller's own ('bed.0', 'speed' …)
  knifeHome: null,               // RDD6584: where the head homes and parks, controller mm (learnt)
  vision: { enabled: false },    // the Trotec's head camera (vision/vision.js DEFAULTS for the rest)
  trotec: { unit: 0.010125, offset: [14.833125, 9.527625], laserSource: 5, travelSpeed: 700, maxSpeed: 2000, travel: 'standard', airOutput: 4, overscan: 10, cutPowerCorrection: 15, engravePowerCorrection: 20 },
  type: 'laser',                 // 'laser' or 'plotter' (Trotec: always laser; Ruida: from the model)
  ruida: { model: 'RDC6442G', magic: 0x88, origin: 'tr' },
  // plotters only
  heads: PLOTTER_HEADS,
  feedLen: 1000,                 // conveyor: material advanced per bed, mm
  timing: { toolDown: 0.15, toolUp: 0.12, toolChange: 8, feedSpeed: 200, feedSettle: 3 },
  sim: { speedup: 20 }
};

// settings that belong to Pathline Run, not to the machine (kept when a machine is removed)
const APP_PREFS = ['httpPort', 'regMarks', 'removeDone', 'returnHead', 'prefix', 'sim'];

// the setup with the machine removed
function withoutMachine(cfg) {
  const keep = Object.fromEntries(Object.entries(cfg).filter(([k]) => APP_PREFS.includes(k)));
  return { ...defaults(cfg.controller), ...keep, configured: false };
}

function defaults(controller) {
  const c = controller === 'ruida' ? 'ruida' : 'trotec';
  return JSON.parse(JSON.stringify({ ...BASE, ...PRESETS[c], controller: c }));
}

// merge saved/edited values over the defaults, one level deep for objects
function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) out[k] = { ...base[k], ...v };
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

function load(dir, overrides) {
  const file = path.join(dir, 'config.json');
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* first run */ }
  // no machine added yet (or settings from before machines were added): keep only the app's own preferences
  if (!saved.configured) saved = Object.fromEntries(Object.entries(saved).filter(([k]) => APP_PREFS.includes(k)));
  const ctrl = (overrides && overrides.controller) || saved.controller;
  let cfg = merge(defaults(ctrl), saved);
  if (overrides) cfg = merge(cfg, overrides);
  return cfg;
}

function save(dir, cfg) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
}

// laser or plotter (a Trotec is always a laser)
const machineType = (cfg) => (cfg.controller === 'ruida' && cfg.type === 'plotter' ? 'plotter' : 'laser');

// Where the head may go with the beam off, [x0, y0, x1, y1] bed mm. A Trotec's own zero (where it
// homes) is its factory offset behind and left of the bed's corner (14.8, 9.5 mm on the Q500):
// jogging and the camera may use that strip; cutting stays on the bed. Others: the bed
function travelBox(cfg) {
  const [W, H] = cfg.bed;
  if (cfg.controller !== 'trotec') return [0, 0, W, H];
  const off = (cfg.trotec && cfg.trotec.offset) || [14.833125, 9.527625];
  return [-Math.max(0, off[0]), -Math.max(0, off[1]), W, H];
}

// Where the head camera can read a mark, [x0, y0, x1, y1] bed mm: the laser (= camera + offset)
// within its travel, the mark on the bed
function markArea(offset, bed, travel) {
  const [W, H] = bed, [ox, oy] = offset, t = travel || [0, 0, W, H];
  return [Math.max(0, t[0] - ox), Math.max(0, t[1] - oy), Math.min(W, t[2] - ox), Math.min(H, t[3] - oy)];
}

// What Pathline sees in GET /machine
function machineView(cfg) {
  const base = { bed: cfg.bed, speed: cfg.speed, acc: cfg.acc, origin: cfg.origin, units: cfg.units, home: cfg.home, prefix: cfg.prefix };
  if (machineType(cfg) === 'plotter') {
    return {
      ...base,
      heads: (cfg.heads || []).map((h) => ({ slot: h.slot, tool: h.tool, x: '0.00', y: '0.00', loaded: true })),
      feedLen: cfg.feedLen, timing: cfg.timing,
      f: { conveyor: !!cfg.f.conveyor, vacuum: !!cfg.f.vacuum, pointer: !!cfg.f.pointer, camera: false, detect: false }
    };
  }
  // the Trotec: travel as it really moves (motion.js). Pathline times travel at one acceleration
  // with no jerk limit, so it gets the acceleration that takes as long over a short move; with the
  // Q500's 20000 mm/s² and 2000 mm/s it put 20 s on travel that took 160
  if (cfg.controller === 'trotec') {
    const motion = require('./ctrl/trotec/motion');
    const P = require('./ctrl/trotec/compile').PLANNER.Standard;
    const lim = motion.travelLimits(cfg, P, (cfg.trotec && cfg.trotec.travelSpeed) || 700);
    base.acc = motion.equivalentAcc(lim);
    base.travelSpeed = lim.v;
    // the real figures, for Prepare 1.6.0 on (HMI-BRIEF §5): it times every move as an S-curve
    // with them (older ones read acc above)
    base.travelAcc = lim.a;
    base.jerk = lim.j;
  }
  // the Trotec's head camera: Pathline offers print and cut (registration marks) when it's on
  const v = cfg.vision || {};
  const cam = cfg.controller === 'trotec' && !!v.enabled;
  const off = v.offset || [41.437, 12.731];
  // markArea: where registration marks must be for the camera to read them (bed mm, x0 y0 x1 y1);
  // Pathline places marks inside it (it couldn't work it out from camX/camY: the head's travel
  // past the bed isn't in the machine settings)
  const area = cam ? markArea(off, cfg.bed, travelBox(cfg)).map((q) => +q.toFixed(1)) : null;
  return {
    ...base, source: cfg.source, power: cfg.power, lens: cfg.lens, minPower: cfg.minPower,
    ...(cam ? { markType: 'Dot', camX: off[0].toFixed(2), camY: off[1].toFixed(2), markArea: area, calibrated: v.calibrated ? new Date(v.calibrated).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '' } : {}),
    f: { camera: cam, autofocus: false, rotary: false, air: !!cfg.f.air, pointer: !!cfg.f.pointer, pass: false, interlock: !!cfg.f.interlock, conveyor: false, vacuum: false }
  };
}

module.exports = { dataDir, defaults, load, save, merge, machineView, machineType, withoutMachine, travelBox, markArea, PRESETS, PLOTTER_HEADS };

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
  trotec: { unit: 0.010125, offset: [14.833125, 9.527625], laserSource: 5, travelSpeed: 700, maxSpeed: 2000, airOutput: 4, overscan: 10, cutPowerCorrection: 15, engravePowerCorrection: 20 },
  type: 'laser',                 // 'laser' or 'plotter' (Trotec: always laser; Ruida: from the model)
  ruida: { model: 'RDC6442G', magic: 0x88, origin: 'tr' },
  // plotters only
  heads: PLOTTER_HEADS,
  feedLen: 1000,                 // conveyor: material advanced per bed, mm
  timing: { toolDown: 0.15, toolUp: 0.12, toolChange: 8, feedSpeed: 200, feedSettle: 3 },
  sim: { speedup: 20 }
};

// settings that belong to Pathline Run, not to the machine (kept when a machine is removed)
const APP_PREFS = ['httpPort', 'regMarks', 'removeDone', 'prefix', 'sim'];

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
  return {
    ...base, source: cfg.source, power: cfg.power, lens: cfg.lens, minPower: cfg.minPower,
    f: { camera: false, autofocus: false, rotary: false, air: !!cfg.f.air, pointer: !!cfg.f.pointer, pass: false, interlock: !!cfg.f.interlock, conveyor: false, vacuum: false }
  };
}

module.exports = { dataDir, defaults, load, save, merge, machineView, machineType, withoutMachine, PRESETS, PLOTTER_HEADS };

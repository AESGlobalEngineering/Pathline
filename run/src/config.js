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

// Starting values per controller. Trotec values are from the Q500 in TROTEC_PROTOCOL.md.
const PRESETS = {
  trotec: {
    name: 'Trotec Q500', bed: [1300, 900], speed: 2000, acc: 20000, power: 130, source: 'CO2', lens: '2.0"', minPower: 0,
    connection: { mode: 'serial', port: process.platform === 'win32' ? 'COM4' : '/dev/ttyACM0', host: '', tcpPort: 4713, ip: '' },
    f: { air: true, pointer: false, camera: false, autofocus: false, rotary: false, interlock: true }
  },
  ruida: {
    name: 'Ruida laser', bed: [900, 600], speed: 500, acc: 3000, power: 100, source: 'CO2', lens: '2.0"', minPower: 10,
    connection: { mode: 'udp', port: '', host: '', tcpPort: 4713, ip: '192.168.1.100' },
    f: { air: false, pointer: false, camera: false, autofocus: false, rotary: false, interlock: false }
  }
};

const BASE = {
  controller: 'trotec',
  httpPort: 8470,
  origin: 'tl', units: 'mm', home: true, prefix: '',
  regMarks: 'refuse',            // 'refuse' or 'ignore' (run without print-and-cut correction)
  removeDone: true,              // completed jobs leave the queue for History
  trotec: { unit: 0.010125, offset: [14.833125, 9.527625], laserSource: 5, travelSpeed: 700, maxSpeed: 2000, airOutput: 4, overscan: 10, cutPowerCorrection: 15, engravePowerCorrection: 20 },
  ruida: { magic: 0x88, origin: 'tr' },
  sim: { speedup: 20 }
};

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
  const ctrl = (overrides && overrides.controller) || saved.controller;
  let cfg = merge(defaults(ctrl), saved);
  if (overrides) cfg = merge(cfg, overrides);
  return cfg;
}

function save(dir, cfg) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
}

// What Pathline sees in GET /machine
function machineView(cfg) {
  return {
    bed: cfg.bed, speed: cfg.speed, acc: cfg.acc, origin: cfg.origin, units: cfg.units, home: cfg.home, prefix: cfg.prefix,
    source: cfg.source, power: cfg.power, lens: cfg.lens, minPower: cfg.minPower,
    f: { camera: false, autofocus: false, rotary: false, air: !!cfg.f.air, pointer: !!cfg.f.pointer, pass: false, interlock: !!cfg.f.interlock, conveyor: false, vacuum: false }
  };
}

module.exports = { dataDir, defaults, load, save, merge, machineView, PRESETS };

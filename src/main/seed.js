// First-run data. The app ships with no machines or materials: the operator
// adds their own under Setup. The templates below are only the starting values
// for "Add machine"; they are never added to the library by themselves.
'use strict';

const machines = () => [];
const materials = () => [];

const templates = {
  laser: {
    type: 'laser', kind: 'Laser · CO2', ctrl: '',
    conn: 'Ethernet', ip: '', port: 8470, usbDrive: '', folder: '', timeout: 3000,
    info: {
      bed: [800, 500], speed: 1000, acc: 10000, origin: 'tl', units: 'mm', home: true, prefix: '',
      source: 'CO2', power: 80, lens: '2.0"', pwm: 5000, minPower: 8, focus: '0.0', airDefault: 'High',
      lid: true, exhaust: '10',
      f: { camera: false, autofocus: false, rotary: false, air: true, pass: false, interlock: true }
    },
    syncedAt: null
  },
  plotter: {
    type: 'plotter', kind: 'Plotter', ctrl: '',
    conn: 'Ethernet', ip: '', port: 8470, usbDrive: '', folder: '', timeout: 3000,
    info: {
      bed: [1600, 1000], speed: 1000, acc: 8000, origin: 'tl', units: 'mm', home: true, prefix: '',
      heads: [{ slot: 'T1', tool: 'Knife', x: '0.00', y: '0.00', loaded: true }],
      feedLen: 1000, timing: { toolDown: 0.15, toolUp: 0.12, toolChange: 8, feedSpeed: 200, feedSettle: 3 },
      f: { conveyor: false, vacuum: false, pointer: false, camera: false, detect: false }
    },
    syncedAt: null
  }
};
const machineTemplate = (type) => JSON.parse(JSON.stringify(templates[type === 'plotter' ? 'plotter' : 'laser']));

// Starting processes for a new material, scaled with thickness.
const { defaultPresets } = require('../shared/core');
const laserPresets = (t) => defaultPresets('laser', t);
const plotterPresets = (t) => defaultPresets('plotter', t);

const settings = () => ({
  currentMachine: null,
  currentMaterial: {},
  recent: [],
  autosave: true,
  accent: '#2457D6'
});

module.exports = { machines, materials, machineTemplate, settings, laserPresets, plotterPresets };

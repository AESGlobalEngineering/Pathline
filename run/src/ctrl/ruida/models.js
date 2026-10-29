// Ruida controller models, for Setup → Controller model.
// What differs per model for Pathline Run: the swizzle magic (how the data is scrambled),
// laser or plotter use, and how many outputs (laser tubes, or plotter tools) it drives.
// Sources: EduTech wiki "Ruida" (magic per model and per card ID), LightBurn forum (models).
// The magic is also detected from the controller's first reply (link.js), so a wrong
// choice here doesn't stop it connecting.
'use strict';

const MODELS = [
  // ---- laser controllers
  { id: 'RDC6442G', kind: 'laser', label: 'RDC6442G', magic: 0x88, outputs: 2, note: 'Most common Ruida laser controller.' },
  { id: 'RDC6442S', kind: 'laser', label: 'RDC6442S', magic: 0x88, outputs: 2, note: 'As the 6442G, with RF tube support.' },
  { id: 'RDC6445G', kind: 'laser', label: 'RDC6445G / 6445S', magic: 0x88, outputs: 2, note: 'Same controller as the 6442, newer panel; double-head linkage.' },
  { id: 'RDC6332G', kind: 'laser', label: 'RDC6332G', magic: 0x88, outputs: 2, note: '633x family.' },
  { id: 'RDC6332M', kind: 'laser', label: 'RDC6332M', magic: 0x88, outputs: 2, note: '633x family (marking).' },
  { id: 'RDC6334G', kind: 'laser', label: 'RDC6334G / 6344G (634x)', magic: 0x11, outputs: 2, note: '634x family: uses swizzle magic 0x11.' },
  { id: 'RDC6344S', kind: 'laser', label: 'RDC6344S', magic: 0x11, outputs: 2, note: '634x family: uses swizzle magic 0x11.' },
  { id: 'RDC6542G', kind: 'laser', label: 'RDC654xG', magic: 0x88, outputs: 4, note: '654x family.' },
  { id: 'RDLC320', kind: 'laser', label: 'RDLC320-A', magic: 0x88, outputs: 1, note: 'Older, small display.' },
  { id: 'RDLC220', kind: 'laser', label: 'RDLC220', magic: 0x88, outputs: 1, note: 'Older, small display.' },
  { id: 'RDL9635', kind: 'laser', label: 'RDL9635', magic: 0x38, outputs: 1, note: 'Uses swizzle magic 0x38.' },
  // ---- plotters and cutters
  { id: 'RD-PLOTTER', kind: 'plotter', label: 'Ruida laser-family controller driving tools', magic: 0x88, outputs: 4, note: 'Tools on outputs 1–4 (knife, V-cut, crease, pen…), conveyor on the U axis. Built from the laser command set: check on the machine before production.' },
  { id: 'RDD6584G', kind: 'plotter', label: 'RDD6584G (oscillating knife)', magic: 0x88, outputs: 4, note: 'Ruida knife-cutting controller. Its protocol isn\'t documented publicly: Pathline Run sends the laser-family commands. Needs a capture to confirm.' },
  { id: 'RDD6584V', kind: 'plotter', label: 'RDD6584V-NET (knife, camera marks)', magic: 0x88, outputs: 4, note: 'Ruida knife-cutting controller. Its protocol isn\'t documented publicly: Pathline Run sends the laser-family commands. Needs a capture to confirm.' },
  { id: 'RDD6584U', kind: 'plotter', label: 'RDD6584U-DFM (dual head)', magic: 0x88, outputs: 4, note: 'Ruida knife-cutting controller. Its protocol isn\'t documented publicly: Pathline Run sends the laser-family commands. Needs a capture to confirm.' },
  { id: 'OTHER', kind: 'laser', label: 'Other / not sure', magic: 0x88, outputs: 2, note: 'Pathline Run works out the swizzle magic from the controller\'s first reply.' }
];

// card ID (DA 00 05 7E) → swizzle magic, from the EduTech wiki; others use 0x88
const CARD_MAGIC = {
  0x6320: 0x11, 0x6302: 0x83, 0x6301: 0x88, 0x6300: 0x33, 0x2210: 0x16, 0x630b: 0x33, 0x6425: 0x88, 0x6501: 0x34,
  0x6511: 0x77, 0x6531: 0x77, 0x6512: 0x75, 0x6513: 0x99, 0x6514: 0x13, 0x651e: 0x60, 0x6533: 0x60, 0x651f: 0x76,
  0x6530: 0x10, 0x6532: 0x10, 0x6920: 0xa1, 0x6811: 0x77, 0x690f: 0xa1, 0x6910: 0xa1, 0x6911: 0xa1, 0x6912: 0x88,
  0x6930: 0x1a, 0x693f: 0x1a, 0x7230: 0x10, 0x7235: 0x10, 0x7236: 0x10, 0x7430: 0x10, 0x7930: 0x10
};

const byId = (id) => MODELS.find((m) => m.id === id) || MODELS.find((m) => m.id === 'OTHER');

module.exports = { MODELS, CARD_MAGIC, byId };

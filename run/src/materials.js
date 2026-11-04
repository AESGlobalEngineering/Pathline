// Material settings kept on the machine for Pathline Prepare (HMI-BRIEF §5.3): Prepare replaces the
// whole list with PUT /materials and reads it back with GET /materials, so every computer running
// Prepare that connects gets the settings made for this machine. Pathline Run only keeps the list:
// byte for byte as received (every field, in its order; Prepare decides which copy is newer, by each
// material's updatedAt), in <data>/materials.json next to the config, so restarts and updates keep
// it. Jobs never use it: every job package carries its own process settings.
'use strict';

const fs = require('fs');
const path = require('path');

const EMPTY = '{"format":"pathline-materials","version":1,"materials":[]}';
const file = (dir) => path.join(dir, 'materials.json');

// the stored list as text; the empty list when nothing has been stored yet
function read(dir) {
  try { return fs.readFileSync(file(dir), 'utf8'); } catch (e) { return EMPTY; }
}

// the stored list, parsed (the screen's read-only Materials tab)
function parse(dir) {
  try { return JSON.parse(read(dir).replace(/^﻿/, '')); } catch (e) { return JSON.parse(EMPTY); }
}

// A whole list, as the text received: checked, then written to a temporary file, flushed to the
// disk and renamed over the old one, so a power cut leaves the old list or the new one, never half
// of one. Returns how many materials it holds.
function write(dir, text) {
  let doc = null;
  try { doc = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { /* not JSON */ }
  if (!doc || doc.format !== 'pathline-materials' || !Array.isArray(doc.materials)) throw Object.assign(new Error('Not a materials list'), { code: 400 });
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file(dir) + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file(dir));
  return doc.materials.length;
}

module.exports = { read, parse, write, EMPTY };

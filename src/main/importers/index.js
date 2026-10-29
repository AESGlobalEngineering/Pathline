// Picks an importer by file extension and returns job entities in mm.
'use strict';

const fs = require('fs');
const path = require('path');
const { joinPaths, toEntities } = require('./common');
const { importDxf } = require('./dxf');
const { importSvg } = require('./svg');
const { importPdf } = require('./pdf');
const { importHpgl } = require('./hpgl');

const EXTENSIONS = ['dxf', 'svg', 'pdf', 'plt', 'hpgl', 'hpg'];

async function importFile(file, opts) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const baseName = path.basename(file);
  const text = () => fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  let res;
  if (ext === 'dxf') res = importDxf(text(), opts);
  else if (ext === 'svg') res = importSvg(text(), opts);
  else if (ext === 'pdf') res = await importPdf(fs.readFileSync(file), opts);
  else if (['plt', 'hpgl', 'hpg'].includes(ext)) res = importHpgl(fs.readFileSync(file, 'latin1'), opts);
  else throw new Error('Unsupported file type .' + ext + ' — use ' + EXTENSIONS.map((e) => '.' + e).join(', '));

  const joined = joinPaths(res.raw);
  const { entities, width, height } = toEntities(joined, { yUp: res.yUp, baseName });
  return {
    file, name: baseName, ext,
    entities, width, height,
    pieces: res.raw.length,
    skipped: res.skipped || {},
    units: res.units || 'mm',
    pages: res.pages, page: res.page
  };
}

module.exports = { importFile, EXTENSIONS };

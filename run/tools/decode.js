#!/usr/bin/env node
// Print a readable listing of a controller file.
//
//   node tools/decode.js <file.rd> [--magic 0x88]     Ruida (swizzled .rd)
//   node tools/decode.js <file.sf>                    Trotec data-lane stream
'use strict';

const fs = require('fs');
const rd = require('../src/ctrl/ruida/rd');
const sf = require('../src/ctrl/trotec/sf');

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--magic');
if (!file) { console.log('Usage: node tools/decode.js <file.rd|file.sf> [--magic 0x88]'); process.exit(2); }
const buf = fs.readFileSync(file);
if (/\.sf$/i.test(file)) console.log(sf.listing(buf));
else {
  const i = argv.indexOf('--magic');
  const magic = i >= 0 ? Number(argv[i + 1]) : 0x88;
  console.log(rd.listing(rd.unswizzle(buf, magic)));
}

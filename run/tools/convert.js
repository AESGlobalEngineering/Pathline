#!/usr/bin/env node
// Convert a Pathline job (package JSON or .cjob) into controller code.
//
//   node tools/convert.js <job.json|job.cjob> --ctrl ruida|trotec [-o out] [--txt] [--origin tr] [--bed 900x600]
//
// Ruida: writes a .rd file (swizzled, magic 0x88 unless --magic). Trotec: writes
// the SF data-lane stream (.sf). --txt also writes a readable listing next to it.
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const validate = require('../src/job/validate');
const plan = require('../src/job/plan');
const { controller } = require('../src/ctrl');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.findIndex((a) => a === '--' + k || (k === 'o' && a === '-o')); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const input = argv.find((a, i) => !a.startsWith('-') && !(i > 0 && argv[i - 1].startsWith('-') && argv[i - 1] !== '--txt'));
if (!input) {
  console.log('Usage: node tools/convert.js <job.json|job.cjob> --ctrl ruida|trotec [-o out] [--txt] [--origin tr] [--bed 900x600] [--magic 0x88]');
  process.exit(2);
}
const ctrl = opt('ctrl', 'ruida');
const cfg = config.load(config.dataDir(opt('data')), { controller: ctrl });
cfg.controller = ctrl;
if (opt('bed')) cfg.bed = opt('bed').split(/[x×,]/).map(Number);
if (opt('origin')) cfg.ruida.origin = opt('origin');
if (opt('magic')) cfg.ruida.magic = Number(opt('magic'));
cfg.regMarks = 'ignore';

const pkg = validate.fromCjob(JSON.parse(fs.readFileSync(input, 'utf8')));
const warnings = validate.check(pkg, cfg);
const out = controller(ctrl).exportFiles(plan.build(pkg), cfg);
const dest = opt('o', input.replace(/\.(json|cjob)$/i, '') + out.ext);
fs.writeFileSync(dest, out.bin);
console.log('Wrote ' + dest + ' (' + out.bin.length + ' bytes, ' + ctrl + ')');
if (argv.includes('--txt')) { fs.writeFileSync(dest + '.txt', out.txt); console.log('Wrote ' + dest + '.txt'); }
for (const w of warnings.concat(out.notes || [])) console.log('  note: ' + w);
if (path.extname(dest).toLowerCase() !== out.ext) console.log('  (usual extension for ' + ctrl + ' is ' + out.ext + ')');

#!/usr/bin/env node
// Lays out the Pathline Monitor download in monitor/dist/Pathline-Monitor/:
//   Start Pathline Monitor.cmd   (Windows: double-click)      start.sh   (Pi / Linux / Mac)
//   monitor/                     the service and the phone app, with its node_modules
//   src/main/discover.js         Pathline Prepare's machine finder, which Monitor uses
//   node/node.exe                with --node <path>: Node.js itself, so Windows needs nothing installed
//
//   node tools/package.js [--node <path to node.exe>]
// Run `npm ci --omit=dev` in monitor/ first. Unzipping a newer download over an older one keeps
// config.json and data/ (they aren't in it).
'use strict';
const fs = require('fs');
const path = require('path');

const MON = path.join(__dirname, '..');
const ROOT = path.join(MON, '..');
const OUT = path.join(MON, 'dist', 'Pathline-Monitor');
const argv = process.argv.slice(2);
const nodeExe = argv.includes('--node') ? argv[argv.indexOf('--node') + 1] : null;

fs.rmSync(OUT, { recursive: true, force: true });
const copy = (from, to) => fs.cpSync(from, to, { recursive: true });
for (const f of ['server.js', 'package.json', 'package-lock.json', 'README.md', 'config.example.json', 'lib', 'app', 'node_modules']) {
  if (!fs.existsSync(path.join(MON, f))) throw new Error('monitor/' + f + ' is missing (npm ci first?)');
  copy(path.join(MON, f), path.join(OUT, 'monitor', f));
}
copy(path.join(ROOT, 'src', 'main', 'discover.js'), path.join(OUT, 'src', 'main', 'discover.js'));

if (nodeExe) {
  copy(nodeExe, path.join(OUT, 'node', 'node.exe'));
  const lic = path.join(path.dirname(nodeExe), 'LICENSE');
  if (fs.existsSync(lic)) copy(lic, path.join(OUT, 'node', 'LICENSE'));
}

const version = require(path.join(MON, 'package.json')).version;
fs.writeFileSync(path.join(OUT, 'Start Pathline Monitor.cmd'), [
  '@echo off',
  'chcp 65001 >nul',
  'title Pathline Monitor',
  'cd /d "%~dp0monitor"',
  'set NODE=node',
  'if exist "%~dp0node\\node.exe" set NODE="%~dp0node\\node.exe"',
  'where %NODE% >nul 2>nul || if not exist "%~dp0node\\node.exe" (echo Pathline Monitor needs Node.js 18 or newer: https://nodejs.org & pause & exit /b 1)',
  'echo Pathline Monitor ' + version + '. Leave this window open: closing it stops Pathline Monitor.',
  '%NODE% server.js',
  'pause',
  '',
].join('\r\n'));
fs.writeFileSync(path.join(OUT, 'start.sh'), [
  '#!/bin/sh',
  '# Pathline Monitor ' + version + ' (needs Node.js 18 or newer: sudo apt install nodejs)',
  'cd "$(dirname "$0")/monitor" && exec node server.js "$@"',
  '',
].join('\n'), { mode: 0o755 });
fs.writeFileSync(path.join(OUT, 'READ ME.txt'), [
  'Pathline Monitor ' + version,
  '',
  'Windows: double-click "Start Pathline Monitor.cmd" and leave its window open.',
  'Raspberry Pi / Linux: ./start.sh (needs Node.js 18 or newer).',
  '',
  'It finds the Pathline Run machines on this network and prints the address phones open,',
  'for example http://192.168.1.20:8480. More in monitor/README.md.',
  '',
  'To update: unzip the newer download over this folder. Your machines and alerts',
  '(monitor/data, monitor/config.json) are kept.',
  '',
].join('\r\n'));
console.log('Pathline Monitor ' + version + ' laid out in ' + OUT + (nodeExe ? ' (with Node.js)' : ''));

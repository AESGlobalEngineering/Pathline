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
// Everything is found from where this file is (%~dp0), never from the folder it was started in:
// Task Scheduler and "Run as administrator" start in C:\Windows\System32.
fs.writeFileSync(path.join(OUT, 'Start Pathline Monitor.cmd'), [
  '@echo off',
  'chcp 65001 >nul',
  'title Pathline Monitor',
  'setlocal',
  'set "HERE=%~dp0"',
  // opened from inside the zip, or copied out on its own: the rest of the files aren't beside it
  'if not exist "%HERE%monitor\\server.js" (',
  '  echo Pathline Monitor\'s files aren\'t next to this file.',
  '  echo.',
  '  echo Unzip the whole download first: right-click Pathline-Monitor-Windows.zip, choose',
  '  echo Extract All, then double-click Start Pathline Monitor.cmd in the folder it makes.',
  '  echo.',
  '  pause',
  '  exit /b 1',
  ')',
  'set "NODE=%HERE%node\\node.exe"',
  'if not exist "%NODE%" (',
  '  set "NODE=node"',
  '  where node >nul 2>nul || (echo Pathline Monitor needs Node.js 18 or newer: https://nodejs.org & pause & exit /b 1)',
  ')',
  'cd /d "%HERE%monitor"',
  'echo Pathline Monitor ' + version + '. Leave this window open: closing it stops Pathline Monitor.',
  'echo.',
  '"%NODE%" "%HERE%monitor\\server.js"',
  'pause',
  '',
].join('\r\n'));
fs.writeFileSync(path.join(OUT, 'start.sh'), [
  '#!/bin/sh',
  '# Pathline Monitor ' + version + ' (needs Node.js 18 or newer: sudo apt install nodejs)',
  'HERE="$(cd "$(dirname "$0")" && pwd)"',
  '[ -f "$HERE/monitor/server.js" ] || { echo "Pathline Monitor\'s files aren\'t next to start.sh: unzip the whole download first."; exit 1; }',
  'cd "$HERE/monitor" && exec node "$HERE/monitor/server.js" "$@"',
  '',
].join('\n'), { mode: 0o755 });
fs.writeFileSync(path.join(OUT, 'READ ME.txt'), [
  'Pathline Monitor ' + version,
  '',
  'Windows: double-click "Start Pathline Monitor.cmd" and leave its window open. (Unzip the',
  'whole download first: opened from inside the zip, it cannot find the rest of its files.)',
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

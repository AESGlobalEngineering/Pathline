#!/usr/bin/env node
// Take pictures in a row with the real head camera, the way Pathline Run does (the camera's own
// process, one USB transport), and count how many come back. For choosing the default transport.
//
//   node tools/camera-burst.js --transport ruby|vimbax|auto|<file.cti> [--count 20] [--exposure µs|auto]
//
// ruby: Ruby's VimbaUSBTL 1.4. vimbax: Vimba X's own VimbaUSBTL. Only one program can hold the
// camera, so it won't start while Ruby, JobDispatcher or Pathline Run is running.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { ProcessCamera } = require('../src/vision/camera');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

function transportFile(name) {
  if (name === 'vimbax') return path.join(process.env.VIMBA_X_HOME || 'C:\\Program Files\\Allied Vision\\Vimba X', 'cti', 'VimbaUSBTL.cti');
  if (name === 'ruby') {
    for (const dir of String(process.env.GENICAM_GENTL64_PATH || '').split(path.delimiter).filter(Boolean)) {
      const f = path.join(dir, 'VimbaUSBTL.cti');
      if (/VimbaUSBTL_1\.4/i.test(dir) && fs.existsSync(f)) return f;
    }
    throw new Error('Ruby\'s VimbaUSBTL 1.4 isn\'t on GENICAM_GENTL64_PATH');
  }
  return name;
}

// programs that hold the camera (or the laser): never take it from them
function busy() {
  if (process.platform !== 'win32') return [];
  const list = execFileSync('tasklist', ['/fo', 'csv', '/nh'], { encoding: 'utf8' });
  return [...new Set([...list.matchAll(/^"([^"]+)"/gm)].map((m) => m[1]).filter((n) => /^(Ruby\.|JobDispatcher|Pathline Run)/i.test(n)))];
}

async function main() {
  const name = opt('transport');
  if (!name) { console.log('Usage: node tools/camera-burst.js --transport ruby|vimbax|auto|<file.cti> [--count 20] [--exposure µs|auto]'); process.exit(2); }
  const running = busy();
  if (running.length) throw new Error('Close these first, they may be using the camera or the laser: ' + running.join(', '));
  const transport = transportFile(name);
  // a missing file would fall back to Vimba X loading every transport it knows: the lock-up
  if (transport !== 'auto' && !fs.existsSync(transport)) throw new Error('No transport at ' + transport);
  const count = Number(opt('count', 20));
  const e = opt('exposure');
  const cam = new ProcessCamera({ transport, exposure: e === 'auto' ? 'auto' : Number(e) || null }, (m) => console.log('  ' + m));

  console.log('Transport: ' + transport);
  let t = Date.now();
  const info = await cam.open();
  console.log('Opened ' + info.model + ' (' + info.serial + ') in ' + (Date.now() - t) + ' ms');
  const shots = [];
  for (let i = 1; i <= count; i++) {
    t = Date.now();
    try {
      const img = await cam.grab();
      shots.push({ ok: true, ms: Date.now() - t });
      console.log(String(i).padStart(3) + '  ok    ' + img.w + ' × ' + img.h + '  ' + (Date.now() - t) + ' ms');
    } catch (err) {
      shots.push({ ok: false, ms: Date.now() - t });
      console.log(String(i).padStart(3) + '  FAIL  ' + err.message + '  ' + (Date.now() - t) + ' ms');
    }
  }
  await cam.close();
  const good = shots.filter((s) => s.ok);
  const ms = good.map((s) => s.ms).sort((a, b) => a - b);
  console.log('\n' + name + ': ' + good.length + ' / ' + count + ' pictures' + (ms.length ? ', median ' + ms[ms.length >> 1] + ' ms, slowest ' + ms[ms.length - 1] + ' ms' : ''));
  process.exit(good.length === count ? 0 : 1);
}

main().catch((err) => { console.error(err.message); process.exit(1); });

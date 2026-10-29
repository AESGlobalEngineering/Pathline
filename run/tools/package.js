#!/usr/bin/env node
// Builds the Pathline Run downloads into run/out/:
//
//   Pathline-Run-<v>-windows.zip   unzip anywhere, double-click "Pathline Run.cmd" (Node.js included)
//   Pathline-Run-<v>-pi.tar.gz     Raspberry Pi: extract, run install.sh (or use install-pi.sh)
//   pathline-run-<v>.tar.gz        the app alone: what installed copies download to update
//   install-pi.sh                  one-line Pi installer (downloads the latest Pi package)
//   pathline-run-latest.json       update manifest: version, app package URL and SHA-256
//
//   node tools/package.js [--node 22.11.0] [--base-url <releases download URL>]
// Needs: npm, tar; on Linux also zip and unzip (both on GitHub's ubuntu runners).
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const RUN = path.join(__dirname, '..');
const pkg = require(path.join(RUN, 'package.json'));
const V = pkg.version;
const NODE = opt('node', '22.11.0');
const REPO = 'AESGlobalEngineering/Pathline';
const BASE = opt('base-url', 'https://github.com/' + REPO + '/releases/download');
const OUT = path.join(RUN, 'out');
const WORK = path.join(OUT, 'work');
const win = process.platform === 'win32';
const TAR = win ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: win && cmd === 'npm' });

fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
fs.mkdirSync(WORK, { recursive: true });

// ---------------------------------------------------------------- the app
const app = path.join(WORK, 'app');
for (const f of ['src', 'ui', 'package.json', 'package-lock.json', 'README.md', 'launcher.js']) fs.cpSync(path.join(RUN, f), path.join(app, f), { recursive: true });
fs.mkdirSync(path.join(app, 'tools'));
for (const f of ['convert.js', 'decode.js']) fs.copyFileSync(path.join(RUN, 'tools', f), path.join(app, 'tools', f));
fs.cpSync(path.join(RUN, 'deploy'), path.join(app, 'deploy'), { recursive: true });
// serialport ships prebuilt binaries for Windows, Linux x64/arm/arm64 and macOS, so one app folder runs everywhere
sh('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], app);
const appTgz = path.join(OUT, 'pathline-run-' + V + '.tar.gz');
sh(TAR, ['-czf', appTgz, '-C', app, '.']);

// an installed layout around a copy of the app
function layout(dir) {
  fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
  fs.cpSync(app, path.join(dir, 'app', V), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app', 'current'), V);
  fs.copyFileSync(path.join(RUN, 'launcher.js'), path.join(dir, 'launcher.js'));
}

// ---------------------------------------------------------------- Windows
const wroot = path.join(WORK, 'windows', 'Pathline Run');
layout(wroot);
fs.mkdirSync(path.join(wroot, 'runtime'));
const nodeZip = path.join(WORK, 'node-win.zip');
const nodeUrl = 'https://nodejs.org/dist/v' + NODE + '/node-v' + NODE + '-win-x64.zip';
console.log('Downloading ' + nodeUrl);
sh('curl', ['-fsSL', '-o', nodeZip, nodeUrl]);
if (win) {
  sh(TAR, ['-xf', nodeZip, '-C', WORK, 'node-v' + NODE + '-win-x64/node.exe']);
  fs.renameSync(path.join(WORK, 'node-v' + NODE + '-win-x64', 'node.exe'), path.join(wroot, 'runtime', 'node.exe'));
} else {
  sh('unzip', ['-q', '-j', nodeZip, 'node-v' + NODE + '-win-x64/node.exe', '-d', path.join(wroot, 'runtime')]);
}
fs.writeFileSync(path.join(wroot, 'Pathline Run.cmd'), [
  '@echo off',
  'title Pathline Run',
  'rem Starts Pathline Run and opens its screen. Close this window to stop it.',
  'cd /d "%~dp0"',
  '"%~dp0runtime\\node.exe" "%~dp0launcher.js" --open %*',
  ''
].join('\r\n'));
fs.writeFileSync(path.join(wroot, 'READ ME.txt'), [
  'Pathline Run ' + V,
  '',
  'Start: double-click "Pathline Run.cmd". Its screen opens in your browser at http://localhost:8470/',
  'Stop: close the black Pathline Run window.',
  '',
  'In Pathline: Setup > Machines > Add machine > Ethernet, this PC\'s IP address, port 8470.',
  'First time: Setup (in Pathline Run) > Machine > choose Trotec or Ruida and the connection.',
  'Windows Firewall may ask to allow Node.js on private networks: allow it, so Pathline can connect.',
  '',
  'Updates: Pathline Run checks for a new version when it starts and every 6 hours, downloads it',
  'in the background, and installs it when you click Restart now (or the next time it starts).',
  '',
  'Settings and received jobs are kept in %APPDATA%\\Pathline Run, not in this folder.',
  ''
].join('\r\n'));
const winZip = path.join(OUT, 'Pathline-Run-' + V + '-windows.zip');
if (win) sh(TAR, ['-a', '-cf', winZip, '-C', path.dirname(wroot), 'Pathline Run']);
else sh('zip', ['-qr', winZip, 'Pathline Run'], path.dirname(wroot));

// ---------------------------------------------------------------- Raspberry Pi
const proot = path.join(WORK, 'pi', 'pathline-run');
layout(proot);
for (const f of ['install.sh', 'kiosk.sh', 'pathline-run.service']) fs.copyFileSync(path.join(RUN, 'deploy', 'pi', f), path.join(proot, f));
const piTgz = path.join(OUT, 'Pathline-Run-' + V + '-pi.tar.gz');
sh(TAR, ['-czf', piTgz, '-C', path.dirname(proot), 'pathline-run']);
fs.copyFileSync(path.join(RUN, 'deploy', 'pi', 'install-pi.sh'), path.join(OUT, 'install-pi.sh'));

// ---------------------------------------------------------------- update manifest
const sha = crypto.createHash('sha256').update(fs.readFileSync(appTgz)).digest('hex');
const manifest = {
  name: 'Pathline Run', version: V, tag: 'run-v' + V, releasedAt: new Date().toISOString(),
  app: { url: BASE + '/run-v' + V + '/' + path.basename(appTgz), sha256: sha, size: fs.statSync(appTgz).size },
  downloads: {
    windows: BASE + '/run-v' + V + '/' + path.basename(winZip),
    pi: BASE + '/run-v' + V + '/' + path.basename(piTgz)
  }
};
fs.writeFileSync(path.join(OUT, 'pathline-run-latest.json'), JSON.stringify(manifest, null, 2));

fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
for (const f of fs.readdirSync(OUT)) console.log('  ' + f + '  ' + (fs.statSync(path.join(OUT, f)).size / 1048576).toFixed(1) + ' MB');

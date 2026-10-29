// Updates from GitHub releases, the way Pathline does it: check when the app
// starts and every 6 hours, download in the background, install on restart.
// Only for an installed copy (started by launcher.js, which sets
// PATHLINE_RUN_ROOT); running from the source folder never updates.
//
// The manifest (pathline-run-latest.json on the run-latest release) names the
// newest version and its app package with a SHA-256. The package is unpacked
// next to the running version as app/<version>, then app/current is switched,
// so the running files are never touched. A failed check (the machine PC is
// often offline) is only logged.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const MANIFEST = process.env.PATHLINE_RUN_UPDATE_URL ||
  'https://github.com/AESGlobalEngineering/Pathline/releases/download/run-latest/pathline-run-latest.json';
const EVERY_MS = 6 * 3600 * 1000;
const FIRST_MS = 20000;
const CURRENT = require('../package.json').version;
const ROOT = process.env.PATHLINE_RUN_ROOT || '';
const APP = ROOT ? path.join(ROOT, 'app') : '';

// 1.10.0 > 1.9.2
function newer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

class Updates {
  constructor(opts) {
    this.log = opts.log;
    this.auto = opts.auto; // () => download automatically?
    // off | idle | checking | current | available | downloading | ready | error
    this.now = { state: ROOT ? 'idle' : 'off', current: CURRENT };
    this.manifest = null;
  }

  status() { return { ...this.now, current: CURRENT }; }
  set(s) { this.now = { ...s, current: CURRENT, checkedAt: this.now.checkedAt }; return this.status(); }

  start() {
    if (!ROOT) return;
    // a version that was installed but didn't start is skipped (launcher.js writes app/skip)
    this.skip = (() => { try { return fs.readFileSync(path.join(APP, 'skip'), 'utf8').trim(); } catch (e) { return ''; } })();
    const tick = () => this.check(true).catch(() => {});
    setTimeout(tick, FIRST_MS);
    setInterval(tick, EVERY_MS).unref();
  }

  async check(background) {
    if (!ROOT) return this.status();
    if (['checking', 'downloading', 'ready'].includes(this.now.state)) return this.status();
    this.set({ state: 'checking' });
    try {
      const res = await fetch(MANIFEST, { signal: AbortSignal.timeout(15000), headers: { 'cache-control': 'no-cache' } });
      if (res.status === 404) { this.now.checkedAt = new Date().toISOString(); return this.set({ state: 'current', message: 'No release published yet' }); }
      if (!res.ok) throw new Error('GitHub answered ' + res.status);
      const m = await res.json();
      this.manifest = m;
      this.now.checkedAt = new Date().toISOString();
      if (!newer(m.version, CURRENT) || m.version === this.skip) return this.set({ state: 'current', latest: m.version });
      this.log('update: Pathline Run ' + m.version + ' is available');
      this.set({ state: 'available', version: m.version });
      if (this.auto()) this.download();
      return this.status();
    } catch (e) {
      this.now.checkedAt = new Date().toISOString();
      const msg = e.name === 'TimeoutError' ? 'No answer from GitHub (offline?)' : e.cause && e.cause.code ? 'Can\'t reach GitHub (' + e.cause.code + ')' : e.message;
      if (!background) this.log('update check failed: ' + msg);
      return this.set({ state: 'error', message: msg });
    }
  }

  download() {
    if (!ROOT || !this.manifest || !['available', 'error'].includes(this.now.state)) return this.status();
    const m = this.manifest;
    if (!newer(m.version, CURRENT)) return this.status();
    this.set({ state: 'downloading', version: m.version, percent: 0 });
    this.fetchAndUnpack(m).then(() => {
      this.log('update: Pathline Run ' + m.version + ' is ready, installs on restart');
      this.set({ state: 'ready', version: m.version });
    }, (e) => {
      this.log('update download failed: ' + e.message);
      this.set({ state: 'error', version: m.version, message: e.message });
    });
    return this.status();
  }

  async fetchAndUnpack(m) {
    const tmp = path.join(APP, '.download');
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    fs.mkdirSync(tmp, { recursive: true });
    const file = path.join(tmp, 'app.tar.gz');
    const res = await fetch(m.app.url, { signal: AbortSignal.timeout(10 * 60000) });
    if (!res.ok) throw new Error('Download failed (' + res.status + ')');
    const total = Number(res.headers.get('content-length')) || m.app.size || 0;
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(file);
    let got = 0;
    for await (const chunk of res.body) {
      hash.update(chunk);
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      if (total) this.now.percent = Math.round((got / total) * 100);
    }
    await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
    if (hash.digest('hex') !== m.app.sha256) throw new Error('The download is damaged (checksum mismatch)');
    const dest = path.join(tmp, 'app');
    fs.mkdirSync(dest);
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    await new Promise((r, j) => execFile(tar, ['-xzf', file, '-C', dest], (e) => (e ? j(new Error('Couldn\'t unpack the update: ' + e.message)) : r())));
    if (!fs.existsSync(path.join(dest, 'src', 'server.js'))) throw new Error('The update package is incomplete');
    const final = path.join(APP, m.version);
    fs.rmSync(final, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    fs.renameSync(dest, final);
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    // switch versions; the launcher starts the new one on the next restart
    const running = fs.readFileSync(path.join(APP, 'current'), 'utf8').trim();
    fs.writeFileSync(path.join(APP, 'previous'), running);
    fs.writeFileSync(path.join(APP, 'current'), m.version);
    fs.writeFileSync(path.join(APP, 'updated'), new Date().toISOString());
    this.prune([m.version, running]);
  }

  // keep only the new and the running version
  prune(keep) {
    for (const d of fs.readdirSync(APP)) {
      if (/^\d+\.\d+\.\d+/.test(d) && !keep.includes(d)) fs.rmSync(path.join(APP, d), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    }
  }
}

module.exports = { Updates, newer, CURRENT, installed: !!ROOT };

// Bug and crash reports. Each report is a folder in <user data>\reports, next
// to the data folder (the program folder is replaced on every update, so
// reports are not kept there). Nothing is sent anywhere: the operator attaches
// the folder to an issue or e-mail if they want help.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);

class Reports {
  // info(): { version, ... } added to every report
  constructor(dir, info) {
    this.dir = dir;
    this.info = info;
    this.lines = [];
    fs.mkdirSync(dir, { recursive: true });
  }

  // recent errors and events, kept in memory and in errors.log
  log(kind, text) {
    const line = new Date().toISOString() + ' [' + kind + '] ' + String(text).replace(/\s+$/, '');
    this.lines.push(line);
    if (this.lines.length > 300) this.lines.shift();
    try { fs.appendFileSync(path.join(this.dir, 'errors.log'), line + os.EOL); } catch (e) { /* disk full or read-only: keep going */ }
  }

  system() {
    return {
      ...this.info(), os: os.type() + ' ' + os.release() + ' (' + os.arch() + ')', electron: process.versions.electron,
      memoryMb: Math.round(os.totalmem() / 1048576), createdAt: new Date().toISOString()
    };
  }

  // A folder with report.json, log.txt and any extra files ({ name: Buffer|string }).
  write(prefix, report, files) {
    const folder = path.join(this.dir, prefix + '-' + stamp());
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'report.json'), JSON.stringify({ ...report, system: this.system() }, null, 2));
    fs.writeFileSync(path.join(folder, 'log.txt'), this.lines.join(os.EOL) + os.EOL);
    for (const [name, data] of Object.entries(files || {})) if (data) fs.writeFileSync(path.join(folder, name), data);
    return folder;
  }

  // what: 'main-error' | 'page-crash' | 'process-crash' | 'unexpected-exit'
  crash(what, detail) {
    const err = detail instanceof Error ? { message: detail.message, stack: detail.stack } : detail;
    this.log('crash', what + ' ' + JSON.stringify(err));
    try {
      const folder = this.write('crash', { type: 'crash', what, detail: err });
      fs.writeFileSync(path.join(this.dir, 'pending-crash.txt'), folder);
      return folder;
    } catch (e) { return null; }
  }

  bug(fields, files) {
    return this.write('bug', { type: 'bug', ...fields }, files);
  }

  // the crash report not yet shown to the operator (then forgotten)
  takePending() {
    const f = path.join(this.dir, 'pending-crash.txt');
    try {
      const folder = fs.readFileSync(f, 'utf8').trim();
      fs.unlinkSync(f);
      return fs.existsSync(folder) ? folder : null;
    } catch (e) { return null; }
  }

  // running.lock exists while the app runs; if it is still there at start, the
  // last session ended without closing normally (power cut, killed, hard crash)
  startSession() {
    const lock = path.join(this.dir, 'running.lock');
    if (fs.existsSync(lock)) {
      let was = {};
      try { was = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch (e) { /* unreadable lock */ }
      this.crash('unexpected-exit', { message: 'The last session did not close normally', startedAt: was.startedAt, version: was.version });
    }
    try { fs.writeFileSync(lock, JSON.stringify({ startedAt: new Date().toISOString(), pid: process.pid, version: this.info().version })); } catch (e) { /* read-only */ }
  }
  endSession() {
    try { fs.unlinkSync(path.join(this.dir, 'running.lock')); } catch (e) { /* already gone */ }
  }
}

module.exports = { Reports };

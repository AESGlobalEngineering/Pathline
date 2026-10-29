// Bug and crash reports. Each report is a folder in <user data>\reports, next
// to the data folder (the program folder is replaced on every update, so
// reports are not kept there). Nothing is sent anywhere: the operator attaches
// the folder to an issue or e-mail if they want help.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

// ---- a small .zip writer (deflate), so a report folder can be sent as one file
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
// files: [{ name, data: Buffer }] → Buffer of a .zip archive
function zipFiles(files) {
  const local = [], central = [];
  let offset = 0;
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = zlib.deflateRawSync(f.data);
    const crc = crc32(f.data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(8, 8);
    head.writeUInt16LE(dosTime, 10); head.writeUInt16LE(dosDate, 12); head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(data.length, 18); head.writeUInt32LE(f.data.length, 22); head.writeUInt16LE(name.length, 26); head.writeUInt16LE(0, 28);
    local.push(head, name, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(dosTime, 12); cen.writeUInt16LE(dosDate, 14); cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(f.data.length, 24); cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += 30 + name.length + data.length;
  }
  const cenSize = central.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cenSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat(local.concat(central, [end]));
}

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

  // a report folder as one .zip (Buffer)
  zip(folder) {
    return zipFiles(fs.readdirSync(folder).filter((n) => fs.statSync(path.join(folder, n)).isFile()).map((n) => ({ name: n, data: fs.readFileSync(path.join(folder, n)) })));
  }

  // the last lines of errors.log, this session's and earlier ones (for an issue text)
  recent(n) {
    try {
      const all = fs.readFileSync(path.join(this.dir, 'errors.log'), 'utf8').split(/\r?\n/).filter(Boolean);
      return all.slice(-(n || 20));
    } catch (e) { return this.lines.slice(-(n || 20)); }
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

module.exports = { Reports, zipFiles };

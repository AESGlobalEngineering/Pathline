// JSON-file data store kept in the user's AppData folder. Every collection is
// one file, written atomically (temp file + rename) so a crash never leaves a
// half-written library behind.
'use strict';

const fs = require('fs');
const path = require('path');
const seed = require('./seed');

class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.cache = {};
    this.defaults = {
      machines: seed.machines,
      materials: seed.materials,
      settings: seed.settings,
    };
  }

  file(name) {
    return path.join(this.dir, name + '.json');
  }

  get(name) {
    if (this.cache[name] !== undefined) return this.cache[name];
    const f = this.file(name);
    let val;
    try {
      val = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (err) {
      if (fs.existsSync(f)) {
        // keep the unreadable file for recovery rather than overwriting it silently
        try { fs.renameSync(f, f + '.corrupt-' + Date.now()); } catch (e) { /* ignore */ }
      }
      val = this.defaults[name] ? this.defaults[name]() : null;
      if (val !== null) this.write(name, val);
    }
    this.cache[name] = val;
    return val;
  }

  set(name, val) {
    this.cache[name] = val;
    this.write(name, val);
    return val;
  }

  write(name, val) {
    const f = this.file(name);
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(val, null, 2));
    fs.renameSync(tmp, f);
  }

  // --- collection helpers
  upsert(name, item) {
    const list = this.get(name).slice();
    const i = list.findIndex((x) => x.id === item.id);
    if (i >= 0) list[i] = item;
    else list.push(item);
    this.set(name, list);
    return item;
  }

  remove(name, id) {
    this.set(name, this.get(name).filter((x) => x.id !== id));
  }

  find(name, id) {
    return this.get(name).find((x) => x.id === id) || null;
  }
}

module.exports = Store;

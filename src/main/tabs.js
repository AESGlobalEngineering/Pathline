// The jobs open in the app: a tab each on the Job page, each with its own undo
// history. They live in memory so they survive moving between pages, and are
// not kept between runs (every launch starts with one clean job).
'use strict';

const path = require('path');

const UNDO_STEPS = 60;

// unsaved work: changes not saved to a file, and something drawn
const unsaved = (job) => !!(job && job.dirty && job.entities && job.entities.length);
const samePath = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// newJob(machineId) makes an empty job; prepare(job) tidies a job as it is
// stored (e.g. registration marks always come with their process)
function createTabs({ newJob, prepare }) {
  const tidy = prepare || ((j) => j);
  const docs = [];
  let front = null;
  let seq = 0;

  function add(job) {
    const d = { id: 't' + (++seq), job: null, undo: [], redo: [] };
    docs.push(d);
    front = d;
    d.job = tidy(job || newJob());
    return d;
  }
  // the tab in front (there is always one)
  function current() {
    if (!front) add();
    return front;
  }
  const byId = (id) => docs.find((d) => d.id === id) || null;
  // Store a job in a tab (the one in front unless given); record: adds an undo step
  function set(job, opts, d) {
    d = d || current();
    if (opts && opts.record && d.job) {
      d.undo.push(d.job);
      if (d.undo.length > UNDO_STEPS) d.undo.shift();
      d.redo = [];
    }
    d.job = tidy(job);
    return d.job;
  }
  // a tab still holding the empty job it started with: opening a file uses it
  const blank = (d) => !!(d && d.job && !d.job.path && !d.job.dirty && !(d.job.entities || []).length && !d.undo.length);

  return {
    unsaved,
    current,
    job: () => current().job,
    byId,
    // the tab holding the job with this id (a job being saved), else the front tab
    ofJob: (job) => docs.find((d) => d.job && job && d.job.id === job.id) || current(),
    set,
    // a new job in a new tab, on the machine of the job in front
    create(machineId) {
      const was = front && front.job;
      return add(newJob(machineId || (was && was.machineId))).job;
    },
    // the front tab's job replaced outright (no undo back to the old one)
    replace(job) {
      const d = current();
      d.undo = []; d.redo = [];
      return set(job, null, d);
    },
    // Open a job read from a file: in the tab that has that file already (it
    // comes to the front as it is), else in the front tab if that's still
    // blank, else in a new tab.
    open(job) {
      const same = docs.find((d) => d.job && samePath(d.job.path, job.path));
      if (same) { front = same; return same.job; }
      if (blank(front)) { front.undo = []; front.redo = []; return set(job, null, front); }
      return add(job).job;
    },
    switchTo(id) {
      const d = byId(id);
      if (d) front = d;
      return current().job;
    },
    // close a tab; the one to its right comes to the front, else the one to
    // its left, else a new blank job on the same machine
    close(id) {
      const i = docs.findIndex((d) => d.id === id);
      if (i < 0) return current().job;
      const [d] = docs.splice(i, 1);
      if (front === d) front = docs[i] || docs[i - 1] || null;
      if (!front) add(newJob(d.job && d.job.machineId));
      return current().job;
    },
    move(id, to) {
      const i = docs.findIndex((d) => d.id === id);
      if (i >= 0) {
        const [d] = docs.splice(i, 1);
        docs.splice(Math.max(0, Math.min(docs.length, to)), 0, d);
      }
      return this.info();
    },
    undo() {
      const d = current();
      if (!d.undo.length) return null;
      d.redo.push(d.job);
      return set(d.undo.pop(), null, d);
    },
    redo() {
      const d = current();
      if (!d.redo.length) return null;
      d.undo.push(d.job);
      return set(d.redo.pop(), null, d);
    },
    history() {
      const d = current();
      return { undo: d.undo.length, redo: d.redo.length };
    },
    // the tabs in order, and which is in front
    info() {
      const f = current();
      return { active: f.id, tabs: docs.map((d) => ({ id: d.id, name: d.job.name, dirty: unsaved(d.job), path: d.job.path || null })) };
    },
    // tabs with unsaved work (asked about on quitting)
    unsavedTabs: () => docs.filter((d) => unsaved(d.job))
  };
}

module.exports = { createTabs, unsaved, samePath };

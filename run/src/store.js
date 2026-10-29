// Received jobs and history, kept on disk so the queue survives a restart.
//   <data>/jobs/<id>/package.json   the package (without files)
//   <data>/jobs/<id>/job.dxf, job.svg, job-sheet.txt, job.cjob
//   <data>/queue.json, history.json
'use strict';

const fs = require('fs');
const path = require('path');

const KEEP_DONE = 30;      // finished jobs listed in GET /jobs
const KEEP_HISTORY = 200;

class Store {
  constructor(dir) {
    this.dir = dir;
    this.jobsDir = path.join(dir, 'jobs');
    fs.mkdirSync(this.jobsDir, { recursive: true });
    this.jobs = this.read('queue.json', []);
    this.history = this.read('history.json', []);
    // a job that was running when the app stopped didn't finish
    for (const j of this.jobs) if (j.status === 'running') j.status = 'stopped';
    this.seq = this.jobs.concat(this.history).reduce((n, j) => Math.max(n, Number(String(j.id).replace(/\D/g, '')) || 0), 0);
  }

  read(name, d) {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')); } catch (e) { return d; }
  }

  flush() {
    fs.writeFileSync(path.join(this.dir, 'queue.json'), JSON.stringify(this.jobs, null, 1));
    fs.writeFileSync(path.join(this.dir, 'history.json'), JSON.stringify(this.history.slice(0, KEEP_HISTORY), null, 1));
  }

  jobDir(id) { return path.join(this.jobsDir, id); }

  add(pkg, warnings, source) {
    const id = 'J' + String(++this.seq).padStart(4, '0');
    const files = pkg.files || {};
    const clean = { ...pkg };
    delete clean.files;
    const dir = this.jobDir(id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(clean));
    if (files.dxf) fs.writeFileSync(path.join(dir, 'job.dxf'), files.dxf);
    if (files.svg) fs.writeFileSync(path.join(dir, 'job.svg'), files.svg);
    if (files.sheet) fs.writeFileSync(path.join(dir, 'job-sheet.txt'), files.sheet);
    if (files.cjob) fs.writeFileSync(path.join(dir, 'job.cjob'), JSON.stringify(files.cjob));
    const job = {
      id, name: (pkg.job && pkg.job.name) || id, status: 'queued', progress: 0,
      seconds: (pkg.estimate && pkg.estimate.totalSeconds) || 0,
      material: pkg.material ? pkg.material.name + (pkg.material.thickness ? ' ' + pkg.material.thickness + ' mm' : '') : '',
      receivedAt: new Date().toISOString(), finishedAt: null, warnings: warnings || [], source: source || 'pathline', runs: 0
    };
    this.jobs.push(job);
    this.prune();
    this.flush();
    return job;
  }

  pkg(id) {
    return JSON.parse(fs.readFileSync(path.join(this.jobDir(id), 'package.json'), 'utf8'));
  }

  get(id) { return this.jobs.find((j) => j.id === id); }
  next() { return this.jobs.find((j) => j.status === 'queued'); }

  remove(id) {
    const i = this.jobs.findIndex((j) => j.id === id);
    if (i < 0) return false;
    this.jobs.splice(i, 1);
    if (!this.history.some((h) => h.id === id)) fs.rmSync(this.jobDir(id), { recursive: true, force: true });
    this.flush();
    return true;
  }

  order(ids) {
    const rank = (j) => { const k = ids.indexOf(j.id); return k < 0 ? Infinity : k; };
    const queued = this.jobs.filter((j) => j.status === 'queued').sort((a, b) => rank(a) - rank(b));
    let k = 0;
    for (let i = 0; i < this.jobs.length; i++) if (this.jobs[i].status === 'queued') this.jobs[i] = queued[k++];
    this.flush();
  }

  finish(job, result, startedAt, removeDone) {
    job.status = result === 'Completed' ? 'done' : 'stopped';
    job.finishedAt = new Date().toISOString();
    job.runs = (job.runs || 0) + 1;
    if (result === 'Completed') job.progress = 1;
    this.history.unshift({
      id: job.id, name: job.name, material: job.material, startedAt, finishedAt: job.finishedAt,
      seconds: Math.round((Date.parse(job.finishedAt) - Date.parse(startedAt)) / 1000), result
    });
    if (removeDone && result === 'Completed') job.hidden = true;
    this.prune();
    this.flush();
  }

  // put a job (from the queue or history) back in the queue
  requeue(id) {
    const j = this.get(id);
    if (j) {
      if (j.status === 'running') return j;
      j.status = 'queued'; j.progress = 0; j.hidden = false; j.finishedAt = null;
      this.jobs.splice(this.jobs.indexOf(j), 1);
      this.jobs.push(j);
      this.flush();
      return j;
    }
    const pkg = this.pkg(id);
    return this.add(pkg, [], 'history');
  }

  prune() {
    const done = this.jobs.filter((j) => j.status === 'done' || j.status === 'stopped');
    for (const j of done.slice(0, Math.max(0, done.length - KEEP_DONE))) this.jobs.splice(this.jobs.indexOf(j), 1);
  }
}

module.exports = Store;

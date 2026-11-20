// Pulls: whoever holds the pull token asks one machine for one thing from a fixed list (a day's
// log, a job's drawings, its camera pictures, its health …). The machine hears it over its own
// outgoing connection (it waits on GET /api/v1/asks), reads it and sends it back; it's handed to
// whoever asked and forgotten.
//
// Nothing about a pull is written to disk. An answer waits in memory only until it's collected,
// an hour at most; an ask for a machine that's switched off waits a day for it.
//
// Pathline Run checks every ask against its own list again, and only ever reads: nothing here can
// change a machine, start or stop anything, or name a file outside that list.
'use strict';

const crypto = require('crypto');

// what can be asked for, and what each needs: day YYYY-MM-DD, job J0123 (runs: either)
const WHAT = {
  list: 'what this machine has: its days of logs and its jobs',
  log: 'one day\'s diagnostics log (day)',
  job: 'a job\'s drawings and package (job)',
  marks: 'the camera\'s pictures of a job\'s marks (job)',
  runs: 'run records: a job\'s, or a day\'s (job or day)',
  fit: 'the head drawing\'s fit and the bed maps',
  settings: 'the machine\'s settings and materials (no keys)',
  health: 'temperature, power, memory, disk, restarts and versions',
};
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const JOB = /^J\d{1,8}$/;

const fail = (code, msg) => Object.assign(new Error(msg), { code });

// { what, day?, job? } checked, or an error to give back
function checkAsk(b) {
  const what = String((b && b.what) || '');
  if (!Object.prototype.hasOwnProperty.call(WHAT, what)) throw fail(400, 'Ask for one of: ' + Object.keys(WHAT).join(', '));
  const day = b.day == null || b.day === '' ? null : String(b.day);
  const job = b.job == null || b.job === '' ? null : String(b.job).toUpperCase();
  if (day !== null && !DAY.test(day)) throw fail(400, 'A day is YYYY-MM-DD');
  if (job !== null && !JOB.test(job)) throw fail(400, 'A job is J and its number, such as J0123');
  if (what === 'log' && !day) throw fail(400, 'Which day? (day: YYYY-MM-DD)');
  if ((what === 'job' || what === 'marks') && !job) throw fail(400, 'Which job? (job: J0123)');
  if (what === 'runs' && !job && !day) throw fail(400, 'Which job or day? (job: J0123, or day: YYYY-MM-DD)');
  return { what, day: what === 'log' || what === 'runs' ? day : null, job: what === 'job' || what === 'marks' || what === 'runs' ? job : null };
}

class Pulls {
  // scale: shorter times (tests only)
  constructor({ log = () => {}, scale = 1, maxAnswer = 64 * 1048576, maxHeld = 512 * 1048576 } = {}) {
    this.log = log;
    this.T = {
      hold: 25000 * scale,        // a machine's GET /api/v1/asks is answered "nothing" after this
      wait: 25000 * scale,        // a collector's GET /api/pull/<id> is answered "not yet" after this
      answerBy: 600000 * scale,   // a machine took an ask and didn't answer: given up
      waiting: 86400000 * scale,  // nobody took it (the machine is off): given up
      keep: 3600000 * scale,      // an answer nobody collected: dropped
      listening: 60000 * scale,   // a machine heard from on /asks this recently counts as listening
    };
    this.maxAnswer = maxAnswer;
    this.maxHeld = maxHeld;
    this.asks = new Map();    // id → { id, machine, what, day, job, at, state, takenAt, answeredAt, reply, waiters }
    this.polls = new Map();   // machine → resolve() of its waiting GET /api/v1/asks
    this.heard = new Map();   // machine → when it last asked for asks
    this.held = 0;            // bytes of answers held
    this.timer = setInterval(() => this.sweep(), Math.max(50, Math.min(30000, this.T.hold))).unref();
  }

  listening(machine, now = Date.now()) { return now - (this.heard.get(machine) || 0) < this.T.listening || this.polls.has(machine); }

  // a new ask (already checked) for a machine
  add(machine, a, now = Date.now()) {
    const open = [...this.asks.values()].filter((x) => x.machine === machine && (x.state === 'waiting' || x.state === 'taken')).length;
    if (open >= 20) throw fail(429, 'This machine already has 20 asks waiting: collect those first');
    const ask = { id: crypto.randomBytes(9).toString('base64url'), machine, ...a, at: now, state: 'waiting', takenAt: 0, answeredAt: 0, reply: null, waiters: [] };
    this.asks.set(ask.id, ask);
    const wake = this.polls.get(machine);
    if (wake) wake();
    return ask;
  }

  // the machine's GET /api/v1/asks: resolves with the asks waiting for it (at most 5), at once if
  // there are any, else when one comes or after a while with none. A second poll from the same
  // machine ends the first.
  next(machine, onClose) {
    this.heard.set(machine, Date.now());
    const take = () => {
      const now = Date.now();
      const list = [...this.asks.values()].filter((x) => x.machine === machine && x.state === 'waiting').slice(0, 5);
      for (const x of list) { x.state = 'taken'; x.takenAt = now; }
      return list.map((x) => ({ id: x.id, what: x.what, day: x.day, job: x.job }));
    };
    const ready = take();
    if (ready.length) return Promise.resolve(ready);
    const before = this.polls.get(machine);
    if (before) before(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (empty) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        if (this.polls.get(machine) === finish) this.polls.delete(machine);
        this.heard.set(machine, Date.now());
        resolve(empty ? [] : take());
      };
      const t = setTimeout(() => finish(true), this.T.hold);
      this.polls.set(machine, finish);
      if (onClose) onClose(() => finish(true));
    });
  }

  // the machine's answer to one of its asks: { status, type, name, body: Buffer }
  answer(machine, id, reply, now = Date.now()) {
    const a = this.asks.get(id);
    if (!a || a.machine !== machine) throw fail(404, 'No such ask for this machine');
    if (a.state !== 'taken') throw fail(409, 'That ask isn\'t waiting for an answer');
    if (this.held + reply.body.length > this.maxHeld) throw fail(507, 'Pathline Monitor is holding too many answers: they\'re collected first');
    a.state = 'answered';
    a.answeredAt = now;
    a.reply = reply;
    this.held += reply.body.length;
    this.log('pull: ' + machine + ' sent ' + label(a) + ' (' + kb(reply.body.length) + (reply.status >= 400 ? ', ' + reply.status : '') + ')');
    for (const w of a.waiters.splice(0)) w();
  }

  // a collector's GET /api/pull/<id>: resolves with the ask once answered (then forgotten), or
  // with its state after a while
  collect(id, onClose) {
    const a = this.asks.get(id);
    if (!a) return Promise.resolve(null);
    // answered or given up: told once, then forgotten
    const done = () => {
      if (a.state !== 'answered' && a.state !== 'failed') return { state: a.state, ask: a };
      this.forget(a);
      return { state: a.state, ask: a };
    };
    if (a.state === 'answered' || a.state === 'failed') return Promise.resolve(done());
    return new Promise((resolve) => {
      let over = false;
      const finish = () => { if (over) return; over = true; clearTimeout(t); a.waiters = a.waiters.filter((w) => w !== finish); resolve(done()); };
      const t = setTimeout(finish, this.T.wait);
      a.waiters.push(finish);
      if (onClose) onClose(finish);
    });
  }

  forget(a) {
    if (!this.asks.has(a.id)) return;
    if (a.reply) this.held -= a.reply.body.length;
    this.asks.delete(a.id);
  }

  // a machine removed from Monitor: its asks go
  dropMachine(machine) {
    for (const a of [...this.asks.values()]) if (a.machine === machine) { a.state = 'failed'; a.error = 'The machine was removed from Pathline Monitor'; this.forget(a); for (const w of a.waiters.splice(0)) w(); }
    const p = this.polls.get(machine);
    if (p) p(true);
    this.heard.delete(machine);
  }

  sweep(now = Date.now()) {
    for (const a of [...this.asks.values()]) {
      const failNow = (why) => { a.state = 'failed'; a.error = why; a.answeredAt = now; for (const w of a.waiters.splice(0)) w(); };
      if (a.state === 'waiting' && now - a.at > this.T.waiting) failNow('The machine didn\'t ask for it within a day: it\'s been switched off, or isn\'t connected');
      else if (a.state === 'taken' && now - a.takenAt > this.T.answerBy) failNow('The machine took the ask but never answered');
      else if ((a.state === 'answered' || a.state === 'failed') && now - a.answeredAt > this.T.keep) {
        if (a.state === 'answered') this.log('pull: ' + label(a) + ' from ' + a.machine + ' wasn\'t collected within the hour: dropped');
        this.forget(a);
      }
    }
  }

  close() { clearInterval(this.timer); for (const p of this.polls.values()) p(true); }
}

const label = (a) => a.what + (a.day ? ' ' + a.day : '') + (a.job ? ' ' + a.job : '');
const kb = (n) => (n < 1048576 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(1) + ' MB');

module.exports = { Pulls, checkAsk, WHAT };

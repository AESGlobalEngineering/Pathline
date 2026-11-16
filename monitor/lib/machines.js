// What each Pathline Run reports (its GET /api/v1/monitor answer, sent here with
// POST /api/v1/report) becomes (a) one view per machine for the phones and (b) alerts when
// something happens.
//
// Which "needs you" cases send an alert:
//   waiting for a registration mark   alert (attn): the job stopped and nobody may be there
//   error (alarm)                     alert (err)
//   stopped reporting / lost the laser  alert (err), after a wait, so a blip doesn't. When
//                                     every machine stops together it's one alert, not one each
//   finished with jobs still queued   the "finished" alert only (it says what's waiting)
//   lid open, paused                  no alert: someone did that at the machine
'use strict';

// Run reports at least every 10 s: three missed and it's taken as not reporting
const SILENT_AFTER_MS = 35 * 1000;
// Run reports, but has lost the laser itself for this long
const LOST_AFTER_MS = 20 * 1000;
// "stopped reporting" alerts wait this long, so machines that stop together make one alert
const TOGETHER_MS = 12 * 1000;
// an idle machine that finished a job this recently, with jobs still queued, is "Finished":
// it's waiting for someone to press Start
const DONE_FOR_MS = 2 * 60 * 60 * 1000;

const mins = (s) => { s = Math.max(0, Math.round(s || 0)); return s >= 3600 ? Math.floor(s / 3600) + ' h ' + String(Math.floor((s % 3600) / 60)).padStart(2, '0') + ' min' : s < 60 ? s + ' s' : Math.floor(s / 60) + ' min ' + String(s % 60).padStart(2, '0') + ' s'; };
const jobs = (n) => n + (n === 1 ? ' job' : ' jobs');
const ms = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };
const str = (v, n = 120) => (v == null ? '' : String(v).slice(0, n));
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const entry = (j) => ({ id: str(j.id, 64), name: str(j.name), material: str(j.material), seconds: num(j.seconds) });

// Run's answer, with only what's used kept and every text cut to a sane length. Times are ms.
function fromMonitor(v) {
  return {
    name: str(v.name, 60), type: v.type === 'plotter' ? 'plotter' : 'laser', ctrl: str(v.ctrl, 40), model: str(v.model, 60),
    link: v.link === 'offline' || v.link === 'connecting' ? v.link : 'online', state: str(v.state, 20) || 'idle', since: ms(v.since), message: str(v.message, 200),
    interlock: !!v.interlock, interlockSince: ms(v.interlockSince),
    markWait: v.markWait ? { mark: num(v.markWait.mark), of: num(v.markWait.of), since: ms(v.markWait.since) } : null,
    job: v.job ? { ...entry(v.job), progress: Math.max(0, Math.min(1, num(v.job.progress))), remaining: Number.isFinite(v.job.remaining) ? v.job.remaining : null, beds: Array.isArray(v.job.beds) ? v.job.beds.slice(0, 2).map(num) : null } : null,
    queue: (Array.isArray(v.queue) ? v.queue : []).slice(0, 100).map((j) => ({ ...entry(j), autoStart: !!j.autoStart })),
    today: (Array.isArray(v.today) ? v.today : []).filter((h) => ms(h.finishedAt)).slice(0, 20).map((h) => ({ ...entry(h), ok: h.result === 'Completed', finishedAt: ms(h.finishedAt) })),
  };
}

class Machines {
  // saved: { id: view } from the last run of this server, so a job that finished while it was
  // restarting still alerts. onAlert(alert); onChange(view) when a phone should be told.
  constructor({ onAlert = () => {}, onChange = () => {}, saved = {}, now = Date.now() } = {}) {
    this.onAlert = onAlert;
    this.onChange = onChange;
    this.saved = saved;
    this.started = now;
    this.list = new Map();
    this.held = new Map();
  }

  add(id, name, now = Date.now()) {
    const view = this.saved[id] || null;
    // a machine that was reporting before the restart gets the usual wait to report again
    this.list.set(id, { id, name, rep: null, at: view && view.state !== 'offline' ? this.started : 0, view, sent: '', sentAt: 0, lost: 0 });
    this.update(this.list.get(id), now);
  }
  remove(id) { this.held.delete(id); return this.list.delete(id); }

  // one report from a machine
  report(id, body, now = Date.now()) {
    const m = this.list.get(id);
    if (!m) return false;
    m.rep = fromMonitor(body);
    m.at = now;
    this.update(m, now);
    return true;
  }
  // now and then: who has gone quiet, and the held "stopped reporting" alerts
  tick(now = Date.now()) {
    for (const m of this.list.values()) this.update(m, now);
    if (!this.held.size) return;
    // sent once no other machine has gone quiet for a while (or the first has waited long enough)
    const due = [...this.held.values()];
    const ats = due.map((a) => a.at);
    if (now - Math.max(...ats) < TOGETHER_MS && now - Math.min(...ats) < 4 * TOGETHER_MS) return;
    this.held.clear();
    const quiet = [...this.list.values()].filter((m) => m.view.state === 'offline' && m.view.why === 'Not reporting').length;
    if (due.length > 1 && quiet === this.list.size) this.onAlert({ kind: 'err', tags: ['err'], machine: null, title: 'The workshop stopped reporting', body: 'None of the ' + quiet + ' machines is reporting. The workshop\'s internet may be down.', at: now });
    else for (const a of due) this.onAlert(a);
  }

  update(m, now) {
    const view = this.toView(m, now);
    if (m.view) this.compare(m.view, view, now);
    m.view = view;
    // phones count a running job down themselves: they're told when something else changes,
    // and every 15 s while a job runs, to stay in step
    const key = JSON.stringify({ ...view, at: 0, job: view.job && { ...view.job, progress: 0, remaining: 0 } });
    if (key !== m.sent || (view.state === 'running' && now - m.sentAt >= 15000)) { m.sent = key; m.sentAt = now; this.onChange(view); }
  }

  // what the phone shows for one machine
  toView(m, now) {
    const r = m.rep;
    const old = m.view;
    const base = { id: m.id, name: (r && r.name) || (old && old.name) || m.name || m.id, kind: r ? r.type : (old && old.kind) || 'laser', model: r ? [r.ctrl, r.model && r.model !== r.name ? r.model : ''].filter(Boolean).join(' · ') : (old && old.model) || '', at: m.at };
    const silent = now - m.at > SILENT_AFTER_MS;
    // this server has just restarted: the machine keeps what it showed until it reports again
    if (!r && !silent) return { ...old, ...base };
    if (silent) {
      const kept = { queue: r ? r.queue : (old && old.queue) || [], today: r ? r.today : (old && old.today) || [] };
      // never heard from (since: null), or already known to be quiet
      if (!m.at || (old && old.state === 'offline' && old.why === 'Not reporting')) return { ...base, ...kept, state: 'offline', why: 'Not reporting', since: old ? old.since : null };
      return { ...base, ...kept, state: 'offline', why: 'Not reporting', since: m.at };
    }
    const job = r.job ? { ...r.job, remaining: r.job.remaining !== null ? r.job.remaining : Math.round(r.job.seconds * (1 - r.job.progress)) } : null;
    const v = { ...base, job, queue: r.queue, today: r.today, message: r.message };
    // when a state began: Run's own time when it gives one, else when this server first saw it
    const began = (s, given) => given || (old && old.state === s ? old.since : now);
    if (r.link !== 'online') {
      // Run reports, but has lost the laser itself
      m.lost = m.lost || now;
      if (now - m.lost > LOST_AFTER_MS) return { ...v, state: 'offline', why: 'Not connected to the ' + base.kind, since: m.lost };
    } else m.lost = 0;
    if (r.state === 'alarm') return { ...v, state: 'alarm', why: r.message || 'Error', since: began('alarm', r.since) };
    if (r.markWait) return { ...v, state: 'mark', why: 'Registration mark ' + r.markWait.mark + ' of ' + r.markWait.of + ' not found', since: began('mark', r.markWait.since) };
    if (r.interlock && r.link === 'online') return { ...v, state: 'lid', since: began('lid', r.interlockSince) };
    if (r.state === 'running') return { ...v, state: 'running' };
    if (r.state === 'paused') return { ...v, state: 'paused', since: began('paused', r.since) };
    if (r.state === 'framing') return { ...v, state: 'framing' };
    const last = r.today[0];
    // finished, and the next job waits for Start (not one a plotter starts by itself)
    if (last && last.ok && r.queue.length && !r.queue[0].autoStart && now - last.finishedAt < DONE_FOR_MS) return { ...v, state: 'done', lastDone: last.name, doneAt: last.finishedAt };
    return { ...v, state: 'idle' };
  }

  // what changed since the last look, as alerts
  compare(a, b, now) {
    const alert = (kind, tags, title, body) => this.onAlert({ kind, tags, machine: b.id, title, body, at: now });
    // a job finished or stopped: a new entry at the top of today's history
    const seen = new Set((a.today || []).map((h) => h.id + '@' + h.finishedAt));
    for (const h of (b.today || []).slice().reverse()) {
      if (seen.has(h.id + '@' + h.finishedAt)) continue;
      if (h.ok) {
        const waiting = b.queue.length;
        const next = b.state === 'running' && b.job ? ' · started ' + b.job.name + ' next'
          : waiting && b.queue[0].autoStart ? ' · ' + b.queue[0].name + ' starts next by itself'
            : waiting ? ' · ' + jobs(waiting) + ' waiting: press Start at the machine' : ' · queue empty';
        alert('done', waiting || b.state === 'running' ? ['done'] : ['done', 'queue'], b.name + ' finished ' + h.name, mins(h.seconds) + next);
      } else {
        alert('err', ['err'], b.name + ' stopped ' + h.name, 'Stopped after ' + mins(h.seconds) + (b.queue.length ? ' · ' + jobs(b.queue.length) + ' still queued' : ''));
      }
    }
    if (b.state === a.state) return;
    const queued = b.queue.length ? ' ' + jobs(b.queue.length) + ' waiting in its queue.' : '';
    if (b.state === 'mark') alert('attn', ['attn'], b.name + ' needs you', b.why + (b.job ? ' on ' + b.job.name : '') + '. Find it with the camera at the machine.');
    else if (b.state === 'alarm') alert('err', ['err'], b.name + ' has an error', b.why + '. Clear it at the machine.');
    else if (b.state === 'offline' && b.why === 'Not reporting') this.held.set(b.id, { kind: 'err', tags: ['err'], machine: b.id, title: b.name + ' stopped reporting', body: 'Its PC is off, Pathline Run is closed, or it has lost the internet.' + queued, at: now });
    else if (b.state === 'offline') alert('err', ['err'], b.name + ' lost its ' + b.kind, 'Pathline Run can\'t reach the ' + b.kind + '.' + queued);
    // back before its "stopped reporting" alert went out: neither is sent
    // (a machine never heard from before isn't "back")
    else if (a.state === 'offline' && !this.held.delete(b.id) && a.since) alert('info', [], b.name + ' is back', 'Reporting again.');
  }

  views() { return [...this.list.values()].map((m) => m.view); }
}

module.exports = { Machines, fromMonitor, SILENT_AFTER_MS, TOGETHER_MS };

// Watches Pathline Run machines over the workshop network and turns what they report into
// (a) one view per machine for the phone and (b) alerts when something happens.
//
// Pathline Run 0.7.12 and later: GET /api/v1/events, a live stream of the machine's own watcher
// answer (GET /api/v1/monitor: state and when it began, the job with Run's own time left, the
// queue with autoStart, today's jobs). A change reaches the phones within a second. If the
// stream drops, GET /api/v1/monitor is asked every POLL_MS until it's back.
// Older Runs: GET /api/local/state (what Run's own screen reads) every POLL_MS, and
// GET /api/v1/info now and then. Both are turned into the same report (toReport), so the view
// and the alerts don't depend on which one a machine has.
//
// Which "needs you" cases send an alert:
//   waiting for a registration mark   alert (attn): the job stopped and nobody may be there
//   error (alarm)                     alert (err)
//   not answering / lost the laser    alert (err), after OFFLINE_AFTER_MS, so a blip doesn't
//   finished with jobs still queued   the "finished" alert only (it says what's waiting)
//   lid open, paused                  no alert: someone did that at the machine
'use strict';

const http = require('http');
const https = require('https');

const POLL_MS = 2000;
const INFO_EVERY_MS = 60 * 1000;
const OFFLINE_AFTER_MS = 20 * 1000;
// an older Run is asked again now and then whether it has /api/v1/monitor yet (it was updated)
const RECHECK_MS = 10 * 60 * 1000;
// Run's stream sends a comment every 25 s: nothing for this long and it's taken as dropped
const STREAM_QUIET_MS = 40 * 1000;
// an idle machine that finished a job this recently, with jobs still queued, is "Finished":
// it's waiting for someone to press Start
const DONE_FOR_MS = 2 * 60 * 60 * 1000;

const lib = (url) => (url.startsWith('https:') ? https : http);
function getJSON(url, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const req = lib(url).get(url, { timeout, headers: { accept: 'application/json' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) { const e = new Error((safeParse(text) || {}).error || 'HTTP ' + res.statusCode); e.status = res.statusCode; return reject(e); }
        const v = safeParse(text);
        if (v === undefined) return reject(new Error('Not JSON'));
        resolve(v);
      });
    });
    req.on('timeout', () => req.destroy(new Error('No answer')));
    req.on('error', reject);
  });
}
function safeParse(t) { try { return JSON.parse(t); } catch (e) { return undefined; } }

const slug = (s) => String(s || 'machine').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'machine';
const today = (iso, now) => { const d = new Date(iso), n = new Date(now); return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate(); };
const mins = (s) => { s = Math.max(0, Math.round(s || 0)); return s >= 3600 ? Math.floor(s / 3600) + ' h ' + String(Math.floor((s % 3600) / 60)).padStart(2, '0') + ' min' : s < 60 ? s + ' s' : Math.floor(s / 60) + ' min ' + String(s % 60).padStart(2, '0') + ' s'; };
const jobs = (n) => n + (n === 1 ? ' job' : ' jobs');
const ms = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };

// ---------------------------------------------------------------- one report, from either source
// { id, name, type, ctrl, model, link, state, since, message, interlock, interlockSince,
//   markWait: { mark, of, since } | null, job: { id, name, material, seconds, progress, remaining, beds } | null,
//   queue: [{ id, name, material, seconds, autoStart }], today: [{ id, name, material, seconds, ok, finishedAt }] }
// Times are ms; since/interlockSince/markWait.since are null when the source doesn't say.
function fromMonitor(v) {
  const job = v.job ? {
    id: v.job.id, name: v.job.name, material: v.job.material || '', seconds: v.job.seconds || 0,
    progress: Math.max(0, Math.min(1, Number(v.job.progress) || 0)),
    remaining: Number.isFinite(v.job.remaining) ? v.job.remaining : null,
    beds: Array.isArray(v.job.beds) ? v.job.beds : null,
  } : null;
  return {
    id: v.id || null, name: v.name, type: v.type, ctrl: v.ctrl, model: v.model,
    link: v.link || 'online', state: v.state || 'idle', since: ms(v.since), message: v.message || '',
    interlock: !!v.interlock, interlockSince: ms(v.interlockSince),
    markWait: v.markWait ? { mark: v.markWait.mark, of: v.markWait.of, since: ms(v.markWait.since) } : null,
    job,
    queue: (v.queue || []).map((j) => ({ id: j.id, name: j.name, material: j.material || '', seconds: j.seconds || 0, autoStart: !!j.autoStart })),
    today: (v.today || []).filter((h) => h.finishedAt).slice(0, 20).map((h) => ({ id: h.id, name: h.name, material: h.material || '', seconds: h.seconds || 0, ok: h.result === 'Completed', finishedAt: ms(h.finishedAt) })),
  };
}
function fromLocalState(r, info, now) {
  const st = r.status || {};
  const cfg = r.config || {};
  const all = (r.jobs || []).filter((j) => !j.hidden);
  const running = all.find((j) => j.id === st.job);
  return {
    id: (info && info.id) || null, name: (info && info.name) || cfg.name, type: (info && info.type) || cfg.type, ctrl: (info && info.ctrl) || (cfg.controller ? cfg.controller[0].toUpperCase() + cfg.controller.slice(1) : ''), model: info && info.model,
    link: st.link || 'online', state: st.state || 'idle', since: null, message: st.message || '',
    interlock: !!st.interlock, interlockSince: null,
    markWait: st.markWait ? { mark: st.markWait.mark, of: st.markWait.of, since: null } : null,
    job: running && (st.state === 'running' || st.state === 'paused' || st.markWait)
      ? { id: running.id, name: running.name, material: running.material || '', seconds: running.seconds || 0, progress: Math.max(0, Math.min(1, st.progress || 0)), remaining: null, beds: null } : null,
    queue: all.filter((j) => j.status === 'queued').map((j) => ({ id: j.id, name: j.name, material: j.material || '', seconds: j.seconds || 0, autoStart: false })),
    today: (r.history || []).filter((h) => h.finishedAt && today(h.finishedAt, now)).slice(0, 20)
      .map((h) => ({ id: h.id, name: h.name, material: h.material || '', seconds: h.seconds || 0, ok: h.result === 'Completed', finishedAt: ms(h.finishedAt) })),
  };
}

class Watcher {
  // machines: [{ id?, name?, host, port? }]; onAlert(alert); now() for tests; stream: false to only poll
  constructor(machines, { onAlert = () => {}, onChange = () => {}, now = () => Date.now(), log = () => {}, stream = true } = {}) {
    this.onAlert = onAlert;
    this.onChange = onChange;
    this.now = now;
    this.log = log;
    this.streams = stream;
    this.list = [];
    for (const m of machines) this.add(m);
  }

  // one machine to watch: { id?, name?, host, port?, deviceId? }. Returns false if it's already
  // watched (the same Run id, or the same address and port).
  add(m) {
    const port = Number(m.port) || 8470;
    if (this.find(m.host, port, m.deviceId)) return false;
    let id = m.id || slug(m.name || m.host);
    while (this.list.some((x) => x.id === id)) id += '-2';
    this.list.push({ id, conf: { ...m, port }, base: (m.https ? 'https' : 'http') + '://' + m.host + ':' + port, api: null, apiAt: 0, info: null, infoAt: 0, rep: null, lastOk: 0, firstSeen: false, view: null, live: null });
    return true;
  }
  find(host, port, deviceId) {
    return this.list.find((x) => (deviceId && x.conf.deviceId === deviceId) || (x.conf.host === host && x.conf.port === (Number(port) || 8470)));
  }
  // a machine that turned up at a new address (Run announced its id from somewhere else)
  moveTo(m, host, port) {
    m.conf = { ...m.conf, host, port };
    m.base = (m.conf.https ? 'https' : 'http') + '://' + host + ':' + port;
    this.closeStream(m);
  }

  start() {
    const loop = async () => { await this.pollAll(); this.timer = setTimeout(loop, POLL_MS); };
    loop();
  }
  stop() { clearTimeout(this.timer); for (const m of this.list) this.closeStream(m); }

  async pollAll() {
    await Promise.all(this.list.map((m) => this.poll(m).catch((e) => this.log(m.id + ': ' + e.message))));
    this.onChange(this.views());
  }

  // a machine with a live stream needn't be asked: it says when something changes
  streaming(m, now) {
    if (!m.live) return false;
    if (now - m.live.heard > STREAM_QUIET_MS) { this.closeStream(m); return false; }
    return true;
  }

  async poll(m) {
    const now = this.now();
    if (this.streaming(m, now)) return;
    try {
      if (m.api === 'local' && now - m.apiAt > RECHECK_MS) m.api = null;
      if (m.api !== 'local') {
        try {
          const v = await getJSON(m.base + '/api/v1/monitor');
          m.api = 'monitor'; m.apiAt = now;
          m.rep = fromMonitor(v);
          if (this.streams) this.openStream(m);
        } catch (e) {
          // an older Run: no /api/v1/monitor (404), so what its own screen reads
          if (e.status !== 404) throw e;
          m.api = 'local'; m.apiAt = now;
          this.log(m.id + ': Pathline Run before 0.7.12, reading its screen\'s data');
        }
      }
      if (m.api === 'local') {
        if (!m.info || now - m.infoAt > INFO_EVERY_MS) { m.info = await getJSON(m.base + '/api/v1/info').catch(() => m.info); m.infoAt = now; }
        m.rep = fromLocalState(await getJSON(m.base + '/api/local/state'), m.info, now);
      }
      if (m.rep && m.rep.id && !m.conf.deviceId) m.conf.deviceId = String(m.rep.id);
      m.lastOk = now;
      m.error = null;
    } catch (e) {
      m.error = e.message;
    }
    this.update(m, now);
  }

  // GET /api/v1/events: the watcher answer as it changes (Run 0.7.12+)
  openStream(m) {
    if (m.live) return;
    const url = m.base + '/api/v1/events';
    const live = { req: null, heard: this.now(), buf: '' };
    m.live = live;
    const req = lib(url).get(url, { headers: { accept: 'text/event-stream' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); this.closeStream(m); return; }
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        live.heard = this.now();
        live.buf += chunk;
        let i;
        while ((i = live.buf.indexOf('\n\n')) >= 0) {
          const block = live.buf.slice(0, i);
          live.buf = live.buf.slice(i + 2);
          const lines = block.split('\n');
          const event = (lines.find((l) => l.startsWith('event:')) || '').slice(6).trim();
          const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
          // "finished" repeats a today entry the next answer carries too: the answer is enough
          if (!data || event) continue;
          const v = safeParse(data);
          if (!v) continue;
          const now = this.now();
          m.rep = fromMonitor(v);
          m.lastOk = now;
          m.error = null;
          this.update(m, now);
          this.onChange(this.views());
        }
      });
      res.on('end', () => this.closeStream(m));
      res.on('error', () => this.closeStream(m));
    });
    req.on('error', () => this.closeStream(m));
    live.req = req;
  }
  closeStream(m) {
    if (!m.live) return;
    const r = m.live.req;
    m.live = null;
    try { if (r) r.destroy(); } catch (e) { /* gone */ }
  }

  update(m, now) {
    const view = this.toView(m, now);
    if (m.firstSeen) this.compare(m, m.view, view, now);
    m.firstSeen = true;
    m.view = view;
  }

  // what the phone shows for one machine
  toView(m, now) {
    const r = m.rep;
    const name = m.conf.name || (r && r.name) || m.conf.host;
    const kind = r && r.type === 'plotter' ? 'plotter' : 'laser';
    const model = r ? [r.ctrl, r.model && r.model !== name ? r.model : ''].filter(Boolean).join(' · ') : '';
    const base = { id: m.id, name, kind, model, address: m.conf.host + ':' + (m.conf.port || 8470), source: m.api };
    if (!r && !m.lastOk) return { ...base, state: 'offline', why: 'Not answering', since: null, queue: [], today: [] };
    if (!r || (m.error && now - m.lastOk > OFFLINE_AFTER_MS)) return { ...base, state: 'offline', why: 'Not answering', since: m.lastOk || now, queue: (m.view && m.view.queue) || [], today: (m.view && m.view.today) || [] };
    const job = r.job ? { ...r.job, remaining: r.job.remaining !== null ? r.job.remaining : Math.round(r.job.seconds * (1 - r.job.progress)) } : null;
    const v = { ...base, job, queue: r.queue, today: r.today, message: r.message };
    // when a state began: Run's own time when it gives one, else when this hub first saw it
    const began = (s, given) => given || (m.view && m.view.state === s ? m.view.since : now);
    if (r.link && r.link !== 'online') {
      // Run answers, but has lost the laser itself
      const lost = (m.lostSince = m.lostSince || now);
      if (now - lost > OFFLINE_AFTER_MS) return { ...v, state: 'offline', why: 'Not connected to the ' + kind, since: lost };
    } else m.lostSince = 0;
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
  compare(m, a, b, now) {
    if (!a) return;
    const alert = (kind, tags, title, body) => this.onAlert({ kind, tags, machine: b.id, title, body, at: now });
    // a job finished or stopped: a new entry at the top of today's history
    const seen = new Set((a.today || []).map((h) => h.id + '@' + h.finishedAt));
    for (const h of (b.today || []).slice().reverse()) {
      if (seen.has(h.id + '@' + h.finishedAt)) continue;
      if (h.ok) {
        const waiting = b.queue.length;
        const nextSelf = waiting && b.queue[0].autoStart;
        const next = b.state === 'running' && b.job ? ' · started ' + b.job.name + ' next'
          : nextSelf ? ' · ' + b.queue[0].name + ' starts next by itself'
            : waiting ? ' · ' + jobs(waiting) + ' waiting: press Start at the machine' : ' · queue empty';
        alert('done', waiting || b.state === 'running' ? ['done'] : ['done', 'queue'], b.name + ' finished ' + h.name, mins(h.seconds) + next);
      } else {
        alert('err', ['err'], b.name + ' stopped ' + h.name, 'Stopped after ' + mins(h.seconds) + (b.queue.length ? ' · ' + jobs(b.queue.length) + ' still queued' : ''));
      }
    }
    if (b.state === a.state) return;
    if (b.state === 'mark') alert('attn', ['attn'], b.name + ' needs you', b.why + (b.job ? ' on ' + b.job.name : '') + '. Find it with the camera at the machine.');
    else if (b.state === 'alarm') alert('err', ['err'], b.name + ' has an error', b.why + '. Clear it at the machine.');
    else if (b.state === 'offline') alert('err', ['err'], b.name + (b.why === 'Not answering' ? ' stopped answering' : ' lost its ' + b.kind), (b.why === 'Not answering' ? 'Not reachable on the workshop network.' : 'Pathline Run can\'t reach the ' + b.kind + '.') + (b.queue.length ? ' ' + jobs(b.queue.length) + ' waiting in its queue.' : ''));
    else if (a.state === 'offline') alert('info', [], b.name + ' is back', 'Answering again.');
  }

  views() { return this.list.map((m) => m.view).filter(Boolean); }
}

module.exports = { Watcher, getJSON, fromMonitor, fromLocalState, POLL_MS, OFFLINE_AFTER_MS };

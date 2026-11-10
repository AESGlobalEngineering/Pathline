// Watches Pathline Run machines over the workshop network and turns what they report into
// (a) one view per machine for the phone and (b) alerts when something happens.
//
// Each machine is asked GET /api/local/state (what Run's own screen reads: status, queue,
// history) every POLL_MS, and GET /api/v1/info now and then (name, laser or plotter, model).
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
// an idle machine that finished a job this recently, with jobs still queued, is "Finished":
// it's waiting for someone to press Start
const DONE_FOR_MS = 2 * 60 * 60 * 1000;

function getJSON(url, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { timeout, headers: { accept: 'application/json' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) return reject(new Error((safeParse(text) || {}).error || 'HTTP ' + res.statusCode));
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

class Watcher {
  // machines: [{ id?, name?, host, port? }]; onAlert(alert); now() for tests
  constructor(machines, { onAlert = () => {}, onChange = () => {}, now = () => Date.now(), log = () => {} } = {}) {
    this.onAlert = onAlert;
    this.onChange = onChange;
    this.now = now;
    this.log = log;
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
    this.list.push({ id, conf: { ...m, port }, base: (m.https ? 'https' : 'http') + '://' + m.host + ':' + port, info: null, infoAt: 0, raw: null, lastOk: 0, firstSeen: false, view: null });
    return true;
  }
  find(host, port, deviceId) {
    return this.list.find((x) => (deviceId && x.conf.deviceId === deviceId) || (x.conf.host === host && x.conf.port === (Number(port) || 8470)));
  }
  // a machine that turned up at a new address (Run announced its id from somewhere else)
  moveTo(m, host, port) {
    m.conf = { ...m.conf, host, port };
    m.base = (m.conf.https ? 'https' : 'http') + '://' + host + ':' + port;
  }

  start() {
    const loop = async () => { await this.pollAll(); this.timer = setTimeout(loop, POLL_MS); };
    loop();
  }
  stop() { clearTimeout(this.timer); }

  async pollAll() {
    await Promise.all(this.list.map((m) => this.poll(m).catch((e) => this.log(m.id + ': ' + e.message))));
    this.onChange(this.views());
  }

  async poll(m) {
    const now = this.now();
    try {
      if (!m.info || now - m.infoAt > INFO_EVERY_MS) {
        m.info = await getJSON(m.base + '/api/v1/info').catch(() => m.info);
        m.infoAt = now;
        // Run's own id, so the machine can be followed if its address changes
        if (m.info && m.info.id && !m.conf.deviceId) m.conf.deviceId = String(m.info.id);
      }
      m.raw = await getJSON(m.base + '/api/local/state');
      m.lastOk = now;
      m.error = null;
    } catch (e) {
      m.error = e.message;
    }
    const view = this.toView(m, now);
    if (m.firstSeen) this.compare(m, m.view, view, now);
    m.firstSeen = true;
    m.view = view;
  }

  // what the phone shows for one machine
  toView(m, now) {
    const r = m.raw;
    const info = m.info || {};
    const cfg = (r && r.config) || {};
    const name = m.conf.name || info.name || cfg.name || m.conf.host;
    const kind = info.type === 'plotter' || cfg.type === 'plotter' ? 'plotter' : 'laser';
    const model = [info.ctrl, info.model && info.model !== name ? info.model : ''].filter(Boolean).join(' · ') || (cfg.controller ? cfg.controller[0].toUpperCase() + cfg.controller.slice(1) : '');
    const base = { id: m.id, name, kind, model, address: m.conf.host + ':' + (m.conf.port || 8470) };
    const unreachable = !r || (m.error && now - m.lastOk > OFFLINE_AFTER_MS);
    if (!r && !m.lastOk) return { ...base, state: 'offline', why: 'Not answering', since: null, queue: [], today: [] };
    if (unreachable) return { ...base, state: 'offline', why: 'Not answering', since: m.lastOk || now, queue: (m.view && m.view.queue) || [], today: (m.view && m.view.today) || [] };
    const st = r.status || {};
    const all = (r.jobs || []).filter((j) => !j.hidden);
    const queue = all.filter((j) => j.status === 'queued').map((j) => ({ id: j.id, name: j.name, material: j.material || '', seconds: j.seconds || 0 }));
    const history = r.history || [];
    const todayList = history.filter((h) => h.finishedAt && today(h.finishedAt, now)).slice(0, 20)
      .map((h) => ({ id: h.id, name: h.name, material: h.material || '', seconds: h.seconds || 0, ok: h.result === 'Completed', finishedAt: Date.parse(h.finishedAt) }));
    const running = all.find((j) => j.id === st.job);
    const job = running && (st.state === 'running' || st.state === 'paused' || st.markWait)
      ? { id: running.id, name: running.name, material: running.material || '', seconds: running.seconds || 0, progress: Math.max(0, Math.min(1, st.progress || 0)) } : null;
    const v = { ...base, job, queue, today: todayList, message: st.message || '' };
    const prevSince = (s) => (m.view && m.view.state === s ? m.view.since : now);
    if (st.link && st.link !== 'online') {
      // Run answers, but has lost the laser itself
      const lost = (m.lostSince = m.lostSince || now);
      if (now - lost > OFFLINE_AFTER_MS) return { ...v, state: 'offline', why: 'Not connected to the ' + kind, since: lost };
    } else m.lostSince = 0;
    if (st.state === 'alarm') return { ...v, state: 'alarm', why: st.message || 'Error', since: prevSince('alarm') };
    if (st.markWait) return { ...v, state: 'mark', why: 'Registration mark ' + st.markWait.mark + ' of ' + st.markWait.of + ' not found', since: prevSince('mark') };
    if (st.interlock && st.link === 'online') return { ...v, state: 'lid', since: prevSince('lid') };
    if (st.state === 'running') return { ...v, state: 'running' };
    if (st.state === 'paused') return { ...v, state: 'paused', since: prevSince('paused') };
    if (st.state === 'framing') return { ...v, state: 'framing' };
    const last = todayList[0];
    if (last && last.ok && queue.length && now - last.finishedAt < DONE_FOR_MS) return { ...v, state: 'done', lastDone: last.name, doneAt: last.finishedAt };
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
        const next = b.state === 'running' && b.job ? ' · started ' + b.job.name + ' next' : waiting ? ' · ' + jobs(waiting) + ' waiting: press Start at the machine' : ' · queue empty';
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

module.exports = { Watcher, getJSON, POLL_MS, OFFLINE_AFTER_MS };

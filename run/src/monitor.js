// GET /api/v1/monitor and GET /api/v1/events: one small, read-only answer for watchers such as
// Pathline Monitor, the workshop's phone app (hmi/RUN-MONITOR-BRIEF.md). It never changes the
// machine. Every 250 ms it looks at the machine, notes when the state, the lid and a wait for a
// registration mark began, and tells the event stream when anything changed or a job finished.
// When the state began is kept in data/monitor.json, so it survives a restart of Pathline Run.
'use strict';

const fs = require('fs');
const path = require('path');

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

// o: { machine, store, dataDir, info() → { id, name, type, ctrl, model, app } }
function createMonitor(o) {
  const { machine, store } = o;
  const file = path.join(o.dataDir, 'monitor.json');
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { /* first run */ }
  const now0 = Date.now();
  // when each began: kept from the last run of Pathline Run if it's still the same
  const t = {
    state: machine.st.state, since: saved.state === machine.st.state && Number.isFinite(saved.since) ? saved.since : now0,
    interlock: !!machine.st.interlock, interlockSince: saved.interlock === !!machine.st.interlock && saved.interlock && Number.isFinite(saved.interlockSince) ? saved.interlockSince : machine.st.interlock ? now0 : null,
    markKey: null, markSince: null
  };
  const save = () => { try { fs.writeFileSync(file, JSON.stringify({ state: t.state, since: t.since, interlock: t.interlock, interlockSince: t.interlockSince })); } catch (e) { /* not kept */ } };

  // what a plotter job over several beds is on: [bed, of]
  function beds(job) {
    let pkg;
    try { pkg = store.pkg(job.id); } catch (e) { return null; }
    const n = Number(pkg && pkg.beds) || 0;
    if (n < 2) return null;
    // the feeds the job has passed, by its steps' own times against the progress
    const steps = pkg.toolpath || [];
    const total = steps.reduce((a, s) => a + (Number(s.seconds) || 0), 0) || 1;
    const done = (Number(machine.st.progress) || 0) * total;
    let acc = 0, bed = 1;
    for (const s of steps) { acc += Number(s.seconds) || 0; if (s.type === 'feed' && acc <= done) bed++; }
    return [Math.min(bed, n), n];
  }

  function view() {
    const st = machine.st;
    const now = Date.now();
    const info = o.info();
    const run = machine.run;
    let job = null;
    if (run && run.job) {
      const j = run.job, startedAt = run.startedAt ? Date.parse(run.startedAt) : null;
      const progress = Math.max(0, Math.min(1, Number(st.progress) || 0));
      const seconds = Number(j.seconds) || null;
      job = {
        id: j.id, name: j.name, material: j.material || '', seconds, progress: +progress.toFixed(4),
        elapsed: startedAt ? Math.max(0, Math.round((now - startedAt) / 1000)) : null,
        // Run's own: the program's time (as converted for the machine) less what the reported parts say is done
        remaining: seconds !== null ? Math.max(0, Math.round(seconds * (1 - progress))) : null,
        startedAt: iso(startedAt), beds: beds(j)
      };
    }
    const batch = Array.isArray(machine.batch) ? machine.batch : [];
    const queue = store.jobs.filter((j) => j.status === 'queued' && !j.hidden).map((j) => ({ id: j.id, name: j.name, material: j.material || '', seconds: j.seconds === undefined ? null : j.seconds, autoStart: batch.includes(j.id) }));
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const today = store.history.filter((h) => h.finishedAt && Date.parse(h.finishedAt) >= midnight.getTime()).slice(0, 50)
      .map((h) => ({ id: h.id, name: h.name, material: h.material || '', seconds: h.seconds === undefined ? null : h.seconds, result: h.result, startedAt: h.startedAt || null, finishedAt: h.finishedAt }));
    const mw = st.markWait;
    return {
      id: info.id, name: info.name, type: info.type, ctrl: info.ctrl, model: info.model, app: info.app,
      link: st.link === 'online' || st.link === 'connecting' ? st.link : 'offline',
      state: st.state, since: iso(t.since), message: st.message || '',
      interlock: !!st.interlock, interlockSince: st.interlock ? iso(t.interlockSince) : null,
      markWait: mw ? { mark: mw.mark, of: mw.of, since: iso(t.markSince) } : null,
      job, queue, today
    };
  }

  // ---- watching: the times things began, and the event stream
  const clients = new Set();
  let lastKey = '', lastSent = 0, todayIds = null;
  const send = (res, event, data) => { try { res.write((event ? 'event: ' + event + '\n' : '') + 'data: ' + JSON.stringify(data) + '\n\n'); } catch (e) { clients.delete(res); } };
  function tick() {
    const st = machine.st, now = Date.now();
    let changed = false;
    if (st.state !== t.state) { t.state = st.state; t.since = now; changed = true; }
    if (!!st.interlock !== t.interlock) { t.interlock = !!st.interlock; t.interlockSince = t.interlock ? now : null; changed = true; }
    const mk = st.markWait ? st.job + ':' + st.markWait.mark + ':' + (st.markWait.again ? 1 : 0) : null;
    if (mk !== t.markKey) { t.markKey = mk; t.markSince = mk ? now : null; }
    if (changed) save();
    if (!clients.size) { todayIds = null; return; }
    const v = view();
    // a job finished: its own event, once
    const ids = new Set(v.today.map((x) => x.id + '@' + x.finishedAt));
    if (todayIds) for (const x of v.today) if (!todayIds.has(x.id + '@' + x.finishedAt)) for (const c of clients) send(c, 'finished', x);
    todayIds = ids;
    // the whole answer when something in it changed (the running clock alone at most once a second)
    const key = JSON.stringify({ ...v, job: v.job ? { ...v.job, elapsed: 0, remaining: 0 } : null });
    if (key !== lastKey || (v.job && now - lastSent >= 1000)) {
      lastKey = key; lastSent = now;
      for (const c of clients) send(c, null, v);
    }
  }
  const timer = setInterval(tick, 250);
  if (timer.unref) timer.unref();
  const keepAlive = setInterval(() => { for (const c of clients) { try { c.write(': still here\n\n'); } catch (e) { clients.delete(c); } } }, 25000);
  if (keepAlive.unref) keepAlive.unref();

  // GET /api/v1/events: the answer now, then again as it changes
  function stream(req, res) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 2000\n\n');
    clients.add(res);
    if (!todayIds) todayIds = new Set(view().today.map((x) => x.id + '@' + x.finishedAt));
    send(res, null, view());
    req.on('close', () => clients.delete(res));
  }

  return { view, stream, tick, close: () => { clearInterval(timer); clearInterval(keepAlive); for (const c of clients) { try { c.end(); } catch (e) { /* closed */ } } clients.clear(); } };
}

module.exports = { createMonitor };

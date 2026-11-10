// Pathline Run HMI screen. Plain JS, no build step: renders the views from the
// design (hmi/project/HMI.dc.html) from /api/local/state, polled.
'use strict';

const $app = document.getElementById('app');
const API = (p) => '/api/v1' + p;
const LOCAL = (p) => '/api/local' + p;

const ICON = {
  menu: 'M4 7h16 M4 12h16 M4 17h16',
  sun: 'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8z M12 2v2 M12 20v2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M2 12h2 M20 12h2 M4.9 19.1l1.4-1.4 M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
  queue: 'M4 5h16v5H4z M4 14h16v5H4z',
  jog: 'M12 3v18 M3 12h18 M12 3l-3 3 M12 3l3 3 M12 21l-3-3 M12 21l3-3 M3 12l3-3 M3 12l3 3 M21 12l-3-3 M21 12l-3 3',
  history: 'M12 7v5l3 2 M3.5 12a8.5 8.5 0 1 0 2.5-6 M3 4v4h4',
  gear: 'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z M12 2v3 M12 19v3 M4.9 4.9l2.1 2.1 M17 17l2.1 2.1 M2 12h3 M19 12h3 M4.9 19.1L7 17 M17 7l2.1-2.1',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13',
  play: 'M7 4.5v15l12.5-7.5z', pause: 'M8 5v14 M16 5v14', stop: 'M6 6h12v12H6z',
  frame: 'M4 9V4h5 M15 4h5v5 M20 15v5h-5 M9 20H4v-5',
  up: 'M12 19V5 M6 11l6-6 6 6', down: 'M12 5v14 M6 13l6 6 6-6', left: 'M19 12H5 M11 6l-6 6 6 6', right: 'M5 12h14 M13 6l6 6-6 6',
  home: 'M4 11l8-7 8 7 M6 9.5V20h12V9.5', upload: 'M12 15V3 M7 8l5-5 5 5 M4 20h16', download: 'M12 3v12 M7 10l5 5 5-5 M4 20h16',
  file: 'M6 3h8l4 4v14H6z M14 3v4h4', chevUp: 'M6 15l6-6 6 6', chevDown: 'M6 9l6 6 6-6',
  anchor: 'M12 3v4 M12 17v4 M3 12h4 M17 12h4 M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8z'
};
const ACI = { 1: '#FF0000', 2: '#FFFF00', 3: '#00FF00', 4: '#00FFFF', 5: '#0000FF', 6: '#FF00FF', 7: null, 8: '#808080', 9: '#C0C0C0' };
const aciHex = (n) => (n in ACI ? ACI[n] : 'hsl(' + ((n * 47) % 360) + ' 70% 45%)');
const aciFg = (n) => ([2, 3, 4, 9].includes(n) ? '#15181E' : '#FFFFFF');

const ui = {
  view: 'queue', sel: null, dark: matchMedia('(prefers-color-scheme: dark)').matches, themeSet: false,
  step: '10', navOpen: false, dlg: null, toast: null, setTab: 'Machine', draft: null, ports: [], pkgs: {}, histFilter: 'All',
  trail: { job: null, pts: [] }, net: null, netDraft: null, zoom: { k: 1, cx: NaN, cy: NaN },
  multi: false, picked: [] // Queue → Select: the ticked jobs
};
try { const t = localStorage.getItem('plr-theme'); if (t) { ui.dark = t === 'dark'; ui.themeSet = true; } } catch (e) { /* private mode */ }
let S = null; // last /api/local/state

const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (d, size) => '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"' + (size ? ' style="width:' + size + 'px;height:' + size + 'px"' : '') + '><path d="' + d + '"></path></svg>';
const hms = (sec) => { const v = Math.max(0, Math.round(sec || 0)); const p = (n) => String(n).padStart(2, '0'); return p(Math.floor(v / 3600)) + ':' + p(Math.floor((v % 3600) / 60)) + ':' + p(v % 60); };
const short = (sec) => { const v = Math.round(sec || 0); return Math.floor(v / 60) + ' min ' + String(v % 60).padStart(2, '0') + ' s'; };
const stamp = (iso) => { if (!iso) return ''; const d = new Date(iso); const p = (n) => String(n).padStart(2, '0'); return p(d.getDate()) + '/' + p(d.getMonth() + 1) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); };

async function call(method, url, body) {
  const r = await fetch(url, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || r.status + ' ' + r.statusText), data.detail ? { detail: data.detail } : {});
  return data;
}
// opts: { action: button label, onAction: handler name in H, ms }
function toast(msg, opts = {}) {
  ui.toast = { msg, action: opts.action, onAction: opts.onAction };
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { ui.toast = null; render(); }, opts.ms || 4500);
  render();
}
const act = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } await refresh(); };

// ---------------------------------------------------------------- data
async function refresh() {
  try {
    const next = await call('GET', LOCAL('/state'));
    // a new version is running: load its screen
    if (S && next.app !== S.app) { location.reload(); return; }
    // first look and no machine yet: open Setup to add one
    if (!S && !next.config.configured) { ui.view = 'setup'; setTimeout(() => { loadPorts(); loadNetwork(); }, 0); }
    // settings changed underneath an untouched Setup page (e.g. filled in from the controller):
    // show the new ones rather than calling them unsaved changes
    if (S && ui.draft && JSON.stringify(ui.draft) === JSON.stringify(S.config) && JSON.stringify(next.config) !== JSON.stringify(S.config)) ui.draft = null;
    S = next;
    S.offline = false;
    // a job anchored (at Start) or put back (after its run): show it where it now sits
    for (const j of S.jobs) {
      const p = ui.pkgs[j.id];
      if (p && p !== 'loading' && JSON.stringify(j.anchor ? [j.anchor.x, j.anchor.y] : null) !== JSON.stringify(p.anchor ? [p.anchor.x, p.anchor.y] : null)) delete ui.pkgs[j.id];
    }
    followUpdate(S.update);
    // trace the head while a job runs (a new job starts a new trace)
    const st = S.status;
    // print and cut: once the marks are read the job is moved onto them; show and follow it there
    if (st.job) { const p = ui.pkgs[st.job]; if (p && p !== 'loading' && (p.placed || null) !== (st.placed || null)) { delete ui.pkgs[st.job]; follow.job = null; } }
    if (st.job !== ui.trail.job) ui.trail = { job: st.job, pts: [] }; // a new job, or none: start again
    if (st.job && Number.isFinite(st.pos.x)) {
      const last = ui.trail.pts[ui.trail.pts.length - 1];
      if (!last || Math.hypot(last[0] - st.pos.x, last[1] - st.pos.y) > 0.5) ui.trail.pts.push([st.pos.x, st.pos.y]);
      if (ui.trail.pts.length > 4000) ui.trail.pts.splice(0, 1000);
    }
    // and along the job's own paths (its package is needed for that, shown or not)
    if (st.job && !ui.pkgs[st.job]) { const id = st.job; ui.pkgs[id] = 'loading'; call('GET', LOCAL('/jobs/' + id + '/package')).then((p) => { ui.pkgs[id] = p; }).catch(() => { delete ui.pkgs[id]; }); }
    followHead(st, ui.pkgs[st.job]);
    // print and cut: a mark wasn't found. Open Jog with the camera picture on, once for each mark
    // (the user may go elsewhere and come back)
    const mw = st.markWait;
    const key = mw ? st.job + ':' + mw.mark : null;
    if (key && key !== ui.markShown) { ui.view = 'jog'; ui.live = true; ui.camErr = null; ui.navOpen = false; }
    ui.markShown = key;
  } catch (e) { if (S) S.offline = true; }
  const queue = visibleQueue();
  if (!queue.some((j) => j.id === ui.sel)) {
    const run = queue.find((j) => j.status === 'running');
    ui.sel = run ? run.id : queue[0] ? queue[0].id : null;
  }
  if (ui.sel && !ui.pkgs[ui.sel]) {
    ui.pkgs[ui.sel] = 'loading';
    call('GET', LOCAL('/jobs/' + ui.sel + '/package')).then((p) => { ui.pkgs[ui.sel] = p; render(); }).catch(() => { delete ui.pkgs[ui.sel]; });
  }
  render();
}
// the queue: queued and running jobs, and with "Remove completed job from queue" off, completed
// ones too (Start runs one again). The server already leaves out the ones it removed.
const visibleQueue = () => (S ? S.jobs.filter((j) => j.status === 'queued' || j.status === 'running' || (j.status === 'done' && !S.config.removeDone)) : []);
const cfg = () => S.config;
const running = () => S && (S.status.state === 'running' || S.status.state === 'paused');

// ---------------------------------------------------------------- the running job, followed along its paths
// The head's position comes every 0.7 s; in between it may cut several shapes, so joining the
// positions drew lines straight across the job. Instead the job's toolpath is laid out as one route
// (travel to each step's start, then along it, each step taking Pathline's estimate spread by length),
// every reported position is placed on the route (only ahead of the last one and not far ahead in
// time, so a path crossing another can't pull it back or on), what's been run is drawn along the
// job's own lines, and between reports the head moves on along the route (at most 1.5 s ahead).
// Positions that don't fit the route (a job moved onto registration marks, say) go back to the trace.
// rate: route seconds per real second, learnt as it runs (the machine needn't match the estimate);
// at: when the head was at t (the report's own time, not when it reached the screen); shown: where
// the head is drawn (it eases towards the prediction and never goes back, bar a big correction)
const follow = { job: null, route: null, k: 0, t: 0, at: 0, miss: 0, doneK: -1, rate: 1, found: false, shown: { t: null, at: 0 } };

// rest-to-rest time over d mm at speed v, acceleration a, jerk j (as src/ctrl/trotec/motion.js)
function moveTime(d, v, a, j) {
  if (!(d > 0)) return 0;
  const ramp = (u) => { const t = u <= (a * a) / j ? 2 * Math.sqrt(u / j) : u / a + a / j; return { t, s: (u * t) / 2 }; };
  const top = ramp(v);
  if (2 * top.s <= d) return 2 * top.t + (d - 2 * top.s) / v;
  let lo = 0, hi = v;
  for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2; if (2 * ramp(m).s > d) hi = m; else lo = m; }
  return 2 * ramp(lo).t;
}

// Seconds along each segment of a cut polyline at speed v, as the Trotec moves it (prof from the
// server, as compile.js's estimate): slower round curves (a bend of up to 16° between segments
// is part of a curve, of radius ≈ segment ÷ bend) and corners, accelerating at prof.acc, from a
// stop and to a stop. Timing cuts as length ÷ speed put J0053 (400 mm/s, small shapes) 60 s
// ahead of the head.
function polyTimes(pts, v, prof) {
  const n = pts.length, L = [], dir = [];
  for (let k = 1; k < n; k++) { L.push(Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1])); dir.push(Math.atan2(pts[k][1] - pts[k - 1][1], pts[k][0] - pts[k - 1][0])); }
  const vj = new Array(n).fill(v);
  vj[0] = 0; vj[n - 1] = 0;
  for (let k = 1; k < n - 1; k++) {
    let th = Math.abs(dir[k] - dir[k - 1]) % (2 * Math.PI);
    if (th > Math.PI) th = 2 * Math.PI - th;
    if (th < 1e-3) continue;
    const sh = Math.sin(th / 2);
    const lim = th <= (16 * Math.PI) / 180 ? Math.sqrt((prof.arc * Math.min(L[k], L[k - 1])) / th) : sh >= 0.9999 ? 0 : Math.sqrt((prof.corner * sh) / (1 - sh));
    vj[k] = Math.min(v, lim);
  }
  const a = prof.acc;
  for (let k = 0; k < n - 1; k++) vj[k + 1] = Math.min(vj[k + 1], Math.sqrt(vj[k] ** 2 + 2 * a * L[k]));
  for (let k = n - 2; k >= 0; k--) vj[k] = Math.min(vj[k], Math.sqrt(vj[k + 1] ** 2 + 2 * a * L[k]));
  return L.map((l, k) => {
    const u0 = vj[k], u1 = vj[k + 1];
    const pk = Math.max(1e-6, Math.min(v, Math.sqrt((2 * a * l + u0 * u0 + u1 * u1) / 2)));
    const s1 = (pk * pk - u0 * u0) / (2 * a), s2 = (pk * pk - u1 * u1) / (2 * a);
    return (pk - u0) / a + (pk - u1) / a + Math.max(0, l - s1 - s2) / pk;
  });
}

// The Trotec's route timing for drawing the head, fitted to where the head really was: every
// report of J0040–J0065 replayed through this code as the screen sees them (a refresh every
// 0.7 s), with the head drawn between reports. Travel between cuts is quicker than the planner
// limits say, and curves and corners slower than the estimate's model, which is fitted to whole
// parts only (it gets each part's time right, not how it's split). With these the head drawn
// is 2.1 mm from the real head (median; 7.7 mm for 9 in 10), was 2.7 and 10.6 mm. On runs left
// out of the fit: 2.3 and 8.0 mm, was 3.2 and 11.2 mm.
const FOLLOW_TROTEC = { travel: { a: 2000, j: 50000, v: 1000 }, cut: { arc: 500, corner: 5, acc: 300 } };

function routeOf(pkg) {
  // travel as the machine moves it (a Trotec: as fitted above; a plain speed if there are no limits)
  const M = S.motion ? (S.motion.cut ? { ...S.motion, ...FOLLOW_TROTEC.travel, cut: FOLLOW_TROTEC.cut } : S.motion) : { v: Number((cfg().trotec || {}).travelSpeed) || 500, a: 5000, j: 1e6 };
  const segs = [];
  let t = 0, cur = null;
  const add = (a, b, dt, kind, step) => { segs.push({ a, b, t0: t, dt: Math.max(dt, 1e-3), kind, step }); t += Math.max(dt, 1e-3); };
  const go = (p, step) => { if (cur && Math.hypot(p[0] - cur[0], p[1] - cur[1]) > 0.01) add(cur, p, moveTime(Math.hypot(p[0] - cur[0], p[1] - cur[1]), M.v, M.a, M.j), 'travel', step); cur = p; };
  (pkg.toolpath || []).forEach((s, i) => {
    let pts = null, kind = 'cut';
    if (Array.isArray(s.p) && s.p.length > 1) pts = s.closed ? s.p.concat([s.p[0]]) : s.p;
    else if (s.type === 'engrave' && Array.isArray(s.box) && s.box.length === 4) {
      // the scan lines (at most 200 of them here: enough to follow and draw)
      const [x0, y0, x1, y1] = s.box, n = Math.max(1, Math.min(200, s.lines || 20)), up = s.direction === 'up';
      pts = [];
      for (let r = 0; r < n; r++) {
        const y = up ? y1 - ((y1 - y0) * (r + 0.5)) / n : y0 + ((y1 - y0) * (r + 0.5)) / n;
        const back = s.bidirectional !== false && r % 2;
        pts.push(back ? [x1, y] : [x0, y], back ? [x0, y] : [x1, y]);
      }
      kind = 'row';
    }
    if (!pts) { if (s.seconds) add(cur || [0, 0], cur || [0, 0], s.seconds, 'wait', i); return; }
    go(pts[0], i);
    const proc = (pkg.processes || []).find((p) => p.index === s.process) || {};
    let len = 0;
    for (let k = 1; k < pts.length; k++) len += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    // a Trotec cut as it moves it (set speed on straights, slower round curves and corners); other
    // cuts at their set speed (Pathline's own time ran ~15 % long), engraving at Pathline's time
    const speed = Math.min(Number(proc.speed) || 0, Number((cfg().trotec || {}).maxSpeed) || Infinity);
    if (kind === 'cut' && speed > 0 && M.cut) {
      const dts = polyTimes(pts, speed, M.cut);
      for (let k = 1; k < pts.length; k++) add(pts[k - 1], pts[k], dts[k - 1], kind, i);
      cur = pts[pts.length - 1];
      return;
    }
    const secs = kind === 'cut' && speed > 0 ? len / speed : s.seconds || len / (Number(proc.speed) || 20);
    for (let k = 1; k < pts.length; k++) {
      // engraving: the beam is on along a row, the step between rows is part of the scan
      const dl = Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
      add(pts[k - 1], pts[k], len ? (secs * dl) / len : 0, kind === 'row' && k % 2 === 0 ? 'step' : kind, i);
    }
    cur = pts[pts.length - 1];
  });
  return { segs, end: t };
}

// where the route is at time t (s): segment index and point
function routeAt(route, t) {
  const s = route.segs;
  let lo = 0, hi = s.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (s[m].t0 <= t) lo = m; else hi = m - 1; }
  const g = s[lo], u = Math.max(0, Math.min(1, (t - g.t0) / g.dt));
  return { k: lo, p: [g.a[0] + (g.b[0] - g.a[0]) * u, g.a[1] + (g.b[1] - g.a[1]) * u] };
}

// a reported head position: placed on the route, ahead of the last place and within reach in time
function followHead(st, pkg) {
  if (!st.job || !pkg || pkg === 'loading' || !Number.isFinite(st.pos.x)) { follow.job = null; return; }
  // when the head was there: the server says how old its position is (it polls the controller,
  // the screen polls the server: together over a second at times). The same position again (no
  // newer one from the controller) is no news: taking it as now made the head snap back
  const now = performance.now() - Math.max(0, Number(st.posAge) || 0);
  if (follow.job !== st.job) Object.assign(follow, { job: st.job, route: routeOf(pkg), k: 0, t: 0, at: now, miss: 0, doneK: -1, rate: 1, found: false, shown: { t: null, at: 0 }, last: null });
  const R = follow.route;
  if (!R.segs.length) return;
  const P = [st.pos.x, st.pos.y];
  if (follow.last && follow.last.x === P[0] && follow.last.y === P[1] && Math.abs(follow.last.at - now) < 400) return;
  follow.last = { x: P[0], y: P[1], at: now };
  // The first time (the screen opened mid-job), or lost for a few reports: anywhere on the route
  // the controller's progress allows (the head waiting where the last run ended can also be where
  // this one ends: the same job again), nearest that progress. Otherwise a few seconds ahead at the
  // pace learnt.
  const wide = !follow.found || follow.miss >= 3;
  // (the progress follows the job closely now: within 10 % of the job, at least 5 s, of it. With
  // 30 % and 15 s, J0043's first report was placed 15 s on)
  const hint = (Number(st.progress) || 0) * R.end, tol = Math.max(5, 0.1 * R.end);
  const from = wide ? 0 : follow.k;
  const reach = wide ? hint + tol : follow.t + 3 + (2 * Math.max(1, follow.rate) * (now - follow.at)) / 1000;
  let best = null;
  for (let k = from; k < R.segs.length && R.segs[k].t0 <= reach; k++) {
    const g = R.segs[k], dx = g.b[0] - g.a[0], dy = g.b[1] - g.a[1], L2 = dx * dx + dy * dy;
    let u = L2 ? ((P[0] - g.a[0]) * dx + (P[1] - g.a[1]) * dy) / L2 : 0;
    u = Math.max(!wide && k === follow.k ? Math.min(1, (follow.t - g.t0) / g.dt) : 0, Math.min(1, u));
    const d = Math.hypot(g.a[0] + dx * u - P[0], g.a[1] + dy * u - P[1]), t = g.t0 + u * g.dt;
    if (wide && Math.abs(t - hint) > tol) continue;
    // (searching wide, of the places that fit, the one nearest the progress reported: a second of
    // the job away counts as a mm off. At 0.01 mm a second, the first report, on the way to the
    // first cut, was put 15 s on where the path passes close by: the head drawn 40–50 mm off for 3 s)
    const score = wide ? d + Math.abs(t - hint) : d;
    if (d < 4 && (!best || score < best.score - 0.01)) best = { k, t, d, score };
  }
  if (best) {
    // the head moves on from here at the route's own pace (rate 1). A pace learnt from the fixes
    // (smoothed, or from the last two in one part) drew it further off: with the route timed as
    // the machine moves, the pace between fixes is mostly the fixes' own scatter
    Object.assign(follow, { k: best.k, t: best.t, at: now, miss: 0, found: true, rate: 1 });
  } else follow.miss++;
}

// following this package's run (its route fits the reported positions)?
const following = (pkg) => !!(follow.job && follow.route && follow.found && S && S.status.job === follow.job && pkg && pkg !== 'loading' && follow.miss < 6 && ui.pkgs[follow.job] === pkg);

// the head as drawn now: the prediction (on from the last place at the pace learnt, not while
// paused, never more than 2 s on), eased into over a quarter second and never backwards, so a
// report a little behind the drawing doesn't pull it back; a big difference (more than 2 s of
// the job behind, 5 s ahead) is jumped to
// Only a correction is eased (a new report moving the prediction): the gap it opens closes over
// ~0.2 s while the head moves on at the prediction's pace. Easing towards the prediction itself
// kept the drawing ~0.2 s (6–8 mm) behind the head the whole job (J0043, 9 Nov).
function predicted() {
  const now = performance.now();
  const ahead = S.status.state === 'running' ? Math.min(2, (now - follow.at) / 1000) * follow.rate : 0;
  const target = Math.min(follow.route.end, follow.t + ahead);
  const sh = follow.shown;
  if (sh.t === null || target < sh.t - 2 || target > sh.t + 5) { sh.t = target; sh.gap = 0; }
  else {
    // a new report: carry on from where the drawing is (no jump), then close the gap
    let gap = sh.fix !== follow.at ? sh.t - target : sh.gap || 0;
    gap *= Math.exp(-Math.max(0, now - (sh.at || now)) / 200);
    sh.t = Math.max(sh.t, target + gap); // never backwards
    sh.gap = sh.t - target;
  }
  sh.fix = follow.at;
  sh.at = now;
  return routeAt(follow.route, sh.t);
}

// what's been run: the cut and engraved parts of the route up to segment k (and point p on it)
function doneD(k0, k1, p) {
  let d = '';
  const segs = follow.route.segs;
  for (let k = k0; k <= k1 && k < segs.length; k++) {
    const g = segs[k];
    if (g.kind === 'travel' || g.kind === 'wait' || g.kind === 'step') continue;
    const b = k === k1 && p ? p : g.b;
    d += 'M' + g.a[0].toFixed(2) + ' ' + g.a[1].toFixed(2) + 'L' + b[0].toFixed(2) + ' ' + b[1].toFixed(2);
  }
  return d;
}

// The running job's time left, counting down a second a second: from the server's figure (the
// estimate × progress left) it moved in uneven steps with each refresh, and stood still while a
// long part was cut. The count runs on its own, kept within 2 s of the server's figure; it stops
// while the job is paused or its marks are read (no progress yet)
function remaining() {
  const st = S.status;
  const job = S.jobs.find((j) => j.id === st.job);
  if (!job) return 0;
  const server = (job.seconds || 0) * (1 - (Number(st.progress) || 0));
  const now = performance.now();
  const r = ui.remain;
  if (!r || r.job !== st.job || r.total !== job.seconds) { ui.remain = { job: st.job, total: job.seconds, v: server, at: now }; return server; }
  const moving = st.state === 'running' && st.progress > 0;
  let v = r.v - (moving ? (now - r.at) / 1000 : 0);
  v = Math.max(0, Math.min(server + 2, Math.max(server - 2, v)));
  Object.assign(r, { v, at: now });
  return v;
}
setInterval(() => {
  if (!S || !running() || ui.view !== 'queue') return;
  const el = document.getElementById('remain');
  if (el) { const t = hms(remaining()); if (el.textContent !== t) el.textContent = t; }
}, 250);

// between redraws: the head, its crosshair and the run so far move on (about 30 times a second)
let lastFrame = 0;
function followFrame(ts) {
  requestAnimationFrame(followFrame);
  if (ts - lastFrame < 33 || !S || ui.view !== 'queue') return;
  lastFrame = ts;
  const svg = document.getElementById('bedview');
  if (!svg || svg.dataset.follow !== follow.job || !following(ui.pkgs[follow.job])) return;
  const { k, p } = predicted();
  const step = follow.route.segs[k].step;
  let first = k;
  while (first > 0 && follow.route.segs[first - 1].step === step) first--;
  const set = (id, attrs) => { const el = document.getElementById(id); if (el) for (const a in attrs) el.setAttribute(a, attrs[a]); };
  if (follow.doneK !== first) { set('run-done', { d: doneD(0, first - 1) }); follow.doneK = first; }
  set('run-now', { d: doneD(first, k, p) });
  set('head-vx', { x1: p[0], x2: p[0] }); set('head-hy', { y1: p[1], y2: p[1] });
  set('head-ring', { cx: p[0], cy: p[1] }); set('head-dot', { cx: p[0], cy: p[1] });
}
requestAnimationFrame(followFrame);

// ---------------------------------------------------------------- drawing
// A job's artwork, drawn once. The screen is redrawn every 0.7 s; the X28 sheet's 1325 paths
// (34 000 points) made each redraw 2.3 MB of markup (bed view and its two thumbnails), 60–100 ms
// of script before any layout, and clicks landed on parts that had just been replaced. The
// artwork goes in as an empty <g data-art>, and render() moves the shapes already drawn across
// into it (artFill), so only what changes is rebuilt
const art = { ids: new WeakMap(), html: new Map(), n: 0 };
function artSlot(pkg, big) {
  let id = art.ids.get(pkg);
  if (!id) { id = 'a' + ++art.n; art.ids.set(pkg, id); }
  const [W] = cfg().bed;
  const key = id + (big ? 'b' : 's') + (ui.dark ? 'd' : 'l') + W;
  if (!art.html.has(key)) {
    let s = '';
    const sw = W / (big ? 500 : 260);
    for (const e of pkg.entities || []) {
      const col = aciHex(e.aci);
      for (const p of e.paths || []) {
        const d = 'M' + p.p.map((q) => q[0].toFixed(2) + ' ' + q[1].toFixed(2)).join('L') + (p.c ? 'Z' : '');
        s += '<path d="' + d + '" fill="none" ' + (col ? 'stroke="' + col + '"' : 'class="ink"') + ' stroke-width="' + sw + '" vector-effect="non-scaling-stroke" style="stroke-width:' + (big ? 1.5 : 1) + 'px"/>';
      }
    }
    art.html.set(key, s);
    // (the last few jobs' only)
    while (art.html.size > 24) art.html.delete(art.html.keys().next().value);
  }
  return '<g data-art="' + key + '"></g>';
}
// after the screen's markup is replaced: the artwork drawn last time into its places again (the
// same nodes, not parsed afresh), new artwork drawn once
function artFill(old) {
  for (const g of $app.querySelectorAll('g[data-art]')) {
    const k = g.dataset.art;
    const prev = old.get(k);
    if (prev && prev.length) g.replaceWith(prev.shift());
    else g.innerHTML = art.html.get(k) || '';
  }
}
// a job's thumbnail as a picture: drawn once, then cached by the browser. As live drawing, the
// two X8/X28 thumbnails alone (1325 paths each) were laid out again at every redraw
const thumbs = new Map();
function thumbImg(pkg) {
  const [W, H] = cfg().bed;
  const key = artSlot(pkg, false).match(/data-art="([^"]+)"/)[1];
  let url = thumbs.get(key);
  if (!url) {
    const cs = getComputedStyle($app);
    const v = (n, d) => (cs.getPropertyValue(n) || '').trim() || d;
    const sh = pkg.sheet;
    const sheet = sh ? '<rect x="' + sh.x + '" y="' + sh.y + '" width="' + sh.w + '" height="' + sh.h + '" fill="' + v('--sheet', '#FBFBFC') + '" stroke="' + v('--bed-line', '#CDD2D9') + '" stroke-width="' + W / 600 + '"/>' : '';
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet"><style>.ink{stroke:' + v('--text', '#111') + '}</style>' + sheet + art.html.get(key) + '</svg>';
    url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    thumbs.set(key, url);
    while (thumbs.size > 24) { const k = thumbs.keys().next().value; URL.revokeObjectURL(thumbs.get(k)); thumbs.delete(k); }
  }
  return '<img class="bedsvg" src="' + url + '" alt="" draggable="false" style="aspect-ratio:' + W + '/' + H + '">';
}
function bedSvg(pkg, opts = {}) {
  const [W, H] = cfg().bed;
  if (!opts.head && pkg && pkg !== 'loading') return thumbImg(pkg);
  let body = '';
  if (pkg && pkg !== 'loading') {
    if (pkg.sheet) body += '<rect x="' + pkg.sheet.x + '" y="' + pkg.sheet.y + '" width="' + pkg.sheet.w + '" height="' + pkg.sheet.h + '" fill="var(--sheet)" stroke="var(--bed-line)" stroke-width="' + W / 600 + '"/>';
    body += artSlot(pkg, !!opts.big);
  }
  // zoomed in, the head ring and markers keep their size on screen
  const r = Math.max(W, H) / 70 / (opts.head ? ui.zoom.k : 1);
  // where an anchored job's top-left corner was pinned (green, as in the design)
  // (pkg is 'loading' while it's fetched: a string, whose old .anchor() method is always there)
  if (opts.big && pkg && pkg !== 'loading' && pkg.anchor) {
    body += '<circle cx="' + pkg.anchor.x + '" cy="' + pkg.anchor.y + '" r="' + r * 0.6 + '" fill="var(--bed)" stroke="var(--ok-dot)" stroke-width="' + r / 4 + '"/>';
  }
  // print and cut: where the camera found the registration marks (green rings)
  if (opts.head && Array.isArray(S.status.marks)) {
    for (const m of S.status.marks) body += '<circle cx="' + m[0] + '" cy="' + m[1] + '" r="' + r * 0.7 + '" fill="none" stroke="var(--ok-dot)" vector-effect="non-scaling-stroke" style="stroke-width:2px"/><circle cx="' + m[0] + '" cy="' + m[1] + '" r="' + r * 0.12 + '" fill="var(--ok-dot)"/>';
  }
  // what's been run of this job: along its own paths while the head can be followed on them,
  // else the trace of where the head has been
  const along = opts.head && following(pkg);
  let at = null;
  if (along) {
    const pr = predicted();
    at = pr.p;
    let first = pr.k;
    while (first > 0 && follow.route.segs[first - 1].step === follow.route.segs[pr.k].step) first--;
    follow.doneK = first;
    const line = (id, d) => '<path id="' + id + '" d="' + d + '" fill="none" stroke="var(--ink)" vector-effect="non-scaling-stroke" style="stroke-width:2.5px" stroke-linecap="round"/>';
    body += line('run-done', doneD(0, first - 1)) + line('run-now', doneD(first, pr.k, pr.p));
  } else if (opts.head && ui.trail.pts.length > 1) {
    body += '<polyline points="' + ui.trail.pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ') + '" fill="none" stroke="var(--ink)" stroke-opacity="0.45" vector-effect="non-scaling-stroke" style="stroke-width:1.5px" stroke-linejoin="round"/>';
  }
  // the toolhead: crosshair across the bed and a ring at its position (only when it's known;
  // followed along the job, where it's predicted to be now)
  if (opts.head && Number.isFinite(S.status.pos.x) && S.status.link === 'online') {
    const [x, y] = at || [S.status.pos.x, S.status.pos.y];
    body += '<line id="head-vx" x1="' + x + '" y1="0" x2="' + x + '" y2="' + H + '" stroke="var(--ink)" stroke-opacity="0.35" vector-effect="non-scaling-stroke" stroke-dasharray="4 4" style="stroke-width:1px"/>' +
      '<line id="head-hy" x1="0" y1="' + y + '" x2="' + W + '" y2="' + y + '" stroke="var(--ink)" stroke-opacity="0.35" vector-effect="non-scaling-stroke" stroke-dasharray="4 4" style="stroke-width:1px"/>' +
      '<circle id="head-ring" cx="' + x + '" cy="' + y + '" r="' + r + '" fill="var(--accent-ring)" stroke="var(--ink)" stroke-width="' + r / 4 + '"/><circle id="head-dot" cx="' + x + '" cy="' + y + '" r="' + r / 4 + '" fill="var(--ink)"/>';
  }
  if (!opts.head) return '<svg class="bedsvg" viewBox="0 0 ' + W + ' ' + H + '" style="aspect-ratio:' + W + '/' + H + '" preserveAspectRatio="xMidYMid meet" aria-hidden="true">' + body + '</svg>';
  // with the head shown: the whole viewport, zoomed and panned (bedViewBox)
  return '<svg id="bedview"' + (along ? ' data-follow="' + esc(follow.job) + '"' : '') + ' viewBox="' + bedViewBox().join(' ') + '" style="display:block;width:100%;height:100%;touch-action:none;cursor:grab" preserveAspectRatio="xMidYMid meet" aria-hidden="true">' +
    '<rect x="0" y="0" width="' + W + '" height="' + H + '" rx="' + (W / 200).toFixed(2) + '" fill="var(--bed)" stroke="var(--bed-line)" vector-effect="non-scaling-stroke" style="stroke-width:1px"/>' + body + '</svg>';
}

// ---------------------------------------------------------------- bed view: zoom and pan
// ui.zoom: k (1 = whole bed) and the centre (bed mm) of what's shown. Wheel or pinch to
// zoom, drag to pan, the +/−/Fit buttons, or double-click to fit again.
function bedViewBox() {
  const [W, H] = cfg().bed;
  // at 1×, a margin round the bed so the whole head ring shows at the edges and corners
  const m = (Math.max(W, H) / 70) * 1.4;
  const z = ui.zoom;
  const w = (W + 2 * m) / z.k, h = (H + 2 * m) / z.k;
  const cx = z.k === 1 || !Number.isFinite(z.cx) ? W / 2 : z.cx, cy = z.k === 1 || !Number.isFinite(z.cy) ? H / 2 : z.cy;
  return [cx - w / 2, cy - h / 2, w, h].map((v) => +v.toFixed(2));
}
function zoomBed(f, at) {
  const [W, H] = cfg().bed;
  const z = ui.zoom;
  const k = Math.max(1, Math.min(40, z.k * f));
  const vb = bedViewBox();
  const c = [vb[0] + vb[2] / 2, vb[1] + vb[3] / 2];
  const p = at || c;
  const g = k / z.k;
  // the point under the pointer stays put
  z.cx = Math.max(0, Math.min(W, p[0] + (c[0] - p[0]) / g));
  z.cy = Math.max(0, Math.min(H, p[1] + (c[1] - p[1]) / g));
  z.k = k;
  applyBedView();
}
// moves the viewport without redrawing the page (smooth while dragging)
function applyBedView() {
  const svg = document.getElementById('bedview');
  if (!svg) return;
  svg.setAttribute('viewBox', bedViewBox().join(' '));
  const pct = document.getElementById('bedzoom');
  if (pct) pct.textContent = Math.round(ui.zoom.k * 100) + ' %';
  clearTimeout(applyBedView.t);
  applyBedView.t = setTimeout(render, 250); // then redraw, so the head ring keeps its size
}
// screen point → bed mm
function bedPoint(svg, e) {
  const m = svg.getScreenCTM();
  if (!m) return null;
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
  return [p.x, p.y];
}
function bedTools() {
  return '<div style="position:absolute;right:10px;bottom:10px;display:flex;align-items:center;gap:2px;padding:3px;border-radius:10px;background:var(--surface);box-shadow:var(--shadow-1)">' +
    '<button class="ib" data-a="zoomOut" aria-label="Zoom out" style="width:38px;height:38px;font-size:20px">−</button>' +
    '<span id="bedzoom" class="mono lbl" style="min-width:48px;text-align:center">' + Math.round(ui.zoom.k * 100) + ' %</span>' +
    '<button class="ib" data-a="zoomIn" aria-label="Zoom in" style="width:38px;height:38px;font-size:20px">+</button>' +
    '<button class="tb sm" data-a="zoomFit" style="height:38px">Fit</button></div>';
}

function jobBox(pkg) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const s of (pkg && pkg.toolpath) || []) {
    const pts = s.p || (s.box ? [[s.box[0], s.box[1]], [s.box[2], s.box[3]]] : []);
    for (const [x, y] of pts) { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); }
  }
  return Number.isFinite(b[0]) ? b : null;
}

// ---------------------------------------------------------------- header
// The machine's status, shown top right:
// orange = a warning or error that needs attention (flagged), red = not connected,
// blue = processing, green = connected and ready
const STATUS_COLOR = { warn: 'var(--warn-dot)', off: 'var(--err-dot)', busy: 'var(--accent)', ok: 'var(--ok-dot)' };
function machineStatus() {
  if (!S || S.offline) return { key: 'off', label: 'Pathline Run isn\'t responding', detail: 'The screen lost contact with Pathline Run.' };
  const st = S.status;
  if (!S.config.configured) return { key: 'off', label: 'No machine set up', detail: 'Add the machine Pathline Run controls: Setup → Add machine.', action: ['go', 'Set up a machine', 'setup'] };
  if (st.state === 'alarm') return { key: 'warn', flag: true, label: 'Error', detail: st.message, action: ['clearAlarm', 'Clear error'] };
  if (st.link === 'online' && st.interlock) return { key: 'warn', flag: true, label: 'Lid open', detail: 'Close the lid: the machine won\'t move or fire while it\'s open.' };
  if (st.link !== 'online') return { key: 'off', label: st.link === 'connecting' ? 'Connecting…' : 'Not connected', detail: st.message, action: ['reconnect', 'Reconnect'] };
  if (st.state === 'running' || st.state === 'paused' || st.state === 'framing') return { key: 'busy', label: st.state === 'paused' ? 'Processing · paused' : st.state === 'framing' ? 'Framing' : 'Processing', detail: st.message };
  return { key: 'ok', label: 'Connected', detail: S.info.model || '' };
}

function connText(c) {
  const m = c.connection;
  if (m.mode === 'sim') return 'Simulated';
  if (m.mode === 'udp') return 'Network · ' + (m.ip || 'no IP set');
  if (m.mode === 'tcp') return 'TCP · ' + (m.host || 'no host set') + ':' + m.tcpPort;
  if (!m.port || m.port === 'auto') return 'USB · automatic' + (S.info.port ? ' (' + S.info.port + ')' : '');
  return 'USB · ' + m.port;
}

// the panel under the machine name: status, connection details, what to do
function machinePanel() {
  const c = cfg();
  const st = S.status;
  const ms = machineStatus();
  const row = (l, v) => '<div style="display:grid;grid-template-columns:120px minmax(0,1fr);gap:10px;align-items:baseline;padding:6px 0;border-bottom:1px solid var(--line-soft)"><span class="lbl">' + l + '</span><span style="overflow-wrap:anywhere">' + v + '</span></div>';
  const addrs = ui.net && ui.net.adapters ? ui.net.adapters.filter((a) => a.addresses.length).map((a) => a.addresses.map((x) => esc(x.ip) + ':' + ui.net.port).join(', ') + ' <span class="lbl">(' + esc(a.label) + ')</span>').join('<br>') : '…';
  return '<div role="dialog" aria-label="Machine status" class="pop" style="position:absolute;right:0;top:56px;width:360px;padding:16px;gap:10px;border-radius:12px;z-index:60;cursor:default">' +
    '<div style="display:flex;align-items:center;gap:10px"><span style="width:12px;height:12px;border-radius:50%;background:' + STATUS_COLOR[ms.key] + ';flex:none"></span><span style="font-size:17px;font-weight:600">' + esc(ms.label) + '</span></div>' +
    (ms.key === 'warn' || ms.key === 'off' ? '<div style="padding:10px 12px;border-radius:10px;background:' + (ms.key === 'warn' ? 'var(--warn-soft)' : 'var(--err-soft)') + ';color:' + (ms.key === 'warn' ? 'var(--warn)' : 'var(--err)') + ';line-height:1.4">' + esc(ms.detail || '') + '</div>' : '') +
    '<div>' + (c.configured ? row('Machine', esc(c.name)) + row('Controller', c.controller === 'ruida' ? 'Ruida' : 'Trotec') + row('Connection', esc(connText(c))) : row('Machine', 'None yet')) +
    (S.info.model ? row('Model', esc(S.info.model)) : '') + (S.info.firmware ? row('Firmware', esc(S.info.firmware)) : '') +
    (st.link === 'online' && Number.isFinite(st.pos.x) ? row('Head', '<span class="mono">X ' + shownPos(st).x.toFixed(1) + '  Y ' + shownPos(st).y.toFixed(1) + ' mm</span>') : '') +
    row('Pathline connects to', '<span class="mono">' + addrs + '</span>') + '</div>' +
    '<div style="display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap">' +
    (c.configured ? '<button class="tb sm" data-a="go" data-v="setup">Machine setup</button>' : '') +
    (ms.action ? '<button class="btn-primary" style="height:40px" data-a="' + ms.action[0] + '"' + (ms.action[2] ? ' data-v="' + ms.action[2] + '"' : '') + '>' + ms.action[1] + '</button>' : '') + '</div></div>';
}

function header() {
  const ms = machineStatus();
  const dot = STATUS_COLOR[ms.key];
  const views = [['queue', 'Queue', ICON.queue], ['jog', 'Jog', ICON.jog], ['history', 'History', ICON.history], ['setup', 'Setup', ICON.gear]];
  const nq = visibleQueue().length;
  const c = S ? cfg() : null;
  return '<header class="hmi-bar">' +
    '<div style="display:flex;align-items:center;gap:10px"><div style="position:relative">' +
    '<button class="ib" data-a="nav" aria-label="Menu" aria-expanded="' + ui.navOpen + '">' + ic(ICON.menu) + '</button>' +
    (ui.navOpen ? '<div role="menu" class="pop" style="position:absolute;left:0;top:52px;min-width:230px">' +
      '<button role="menuitem" class="opt" data-a="go" data-v="setup">' + (S && !S.config.configured ? 'Add machine' : 'Machine setup') + '</button>' +
      '<button role="menuitem" class="opt" data-a="log">Diagnostics log</button>' +
      (S && S.here && S.config.configured ? '<button role="menuitem" class="opt" data-a="removeMachine" style="color:var(--err)">Remove machine…</button>' : '') +
      '<div class="sep"></div>' +
      '<button role="menuitem" aria-label="Dark mode ' + (ui.dark ? 'on' : 'off') + '" class="opt" data-a="theme" style="justify-content:space-between">' +
      '<span style="display:inline-flex;align-items:center;gap:10px">' + ic(ui.dark ? ICON.moon : ICON.sun, 18) + 'Dark mode</span>' +
      '<span class="sw" aria-hidden="true" aria-checked="' + ui.dark + '" style="pointer-events:none"></span></button>' +
      '<div class="sep"></div>' + (S && S.here ? '<button role="menuitem" class="opt" data-a="checkUpdate">Check for updates…</button>' : '') +
      '<button role="menuitem" class="opt" data-a="whatsNew">What\'s new</button><button role="menuitem" class="opt" data-a="about">About</button></div>' : '') +
    '</div><div class="brand"><img class="brand-mark" src="icon.svg" width="34" height="34" alt=""><span class="word">Pathline <span style="font-weight:400">Run</span></span></div></div>' +
    '<nav aria-label="Views" class="tabs views" style="flex:1 1 280px">' + views.map(([k, l, d]) =>
      '<button data-a="go" data-v="' + k + '" aria-current="' + (ui.view === k ? 'page' : 'false') + '">' + ic(d) + '<span class="lab">' + l + '</span>' + (k === 'queue' ? '<span class="count">' + nq + '</span>' : '') + '</button>').join('') + '</nav>' +
    '<div style="display:flex;align-items:center;gap:8px">' + updateChip() +
    (c ? '<div style="position:relative"><button data-a="machMenu" aria-haspopup="dialog" aria-expanded="' + !!ui.machOpen + '" aria-label="' + esc((c.configured ? c.name : 'No machine') + ': ' + ms.label) + '" title="' + esc(ms.label) + '" style="display:flex;align-items:center;gap:10px;height:48px;padding:0 12px 0 8px;border:1px solid ' + (ms.flag ? STATUS_COLOR.warn : 'var(--line-strong)') + ';border-radius:var(--ctl-r);background:var(--surface);color:var(--text);cursor:pointer;text-align:left">' +
      (c.controller === 'ruida' && c.type === 'plotter' ? '<span class="badge" style="background:var(--badge-plotter)">PLOTTER</span>' : '<span class="badge">LASER</span>') + '<span style="display:flex;flex-direction:column;line-height:1.2"><span style="font-weight:600">' + esc(c.configured ? c.name : 'No machine') + '</span><span class="lbl">' + esc(ms.label) + '</span></span>' +
      (ms.flag ? '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" style="flex:none"><path d="M12 3L2 21h20z" fill="' + STATUS_COLOR.warn + '"/><path d="M12 10v5 M12 17.5v.5" stroke="#FFFFFF" stroke-width="2.2" stroke-linecap="round"/></svg>' : '') +
      '<span aria-hidden="true"' + (ms.key === 'busy' ? ' class="loop"' : '') + ' style="width:11px;height:11px;border-radius:50%;background:' + dot + (ms.key === 'busy' ? ';animation:plr-pulse 1.4s ease-in-out infinite' : '') + '"></span></button>' +
      (ui.machOpen ? machinePanel() : '') + '</div>' : '') +
    '</div></header>';
}

// ---------------------------------------------------------------- updates (as in Pathline)
// The installed app checks when it opens and every minute. A found update
// asks first (Later / Download and install), the download shows its progress,
// then Restart and install. Nothing downloads or installs without a tap. Only
// the machine's own screen sees this, not browsers elsewhere on the network.
let seenSeq = null;
function followUpdate(u) {
  if (!u || !S.here) return;
  const first = seenSeq === null;
  if (u.seq === seenSeq) return;
  seenSeq = u.seq;
  const open = ui.dlg && ui.dlg.kind === 'update';
  if (open) return; // the window follows the state on its own
  if (u.state === 'available' && !first) ui.dlg = { kind: 'update' };
  else if (u.state === 'downloading' && first) ui.dlg = { kind: 'update' };
  else if (u.state === 'ready') toast('Pathline Run ' + u.version + ' is ready to install', { action: 'Restart and install', onAction: 'install', ms: 20000 });
  else if (u.state === 'error') toast('The update didn\'t download: ' + (u.message || 'no connection'), { action: 'Try again', onAction: 'download', ms: 12000 });
}

// header: while an update downloads, and once it's ready
function updateChip() {
  const u = S && S.update;
  if (!u || !S.here) return '';
  if (u.state === 'ready') return '<button class="tb sm" data-a="showUpdate" style="border-color:var(--ok-dot);color:var(--ok)">Update ' + esc(u.version) + ' ready</button>';
  if (u.state === 'downloading') return '<button class="tb sm" data-a="showUpdate">Downloading ' + Math.round(u.percent || 0) + ' %</button>';
  return '';
}

const mb = (b) => (b / 1048576).toFixed(1) + ' MB';
function updateWindow() {
  const u = S.update;
  const v = esc(u.version || '');
  const btns = (list) => '<div style="display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap">' + list.map(([l, a, primary, off]) => '<button class="' + (primary ? 'btn-primary' : 'tb') + '" data-a="' + a + '"' + (off ? ' disabled' : '') + '>' + l + '</button>').join('') + '</div>';
  let inner;
  if (u.state === 'available') {
    inner = '<span class="h-sec" style="font-size:18px">Update available</span><span style="color:var(--text-2);line-height:1.5">Pathline Run ' + v + ' is available. You have ' + esc(u.current) + '.</span>' +
      btns([['Later', 'close'], ['Download and install', 'download', true]]);
  } else if (u.state === 'downloading') {
    const pct = Math.max(1, Math.min(100, u.percent || 0));
    inner = '<span class="h-sec" style="font-size:18px">Downloading Pathline Run ' + v + '</span>' +
      '<div role="progressbar" aria-valuenow="' + Math.round(pct) + '" style="height:12px;border-radius:6px;background:var(--sunken);box-shadow:inset 0 0 0 1px var(--line);overflow:hidden"><div style="height:100%;width:' + pct + '%;background:var(--action);transition:width .3s ease-out"></div></div>' +
      '<span class="mono" style="color:var(--text-2)">' + Math.round(u.percent || 0) + ' %' + (u.total ? ' · ' + mb(u.transferred || 0) + ' of ' + mb(u.total) : '') + (u.bytesPerSecond ? ' · ' + mb(u.bytesPerSecond) + '/s' : '') + '</span>' +
      '<span class="lbl">The machine keeps working. You\'ll be told when it\'s ready.</span>' + btns([['Hide', 'close']]);
  } else if (u.state === 'ready') {
    const busy = running();
    inner = '<span class="h-sec" style="font-size:18px">Update ready to install</span><span style="color:var(--text-2);line-height:1.5">Pathline Run ' + v + ' has downloaded. Restarting installs it and opens Pathline Run again. Queued jobs and settings are kept.' +
      (busy ? '<br><b>A job is running: restart once it has finished.</b>' : '') + '</span>' + btns([['Later', 'close'], ['Restart and install', 'install', true, busy]]);
  } else if (u.state === 'error') {
    inner = '<span class="h-sec" style="font-size:18px">Update didn\'t download</span><div class="errbox">' + esc(u.message || 'The download failed.') + '</div>' + btns([['Close', 'close'], ['Try again', 'download', true]]);
  } else {
    ui.dlg = null;
    return '';
  }
  return '<div class="scrim"><div role="dialog" aria-label="Pathline Run update" class="dlg">' + inner + '</div></div>';
}

function changelogWindow(entries, title) {
  return '<div class="scrim"><div role="dialog" aria-label="What\'s new" class="dlg" style="max-width:560px"><span class="h-sec" style="font-size:18px">' + esc(title) + '</span>' +
    entries.map((c) => '<section style="display:flex;flex-direction:column;gap:6px;padding-top:8px;border-top:1px solid var(--line-soft)"><span style="font-weight:600">Pathline Run ' + esc(c.version) + '</span>' + (c.date ? '<span class="lbl">' + esc(c.date) + '</span>' : '') +
      [['New', c.added], ['Fixed', c.fixed]].filter(([, l]) => l && l.length).map(([label, l]) => '<span class="lbl" style="font-weight:600;text-transform:uppercase;letter-spacing:.04em">' + label + '</span><ul style="margin:0;padding-left:20px;line-height:1.5;color:var(--text-2)">' + l.map((t) => '<li>' + esc(t) + '</li>').join('') + '</ul>').join('') + '</section>').join('') +
    '<div style="display:flex;justify-content:flex-end"><button class="btn-primary" data-a="close">Got it</button></div></div></div>';
}

function messageWindow(title, msg) {
  return '<div class="scrim"><div role="dialog" aria-label="' + esc(title) + '" class="dlg"><span class="h-sec" style="font-size:18px">' + esc(title) + '</span><span style="color:var(--text-2);line-height:1.5">' + esc(msg) + '</span>' +
    '<div style="display:flex;justify-content:flex-end"><button class="btn-primary" data-a="close">Close</button></div></div></div>';
}

// ---------------------------------------------------------------- queue view
// the processes the job uses (a step of its toolpath names it): a material's others are left out
function procRows(pkg) {
  const used = new Set((pkg.toolpath || []).map((s) => s.process).filter((i) => i !== undefined));
  return (pkg.processes || []).filter((p) => !used.size || used.has(p.index)).map((p) => {
    const pv = p.tool !== undefined && p.proc === undefined
      ? String(p.tool).split(' · ')[0] + ' · ' + p.speed + ' mm/s' + (p.passes > 1 ? '  ×' + p.passes : '') // plotter: tool and speed
      : p.proc === 'Engrave' ? 'P ' + p.power + ' %  V ' + p.speed + ' mm/s  ' + p.f + ' DPI' : 'P ' + p.power + ' %  V ' + p.speed + ' mm/s' + (p.passes > 1 ? '  ×' + p.passes : '');
    return '<div style="display:flex;align-items:center;gap:10px;min-height:34px;padding:0 2px;border-bottom:1px solid var(--line-soft)">' +
      '<span style="display:flex;gap:3px">' + (p.aci || []).slice(0, 4).map((n) => '<span class="chip" title="ACI ' + n + '" style="background:' + (aciHex(n) || 'var(--text)') + ';color:' + (n === 7 ? 'var(--surface)' : aciFg(n)) + '">' + n + '</span>').join('') + '</span>' +
      '<span style="flex:1;min-width:0">' + esc(p.name) + '</span><span class="mono" style="font-size:13px;color:var(--text-2)">' + pv + '</span></div>';
  }).join('');
}

// X/Y as the machine's own panel shows them (Ruida: from the controller's origin, e.g. top
// right on a YC-1610); the bed view still draws in Pathline's top-left frame
const shownPos = (st) => st.mpos || st.pos;

// top of the preview: where the toolhead is now (live while a job runs)
function headReadout(st, isRun) {
  const ok = Number.isFinite(st.pos.x) && st.link === 'online';
  const label = isRun ? (st.state === 'paused' ? 'Toolhead · paused' : 'Toolhead · processing') : 'Toolhead';
  return '<div style="position:absolute;left:12px;top:12px;display:flex;align-items:center;gap:10px;padding:6px 12px;border-radius:8px;background:var(--surface);box-shadow:var(--shadow-1);font-size:13px">' +
    '<span aria-hidden="true" class="loop" style="width:10px;height:10px;border-radius:50%;background:var(--ink);box-shadow:0 0 0 3px var(--accent-ring)' + (isRun && st.state === 'running' ? ';animation:plr-pulse 1.2s ease-in-out infinite' : '') + '"></span>' +
    '<span style="color:var(--text-2)">' + label + '</span>' +
    (ok ? '<span class="mono" style="font-weight:500">X ' + shownPos(st).x.toFixed(1) + '</span><span class="mono" style="font-weight:500">Y ' + shownPos(st).y.toFixed(1) + '</span><span class="lbl">mm</span>' : '<span class="lbl">position unknown</span>') + '</div>';
}

function queueView() {
  const st = S.status;
  const q = visibleQueue();
  const job = q.find((j) => j.id === ui.sel) || null;
  const pkg = job ? ui.pkgs[job.id] : null;
  const isRun = running();
  const runJob = isRun ? S.jobs.find((j) => j.id === st.job) : null;
  const shown = runJob || job;

  const total = shown ? shown.seconds : 0;
  const frac = isRun ? st.progress : 0;
  ui.picked = ui.picked.filter((id) => q.some((j) => j.id === id && j.status === 'queued'));
  // Select (several jobs back to back) is for plotters / routers only
  const canMulti = cfg().type === 'plotter';
  if (!canMulti && ui.multi) { ui.multi = false; ui.picked = []; }
  const cantStart = (ui.multi ? !ui.picked.length : !job) || st.link !== 'online' || st.interlock || st.state === 'alarm' || st.state === 'framing';

  const list = q.map((j, i) => {
    const p = ui.pkgs[j.id];
    const ticked = ui.picked.includes(j.id);
    // Select mode: a tap ticks the job (and shows it); otherwise a tap shows it
    const tick = ui.multi && j.status === 'queued'
      ? '<span aria-hidden="true" style="position:absolute;left:16px;top:16px;width:24px;height:24px;border-radius:6px;display:flex;align-items:center;justify-content:center;box-shadow:var(--shadow-1);' +
        (ticked ? 'background:var(--accent);color:var(--on-accent)">' + ic('M5 12l5 5L19 7', 16) : 'background:var(--surface);border:2px solid var(--line-strong)">') + '</span>'
      : '';
    return '<div class="jobcard' + (j.id === ui.sel ? ' on' : '') + '">' +
      '<button class="pick" data-a="' + (ui.multi && j.status === 'queued' ? 'pick' : 'sel') + '" data-v="' + j.id + '" aria-pressed="' + (ui.multi ? ticked : j.id === ui.sel) + '">' + bedSvg(p) +
      '<span style="display:flex;flex-direction:column;gap:1px;line-height:1.3"><span style="font-weight:600">' + (i + 1) + '. ' + esc(j.name) + '</span>' +
      '<span class="lbl">' + esc(j.material || '—') + '</span><span class="lbl mono">' + stamp(j.receivedAt) + ' · ' + short(j.seconds) + '</span></span></button>' + tick +
      (j.status === 'running' ? '<span class="pill accent" style="position:absolute;top:16px;right:16px;box-shadow:var(--shadow-1)">Running</span>'
        : j.status === 'done' ? '<span class="pill ok" style="position:absolute;top:16px;right:16px;box-shadow:var(--shadow-1)">Done' + (j.runs > 1 ? ' ×' + j.runs : '') + '</span>'
        : '<div class="ord"><button class="ib" data-a="up" data-v="' + j.id + '" aria-label="Move up"' + (i === 0 ? ' disabled' : '') + '>' + ic(ICON.chevUp, 18) + '</button><button class="ib" data-a="down" data-v="' + j.id + '" aria-label="Move down"' + (i === q.length - 1 ? ' disabled' : '') + '>' + ic(ICON.chevDown, 18) + '</button></div>') +
      '</div>';
  }).join('');
  // thumbnails need packages too
  for (const j of q) if (!ui.pkgs[j.id]) { ui.pkgs[j.id] = 'loading'; call('GET', LOCAL('/jobs/' + j.id + '/package')).then((p) => { ui.pkgs[j.id] = p; render(); }).catch(() => { delete ui.pkgs[j.id]; }); }

  const shownPkg = shown ? ui.pkgs[shown.id] : null;
  const warn = shown && shown.warnings && shown.warnings.length ? '<div class="warnbox">' + shown.warnings.map(esc).join('<br>') + '</div>' : '';
  const ctrlName = cfg().controller === 'ruida' ? 'Ruida' : 'Trotec';

  return '<div class="view fit qview">' +
    '<aside aria-label="Job queue" class="card qlist">' +
    '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:14px 14px 10px"><span class="h-sec">Queue</span><span class="lbl">' + q.length + (q.length === 1 ? ' job' : ' jobs') + '</span><span style="flex:1"></span>' +
    // Select: tick several jobs; Start runs them one after another (plotters / routers)
    (canMulti ? '<label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer" title="Tick several jobs, then Start runs them one after another"><span class="lbl" style="font-size:13px;color:var(--text-2)">' + (ui.multi ? ui.picked.length + ' ticked' : 'Select') + '</span><button role="switch" class="sw" aria-checked="' + !!ui.multi + '" data-a="multi" aria-label="Select several jobs"></button></label>' : '') +
    '<button class="tb sm" data-a="import">' + ic(ICON.upload, 16) + 'Import</button></div>' +
    '<div data-keep="qlist" style="flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding:0 12px 12px">' + (list || '<div style="padding:28px 8px;text-align:center;color:var(--text-3)">No jobs yet. Send one from Pathline, or Import a file.</div>') + '</div>' +
    '<div style="display:flex;gap:8px;padding:12px;border-top:1px solid var(--line)"><button class="tb" data-a="remove"' + (!job || job.status === 'running' ? ' disabled' : '') + '>' + ic(ICON.trash, 18) + 'Remove</button></div></aside>' +

    '<main class="card qmain">' +
    '<div class="qtop">' +
    '<div class="qinfo" data-keep="qinfo">' +
    '<div style="display:flex;flex-direction:column;gap:4px"><h1 style="margin:0;font-size:24px;font-weight:600;line-height:1.2">' + esc(shown ? shown.name : 'No job selected') + '</h1>' +
    '<span style="color:var(--text-2)">' + esc(shown ? (shown.material || 'No material') + (cfg().configured ? ' · ' + cfg().name + ' · ' + ctrlName : '') : '') + '</span></div>' +
    // the two switches first, always in the same place (the material's processes below can be long)
    '<div style="display:flex;flex-direction:column;gap:2px;padding-bottom:8px;border-bottom:1px solid var(--line-soft)">' +
    // pin the job's top-left corner to the head: where the head is when Start is pressed, for that
    // run only (off puts the job back where Pathline placed it)
    (() => {
      const on = !!(job && (job.anchorAtStart || job.anchor));
      const off = !job || isRun;
      const here = Number.isFinite(st.pos.x) ? ' (now X ' + shownPos(st).x.toFixed(1) + ', Y ' + shownPos(st).y.toFixed(1) + ' mm)' : '';
      // print and cut: the top-left corner is the top-left registration mark, under the laser
      // (J0064: the camera was put over it, 42 mm out)
      const marks = !!(shownPkg && shownPkg !== 'loading' && (shownPkg.toolpath || []).some((s) => s.type === 'inspect'));
      const note = !on ? ''
        : job.anchor ? 'Top-left corner at X ' + job.anchor.x.toFixed(1) + ', Y ' + job.anchor.y.toFixed(1) + ' mm'
          : marks ? 'Put the laser (not the camera) over the top-left dot, then press Start' + here
            : 'Top-left corner goes to the head when you press Start' + here;
      return '<div style="display:flex;align-items:center;gap:12px;min-height:44px"><button role="switch" class="sw" aria-checked="' + on + '" data-a="anchor"' + (on ? ' data-v="clear"' : '') + ' aria-label="Anchor to toolhead"' + (off ? ' disabled' : '') + '></button>' +
        '<span style="display:flex;flex-direction:column;gap:2px;line-height:1.3"><span style="font-size:16px">Anchor to toolhead</span>' +
        (note ? '<span class="lbl">' + note + '</span>' : '') + '</span></div>';
    })() +
    '<div style="display:flex;align-items:center;gap:12px;min-height:44px"><button role="switch" class="sw" aria-checked="' + !!cfg().removeDone + '" data-a="removeDone" aria-label="Remove completed job from queue"></button><span style="font-size:16px">Remove completed job from queue</span></div>' +
    '</div>' +
    (shownPkg && shownPkg !== 'loading' ? '<div style="display:flex;flex-direction:column;gap:6px">' + procRows(shownPkg) + '</div>' : '') + warn +
    '</div>' +
    '<div class="qbed"><div class="viewport" style="position:relative;flex:1;min-height:0;border:1px solid var(--line);border-radius:10px;overflow:hidden">' +
    '<div style="position:absolute;inset:50px 8px 8px">' + bedSvg(shownPkg, { big: true, head: true }) + '</div>' +
    headReadout(st, isRun) + bedTools() + '</div>' +
    (shown && shownPkg && shownPkg !== 'loading' && shownPkg.anchor ? '<span class="lbl" style="display:flex;align-items:center;gap:8px"><span style="width:10px;height:10px;border-radius:50%;border:2px solid var(--ok-dot);background:var(--bed);flex:none"></span>Anchored at X ' + shownPkg.anchor.x.toFixed(1) + ', Y ' + shownPkg.anchor.y.toFixed(1) + ' mm</span>' : '') +
    '</div></div>' +

    '<div class="qrun">' +
    '<button class="run-btn" data-a="startPause" aria-label="' + (st.state === 'running' ? 'Pause' : st.state === 'paused' ? 'Resume' : 'Start') + '"' + (!isRun && cantStart ? ' disabled' : '') + ' style="background:' + (st.state === 'running' ? 'var(--pause)' : 'var(--go)') + ';cursor:pointer">' + ic(st.state === 'running' ? ICON.pause : ICON.play, 28) + '</button>' +
    '<button class="run-btn stop" data-a="stop" aria-label="Stop" style="color:var(--err)">' + ic(ICON.stop, 24) + '</button>' +
    '<button class="tb" data-a="frame" style="height:64px;padding:0 18px"' + (!shown || isRun ? ' disabled' : '') + '>' + ic(ICON.frame) + 'Frame</button>' +
    '<div style="flex:1 1 280px;min-width:0;display:flex;flex-direction:column;gap:8px">' +
    // the bar, with the percentage complete at its end
    '<div style="display:flex;align-items:center;gap:12px"><div role="progressbar" aria-label="Job progress" aria-valuenow="' + Math.round(frac * 100) + '" aria-valuemin="0" aria-valuemax="100" style="flex:1;height:14px;border-radius:7px;background:var(--sunken);box-shadow:inset 0 0 0 1px var(--line);overflow:hidden"><div style="height:100%;width:' + (frac * 100).toFixed(1) + '%;background:var(--accent)"></div></div>' +
    '<span class="mono" style="min-width:52px;text-align:right;font-size:18px;font-weight:500;color:' + (isRun ? 'var(--text)' : 'var(--text-3)') + '">' + Math.floor(frac * 100) + ' %</span></div>' +
    '<div style="display:flex;justify-content:space-between;gap:8px"><span style="color:var(--text-2)">' + esc(isRun ? (st.state === 'paused' ? 'Paused' : 'Running') + ' · ' + st.message : /^(Finished|Stopped)/.test(st.message) ? st.message : 'Not started') + '</span><span class="mono' + (isRun ? '' : ' qest-idle') + '" style="color:var(--text-2)">' + (isRun ? hms(frac * total) + ' / ' + hms(total) : 'Estimated ' + hms(total)) + '</span></div></div>' +
    '<div class="qremain" style="display:flex;flex-direction:column;align-items:flex-end"><span class="lbl">' + (isRun ? 'Remaining' : 'Estimated time') + '</span><span class="mono" id="remain" style="font-size:44px;font-weight:500;line-height:1">' + hms(isRun ? remaining() : total) + '</span></div>' +
    '</div></main></div>';
}

// ---------------------------------------------------------------- jog view
function jogView() {
  const st = S.status;
  const c = cfg();
  const pill = (l, v, ok) => '<div style="display:flex;align-items:center;justify-content:space-between;min-height:48px;border-bottom:1px solid var(--line-soft)"><span>' + l + '</span><span class="pill ' + (ok ? 'ok' : 'err') + '">' + esc(v) + '</span></div>';
  const tog = (l, k) => '<div style="display:flex;align-items:center;justify-content:space-between;min-height:48px;border-bottom:1px solid var(--line-soft)"><span>' + l + '</span><button role="switch" class="sw" aria-checked="' + !!st.io[k] + '" data-a="io" data-v="' + k + '" aria-label="' + l + '"></button></div>';
  const sim = c.connection.mode === 'sim';
  const btn = (a, d, label) => '<button class="tb" data-a="' + a + '" aria-label="' + label + '" style="height:76px;padding:0">' + ic(d, 26) + '</button>';
  // jog arrows: tap moves one step, press and hold keeps moving (handled by pointer events below)
  const arrow = (v, d, label) => {
    const on = ui.hold && ui.hold.held && ui.hold.axis + (ui.hold.dir < 0 ? '-' : '+') === v;
    return '<button class="tb" data-hold="' + v + '" aria-label="' + label + '" style="height:76px;padding:0;touch-action:none;user-select:none' + (on ? ';border-color:var(--accent);background:var(--accent-soft);color:var(--accent-fg)' : '') + '">' + ic(d, 26) + '</button>';
  };
  // the head outside the bed set in Setup: usually the bed is set smaller than the machine
  const [bw, bh] = c.bed;
  const outside = st.link === 'online' && Number.isFinite(st.pos.x) && (st.pos.x < -0.5 || st.pos.y < -0.5 || st.pos.x > bw + 0.5 || st.pos.y > bh + 0.5);
  const mw = st.markWait;
  // print and cut waiting for a mark: what to do, Accept and Stop
  const markBox = mw ? '<div role="alert" class="warnbox" style="display:flex;flex-wrap:wrap;align-items:center;gap:12px 16px">' +
    '<div style="flex:1 1 260px;min-width:0;display:flex;flex-direction:column;gap:4px"><strong>Registration mark ' + mw.mark + ' of ' + mw.of + (mw.again ? ' still not found' : ' not found') + '</strong>' +
    '<span>' + (mw.again ? 'There was no mark under the crosshair. ' : 'It wasn\'t near X ' + mw.near[0].toFixed(1) + ', Y ' + mw.near[1].toFixed(1) + ' mm. ') + 'Jog the camera until the mark is in the red circle, then press Accept: the camera finds its centre from there.</span></div>' +
    '<button class="tb" data-a="markAccept" style="height:56px;padding:0 28px;background:var(--go);border-color:var(--go);color:#fff;font-weight:600">Accept</button>' +
    '<button class="tb" data-a="stop" style="height:56px;padding:0 20px;color:var(--err)">Stop job</button></div>' : '';
  const coords = '<div style="display:flex;flex-wrap:wrap;gap:36px">' + [['X', shownPos(st).x], ['Y', shownPos(st).y]].map(([l, v]) => '<div style="display:flex;flex-direction:column;gap:2px"><span class="lbl">' + l + ' <span class="mono">mm</span></span><span class="mono" style="font-size:' + (mw ? 24 : 36) + 'px;font-weight:500">' + (Number.isFinite(v) ? v.toFixed(1) : '—') + '</span></div>').join('') + '</div>';
  // the arrows (home in the middle, not while a job waits for a mark) and the step / speed
  const pad = '<div style="display:grid;grid-template-columns:repeat(3,76px);grid-template-rows:repeat(3,76px);gap:8px">' +
    '<span></span>' + arrow('y-', ICON.up, 'Jog Y minus') + '<span></span>' +
    arrow('x-', ICON.left, 'Jog X minus') + (mw ? '<span></span>' : btn('home', ICON.home, 'Home')) + arrow('x+', ICON.right, 'Jog X plus') +
    '<span></span>' + arrow('y+', ICON.down, 'Jog Y plus') + '<span></span></div>';
  const steps = '<div style="display:flex;flex-direction:column;gap:6px"><span class="lbl">Tap: step in mm · Hold: speed in mm/s</span><div role="radiogroup" aria-label="Step size, or speed while held" class="seg">' +
    ['0.1', '1', '10', '100'].map((v) => '<button role="radio" class="mono" style="min-width:56px" aria-checked="' + (ui.step === v) + '" data-a="step" data-v="' + v + '">' + v + '</button>').join('') + '</div>' +
    '<span class="lbl" style="min-height:18px">' + (ui.hold && ui.hold.held ? 'Moving ' + ui.hold.axis.toUpperCase() + (ui.hold.dir < 0 ? '−' : '+') + ' at ' + ui.step + ' mm/s' : '') + '</span></div>';
  // a mark to find by hand: the camera picture beside the arrows, both in sight at once
  const body = mw
    ? '<div style="display:flex;flex-wrap:wrap;gap:20px;align-items:flex-start">' + camPicture(c) +
      '<div style="display:flex;flex-direction:column;gap:14px">' + coords + pad + steps + '</div></div>'
    : '<h2 class="h-sec">Position</h2>' +
      (outside ? '<div class="warnbox">The head is outside the ' + bw + ' × ' + bh + ' mm bed. If the machine is bigger, set its size in Setup → Work area.</div>' : '') +
      coords + '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:28px">' + pad + steps + '</div>' + camCard(c, st);
  return '<div class="view fit jview">' +
    '<section aria-label="Jog" data-keep="jogpos" class="card" style="flex:1 1 auto;min-width:0;min-height:0;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:16px">' + markBox + body + '</section>' +
    '<section aria-label="Machine" data-keep="jogmach" class="card" style="flex:0 1 360px;min-width:260px;min-height:0;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:12px"><h2 class="h-sec">Machine</h2>' +
    '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px">' +
    '<button class="tb" style="height:52px" data-a="home">Home</button><button class="tb" style="height:52px" data-a="frame">Frame job</button>' +
    (c.controller === 'ruida' && c.type === 'plotter' && c.f.conveyor ? '<button class="tb" style="height:52px" data-a="feed" title="Advances the material ' + esc(c.feedLen) + ' mm">Conveyor</button>' : '') +
    '<button class="tb" style="height:52px" data-a="stop">Stop</button></div>' +
    // a plotter's vacuum table, switched by hand: only once the controller can do it
    (c.controller === 'ruida' && c.type === 'plotter' && c.f.vacuum && S.info.vacuum ? tog('Vacuum', 'vacuum') : '') +
    '<div class="hr" style="margin:4px 0"></div><h2 class="h-sec">Status</h2><div style="display:flex;flex-direction:column;gap:4px">' +
    pill('Controller', st.link === 'online' ? (S.info.model || 'Connected') : st.link === 'connecting' ? 'Connecting…' : 'Not connected', st.link === 'online') +
    (sim ? '<div style="display:flex;align-items:center;justify-content:space-between;min-height:48px;border-bottom:1px solid var(--line-soft)"><span>Lid closed (simulated)</span><button role="switch" class="sw" aria-checked="' + !st.interlock + '" data-a="simLid" aria-label="Lid closed"></button></div>'
      : pill('Lid', st.interlock ? 'Open' : c.f.interlock ? 'Closed' : 'Not monitored', !st.interlock)) +
    (c.f.air && c.controller === 'trotec' ? tog('Air assist', 'air') : '') +
    pill('State', st.state.charAt(0).toUpperCase() + st.state.slice(1), st.state !== 'alarm') + '</div></section></div>';
}

// Jog → Camera (Trotec with the head camera on): the live picture, and camera ↔ laser moves
// the live picture itself, with its centre crosshair (drawCam)
function camPicture(c) {
  if (c.controller !== 'trotec' || !c.vision || !c.vision.enabled) return '<div class="errbox">The head camera is off (Setup → Camera)</div>';
  const busy = S.camera.busy;
  return '<div style="position:relative;width:min(320px,100%);aspect-ratio:1;border-radius:10px;overflow:hidden;background:var(--sunken);box-shadow:inset 0 0 0 1px var(--line)">' +
    (ui.live && ui.cam ? '<canvas id="camview" style="display:block;width:100%;height:100%"></canvas>'
      : '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:16px;text-align:center" class="lbl">' + esc(busy ? busy : ui.camErr ? ui.camErr : ui.live ? 'Opening the camera…' : 'Camera picture off') + '</div>') + '</div>';
}

function camCard(c, st) {
  if (c.controller !== 'trotec' || !c.vision || !c.vision.enabled) return '';
  const busy = S.camera.busy;
  return '<div class="hr"></div><div style="display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start">' + camPicture(c) +
    '<div style="display:flex;flex-direction:column;gap:8px;min-width:200px">' +
    '<h2 class="h-sec">Camera</h2>' +
    '<div style="display:flex;align-items:center;gap:10px"><button role="switch" class="sw" aria-checked="' + !!ui.live + '" data-a="camLive" aria-label="Camera picture"></button><span>Live picture</span></div>' +
    '<button class="tb" data-a="camGoto" data-v="camera"' + (busy ? ' disabled' : '') + ' title="Moves the head so the camera looks where the laser is now">Camera to the laser\'s spot</button>' +
    '<button class="tb" data-a="camGoto" data-v="laser"' + (busy ? ' disabled' : '') + ' title="Moves the head so the laser is where the camera\'s crosshair is">Laser to the crosshair</button>' +
    '<span class="lbl">' + esc(S.camera.info ? S.camera.info.model + (S.camera.info.serial ? ' · ' + S.camera.info.serial : '') : 'Allied Vision head camera') + '</span></div></div>';
}

// ---------------------------------------------------------------- history view
function historyView() {
  const hf = ui.histFilter;
  const rows = S.history.filter((h) => hf === 'All' || h.result === hf);
  const cols = 'grid-template-columns:minmax(200px,2fr) minmax(160px,1.4fr) 140px 110px 120px 130px';
  return '<div class="view" style="padding:12px;display:flex"><section aria-label="History" class="card" style="flex:1;min-width:0;display:flex;flex-direction:column">' +
    '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid var(--line)"><h2 class="h-sec">History</h2><div role="radiogroup" aria-label="Filter" class="seg">' +
    ['All', 'Completed', 'Stopped'].map((l) => '<button role="radio" aria-checked="' + (hf === l) + '" data-a="hist" data-v="' + l + '">' + l + '</button>').join('') +
    '</div><span style="flex:1"></span><span class="lbl">' + rows.length + ' jobs</span></div><div style="overflow-x:auto"><div role="table" aria-label="Job history" style="min-width:860px">' +
    '<div role="row" style="display:grid;' + cols + ';gap:12px;align-items:center;padding:10px 18px;border-bottom:1px solid var(--line)">' +
    ['Job', 'Material', 'Started', 'Duration', 'Result', ''].map((h) => '<span role="columnheader" class="lbl" style="font-weight:500">' + h + '</span>').join('') + '</div>' +
    (rows.length ? rows.map((h) => '<div role="row" style="display:grid;' + cols + ';gap:12px;align-items:center;padding:10px 18px;border-bottom:1px solid var(--line-soft)">' +
      '<span role="cell" style="font-weight:500">' + esc(h.name) + '</span><span role="cell" style="color:var(--text-2)">' + esc(h.material || '—') + '</span>' +
      '<span role="cell" class="mono" style="font-size:13px">' + stamp(h.startedAt) + '</span><span role="cell" class="mono" style="font-size:13px">' + hms(h.seconds) + '</span>' +
      '<span role="cell"><span class="pill ' + (h.result === 'Completed' ? 'ok' : 'warn') + '">' + h.result + '</span></span>' +
      '<span role="cell"><button class="tb sm" data-a="rerun" data-v="' + h.id + '">Run again</button></span></div>').join('')
      : '<div style="padding:28px;text-align:center;color:var(--text-3)">No jobs have run yet</div>') +
    '</div></div></section></div>';
}

// ---------------------------------------------------------------- setup view
const get = (obj, path) => path.split('.').reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), obj);
function set(obj, path, v) {
  const ks = path.split('.');
  let o = obj;
  ks.slice(0, -1).forEach((k) => { o[k] = Array.isArray(o[k]) ? o[k].slice() : { ...o[k] }; o = o[k]; });
  o[ks[ks.length - 1]] = v;
}

// Setup → Network: this computer's addresses (what Pathline connects to), and
// DHCP or a static IP for one adapter. Applied to the computer straight away,
// not saved with the machine setup.
function networkCard(card) {
  const n = ui.net;
  if (!n) return card('This computer\'s IP address', '<span class="lbl">Reading the network adapters…</span>');
  if (n.error) return card('This computer\'s IP address', '<div class="errbox">' + esc(n.error) + '</div>');
  const port = n.port;
  const live = n.adapters.filter((a) => a.addresses.length);
  const connect = live.length
    ? live.map((a) => '<div class="row"><span>' + esc(a.label) + (a.mode ? '<span class="hint">' + (a.mode === 'dhcp' ? 'DHCP' : 'Static') + (a.gateway ? ' · gateway ' + esc(a.gateway) : '') + '</span>' : '') + '</span><span class="mono" style="font-size:16px;font-weight:500">' + a.addresses.map((x) => esc(x.ip) + ':' + port).join('<br>') + '</span></div>').join('')
    : '<span class="lbl">No network connection. Plug in the network cable.</span>';
  if (!ui.netDraft) {
    const a = live[0] || n.adapters[0] || { name: '', addresses: [], mode: 'dhcp', gateway: '' };
    ui.netDraft = { adapter: a.name, connection: a.connection, mode: a.mode || 'dhcp', ip: (a.addresses[0] || {}).ip || '', mask: (a.addresses[0] || {}).mask || '255.255.255.0', gateway: a.gateway || '' };
  }
  const d = ui.netDraft;
  const canSet = n.canSet && S.here;
  const field = (l, k, hint) => '<label class="row"><span>' + l + (hint ? '<span class="hint">' + hint + '</span>' : '') + '</span><span class="fld"><input class="mono" data-n="' + k + '" value="' + esc(d[k]) + '"' + (canSet ? '' : ' disabled') + '></span></label>';
  const form = !canSet
    ? '<span class="lbl">' + (S.here ? 'This system can\'t be set from Pathline Run.' : 'The IP address can only be changed on the machine\'s own screen.') + '</span>'
    : '<div class="row"><span>Adapter</span><select class="cell" data-n="adapter">' + n.adapters.map((a) => '<option value="' + esc(a.name) + '"' + (a.name === d.adapter ? ' selected' : '') + '>' + esc(a.label) + (a.up ? '' : ' (not connected)') + '</option>').join('') + '</select></div>' +
      '<div class="row"><span>IP address</span><div role="radiogroup" aria-label="IP address mode" class="seg" style="justify-self:start">' +
      [['dhcp', 'Automatic (DHCP)'], ['static', 'Static']].map(([v, t]) => '<button role="radio" aria-checked="' + (d.mode === v) + '" data-a="netMode" data-v="' + v + '">' + t + '</button>').join('') + '</div></div>' +
      (d.mode === 'static' ? field('IP address', 'ip', 'e.g. 192.168.1.40') + field('Subnet mask', 'mask') + field('Gateway', 'gateway', 'Optional') : '') +
      '<div style="display:flex;align-items:center;justify-content:flex-end;gap:12px;padding-top:6px;border-top:1px solid var(--line-soft)">' +
      '<span class="lbl" style="flex:1">' + (process_platform() === 'win' ? 'Windows asks for administrator permission.' : 'The connection restarts with the new address.') + '</span>' +
      '<button class="btn-primary" data-a="netApply"' + (n.busy ? ' disabled' : '') + '>' + (n.busy ? 'Applying…' : 'Apply') + '</button></div>';
  return card('This computer\'s IP address', '<span class="h-sec" style="font-size:14px">Pathline connects to</span>' + connect + '<div class="hr" style="margin:6px 0"></div><span class="h-sec" style="font-size:14px">Set the IP address</span>' + form,
    'In Pathline: Setup → Machines → the machine → Ethernet, this IP address and port ' + port + '. Changing the address disconnects Pathline until it uses the new one.');
}
const process_platform = () => (/Windows/i.test(navigator.userAgent) ? 'win' : 'other');
async function loadNetwork() {
  try { ui.net = await call('GET', LOCAL('/network')); } catch (e) { ui.net = { error: e.message }; }
  render();
}

function setupView() {
  if (!ui.draft) ui.draft = JSON.parse(JSON.stringify(cfg()));
  const d = ui.draft;
  const dirty = JSON.stringify(d) !== JSON.stringify(cfg());
  const text = (l, path, unit, hint) => '<label class="row"><span>' + l + (hint ? '<span class="hint">' + hint + '</span>' : '') + '</span><span class="fld"><input class="mono" data-f="' + path + '" value="' + esc(get(d, path)) + '"><span class="lbl mono">' + (unit || '') + '</span></span></label>';
  const num = (l, path, unit, hint) => text(l, path, unit, hint).replace('data-f=', 'data-num="1" data-f=');
  // a setting the controller reports: shows its value, and Reset puts it back after typing over it
  const fc = S.fromController || {};
  const ctl = (l, path, unit, hint) => {
    const v = fc[path];
    if (v === undefined) return num(l, path, unit, hint);
    const own = Number(get(d, path)) === v;
    const note = own ? 'From the controller' : 'Typed over · controller: ' + v + ' ' + unit;
    return num(l, path, unit, (hint ? hint + ' · ' : '') + note).replace('</span></span></label>', '</span></span>' + (own ? '' : '<button class="tb sm" style="grid-column:2;justify-self:end;height:32px" data-a="resetCtl" data-v="' + path + '">Reset to ' + v + ' ' + unit + '</button>') + '</label>');
  };
  const seg = (l, path, opts) => '<div class="row"><span>' + l + '</span><div role="radiogroup" aria-label="' + l + '" class="seg" style="justify-self:start">' + opts.map(([v, t]) => '<button role="radio" aria-checked="' + (get(d, path) === v) + '" data-a="setv" data-f="' + path + '" data-v="' + esc(JSON.stringify(v)) + '">' + t + '</button>').join('') + '</div></div>';
  const tog = (l, path) => '<div class="row"><span>' + l + '</span><button role="switch" class="sw" style="justify-self:start" aria-checked="' + !!get(d, path) + '" data-a="setv" data-f="' + path + '" data-v="' + !get(d, path) + '"></button></div>';
  const card = (title, inner, note) => '<section class="card" style="padding:18px;display:flex;flex-direction:column;gap:10px"><h2 class="h-sec">' + title + '</h2>' + (note ? '<span class="lbl">' + note + '</span>' : '') + inner + '</section>';
  const trotec = d.controller === 'trotec';
  const modes = trotec ? [['serial', 'USB'], ['tcp', 'TCP'], ['sim', 'Simulated']] : [['udp', 'Network'], ['sim', 'Simulated']];
  // serial port: Automatic finds the Trotec by its USB id; the ports found are listed too
  const curPort = d.connection.port || 'auto';
  const portOpts = [['auto', 'Automatic (finds the Trotec)']].concat(ui.ports.map((p) => [p.path, p.path + (p.label ? ' · ' + p.label : '')]));
  if (!portOpts.some(([v]) => v === curPort)) portOpts.push([curPort, curPort + ' · not found now']);
  const portSelect = '<label class="row"><span>Serial port<span class="hint">' + (ui.ports.some((p) => p.trotec) ? 'Trotec found on ' + esc(ui.ports.find((p) => p.trotec).path) : 'No Trotec found on USB right now') + '</span></span><select class="cell" data-f="connection.port">' + portOpts.map(([v, l]) => '<option value="' + esc(v) + '"' + (v === curPort ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select></label>';

  const tabs = { Machine: [], Network: [], 'Work area': [], Controller: [], Jobs: [] };
  tabs.Network.push(networkCard(card), card('Pathline connection', num('HTTP port', 'httpPort', '', 'Takes effect after a restart') +
    '<div class="row"><span>This screen is showing</span><span class="mono">' + esc(location.host) + '</span></div>',
  'Use the same port in Pathline\'s machine setup.'));
  // Ruida: which controller model (sets laser or plotter, and the swizzle magic)
  const models = S.ruidaModels || [];
  const model = models.find((m) => m.id === d.ruida.model) || models.find((m) => m.id === 'OTHER') || { kind: 'laser', note: '' };
  const isPlotter = !trotec && model.kind === 'plotter';
  const group = (kind, title) => '<optgroup label="' + title + '">' + models.filter((m) => m.kind === kind && m.id !== 'OTHER').map((m) => '<option value="' + m.id + '"' + (m.id === model.id ? ' selected' : '') + '>' + esc(m.label) + '</option>').join('') + '</optgroup>';
  const modelSelect = trotec ? '' : '<label class="row"><span>Controller model<span class="hint">' + esc(model.note || '') + '</span></span><select class="cell" data-f="ruida.model">' +
    group('laser', 'Laser controllers') + group('plotter', 'Plotters and cutters') +
    '<option value="OTHER"' + (model.id === 'OTHER' ? ' selected' : '') + '>Other / not sure</option></select></label>';
  // plotter tools: which controller output (1–4) lowers each tool
  const heads = d.heads || [];
  const toolRows = heads.map((h, i) => '<div class="row" style="grid-template-columns:52px minmax(0,1fr) 150px 44px"><span class="mono" style="font-weight:600;color:var(--text)">' + esc(h.slot) + '</span>' +
    '<span class="fld"><input class="sans" data-f="heads.' + i + '.tool" value="' + esc(h.tool) + '" aria-label="' + esc(h.slot) + ' tool"></span>' +
    '<select class="cell" data-num="1" data-f="heads.' + i + '.output" aria-label="' + esc(h.slot) + ' output">' + [1, 2, 3, 4].map((o) => '<option value="' + o + '"' + (Number(h.output) === o ? ' selected' : '') + '>Output ' + o + '</option>').join('') + '</select>' +
    '<button class="ib" data-a="toolRemove" data-v="' + i + '" aria-label="Remove ' + esc(h.slot) + '" title="Remove ' + esc(h.slot) + '"' + (heads.length <= 1 ? ' disabled' : '') + '>' + ic('M6 6l12 12 M18 6L6 18', 18) + '</button></div>').join('') +
    '<div style="display:flex;align-items:center;gap:12px"><button class="tb sm" data-a="toolAdd"' + (heads.length >= 4 ? ' disabled' : '') + '>+ Add tool</button><span class="lbl">' + heads.length + ' of up to 4 tools (one per output)</span></div>';

  tabs.Machine.push(card('Machine', text('Name', 'name') +
    seg('Controller', 'controller', [['trotec', 'Trotec'], ['ruida', 'Ruida']]) +
    modelSelect +
    seg('Connection', 'connection.mode', modes) +
    (d.connection.mode === 'serial' ? portSelect : '') +
    (d.connection.mode === 'tcp' ? text('Host', 'connection.host') + num('TCP port', 'connection.tcpPort') : '') +
    (d.connection.mode === 'udp' ? text('Controller IP address', 'connection.ip', '', 'UDP 50200') +
      '<div style="display:flex;justify-content:flex-end"><button class="tb" data-a="findRuida"' + (ui.finding ? ' disabled' : '') + '>' + (ui.finding ? 'Searching…' : 'Find on network') + '</button></div>' : '') +
    (d.connection.mode === 'sim' ? num('Simulation speed', 'sim.speedup', '×', 'Jobs run this many times faster') : ''),
  trotec ? 'Close Ruby / JobDispatcher first: only one program can use the port.' : 'Close LightBurn or RDWorks while Pathline Run is connected.'));
  if (isPlotter) {
    tabs.Machine.push(card('Tools', '<div class="row" style="grid-template-columns:52px minmax(0,1fr) 150px 44px"><span class="lbl">Slot</span><span class="lbl">Tool</span><span class="lbl">Lowered by</span><span></span></div>' + toolRows +
      num('Tool down time', 'timing.toolDown', 's') + num('Tool up time', 'timing.toolUp', 's'),
    'Each tool is lowered by one controller output (a Ruida\'s laser tube outputs 1–4). Pathline\'s processes name the slot, e.g. "T2 · V-cut 45°".'));
  } else {
    tabs.Machine.push(card('Laser source', text('Type', 'source') + num('Rated power', 'power', 'W') + text('Lens', 'lens') + num('Minimum power', 'minPower', '%') +
      tog('Air assist', 'f.air') + tog('Lid interlock', 'f.interlock')));
  }
  tabs['Work area'].push(card('Bed', ctl('Width', 'bed.0', 'mm') + ctl('Height', 'bed.1', 'mm') + ctl('Max speed', 'speed', 'mm/s', 'Used by Pathline\'s time estimate') + ctl('Acceleration', 'acc', 'mm/s²')));
  if (isPlotter) {
    tabs['Work area'].push(card('Conveyor and vacuum', tog('Conveyor', 'f.conveyor') + (d.f.conveyor ? num('Feed length', 'feedLen', 'mm', 'Material advanced per bed (U axis)') + num('Feed time', 'timing.feedSettle', 's', 'For Pathline\'s estimate') : '') + tog('Vacuum', 'f.vacuum'),
      'Fed between the beds of a job that uses several.'));
  }
  if (trotec) {
    tabs.Controller.push(card('Trotec', num('Position unit', 'trotec.unit', 'mm') + num('Mechanical offset X', 'trotec.offset.0', 'mm') + num('Mechanical offset Y', 'trotec.offset.1', 'mm') +
      num('Travel speed', 'trotec.travelSpeed', 'mm/s') + num('Speed limit', 'trotec.maxSpeed', 'mm/s') + num('Engrave overscan', 'trotec.overscan', 'mm') +
      num('Power correction, cut', 'trotec.cutPowerCorrection', '%', 'Unless the process sets one') + num('Power correction, engrave', 'trotec.engravePowerCorrection', '%') +
      num('Laser source code', 'trotec.laserSource', '', '5 = CO2 (Q500 DC)') + num('Air assist output', 'trotec.airOutput'),
    'Factory calibration. Change only if your machine differs.'));
    tabs.Controller.push(card('Travel between cuts', seg('Travel', 'trotec.travel', [['standard', 'Standard'], ['faster', 'Faster'], ['fastest', 'Fastest']]),
      'How sharply the head starts and stops between cuts. Standard is what Ruby sends; Faster takes about 4 % off a job of many small parts, Fastest about 10 %. ' +
      'After changing it, check that print and cut still lines up.'));
  } else {
    tabs.Controller.push(card('Ruida', seg('Machine origin', 'ruida.origin', [['tl', 'Top left'], ['tr', 'Top right'], ['bl', 'Bottom left'], ['br', 'Bottom right']]) +
      num('Swizzle magic', 'ruida.magic', '', 'Set by the model (136 = 0x88 for most). Pathline Run also detects it from the controller\'s first reply.') +
      (S.info && S.info.cardId ? '<div class="row"><span>Connected controller</span><span class="mono">card 0x' + S.info.cardId.toString(16).toUpperCase() + ' · magic 0x' + S.info.magic.toString(16) + '</span></div>' : ''),
    'The corner the head homes to.'));
  }
  tabs.Jobs.push(card('Job defaults', (isPlotter ? '' : seg('Registration marks without the camera', 'regMarks', [['refuse', 'Don\'t run'], ['ignore', 'Skip']])) + tog('Remove completed job from queue', 'removeDone') + (isPlotter ? '' : tog('Return head to start after a job', 'returnHead')) + text('File name prefix', 'prefix'),
    isPlotter ? '' : 'With the head camera on, registration marks are read and the job is lined up to them.'));
  if (trotec) {
    tabs.Camera = [];
    const v = d.vision || {};
    const saved = !dirty && !!(cfg().vision || {}).enabled;
    const busy = S.camera.busy;
    const need = !saved ? ' disabled title="Turn the camera on and save first"' : busy ? ' disabled' : '';
    const [ma, mb, mc, md] = v.matrix || [0, 0.02, 0.02, 0];
    const pixel = Math.sqrt(Math.abs(ma * md - mb * mc));
    const turned = (Math.atan2(mc, ma) * 180) / Math.PI;
    const ro = (l, val) => '<div class="row"><span>' + l + '</span><span class="mono">' + val + '</span></div>';
    tabs.Camera.push(card('Head camera', tog('Camera on', 'vision.enabled') + seg('Camera', 'vision.source', [['vimba', 'Allied Vision (Vimba X)'], ['sim', 'Simulated']]) +
      seg('Exposure', 'vision.exposure', [['auto', 'Auto'], [Number(v.exposure) > 0 ? Number(v.exposure) : 100000, 'Fixed']]) +
      (v.exposure === 'auto' ? ro('Exposure now', S.camera.exposure ? (S.camera.exposure / 1000).toFixed(1) + ' ms' : '—') : num('Exposure time', 'vision.exposure', 'µs')) +
      tog('Camera light (laser parameter 186)', 'vision.light') + num('Re-centre a mark further than', 'vision.tolerance', 'mm', 'From the middle of the picture') +
      ro('Camera', S.camera.info ? esc(S.camera.info.model + ' · ' + S.camera.info.serial) : 'not opened yet'),
    'Plugs into this computer by USB, not the laser. Needs Allied Vision\'s Vimba X, with Ruby / JobDispatcher closed.'));
    const when = (t) => (t ? new Date(t).toLocaleString() : 'not yet');
    tabs.Camera.push(card('1 · Camera calibration', num('Checkerboard squares', 'vision.camBoard.square', 'mm', 'The small board, under the camera') +
      ro('Pixel size', (pixel * 1000).toFixed(2) + ' µm') + ro('Picture turned', turned.toFixed(2) + '°' + (ma * md - mb * mc < 0 ? ' (mirrored)' : '')) +
      ro('Lens bends lines', v.cameraLens !== undefined ? (v.cameraLens * 1000).toFixed(0) + ' µm at most' : '—') + ro('Calibrated', when(v.cameraAt)) +
      '<div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end"><button class="btn-primary" data-a="camCalibrate"' + need + '>Calibrate camera</button></div>',
    'Lay the ' + (get(d, 'vision.camBoard.square') || 10) + ' mm checkerboard flat, at any angle, and jog the head until the board fills the camera view. The head moves a few mm, then goes back.'));
    const stage2 = !v.cameraAt ? ' disabled title="Calibrate the camera (stage 1) first"' : need;
    tabs.Camera.push(card('2 · Offset calibration (cut check)', num('Camera offset X', 'vision.offset.0', 'mm', 'Laser − camera') + num('Camera offset Y', 'vision.offset.1', 'mm') +
      num('Cut power', 'vision.mark.power', '%', 'For the check mark') + num('Cut speed', 'vision.mark.speed', 'mm/s') +
      ro('Last cut check', v.offsetCheck !== undefined && v.offsetCheck !== null ? (v.offsetCheck * 1000).toFixed(0) + ' µm off · ' + when(v.offsetAt) : 'not yet') +
      '<div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end"><button class="btn-primary" data-a="camOffsetAsk"' + stage2 + '>Cut check: calibrate offset</button></div>',
    'Jog the laser head over scrap card or board. The laser cuts a 3 mm mark there, and the camera finds it to set the offset and check it.'));
    const b = ui.board;
    const map = v.map;
    tabs.Camera.push(card('Checkerboard: bed accuracy', num('Square size', 'vision.board.square', 'mm') + num('Corners across', 'vision.board.across', '', 'Inner corners (squares − 1)') + num('Corners down', 'vision.board.down') +
      num('Measure every', 'vision.board.every', '', '1 = every corner; 2, 3… for a quicker check') +
      seg('Correction', 'vision.board.model', [['linear', 'Scale and squareness'], ['smooth', 'Smooth'], ['full', 'Every corner']]) +
      tog('Correct jobs with the bed map', 'vision.mapOn') +
      ro('Bed map', map ? map.nx + ' × ' + map.ny + ' points every ' + map.step + ' mm' + (v.mapAt ? ' · ' + new Date(v.mapAt).toLocaleString() : '') : 'none yet') +
      '<div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end"><button class="tb" data-a="camBoard" data-v="check"' + need + '>Check bed</button><button class="btn-primary" data-a="camBoard" data-v="calibrate"' + need + '>Calibrate bed</button></div>' +
      (busy ? '<div class="warnbox">' + esc(S.status.message || busy) + '</div>' : '') +
      (b && b.points ? boardResult(b) : ''),
    'Lay the checkerboard on the bed at any angle and jog the laser head over its top-left inner corner. Check measures with the bed map on; Calibrate saves a new map. Use Every corner only with a board that is perfectly flat.'));
  }

  // the material settings Pathline Prepare keeps on this machine (GET /materials), read only:
  // they're made and changed in Prepare
  if (cfg().configured) {
    if (ui.mats === undefined) {
      ui.mats = 'loading';
      call('GET', API('/materials')).then((m) => { ui.mats = m; render(); }).catch((e) => { ui.mats = { error: e.message }; render(); });
    }
    const m = ui.mats;
    const list = m && m !== 'loading' && Array.isArray(m.materials) ? m.materials : [];
    tabs.Materials = m === 'loading' ? [card('Materials', '<span class="sr-only">Loading</span>' + [0, 1, 2].map(() => '<div class="row">' + sk('40%', '12px') + sk('70%', '12px') + '</div>').join(''))]
      : m && m.error ? [card('Materials', '<div class="warnbox">' + esc(m.error) + '</div>')]
        : !list.length ? [card('Materials', '<span class="lbl">None yet. Pathline Prepare sends them when it connects.</span>')]
          : list.map((x) => card('<span style="display:inline-flex;align-items:center;gap:10px"><span aria-hidden="true" style="width:14px;height:14px;border-radius:4px;flex:none;box-shadow:inset 0 0 0 1px var(--line-strong);background:' + esc(x.sw || 'var(--sunken)') + '"></span>' + esc(x.name || 'Unnamed') + '</span>',
            '<div class="row"><span>Thickness</span><span class="mono">' + (x.t !== undefined && x.t !== '' ? esc(x.t) + ' mm' : '—') + '</span></div>' +
            '<div class="row"><span>Group</span><span>' + esc(x.g || '—') + '</span></div>' +
            '<div style="display:flex;flex-direction:column;gap:6px">' + procRows({ processes: x.processes || [] }) + '</div>',
            x.updatedAt ? 'Changed ' + new Date(x.updatedAt).toLocaleString() : ''));
    if (list.length) tabs.Materials.unshift(card('Materials', '<span class="lbl">Made in Pathline Prepare. Change them there.</span>'));
  }

  const tab = tabs[ui.setTab] ? ui.setTab : 'Machine';
  // no machine yet: this page adds one (name, controller and connection on the Machine tab)
  const adding = !cfg().configured;
  // Ruida: fill in the work area, speeds and conveyor from what the controller reports
  const readBtn = trotec ? '' : '<button class="tb" data-a="readCtrl"' + (ui.reading ? ' disabled' : '') + '>' + (ui.reading ? 'Reading…' : 'Read from controller') + '</button>';
  return '<div class="view" style="padding:12px;display:flex;flex-direction:column;gap:12px">' +
    '<section class="card" style="padding:16px 18px;display:flex;flex-wrap:wrap;align-items:center;gap:14px"><span class="badge" style="height:28px;padding:0 9px;border-radius:6px' + (isPlotter ? ';background:var(--badge-plotter)' : '') + '">' + (isPlotter ? 'PLOTTER' : 'LASER') + '</span>' +
    (adding
      ? '<div style="flex:1 1 280px;min-width:0;display:flex;flex-direction:column;gap:4px"><span style="font-size:17px;font-weight:600">Add a machine</span><span class="lbl">Name it, choose the controller and connection, check the bed size under Work area, then Add machine.</span></div>' +
        readBtn + '<button class="btn-primary" data-a="save">Add machine</button></section>'
      : '<div style="flex:1 1 280px;min-width:0;display:flex;flex-direction:column;gap:4px"><span style="font-size:17px;font-weight:600">' + esc(d.name) + '</span><span class="lbl">' + (d.controller === 'ruida' ? 'Ruida' : 'Trotec') + ' · ' + esc(S.info.model || 'not connected') + (S.info.firmware ? ' · ' + esc(S.info.firmware) : '') + '</span></div>' +
        (dirty ? '<span class="tag warn">Unsaved changes</span><button class="tb" data-a="discard">Discard</button>' : '') +
        readBtn + '<button class="btn-primary" data-a="save"' + (dirty ? '' : ' disabled') + '>Save to machine</button></section>') +
    '<div role="tablist" aria-label="Setup sections" class="tabs">' + Object.keys(tabs).map((t) => '<button role="tab" aria-selected="' + (t === tab) + '" data-a="setTab" data-v="' + t + '">' + t + '</button>').join('') + '</div>' +
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:12px;align-items:start">' + tabs[tab].join('') + '</div></div>';
}

// the last checkerboard result: numbers, and each corner's error as an arrow over the bed
// (drawn 200× life size: a 0.5 mm error is a 100 mm arrow)
function boardResult(b) {
  const [W, H] = cfg().bed;
  const k = 200;
  const col = (e) => (e < 0.1 ? 'var(--ok-dot)' : e < 0.3 ? 'var(--warn-dot)' : 'var(--err-dot)');
  const arrows = b.points.map((p) => {
    const e = Math.hypot(p.res[0], p.res[1]);
    // corners a bump in the board moved: hollow and grey (left out of the map)
    if (p.out) return '<circle cx="' + p.at[0] + '" cy="' + p.at[1] + '" r="' + W / 150 + '" fill="none" stroke="var(--text-3)" vector-effect="non-scaling-stroke" style="stroke-width:1.5px"/>';
    return '<circle cx="' + p.at[0] + '" cy="' + p.at[1] + '" r="' + W / 150 + '" fill="' + col(e) + '"/><line x1="' + p.at[0] + '" y1="' + p.at[1] + '" x2="' + (p.at[0] + p.res[0] * k) + '" y2="' + (p.at[1] + p.res[1] * k) + '" stroke="' + col(e) + '" vector-effect="non-scaling-stroke" style="stroke-width:2px"/>';
  }).join('');
  const n = (x, d) => Number(x).toFixed(d);
  const sgn = (x, d) => (x > 0 ? '+' : '') + n(x, d);
  return '<div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;font-size:13px">' +
    [['Worst', n(b.worst, 3) + ' mm'], ['RMS', n(b.rms, 3) + ' mm'], ['Corners', b.points.length + (b.missed ? ' (' + b.missed + ' missed)' : '')],
      ['X travel', sgn(b.scaleX, 2) + ' mm/m'], ['Y travel', sgn(b.scaleY, 2) + ' mm/m'], ['Y leans', sgn(b.squareness, 3) + '°'],
      ['Board bumps', (b.bumps || 0) + ' corner' + (b.bumps === 1 ? '' : 's') + ' left out'], ['Board misfit', b.noise !== undefined ? n(b.noise, 3) + ' mm' : '—'], ['Correction', { linear: 'Scale and squareness', smooth: 'Smooth', full: 'Every corner' }[b.model] || '—']]
      .map(([l, val]) => '<div style="display:flex;flex-direction:column;gap:2px;padding:8px;border-radius:8px;background:var(--surface-2)"><span class="lbl">' + l + '</span><span class="mono">' + val + '</span></div>').join('') + '</div>' +
    '<span class="lbl">' + (b.raw ? 'Machine as it is' : 'With the bed map on') + ' · board laid at ' + n(b.boardAngle, 2) + '° · ' + new Date(b.at).toLocaleString() + '</span>' +
    '<svg viewBox="' + [-20, -20, W + 40, H + 40].join(' ') + '" style="width:100%;aspect-ratio:' + (W + 40) + '/' + (H + 40) + ';background:var(--sunken);border-radius:8px" aria-label="Error at each corner, 200 times life size"><rect x="0" y="0" width="' + W + '" height="' + H + '" fill="var(--bed)" stroke="var(--bed-line)" vector-effect="non-scaling-stroke"/>' + arrows + '</svg>';
}

// ---------------------------------------------------------------- dialogs
function dialog() {
  if (!ui.dlg) return '';
  if (ui.dlg.kind === 'import') {
    return '<div class="scrim"><div role="dialog" aria-label="Import file" class="dlg"><span class="h-sec" style="font-size:18px">Import job</span>' +
      '<div style="display:flex;align-items:center;gap:12px;padding:14px;border:1.5px dashed var(--line-hover);border-radius:10px;background:var(--surface-2)">' + ic(ICON.file, 26) +
      '<span style="flex:1;min-width:0;display:flex;flex-direction:column;line-height:1.3"><span style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(ui.dlg.name || 'No file chosen') + '</span><span class="lbl">Pathline job (.cjob) or job package (.json)</span></span>' +
      '<label class="tb" style="position:relative;cursor:pointer">Choose file<input type="file" accept=".cjob,.json" data-a="file" aria-label="Choose file" style="position:absolute;inset:0;opacity:0;cursor:pointer"></label></div>' +
      '<span class="lbl">DXF, SVG and PDF: prepare them in Pathline first.</span>' +
      '<div style="display:flex;justify-content:flex-end;gap:8px"><button class="tb" data-a="close">Cancel</button><button class="btn-primary" data-a="importGo"' + (ui.dlg.data ? '' : ' disabled') + '>Add to queue</button></div></div></div>';
  }
  if (ui.dlg.kind === 'log') {
    return '<div class="scrim"><div role="dialog" aria-label="Diagnostics log" class="dlg wide"><span class="h-sec" style="font-size:18px">Diagnostics log</span><pre class="log">' + esc((ui.dlg.lines || []).join('\n')) + '</pre>' +
      '<div style="display:flex;justify-content:flex-end"><button class="tb" data-a="close">Close</button></div></div></div>';
  }
  if (ui.dlg.kind === 'about') {
    return '<div class="scrim"><div role="dialog" aria-label="About" class="dlg"><div style="display:flex;gap:14px;align-items:center"><img src="icon.svg" width="48" height="48" alt=""><div><div class="h-sec" style="font-size:18px">Pathline Run ' + esc(S.app) + '</div><span class="lbl">The machine side of Pathline</span></div></div>' +
      '<span style="color:var(--text-2);line-height:1.5">Receives jobs from Pathline over Ethernet (port ' + esc(cfg().httpPort) + '), converts them for Trotec or Ruida controllers, and runs them.</span>' +
      '<div style="display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap">' + (S.here ? '<button class="tb" data-a="checkUpdate">Check for updates…</button>' : '') + '<button class="tb" data-a="whatsNew">What\'s new</button><button class="btn-primary" data-a="close">Close</button></div></div></div>';
  }
  if (ui.dlg.kind === 'remove1' || ui.dlg.kind === 'remove2') {
    const name = esc(cfg().name);
    const busy = running();
    const first = ui.dlg.kind === 'remove1';
    return '<div class="scrim"><div role="dialog" aria-label="Remove machine" class="dlg">' +
      (first
        ? '<span class="h-sec" style="font-size:18px">Remove ' + name + '?</span><span style="color:var(--text-2);line-height:1.5">Pathline Run forgets this machine: its controller, connection, bed size and calibration values. Pathline can\'t send jobs here until a machine is added again.<br>Queued jobs and history stay.</span>'
        : '<span class="h-sec" style="font-size:18px">Are you sure?</span><span style="color:var(--text-2);line-height:1.5">' + name + '\'s setup will be deleted and can\'t be brought back. You\'d have to set it up again from the start.</span>') +
      (busy ? '<div class="errbox">A job is running. Stop it before removing the machine.</div>' : '') +
      '<div style="display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap"><button class="tb" data-a="close">' + (first ? 'Cancel' : 'Keep ' + name) + '</button>' +
      '<button class="btn-primary" data-a="' + (first ? 'removeAsk2' : 'removeGo') + '"' + (busy ? ' disabled' : '') + '>' + (first ? 'Remove machine' : 'Yes, remove it') + '</button></div></div></div>';
  }
  // Start refused: registration marks the camera can't reach. Stays up until closed (a passing
  // message was missed), with which way to move the sheet in large type
  if (ui.dlg.kind === 'reach') {
    const d = ui.dlg.d;
    const AR = { right: ICON.right, left: ICON.left, front: ICON.down, back: ICON.up };
    const big = d.wide
      ? '<div class="errbox" style="font-size:20px;font-weight:600">' + esc(d.title || 'The marks are too far apart for the camera') + '</div>'
      : (d.moves || []).map((m) => '<div style="display:flex;align-items:center;gap:14px;padding:14px 16px;border-radius:12px;background:var(--warn-soft);color:var(--warn)">' + ic(AR[m.dir], 44) +
        '<span style="font-size:26px;font-weight:600;line-height:1.2">Move the sheet ' + m.mm + ' mm to the ' + esc(m.dir) + '</span></div>').join('');
    return '<div class="scrim"><div role="alertdialog" aria-label="Registration marks out of the camera\'s reach" class="dlg">' +
      '<span class="h-sec" style="font-size:18px">' + esc(d.title || 'The camera can\'t reach the registration marks') + '</span>' + big +
      '<span style="color:var(--text-2);line-height:1.5">' + (d.why || []).map(esc).join('<br>') + '</span>' +
      '<span style="line-height:1.5">' + esc(d.wide || d.then) + '</span>' +
      '<span class="lbl">' + esc(d.job || '') + '</span>' +
      '<div style="display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap"><button class="tb" data-a="reachJog">Open Jog</button><button class="btn-primary" data-a="close">OK</button></div></div></div>';
  }
  if (ui.dlg.kind === 'readback') {
    const r = ui.dlg.r;
    const s = r.suggest || {};
    const uses = [s.bed && 'work area', s.speed && 'max speed', s.acc && 'acceleration', s.feedSpeed && 'conveyor speed'].filter(Boolean);
    return '<div class="scrim"><div role="dialog" aria-label="Read from controller" class="dlg" style="max-width:600px"><span class="h-sec" style="font-size:18px">Read from the controller</span>' +
      '<div>' + r.rows.map((x) => '<div style="display:grid;grid-template-columns:200px minmax(0,1fr);gap:10px;padding:7px 0;border-bottom:1px solid var(--line-soft)"><span class="lbl">' + esc(x.label) + '</span><span><span class="mono">' + esc(x.value) + '</span> <span class="lbl">' + esc(x.unit) + (x.note ? ' · ' + esc(x.note) : '') + '</span></span></div>').join('') + '</div>' +
      '<span class="lbl">' + (uses.length ? 'Use these values fills in the ' + uses.join(', ') + '. Nothing is saved until you save the setup.' : 'Nothing here can be filled in automatically.') + '</span>' +
      '<div style="display:flex;justify-content:flex-end;gap:8px"><button class="tb" data-a="close">Close</button>' + (uses.length ? '<button class="btn-primary" data-a="useRead">Use these values</button>' : '') + '</div></div></div>';
  }
  // Setup → Camera → Calibrate offset: the laser fires, so say where and how hard first
  if (ui.dlg.kind === 'camOffset') {
    const v = cfg().vision, p = S.status.pos;
    return '<div class="scrim"><div role="dialog" aria-label="Cut check: calibrate the camera offset" class="dlg"><span class="h-sec" style="font-size:18px">Cut check: fire the laser?</span>' +
      '<span style="color:var(--text-2);line-height:1.5">The laser cuts a small 3 mm mark where the head is now (X ' + p.x.toFixed(1) + ', Y ' + p.y.toFixed(1) + ' mm) at <b>' + v.mark.power + ' %</b> and <b>' + v.mark.speed + ' mm/s</b>. The camera finds it, sets the offset, and checks it. Put scrap card or board under the head, focus, and close the lid.</span>' +
      '<div style="display:flex;justify-content:flex-end;gap:8px"><button class="tb" data-a="close">Cancel</button><button class="btn-primary" data-a="camOffset">Cut and calibrate</button></div></div></div>';
  }
  if (ui.dlg.kind === 'found') {
    const l = ui.dlg.list;
    return '<div class="scrim"><div role="dialog" aria-label="Ruida controllers found" class="dlg" style="max-width:600px"><span class="h-sec" style="font-size:18px">Ruida controllers on the network</span>' +
      (l.length
        ? '<div>' + l.map((f, i) => '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line-soft)"><span style="flex:1;min-width:0"><span class="mono">' + esc(f.ip) + '</span> <span class="lbl">' + (f.card ? 'card ' + esc(f.card) + ' · ' : '') + 'magic 0x' + f.magic.toString(16).toUpperCase() + (f.via ? ' · via ' + esc(f.via) : '') + '</span></span><button class="tb sm" data-a="useFound" data-v="' + i + '">Use</button></div>').join('') + '</div>'
        : '<span class="lbl">No Ruida controller answered. Check it is switched on and cabled to this computer, that this computer\'s Ethernet has an address on the same network as the controller (Setup → Network), and that LightBurn, RDWorks and RDCutting are closed.</span>') +
      '<div style="display:flex;justify-content:flex-end;gap:8px"><button class="tb" data-a="close">Close</button></div></div></div>';
  }
  if (ui.dlg.kind === 'update') return updateWindow();
  if (ui.dlg.kind === 'changelog') return changelogWindow(ui.dlg.entries, ui.dlg.title);
  if (ui.dlg.kind === 'message') return messageWindow(ui.dlg.title, ui.dlg.msg);
  return '';
}

// ---------------------------------------------------------------- render + events
// the screen before the first answer from the server: the queue's own panels, greyed
const sk = (w, h, cls) => '<span class="skel' + (cls ? ' ' + cls : '') + '" style="width:' + w + (h ? ';height:' + h : '') + '"></span>';
function loadingView() {
  const col = (gap, inner, extra) => '<div style="display:flex;flex-direction:column;gap:' + gap + 'px' + (extra || '') + '">' + inner + '</div>';
  const swRow = (w) => '<div style="display:flex;align-items:center;gap:12px;min-height:44px">' + sk('48px', '28px', 'ctl') + sk(w, '14px') + '</div>';
  const procRow = (w) => '<div style="display:flex;align-items:center;gap:10px;min-height:34px;border-bottom:1px solid var(--line-soft)">' + sk('20px', '20px') + sk(w, '12px') + '<span style="flex:1"></span>' + sk('150px', '11px') + '</div>';
  return '<div class="view fit qview" role="status" aria-live="polite"><span class="sr-only">Connecting to Pathline Run…</span>' +
    '<aside class="card qlist" aria-hidden="true"><div style="display:flex;align-items:center;gap:8px;padding:14px 14px 10px">' + sk('64px', '16px') + '<span style="flex:1"></span>' + sk('92px', '40px', 'ctl') + '</div>' +
    col(8, ['70%', '56%', '64%'].map((w) => '<div class="jobcard" style="flex-direction:column;gap:8px">' + sk('100%', '110px') + sk(w, '14px') + sk('46%', '10px') + '</div>').join(''), ';padding:0 12px 12px') + '</aside>' +
    '<main class="card qmain" aria-hidden="true"><div class="qtop"><div class="qinfo">' + col(8, sk('62%', '26px') + sk('44%', '12px')) +
    col(2, swRow('150px') + swRow('230px'), ';padding-bottom:8px;border-bottom:1px solid var(--line-soft)') + col(6, procRow('96px') + procRow('110px') + procRow('84px')) + '</div>' +
    '<div class="qbed"><div class="viewport" style="flex:1;min-height:0;border:1px solid var(--line);border-radius:10px"></div></div></div>' +
    '<div class="qrun">' + sk('64px', '64px', 'ctl') + sk('64px', '64px', 'ctl') + sk('110px', '64px', 'ctl') + col(8, sk('100%', '14px') + sk('36%', '12px'), ';flex:1 1 280px;min-width:0') + '</div></main></div>';
}

// dialogs, menus and toasts animate in on the render that opens them only (the screen is
// redrawn every 0.7 s, and would replay it each time)
function markOpened(headerOnly) {
  const was = ui.opened || {};
  const now = { nav: !!ui.navOpen, mach: !!ui.machOpen, dlg: headerOnly ? was.dlg : ui.dlg ? ui.dlg.kind : '', toast: headerOnly ? was.toast : ui.toast ? ui.toast.msg : '' };
  const add = (sel) => { const el = $app.querySelector(sel); if (el) el.classList.add('in'); };
  if (now.nav && !was.nav) add('[role="menu"].pop');
  if (now.mach && !was.mach) add('[aria-label="Machine status"].pop');
  if (now.dlg && now.dlg !== was.dlg) add('.scrim');
  if (now.toast && now.toast !== was.toast) add('.toast');
  ui.opened = now;
}

function render() {
  $app.dataset.theme = ui.dark ? 'dark' : 'light';
  // looping animations (the busy dots) keep their phase across redraws: each starts as if at page load
  $app.style.setProperty('--clock', -Math.round(performance.now()) + 'ms');
  if (!S) {
    const first = !ui.loadShown;
    ui.loadShown = true;
    $app.innerHTML = header() + loadingView();
    // shown only if loading takes a moment, so a quick start doesn't flash it
    if (first) { const v = $app.querySelector('.qview'); if (v) v.style.animation = 'plr-fade .24s ease-out .12s both'; }
    return;
  }
  // don't redraw the setup form under the operator's fingers while a field has focus
  // (only fields you type in or pick from: a switch or a choice button that keeps focus must still redraw)
  const ae = document.activeElement;
  const focused = ae && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName) && ae.dataset && (ae.dataset.f || ae.dataset.n);
  if (ui.view === 'setup' && focused) { const h = $app.querySelector('header'); if (h) h.outerHTML = header(); markOpened(true); return; }
  // every part that scrolls keeps its place: the screen is redrawn every 0.7 s, and the job's
  // process list (a test grid has dozens) went back to the top each time, so it couldn't be scrolled
  const scrollers = '.view, [data-keep], .dlg, pre.log';
  const keyOf = (el) => el.dataset.keep || el.className;
  const scroll = {};
  if (ui.drawn === ui.view) for (const el of $app.querySelectorAll(scrollers)) scroll[keyOf(el)] = el.scrollTop;
  ui.drawn = ui.view;
  const v = ui.view === 'jog' ? jogView() : ui.view === 'history' ? historyView() : ui.view === 'setup' ? setupView() : queueView();
  const t = ui.toast;
  // the artwork already drawn (artFill puts it back)
  const old = new Map();
  for (const g of $app.querySelectorAll('g[data-art]')) { if (!old.has(g.dataset.art)) old.set(g.dataset.art, []); old.get(g.dataset.art).push(g); }
  $app.innerHTML = header() + v + dialog() + (t ? '<div class="toast" role="status" style="display:flex;align-items:center;gap:14px">' + esc(t.msg) +
    (t.action ? '<button class="tb sm" data-a="toastAction">' + esc(t.action) + '</button>' : '') + '</div>' : '');
  artFill(old);
  for (const el of $app.querySelectorAll(scrollers)) if (keyOf(el) in scroll) el.scrollTop = scroll[keyOf(el)];
  markOpened(false);
  drawCam();
}

// ---------------------------------------------------------------- head camera picture
// Jog → Camera: the latest frame (grey bytes from /camera/frame), redrawn after every render,
// fetched again about twice a second while it's showing
function drawCam() {
  const cv = document.getElementById('camview');
  if (!cv || !ui.cam) return;
  const { w, h, data } = ui.cam;
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  const im = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) { im.data[i * 4] = im.data[i * 4 + 1] = im.data[i * 4 + 2] = data[i]; im.data[i * 4 + 3] = 255; }
  ctx.putImageData(im, 0, 0);
  // the centre crosshair: what the camera reads marks against
  ctx.strokeStyle = 'rgba(214,40,40,0.9)'; ctx.lineWidth = Math.max(1, w / 240);
  ctx.beginPath(); ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(w / 2, h / 2, w / 12, 0, Math.PI * 2); ctx.stroke();
}
async function camLoop() {
  const on = S && S.config.controller === 'trotec' && S.config.vision && S.config.vision.enabled && ui.view === 'jog' && ui.live && !S.camera.busy && (S.status.state !== 'running' || !!S.status.markWait);
  if (on) {
    try {
      const r = await fetch(LOCAL('/camera/frame') + '?size=480', { cache: 'no-store' });
      if (r.ok) { const b = new Uint8Array(await r.arrayBuffer()); ui.cam = { w: (b[0] << 8) | b[1], h: (b[2] << 8) | b[3], data: b.subarray(4) }; ui.camErr = null; drawCam(); }
      else { ui.camErr = ((await r.json().catch(() => ({}))).error) || 'No picture'; ui.live = false; render(); }
    } catch (e) { ui.camErr = e.message; }
  }
  setTimeout(camLoop, on ? 400 : 800);
}
setTimeout(camLoop, 1000);

const H = {
  nav: () => { ui.navOpen = !ui.navOpen; ui.machOpen = false; render(); },
  // the machine name, top right: status and connection details
  machMenu: () => { ui.machOpen = !ui.machOpen; ui.navOpen = false; if (ui.machOpen && !ui.net) loadNetwork(); render(); },
  go: (v) => { ui.view = v; ui.navOpen = false; if (v === 'setup') { ui.draft = null; ui.netDraft = null; loadPorts(); loadNetwork(); } render(); },
  theme: () => { ui.dark = !ui.dark; ui.themeSet = true; try { localStorage.setItem('plr-theme', ui.dark ? 'dark' : 'light'); } catch (e) { /* ignore */ } render(); },
  sel: (id) => { ui.sel = id; refresh(); },
  up: act(async (id) => move(id, -1)),
  down: act(async (id) => move(id, 1)),
  remove: act(async () => { if (ui.sel) await call('DELETE', API('/jobs/' + encodeURIComponent(ui.sel))); }),
  startPause: act(async () => {
    try { await H.startRun(); } catch (e) {
      // marks out of the camera's reach: a dialog that stays, not a passing message
      if (e.detail && e.detail.kind === 'reach') { ui.dlg = { kind: 'reach', d: e.detail }; render(); return; }
      throw e;
    }
  }),
  // (startPause's work; not a button of its own)
  startRun: async () => {
    const s = S.status.state;
    if (s === 'running') return call('POST', API('/pause'), {});
    if (s === 'paused') return call('POST', API('/resume'), {});
    // Select mode: the ticked jobs, one after another, in queue order
    if (ui.multi) {
      const ids = visibleQueue().filter((j) => j.status === 'queued' && ui.picked.includes(j.id)).map((j) => j.id);
      const r = await call('POST', API('/start'), { ids });
      if (r.message) toast(r.message); else if (ids.length > 1) toast('Running ' + ids.length + ' jobs, one after another');
      ui.multi = false; ui.picked = [];
      return;
    }
    // a completed job kept in the queue: queue it again first
    const sel = S.jobs.find((j) => j.id === ui.sel);
    // (keeping Anchor to toolhead if it was switched on for this run)
    if (sel && sel.status === 'done') { await call('POST', LOCAL('/jobs/' + encodeURIComponent(sel.id) + '/requeue'), { keepAnchor: true }); await refresh(); }
    // Start runs the next queued job: put the selected one first
    const ids = visibleQueue().filter((j) => j.status === 'queued').map((j) => j.id);
    if (ui.sel && ids[0] !== ui.sel) await call('POST', API('/jobs/order'), { ids: [ui.sel].concat(ids.filter((i) => i !== ui.sel)) });
    const r = await call('POST', API('/start'), {});
    if (r.message) toast(r.message);
  },
  stop: act(async () => call('POST', API('/stop'), {})),
  frame: act(async () => {
    const id = running() ? S.status.job : ui.sel;
    let b = jobBox(ui.pkgs[id]);
    if (!b) throw new Error('Select a job to frame');
    // anchored to the head, not started yet: where it will go if Start is pressed now (its
    // top-left corner at the head, registration marks included; print and cut: its top-left mark,
    // as src/job/anchor.js)
    const j = S.jobs.find((x) => x.id === id);
    if (j && j.anchorAtStart && !j.anchor && Number.isFinite(S.status.pos.x)) {
      let x0 = b[0], y0 = b[1], mark = null;
      for (const s of ui.pkgs[id].toolpath || []) if (s.at) { x0 = Math.min(x0, s.at[0]); y0 = Math.min(y0, s.at[1]); }
      for (const s of ui.pkgs[id].toolpath || []) if (s.type === 'inspect' && s.at && (!mark || s.at[0] + s.at[1] < mark[0] + mark[1])) mark = s.at;
      if (mark) { x0 = mark[0]; y0 = mark[1]; }
      const dx = S.status.pos.x - x0, dy = S.status.pos.y - y0;
      b = [b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy];
    }
    await call('POST', API('/frame'), { box: b });
  }),
  removeDone: act(async () => call('PUT', LOCAL('/config'), { removeDone: !cfg().removeDone })),
  multi: () => { ui.multi = !ui.multi; ui.picked = []; render(); },
  // head camera
  camLive: () => { ui.live = !ui.live; ui.camErr = null; if (!ui.live) ui.cam = null; render(); },
  camGoto: act(async (v) => call('POST', LOCAL('/camera/goto'), { to: v })),
  // print and cut: the waiting mark is under the crosshair; back to the queue to watch the job
  markAccept: act(async () => { await call('POST', API('/marks/accept'), {}); ui.view = 'queue'; }),
  camCalibrate: act(async () => {
    const r = await call('POST', LOCAL('/camera/calibrate'), {});
    toast('Camera calibrated on ' + r.corners + ' corners: pixel size ' + (r.pixel * 1000).toFixed(2) + ' µm, picture turned ' + r.rotation.toFixed(2) + '°' + (r.mirrored ? ' (mirrored)' : '') + ': saved', { ms: 8000 });
    ui.draft = null;
  }),
  camOffsetAsk: () => { ui.dlg = { kind: 'camOffset' }; render(); },
  camOffset: act(async () => {
    ui.dlg = null; render();
    const r = await call('POST', LOCAL('/camera/offset'), { power: cfg().vision.mark.power, speed: cfg().vision.mark.speed });
    toast('Camera offset X ' + r.offset[0].toFixed(3) + ', Y ' + r.offset[1].toFixed(3) + ' mm: saved' + (r.check !== null ? '. Cut check: ' + (r.check * 1000).toFixed(0) + ' µm off' : ''), { ms: 10000 });
    ui.draft = null;
  }),
  camBoard: act(async (v) => {
    ui.board = await call('POST', LOCAL('/camera/board'), { mode: v });
    const b = ui.board;
    toast((v === 'calibrate' ? 'Bed map saved. ' : '') + b.points.length + ' corners: worst ' + b.worst.toFixed(3) + ' mm, X ' + b.scaleX.toFixed(2) + ' / Y ' + b.scaleY.toFixed(2) + ' mm/m', { ms: 10000 });
    ui.draft = null;
  }),
  pick: (id) => { ui.picked = ui.picked.includes(id) ? ui.picked.filter((x) => x !== id) : ui.picked.concat(id); ui.sel = id; refresh(); },
  // Setup: put a setting back to the controller's own value
  resetCtl: (p) => { set(ui.draft, p, S.fromController[p]); render(); },
  // pin the selected job's top-left corner to where the head is now (or put it back)
  anchor: act(async (v) => {
    if (!ui.sel) return;
    const r = await call('POST', LOCAL('/jobs/' + ui.sel + '/anchor'), v === 'clear' ? { clear: true } : {});
    delete ui.pkgs[ui.sel]; // reload the preview where it now sits
    toast(r.atStart ? 'Anchored: the job starts where the head is when you press Start' : 'Anchor cleared: the job runs where Pathline placed it');
  }),
  jog: act(async (v) => call('POST', API('/jog'), { axis: v[0], distance: (v[1] === '-' ? -1 : 1) * Number(ui.step) })),
  step: (v) => { ui.step = v; render(); },
  zoomIn: () => zoomBed(1.5),
  zoomOut: () => zoomBed(1 / 1.5),
  zoomFit: () => { ui.zoom = { k: 1, cx: NaN, cy: NaN }; render(); },
  home: act(async () => call('POST', API('/home'), {})),
  feed: act(async () => { const r = await call('POST', API('/feed'), {}); toast('Conveyor fed ' + r.fed + ' mm'); }),
  io: act(async (k) => call('POST', API('/io'), { [k]: !S.status.io[k] })),
  simLid: act(async () => call('POST', LOCAL('/sim/lid'), { open: !S.status.interlock })),
  hist: (v) => { ui.histFilter = v; render(); },
  rerun: act(async (id) => { const j = await call('POST', LOCAL('/jobs/' + id + '/requeue'), {}); ui.sel = j.id; ui.view = 'queue'; }),
  setTab: (v) => { ui.setTab = v; if (v === 'Network') { ui.netDraft = null; loadNetwork(); } if (v === 'Materials') ui.mats = undefined; render(); },
  netMode: (v) => { ui.netDraft.mode = v; render(); },
  netApply: async () => {
    const d = ui.netDraft;
    const what = d.mode === 'dhcp' ? 'automatic (DHCP)' : d.ip + ' / ' + d.mask + (d.gateway ? ', gateway ' + d.gateway : '');
    if (!window.confirm('Set "' + d.adapter + '" to ' + what + '?\n\nPathline loses the connection until it uses the new address.')) return;
    ui.net = { ...ui.net, busy: true };
    render();
    try {
      ui.net = await call('POST', LOCAL('/network'), d);
      ui.netDraft = null;
      toast('IP address set');
    } catch (e) { ui.net = { ...ui.net, busy: false }; toast(e.message); }
    render();
  },
  setv: (v, el) => {
    let val = JSON.parse(v);
    const f = el.dataset.f;
    if (f === 'controller' && val !== ui.draft.controller) {
      // switching controller: start from that controller's preset, keep the name
      const keep = { name: ui.draft.name, httpPort: ui.draft.httpPort };
      return call('GET', LOCAL('/presets')).then((p) => { ui.draft = { ...p[val], ...keep }; render(); });
    }
    set(ui.draft, f, val);
    render();
  },
  discard: () => { ui.draft = null; render(); },
  save: act(async () => {
    const adding = !cfg().configured;
    const r = await call('PUT', LOCAL('/config'), { ...ui.draft, configured: true });
    S.config = r.config; // so the form shows what was saved, not the settings from before
    ui.draft = null;
    toast(adding ? 'Machine added. Connecting to the controller…' : 'Saved. Reconnecting to the controller…');
  }),
  // Setup → Tools: as many tools as the plotter has (1–4). A new tool takes the next free
  // slot (T1…T4) and output; removing one leaves the other slots' names as they are.
  toolAdd: () => {
    const heads = (ui.draft.heads || []).slice();
    if (heads.length >= 4) return;
    const slot = ['T1', 'T2', 'T3', 'T4'].find((s) => !heads.some((h) => h.slot === s));
    const output = [1, 2, 3, 4].find((o) => !heads.some((h) => Number(h.output) === o)) || 1;
    heads.push({ slot, tool: 'Tool ' + slot.slice(1), output });
    heads.sort((a, b) => a.slot.localeCompare(b.slot));
    ui.draft.heads = heads;
    render();
  },
  toolRemove: (v) => {
    const heads = (ui.draft.heads || []).slice();
    if (heads.length <= 1) return;
    heads.splice(Number(v), 1);
    ui.draft.heads = heads;
    render();
  },
  // Setup → Read from controller: show what it reports, then copy it into the form
  readCtrl: async () => {
    ui.reading = true; render();
    try { ui.dlg = { kind: 'readback', r: await call('POST', LOCAL('/machine/read'), ui.draft) }; } catch (e) { toast('Couldn\'t read the controller: ' + e.message, { ms: 8000 }); }
    ui.reading = false; render();
  },
  // Setup → Find on network: Ruida controllers that answer; pick one to fill in its IP
  findRuida: async () => {
    ui.finding = true; render();
    try { ui.dlg = { kind: 'found', list: (await call('POST', LOCAL('/ruida/find'))).found }; } catch (e) { toast('Couldn\'t search: ' + e.message, { ms: 8000 }); }
    ui.finding = false; render();
  },
  useFound: (v) => {
    const f = ui.dlg.list[Number(v)];
    set(ui.draft, 'connection.ip', f.ip);
    set(ui.draft, 'ruida.magic', f.magic);
    ui.dlg = null;
    toast('Controller ' + f.ip + ' filled in. ' + (cfg().configured ? 'Save to machine' : 'Add machine') + ' to connect.', { ms: 6000 });
  },
  useRead: () => {
    const s = (ui.dlg && ui.dlg.r && ui.dlg.r.suggest) || {};
    if (s.bed) set(ui.draft, 'bed', s.bed);
    if (s.speed) set(ui.draft, 'speed', s.speed);
    if (s.acc) set(ui.draft, 'acc', s.acc);
    if (s.feedSpeed) set(ui.draft, 'timing.feedSpeed', s.feedSpeed);
    ui.dlg = null;
    toast('Filled in from the controller. Check them, then ' + (cfg().configured ? 'Save to machine.' : 'Add machine.'), { ms: 6000 });
  },
  // ☰ → Remove machine: two confirmations, then the setup is forgotten
  removeMachine: () => { ui.navOpen = false; ui.dlg = { kind: 'remove1' }; render(); },
  removeAsk2: () => { ui.dlg = { kind: 'remove2' }; render(); },
  removeGo: act(async () => {
    const name = cfg().name;
    const r = await call('POST', LOCAL('/machine/remove'), {});
    S.config = r.config;
    ui.dlg = null; ui.draft = null;
    ui.view = 'setup';
    toast(name + ' was removed. Add a machine to use Pathline Run again.', { ms: 8000 });
  }),
  clearAlarm: act(async () => call('POST', LOCAL('/alarm/clear'), {})),
  reconnect: act(async () => call('POST', LOCAL('/reconnect'), {})),
  import: () => { ui.dlg = { kind: 'import' }; render(); },
  importGo: act(async () => { const r = await call('POST', LOCAL('/import'), ui.dlg.data); ui.dlg = null; ui.sel = r.id; ui.view = 'queue'; }),
  log: act(async () => { ui.navOpen = false; ui.dlg = { kind: 'log', lines: await call('GET', LOCAL('/log')) }; }),
  about: () => { ui.navOpen = false; ui.dlg = { kind: 'about' }; render(); },
  // ☰ → Check for updates: an update opens the update window; otherwise says what it found
  checkUpdate: act(async () => {
    ui.navOpen = false;
    const s = await call('POST', LOCAL('/update/check'), {});
    if (['available', 'downloading', 'ready'].includes(s.state)) { await refresh(); seenSeq = S.update.seq; ui.dlg = { kind: 'update' }; return; }
    const msg = {
      current: 'Pathline Run ' + s.version + ' is up to date.',
      none: 'No update information was found where this copy looks (' + (s.message || 'unknown address') + '). You have version ' + s.version + '. If the downloads have moved, install the latest version once from the download page.',
      off: 'Update checks aren\'t set up in this copy of Pathline Run (version ' + s.version + '). Copies run from the source folder update with git pull.',
      portable: 'This is the portable copy (version ' + s.version + '). It can\'t update itself: download the latest version from the releases page.',
      error: 'Couldn\'t check for updates: ' + (s.message || 'no connection') + '.'
    }[s.state];
    ui.dlg = { kind: 'message', title: 'Check for updates', msg };
  }),
  showUpdate: () => { ui.dlg = { kind: 'update' }; render(); },
  download: act(async () => { await call('POST', LOCAL('/update/download'), {}); ui.dlg = { kind: 'update' }; ui.toast = null; }),
  install: act(async () => { await call('POST', LOCAL('/update/install'), {}); ui.dlg = null; ui.toast = null; toast('Pathline Run is closing to install the update…', { ms: 20000 }); }),
  toastAction: (v, el) => { const a = ui.toast && ui.toast.onAction; ui.toast = null; if (a && H[a]) H[a](); else render(); },
  whatsNew: act(async () => { ui.navOpen = false; ui.dlg = { kind: 'changelog', title: 'What\'s new in Pathline Run', entries: await call('GET', LOCAL('/changelog')) }; }),
  close: () => { ui.dlg = null; render(); },
  reachJog: () => { ui.dlg = null; H.go('jog'); }
};

async function move(id, dir) {
  const ids = visibleQueue().filter((j) => j.status === 'queued').map((j) => j.id);
  const i = ids.indexOf(id);
  const k = i + dir;
  if (i < 0 || k < 0 || k >= ids.length) return;
  [ids[i], ids[k]] = [ids[k], ids[i]];
  await call('POST', API('/jobs/order'), { ids });
}

async function loadPorts() {
  try { ui.ports = await call('GET', LOCAL('/ports')); } catch (e) { ui.ports = []; }
  render();
}

// ---------------------------------------------------------------- jog arrows: tap or hold
// Shorter than 350 ms: one step of the chosen size. Longer: keep moving at that many mm/s,
// telling the machine every 200 ms; it stops on release (or by itself if we go quiet).
const HOLD_MS = 350;
function endHold(tap) {
  const h = ui.hold;
  if (!h) return;
  clearTimeout(h.timer);
  clearInterval(h.every);
  ui.hold = null;
  if (h.held) call('POST', LOCAL('/jog/release'), {}).catch(() => {});
  else if (tap) H.jog(h.axis + (h.dir < 0 ? '-' : '+'));
  render();
}
$app.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('[data-hold]');
  if (!el || el.disabled || e.button > 0) return;
  e.preventDefault();
  endHold(false);
  const v = el.dataset.hold;
  const h = { axis: v[0], dir: v[1] === '-' ? -1 : 1, held: false };
  const send = () => call('POST', LOCAL('/jog/hold'), { axis: h.axis, dir: h.dir, speed: Number(ui.step) }).catch((err) => { toast(err.message); endHold(false); });
  h.timer = setTimeout(() => { h.held = true; send(); h.every = setInterval(send, 200); render(); }, HOLD_MS);
  ui.hold = h;
});
document.addEventListener('pointerup', () => endHold(true));
document.addEventListener('pointercancel', () => endHold(false));
window.addEventListener('blur', () => endHold(false));
$app.addEventListener('contextmenu', (e) => { if (e.target.closest('[data-hold]')) e.preventDefault(); }); // long press on a touch screen

// bed view: one finger or the mouse drags, two fingers pinch, the wheel zooms at the pointer
const pan = { pts: new Map(), start: null };
$app.addEventListener('pointerdown', (e) => {
  const svg = e.target.closest('#bedview');
  if (!svg || e.button > 0) return;
  e.preventDefault();
  pan.pts.set(e.pointerId, [e.clientX, e.clientY]);
  pan.start = null; // restarts with the new set of fingers on the next move
});
document.addEventListener('pointermove', (e) => {
  if (!pan.pts.has(e.pointerId)) return;
  const svg = document.getElementById('bedview');
  if (!svg) { pan.pts.clear(); return; }
  pan.pts.set(e.pointerId, [e.clientX, e.clientY]);
  const pts = [...pan.pts.values()];
  const mid = pts.length > 1 ? [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2] : pts[0];
  const dist = pts.length > 1 ? Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]) : 0;
  if (!pan.start || pan.start.n !== pts.length) {
    const vb = bedViewBox();
    pan.start = { n: pts.length, mid, dist, k: ui.zoom.k, c: [vb[0] + vb[2] / 2, vb[1] + vb[3] / 2], scale: svg.getScreenCTM().a };
    return;
  }
  const s = pan.start;
  if (pts.length > 1 && s.dist > 0) {
    const f = (dist / s.dist) * s.k / ui.zoom.k;
    if (Math.abs(f - 1) > 0.01) zoomBed(f, bedPoint(svg, { clientX: mid[0], clientY: mid[1] }));
    const vb = bedViewBox();
    pan.start = { ...s, mid, dist, k: ui.zoom.k, c: [vb[0] + vb[2] / 2, vb[1] + vb[3] / 2], scale: svg.getScreenCTM().a };
    return;
  }
  if (ui.zoom.k === 1) return; // the whole bed is showing: nothing to pan to
  const [W, H] = cfg().bed;
  ui.zoom.cx = Math.max(0, Math.min(W, s.c[0] - (mid[0] - s.mid[0]) / s.scale));
  ui.zoom.cy = Math.max(0, Math.min(H, s.c[1] - (mid[1] - s.mid[1]) / s.scale));
  applyBedView();
});
const panEnd = (e) => { if (pan.pts.delete(e.pointerId)) pan.start = null; };
document.addEventListener('pointerup', panEnd);
document.addEventListener('pointercancel', panEnd);
$app.addEventListener('wheel', (e) => {
  const svg = e.target.closest('#bedview');
  if (!svg) return;
  e.preventDefault();
  zoomBed(Math.exp(-e.deltaY / 400), bedPoint(svg, e));
}, { passive: false });
$app.addEventListener('dblclick', (e) => { if (e.target.closest('#bedview')) H.zoomFit(); });

$app.addEventListener('click', (e) => {
  // keyboard (Enter/Space) on a jog arrow: one step
  const arrowEl = e.target.closest('[data-hold]');
  if (arrowEl) { if (e.detail === 0 && !arrowEl.disabled) H.jog(arrowEl.dataset.hold); return; }
  const el = e.target.closest('[data-a]');
  // the machine panel closes on a tap outside it, or on one of its buttons
  if (ui.machOpen && !(el && el.dataset.a === 'machMenu') && (!e.target.closest('[aria-label="Machine status"]') || el)) { ui.machOpen = false; if (!el) render(); }
  if (!el || el.tagName === 'INPUT' || el.disabled) return;
  const fn = H[el.dataset.a];
  if (fn) { e.preventDefault(); fn(el.dataset.v, el); }
  if (ui.navOpen && el.dataset.a !== 'nav' && el.dataset.a !== 'theme') { ui.navOpen = false; render(); }
});
$app.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.a === 'file') {
    const f = el.files && el.files[0];
    if (!f) return;
    f.text().then((t) => {
      try { ui.dlg = { kind: 'import', name: f.name, data: JSON.parse(t) }; } catch (err) { ui.dlg = { kind: 'import' }; toast('That file isn\'t a Pathline job'); }
      render();
    });
    return;
  }
  if (el.dataset.n && ui.netDraft) {
    ui.netDraft[el.dataset.n] = el.value.trim();
    if (el.dataset.n === 'adapter') {
      // a different adapter: start from what it has now
      const a = (ui.net.adapters || []).find((x) => x.name === el.value) || {};
      Object.assign(ui.netDraft, { connection: a.connection, mode: a.mode || 'dhcp', ip: (a.addresses && a.addresses[0] || {}).ip || '', mask: (a.addresses && a.addresses[0] || {}).mask || '255.255.255.0', gateway: a.gateway || '' });
    }
    el.blur();
    render();
    return;
  }
  if (el.dataset.f && ui.draft) {
    let v = el.value.trim();
    if (el.dataset.num) { v = Number(v.replace(',', '.')); if (!Number.isFinite(v)) { toast('Enter a number'); render(); return; } }
    set(ui.draft, el.dataset.f, v);
    // a Ruida model brings its machine type (laser or plotter) and swizzle magic
    if (el.dataset.f === 'ruida.model') {
      const m = (S.ruidaModels || []).find((x) => x.id === v);
      if (m) { ui.draft.type = m.kind; set(ui.draft, 'ruida.magic', m.magic); }
    }
    el.blur();
    render();
  }
});
$app.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.dataset && (e.target.dataset.f || e.target.dataset.n)) e.target.blur(); });
$app.addEventListener('focusout', (e) => { if (e.target.dataset && (e.target.dataset.f || e.target.dataset.n)) setTimeout(render, 0); });

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => { if (!ui.themeSet) { ui.dark = e.matches; render(); } });
render();
refresh().then(() => {
  // the first screen after an update shows what changed since the last version that ran
  if (S && S.here) {
    call('GET', LOCAL('/whatsnew')).then((list) => {
      if (list && list.length && !ui.dlg) { ui.dlg = { kind: 'changelog', title: 'Pathline Run has been updated to ' + list[0].version, entries: list }; render(); }
    }).catch(() => {});
  }
});
setInterval(refresh, 700);
// while a job runs and the queue is shown: the head's position alone, four times a second, in
// between (the whole state every 0.7 s left the head up to 1.5 s behind; the drawing moves on its own)
let statusBusy = false;
setInterval(async () => {
  if (statusBusy || !S || S.offline || !running() || ui.view !== 'queue') return;
  statusBusy = true;
  try {
    const st = await call('GET', API('/status'));
    if (S && st.job && st.job === S.status.job) { S.status = { ...S.status, ...st }; followHead(S.status, ui.pkgs[st.job]); }
  } catch (e) { /* the full refresh reports problems */ } finally { statusBusy = false; }
}, 250);

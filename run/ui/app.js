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
  trail: { job: null, pts: [] }, net: null, netDraft: null
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
  if (!r.ok) throw new Error(data.error || r.status + ' ' + r.statusText);
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
    S = next;
    S.offline = false;
    followUpdate(S.update);
    // trace the head while a job runs (a new job starts a new trace)
    const st = S.status;
    if (st.job && st.job !== ui.trail.job) ui.trail = { job: st.job, pts: [] };
    if (st.job && Number.isFinite(st.pos.x)) {
      const last = ui.trail.pts[ui.trail.pts.length - 1];
      if (!last || Math.hypot(last[0] - st.pos.x, last[1] - st.pos.y) > 0.5) ui.trail.pts.push([st.pos.x, st.pos.y]);
      if (ui.trail.pts.length > 4000) ui.trail.pts.splice(0, 1000);
    }
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
const visibleQueue = () => (S ? S.jobs.filter((j) => j.status === 'queued' || j.status === 'running') : []);
const cfg = () => S.config;
const running = () => S && (S.status.state === 'running' || S.status.state === 'paused');

// ---------------------------------------------------------------- drawing
function bedSvg(pkg, opts = {}) {
  const [W, H] = cfg().bed;
  let body = '';
  if (pkg && pkg !== 'loading') {
    if (pkg.sheet) body += '<rect x="' + pkg.sheet.x + '" y="' + pkg.sheet.y + '" width="' + pkg.sheet.w + '" height="' + pkg.sheet.h + '" fill="var(--sheet)" stroke="var(--bed-line)" stroke-width="' + W / 600 + '"/>';
    const sw = W / (opts.big ? 500 : 260);
    for (const e of pkg.entities || []) {
      const col = aciHex(e.aci);
      for (const p of e.paths || []) {
        const d = 'M' + p.p.map((q) => q[0].toFixed(2) + ' ' + q[1].toFixed(2)).join('L') + (p.c ? 'Z' : '');
        body += '<path d="' + d + '" fill="none" ' + (col ? 'stroke="' + col + '"' : 'class="ink"') + ' stroke-width="' + sw + '" vector-effect="non-scaling-stroke" style="stroke-width:' + (opts.big ? 1.5 : 1) + 'px"/>';
      }
    }
  }
  const r = Math.max(W, H) / 70;
  // where an anchored job's top-left corner was pinned (green, as in the design)
  if (opts.big && pkg && pkg.anchor) {
    body += '<circle cx="' + pkg.anchor.x + '" cy="' + pkg.anchor.y + '" r="' + r * 0.6 + '" fill="var(--bed)" stroke="#30A46C" stroke-width="' + r / 4 + '"/>';
  }
  // the path the head has travelled in this job
  if (opts.head && ui.trail.pts.length > 1) {
    body += '<polyline points="' + ui.trail.pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ') + '" fill="none" stroke="var(--accent)" stroke-opacity="0.45" vector-effect="non-scaling-stroke" style="stroke-width:1.5px" stroke-linejoin="round"/>';
  }
  // the toolhead: crosshair across the bed and a ring at its position
  if (opts.head && Number.isFinite(S.status.pos.x)) {
    const { x, y } = S.status.pos;
    body += '<line x1="' + x + '" y1="0" x2="' + x + '" y2="' + H + '" stroke="var(--accent)" stroke-opacity="0.35" vector-effect="non-scaling-stroke" stroke-dasharray="4 4" style="stroke-width:1px"/>' +
      '<line x1="0" y1="' + y + '" x2="' + W + '" y2="' + y + '" stroke="var(--accent)" stroke-opacity="0.35" vector-effect="non-scaling-stroke" stroke-dasharray="4 4" style="stroke-width:1px"/>' +
      '<circle cx="' + x + '" cy="' + y + '" r="' + r + '" fill="var(--accent-ring)" stroke="var(--accent)" stroke-width="' + r / 4 + '"/><circle cx="' + x + '" cy="' + y + '" r="' + r / 4 + '" fill="var(--accent)"/>';
  }
  return '<svg class="bedsvg" viewBox="0 0 ' + W + ' ' + H + '" style="aspect-ratio:' + W + '/' + H + '" preserveAspectRatio="xMidYMid meet" aria-hidden="true">' + body + '</svg>';
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
function header() {
  const st = S ? S.status : null;
  const dot = !S || S.offline || st.link !== 'online' || st.state === 'alarm' || st.interlock ? 'var(--err-dot)' : st.state === 'idle' ? 'var(--ok-dot)' : 'var(--warn-dot)';
  const views = [['queue', 'Queue', ICON.queue], ['jog', 'Jog', ICON.jog], ['history', 'History', ICON.history], ['setup', 'Setup', ICON.gear]];
  const nq = visibleQueue().length;
  const c = S ? cfg() : null;
  const conn = c ? (c.connection.mode === 'sim' ? 'Simulated' : c.connection.mode === 'udp' ? c.connection.ip : c.connection.mode === 'tcp' ? c.connection.host : c.connection.port) : '';
  return '<header class="hmi-bar">' +
    '<div style="display:flex;align-items:center;gap:10px"><div style="position:relative">' +
    '<button class="ib" data-a="nav" aria-label="Menu" aria-expanded="' + ui.navOpen + '">' + ic(ICON.menu) + '</button>' +
    (ui.navOpen ? '<div role="menu" class="pop" style="position:absolute;left:0;top:52px;min-width:230px">' +
      '<button role="menuitem" class="opt" data-a="go" data-v="setup">Machine setup</button>' +
      '<button role="menuitem" class="opt" data-a="log">Diagnostics log</button>' +
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
    (c ? '<div style="display:flex;align-items:center;gap:10px;height:48px;padding:0 12px 0 8px;border:1px solid var(--line-strong);border-radius:var(--ctl-r)">' +
      '<span class="badge">LASER</span><span style="display:flex;flex-direction:column;line-height:1.2"><span style="font-weight:600">' + esc(c.name) + '</span><span class="lbl">' + esc((c.controller === 'ruida' ? 'Ruida' : 'Trotec') + ' · ' + conn) + '</span></span>' +
      '<span aria-hidden="true" style="width:9px;height:9px;border-radius:50%;background:' + dot + '"></span></div>' : '') +
    '</div></header>';
}

// ---------------------------------------------------------------- updates (as in Pathline)
// The installed app checks when it opens and every 5 minutes. A found update
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
    inner = '<span class="h-sec" style="font-size:18px">Update available</span><span style="color:var(--text-2);line-height:1.5">Pathline Run ' + v + ' is available. You have version ' + esc(u.current) + '.<br>Download it now, then restart Pathline Run to install it.</span>' +
      btns([['Later', 'close'], ['Download and install', 'download', true]]);
  } else if (u.state === 'downloading') {
    const pct = Math.max(1, Math.min(100, u.percent || 0));
    inner = '<span class="h-sec" style="font-size:18px">Downloading Pathline Run ' + v + '</span>' +
      '<div role="progressbar" aria-valuenow="' + Math.round(pct) + '" style="height:12px;border-radius:6px;background:var(--sunken);box-shadow:inset 0 0 0 1px var(--line);overflow:hidden"><div style="height:100%;width:' + pct + '%;background:var(--accent);transition:width .3s ease-out"></div></div>' +
      '<span class="mono" style="color:var(--text-2)">' + Math.round(u.percent || 0) + ' %' + (u.total ? ' · ' + mb(u.transferred || 0) + ' of ' + mb(u.total) : '') + (u.bytesPerSecond ? ' · ' + mb(u.bytesPerSecond) + '/s' : '') + '</span>' +
      '<span class="lbl">The machine keeps working. Hide this window and you\'ll be told when the download has finished.</span>' + btns([['Hide', 'close']]);
  } else if (u.state === 'ready') {
    const busy = running();
    inner = '<span class="h-sec" style="font-size:18px">Update ready to install</span><span style="color:var(--text-2);line-height:1.5">Pathline Run ' + v + ' has downloaded. Restart to install it: Pathline Run closes, installs the update and opens again. Queued jobs and settings are kept.' +
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
function procRows(pkg) {
  return (pkg.processes || []).map((p) => {
    const pv = p.proc === 'Engrave' ? 'P ' + p.power + ' %  V ' + p.speed + ' mm/s  ' + p.f + ' DPI' : 'P ' + p.power + ' %  V ' + p.speed + ' mm/s' + (p.passes > 1 ? '  ×' + p.passes : '');
    return '<div style="display:flex;align-items:center;gap:10px;min-height:34px;padding:0 2px;border-bottom:1px solid var(--line-soft)">' +
      '<span style="display:flex;gap:3px">' + (p.aci || []).slice(0, 4).map((n) => '<span class="chip" title="ACI ' + n + '" style="background:' + (aciHex(n) || 'var(--text)') + ';color:' + (n === 7 ? 'var(--surface)' : aciFg(n)) + '">' + n + '</span>').join('') + '</span>' +
      '<span style="flex:1;min-width:0">' + esc(p.name) + '</span><span class="mono" style="font-size:13px;color:var(--text-2)">' + pv + '</span></div>';
  }).join('');
}

// top of the preview: where the toolhead is now (live while a job runs)
function headReadout(st, isRun) {
  const ok = Number.isFinite(st.pos.x) && st.link === 'online';
  const label = isRun ? (st.state === 'paused' ? 'Toolhead · paused' : 'Toolhead · processing') : 'Toolhead';
  return '<div style="position:absolute;left:12px;top:12px;display:flex;align-items:center;gap:10px;padding:6px 12px;border-radius:8px;background:var(--surface);box-shadow:var(--shadow-1);font-size:13px">' +
    '<span aria-hidden="true" style="width:10px;height:10px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 3px var(--accent-ring)' + (isRun && st.state === 'running' ? ';animation:plr-pulse 1.2s ease-in-out infinite' : '') + '"></span>' +
    '<span style="color:var(--text-2)">' + label + '</span>' +
    (ok ? '<span class="mono" style="font-weight:500">X ' + st.pos.x.toFixed(1) + '</span><span class="mono" style="font-weight:500">Y ' + st.pos.y.toFixed(1) + '</span><span class="lbl">mm</span>' : '<span class="lbl">position unknown</span>') + '</div>';
}

function queueView() {
  const st = S.status;
  const q = visibleQueue();
  const job = q.find((j) => j.id === ui.sel) || null;
  const pkg = job ? ui.pkgs[job.id] : null;
  const isRun = running();
  const runJob = isRun ? S.jobs.find((j) => j.id === st.job) : null;
  const shown = runJob || job;

  let status;
  if (S.offline) status = ['Pathline Run is not responding', 'err'];
  else if (st.state === 'alarm') status = ['Alarm', 'err'];
  else if (st.link !== 'online') status = ['Device not connected', 'err'];
  else if (st.interlock) status = ['Lid open', 'err'];
  else if (st.state === 'running') status = ['Running', 'accent'];
  else if (st.state === 'paused') status = ['Paused', 'warn'];
  else if (st.state === 'framing') status = ['Framing', 'warn'];
  else if (/^Finished/.test(st.message)) status = ['Job complete', 'ok'];
  else if (!job) status = ['Idle', ''];
  else status = ['Ready', 'ok'];

  const total = shown ? shown.seconds : 0;
  const frac = isRun ? st.progress : 0;
  const cantStart = !job || st.link !== 'online' || st.interlock || st.state === 'alarm' || st.state === 'framing';

  const list = q.map((j, i) => {
    const p = ui.pkgs[j.id];
    return '<div class="jobcard' + (j.id === ui.sel ? ' on' : '') + '">' +
      '<button class="pick" data-a="sel" data-v="' + j.id + '" aria-pressed="' + (j.id === ui.sel) + '">' + bedSvg(p) +
      '<span style="display:flex;flex-direction:column;gap:1px;line-height:1.3"><span style="font-weight:600">' + (i + 1) + '. ' + esc(j.name) + '</span>' +
      '<span class="lbl">' + esc(j.material || '—') + '</span><span class="lbl mono">' + stamp(j.receivedAt) + ' · ' + short(j.seconds) + '</span></span></button>' +
      (j.status === 'running' ? '<span class="pill accent" style="position:absolute;top:16px;right:16px;box-shadow:var(--shadow-1)">Running</span>'
        : '<div class="ord"><button class="ib" data-a="up" data-v="' + j.id + '" aria-label="Move up"' + (i === 0 ? ' disabled' : '') + '>' + ic(ICON.chevUp, 18) + '</button><button class="ib" data-a="down" data-v="' + j.id + '" aria-label="Move down"' + (i === q.length - 1 ? ' disabled' : '') + '>' + ic(ICON.chevDown, 18) + '</button></div>') +
      '</div>';
  }).join('');
  // thumbnails need packages too
  for (const j of q) if (!ui.pkgs[j.id]) { ui.pkgs[j.id] = 'loading'; call('GET', LOCAL('/jobs/' + j.id + '/package')).then((p) => { ui.pkgs[j.id] = p; render(); }).catch(() => { delete ui.pkgs[j.id]; }); }

  const shownPkg = shown ? ui.pkgs[shown.id] : null;
  const warn = shown && shown.warnings && shown.warnings.length ? '<div class="warnbox">' + shown.warnings.map(esc).join('<br>') + '</div>' : '';
  const alarm = st.state === 'alarm' ? '<div class="errbox"><span style="flex:1">' + esc(st.message) + '</span><button class="tb sm" data-a="clearAlarm">Clear alarm</button></div>'
    : st.link !== 'online' && !S.offline ? '<div class="errbox"><span style="flex:1">' + esc(st.message) + '</span><button class="tb sm" data-a="reconnect">Reconnect</button></div>' : '';
  const ctrlName = cfg().controller === 'ruida' ? 'Ruida' : 'Trotec';

  return '<div class="view" style="display:flex;gap:12px;padding:12px">' +
    '<aside aria-label="Job queue" class="card" style="flex:1 1 300px;min-width:0;max-width:420px;min-height:0;display:flex;flex-direction:column">' +
    '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:14px 14px 10px"><span class="h-sec">Queue</span><span class="lbl">' + q.length + (q.length === 1 ? ' job' : ' jobs') + '</span><span style="flex:1"></span>' +
    '<button class="tb sm" data-a="import">' + ic(ICON.upload, 16) + 'Import</button></div>' +
    '<div style="flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding:0 12px 12px">' + (list || '<div style="padding:28px 8px;text-align:center;color:var(--text-3)">Queue empty. Send a job from Pathline, or import a .cjob file.</div>') + '</div>' +
    '<div style="display:flex;gap:8px;padding:12px;border-top:1px solid var(--line)"><button class="tb" data-a="remove"' + (!job || job.status === 'running' ? ' disabled' : '') + '>' + ic(ICON.trash, 18) + 'Remove</button></div></aside>' +

    '<main class="card" style="flex:999 1 720px;min-width:0;display:flex;flex-direction:column">' +
    '<div style="flex:1;display:flex;flex-wrap:wrap;gap:24px;padding:22px">' +
    '<div style="flex:1 1 380px;min-width:0;display:flex;flex-direction:column;gap:14px">' +
    '<div style="display:flex;flex-direction:column;gap:4px"><h1 style="margin:0;font-size:28px;font-weight:600;line-height:1.2">' + esc(shown ? shown.name : 'No job selected') + '</h1>' +
    '<span style="color:var(--text-2)">' + esc(shown ? (shown.material || 'No material') + ' · ' + cfg().name + ' · ' + ctrlName : 'Choose a job from the queue') + '</span></div>' +
    alarm +
    (shownPkg && shownPkg !== 'loading' ? '<div style="display:flex;flex-direction:column;gap:6px">' + procRows(shownPkg) + '</div>' : '') + warn +
    '<div style="display:flex;margin-top:4px"><span class="pill lg ' + status[1] + '">' + status[0] + '</span></div>' +
    '<div style="display:flex;align-items:center;gap:12px;min-height:44px"><button role="switch" class="sw" aria-checked="' + !!cfg().removeDone + '" data-a="removeDone" aria-label="Remove completed job from queue"></button><span style="font-size:16px">Remove completed job from queue</span></div>' +
    // pin the job's top-left corner to where the head is now
    // (switching it on uses the head position at that moment; off puts the job back where Pathline placed it)
    (() => {
      const on = !!(job && job.anchor);
      const off = !job || isRun || (!on && st.link !== 'online');
      return '<div style="display:flex;align-items:center;gap:12px;min-height:44px"><button role="switch" class="sw" aria-checked="' + on + '" data-a="anchor"' + (on ? ' data-v="clear"' : '') + ' aria-label="Anchor to toolhead"' + (off ? ' disabled' : '') + '></button>' +
        '<span style="display:flex;flex-direction:column;gap:2px;line-height:1.3"><span style="font-size:16px">Anchor to toolhead</span>' +
        '<span class="lbl">' + (on ? 'The job\'s top-left corner starts at X ' + job.anchor.x.toFixed(1) + ', Y ' + job.anchor.y.toFixed(1) + ' mm' : 'Moves the job so its top-left corner starts at the head') + '</span></span></div>';
    })() +
    (shown ? '<div style="display:flex;gap:8px;flex-wrap:wrap"><a class="tb sm" href="' + LOCAL('/jobs/' + shown.id + '/export') + '">' + ic(ICON.download, 16) + 'Save ' + (cfg().controller === 'ruida' ? '.rd file' : 'Trotec stream') + '</a>' +
      '<a class="tb sm" href="' + LOCAL('/jobs/' + shown.id + '/export?format=txt') + '">' + ic(ICON.file, 16) + 'Code listing</a></div>' : '') +
    '</div>' +
    '<div style="flex:1 1 440px;min-width:0;display:flex;flex-direction:column;gap:10px"><div class="viewport" style="position:relative;min-height:320px;display:flex;align-items:center;justify-content:center;padding:52px 18px 18px;border:1px solid var(--line);border-radius:10px">' +
    headReadout(st, isRun) +
    '<div style="width:100%">' + bedSvg(shownPkg, { big: true, head: true }) + '</div></div>' +
    (shown && shownPkg && shownPkg.anchor ? '<span class="lbl" style="display:flex;align-items:center;gap:8px"><span style="width:10px;height:10px;border-radius:50%;border:2px solid #30A46C;background:var(--bed);flex:none"></span>Anchored: the job\'s top-left corner is at the toolhead position X ' + shownPkg.anchor.x.toFixed(1) + ', Y ' + shownPkg.anchor.y.toFixed(1) + ' mm</span>' : '') +
    '</div></div>' +

    '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:14px 18px;padding:16px 22px;border-top:1px solid var(--line)">' +
    '<button class="run-btn" data-a="startPause" aria-label="' + (st.state === 'running' ? 'Pause' : st.state === 'paused' ? 'Resume' : 'Start') + '"' + (!isRun && cantStart ? ' disabled' : '') + ' style="background:' + (st.state === 'running' ? 'var(--pause)' : 'var(--go)') + ';cursor:pointer">' + ic(st.state === 'running' ? ICON.pause : ICON.play, 28) + '</button>' +
    '<button class="run-btn stop" data-a="stop" aria-label="Stop" style="color:var(--err)">' + ic(ICON.stop, 24) + '</button>' +
    '<button class="tb" data-a="frame" style="height:64px;padding:0 18px"' + (!shown || isRun ? ' disabled' : '') + '>' + ic(ICON.frame) + 'Frame</button>' +
    '<div style="flex:1 1 280px;min-width:0;display:flex;flex-direction:column;gap:8px">' +
    // the bar, with the percentage complete at its end
    '<div style="display:flex;align-items:center;gap:12px"><div role="progressbar" aria-label="Job progress" aria-valuenow="' + Math.round(frac * 100) + '" aria-valuemin="0" aria-valuemax="100" style="flex:1;height:14px;border-radius:7px;background:var(--sunken);box-shadow:inset 0 0 0 1px var(--line);overflow:hidden"><div style="height:100%;width:' + (frac * 100).toFixed(1) + '%;background:var(--accent)"></div></div>' +
    '<span class="mono" style="min-width:52px;text-align:right;font-size:18px;font-weight:500;color:' + (isRun ? 'var(--text)' : 'var(--text-3)') + '">' + Math.floor(frac * 100) + ' %</span></div>' +
    '<div style="display:flex;justify-content:space-between;gap:8px"><span style="color:var(--text-2)">' + esc(isRun ? (st.state === 'paused' ? 'Paused' : 'Running') + ' · ' + st.message : st.message) + '</span><span class="mono" style="color:var(--text-2)">' + (isRun ? hms(frac * total) + ' / ' + hms(total) : 'Estimated ' + hms(total)) + '</span></div></div>' +
    '<div style="display:flex;flex-direction:column;align-items:flex-end"><span class="lbl">' + (isRun ? 'Remaining' : 'Estimated time') + '</span><span class="mono" style="font-size:60px;font-weight:500;line-height:1">' + hms(isRun ? total * (1 - frac) : total) + '</span></div>' +
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
  return '<div class="view" style="display:flex;flex-wrap:wrap;gap:12px;padding:12px;align-content:flex-start">' +
    '<section aria-label="Jog" class="card" style="flex:2 1 560px;min-width:0;padding:22px;display:flex;flex-direction:column;gap:20px"><h2 class="h-sec">Position</h2>' +
    '<div style="display:flex;flex-wrap:wrap;gap:36px">' + [['X', st.pos.x], ['Y', st.pos.y]].map(([l, v]) => '<div style="display:flex;flex-direction:column;gap:2px"><span class="lbl">' + l + ' <span class="mono">mm</span></span><span class="mono" style="font-size:36px;font-weight:500">' + (Number.isFinite(v) ? v.toFixed(1) : '—') + '</span></div>').join('') + '</div>' +
    '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:28px"><div style="display:grid;grid-template-columns:repeat(3,76px);grid-template-rows:repeat(3,76px);gap:8px">' +
    '<span></span>' + btn('jog', ICON.up, 'Jog Y minus').replace('data-a="jog"', 'data-a="jog" data-v="y-"') + '<span></span>' +
    btn('jog', ICON.left, 'Jog X minus').replace('data-a="jog"', 'data-a="jog" data-v="x-"') + btn('home', ICON.home, 'Home') + btn('jog', ICON.right, 'Jog X plus').replace('data-a="jog"', 'data-a="jog" data-v="x+"') +
    '<span></span>' + btn('jog', ICON.down, 'Jog Y plus').replace('data-a="jog"', 'data-a="jog" data-v="y+"') + '<span></span></div>' +
    '<div style="display:flex;flex-direction:column;gap:6px"><span class="lbl">Step</span><div role="radiogroup" aria-label="Step size" class="seg">' +
    ['0.1', '1', '10', '100'].map((v) => '<button role="radio" class="mono" style="min-width:56px" aria-checked="' + (ui.step === v) + '" data-a="step" data-v="' + v + '">' + v + '</button>').join('') + '</div></div></div></section>' +
    '<section aria-label="Machine" class="card" style="flex:1 1 360px;min-width:0;padding:22px;display:flex;flex-direction:column;gap:14px"><h2 class="h-sec">Machine</h2>' +
    '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px">' +
    '<button class="tb" style="height:52px" data-a="home">Home</button><button class="tb" style="height:52px" data-a="frame">Frame job</button>' +
    '<button class="tb" style="height:52px" data-a="goto0">Go to 0, 0</button><button class="tb" style="height:52px" data-a="stop">Stop</button></div>' +
    '<div class="hr" style="margin:4px 0"></div><h2 class="h-sec">Status</h2><div style="display:flex;flex-direction:column;gap:4px">' +
    pill('Controller', st.link === 'online' ? (S.info.model || 'Connected') : st.link === 'connecting' ? 'Connecting…' : 'Not connected', st.link === 'online') +
    (sim ? '<div style="display:flex;align-items:center;justify-content:space-between;min-height:48px;border-bottom:1px solid var(--line-soft)"><span>Lid closed (simulated)</span><button role="switch" class="sw" aria-checked="' + !st.interlock + '" data-a="simLid" aria-label="Lid closed"></button></div>'
      : pill('Lid', st.interlock ? 'Open' : c.f.interlock ? 'Closed' : 'Not monitored', !st.interlock)) +
    (c.f.air && c.controller === 'trotec' ? tog('Air assist', 'air') : '') +
    pill('State', st.state, st.state !== 'alarm') + '</div></section></div>';
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
  const seg = (l, path, opts) => '<div class="row"><span>' + l + '</span><div role="radiogroup" aria-label="' + l + '" class="seg" style="justify-self:start">' + opts.map(([v, t]) => '<button role="radio" aria-checked="' + (get(d, path) === v) + '" data-a="setv" data-f="' + path + '" data-v="' + esc(JSON.stringify(v)) + '">' + t + '</button>').join('') + '</div></div>';
  const tog = (l, path) => '<div class="row"><span>' + l + '</span><button role="switch" class="sw" style="justify-self:start" aria-checked="' + !!get(d, path) + '" data-a="setv" data-f="' + path + '" data-v="' + !get(d, path) + '"></button></div>';
  const card = (title, inner, note) => '<section class="card" style="padding:18px;display:flex;flex-direction:column;gap:10px"><h2 class="h-sec">' + title + '</h2>' + (note ? '<span class="lbl">' + note + '</span>' : '') + inner + '</section>';
  const trotec = d.controller === 'trotec';
  const modes = trotec ? [['serial', 'USB'], ['tcp', 'TCP'], ['sim', 'Simulated']] : [['udp', 'Network'], ['sim', 'Simulated']];
  const portList = ui.ports.length ? '<span class="hint">Found: ' + ui.ports.map((p) => esc(p.path) + (p.label ? ' (' + esc(p.label) + ')' : '')).join(', ') + '</span>' : '';

  const tabs = { Machine: [], Network: [], 'Work area': [], Controller: [], Jobs: [] };
  tabs.Network.push(networkCard(card), card('Pathline connection', num('HTTP port', 'httpPort', '', 'Takes effect after a restart') +
    '<div class="row"><span>This screen is showing</span><span class="mono">' + esc(location.host) + '</span></div>',
  'Pathline talks to Pathline Run on this port. Use the same port in Pathline\'s machine setup.'));
  tabs.Machine.push(card('Machine', text('Name', 'name') +
    seg('Controller', 'controller', [['trotec', 'Trotec'], ['ruida', 'Ruida']]) +
    seg('Connection', 'connection.mode', modes) +
    (d.connection.mode === 'serial' ? '<label class="row"><span>Serial port' + portList + '</span><span class="fld"><input class="mono" data-f="connection.port" value="' + esc(d.connection.port) + '"></span></label>' : '') +
    (d.connection.mode === 'tcp' ? text('Host', 'connection.host') + num('TCP port', 'connection.tcpPort') : '') +
    (d.connection.mode === 'udp' ? text('Controller IP address', 'connection.ip', '', 'UDP 50200') : '') +
    (d.connection.mode === 'sim' ? num('Simulation speed', 'sim.speedup', '×', 'Jobs run this many times faster') : ''),
  trotec ? 'Trotec classic controllers (Electronics 2000/2015) over USB. Close Ruby/JobDispatcher first: only one program can hold the port.' : 'Ruida controllers over Ethernet (UDP). Close LightBurn or RDWorks while Pathline Run is connected.'));
  tabs.Machine.push(card('Laser source', text('Type', 'source') + num('Rated power', 'power', 'W') + text('Lens', 'lens') + num('Minimum power', 'minPower', '%') +
    tog('Air assist', 'f.air') + tog('Lid interlock', 'f.interlock')));
  tabs['Work area'].push(card('Bed', num('Width', 'bed.0', 'mm') + num('Height', 'bed.1', 'mm') + num('Max speed', 'speed', 'mm/s', 'Used by Pathline\'s time estimate') + num('Acceleration', 'acc', 'mm/s²')));
  if (trotec) {
    tabs.Controller.push(card('Trotec', num('Position unit', 'trotec.unit', 'mm') + num('Mechanical offset X', 'trotec.offset.0', 'mm') + num('Mechanical offset Y', 'trotec.offset.1', 'mm') +
      num('Travel speed', 'trotec.travelSpeed', 'mm/s') + num('Speed limit', 'trotec.maxSpeed', 'mm/s') + num('Engrave overscan', 'trotec.overscan', 'mm') +
      num('Power correction, cut', 'trotec.cutPowerCorrection', '%', 'Unless the process sets one') + num('Power correction, engrave', 'trotec.engravePowerCorrection', '%') +
      num('Laser source code', 'trotec.laserSource', '', '5 = CO2 (Q500 DC)') + num('Air assist output', 'trotec.airOutput'),
    'From the factory calibration in the controller (TROTEC_PROTOCOL.md §0). Change only if your machine differs.'));
  } else {
    tabs.Controller.push(card('Ruida', seg('Machine origin', 'ruida.origin', [['tl', 'Top left'], ['tr', 'Top right'], ['bl', 'Bottom left'], ['br', 'Bottom right']]) +
      num('Swizzle magic', 'ruida.magic', '', '136 (0x88) for most cards; 17 (0x11) for 634XG'),
    'Origin is the corner the head homes to. Pathline\'s top-left coordinates are mirrored to match.'));
  }
  tabs.Jobs.push(card('Job defaults', seg('Registration marks', 'regMarks', [['refuse', 'Don\'t run'], ['ignore', 'Skip']]) + tog('Remove completed job from queue', 'removeDone') + text('File name prefix', 'prefix'),
    'Pathline Run has no camera yet: jobs with registration marks either wait, or run without print-and-cut correction.'));

  const tab = tabs[ui.setTab] ? ui.setTab : 'Machine';
  return '<div class="view" style="padding:12px;display:flex;flex-direction:column;gap:12px">' +
    '<section class="card" style="padding:16px 18px;display:flex;flex-wrap:wrap;align-items:center;gap:14px"><span class="badge" style="height:28px;padding:0 9px;border-radius:6px">LASER</span>' +
    '<div style="flex:1 1 280px;min-width:0;display:flex;flex-direction:column;gap:4px"><span style="font-size:17px;font-weight:600">' + esc(d.name) + '</span><span class="lbl">' + (d.controller === 'ruida' ? 'Ruida' : 'Trotec') + ' · ' + esc(S.info.model || 'not connected') + (S.info.firmware ? ' · ' + esc(S.info.firmware) : '') + '</span></div>' +
    (dirty ? '<span class="tag warn">Unsaved changes</span><button class="tb" data-a="discard">Discard</button>' : '') +
    '<button class="btn-primary" data-a="save"' + (dirty ? '' : ' disabled') + '>Save to machine</button></section>' +
    '<div role="tablist" aria-label="Setup sections" class="tabs">' + Object.keys(tabs).map((t) => '<button role="tab" aria-selected="' + (t === tab) + '" data-a="setTab" data-v="' + t + '">' + t + '</button>').join('') + '</div>' +
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:12px;align-items:start">' + tabs[tab].join('') + '</div></div>';
}

// ---------------------------------------------------------------- dialogs
function dialog() {
  if (!ui.dlg) return '';
  if (ui.dlg.kind === 'import') {
    return '<div class="scrim"><div role="dialog" aria-label="Import file" class="dlg"><span class="h-sec" style="font-size:18px">Import job</span>' +
      '<div style="display:flex;align-items:center;gap:12px;padding:14px;border:1.5px dashed var(--line-hover);border-radius:10px;background:var(--surface-2)">' + ic(ICON.file, 26) +
      '<span style="flex:1;min-width:0;display:flex;flex-direction:column;line-height:1.3"><span style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(ui.dlg.name || 'No file chosen') + '</span><span class="lbl">Pathline job (.cjob) or job package (.json)</span></span>' +
      '<label class="tb" style="position:relative;cursor:pointer">Choose file<input type="file" accept=".cjob,.json" data-a="file" aria-label="Choose file" style="position:absolute;inset:0;opacity:0;cursor:pointer"></label></div>' +
      '<span class="lbl">DXF, SVG and PDF are prepared in Pathline: set up the processes there, then Send or Save.</span>' +
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
  if (ui.dlg.kind === 'update') return updateWindow();
  if (ui.dlg.kind === 'changelog') return changelogWindow(ui.dlg.entries, ui.dlg.title);
  if (ui.dlg.kind === 'message') return messageWindow(ui.dlg.title, ui.dlg.msg);
  return '';
}

// ---------------------------------------------------------------- render + events
function render() {
  $app.dataset.theme = ui.dark ? 'dark' : 'light';
  if (!S) { $app.innerHTML = header() + '<div class="view" style="display:flex;align-items:center;justify-content:center;color:var(--text-3)">Connecting to Pathline Run…</div>'; return; }
  // don't redraw the setup form under the operator's fingers while a field has focus
  const focused = document.activeElement && document.activeElement.dataset && (document.activeElement.dataset.f || document.activeElement.dataset.n);
  if (ui.view === 'setup' && focused) { const h = $app.querySelector('header'); if (h) h.outerHTML = header(); return; }
  const scroll = $app.querySelector('.view') && ui.drawn === ui.view ? $app.querySelector('.view').scrollTop : 0;
  ui.drawn = ui.view;
  const v = ui.view === 'jog' ? jogView() : ui.view === 'history' ? historyView() : ui.view === 'setup' ? setupView() : queueView();
  const t = ui.toast;
  $app.innerHTML = header() + v + dialog() + (t ? '<div class="toast" role="status" style="display:flex;align-items:center;gap:14px">' + esc(t.msg) +
    (t.action ? '<button class="tb sm" data-a="toastAction">' + esc(t.action) + '</button>' : '') + '</div>' : '');
  const nv = $app.querySelector('.view');
  if (nv) nv.scrollTop = scroll;
}

const H = {
  nav: () => { ui.navOpen = !ui.navOpen; render(); },
  go: (v) => { ui.view = v; ui.navOpen = false; if (v === 'setup') { ui.draft = null; ui.netDraft = null; loadPorts(); loadNetwork(); } render(); },
  theme: () => { ui.dark = !ui.dark; ui.themeSet = true; try { localStorage.setItem('plr-theme', ui.dark ? 'dark' : 'light'); } catch (e) { /* ignore */ } render(); },
  sel: (id) => { ui.sel = id; refresh(); },
  up: act(async (id) => move(id, -1)),
  down: act(async (id) => move(id, 1)),
  remove: act(async () => { if (ui.sel) await call('DELETE', API('/jobs/' + encodeURIComponent(ui.sel))); }),
  startPause: act(async () => {
    const s = S.status.state;
    if (s === 'running') return call('POST', API('/pause'), {});
    if (s === 'paused') return call('POST', API('/resume'), {});
    // Start runs the next queued job: put the selected one first
    const ids = visibleQueue().filter((j) => j.status === 'queued').map((j) => j.id);
    if (ui.sel && ids[0] !== ui.sel) await call('POST', API('/jobs/order'), { ids: [ui.sel].concat(ids.filter((i) => i !== ui.sel)) });
    const r = await call('POST', API('/start'), {});
    if (r.message) toast(r.message);
  }),
  stop: act(async () => call('POST', API('/stop'), {})),
  frame: act(async () => {
    const id = running() ? S.status.job : ui.sel;
    const b = jobBox(ui.pkgs[id]);
    if (!b) throw new Error('Select a job to frame');
    await call('POST', API('/frame'), { box: b });
  }),
  removeDone: act(async () => call('PUT', LOCAL('/config'), { removeDone: !cfg().removeDone })),
  // pin the selected job's top-left corner to where the head is now (or put it back)
  anchor: act(async (v) => {
    if (!ui.sel) return;
    const r = await call('POST', LOCAL('/jobs/' + ui.sel + '/anchor'), v === 'clear' ? { clear: true } : {});
    delete ui.pkgs[ui.sel]; // reload the preview where it now sits
    toast(r.anchor ? 'Anchored: the job starts at X ' + r.anchor.x.toFixed(1) + ', Y ' + r.anchor.y.toFixed(1) + ' mm' : 'Anchor cleared: the job runs where Pathline placed it');
  }),
  jog: act(async (v) => call('POST', API('/jog'), { axis: v[0], distance: (v[1] === '-' ? -1 : 1) * Number(ui.step) })),
  step: (v) => { ui.step = v; render(); },
  home: act(async () => call('POST', API('/home'), {})),
  goto0: act(async () => call('POST', API('/jog'), { x: 0, y: 0 })),
  io: act(async (k) => call('POST', API('/io'), { [k]: !S.status.io[k] })),
  simLid: act(async () => call('POST', LOCAL('/sim/lid'), { open: !S.status.interlock })),
  hist: (v) => { ui.histFilter = v; render(); },
  rerun: act(async (id) => { const j = await call('POST', LOCAL('/jobs/' + id + '/requeue'), {}); ui.sel = j.id; ui.view = 'queue'; }),
  setTab: (v) => { ui.setTab = v; if (v === 'Network') { ui.netDraft = null; loadNetwork(); } render(); },
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
  save: act(async () => { await call('PUT', LOCAL('/config'), ui.draft); ui.draft = null; toast('Saved. Reconnecting to the controller…'); }),
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
  close: () => { ui.dlg = null; render(); }
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

$app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-a]');
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

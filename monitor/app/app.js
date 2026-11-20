// Pathline Monitor: the phone app. A phone signs in once with the workshop password. Live
// machine views come from the Monitor server (/api/events, a server-sent stream: everything
// once, then each machine as it changes); this phone's alert settings are kept there too
// (/api/device). A new alert shows here while the app is open (a banner, a tone and a buzz)
// and arrives as a notification when it's closed (Web Push, sw.js).
'use strict';

// ---------------------------------------------------------------- small things
const I = {
  back: 'M15 18l-6-6 6-6', bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9 M13.7 21a2 2 0 0 1-3.4 0',
  grid: 'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z', sliders: 'M4 21v-7 M4 10V3 M12 21v-9 M12 8V3 M20 21v-5 M20 12V3 M1 14h6 M9 8h6 M17 16h6',
  check: 'M5 12l5 5L19 7', alert: 'M12 3L2 21h20z M12 10v5 M12 18v.5', queue: 'M4 6h16 M4 12h16 M4 18h10',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3 2', off: 'M2 2l20 20 M8.5 16.5a5 5 0 0 1 7 0 M5 12.9a10 10 0 0 1 5.2-2.8 M12 20h.01', info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 11v5 M12 8v.5',
};
const ic = (d, s) => '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"' + (s ? ' style="width:' + s + 'px;height:' + s + 'px"' : '') + '><path d="' + d + '"/></svg>';
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const clock = (ms) => { const d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const dur = (s) => { s = Math.max(0, Math.round(s)); if (s >= 3600) return Math.floor(s / 3600) + ' h ' + pad(Math.floor((s % 3600) / 60)) + ' min'; return s < 60 ? s + ' s' : Math.floor(s / 60) + ' min ' + pad(s % 60) + ' s'; };
const short = (s) => dur(s).replace(/ \d+ s$/, '');
const left = (s) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600); return (h ? h + ':' + pad(Math.floor((s % 3600) / 60)) : Math.floor(s / 60)) + ':' + pad(s % 60); };
const since = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? 'now' : m < 60 ? m + ' min' : m < 1440 ? Math.floor(m / 60) + ' h ' + (m % 60) + ' min' : Math.floor(m / 1440) + ' d'; };
const store = {
  get(k, d) { try { const v = localStorage.getItem('pm-' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('pm-' + k, JSON.stringify(v)); } catch (e) { /* private mode: kept for this visit only */ } },
};

// this phone, as the service knows it
let deviceId = store.get('device', null);
if (!deviceId) { deviceId = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).replace(/[^a-z0-9-]/gi, ''); store.set('device', deviceId); }

// ---------------------------------------------------------------- state
let S = null;           // what the server last said: { app, machines, alerts, pushKey }
let skew = 0;           // this phone's clock minus the server's, to count down between updates
let live = false;
// signedIn: null until the server has answered, then true or false
const ui = { view: 'machines', machine: null, seenAt: store.get('seenAt', 0), prefs: null, notif: false, busy: false, note: '', signedIn: null, signMsg: '', code: null, codeNote: '', removing: null,
  // Settings, Pathline Prepare: what the server says (GET /api/prepare), the authenticator setup
  // under way ({ mode: new|again|spare, step: code|scan|spare, secret, uri, spare, msg }), a computer being removed
  prep: null, ts: null, removingPc: null };

// seconds since the machine's last report (m.at, by the server's clock)
const age = (m) => Math.max(0, (Date.now() - skew - m.at) / 1000);
// time left on a running job (Run's own figure), counted down since that report
const remain = (m) => {
  if (!m.job) return 0;
  const r = Number.isFinite(m.job.remaining) ? m.job.remaining : m.job.seconds * (1 - m.job.progress);
  return m.state === 'running' ? Math.max(0, r - age(m)) : r;
};
const bedOf = (m) => (m.job && Array.isArray(m.job.beds) ? 'bed ' + m.job.beds[0] + ' of ' + m.job.beds[1] : '');
const pctOf = (m) => (m.job ? Math.floor(Math.min(1, m.job.progress + (m.state === 'running' && m.job.seconds ? age(m) / m.job.seconds : 0)) * 100) : 0);
const queueSecs = (m) => m.queue.reduce((a, j) => a + (j.seconds || 0), 0);
const at = (secs) => clock(Date.now() + secs * 1000);

const STATE = {
  running: ['run', 'Running'], framing: ['run', 'Framing'], paused: ['warn', 'Paused'], mark: ['warn', 'Needs you'], lid: ['warn', 'Lid open'],
  alarm: ['err', 'Error'], done: ['ok', 'Finished'], idle: ['', 'Idle'], offline: ['err', 'Offline'],
};
const needsYou = (m) => ['mark', 'lid', 'alarm', 'offline', 'paused', 'done'].includes(m.state);
const busy = (m) => m.job && ['running', 'paused', 'mark', 'framing'].includes(m.state);
const badge = (m, big) => '<span class="badge' + (m.kind === 'plotter' ? ' plotter' : '') + '"' + (big ? ' style="height:24px;padding:0 8px"' : '') + '>' + m.kind.toUpperCase() + '</span>';

// ---------------------------------------------------------------- machines
function noteFor(m) {
  if (m.state === 'mark') return '<div class="note warn">' + ic(I.alert) + '<span><b>' + esc(m.why) + '.</b> Find it with the camera at the machine.</span></div>';
  if (m.state === 'alarm') return '<div class="note err">' + ic(I.alert) + '<span><b>' + esc(m.why) + '.</b> Clear it at the machine.</span></div>';
  if (m.state === 'offline') return '<div class="note err">' + ic(I.off) + '<span><b>' + esc(m.why) + (m.since ? ' since ' + clock(m.since) : '') + '.</b> ' + (m.why === 'Not reporting' ? 'Check its PC is on, Pathline Run is open and it has internet.' : 'Check the machine is on and connected.') + '</span></div>';
  if (m.state === 'lid') return '<div class="note warn">' + ic(I.alert) + '<span><b>Lid open since ' + clock(m.since) + '.</b> No alert sent: someone opened it at the machine.</span></div>';
  if (m.state === 'paused') return '<div class="note warn">' + ic(I.alert) + '<span><b>Paused at the machine' + (m.since ? ' since ' + clock(m.since) : '') + '.</b> No alert sent.</span></div>';
  if (m.state === 'done') return '<div class="note ok">' + ic(I.check) + '<span><b>Finished ' + esc(m.lastDone) + ' at ' + clock(m.doneAt) + '.</b> Next job needs Start at the machine.</span></div>';
  return '';
}

function card(m) {
  const [cls, label] = STATE[m.state] || STATE.idle;
  let body = '';
  if (busy(m)) {
    const pct = pctOf(m);
    body += '<div class="job"><span class="t">' + esc(m.job.name) + '</span><span class="s">' + esc([m.job.material, bedOf(m)].filter(Boolean).join(' · ') || ' ') + '</span></div>' +
      '<div class="track" role="progressbar" aria-label="' + esc(m.name) + ' progress" aria-valuenow="' + pct + '" aria-valuemin="0" aria-valuemax="100"><i style="width:' + pct + '%"></i></div>' +
      '<div class="meta"><span>' + (m.state === 'running' ? 'Done at <span class="mono">' + at(remain(m)) + '</span> · <span class="mono">' + left(remain(m)) + '</span> left' : m.since ? 'Waiting ' + since(m.since) : '') + '</span><span class="mono">' + pct + ' %</span></div>';
  }
  body += noteFor(m);
  if (m.state === 'idle') { const h = m.today[0]; body += '<div class="meta"><span>' + (h ? 'Last job finished at <span class="mono">' + clock(h.finishedAt) + '</span>' : 'No jobs today') + '</span></div>'; }
  const q = '<span class="q">' + ic(I.queue, 16) + (m.queue.length ? m.queue.length + ' queued · ' + short(queueSecs(m)) : 'Queue empty') + '</span>';
  const loud = ['mark', 'alarm', 'offline'].includes(m.state);
  return '<button class="card' + (loud ? ' attn' : '') + '" data-a="open" data-v="' + esc(m.id) + '" aria-label="' + esc(m.name + ', ' + label) + '"><div class="row">' + badge(m) + '<span class="m-name">' + esc(m.name) + '</span><span class="pill ' + cls + '">' + label + '</span></div>' +
    body + '<div class="meta"><span class="m-model">' + esc(m.model) + '</span>' + q + '</div></button>';
}

function machinesView() {
  if (!S) return bar('<h1>Machines</h1><div class="sub">Connecting…</div>', '') + '<main class="main"><div class="loading" aria-hidden="true"><span class="skel" style="height:72px"></span><span class="skel"></span><span class="skel"></span></div></main>';
  const M = S.machines;
  const running = M.filter((m) => m.state === 'running');
  const attn = M.filter(needsYou);
  const rest = M.filter((m) => !attn.includes(m));
  const soonest = running.slice().sort((a, b) => remain(a) - remain(b))[0];
  const tiles = '<div class="summary"><div class="tile"><b>' + running.length + '</b><span>running</span></div>' +
    '<div class="tile' + (attn.length ? ' warn' : '') + '"><b>' + attn.length + '</b><span>need you</span></div>' +
    '<div class="tile"><b>' + M.reduce((a, m) => a + m.queue.length, 0) + '</b><span>jobs queued</span></div></div>' +
    (soonest ? '<div class="next">' + ic(I.clock, 18) + '<span>Next to finish: <b>' + esc(soonest.name) + '</b> at <span class="mono">' + at(remain(soonest)) + '</span></span></div>' : '');
  const empty = !M.length ? '<div class="list"><div class="hint"><b>No machines yet.</b> Each machine is added once, with a code typed into its Pathline Run.</div>' +
    '<div class="set"><span class="body">Add the first machine</span><button class="btn-primary" data-a="addMachine">Add a machine</button></div></div>' : '';
  return bar('<h1>Machines</h1><div class="sub">' + M.length + (M.length === 1 ? ' machine' : ' machines') + '</div>', liveTag()) +
    '<main class="main">' + installCard() + (M.length ? tiles : empty) +
    (attn.length ? '<section class="sec"><div class="sec-h">Needs you <span class="n">' + attn.length + '</span></div>' + attn.map(card).join('') + '</section>' : '') +
    (rest.length ? '<section class="sec"><div class="sec-h">' + (attn.length ? 'Everything else' : 'All machines') + ' <span class="n">' + rest.length + '</span></div>' + rest.map(card).join('') + '</section>' : '') + '</main>';
}

function ring(pct) {
  const r = 52, c = 2 * Math.PI * r;
  return '<div class="ring"><svg viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="' + r + '" fill="none" stroke="var(--sunken)" stroke-width="10"/>' +
    '<circle cx="60" cy="60" r="' + r + '" fill="none" stroke="var(--accent)" stroke-width="10" stroke-linecap="round" stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + (c * (1 - pct / 100)).toFixed(1) + '"/></svg>' +
    '<div class="c"><b>' + pct + '%</b><span>done</span></div></div>';
}

function detailView() {
  const m = S && S.machines.find((x) => x.id === ui.machine);
  if (!m) { ui.machine = null; return machinesView(); }
  const [cls, label] = STATE[m.state] || STATE.idle;
  let top;
  if (busy(m)) {
    const pct = pctOf(m);
    top = '<div class="hero">' + ring(pct) + '<div class="facts"><span class="pill ' + cls + '" style="margin-left:0;align-self:flex-start">' + label + '</span>' +
      (m.state === 'running' ? '<div><div class="big">' + left(remain(m)) + '</div><div style="font-size:12px;color:var(--text-3)">left · done at ' + at(remain(m)) + '</div></div>' : '<div style="font-size:13px;color:var(--text-2)">' + esc(m.why || (m.state === 'paused' ? 'Paused at the machine' : '')) + '</div>') +
      '</div></div>' + noteFor(m) +
      '<div class="kv"><div><span class="k">Job</span><span class="v">' + esc(m.job.name) + '</span></div>' + (m.job.material ? '<div><span class="k">Material</span><span class="v">' + esc(m.job.material) + '</span></div>' : '') +
      (bedOf(m) ? '<div><span class="k">Bed</span><span class="v mono">' + m.job.beds[0] + ' of ' + m.job.beds[1] + '</span></div>' : '') +
      '<div><span class="k">Run time</span><span class="v mono">' + dur(m.job.seconds - remain(m)) + ' of ' + dur(m.job.seconds) + '</span></div></div>';
  } else {
    top = '<div class="hero"><span class="pill ' + cls + '" style="margin-left:0">' + label + '</span><span style="color:var(--text-2);font-size:14px">' + (m.state === 'idle' ? 'Nothing running.' : m.state === 'done' ? 'Waiting for Start at the machine.' : '') + '</span></div>' + noteFor(m);
  }
  // each queued job: how long, and when it starts (a plotter's Select run starts the next by itself)
  let t = m.state === 'running' ? remain(m) : 0;
  let chain = m.state === 'running';
  const queue = '<div class="list">' + (m.queue.length ? m.queue.map((j, i) => {
    const self = chain && j.autoStart;
    const starts = self ? 'starts ' + at(t) + ' by itself' : 'needs Start';
    chain = self;
    t += j.seconds || 0;
    return '<div class="li"><span class="ord">' + (i + 1) + '</span><span class="body"><span class="t">' + esc(j.name) + '</span><span class="s">' + esc(j.material) + '</span></span><span class="end"><span class="mono">' + short(j.seconds) + '</span><br><span class="s">' + starts + '</span></span></div>';
  }).join('')
    : '<div class="empty">Queue empty. New jobs come from Pathline Prepare.</div>') + '</div>';
  const hist = '<div class="list">' + (m.today.length ? m.today.map((h) => '<div class="li"><span class="body"><span class="t">' + esc(h.name) + '</span><span class="s mono">' + clock(h.finishedAt) + ' · ' + dur(h.seconds) + '</span></span><span class="pill ' + (h.ok ? 'ok' : 'warn') + '">' + (h.ok ? 'Completed' : 'Stopped') + '</span></div>').join('')
    : '<div class="empty">No jobs finished today.</div>') + '</div>';
  const muted = !!(ui.prefs && ui.prefs.mute && ui.prefs.mute[m.id]);
  return bar('<button class="back" data-a="home">' + ic(I.back) + 'Machines</button>', liveTag()) +
    '<main class="main"><div class="row" style="gap:12px">' + badge(m, true) + '<div style="min-width:0"><div style="font-size:22px;font-weight:600;line-height:1.2">' + esc(m.name) + '</div><div class="m-model" style="white-space:normal">' + esc(m.model) + '</div></div></div>' + top +
    '<section class="sec"><div class="sec-h">Up next <span class="n">' + m.queue.length + (m.queue.length ? ' · ' + short(queueSecs(m)) : '') + '</span></div>' + queue +
    (m.queue.length ? '<span style="font-size:12px;color:var(--text-3);padding:0 2px">' + (m.queue.some((j) => j.autoStart) ? 'Jobs in a plotter\'s Select run start by themselves; the others are started at the machine.' : 'Each job is started at the machine.') + (m.state === 'running' ? ' Started straight away, the queue clears at ' + at(remain(m) + queueSecs(m)) + '.' : '') + '</span>' : '') + '</section>' +
    '<section class="sec"><div class="sec-h">Today</div>' + hist + '</section>' +
    '<section class="sec"><div class="sec-h">Notifications</div><div class="list"><div class="set"><span class="body">Notify me about ' + esc(m.name) + '<span class="s">Finished jobs, waiting for you, errors</span></span><button role="switch" class="sw" aria-checked="' + !muted + '" aria-label="Notifications for ' + esc(m.name) + '" data-a="mute" data-v="' + esc(m.id) + '"></button></div></div></section>' +
    '<section class="sec"><div class="sec-h">This machine</div><div class="list">' + (ui.removing === m.id
      ? '<div class="hint"><b>Remove ' + esc(m.name) + ' from Pathline Monitor?</b> It disappears from every phone and its Pathline Run stops reporting. It can be added again with a new code.</div><div class="set"><span class="body"></span><span class="acts"><button class="tb" data-a="removeNo">Keep it</button><button class="btn-primary" data-a="removeYes" data-v="' + esc(m.id) + '">Remove</button></span></div>'
      : '<div class="set"><span class="body">Remove from Pathline Monitor<span class="s">For a machine that has gone, or one added by mistake</span></span><button class="tb" data-a="remove" data-v="' + esc(m.id) + '">Remove</button></div>') + '</div></section></main>';
}

// ---------------------------------------------------------------- alerts
function alertsView() {
  const icon = { done: I.check, attn: I.alert, err: I.off, info: I.info };
  const list = S ? S.alerts : [];
  const unread = list.filter((a) => a.at > ui.seenAt).length;
  const day = (ms) => { const d = new Date(ms), n = new Date(); return d.toDateString() === n.toDateString() ? 'Today' : d.toDateString() === new Date(n - 864e5).toDateString() ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' }); };
  const groups = [];
  for (const a of list) { const k = day(a.at); if (!groups.length || groups[groups.length - 1][0] !== k) groups.push([k, []]); groups[groups.length - 1][1].push(a); }
  return bar('<h1>Alerts</h1><div class="sub">' + (unread ? unread + ' new' : 'All read') + '</div>', unread ? '<button class="tb" data-a="readAll" style="height:36px;font-size:13px">Mark all read</button>' : '') +
    '<main class="main">' + (groups.length ? groups.map(([k, items]) => '<section class="sec"><div class="sec-h">' + esc(k) + '</div><div class="list">' +
      items.map((a) => '<button class="al' + (a.at > ui.seenAt ? ' unread' : '') + '" data-a="alert" data-v="' + esc(a.machine) + '"><span class="ico ' + esc(a.kind) + '">' + ic(icon[a.kind] || I.info, 18) + '</span><span class="body"><span class="t">' + esc(a.title) + '</span><br><span class="s">' + esc(a.body) + '</span></span><span class="when">' + since(a.at) + '</span></button>').join('') + '</div></section>').join('')
      : '<div class="list"><div class="empty">No alerts yet. Finished jobs and machines that need you show here.</div></div>') + '</main>';
}

// ---------------------------------------------------------------- settings
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isAndroid = /Android/i.test(navigator.userAgent);
// opened on a PC (a mouse, a wide window): the app is for phones, so say how to get it on one
const onDesk = () => matchMedia('(min-width: 1200px) and (pointer: fine)').matches;

// ---------------------------------------------------------------- getting the app on a phone
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; render(); });
window.addEventListener('appinstalled', () => { installPrompt = null; store.set('installHide', true); render(); });
const SHARE = 'M12 3v12 M8 7l4-4 4 4 M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7';
const DOTS = 'M12 5v.5 M12 12v.5 M12 19v.5';
function installSteps() {
  const step = (n, html) => '<li><span class="ord">' + n + '</span><span>' + html + '</span></li>';
  if (isIOS) return '<ol class="steps">' + step(1, 'Tap <b>Share</b> ' + ic(SHARE, 18) + ' in Safari\'s toolbar') + step(2, 'Scroll down and tap <b>Add to Home Screen</b>') + step(3, 'Tap <b>Add</b>. Pathline Monitor is on the Home Screen, with its white tile') + '</ol>';
  if (isAndroid) return '<ol class="steps">' + step(1, 'Tap the menu ' + ic(DOTS, 18) + ' in Chrome\'s corner') + step(2, 'Tap <b>Add to Home screen</b> (or <b>Install app</b>)') + step(3, 'Tap <b>Add</b>. Pathline Monitor is on the Home screen') + '</ol>';
  return '<ol class="steps">' + step(1, 'Open this page on the phone') + step(2, 'Use the browser\'s <b>Add to Home Screen</b>') + '</ol>';
}
function installCard() {
  if (standalone || onDesk() || store.get('installHide', false)) return '';
  return '<div class="list install"><div class="set"><img class="mark" src="icon.svg" alt="" style="width:36px;height:36px"><span class="body">Keep Pathline Monitor on your Home Screen<span class="s">' + (isIOS ? 'On iPhone, notifications need it there' : 'It opens full screen, like an app, one tap away') + '</span></span>' +
    (installPrompt ? '<button class="btn-primary" data-a="install">Install</button>' : '<button class="tb" data-a="howInstall">How</button>') + '</div>' +
    (ui.howInstall ? '<div class="hint">' + installSteps() + '<button class="tb" data-a="installHide" style="margin-top:8px">Done, hide this</button></div>' : '') + '</div>';
}
// the PC's view: the address to open on a phone, beside the app
function deskCard() {
  if (!onDesk()) return '';
  return '<aside class="desk" aria-label="Get Pathline Monitor on a phone"><img src="icon.svg" alt="" width="48" height="48"><h2>Pathline Monitor is for your phone</h2>' +
    '<p>Open this address in the phone\'s browser and sign in with the workshop password. It works anywhere the phone has internet.</p>' +
    '<p class="url mono">' + esc(location.host) + '</p>' +
    '<p class="small">Then add it to the Home Screen and turn on notifications in Settings, to hear when a job finishes with the app closed.</p></aside>';
}
const canPush = window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function phoneCard() {
  const p = ui.prefs || {};
  const sound = '<div class="set"><span class="body">Sound while the app is open<span class="s">A short tone and a buzz with each alert</span></span><button role="switch" class="sw" aria-checked="' + (p.sound !== false) + '" aria-label="Sound while the app is open" data-a="pref" data-v="sound"></button></div>';
  const test = '<div class="set"><span class="body">Try an alert<span class="s">Shows one here, with the sound</span></span><button class="tb" data-a="testLocal">Try it</button></div>';
  if (isIOS && !standalone) return '<div class="hint"><b>Add Pathline Monitor to your Home Screen first.</b> On iPhone, notifications only work from the Home Screen app: tap Share, then Add to Home Screen, and open Pathline Monitor from there.</div>';
  if (!canPush) return sound + test + '<div class="hint"><b>This browser can\'t show notifications with the app closed.</b> Use Safari on iPhone, or Chrome on Android.</div>';
  if (Notification.permission === 'denied') return '<div class="hint"><b>Notifications are blocked for Pathline Monitor.</b> Allow them in the phone\'s settings for this app, then come back here.</div>';
  if (ui.notif) return sound + '<div class="set"><span class="body">Notifications are on<span class="s">' + esc(ui.note || 'This phone gets the alerts chosen below') + '</span></span><span class="acts"><button class="tb" data-a="testPush"' + (ui.busy ? ' disabled' : '') + '>Send a test</button></span></div>' +
    '<div class="set"><span class="body">Stop notifications on this phone</span><button class="tb" data-a="pushOff"' + (ui.busy ? ' disabled' : '') + '>Turn off</button></div>';
  return sound + test + '<div class="set"><span class="body">Notifications with the app closed<span class="s">' + esc(ui.note || 'Off. Turn them on to hear when jobs finish.') + '</span></span><button class="btn-primary" data-a="pushOn"' + (ui.busy ? ' disabled' : '') + '>Turn on</button></div>';
}

// adding a machine: a one-time code, typed into that machine's Pathline Run with this address
function addMachineCard() {
  const c = ui.code;
  if (!c) return '<div class="set"><span class="body">Add a machine<span class="s">' + esc(ui.codeNote || 'Gives a code to type into its Pathline Run') + '</span></span><button class="tb" data-a="addMachine"' + (ui.busy ? ' disabled' : '') + '>Add</button></div>';
  if (Date.now() > c.until) return '<div class="set"><span class="body">That code has run out<span class="s">It lasts 10 minutes</span></span><button class="tb" data-a="addMachine">New code</button></div>';
  const step = (n, html) => '<li><span class="ord">' + n + '</span><span>' + html + '</span></li>';
  return '<div class="hint addm"><div class="code mono" aria-label="Code">' + esc(c.code.slice(0, 3) + '-' + c.code.slice(3)) + '</div>' +
    '<ol class="steps">' + step(1, 'At the machine, open Pathline Run\'s <b>Setup</b>, then <b>Pathline Monitor</b>') +
    step(2, 'Type this address: <b class="mono">' + esc(location.host) + '</b>') +
    step(3, 'Type the code above and press <b>Connect</b>. It works once, until <span class="mono">' + clock(c.until) + '</span>') + '</ol>' +
    '<button class="tb" data-a="codeDone">Done</button></div>';
}

// Pathline Prepare: a computer signs in with the workshop password and a code from the
// authenticator app set up here (Google or Microsoft Authenticator), then queues jobs on the
// machines from anywhere. It can't start them: Start is pressed at the machine.
const dateOf = (ms) => new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
function prepareCard() {
  const p = ui.prep;
  const head = '<section class="sec"><div class="sec-h">Pathline Prepare</div><div class="list">';
  // asked for when first shown (and again every 10 s while it can't be had)
  if (!p && Date.now() - (ui.prepAt || 0) > 10000) { ui.prepAt = Date.now(); setTimeout(loadPrep, 0); }
  if (!p) return head + '<div class="set"><span class="body"><span class="s">Loading…</span></span></div></div></section>';
  const ts = p.twoStep || {};
  const auth = ts.on
    ? '<div class="set"><span class="body">Authenticator app set up<span class="s">Since ' + dateOf(ts.setAt) + '. A new phone, or a lost one: set it up again</span></span><button class="tb" data-a="tsStart" data-v="again">Set up again</button></div>' +
      '<div class="set"><span class="body">Spare codes<span class="s">' + ts.spareLeft + ' left. New ones replace them</span></span><button class="tb" data-a="tsStart" data-v="spare">New codes</button></div>'
    : '<div class="set"><span class="body">Set up the authenticator app<span class="s">Google or Microsoft Authenticator on a phone. Pathline Prepare can\'t sign in until it\'s set up</span></span><button class="btn-primary" data-a="tsStart" data-v="new">Set up</button></div>';
  const pcs = p.computers.map((c) => (ui.removingPc === c.id
    ? '<div class="hint"><b>Remove ' + esc(c.name) + '?</b> It can\'t reach the machines through Pathline Monitor any more, until it signs in again with the password and a code.</div><div class="set"><span class="body"></span><span class="acts"><button class="tb" data-a="removePcNo">Keep it</button><button class="btn-primary" data-a="removePcYes" data-v="' + esc(c.id) + '">Remove</button></span></div>'
    : '<div class="set"><span class="body">' + esc(c.name) + '<span class="s">Signed in ' + dateOf(c.addedAt) + ' · last used ' + (since(c.seenAt) === 'now' ? 'now' : since(c.seenAt) + ' ago') + '</span></span><button class="tb" data-a="removePc" data-v="' + esc(c.id) + '">Remove</button></div>')).join('');
  return head + '<div class="hint">A computer with Pathline Prepare signs in with the workshop password and a code from the authenticator app. It can then queue jobs on the machines from anywhere, but never start them: Start is pressed at the machine.' + (ui.prepMsg ? '<br><b style="color:var(--err)">' + esc(ui.prepMsg) + '</b>' : '') + '</div>' +
    auth + (pcs || (ts.on ? '<div class="set"><span class="body"><span class="s">No computers signed in yet</span></span></div>' : '')) + '</div></section>';
}
// setting up the authenticator app: (a code from it first, when replacing it) → scan → spare codes
function twoStepView() {
  const t = ui.ts || {};
  const back = '<button class="tb" data-a="tsDone">' + (t.step === 'spare' ? 'Done' : 'Cancel') + '</button>';
  const top = bar('<h1>' + (t.mode === 'spare' ? 'Spare codes' : 'Authenticator app') + '</h1><div class="sub">For Pathline Prepare\'s sign-in</div>', back);
  const msg = '<span class="s" id="tsmsg" role="alert" style="color:var(--err)">' + esc(t.msg || '') + '</span>';
  const codeField = (label) => '<label class="field"><span>' + label + '</span><input name="code" inputmode="numeric" autocomplete="one-time-code" autocapitalize="off" spellcheck="false" enterkeyhint="go" required class="mono"></label>';
  let body = '';
  if (t.step === 'code') {
    body = '<div class="list"><div class="hint">' + (t.mode === 'spare' ? 'New spare codes replace the old ones.' : 'Setting it up again replaces the app\'s codes: the old ones stop working.') + ' First type the 6-digit code the authenticator app shows now (or a spare code).</div>' +
      '<form id="tsform" data-step="code">' + codeField('Code from the authenticator app') + '<div class="set"><span class="body">' + msg + '</span><button class="btn-primary" type="submit"' + (ui.busy ? ' disabled' : '') + '>Next</button></div></form></div>';
  } else if (t.step === 'scan') {
    const step = (n, html) => '<li><span class="ord">' + n + '</span><span>' + html + '</span></li>';
    const key = (t.secret || '').replace(/(.{4})/g, '$1 ').trim();
    body = '<div class="list"><div class="hint"><ol class="steps">' +
      step(1, 'Open <b>Google Authenticator</b> or <b>Microsoft Authenticator</b> on the phone that will keep the codes, tap <b>+</b> and scan this code') +
      step(2, 'Type the 6-digit code it then shows for <b>Pathline Monitor</b>') + '</ol></div>' +
      '<div class="qr">' + (window.QR ? window.QR.svg(t.uri) : '') + '</div>' +
      '<div class="hint">On this phone itself? <a href="' + esc(t.uri) + '">Add it to the authenticator app</a>, or type this key in the app (time-based):<div class="key mono">' + esc(key) + '</div></div>' +
      '<form id="tsform" data-step="scan">' + codeField('Code from the authenticator app') + '<div class="set"><span class="body">' + msg + '</span><button class="btn-primary" type="submit"' + (ui.busy ? ' disabled' : '') + '>Turn on</button></div></form></div>';
  } else if (t.step === 'spare') {
    body = '<div class="list"><div class="hint"><b>Write these down, or take a picture and keep it off the phone.</b> If the phone with the authenticator app is lost, each one works once instead of a code. They\'re not shown again.</div>' +
      '<div class="spares mono">' + (t.spare || []).map((c) => '<span>' + esc(c) + '</span>').join('') + '</div>' +
      '<div class="set"><span class="body"><span class="s">Pathline Prepare now asks for a code from the app when a computer signs in.</span></span><button class="btn-primary" data-a="tsDone">Done</button></div></div>';
  }
  return top + '<main class="main" id="ts">' + body + '</main>';
}
async function tsSubmit(form) {
  const t = ui.ts;
  if (!t) return;
  const code = form.code.value.trim();
  const say = (m) => { t.msg = m; const el = document.getElementById('tsmsg'); if (el) el.textContent = m; };
  ui.busy = true; say('');
  form.querySelector('button').disabled = true;
  try {
    if (form.dataset.step === 'code' && t.mode === 'spare') {
      const v = await api('prepare/spare', { code });
      ui.prep = v; Object.assign(t, { step: 'spare', spare: v.spare, msg: '' });
    } else if (form.dataset.step === 'code') {
      const v = await api('prepare/two-step', { code });
      Object.assign(t, { step: 'scan', secret: v.secret, uri: v.uri, msg: '' });
    } else {
      const v = await api('prepare/two-step/confirm', { code });
      ui.prep = v; Object.assign(t, { step: 'spare', spare: v.spare, secret: null, uri: null, msg: '' });
    }
    render(true);
  } catch (e) {
    say(e.message);
    form.code.select();
  } finally { ui.busy = false; const b = form.querySelector('button'); if (b) b.disabled = false; }
}
async function loadPrep() { try { ui.prep = await api('prepare'); } catch (e) { /* shown as loading; tried again on the next visit */ } render(); }

function prefsView() {
  const p = ui.prefs || {};
  const sw = (k, t, s) => '<div class="set"><span class="body">' + t + '<span class="s">' + s + '</span></span><button role="switch" class="sw" aria-checked="' + !!p[k] + '" aria-label="' + t + '" data-a="pref" data-v="' + k + '"></button></div>';
  const M = S ? S.machines : [];
  return bar('<h1>Settings</h1><div class="sub">Alerts on this phone</div>', '') +
    '<main class="main"><section class="sec"><div class="sec-h">This phone</div><div class="list">' + phoneCard() + '</div>' +
    (!standalone && !onDesk() ? '<div class="list"><div class="set"><span class="body">Add to Home Screen<span class="s">Opens full screen, like an app</span></span>' + (installPrompt ? '<button class="btn-primary" data-a="install">Install</button>' : '<button class="tb" data-a="howInstall">How</button>') + '</div>' + (ui.howInstall ? '<div class="hint">' + installSteps() + '</div>' : '') + '</div>' : '') + '</section>' +
    '<section class="sec"><div class="sec-h">Notify me when</div><div class="list">' +
    sw('done', 'A job finishes', 'With how long it took and what\'s queued next') +
    sw('queue', 'A queue runs out', 'The machine has nothing left to do') +
    sw('attn', 'A machine is waiting for me', 'A registration mark it can\'t find. Not for a lid opened or a pause pressed at the machine') +
    sw('err', 'A machine stops or goes offline', 'Stopped jobs, errors, lost connection') +
    sw('quiet', 'Quiet hours', '18:00 to 07:00: alerts arrive without a sound') + '</div></section>' +
    '<section class="sec"><div class="sec-h">Machines</div><div class="list">' + M.map((m) => '<div class="set">' + badge(m) + '<span class="body">' + esc(m.name) + '<span class="s">' + esc(m.model || (m.kind === 'plotter' ? 'Plotter' : 'Laser')) + '</span></span><button role="switch" class="sw" aria-checked="' + !(p.mute && p.mute[m.id]) + '" aria-label="Alerts for ' + esc(m.name) + '" data-a="mute" data-v="' + esc(m.id) + '"></button></div>').join('') +
    addMachineCard() + '</div></section>' +
    prepareCard() +
    '<section class="sec"><div class="sec-h">Sign-in</div><div class="list"><div class="set"><span class="body">Signed in on this phone<span class="s">Signing out also stops its notifications</span></span><button class="tb" data-a="signOut">Sign out</button></div></div></section>' +
    '<span style="font-size:12px;color:var(--text-4);padding:0 2px">Pathline Monitor ' + esc(S ? S.app : '') + '</span></main>';
}

// ---------------------------------------------------------------- signing in
function signInView() {
  return '<main class="main signin"><img src="icon.svg" alt="" width="56" height="56"><h1>Pathline Monitor</h1>' +
    '<p>Every machine\'s progress and queue, and an alert when a job finishes.</p>' +
    '<form id="signin" class="list"><input type="text" name="username" autocomplete="username" value="Pathline Monitor" hidden>' +
    '<label class="field"><span>Workshop password</span><input type="password" name="password" autocomplete="current-password" autocapitalize="off" enterkeyhint="go" required></label>' +
    '<div class="set"><span class="body"><span class="s" id="signmsg" role="alert"></span></span><button class="btn-primary" type="submit">Sign in</button></div></form>' +
    '<p class="small">Whoever looks after Pathline Monitor has the password. This phone stays signed in.</p></main>';
}
async function signIn(form) {
  const btn = form.querySelector('button');
  const msg = (t) => { ui.signMsg = t; const el = document.getElementById('signmsg'); if (el) el.textContent = t; };
  btn.disabled = true; msg('');
  try {
    const r = await fetch('api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: deviceId, password: form.password.value }) });
    if (!r.ok) { msg((await r.json().catch(() => ({}))).error || 'Couldn\'t sign in'); form.password.select(); return; }
    ui.signedIn = true; ui.signMsg = '';
    render(); connect(); loadDevice();
  } catch (e) { msg('Can\'t reach Pathline Monitor. Check this phone is online.'); } finally { btn.disabled = false; }
}
function signedOut() {
  if (es) { es.close(); es = null; }
  S = null; live = false; ui.signedIn = false; ui.notif = false; ui.code = null;
  render();
}

// ---------------------------------------------------------------- frame
const bar = (mid, right) => '<header class="bar"><img class="mark" src="icon.svg" alt=""><div class="grow">' + mid + '</div>' + right + '</header>';
const liveTag = () => '<span class="live' + (live ? '' : ' lost') + '">' + (live ? 'Live' : 'Reconnecting…') + '</span>';
function tabs() {
  const unread = S ? S.alerts.filter((a) => a.at > ui.seenAt).length : 0;
  const t = [['machines', 'Machines', I.grid], ['alerts', 'Alerts', I.bell], ['prefs', 'Settings', I.sliders]];
  return '<div class="tabs"><nav aria-label="Sections">' + t.map(([k, l, d]) => '<button data-a="go" data-v="' + k + '" aria-current="' + (ui.view === k ? 'page' : 'false') + '">' + ic(d, 22) + l +
    (k === 'alerts' && unread ? '<span class="dot" aria-label="' + unread + ' new">' + unread + '</span>' : '') + '</button>').join('') + '</nav></div>';
}

const $app = document.getElementById('app');
function render(force) {
  // signed out: the form is drawn once and left alone, so typing isn't lost to the redraw
  if (ui.signedIn === false) {
    if (!document.getElementById('signin')) { $app.innerHTML = signInView(); const d = document.getElementById('desk'); if (d) d.remove(); document.getElementById('signmsg').textContent = ui.signMsg; }
    return;
  }
  // the authenticator setup: drawn when its step changes (render(true)), so a code being typed stays
  if (ui.view === 'twostep') {
    if (force === true || !document.getElementById('ts')) { $app.innerHTML = twoStepView(); window.scrollTo(0, 0); const f = $app.querySelector('#tsform input'); if (f && !matchMedia('(pointer:coarse)').matches) f.focus(); }
    return;
  }
  const v = ui.view === 'machines' && ui.machine ? detailView() : ui.view === 'alerts' ? alertsView() : ui.view === 'prefs' ? prefsView() : machinesView();
  const y = window.scrollY;
  const focus = document.activeElement && document.activeElement.dataset ? [document.activeElement.dataset.a, document.activeElement.dataset.v] : null;
  $app.innerHTML = v + tabs();
  const desk = deskCard();
  let $desk = document.getElementById('desk');
  if (!desk) { if ($desk) $desk.remove(); } else { if (!$desk) { $desk = document.createElement('div'); $desk.id = 'desk'; document.body.appendChild($desk); } if ($desk.innerHTML !== desk) $desk.innerHTML = desk; }
  window.scrollTo(0, y);
  // keep keyboard focus on the same control across the once-a-second redraw
  if (focus && focus[0]) { const el = $app.querySelector('[data-a="' + focus[0] + '"]' + (focus[1] ? '[data-v="' + CSS.escape(focus[1]) + '"]' : '')); if (el) el.focus(); }
  if (ui.view === 'alerts') markSeen(false);
  if ('setAppBadge' in navigator && S) { const n = S.alerts.filter((a) => a.at > ui.seenAt).length; (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {}); }
}
// looking at Alerts counts as having seen them, from the next visit on
function markSeen(now) {
  const newest = S && S.alerts[0] ? S.alerts[0].at : 0;
  if (now) { ui.seenAt = Math.max(newest, Date.now()); store.set('seenAt', ui.seenAt); return; }
  // the dots stay while the list is open; the next visit starts with these read
  if (newest > store.get('seenAt', 0)) store.set('seenAt', newest);
}

// ---------------------------------------------------------------- alerts while the app is open
// the alerts already here when the app opened don't sound; each new one does, if this phone
// wants it (the same choices the service uses for push)
let heard = null;
function wants(a) {
  const p = ui.prefs || {};
  if (!a.tags || !a.tags.some((t) => p[t])) return false;
  return !(p.mute && p.mute[a.machine]);
}
const quietNow = () => { const h = new Date().getHours(); return !!(ui.prefs && ui.prefs.quiet) && (h >= 18 || h < 7); };
function newAlerts(list) {
  if (!heard) { heard = new Set(list.map((a) => a.id)); return; }
  const fresh = list.filter((a) => !heard.has(a.id));
  fresh.forEach((a) => heard.add(a.id));
  const show = fresh.filter(wants);
  if (show.length) banner(show[0], show.length - 1);
}
let audio = null;
// phones only play sound after a tap: the first tap anywhere opens the audio
document.addEventListener('pointerdown', () => { try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); if (audio.state === 'suspended') audio.resume(); } catch (e) { /* no sound */ } }, { passive: true });
function chime(kind) {
  if (!audio || (ui.prefs && ui.prefs.sound === false) || quietNow()) return;
  // two short notes: up for a finished job, down for one that needs someone
  const notes = kind === 'done' ? [660, 880] : [880, 587];
  notes.forEach((f, i) => {
    const o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime + i * 0.16;
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    o.connect(g).connect(audio.destination); o.start(t); o.stop(t + 0.3);
  });
  if (navigator.vibrate) navigator.vibrate(kind === 'done' ? [120, 60, 120] : [300, 100, 300]);
}
let $banner = null;
function banner(a, more) {
  if ($banner) $banner.remove();
  document.body.insertAdjacentHTML('beforeend', '<div class="push" role="status"><button data-machine="' + esc(a.machine) + '"><img src="icon-192.png" alt=""><span style="flex:1;min-width:0"><span class="app-n"><span>Pathline Monitor</span><span>now</span></span><span class="t">' + esc(a.title) + '</span><br><span class="s">' + esc(a.body) + (more > 0 ? ' · ' + more + ' more' : '') + '</span></span></button></div>');
  const el = $banner = document.body.lastElementChild;
  el.querySelector('button').addEventListener('click', () => { hide(); if (a.machine) { markSeen(true); ui.view = 'machines'; ui.machine = a.machine; route(); } });
  const hide = () => { if (!el.isConnected) return; el.classList.add('out'); setTimeout(() => el.remove(), 230); if ($banner === el) $banner = null; };
  setTimeout(hide, 8000);
  chime(a.kind);
}

// ---------------------------------------------------------------- live updates
// everything once ({ machines, alerts, ... }), then one machine ({ m }), one alert ({ alert })
// or a machine removed ({ gone }) at a time
let es = null;
function connect() {
  if (es) es.close();
  es = new EventSource('api/events');
  es.onmessage = (e) => {
    const v = JSON.parse(e.data);
    skew = Date.now() - v.now;
    live = true;
    if (v.machines) S = v;
    else if (!S) return;
    else if (v.m) {
      const i = S.machines.findIndex((m) => m.id === v.m.id);
      if (i >= 0) S.machines[i] = v.m;
      else { S.machines.push(v.m); if (ui.code) { ui.code = null; ui.codeNote = v.m.name + ' is connected'; } }
    } else if (v.gone) S.machines = S.machines.filter((m) => m.id !== v.gone);
    else if (v.alert) S.alerts.unshift(v.alert);
    newAlerts(S.alerts);
    render();
  };
  // a dropped connection comes back by itself; a closed one means signed out, or the server away
  es.onerror = () => {
    live = false; render();
    if (es && es.readyState === 2) { es = null; setTimeout(() => { if (ui.signedIn !== false && !es) loadDevice().then(() => { if (ui.signedIn !== false && !es) connect(); }); }, 3000); }
  };
}
setInterval(render, 1000);

// ---------------------------------------------------------------- this phone's settings and push
async function api(path, data) {
  const r = await fetch('api/' + path, data === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  const v = await r.json().catch(() => ({}));
  if (r.status === 401) { signedOut(); throw new Error('Signed out'); }
  if (!r.ok) throw new Error(v.error || 'Pathline Monitor didn\'t answer');
  return v;
}
async function saveDevice(extra) {
  const v = await api('device', { prefs: { ...ui.prefs, tzOffset: new Date().getTimezoneOffset() }, name: navigator.userAgent.slice(0, 80), ...extra });
  ui.prefs = v.prefs; ui.notif = v.notifications;
}
// also how the app learns whether this phone is signed in
async function loadDevice() {
  try { const v = await api('device'); ui.prefs = v.prefs; ui.notif = v.notifications; ui.signedIn = true; }
  catch (e) { ui.prefs = ui.prefs || { done: true, queue: true, attn: true, err: true, quiet: false, sound: true, mute: {} }; }
  render();
}
const b64 = (s) => { const p = '='.repeat((4 - (s.length % 4)) % 4); const raw = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, (c) => c.charCodeAt(0)); };
async function swReg() { return navigator.serviceWorker.ready; }
async function pushOn() {
  ui.busy = true; ui.note = ''; render();
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { ui.note = 'Not allowed. The phone asked, and the answer was no.'; return; }
    const reg = await swReg();
    const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(S.pushKey) });
    await saveDevice({ subscription: sub.toJSON() });
    ui.note = '';
  } catch (e) { ui.note = 'Couldn\'t turn them on: ' + e.message; } finally { ui.busy = false; render(); }
}
async function pushOff() {
  ui.busy = true; render();
  try { const reg = await swReg(); const sub = await reg.pushManager.getSubscription(); if (sub) await sub.unsubscribe(); await saveDevice({ subscription: null }); ui.note = ''; }
  catch (e) { ui.note = 'Couldn\'t turn them off: ' + e.message; } finally { ui.busy = false; render(); }
}
async function testPush() {
  ui.busy = true; render();
  try { await api('test-push', {}); ui.note = 'Test sent. It should arrive in a few seconds.'; }
  catch (e) { ui.note = e.message; } finally { ui.busy = false; render(); }
}

// ---------------------------------------------------------------- views on the hash: #machines, #alerts, #prefs, #m-<machine>
function route(top) {
  const h = ui.machine && ui.view === 'machines' ? 'm-' + ui.machine : ui.view;
  if (location.hash.slice(1) !== h) history.pushState(null, '', '#' + h);
  render();
  if (top !== false) window.scrollTo(0, 0);
}
function fromHash() {
  const h = decodeURIComponent(location.hash.slice(1));
  if (h.startsWith('m-')) { ui.view = 'machines'; ui.machine = h.slice(2); }
  else if (h === 'alerts' || h === 'prefs') { ui.view = h; ui.machine = null; if (h === 'prefs' && ui.signedIn !== false) loadPrep(); }
  else { ui.view = 'machines'; ui.machine = null; }
  render();
}
window.addEventListener('popstate', fromHash);
window.addEventListener('resize', () => render());

const H = {
  go: (v) => { if (ui.view === 'alerts' && v !== 'alerts') markSeen(true); ui.view = v; ui.machine = null; if (v === 'prefs') loadPrep(); route(); },
  open: (v) => { ui.view = 'machines'; ui.machine = v; route(); },
  home: () => { ui.machine = null; route(); },
  alert: (v) => { markSeen(true); ui.view = 'machines'; ui.machine = v; route(); },
  readAll: () => { markSeen(true); render(); },
  pref: (v) => { ui.prefs[v] = !ui.prefs[v]; render(); saveDevice().catch(() => {}); },
  mute: (v) => { ui.prefs.mute = { ...(ui.prefs.mute || {}), [v]: !(ui.prefs.mute || {})[v] }; render(); saveDevice().catch(() => {}); },
  pushOn, pushOff, testPush,
  testLocal: () => banner({ kind: 'done', machine: null, title: 'Laser A finished Coasters', body: 'This is how an alert looks and sounds' }, 0),
  howInstall: () => { ui.howInstall = !ui.howInstall; render(); },
  installHide: () => { store.set('installHide', true); ui.howInstall = false; render(); },
  install: async () => { if (!installPrompt) return; installPrompt.prompt(); const c = await installPrompt.userChoice.catch(() => null); installPrompt = null; if (c && c.outcome === 'accepted') store.set('installHide', true); render(); },
  addMachine: async () => {
    ui.busy = true; ui.codeNote = ''; ui.view = 'prefs'; ui.machine = null; route(false);
    try { const v = await api('machine-code', {}); ui.code = { code: v.code, until: Date.now() + v.minutes * 60000 }; }
    catch (e) { ui.codeNote = e.message; } finally { ui.busy = false; render(); }
  },
  codeDone: () => { ui.code = null; render(); },
  remove: (v) => { ui.removing = v; render(); },
  removeNo: () => { ui.removing = null; render(); },
  removeYes: async (v) => { ui.removing = null; try { await api('machine-remove', { id: v }); ui.machine = null; route(); } catch (e) { render(); } },
  // Settings, Pathline Prepare
  tsStart: async (v) => {
    ui.ts = { mode: v, step: v === 'new' ? 'scan' : 'code', msg: '' };
    if (v === 'new') {
      try { const r = await api('prepare/two-step', {}); Object.assign(ui.ts, { secret: r.secret, uri: r.uri }); } catch (e) { ui.ts = null; ui.prepMsg = e.message; render(); return; }
    }
    ui.view = 'twostep'; render(true); window.scrollTo(0, 0);
  },
  tsDone: () => { ui.ts = null; ui.view = 'prefs'; route(); loadPrep(); },
  removePc: (v) => { ui.removingPc = v; render(); },
  removePcNo: () => { ui.removingPc = null; render(); },
  removePcYes: async (v) => { ui.removingPc = null; try { ui.prep = await api('prepare/remove', { id: v }); } catch (e) { /* shown again as it was */ } render(); },
  signOut: async () => {
    try { if (canPush) { const sub = await (await swReg()).pushManager.getSubscription(); if (sub) await sub.unsubscribe(); } } catch (e) { /* the server forgets it anyway */ }
    try { await api('logout', {}); } catch (e) { /* signed out either way */ }
    signedOut();
  },
};
$app.addEventListener('submit', (e) => {
  if (e.target.id === 'signin') { e.preventDefault(); signIn(e.target); }
  if (e.target.id === 'tsform') { e.preventDefault(); tsSubmit(e.target); }
});
$app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-a]');
  if (!el || el.disabled || !H[el.dataset.a]) return;
  H[el.dataset.a](el.dataset.v, el);
});

// a tapped notification opens the machine (the service worker posts it here)
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.open) { ui.view = 'machines'; ui.machine = e.data.open; route(); } });
}

fromHash();
// signed in already: straight to live. Not signed in: the form. No network: the app still
// opens and keeps trying.
loadDevice().then(() => { if (ui.signedIn !== false) connect(); });

// Pathline Monitor: the phone app. Live machine views come from the Monitor service
// (/api/events, a server-sent stream); this phone's alert settings are kept there too
// (/api/device). On the workshop network (plain http) a new alert shows here while the app
// is open: a banner, a tone and a buzz. With an https address the phone trusts, alerts can
// also arrive with the app closed (Web Push, sw.js).
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
let S = null;           // the last snapshot: { now, machines, alerts }
let gotAt = 0;          // when it arrived (this phone's clock), to count down between updates
let live = false;
const ui = { view: 'machines', machine: null, seenAt: store.get('seenAt', 0), prefs: null, notif: false, busy: false, note: '' };

// time left on a running job, counted down since the last update
const remain = (m) => {
  if (!m.job) return 0;
  const r = m.job.seconds * (1 - m.job.progress);
  return m.state === 'running' ? Math.max(0, r - (Date.now() - gotAt) / 1000) : r;
};
const pctOf = (m) => (m.job ? Math.floor(Math.min(1, m.job.progress + (m.state === 'running' && m.job.seconds ? (Date.now() - gotAt) / 1000 / m.job.seconds : 0)) * 100) : 0);
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
  if (m.state === 'offline') return '<div class="note err">' + ic(I.off) + '<span><b>' + esc(m.why) + (m.since ? ' since ' + clock(m.since) : '') + '.</b> Check the machine is on and connected.</span></div>';
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
    body += '<div class="job"><span class="t">' + esc(m.job.name) + '</span><span class="s">' + esc(m.job.material || ' ') + '</span></div>' +
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
  const empty = !M.length ? '<div class="list"><div class="hint">' + (S.finding ? '<b>Looking for Pathline Run machines on the network…</b>' : '<b>No machines found.</b> Check each machine\'s Pathline Run is open and on this network, then look again.') + '</div>' +
    (S.finding ? '' : '<div class="set"><span class="body">Machines are found the way Pathline Prepare finds them</span><button class="tb" data-a="find">Look again</button></div>') + '</div>' : '';
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
      '<div><span class="k">Run time</span><span class="v mono">' + dur(m.job.seconds * m.job.progress) + ' of ' + dur(m.job.seconds) + '</span></div></div>';
  } else {
    top = '<div class="hero"><span class="pill ' + cls + '" style="margin-left:0">' + label + '</span><span style="color:var(--text-2);font-size:14px">' + (m.state === 'idle' ? 'Nothing running.' : m.state === 'done' ? 'Waiting for Start at the machine.' : '') + '</span></div>' + noteFor(m);
  }
  const queue = '<div class="list">' + (m.queue.length ? m.queue.map((j, i) => '<div class="li"><span class="ord">' + (i + 1) + '</span><span class="body"><span class="t">' + esc(j.name) + '</span><span class="s">' + esc(j.material) + '</span></span><span class="end"><span class="mono">' + short(j.seconds) + '</span></span></div>').join('')
    : '<div class="empty">Queue empty. New jobs come from Pathline Prepare.</div>') + '</div>';
  const hist = '<div class="list">' + (m.today.length ? m.today.map((h) => '<div class="li"><span class="body"><span class="t">' + esc(h.name) + '</span><span class="s mono">' + clock(h.finishedAt) + ' · ' + dur(h.seconds) + '</span></span><span class="pill ' + (h.ok ? 'ok' : 'warn') + '">' + (h.ok ? 'Completed' : 'Stopped') + '</span></div>').join('')
    : '<div class="empty">No jobs finished today.</div>') + '</div>';
  const muted = !!(ui.prefs && ui.prefs.mute && ui.prefs.mute[m.id]);
  return bar('<button class="back" data-a="home">' + ic(I.back) + 'Machines</button>', liveTag()) +
    '<main class="main"><div class="row" style="gap:12px">' + badge(m, true) + '<div style="min-width:0"><div style="font-size:22px;font-weight:600;line-height:1.2">' + esc(m.name) + '</div><div class="m-model" style="white-space:normal">' + esc(m.model) + '</div></div></div>' + top +
    '<section class="sec"><div class="sec-h">Up next <span class="n">' + m.queue.length + (m.queue.length ? ' · ' + short(queueSecs(m)) : '') + '</span></div>' + queue +
    (m.queue.length ? '<span style="font-size:12px;color:var(--text-3);padding:0 2px">Each job is started at the machine.' + (m.state === 'running' ? ' Started straight away, the queue clears at ' + at(remain(m) + queueSecs(m)) + '.' : '') + '</span>' : '') + '</section>' +
    '<section class="sec"><div class="sec-h">Today</div>' + hist + '</section>' +
    '<section class="sec"><div class="sec-h">Notifications</div><div class="list"><div class="set"><span class="body">Notify me about ' + esc(m.name) + '<span class="s">Finished jobs, waiting for you, errors</span></span><button role="switch" class="sw" aria-checked="' + !muted + '" aria-label="Notifications for ' + esc(m.name) + '" data-a="mute" data-v="' + esc(m.id) + '"></button></div></div></section></main>';
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
// Over the workshop network's plain http, "Add to Home Screen" is how a phone keeps the app
// (Chrome's own Install prompt only comes with https; when it does, Install uses it).
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; render(); });
window.addEventListener('appinstalled', () => { installPrompt = null; store.set('installHide', true); render(); });
const SHARE = 'M12 3v12 M8 7l4-4 4 4 M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7';
const DOTS = 'M12 5v.5 M12 12v.5 M12 19v.5';
function installSteps() {
  const step = (n, html) => '<li><span class="ord">' + n + '</span><span>' + html + '</span></li>';
  if (isIOS) return '<ol class="steps">' + step(1, 'Tap <b>Share</b> ' + ic(SHARE, 18) + ' in Safari\'s toolbar') + step(2, 'Scroll down and tap <b>Add to Home Screen</b>') + step(3, 'Tap <b>Add</b>. Pathline Monitor is on the Home Screen, with its white tile') + '</ol>';
  if (isAndroid) return '<ol class="steps">' + step(1, 'Tap the menu ' + ic(DOTS, 18) + ' in Chrome\'s corner') + step(2, 'Tap <b>Add to Home screen</b> (or <b>Install app</b>)') + step(3, 'Tap <b>Add</b>. Pathline Monitor is on the Home screen') + '</ol>';
  return '<ol class="steps">' + step(1, 'Open this page on the phone, on the workshop Wi-Fi') + step(2, 'Use the browser\'s <b>Add to Home Screen</b>') + '</ol>';
}
function installCard() {
  if (standalone || onDesk() || store.get('installHide', false)) return '';
  return '<div class="list install"><div class="set"><img class="mark" src="icon.svg" alt="" style="width:36px;height:36px"><span class="body">Keep Pathline Monitor on your Home Screen<span class="s">It opens full screen, like an app, one tap away</span></span>' +
    (installPrompt ? '<button class="btn-primary" data-a="install">Install</button>' : '<button class="tb" data-a="howInstall">How</button>') + '</div>' +
    (ui.howInstall ? '<div class="hint">' + installSteps() + '<button class="tb" data-a="installHide" style="margin-top:8px">Done, hide this</button></div>' : '') + '</div>';
}
// the PC's view: a QR code beside the app, for a phone's camera
let phone = null;
function deskCard() {
  if (!onDesk()) return '';
  if (!phone) { phone = {}; fetch('api/phone').then((r) => r.json()).then((v) => { phone = v; render(); }).catch(() => {}); }
  const url = phone.urls && phone.urls[0];
  return '<aside class="desk" aria-label="Get Pathline Monitor on a phone"><img src="icon.svg" alt="" width="48" height="48"><h2>Pathline Monitor is for your phone</h2>' +
    '<p>Scan this with the phone\'s camera, on the workshop Wi-Fi, then add it to the Home Screen.</p>' +
    (phone.qr ? '<div class="qr">' + phone.qr + '</div>' : '<div class="qr empty">' + (phone.urls ? 'This PC has no network address' : '') + '</div>') +
    (url ? '<p class="url mono">' + esc(url.replace(/\/$/, '')) + '</p>' : '') +
    '<p class="small"><b>iPhone</b>: Share, then Add to Home Screen.<br><b>Android</b>: menu, then Add to Home screen.</p></aside>';
}
const canPush = window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function phoneCard() {
  const p = ui.prefs || {};
  const sound = '<div class="set"><span class="body">Sound while the app is open<span class="s">A short tone and a buzz with each alert</span></span><button role="switch" class="sw" aria-checked="' + (p.sound !== false) + '" aria-label="Sound while the app is open" data-a="pref" data-v="sound"></button></div>';
  const test = '<div class="set"><span class="body">Try an alert<span class="s">Shows one here, with the sound</span></span><button class="tb" data-a="testLocal">Try it</button></div>';
  // the workshop network: alerts reach the phone while the app is open
  if (!window.isSecureContext) return '<div class="hint"><b>Alerts show here while Pathline Monitor is open.</b> Keep it open on the phone you carry around the workshop. For alerts with the app closed, the Monitor needs a certificate the phones trust (see the README).</div>' + sound + test;
  if (isIOS && !standalone) return '<div class="hint"><b>Add Pathline Monitor to your Home Screen first.</b> On iPhone, notifications only work from the Home Screen app: tap Share, then Add to Home Screen, and open Pathline Monitor from there.</div>';
  if (!canPush) return '<div class="hint"><b>This browser can\'t show notifications.</b> Use Safari on iPhone, or Chrome on Android.</div>';
  if (Notification.permission === 'denied') return '<div class="hint"><b>Notifications are blocked for Pathline Monitor.</b> Allow them in the phone\'s settings for this app, then come back here.</div>';
  if (ui.notif) return sound + '<div class="set"><span class="body">Notifications are on<span class="s">' + esc(ui.note || 'This phone gets the alerts chosen below') + '</span></span><span class="acts"><button class="tb" data-a="testPush"' + (ui.busy ? ' disabled' : '') + '>Send a test</button></span></div>' +
    '<div class="set"><span class="body">Stop notifications on this phone</span><button class="tb" data-a="pushOff"' + (ui.busy ? ' disabled' : '') + '>Turn off</button></div>';
  return sound + '<div class="set"><span class="body">Notifications with the app closed<span class="s">' + esc(ui.note || 'Off. Turn them on to hear when jobs finish.') + '</span></span><button class="btn-primary" data-a="pushOn"' + (ui.busy ? ' disabled' : '') + '>Turn on</button></div>';
}

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
    '<section class="sec"><div class="sec-h">Machines</div><div class="list">' + M.map((m) => '<div class="set">' + badge(m) + '<span class="body">' + esc(m.name) + '<span class="s">' + esc((m.model ? m.model + ' · ' : '') + m.address) + '</span></span><button role="switch" class="sw" aria-checked="' + !(p.mute && p.mute[m.id]) + '" aria-label="Alerts for ' + esc(m.name) + '" data-a="mute" data-v="' + esc(m.id) + '"></button></div>').join('') +
    (S && S.canFind ? '<div class="set"><span class="body">' + (S.finding ? 'Looking on the network…' : 'Look for new machines') + '<span class="s">' + (S.lastFind ? 'Last looked at ' + clock(S.lastFind) + '. ' : '') + 'Every Pathline Run on this network is added</span></span><button class="tb" data-a="find"' + (S.finding ? ' disabled' : '') + '>Look now</button></div>' : '') + '</div></section>' +
    '<span style="font-size:12px;color:var(--text-4);padding:0 2px">Pathline Monitor ' + esc(S ? S.app : '') + '</span></main>';
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
function render() {
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
function connect() {
  const es = new EventSource('api/events');
  es.onmessage = (e) => { S = JSON.parse(e.data); gotAt = Date.now(); live = true; newAlerts(S.alerts); render(); };
  es.onerror = () => { live = false; render(); };
}
setInterval(render, 1000);

// ---------------------------------------------------------------- this phone's settings and push
async function saveDevice(extra) {
  const r = await fetch('api/device', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: deviceId, prefs: { ...ui.prefs, tzOffset: new Date().getTimezoneOffset() }, name: navigator.userAgent.slice(0, 80), ...extra }) });
  const v = await r.json();
  if (!r.ok) throw new Error(v.error || 'Not saved');
  ui.prefs = v.prefs; ui.notif = v.notifications;
}
async function loadDevice() {
  try { const v = await (await fetch('api/device?id=' + encodeURIComponent(deviceId))).json(); ui.prefs = v.prefs; ui.notif = v.notifications; } catch (e) { ui.prefs = ui.prefs || { done: true, queue: true, attn: true, err: true, quiet: false, sound: true, mute: {} }; }
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
    const { key } = await (await fetch('api/push-key')).json();
    const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) });
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
  try { const r = await fetch('api/test-push', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: deviceId }) }); const v = await r.json(); ui.note = r.ok ? 'Test sent. It should arrive in a few seconds.' : v.error; }
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
  else if (h === 'alerts' || h === 'prefs') { ui.view = h; ui.machine = null; }
  else { ui.view = 'machines'; ui.machine = null; }
  render();
}
window.addEventListener('popstate', fromHash);
window.addEventListener('resize', () => render());

const H = {
  go: (v) => { if (ui.view === 'alerts' && v !== 'alerts') markSeen(true); ui.view = v; ui.machine = null; route(); },
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
  find: async () => { try { await fetch('api/find', { method: 'POST' }); } catch (e) { /* the stream shows the result */ } },
};
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
connect();
loadDevice();

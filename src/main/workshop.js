// The workshop's Pathline Monitor, for reaching machines from anywhere (Pathline Monitor 0.7).
//
// This computer signs in once with the workshop password (the one phones use) and a code from
// the authenticator app (Google or Microsoft Authenticator …, set up on a phone in Pathline
// Monitor: Settings, Pathline Prepare). Pathline Monitor gives it its own key, kept in
// workshop.json in the data folder (sealed with Windows' own protection when it can be).
// Removing the computer in Pathline Monitor, or changing the workshop password, ends it.
//
// Then any machine in Pathline Monitor can be added here. On the workshop network Prepare talks
// to a machine directly, as always; when the machine doesn't answer there (working from home, at
// another site), device.js sends the same call through Pathline Monitor instead. Only what Prepare
// does with a machine goes that way: reading it, queuing a job, reordering or removing queued
// jobs, the materials list. Start, the head and outputs never do: a job waits in the machine's
// queue for someone to press Start there.
'use strict';

const os = require('os');
const crypto = require('crypto');

const fail = (msg, extra) => Object.assign(new Error(msg), extra || {});

// "monitor.example.com", "https://monitor.example.com/" → https://monitor.example.com.
// Plain http:// only for this computer (testing).
function address(s) {
  let a = String(s || '').trim();
  if (!a) throw fail('Type the Pathline Monitor address, as the phones open it, such as monitor.example.com');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(a)) a = 'https://' + a;
  let u;
  try { u = new URL(a); } catch (e) { throw fail('"' + String(s).trim() + '" isn\'t an address. Type it as the phones open it, such as monitor.example.com'); }
  if (u.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(u.hostname)) throw fail('Pathline Monitor is reached over https only. Type the address without http://');
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw fail('Pathline Monitor\'s address starts https://');
  if (u.username || u.password || u.search || u.hash) throw fail('Type only the address, such as monitor.example.com');
  return u.origin + u.pathname.replace(/\/+$/, '');
}

// o: { store, log(s), seal(s) → string, unseal(s) → string, name } (seal: Electron's safeStorage)
function createWorkshop(o) {
  const log = (s) => { try { o.log && o.log(s); } catch (e) { /* never in the way */ } };
  const seal = o.seal || ((s) => 'plain:' + s);
  const unseal = o.unseal || ((s) => String(s).replace(/^plain:/, ''));
  // { address, key (sealed), computer, name, joinedAt } or { address } after signing out
  const saved = () => o.store.get('workshop') || {};
  const keep = (v) => o.store.set('workshop', v);
  // this computer's id in Pathline Monitor (kept, so signing in again replaces its old key)
  const computer = () => {
    const w = saved();
    if (w.computer) return w.computer;
    const id = 'prep-' + crypto.randomBytes(9).toString('hex');
    keep({ ...w, computer: id });
    return id;
  };
  let key = null;
  const keyOf = () => {
    if (key) return key;
    const w = saved();
    if (!w.key) return null;
    try { key = unseal(w.key); } catch (e) { log('the workshop key couldn\'t be read: sign in again'); return null; }
    return key;
  };

  async function ask(method, route, opts = {}) {
    const w = saved();
    if (!w.address) throw fail('Not signed in to the workshop', { status: 401 });
    const headers = { accept: 'application/json', ...(opts.headers || {}) };
    if (!opts.noKey) { const k = keyOf(); if (!k) throw fail('This computer isn\'t signed in to the workshop. Sign in: Setup, Machines, Add machine, Machines in your workshop.', { status: 401, signedOut: true }); headers.authorization = 'Bearer ' + k; }
    let res;
    try {
      res = await fetch(w.address + route, { method, headers, body: opts.body, signal: AbortSignal.timeout(opts.timeout || 15000) });
    } catch (err) {
      const why = err.name === 'TimeoutError' ? 'no answer in ' + Math.round((opts.timeout || 15000) / 1000) + ' s' : (err.cause && err.cause.code) || err.message;
      throw fail('Can\'t reach Pathline Monitor at ' + w.address.replace(/^https:\/\//, '') + ' (' + why + ')', { offline: true });
    }
    return res;
  }
  const readJson = async (res) => { const t = await res.text(); try { return t ? JSON.parse(t) : null; } catch (e) { return { raw: t }; } };

  // the key stopped working (removed in Pathline Monitor, or the workshop password changed)
  function signedOut() {
    const w = saved();
    if (w.key) log('signed out by Pathline Monitor (removed there, or the workshop password changed)');
    key = null;
    keep({ address: w.address, computer: w.computer });
  }

  return {
    address,
    connected: () => !!(saved().key && saved().address),
    status: () => { const w = saved(); return { connected: !!(w.key && w.address), address: w.address || '', label: (w.address || '').replace(/^https:\/\//, ''), name: w.name || '', joinedAt: w.joinedAt || null }; },

    // { address, password, code } → { machines }; errors carry need: 'password' | 'code' | 'setup'
    async join(b) {
      const base = address(b && b.address);
      const name = String(o.name || os.hostname() || 'Pathline Prepare').slice(0, 60);
      keep({ ...saved(), address: base });
      const res = await ask('POST', '/api/v1/prepare/join', {
        noKey: true, headers: { 'content-type': 'application/json' }, timeout: 20000,
        body: JSON.stringify({ id: computer(), name, password: String((b && b.password) || ''), code: String((b && b.code) || '').trim() })
      });
      const v = (await readJson(res)) || {};
      if (res.status === 404) throw fail('No Pathline Monitor 0.7 at ' + base.replace(/^https:\/\//, '') + '. Check the address, and that Pathline Monitor has been updated.');
      if (!res.ok || !v.key) throw fail(v.error || 'Pathline Monitor answered ' + res.status, { need: v.need || null });
      key = v.key;
      keep({ address: base, key: seal(v.key), computer: computer(), name: v.name || name, joinedAt: new Date().toISOString() });
      log('signed in to ' + base);
      return { machines: v.machines || [] };
    },

    // the machines in Pathline Monitor
    async machines() {
      const res = await ask('GET', '/api/v1/prepare/machines');
      const v = (await readJson(res)) || {};
      if (res.status === 401) { signedOut(); throw fail(v.error || 'Signed out of the workshop', { signedOut: true }); }
      if (!res.ok) throw fail(v.error || 'Pathline Monitor answered ' + res.status);
      return v.machines || [];
    },

    // one call to a machine through Pathline Monitor, answered like device.js's request:
    // { data, ms, via: 'monitor' }; err.offline when the machine (or Monitor) can't be reached
    async call(m, method, route, body, timeout) {
      const t0 = Date.now();
      const res = await ask('POST', '/api/v1/prepare/call/' + encodeURIComponent(m.monitorId), {
        headers: { 'x-pathline-call': method + ' ' + route, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        // a job takes a while to go up and be queued; reads are quick
        timeout: Math.max(Number(timeout) || 0, method === 'GET' ? 20000 : 90000)
      });
      const data = await readJson(res);
      if (res.status === 401 && !res.headers.get('x-pathline-via')) { signedOut(); throw fail((data && data.error) || 'Signed out of the workshop', { offline: true }); }
      if (!res.ok) throw fail((data && data.error) || 'Pathline Monitor answered ' + res.status, { status: res.status, offline: !!(data && data.offline) || res.status === 503 || res.status === 504 });
      return { data, ms: Date.now() - t0, via: 'monitor' };
    },

    async leave() {
      try { await ask('POST', '/api/v1/prepare/leave', { timeout: 8000 }); } catch (e) { /* forgotten here either way */ }
      const w = saved();
      key = null;
      keep({ address: w.address, computer: w.computer });
      log('signed out of ' + (w.address || 'the workshop'));
    }
  };
}

module.exports = { createWorkshop, address };

// Letting Pathline Prepare find this machine without an IP address being typed
// (hmi/RUN-DISCOVERY-BRIEF.md).
//
// Run answers mDNS / DNS-SD questions for "_pathline._tcp.local" on UDP 5353:
//  - PTR  _pathline._tcp.local        → <name>._pathline._tcp.local   (answers)
//  - SRV  <name>._pathline._tcp.local → Run's HTTP port, <host>.local  (additionals)
//  - TXT  <name>._pathline._tcp.local → id, name, type, ctrl, model, protocol, app
//  - A    <host>.local                → each IPv4 address (not 127.x or 169.254.x)
// A question from an ordinary port (Prepare's, with the unicast-reply bit) is answered straight
// back to that port (RFC 6762 §6.7), which Windows Firewall lets in as a reply; a question from
// 5353 (another mDNS device) gets the usual multicast answer. Run also announces itself unasked,
// twice 1 s apart, on start-up and whenever its name, port or addresses change, and says goodbye
// (TTL 0) when it closes.
//
// No library: the packets are small and this keeps the app free of extra modules.
'use strict';

const os = require('os');
const dgram = require('dgram');

const SERVICE = '_pathline._tcp.local';
const MDNS = { address: '224.0.0.251', port: 5353 };
const T = { A: 1, PTR: 12, TXT: 16, SRV: 33, ANY: 255 };
const TTL = 120;
const lower = (s) => String(s || '').toLowerCase();

// ---------------------------------------------------------------- packets
function encodeName(name) {
  const parts = String(name).replace(/\.$/, '').split('.').filter(Boolean);
  const bufs = parts.map((p) => { const b = Buffer.from(p, 'utf8').subarray(0, 63); return Buffer.concat([Buffer.from([b.length]), b]); });
  return Buffer.concat(bufs.concat([Buffer.from([0])]));
}
function readName(buf, off) {
  const labels = [];
  let jumped = false, end = off, guard = 0;
  while (off < buf.length && guard++ < 128) {
    const len = buf[off];
    if (len === 0) { off++; break; }
    if ((len & 0xc0) === 0xc0) {
      if (off + 1 >= buf.length) break;
      if (!jumped) end = off + 2;
      off = ((len & 0x3f) << 8) | buf[off + 1];
      jumped = true;
      continue;
    }
    labels.push(buf.toString('utf8', off + 1, off + 1 + len));
    off += 1 + len;
  }
  return { name: labels.join('.'), end: jumped ? end : off };
}

// The questions in a packet: [{ name, type, qu }] (null when it isn't a question)
function questions(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf.readUInt16BE(2) & 0x8000) return null; // an answer
  const n = buf.readUInt16BE(4);
  const out = [];
  let off = 12;
  for (let i = 0; i < n && off < buf.length; i++) {
    const q = readName(buf, off);
    off = q.end;
    if (off + 4 > buf.length) break;
    out.push({ name: q.name, type: buf.readUInt16BE(off), qu: !!(buf.readUInt16BE(off + 2) & 0x8000) });
    off += 4;
  }
  return { id: buf.readUInt16BE(0), questions: out };
}

// The DNS-SD names and TXT values for this machine
function records(info) {
  // a name for the service instance: dots would split it into labels
  const instance = (String(info.name || '').trim() || 'Pathline Run').replace(/\./g, ' ').slice(0, 63);
  const host = (String(info.hostname || 'pathline-run').replace(/\.local$/i, '').replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'pathline-run').slice(0, 63) + '.local';
  const txt = { id: info.id, name: String(info.name || '').trim() || 'Pathline Run', type: info.type, ctrl: info.ctrl, model: info.model, protocol: 1, app: info.app };
  return { instance: instance + '.' + SERVICE, host, port: info.port, txt, ips: info.ips || [] };
}

// One answer: the PTR in answers, SRV, TXT and the A records in additionals.
// opts: { id, ttl, question (legacy unicast: echo the question back) }
function encodeAnswer(rec, opts = {}) {
  const ttl = opts.ttl === undefined ? TTL : opts.ttl;
  const rr = (name, type, data, flush) => {
    const head = Buffer.alloc(10);
    head.writeUInt16BE(type, 0);
    // the cache-flush bit marks records only this machine owns (not in legacy unicast replies)
    head.writeUInt16BE(flush && !opts.question ? 0x8001 : 1, 2);
    head.writeUInt32BE(ttl, 4);
    head.writeUInt16BE(data.length, 8);
    return Buffer.concat([encodeName(name), head, data]);
  };
  const srv = Buffer.alloc(6);
  srv.writeUInt16BE(rec.port, 4);
  const txt = Buffer.concat(Object.entries(rec.txt).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => {
    const b = Buffer.from(k + '=' + v, 'utf8').subarray(0, 255);
    return Buffer.concat([Buffer.from([b.length]), b]);
  }));
  const extra = [
    rr(rec.instance, T.SRV, Buffer.concat([srv, encodeName(rec.host)]), true),
    rr(rec.instance, T.TXT, txt.length ? txt : Buffer.from([0]), true)
  ].concat(rec.ips.map((ip) => rr(rec.host, T.A, Buffer.from(ip.split('.').map(Number)), true)));
  const h = Buffer.alloc(12);
  h.writeUInt16BE(opts.id || 0, 0);
  h.writeUInt16BE(0x8400, 2);
  const q = opts.question ? [encodeName(opts.question.name), Buffer.from([opts.question.type >> 8, opts.question.type & 255, 0, 1])] : [];
  h.writeUInt16BE(q.length ? 1 : 0, 4);
  h.writeUInt16BE(1, 6);
  h.writeUInt16BE(extra.length, 10);
  return Buffer.concat([h, ...q, rr(SERVICE, T.PTR, encodeName(rec.instance), false), ...extra]);
}

// Whether a question is about this machine
function asksForUs(q, rec) {
  const n = lower(q.name);
  if (n === lower(SERVICE)) return q.type === T.PTR || q.type === T.ANY;
  if (n === lower(rec.instance)) return [T.SRV, T.TXT, T.ANY].includes(q.type);
  if (n === lower(rec.host)) return q.type === T.A || q.type === T.ANY;
  return false;
}

// ---------------------------------------------------------------- the network
const ipToInt = (ip) => ip.split('.').reduce((n, x) => n * 256 + Number(x), 0) >>> 0;

// This computer's IPv4 addresses that others can reach: [{ address, netmask }]
function addresses(ifaces) {
  const out = [];
  for (const list of Object.values(ifaces || os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || /^127\./.test(a.address) || /^169\.254\./.test(a.address)) continue;
      out.push({ address: a.address, netmask: a.netmask || '255.255.255.0' });
    }
  }
  return out;
}

// The addresses, the one on the asker's network first (Prepare uses the first A record)
function ordered(addrs, from) {
  if (!from || !/^\d+\.\d+\.\d+\.\d+$/.test(from)) return addrs.map((a) => a.address);
  const same = (a) => (ipToInt(a.address) & ipToInt(a.netmask)) === (ipToInt(from) & ipToInt(a.netmask));
  return addrs.filter(same).concat(addrs.filter((a) => !same(a))).map((a) => a.address);
}

// ---------------------------------------------------------------- the responder
// getInfo(): { id, name, type, ctrl, model, app, port } (null while there's no machine set up,
// so nothing is announced). opts: { log, port (5353), interfaces (for tests), every (address check, ms) }
function start(getInfo, opts = {}) {
  const log = opts.log || (() => {});
  const listenPort = opts.port === undefined ? MDNS.port : opts.port;
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let closed = false, joined = new Set(), last = '', timers = [];
  const addrs = () => addresses(opts.interfaces ? opts.interfaces() : undefined);

  const current = (from) => {
    let info = null;
    try { info = getInfo(); } catch (e) { info = null; }
    if (!info || !info.id) return null;
    return records({ ...info, hostname: os.hostname(), ips: ordered(addrs(), from) });
  };

  // join the mDNS group on every network (again when one appears)
  const join = () => {
    for (const a of addrs()) {
      if (joined.has(a.address)) continue;
      try { sock.addMembership(MDNS.address, a.address); joined.add(a.address); } catch (e) { /* that network can't multicast */ }
    }
  };

  // to everyone, on each network in turn
  const multicast = (ttl) => {
    const all = addrs();
    for (const a of all) {
      const rec = current(a.address);
      if (!rec) return;
      try { sock.setMulticastInterface(a.address); } catch (e) { continue; }
      sock.send(encodeAnswer(rec, { ttl }), MDNS.port, MDNS.address, () => {});
    }
  };
  const announce = () => {
    if (closed || !current()) return;
    multicast();
    timers.push(setTimeout(() => { if (!closed) multicast(); }, 1000));
  };

  sock.on('error', (e) => { log('discovery: ' + e.message); });
  sock.on('message', (msg, rinfo) => {
    const p = questions(msg);
    if (!p || !p.questions.length) return;
    const rec = current(rinfo.address);
    if (!rec) return;
    const q = p.questions.find((x) => asksForUs(x, rec));
    if (!q) return;
    if (rinfo.port !== MDNS.port) {
      // an ordinary port: straight back to it, with its ID and question (legacy unicast)
      sock.send(encodeAnswer(rec, { id: p.id, question: q }), rinfo.port, rinfo.address, () => {});
    } else if (q.qu) {
      sock.send(encodeAnswer(rec), rinfo.port, rinfo.address, () => {});
    } else {
      // a little later, as mDNS asks, so several machines don't answer at once
      timers.push(setTimeout(() => { if (!closed) multicast(); }, 20 + Math.floor(Math.random() * 100)));
    }
  });

  // what's announced: when it changes (name, port, an address), announce again
  const signature = () => { const r = current(); return r ? JSON.stringify([r.instance, r.port, r.txt, r.ips.slice().sort()]) : ''; };
  const check = () => {
    if (closed) return;
    join();
    const s = signature();
    if (s && s !== last) { last = s; announce(); }
    last = s;
  };

  const ready = new Promise((resolve) => {
    sock.bind(listenPort, () => {
      try { sock.setMulticastTTL(255); sock.setMulticastLoopback(true); } catch (e) { /* fine */ }
      join();
      const r = current();
      log('discovery: answering for ' + SERVICE + (r ? ' as "' + r.txt.name + '" (' + r.txt.id + ') on ' + (r.ips.join(', ') || 'no network yet') : ' once a machine is set up'));
      check();
      resolve();
    });
  });
  const poll = setInterval(check, opts.every || 10000);
  if (poll.unref) poll.unref();

  return {
    ready,
    // the name or settings changed: announce now if what's announced is different
    update: check,
    port: () => sock.address().port,
    // goodbye (TTL 0), then close
    close: () => new Promise((resolve) => {
      if (closed) return resolve();
      try { if (current()) multicast(0); } catch (e) { /* closing anyway */ }
      closed = true;
      clearInterval(poll);
      timers.forEach(clearTimeout);
      setTimeout(() => { try { sock.close(); } catch (e) { /* closed */ } resolve(); }, 50);
    })
  };
}

module.exports = { SERVICE, start, addresses, _packet: { encodeAnswer, questions, records, asksForUs, ordered } };

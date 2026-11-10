// Finding Pathline Run machines on the network without typing an IP address.
//
// Two ways, used together (Setup → Machines → Add machine → Find machines):
//  - scan: ask every address on this computer's local networks for
//    GET /api/v1/info on port 8470. Works with any Pathline Run (and the
//    emulator), but only on the computer's own subnet.
//  - announce (mDNS / DNS-SD, the way printers are found): ask the network for
//    "_pathline._tcp.local"; each Pathline Run that announces itself answers
//    with its address, port and a TXT record { id, name, type, ctrl, model,
//    protocol, app } (hmi/RUN-DISCOVERY-BRIEF.md). The question is sent from
//    an ordinary port, so Run answers straight back to it (RFC 6762 §6.7,
//    "legacy unicast"), which Windows Firewall lets through as a reply.
//
// A machine's `id` (from Run's /info and TXT record) is what lets Prepare
// follow a machine whose IP address changed (relocate()).
'use strict';

const os = require('os');
const dgram = require('dgram');

const SERVICE = '_pathline._tcp.local';
const DEFAULT_PORT = 8470;
const MDNS = { address: '224.0.0.251', port: 5353 };
const T = { PTR: 12, TXT: 16, SRV: 33, A: 1 };

// ---------------------------------------------------------------- network scan
const ipToInt = (ip) => ip.split('.').reduce((n, x) => n * 256 + Number(x), 0);
const intToIp = (n) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.');
const prefixOf = (mask) => mask.split('.').reduce((n, x) => n + ((Number(x) >>> 0).toString(2).match(/1/g) || []).length, 0);

// The addresses to ask: every other host on each local IPv4 network this
// computer is on (a network bigger than /24 is narrowed to the /24 around the
// computer's own address, so a scan never asks more than 254 addresses each).
function scanHosts(ifaces) {
  const out = new Set();
  for (const list of Object.values(ifaces || os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || !a.netmask || /^169\.254\./.test(a.address)) continue;
      const prefix = Math.max(24, prefixOf(a.netmask));
      if (prefix >= 31) continue;
      const size = 2 ** (32 - prefix);
      const base = Math.floor(ipToInt(a.address) / size) * size;
      for (let i = 1; i < size - 1; i++) out.add(intToIp(base + i));
    }
  }
  return [...out];
}

// One address: a Pathline machine answers /info with its type and protocol.
async function probe(ip, port, timeout) {
  try {
    const res = await fetch('http://' + ip + ':' + port + '/api/v1/info', { signal: AbortSignal.timeout(timeout) });
    if (!res.ok) return null;
    const info = await res.json();
    if (!info || (info.type !== 'laser' && info.type !== 'plotter')) return null;
    return { ip, port, id: info.id ? String(info.id) : null, name: info.name ? String(info.name).trim() : '', type: info.type, ctrl: info.ctrl || '', model: info.model || '', app: info.app || '', via: ['scan'] };
  } catch (e) {
    return null;
  }
}

async function scan(opts = {}) {
  const hosts = opts.hosts || scanHosts();
  const port = Number(opts.port) || DEFAULT_PORT;
  const timeout = opts.timeout || 900;
  const found = [];
  let next = 0;
  const worker = async () => {
    while (next < hosts.length) {
      const r = await probe(hosts[next++], port, timeout);
      if (r) found.push(r);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency || 128, hosts.length) }, worker));
  return found;
}

// ---------------------------------------------------------------- mDNS packets
function encodeName(name) {
  const parts = String(name).replace(/\.$/, '').split('.').filter(Boolean);
  const bufs = parts.map((p) => { const b = Buffer.from(p, 'utf8'); return Buffer.concat([Buffer.from([b.length]), b]); });
  return Buffer.concat(bufs.concat([Buffer.from([0])]));
}
function readName(buf, off) {
  const labels = [];
  let jumped = false, end = off, guard = 0;
  while (off < buf.length && guard++ < 128) {
    const len = buf[off];
    if (len === 0) { off++; break; }
    if ((len & 0xc0) === 0xc0) {
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
const lower = (s) => String(s || '').toLowerCase();

// A question for every machine that announces itself (QU: answer to me)
function encodeQuery(id) {
  const h = Buffer.alloc(12);
  h.writeUInt16BE(id || 0, 0);
  h.writeUInt16BE(1, 4);
  const q = Buffer.alloc(4);
  q.writeUInt16BE(T.PTR, 0);
  q.writeUInt16BE(0x8001, 2);
  return Buffer.concat([h, encodeName(SERVICE), q]);
}

// An answer, as Pathline Run sends it (used by the self-test and the emulator)
// rec: { instance, host, ip, port, txt: { id, name, ... } }
function encodeAnswer(rec, id) {
  const instance = rec.instance + '.' + SERVICE;
  const rr = (name, type, data, cls) => {
    const head = Buffer.alloc(10);
    head.writeUInt16BE(type, 0);
    head.writeUInt16BE(cls || 1, 2);
    head.writeUInt32BE(120, 4);
    head.writeUInt16BE(data.length, 8);
    return Buffer.concat([encodeName(name), head, data]);
  };
  const srv = Buffer.alloc(6);
  srv.writeUInt16BE(rec.port || DEFAULT_PORT, 4);
  const txt = Buffer.concat(Object.entries(rec.txt || {}).map(([k, v]) => { const b = Buffer.from(k + '=' + v, 'utf8'); return Buffer.concat([Buffer.from([b.length]), b]); }));
  const records = [
    rr(SERVICE, T.PTR, encodeName(instance)),
    rr(instance, T.SRV, Buffer.concat([srv, encodeName(rec.host)]), 0x8001),
    rr(instance, T.TXT, txt.length ? txt : Buffer.from([0]), 0x8001),
    rr(rec.host, T.A, Buffer.from(rec.ip.split('.').map(Number)), 0x8001)
  ];
  const h = Buffer.alloc(12);
  h.writeUInt16BE(id || 0, 0);
  h.writeUInt16BE(0x8400, 2);
  h.writeUInt16BE(1, 6);
  h.writeUInt16BE(records.length - 1, 10);
  return Buffer.concat([h].concat(records));
}

function decode(buf) {
  if (buf.length < 12) return null;
  const qd = buf.readUInt16BE(4), counts = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  const flags = buf.readUInt16BE(2);
  let off = 12;
  for (let i = 0; i < qd; i++) off = readName(buf, off).end + 4;
  const rrs = [];
  for (let i = 0; i < counts && off + 10 <= buf.length; i++) {
    const n = readName(buf, off);
    off = n.end;
    const type = buf.readUInt16BE(off), len = buf.readUInt16BE(off + 8);
    const at = off + 10;
    off = at + len;
    if (off > buf.length) break;
    let data = null;
    if (type === T.PTR) data = readName(buf, at).name;
    else if (type === T.SRV) data = { port: buf.readUInt16BE(at + 4), target: readName(buf, at + 6).name };
    else if (type === T.A && len === 4) data = [buf[at], buf[at + 1], buf[at + 2], buf[at + 3]].join('.');
    else if (type === T.TXT) {
      data = {};
      for (let p = at; p < at + len;) {
        const l = buf[p];
        const s = buf.toString('utf8', p + 1, p + 1 + l);
        const eq = s.indexOf('=');
        if (s && eq !== 0) data[eq < 0 ? s : s.slice(0, eq)] = eq < 0 ? '' : s.slice(eq + 1);
        p += 1 + l;
      }
    }
    if (data !== null) rrs.push({ name: n.name, type, data });
  }
  return { response: !!(flags & 0x8000), rrs };
}

// The machines described by a set of answers (from one or more packets)
function machinesFrom(packets) {
  const all = packets.flatMap((p) => p.rrs.map((r) => ({ ...r, from: p.from })));
  const of = (name, type) => all.find((r) => r.type === type && lower(r.name) === lower(name));
  const out = [];
  for (const ptr of all.filter((r) => r.type === T.PTR && lower(r.name) === lower(SERVICE))) {
    const srv = of(ptr.data, T.SRV), txt = (of(ptr.data, T.TXT) || {}).data || {};
    const a = srv && of(srv.data.target, T.A);
    const ip = (a && a.data) || ptr.from;
    if (!ip) continue;
    const type = txt.type === 'laser' || txt.type === 'plotter' ? txt.type : null;
    out.push({
      ip, port: (srv && srv.data.port) || DEFAULT_PORT, id: txt.id || null,
      name: txt.name || ptr.data.slice(0, ptr.data.length - SERVICE.length - 1), type, ctrl: txt.ctrl || '', model: txt.model || '', app: txt.app || '', via: ['announce']
    });
  }
  return out;
}

// Ask the network for machines that announce themselves, and collect the
// answers for `timeout` ms. opts.to: { address, port } to ask one responder
// directly (the self-test).
function browse(opts = {}) {
  const timeout = opts.timeout || 1800;
  return new Promise((resolve) => {
    const packets = [];
    const socks = [];
    const done = () => { socks.forEach((s) => { try { s.close(); } catch (e) { /* closed */ } }); resolve(merge(machinesFrom(packets))); };
    const onMsg = (msg, rinfo) => { const p = decode(msg); if (p && p.response) packets.push({ ...p, from: rinfo.address }); };
    const qid = 1 + Math.floor(Math.random() * 65000);
    const ask = dgram.createSocket({ type: 'udp4' });
    socks.push(ask);
    ask.on('message', onMsg);
    ask.on('error', () => { /* no network: nothing found */ });
    ask.bind(0, () => {
      const send = () => {
        if (opts.to) { ask.send(encodeQuery(qid), opts.to.port, opts.to.address, () => {}); return; }
        const addrs = Object.values(os.networkInterfaces()).flat().filter((a) => a && (a.family === 'IPv4' || a.family === 4) && !a.internal).map((a) => a.address);
        for (const addr of addrs.length ? addrs : [null]) {
          try { if (addr) ask.setMulticastInterface(addr); } catch (e) { /* that network can't multicast */ }
          ask.send(encodeQuery(qid), MDNS.port, MDNS.address, () => {});
        }
      };
      send();
      // once more, in case the first question was lost
      setTimeout(send, Math.min(700, timeout / 2));
    });
    // also hear answers sent to everyone (where the firewall lets them in)
    if (!opts.to) {
      const listen = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      socks.push(listen);
      listen.on('message', onMsg);
      listen.on('error', () => { /* port taken or blocked: the direct answers still arrive */ });
      try {
        listen.bind(MDNS.port, () => { try { listen.addMembership(MDNS.address); } catch (e) { /* no multicast */ } });
      } catch (e) { /* ignore */ }
    }
    setTimeout(done, timeout);
  });
}

// The same machine found more than once (both ways, or on two networks): by
// its id when it has one, else by address and port
function merge(list) {
  const out = [];
  for (const m of list) {
    const same = out.find((o) => (m.id && o.id ? o.id === m.id : o.ip === m.ip && o.port === m.port));
    if (!same) { out.push({ ...m, via: m.via.slice() }); continue; }
    for (const k of ['id', 'name', 'type', 'ctrl', 'model', 'app']) if (!same[k] && m[k]) same[k] = m[k];
    same.via = [...new Set(same.via.concat(m.via))];
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name)) || ipToInt(a.ip) - ipToInt(b.ip));
}

// Find machines both ways at once
async function find(opts = {}) {
  const [a, b] = await Promise.all([browse(opts), scan(opts)]);
  return merge(a.concat(b));
}

// Saved machines whose address changed: [{ id, ip, port, was }] for each
// machine (with a deviceId) that announced itself somewhere else
async function relocate(machines, opts = {}) {
  const want = machines.filter((m) => m.deviceId && m.conn === 'Ethernet' && !m.sim);
  if (!want.length) return [];
  const found = await browse(opts);
  const out = [];
  for (const m of want) {
    const f = found.find((x) => x.id && x.id === m.deviceId);
    if (f && (f.ip !== String(m.ip || '').trim() || f.port !== (Number(m.port) || DEFAULT_PORT))) out.push({ id: m.id, ip: f.ip, port: f.port, was: m.ip });
  }
  return out;
}

module.exports = { SERVICE, scanHosts, scan, browse, find, relocate, merge, _packet: { encodeQuery, encodeAnswer, decode, machinesFrom } };

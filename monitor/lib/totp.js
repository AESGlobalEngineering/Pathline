// Two-step sign-in for Pathline Prepare: the 6-digit codes an authenticator app shows (Microsoft
// Authenticator, Google Authenticator, 1Password …; RFC 6238: HMAC-SHA1, 30 s, 6 digits), and the
// spare one-time codes for a lost phone. Nothing to install: Node's own crypto.
'use strict';

const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
// spare codes: letters and digits that can't be mistaken for each other
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const STEP = 30;

function toBase32(buf) {
  let bits = 0, v = 0, out = '';
  for (const b of buf) { v = (v << 8) | b; bits += 8; while (bits >= 5) { out += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(v << (5 - bits)) & 31];
  return out;
}
function fromBase32(s) {
  const clean = String(s).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, v = 0;
  const out = [];
  for (const c of clean) { v = (v << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}

// a new secret: 20 random bytes, as the 32 letters the app is given
const newSecret = () => toBase32(crypto.randomBytes(20));

// the code for one 30 s step
function code(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(step / 0x100000000), 0);
  msg.writeUInt32BE(step >>> 0, 4);
  const h = crypto.createHmac('sha1', fromBase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0');
}
const stepAt = (ms) => Math.floor(ms / 1000 / STEP);

// the step a typed code belongs to (this one, or one either side for a phone clock that's a
// little out), or -1. A step at or before `after` (a code already used) doesn't count again.
function check(secret, typed, now = Date.now(), after = -1) {
  const c = String(typed || '').replace(/\D/g, '');
  if (c.length !== 6) return -1;
  const s = stepAt(now);
  for (const t of [s, s - 1, s + 1]) {
    if (t <= after) continue;
    if (crypto.timingSafeEqual(Buffer.from(code(secret, t)), Buffer.from(c))) return t;
  }
  return -1;
}

// the setup link authenticator apps take (scanned as a QR code, or tapped on the phone itself)
function uri(secret, account, issuer = 'Pathline Monitor') {
  return 'otpauth://totp/' + encodeURIComponent(issuer) + ':' + encodeURIComponent(account) + '?secret=' + secret + '&issuer=' + encodeURIComponent(issuer) + '&algorithm=SHA1&digits=6&period=' + STEP;
}

// spare codes: 10 of 10 letters and digits each, shown as XXXXX-XXXXX; kept only as hashes
const normSpare = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const hashSpare = (s) => crypto.createHash('sha256').update('pathline-spare:' + normSpare(s)).digest('hex');
function newSpares(n = 10) {
  const list = [];
  for (let i = 0; i < n; i++) { const c = Array.from({ length: 10 }, () => LETTERS[crypto.randomInt(32)]).join(''); list.push(c.slice(0, 5) + '-' + c.slice(5)); }
  return list;
}
const isSpare = (s) => normSpare(s).length === 10;

module.exports = { newSecret, code, check, stepAt, uri, newSpares, hashSpare, isSpare, toBase32, fromBase32, STEP };

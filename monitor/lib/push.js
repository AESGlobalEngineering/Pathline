// Web Push with nothing but Node's own crypto: the message is encrypted for one phone
// (RFC 8291, aes128gcm) and signed as coming from this server (VAPID, RFC 8292), then handed
// to the phone maker's push service (Apple, Google, Mozilla, Microsoft).
'use strict';
const crypto = require('crypto');

const b64 = (b) => Buffer.from(b).toString('base64url');
const un = (s) => Buffer.from(String(s), 'base64url');
const hkdf = (ikm, salt, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));

// the server's own key pair, made once: { publicKey (65 bytes), privateKey (32 bytes) } as base64url
function newKeys() {
  const { d, x, y } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' });
  return { publicKey: b64(Buffer.concat([Buffer.from([4]), un(x), un(y)])), privateKey: d };
}

// "this really is Pathline Monitor": a token for one push service, reused for half a day
const tokens = new Map();
function token(keys, audience, subject) {
  const now = Math.floor(Date.now() / 1000);
  const have = tokens.get(audience);
  if (have && have.until > now) return have.t;
  const pub = un(keys.publicKey);
  const key = crypto.createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64(pub.subarray(1, 33)), y: b64(pub.subarray(33)) } });
  const head = b64(JSON.stringify({ typ: 'JWT', alg: 'ES256' })) + '.' + b64(JSON.stringify({ aud: audience, exp: now + 12 * 3600, sub: subject }));
  const t = head + '.' + b64(crypto.sign('sha256', Buffer.from(head), { key, dsaEncoding: 'ieee-p1363' }));
  tokens.set(audience, { t, until: now + 6 * 3600 });
  return t;
}

// the message, readable only by the phone that made this subscription
function encrypt(sub, payload) {
  const phone = un(sub.keys.p256dh);
  const auth = un(sub.keys.auth);
  const mine = crypto.createECDH('prime256v1');
  const pub = mine.generateKeys();
  const salt = crypto.randomBytes(16);
  const ikm = hkdf(mine.computeSecret(phone), auth, Buffer.concat([Buffer.from('WebPush: info\0'), phone, pub]), 32);
  const c = crypto.createCipheriv('aes-128-gcm', hkdf(ikm, salt, 'Content-Encoding: aes128gcm\0', 16), hkdf(ikm, salt, 'Content-Encoding: nonce\0', 12));
  const text = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(21);
  salt.copy(head);
  head.writeUInt32BE(4096, 16);
  head[20] = pub.length;
  return Buffer.concat([head, pub, text]);
}

// only the phone makers' push services: a subscription can't point this server anywhere else
const SERVICES = /(^|\.)(googleapis\.com|push\.apple\.com|mozilla\.com|mozaws\.net|notify\.windows\.com)$/;
function valid(sub) {
  try { const u = new URL(sub.endpoint); return u.protocol === 'https:' && SERVICES.test(u.hostname) && !!sub.keys.p256dh && !!sub.keys.auth; } catch (e) { return false; }
}

// sends one message; resolves { ok, gone } (gone: the phone unsubscribed, forget it)
async function send(keys, subject, sub, payload, { ttl = 3600, urgent = false } = {}) {
  const r = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      ttl: String(ttl), urgency: urgent ? 'high' : 'normal', 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream',
      authorization: 'vapid t=' + token(keys, new URL(sub.endpoint).origin, subject) + ', k=' + keys.publicKey,
    },
    body: encrypt(sub, payload),
  });
  return { ok: r.ok, gone: r.status === 404 || r.status === 410, status: r.status };
}

module.exports = { newKeys, token, encrypt, valid, send };

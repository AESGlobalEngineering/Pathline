// The workshop's own certificate, so phones can open Pathline Monitor over https on the local
// network: what turns it into a full app (installable, works offline, notifications when closed).
//
// Made once and kept in data/:
//   workshop-ca.key / .crt   a small certificate authority for this workshop only (10 years).
//                            It can only vouch for private network addresses (10.x, 172.16-31.x,
//                            192.168.x), *.local and localhost (X.509 name constraints), so a
//                            phone that trusts it can't be fooled about any real website.
//   monitor.key / .crt       this computer's certificate, signed by it: its own addresses and
//                            names, 397 days (phones refuse longer). Made again when the
//                            addresses change or a month before it runs out.
// Each phone trusts the authority once (the setup page hands it over: a profile on iPhone, a
// certificate on Android).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const forge = require('node-forge');

const PRIVATE = [['10.0.0.0', '255.0.0.0'], ['172.16.0.0', '255.240.0.0'], ['192.168.0.0', '255.255.0.0']];
const isPrivate = (ip) => {
  const n = ip.split('.').map(Number);
  return n[0] === 10 || (n[0] === 172 && n[1] >= 16 && n[1] <= 31) || (n[0] === 192 && n[1] === 168) || ip === '127.0.0.1';
};
const DAY = 864e5;

// node's own RSA keys (fast), in forge's form
function keys() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privateKey: forge.pki.privateKeyFromPem(privateKey.export({ type: 'pkcs1', format: 'pem' })),
    publicKey: forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' })),
  };
}
const serial = () => '01' + crypto.randomBytes(15).toString('hex');

// NameConstraints (RFC 5280 §4.2.1.10): permitted private IPv4 ranges, .local and localhost
function nameConstraints() {
  const A = forge.asn1;
  const ipBytes = (ip) => ip.split('.').map((x) => String.fromCharCode(Number(x))).join('');
  const subtree = (gn) => A.create(A.Class.UNIVERSAL, A.Type.SEQUENCE, true, [gn]);
  const ipName = ([ip, mask]) => A.create(A.Class.CONTEXT_SPECIFIC, 7, false, ipBytes(ip) + ipBytes(mask));
  const dnsName = (s) => A.create(A.Class.CONTEXT_SPECIFIC, 2, false, s);
  const permitted = [...PRIVATE, ['127.0.0.0', '255.0.0.0']].map(ipName).concat([dnsName('local'), dnsName('localhost')]).map(subtree);
  const value = A.create(A.Class.UNIVERSAL, A.Type.SEQUENCE, true, [A.create(A.Class.CONTEXT_SPECIFIC, 0, true, permitted)]);
  return { id: '2.5.29.30', critical: true, value: A.toDer(value).getBytes() };
}

function makeCA() {
  const k = keys();
  const c = forge.pki.createCertificate();
  c.publicKey = k.publicKey;
  c.serialNumber = serial();
  c.validity.notBefore = new Date(Date.now() - DAY);
  c.validity.notAfter = new Date(Date.now() + 3650 * DAY);
  const name = [{ name: 'commonName', value: 'Pathline Monitor workshop (' + os.hostname() + ')' }, { name: 'organizationName', value: 'Pathline Monitor' }];
  c.setSubject(name);
  c.setIssuer(name);
  c.setExtensions([
    { name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
    nameConstraints(),
  ]);
  c.sign(k.privateKey, forge.md.sha256.create());
  return { key: forge.pki.privateKeyToPem(k.privateKey), cert: forge.pki.certificateToPem(c) };
}

function makeLeaf(ca, ips, hosts) {
  const caKey = forge.pki.privateKeyFromPem(ca.key);
  const caCert = forge.pki.certificateFromPem(ca.cert);
  const k = keys();
  const c = forge.pki.createCertificate();
  c.publicKey = k.publicKey;
  c.serialNumber = serial();
  c.validity.notBefore = new Date(Date.now() - DAY);
  c.validity.notAfter = new Date(Date.now() + 397 * DAY);
  c.setSubject([{ name: 'commonName', value: hosts[0] || ips[0] || 'localhost' }]);
  c.setIssuer(caCert.subject.attributes);
  c.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: hosts.map((h) => ({ type: 2, value: h })).concat(ips.map((ip) => ({ type: 7, ip }))) },
    { name: 'subjectKeyIdentifier' },
    { name: 'authorityKeyIdentifier', keyIdentifier: caCert.generateSubjectKeyIdentifier().getBytes() },
  ]);
  c.sign(caKey, forge.md.sha256.create());
  return { key: forge.pki.privateKeyToPem(k.privateKey), cert: forge.pki.certificateToPem(c), names: ips.concat(hosts).sort().join(' ') };
}

// ips: this computer's addresses. Returns { key, cert } for the https server and the authority
// for the phones ({ pem, der, fingerprint }), making or renewing what's needed.
function ensure(dir, ips, log = () => {}) {
  const f = (n) => path.join(dir, n);
  const read = (n) => { try { return fs.readFileSync(f(n), 'utf8'); } catch (e) { return null; } };
  let ca = { key: read('workshop-ca.key'), cert: read('workshop-ca.crt') };
  if (!ca.key || !ca.cert) {
    ca = makeCA();
    fs.writeFileSync(f('workshop-ca.key'), ca.key, { mode: 0o600 });
    fs.writeFileSync(f('workshop-ca.crt'), ca.cert);
    log('made the workshop certificate authority (data/workshop-ca.crt): each phone trusts it once');
  }
  const host = os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const usable = ips.filter(isPrivate);
  const skipped = ips.filter((ip) => !isPrivate(ip));
  if (skipped.length) log('https: ' + skipped.join(', ') + ' left out (not a private network address)');
  const names = [...new Set(usable.concat('127.0.0.1'))].sort().concat(['localhost', host + '.local']).sort().join(' ');
  let leaf = { key: read('monitor.key'), cert: read('monitor.crt') };
  let fresh = false;
  if (leaf.key && leaf.cert) {
    try {
      const c = new crypto.X509Certificate(leaf.cert);
      const left = Date.parse(c.validTo) - Date.now();
      const has = (c.subjectAltName || '').split(', ').map((s) => s.replace(/^(DNS|IP Address):/, '')).sort().join(' ');
      fresh = left > 30 * DAY && has === names && c.checkIssued(new crypto.X509Certificate(ca.cert));
    } catch (e) { fresh = false; }
  }
  if (!fresh) {
    leaf = makeLeaf(ca, [...new Set(usable.concat('127.0.0.1'))], ['localhost', host + '.local']);
    fs.writeFileSync(f('monitor.key'), leaf.key, { mode: 0o600 });
    fs.writeFileSync(f('monitor.crt'), leaf.cert);
    log('made this computer\'s certificate for ' + names);
  }
  const x = new crypto.X509Certificate(ca.cert);
  return { key: leaf.key, cert: leaf.cert, ca: { pem: ca.cert, der: x.raw, fingerprint: x.fingerprint256 } };
}

// the authority as an iPhone profile: Settings shows "Pathline Monitor (workshop)"
function mobileconfig(ca) {
  const id = crypto.createHash('sha256').update(ca.der).digest('hex');
  const uuid = (n) => { const h = crypto.createHash('sha256').update(id + n).digest('hex'); return [h.slice(0, 8), h.slice(8, 12), '4' + h.slice(13, 16), '8' + h.slice(17, 20), h.slice(20, 32)].join('-').toUpperCase(); };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key><string>pathline-monitor-workshop.cer</string>
      <key>PayloadContent</key><data>${ca.der.toString('base64')}</data>
      <key>PayloadDescription</key><string>Lets this phone open Pathline Monitor securely on the workshop network. It can only vouch for addresses on private networks.</string>
      <key>PayloadDisplayName</key><string>Pathline Monitor workshop certificate</string>
      <key>PayloadIdentifier</key><string>com.pathline.monitor.workshop.${id.slice(0, 12)}.cert</string>
      <key>PayloadType</key><string>com.apple.security.root</string>
      <key>PayloadUUID</key><string>${uuid('cert')}</string>
      <key>PayloadVersion</key><integer>1</integer>
    </dict>
  </array>
  <key>PayloadDescription</key><string>Pathline Monitor on the workshop network: the machines' progress and queues, with alerts.</string>
  <key>PayloadDisplayName</key><string>Pathline Monitor (workshop)</string>
  <key>PayloadIdentifier</key><string>com.pathline.monitor.workshop.${id.slice(0, 12)}</string>
  <key>PayloadOrganization</key><string>Pathline Monitor</string>
  <key>PayloadRemovalDisallowed</key><false/>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadUUID</key><string>${uuid('profile')}</string>
  <key>PayloadVersion</key><integer>1</integer>
</dict>
</plist>
`;
}

module.exports = { ensure, mobileconfig, isPrivate };

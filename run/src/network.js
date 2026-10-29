// Pathline Run's own network address: the one Pathline connects to. Lists the
// network adapters and sets one to DHCP or a static IPv4 address.
//   Windows: netsh (changing it needs administrator rights: Windows asks on screen)
//   Linux / Raspberry Pi OS: NetworkManager (nmcli)
'use strict';

const os = require('os');
const { execFile } = require('child_process');

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { windowsHide: true, timeout: opts.timeout || 15000 }, (e, out, errOut) => {
    if (e) reject(Object.assign(new Error((errOut || out || e.message).toString().trim().split('\n').slice(-1)[0] || e.message), { code: 500 }));
    else resolve(String(out));
  });
});

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const maskToPrefix = (m) => m.split('.').reduce((n, o) => n + (Number(o) >>> 0).toString(2).split('1').length - 1, 0);
const prefixToMask = (p) => [24, 16, 8, 0].map((s) => ((p ? 0xffffffff << (32 - p) : 0) >>> s) & 0xff).join('.');
function validMask(m) {
  if (!IPV4.test(m)) return false;
  const bits = m.split('.').map((o) => Number(o).toString(2).padStart(8, '0')).join('');
  return /^1+0*$/.test(bits);
}

// [{ name, label, mode: 'dhcp' | 'static' | '', addresses: [{ ip, mask }], gateway, mac, up }]
async function list() {
  const nics = os.networkInterfaces();
  const fromOs = (name) => (nics[name] || []).filter((a) => a.family === 'IPv4' && !a.internal);
  const adapters = new Map();
  for (const [name, addrs] of Object.entries(nics)) {
    const v4 = addrs.filter((a) => a.family === 'IPv4' && !a.internal);
    if (v4.length) adapters.set(name, { name, label: name, mode: '', addresses: v4.map((a) => ({ ip: a.address, mask: a.netmask })), gateway: '', mac: v4[0].mac, up: true });
  }
  try {
    if (process.platform === 'win32') {
      // also lists adapters that are plugged in but have no address yet
      const out = await run('netsh', ['interface', 'ipv4', 'show', 'config']);
      for (const block of out.split(/\r?\n(?=Configuration for interface)/)) {
        const m = block.match(/Configuration for interface "(.+)"/);
        if (!m || /Loopback|Local Area Connection\*/i.test(m[1])) continue;
        const name = m[1];
        const a = adapters.get(name) || { name, label: name, addresses: fromOs(name).map((x) => ({ ip: x.address, mask: x.netmask })), gateway: '', mac: '', up: false };
        a.mode = /DHCP enabled:\s+Yes/i.test(block) ? 'dhcp' : 'static';
        const gw = block.match(/Default Gateway:\s+([\d.]+)/);
        if (gw) a.gateway = gw[1];
        adapters.set(name, a);
      }
    } else if (process.platform === 'linux') {
      const out = await run('nmcli', ['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device']);
      for (const line of out.trim().split('\n')) {
        const [dev, type, state, conn] = line.split(':');
        if (!/ethernet|wifi/.test(type)) continue;
        const a = adapters.get(dev) || { name: dev, label: dev, addresses: [], gateway: '', mac: '', up: false };
        a.label = dev + (type === 'wifi' ? ' (Wi-Fi)' : ' (Ethernet)');
        a.connection = conn || '';
        a.up = /connected/.test(state) && !/disconnected/.test(state);
        if (conn) {
          const info = await run('nmcli', ['-t', '-f', 'ipv4.method,ipv4.gateway', 'connection', 'show', conn]).catch(() => '');
          const method = (info.match(/ipv4\.method:(\w+)/) || [])[1];
          a.mode = method === 'manual' ? 'static' : method === 'auto' ? 'dhcp' : '';
          a.gateway = (info.match(/ipv4\.gateway:([\d.]+)/) || [])[1] || '';
        }
        adapters.set(dev, a);
      }
    }
  } catch (e) { /* the OS tool isn't there: the addresses from Node are still listed */ }
  return [...adapters.values()].sort((a, b) => Number(b.up) - Number(a.up) || a.name.localeCompare(b.name));
}

// The commands that set it, without running them (also used by the self-test).
// s: { adapter, mode: 'dhcp' | 'static', ip, mask, gateway, connection }
function commands(s, platform = process.platform) {
  if (!s || !s.adapter) throw Object.assign(new Error('Choose a network adapter'), { code: 400 });
  if (s.mode === 'static') {
    if (!IPV4.test(s.ip || '')) throw Object.assign(new Error('IP address must look like 192.168.1.40'), { code: 400 });
    if (!validMask(s.mask || '')) throw Object.assign(new Error('Subnet mask must look like 255.255.255.0'), { code: 400 });
    if (s.gateway && !IPV4.test(s.gateway)) throw Object.assign(new Error('Gateway must look like 192.168.1.1, or be empty'), { code: 400 });
  } else if (s.mode !== 'dhcp') throw Object.assign(new Error('Choose DHCP or Static'), { code: 400 });
  if (platform === 'win32') {
    const base = ['interface', 'ipv4', 'set', 'address', 'name=' + s.adapter];
    return [['netsh', s.mode === 'dhcp' ? base.concat('source=dhcp') : base.concat('source=static', 'address=' + s.ip, 'mask=' + s.mask).concat(s.gateway ? ['gateway=' + s.gateway] : ['gateway=none'])]];
  }
  const conn = s.connection || s.adapter;
  const mod = s.mode === 'dhcp'
    ? ['connection', 'modify', conn, 'ipv4.method', 'auto', 'ipv4.addresses', '', 'ipv4.gateway', '']
    : ['connection', 'modify', conn, 'ipv4.method', 'manual', 'ipv4.addresses', s.ip + '/' + maskToPrefix(s.mask), 'ipv4.gateway', s.gateway || ''];
  return [['nmcli', mod], ['nmcli', ['connection', 'up', conn]]];
}

async function apply(s) {
  const cmds = commands(s);
  if (process.platform === 'win32') {
    // netsh needs administrator rights: run it elevated (Windows shows its permission prompt)
    // Start-Process doesn't quote arguments, so values with spaces (name=Ethernet 2) are quoted here
    const [cmd, args] = cmds[0];
    const line = args.map((a) => (/\s/.test(a) ? a.replace(/^([^=]+)=(.*)$/, '$1="$2"') : a)).join(' ');
    const ps = 'try { $p = Start-Process -FilePath ' + cmd + " -ArgumentList '" + line.replace(/'/g, "''") + "' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode } catch { Write-Error 'Windows did not allow the change (administrator permission was refused)'; exit 5 }";
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 120000 });
  } else if (process.platform === 'linux') {
    for (const [cmd, args] of cmds) await run(cmd, args, { timeout: 30000 });
  } else {
    throw Object.assign(new Error('Setting the IP address isn\'t supported on this system'), { code: 409 });
  }
  return list();
}

module.exports = { list, apply, commands, maskToPrefix, prefixToMask, validMask };

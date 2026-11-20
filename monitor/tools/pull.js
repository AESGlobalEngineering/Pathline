#!/usr/bin/env node
// Pulls one thing from a machine through Pathline Monitor (lib/pulls.js) and unpacks it:
//
//   node monitor/tools/pull.js                         the machines, and whether each is listening
//   node monitor/tools/pull.js <machine> list          what it has: its days of logs, its jobs
//   node monitor/tools/pull.js <machine> log 2026-11-20
//   node monitor/tools/pull.js <machine> job J0123     the job's drawings and package
//   node monitor/tools/pull.js <machine> marks J0123   the camera's pictures of its marks
//   node monitor/tools/pull.js <machine> runs J0123    its run records (or a day: runs 2026-11-20)
//   node monitor/tools/pull.js <machine> fit | settings | health
//
// <machine> is its name as Pathline Monitor shows it ("Laser A"), or its id (run-3f9c2a71).
// Files go in pulled/<machine>/<what>[-<day or job>]/ (--out <folder> for another place); list
// and health are also printed.
//
// The server and the pull token: PATHLINE_MONITOR and PATHLINE_PULL_TOKEN, or a file pull.json
// { "address": "https://monitor.example.com", "token": "…" } in %APPDATA%\Pathline Monitor\
// (Windows) or ~/.config/pathline-monitor/. The token is in /etc/pathline-monitor/pull-token on
// the server. Node.js 18 or newer, no packages.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf('--' + k); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const OUT = opt('out');
const die = (s) => { console.error(s); process.exit(1); };

function settings() {
  const home = process.platform === 'win32' ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Pathline Monitor') : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'pathline-monitor');
  let f = {};
  try { f = JSON.parse(fs.readFileSync(path.join(home, 'pull.json'), 'utf8')); } catch (e) { /* not there */ }
  let address = String(process.env.PATHLINE_MONITOR || f.address || '').trim().replace(/\/+$/, '');
  const token = String(process.env.PATHLINE_PULL_TOKEN || f.token || '').trim();
  if (!address || !token) die('Set the Pathline Monitor address and the pull token: PATHLINE_MONITOR and PATHLINE_PULL_TOKEN, or ' + path.join(home, 'pull.json') + ' with { "address": "https://monitor.example.com", "token": "…" }.');
  if (!/^https?:\/\//.test(address)) address = 'https://' + address;
  return { address, token };
}

async function main() {
  const { address, token } = settings();
  const call = (route, data) => fetch(address + route, { method: data ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, ...(data ? { 'content-type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined });
  const errorOf = async (r) => { try { return (await r.json()).error || r.status; } catch (e) { return r.status; } };

  const [machine, what, arg] = args;
  if (!machine) {
    const r = await call('/api/pull/machines');
    if (r.status !== 200) die('Pathline Monitor: ' + await errorOf(r));
    const v = await r.json();
    for (const m of v.machines) console.log((m.listening ? 'listening  ' : m.reporting ? 'reporting  ' : 'off        ') + m.name.padEnd(24) + ' ' + m.id + (m.app ? '  ' + m.app : ''));
    if (!v.machines.length) console.log('No machines in Pathline Monitor yet.');
    console.log('\nAsk for: ' + Object.entries(v.what).map(([k, d]) => '\n  ' + k.padEnd(9) + d).join(''));
    return;
  }
  if (!what) die('What from ' + machine + '? list, log <day>, job <J…>, marks <J…>, runs <J… or day>, fit, settings, health');
  const ask = { machine, what };
  if (arg && /^\d{4}-\d{2}-\d{2}$/.test(arg)) ask.day = arg;
  else if (arg) ask.job = arg;
  let r = await call('/api/pull', ask);
  if (r.status !== 202) die('Pathline Monitor: ' + await errorOf(r));
  const a = await r.json();
  process.stderr.write('Asked ' + a.machine.name + ' for ' + what + (arg ? ' ' + arg : '') + (a.listening ? '' : ' (it isn\'t listening right now: the ask waits for it, a day at most)') + '…');
  // collect: the server holds each try up to 25 s
  for (;;) {
    r = await call('/api/pull/' + a.id);
    if (r.status !== 202) break;
    process.stderr.write('.');
  }
  process.stderr.write('\n');
  if (r.status !== 200) die(a.machine.name + ': ' + await errorOf(r));
  const bundle = JSON.parse(zlib.gunzipSync(Buffer.from(await r.arrayBuffer())).toString('utf8'));
  if (bundle.format !== 'pathline-run-pull') die('That isn\'t a Pathline Run answer');
  const dir = path.resolve(OUT || path.join('pulled', a.machine.name.replace(/[^\w.-]+/g, '-'), what + (arg ? '-' + arg : '')));
  fs.mkdirSync(dir, { recursive: true });
  for (const f of bundle.files) {
    // only names inside the folder (a file's name comes from the machine)
    const to = path.resolve(dir, String(f.name).replace(/\\/g, '/').split('/').filter((s) => s && s !== '.' && s !== '..').join(path.sep));
    if (!to.startsWith(dir + path.sep)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, Buffer.from(f.data, 'base64'));
    const t = Date.parse(f.mtime);
    if (Number.isFinite(t)) fs.utimesSync(to, new Date(t), new Date(t));
    if (what === 'list' || what === 'health') console.log(Buffer.from(f.data, 'base64').toString('utf8'));
  }
  console.log(bundle.files.length + (bundle.files.length === 1 ? ' file' : ' files') + ' from ' + a.machine.name + ' (Pathline Run ' + (bundle.app || '?') + ') in ' + dir);
}

main().catch((e) => die(e.message));

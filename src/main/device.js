// Link to the controller device that runs the machine (see PROTOCOL.md).
// Ethernet talks HTTP+JSON to the device. (Machines without a network link
// get their jobs saved locally instead — see deliver() in main.js.)
'use strict';

const API = '/api/v1';

function baseUrl(m) {
  const host = String(m.ip || '').trim();
  if (!host) throw new Error('No IP address set for ' + m.name);
  return 'http://' + host + ':' + (Number(m.port) || 8470) + API;
}

async function request(m, method, route, body) {
  const timeout = Math.max(300, Number(m.timeout) || 3000);
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(baseUrl(m) + route, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout)
    });
  } catch (err) {
    const why = err.name === 'TimeoutError' ? 'No response after ' + timeout + ' ms' : err.cause && err.cause.code === 'ECONNREFUSED' ? 'Connection refused' : (err.cause && err.cause.code) || err.message;
    const e = new Error(why);
    e.offline = true;
    throw e;
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
  if (!res.ok) throw new Error((data && data.error) || 'Device answered ' + res.status);
  return { data, ms: Date.now() - t0 };
}

const test = async (m) => {
  const { data, ms } = await request(m, 'GET', '/info');
  return { ok: true, ms, info: data };
};
const machineSettings = async (m) => (await request(m, 'GET', '/machine')).data;
const status = async (m) => (await request(m, 'GET', '/status')).data;

// Motion and I/O commands the Move panel and Machine menu use.
const COMMANDS = new Set(['jog', 'home', 'frame', 'io', 'stop', 'pause', 'resume', 'start', 'autofocus', 'testfire', 'feed', 'toolchange']);
async function command(m, cmd, args) {
  if (!COMMANDS.has(cmd)) throw new Error('Unknown command ' + cmd);
  return (await request(m, 'POST', '/' + cmd, args || {})).data;
}

const sendPackage = async (m, pkg) => (await request(m, 'POST', '/jobs', pkg)).data;

// The controller's own job queue.
const jobs = async (m) => (await request(m, 'GET', '/jobs')).data || [];
const removeJob = async (m, id) => (await request(m, 'DELETE', '/jobs/' + encodeURIComponent(id))).data;
const orderJobs = async (m, ids) => (await request(m, 'POST', '/jobs/order', { ids })).data;

// File/folder name without characters Windows refuses.
const safeName = (s) => String(s || 'job').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'job';

module.exports = { test, machineSettings, status, command, sendPackage, jobs, removeJob, orderJobs, safeName };

// What a Ruida's own settings mean for Pathline Run's setup (Setup → Read from controller).
// raw: values from link.readSettings() (µm, µm/s, µm/s², or null when it didn't answer).
'use strict';

const mm = (v) => (v === null || v === undefined ? null : v / 1000);
// a value we'd trust for a machine: positive and not absurd
const sane = (v, lo, hi) => v !== null && Number.isFinite(v) && v >= lo && v <= hi;

function interpret(raw) {
  const out = { rows: [], suggest: {} };
  const row = (label, value, unit, note) => out.rows.push({ label, value, unit: unit || '', note: note || '' });
  const rx = mm(raw.rangeX), ry = mm(raw.rangeY);
  if (sane(rx, 50, 10000) && sane(ry, 50, 10000)) {
    out.suggest.bed = [+rx.toFixed(1), +ry.toFixed(1)];
    row('Work area', rx.toFixed(1) + ' × ' + ry.toFixed(1), 'mm', 'X and Y range');
  } else row('Work area', 'not readable', '', 'X ' + raw.rangeX + ', Y ' + raw.rangeY);
  const vx = mm(raw.maxVelX), vy = mm(raw.maxVelY);
  if (sane(vx, 1, 5000) && sane(vy, 1, 5000)) {
    out.suggest.speed = Math.round(Math.min(vx, vy));
    row('Max speed', 'X ' + vx.toFixed(0) + ', Y ' + vy.toFixed(0), 'mm/s');
  }
  const ax = mm(raw.maxAccX), ay = mm(raw.maxAccY);
  if (sane(ax, 10, 200000) && sane(ay, 10, 200000)) {
    out.suggest.acc = Math.round(Math.min(ax, ay));
    row('Max acceleration', 'X ' + ax.toFixed(0) + ', Y ' + ay.toFixed(0), 'mm/s²');
  }
  if (sane(mm(raw.g0Vel), 1, 5000)) row('Travel speed (G0)', mm(raw.g0Vel).toFixed(0), 'mm/s');
  const ru = mm(raw.rangeU), vu = mm(raw.uWorkVel) || mm(raw.maxVelU);
  if (sane(ru, 1, 100000)) row('U axis (conveyor) range', ru.toFixed(1), 'mm');
  if (sane(vu, 1, 5000)) {
    out.suggest.feedSpeed = Math.round(vu);
    row('U axis (conveyor) speed', vu.toFixed(0), 'mm/s');
  }
  // output power limits (on a plotter: which outputs are in use)
  for (let k = 1; k <= 4; k++) {
    const lo = raw['out' + k + 'Min'], hi = raw['out' + k + 'Max'];
    if (lo !== null || hi !== null) row('Output ' + k + ' power', (lo === null ? '?' : lo) + ' – ' + (hi === null ? '?' : hi), 'raw');
  }
  if (raw.cardId !== null) row('Card ID', '0x' + Number(raw.cardId).toString(16).toUpperCase());
  if (raw.mainboard !== null) row('Mainboard version', '0x' + Number(raw.mainboard).toString(16).toUpperCase());
  if (raw.machineType !== null) row('Machine type', '0x' + Number(raw.machineType).toString(16).toUpperCase());
  return out;
}

module.exports = { interpret };

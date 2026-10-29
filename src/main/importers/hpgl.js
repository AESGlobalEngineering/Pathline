// HPGL / PLT import (plotter files): PU/PD/PA/PR with SP pen numbers mapped
// straight to colour indexes. 40 plotter units = 1 mm.
'use strict';

function importHpgl(text) {
  const raw = [];
  let x = 0, y = 0, down = false, rel = false, pen = 7;
  let cur = null;
  const flush = () => { if (cur && cur.pts.length > 1) raw.push(cur); cur = null; };
  const cmds = text.replace(/\r?\n/g, ';').split(';');
  for (let c of cmds) {
    c = c.trim();
    if (c.length < 2) continue;
    const op = c.slice(0, 2).toUpperCase();
    const nums = c.slice(2).split(/[\s,]+/).filter(Boolean).map(Number).filter((n) => !Number.isNaN(n));
    const moveSeq = () => {
      for (let k = 0; k + 1 < nums.length; k += 2) {
        const nx = rel ? x + nums[k] : nums[k], ny = rel ? y + nums[k + 1] : nums[k + 1];
        if (down) {
          if (!cur) cur = { pts: [[x / 40, y / 40]], closed: false, aci: pen, kind: 'Plot path' };
          cur.pts.push([nx / 40, ny / 40]);
        }
        x = nx; y = ny;
      }
    };
    switch (op) {
      case 'IN': flush(); x = y = 0; down = false; rel = false; break;
      case 'SP': flush(); pen = nums.length ? Math.max(1, Math.min(255, nums[0] || 7)) : 7; break;
      case 'PU': flush(); down = false; moveSeq(); break;
      case 'PD': down = true; moveSeq(); break;
      case 'PA': rel = false; moveSeq(); break;
      case 'PR': rel = true; moveSeq(); break;
      default: break;
    }
  }
  flush();
  return { raw, yUp: true, skipped: {} };
}

module.exports = { importHpgl };

// Shared post-processing for every importer: chain loose segments into
// contours, flip into job coordinates and wrap the result as entities.
'use strict';

const CC = require('../../shared/core');

const JOIN_TOL = 0.02; // mm — endpoints closer than this are treated as joined

// raw: [{ pts: [[x, y]...], closed, aci }] in source coordinates (any Y direction)
// Joins open pieces of the same colour end-to-end (CAD files often store one
// contour as dozens of separate LINE/ARC entities).
function joinPaths(raw, tol) {
  tol = tol || JOIN_TOL;
  const out = [];
  const byAci = new Map();
  for (const r of raw) {
    const pts = CC.cleanPath(r.pts, r.closed);
    if (pts.length < 2) continue;
    const closed = r.closed || CC.isClosedPts(pts, tol);
    const item = { pts: closed && CC.isClosedPts(pts, tol) ? pts.slice(0, -1) : pts, closed, aci: r.aci, layer: r.layer };
    if (item.closed) { out.push(item); continue; }
    if (!byAci.has(r.aci)) byAci.set(r.aci, []);
    byAci.get(r.aci).push(item);
  }

  const key = (p) => Math.round(p[0] / tol) + ',' + Math.round(p[1] / tol);
  for (const [aci, items] of byAci) {
    // endpoint index: grid cell -> list of [item, end]
    const grid = new Map();
    const add = (it, end) => {
      const p = end ? it.pts[it.pts.length - 1] : it.pts[0];
      const gx = Math.round(p[0] / tol), gy = Math.round(p[1] / tol);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const k = (gx + dx) + ',' + (gy + dy);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push([it, end]);
      }
    };
    items.forEach((it) => { add(it, 0); add(it, 1); });
    const used = new Set();
    const near = (p) => {
      for (const [it, end] of grid.get(key(p)) || []) {
        if (used.has(it)) continue;
        const q = end ? it.pts[it.pts.length - 1] : it.pts[0];
        if (Math.hypot(q[0] - p[0], q[1] - p[1]) <= tol) return [it, end];
      }
      return null;
    };
    for (const start of items) {
      if (used.has(start)) continue;
      used.add(start);
      let chain = start.pts.slice();
      // grow forwards, then backwards
      for (let dir = 0; dir < 2; dir++) {
        for (;;) {
          const tip = chain[chain.length - 1];
          const hit = near(tip);
          if (!hit) break;
          const [it, end] = hit;
          used.add(it);
          const seg = end ? it.pts.slice().reverse() : it.pts;
          chain = chain.concat(seg.slice(1));
        }
        chain.reverse();
      }
      const closed = CC.isClosedPts(chain, tol);
      out.push({ pts: closed ? chain.slice(0, -1) : chain, closed, aci, layer: start.layer });
    }
  }
  return out;
}

// Convert joined paths to job entities with the origin at the drawing's top
// left. yUp: source Y grows upwards (DXF, PDF, HPGL) and must be flipped.
function toEntities(paths, opts) {
  const { yUp, baseName } = opts || {};
  const b = CC.EMPTY_BOX();
  paths.forEach((p) => p.pts.forEach(([x, y]) => CC.growBox(b, x, y)));
  if (!CC.boxValid(b)) return { entities: [], width: 0, height: 0 };
  const map = yUp ? ([x, y]) => [x - b.x0, b.y1 - y] : ([x, y]) => [x - b.x0, y - b.y0];
  let n = 0;
  const entities = paths.map((p) => {
    const pts = p.pts.map(map);
    const eb = CC.EMPTY_BOX();
    pts.forEach(([x, y]) => CC.growBox(eb, x, y));
    const bw = eb.x1 - eb.x0, bh = eb.y1 - eb.y0;
    const kind = p.kind || (p.closed ? 'Closed path' : pts.length === 2 ? 'Line' : 'Open path');
    n++;
    return {
      id: CC.uid('e'),
      name: (p.name || kind) + ' ' + n,
      type: kind,
      aci: p.aci || 7,
      layer: p.layer || '',
      src: baseName || '',
      size: [bw, bh],
      paths: [{ p: pts, c: !!p.closed }]
    };
  });
  return { entities, width: b.x1 - b.x0, height: b.y1 - b.y0 };
}

module.exports = { joinPaths, toEntities, JOIN_TOL };

// DXF import: LINE, LWPOLYLINE/POLYLINE (with bulges), CIRCLE, ARC, ELLIPSE,
// SPLINE, POINT and block INSERTs, coloured by their AutoCAD Color Index.
'use strict';

const DxfParser = require('dxf-parser');
const CC = require('../../shared/core');

const UNIT_MM = { 0: 1, 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 8: 0.0000254, 9: 0.0254, 10: 914.4 };

// segments per full circle, scaled to radius so small holes stay smooth
const arcSteps = (r, sweep) => Math.max(4, Math.ceil((Math.abs(sweep) / (2 * Math.PI)) * Math.min(256, Math.max(24, r * 6))));

function arcPts(cx, cy, r, a0, a1) {
  let sweep = a1 - a0;
  if (sweep <= 0) sweep += Math.PI * 2;
  const n = arcSteps(r, sweep);
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

// Points along a bulged polyline segment (bulge = tan(included angle / 4)).
function bulgePts(p0, p1, bulge) {
  if (!bulge) return [p1];
  const theta = 4 * Math.atan(bulge);
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-9) return [p1];
  const r = chord / (2 * Math.sin(theta / 2));
  const mx = (p0[0] + p1[0]) / 2, my = (p0[1] + p1[1]) / 2;
  const h = r * Math.cos(theta / 2); // signed distance from chord midpoint to centre
  const cx = mx - (h * dy) / chord, cy = my + (h * dx) / chord;
  const a0 = Math.atan2(p0[1] - cy, p0[0] - cx);
  const n = arcSteps(Math.abs(r), theta);
  const out = [];
  for (let i = 1; i <= n; i++) {
    const a = a0 + (theta * i) / n;
    out.push([cx + Math.abs(r) * Math.cos(a), cy + Math.abs(r) * Math.sin(a)]);
  }
  out[out.length - 1] = p1;
  return out;
}

function polyPts(vertices, closed) {
  const v = vertices.map((q) => [q.x, q.y, q.bulge || 0]);
  if (!v.length) return [];
  const out = [[v[0][0], v[0][1]]];
  const n = closed ? v.length : v.length - 1;
  for (let i = 0; i < n; i++) {
    const a = v[i], b = v[(i + 1) % v.length];
    out.push(...bulgePts([a[0], a[1]], [b[0], b[1]], a[2]));
  }
  return out;
}

// Rational B-spline evaluation (de Boor).
function splinePts(e) {
  const cps = (e.controlPoints || []).map((p) => [p.x, p.y]);
  const deg = e.degreeOfSplineCurve || 3;
  if (cps.length < 2) return (e.fitPoints || []).map((p) => [p.x, p.y]);
  const knots = e.knotValues && e.knotValues.length === cps.length + deg + 1
    ? e.knotValues
    : Array.from({ length: cps.length + deg + 1 }, (_, i) => Math.min(Math.max(i - deg, 0), cps.length - deg));
  const w = e.weights && e.weights.length === cps.length ? e.weights : cps.map(() => 1);
  const evalAt = (t) => {
    let k = deg;
    while (k < cps.length - 1 && t >= knots[k + 1]) k++;
    const d = [];
    for (let j = 0; j <= deg; j++) {
      const i = k - deg + j;
      d.push([cps[i][0] * w[i], cps[i][1] * w[i], w[i]]);
    }
    for (let r = 1; r <= deg; r++) {
      for (let j = deg; j >= r; j--) {
        const i = k - deg + j;
        const den = knots[i + deg - r + 1] - knots[i];
        const a = den ? (t - knots[i]) / den : 0;
        d[j] = [0, 1, 2].map((c) => (1 - a) * d[j - 1][c] + a * d[j][c]);
      }
    }
    return [d[deg][0] / d[deg][2], d[deg][1] / d[deg][2]];
  };
  const t0 = knots[deg], t1 = knots[cps.length];
  const n = Math.max(16, (cps.length - deg) * 16);
  const out = [];
  for (let i = 0; i <= n; i++) out.push(evalAt(t0 + ((t1 - t0) * i) / n));
  return out;
}

function ellipsePts(e) {
  const cx = e.center.x, cy = e.center.y;
  const mx = e.majorAxisEndPoint.x, my = e.majorAxisEndPoint.y;
  const ratio = e.axisRatio || 1;
  const nx = -my * ratio, ny = mx * ratio;
  let a0 = e.startAngle || 0, a1 = e.endAngle === undefined ? Math.PI * 2 : e.endAngle;
  let sweep = a1 - a0;
  if (sweep <= 0) sweep += Math.PI * 2;
  const n = arcSteps(Math.hypot(mx, my), sweep);
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = a0 + (sweep * i) / n;
    out.push([cx + mx * Math.cos(t) + nx * Math.sin(t), cy + my * Math.cos(t) + ny * Math.sin(t)]);
  }
  return { pts: out, closed: Math.abs(sweep - Math.PI * 2) < 1e-6 };
}

function importDxf(text, opts) {
  const dxf = new DxfParser().parseSync(text);
  const scale = UNIT_MM[(dxf.header && dxf.header.$INSUNITS) || 0] || 1;
  const layers = (dxf.tables && dxf.tables.layer && dxf.tables.layer.layers) || {};
  const blocks = dxf.blocks || {};
  const raw = [];
  const skipped = {};

  const colourOf = (e, inherited) => {
    let n = e.colorIndex;
    if (n === undefined && typeof e.color === 'number' && e.color !== 16777215 && !(e.layer && layers[e.layer] && layers[e.layer].color === e.color)) {
      n = CC.rgbToAci([e.color >> 16, (e.color >> 8) & 255, e.color & 255]);
    }
    if (n === 0) return inherited || 7; // BYBLOCK
    if (n === undefined || n === 256) {
      const l = layers[e.layer];
      n = l && l.colorIndex ? l.colorIndex : inherited || 7;
    }
    return n;
  };

  const walk = (entities, xf, inheritedAci, depth) => {
    if (depth > 16) return;
    for (const e of entities) {
      const L = layers[e.layer];
      if (L && (L.visible === false || L.frozen)) continue;
      const aci = colourOf(e, inheritedAci);
      // OCS: arcs/circles/polylines with a flipped extrusion are mirrored in X
      const flip = e.extrusionDirectionZ < 0 || (e.extrusionDirection && e.extrusionDirection.z < 0);
      const ocs = (p) => (flip ? [-p[0], p[1]] : p);
      const emit = (pts, closed, kind) => {
        if (pts.length < 2) return;
        raw.push({ pts: pts.map((p) => xf(ocs(p))), closed, aci, layer: e.layer, kind });
      };
      switch (e.type) {
        case 'LINE':
          emit(e.vertices.map((v) => [v.x, v.y]), false, 'Line');
          break;
        case 'LWPOLYLINE':
        case 'POLYLINE': {
          if (e.is3dPolygonMesh || e.isPolyfaceMesh) { skipped[e.type + ' mesh'] = (skipped[e.type + ' mesh'] || 0) + 1; break; }
          const closed = !!(e.shape || e.closed);
          emit(polyPts(e.vertices || [], closed), closed, closed ? 'Closed path' : 'Polyline');
          break;
        }
        case 'CIRCLE':
          emit(arcPts(e.center.x, e.center.y, e.radius, 0, Math.PI * 2).slice(0, -1), true, 'Circle');
          break;
        case 'ARC':
          emit(arcPts(e.center.x, e.center.y, e.radius, e.startAngle, e.endAngle), false, 'Arc');
          break;
        case 'ELLIPSE': {
          const r = ellipsePts(e);
          emit(r.closed ? r.pts.slice(0, -1) : r.pts, r.closed, 'Ellipse');
          break;
        }
        case 'SPLINE': {
          const pts = splinePts(e);
          emit(pts, !!e.closed, 'Spline');
          break;
        }
        case 'POINT':
          // a single point has no length; skip it rather than invent geometry
          skipped.POINT = (skipped.POINT || 0) + 1;
          break;
        case 'SOLID':
        case '3DFACE': {
          const pts = (e.points || e.vertices || []).map((v) => [v.x, v.y]);
          if (pts.length >= 3) emit(pts, true, 'Solid');
          break;
        }
        case 'INSERT': {
          const blk = blocks[e.name];
          if (!blk || !blk.entities) break;
          const bx = (blk.position && blk.position.x) || 0, by = (blk.position && blk.position.y) || 0;
          const sx = e.xScale === undefined ? 1 : e.xScale, sy = e.yScale === undefined ? 1 : e.yScale;
          const rot = ((e.rotation || 0) * Math.PI) / 180, c = Math.cos(rot), s = Math.sin(rot);
          const px = e.position.x, py = e.position.y;
          const cols = Math.max(1, e.columnCount || 1), rows = Math.max(1, e.rowCount || 1);
          for (let ci = 0; ci < cols; ci++) for (let ri = 0; ri < rows; ri++) {
            const ox = ci * (e.columnSpacing || 0), oy = ri * (e.rowSpacing || 0);
            const inner = ([x, y]) => {
              const lx = (x - bx) * sx + ox, ly = (y - by) * sy + oy;
              return xf([px + lx * c - ly * s, py + lx * s + ly * c]);
            };
            walk(blk.entities, inner, aci, depth + 1);
          }
          break;
        }
        default:
          skipped[e.type] = (skipped[e.type] || 0) + 1;
      }
    }
  };
  walk(dxf.entities || [], ([x, y]) => [x * scale, y * scale], 7, 0);
  return { raw, yUp: true, skipped, units: scale === 1 ? 'mm' : scale === 25.4 ? 'in' : String(scale) + ' mm/unit' };
}

module.exports = { importDxf, splinePts, polyPts };

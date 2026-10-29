// SVG import: path/rect/circle/ellipse/line/polyline/polygon/use with nested
// transforms. Stroke colour (or fill when there is no stroke) picks the ACI.
'use strict';

const { DOMParser } = require('@xmldom/xmldom');
const CC = require('../../shared/core');

const NAMED = {
  black: '#000000', white: '#FFFFFF', red: '#FF0000', lime: '#00FF00', green: '#008000', blue: '#0000FF',
  yellow: '#FFFF00', cyan: '#00FFFF', aqua: '#00FFFF', magenta: '#FF00FF', fuchsia: '#FF00FF', gray: '#808080',
  grey: '#808080', silver: '#C0C0C0', orange: '#FFA500', purple: '#800080', navy: '#000080', maroon: '#800000'
};
function parseColour(v) {
  if (!v) return null;
  v = String(v).trim().toLowerCase();
  if (v === 'none' || v === 'transparent') return null;
  if (NAMED[v]) return CC.hexToRgb(NAMED[v]);
  if (v[0] === '#') return CC.hexToRgb(v);
  const m = v.match(/rgba?\(([^)]+)\)/);
  if (m) {
    return m[1].split(/[ ,/]+/).slice(0, 3).map((s) => (s.endsWith('%') ? Math.round(parseFloat(s) * 2.55) : Math.round(parseFloat(s))));
  }
  return [0, 0, 0];
}

// --- 2D affine matrices [a b c d e f]
const I = [1, 0, 0, 1, 0, 0];
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]
];
const apply = (m, [x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
function parseTransform(s) {
  let m = I;
  if (!s) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let r;
  while ((r = re.exec(s))) {
    const a = r[2].split(/[\s,]+/).filter(Boolean).map(Number);
    let t = I;
    switch (r[1]) {
      case 'matrix': t = a.slice(0, 6); break;
      case 'translate': t = [1, 0, 0, 1, a[0] || 0, a[1] || 0]; break;
      case 'scale': t = [a[0], 0, 0, a[1] === undefined ? a[0] : a[1], 0, 0]; break;
      case 'rotate': {
        const k = ((a[0] || 0) * Math.PI) / 180, c = Math.cos(k), sn = Math.sin(k);
        t = [c, sn, -sn, c, 0, 0];
        if (a.length >= 3) t = mul(mul([1, 0, 0, 1, a[1], a[2]], t), [1, 0, 0, 1, -a[1], -a[2]]);
        break;
      }
      case 'skewX': t = [1, 0, Math.tan(((a[0] || 0) * Math.PI) / 180), 1, 0, 0]; break;
      case 'skewY': t = [1, Math.tan(((a[0] || 0) * Math.PI) / 180), 0, 1, 0, 0]; break;
    }
    m = mul(m, t);
  }
  return m;
}

// --- path data → polylines
function tokenize(d) {
  const out = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)/g;
  let r;
  while ((r = re.exec(d))) out.push(r[1] || Number(r[2]));
  return out;
}
const CURVE_STEPS = 16;
function pathToPolys(d) {
  const tk = tokenize(d);
  const polys = [];
  let cur = null, x = 0, y = 0, sx = 0, sy = 0, cmd = null, lcx = 0, lcy = 0, lastCmd = '';
  let i = 0;
  const num = () => tk[i++];
  const has = () => i < tk.length && typeof tk[i] === 'number';
  const start = () => { if (cur && cur.pts.length > 1) polys.push(cur); cur = { pts: [[x, y]], closed: false }; };
  const lineTo = (nx, ny) => { if (!cur) start(); cur.pts.push([nx, ny]); x = nx; y = ny; };
  const cubic = (x1, y1, x2, y2, x3, y3) => {
    const x0 = x, y0 = y;
    for (let k = 1; k <= CURVE_STEPS; k++) {
      const t = k / CURVE_STEPS, u = 1 - t;
      lineTo(u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3);
    }
  };
  const quad = (x1, y1, x2, y2) => {
    const x0 = x, y0 = y;
    for (let k = 1; k <= CURVE_STEPS; k++) {
      const t = k / CURVE_STEPS, u = 1 - t;
      lineTo(u * u * x0 + 2 * u * t * x1 + t * t * x2, u * u * y0 + 2 * u * t * y1 + t * t * y2);
    }
  };
  const arc = (rx, ry, phi, fa, fs, x2, y2) => {
    const x1 = x, y1 = y;
    if (!rx || !ry) return lineTo(x2, y2);
    rx = Math.abs(rx); ry = Math.abs(ry);
    const p = (phi * Math.PI) / 180, cp = Math.cos(p), sp = Math.sin(p);
    const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
    const x1p = cp * dx + sp * dy, y1p = -sp * dx + cp * dy;
    const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
    const sgn = fa === fs ? -1 : 1;
    const num2 = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    const coef = sgn * Math.sqrt(Math.max(0, num2 / (rx * rx * y1p * y1p + ry * ry * x1p * x1p)));
    const cxp = (coef * rx * y1p) / ry, cyp = (-coef * ry * x1p) / rx;
    const cx = cp * cxp - sp * cyp + (x1 + x2) / 2, cy = sp * cxp + cp * cyp + (y1 + y2) / 2;
    const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if (!fs && dt > 0) dt -= 2 * Math.PI;
    if (fs && dt < 0) dt += 2 * Math.PI;
    const n = Math.max(4, Math.ceil((Math.abs(dt) / (Math.PI * 2)) * 64));
    for (let k = 1; k <= n; k++) {
      const t = t1 + (dt * k) / n;
      lineTo(cx + rx * Math.cos(t) * cp - ry * Math.sin(t) * sp, cy + rx * Math.cos(t) * sp + ry * Math.sin(t) * cp);
    }
  };
  while (i < tk.length) {
    if (typeof tk[i] === 'string') cmd = tk[i++];
    else if (!cmd) { i++; continue; }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    switch (C) {
      case 'M': {
        x = ox + num(); y = oy + num();
        start(); sx = x; sy = y;
        cmd = rel ? 'l' : 'L';
        break;
      }
      case 'L': lineTo(ox + num(), oy + num()); break;
      case 'H': lineTo(ox + num(), y); break;
      case 'V': lineTo(x, oy + num()); break;
      case 'C': {
        const a = [num(), num(), num(), num(), num(), num()];
        cubic(ox + a[0], oy + a[1], ox + a[2], oy + a[3], ox + a[4], oy + a[5]);
        lcx = ox + a[2]; lcy = oy + a[3];
        break;
      }
      case 'S': {
        const a = [num(), num(), num(), num()];
        const r = 'CS'.includes(lastCmd);
        const x1 = r ? 2 * x - lcx : x, y1 = r ? 2 * y - lcy : y;
        cubic(x1, y1, ox + a[0], oy + a[1], ox + a[2], oy + a[3]);
        lcx = ox + a[0]; lcy = oy + a[1];
        break;
      }
      case 'Q': {
        const a = [num(), num(), num(), num()];
        quad(ox + a[0], oy + a[1], ox + a[2], oy + a[3]);
        lcx = ox + a[0]; lcy = oy + a[1];
        break;
      }
      case 'T': {
        const a = [num(), num()];
        const r = 'QT'.includes(lastCmd);
        const x1 = r ? 2 * x - lcx : x, y1 = r ? 2 * y - lcy : y;
        quad(x1, y1, ox + a[0], oy + a[1]);
        lcx = x1; lcy = y1;
        break;
      }
      case 'A': {
        const a = [num(), num(), num(), num(), num(), num(), num()];
        arc(a[0], a[1], a[2], a[3], a[4], ox + a[5], oy + a[6]);
        break;
      }
      case 'Z':
        if (cur) { cur.closed = true; polys.push(cur); cur = null; }
        x = sx; y = sy;
        break;
      default:
        i++;
    }
    lastCmd = C;
    if (C === 'Z') { cmd = null; continue; }
    // numbers straight after a command repeat it; otherwise read the next command
    if (!has() && typeof tk[i] !== 'string') break;
  }
  if (cur && cur.pts.length > 1) polys.push(cur);
  return polys;
}

// Length attribute → user units (px at 96 dpi) for width/height handling.
function lengthMm(v) {
  if (v === null || v === undefined || v === '') return null;
  const m = String(v).trim().match(/^([-+]?[\d.]+(?:e[-+]?\d+)?)\s*(mm|cm|in|pt|pc|px|%)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return { mm: n, cm: n * 10, in: n * 25.4, pt: (n * 25.4) / 72, pc: (n * 25.4) / 6, px: (n * 25.4) / 96, '%': null }[(m[2] || 'px').toLowerCase()];
}

function styleOf(el) {
  const out = {};
  for (const k of ['stroke', 'fill', 'display', 'visibility']) {
    const v = el.getAttribute && el.getAttribute(k);
    if (v) out[k] = v;
  }
  const st = el.getAttribute && el.getAttribute('style');
  if (st) st.split(';').forEach((kv) => {
    const [k, v] = kv.split(':').map((s) => s && s.trim());
    if (k && v) out[k] = v;
  });
  return out;
}

function importSvg(text) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const svg = doc.documentElement;
  const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
  const wMm = lengthMm(svg.getAttribute('width')), hMm = lengthMm(svg.getAttribute('height'));
  let root = [25.4 / 96, 0, 0, 25.4 / 96, 0, 0];
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
    const sx = wMm ? wMm / vb[2] : 25.4 / 96, sy = hMm ? hMm / vb[3] : sx;
    root = [sx, 0, 0, sy, -vb[0] * sx, -vb[1] * sy];
  }
  const byId = {};
  const index = (el) => {
    if (el.nodeType !== 1) return;
    const id = el.getAttribute('id');
    if (id) byId[id] = el;
    for (let c = el.firstChild; c; c = c.nextSibling) index(c);
  };
  index(svg);

  const raw = [];
  const num = (el, k) => parseFloat(el.getAttribute(k)) || 0;
  const visit = (el, m, inh, depth, viaUse) => {
    if (el.nodeType !== 1 || depth > 32) return;
    const tag = el.localName || el.nodeName;
    if (tag === 'symbol' && !viaUse) return;
    if (['defs', 'clipPath', 'mask', 'title', 'desc', 'metadata', 'style', 'pattern', 'marker', 'text'].includes(tag) && depth > 0) return;
    const st = { ...inh, ...styleOf(el) };
    if (st.display === 'none' || st.visibility === 'hidden') return;
    const mm = mul(m, parseTransform(el.getAttribute('transform')));
    const col = parseColour(st.stroke) || parseColour(st.fill === undefined ? 'black' : st.fill);
    const aci = col ? CC.rgbToAci(col) : 7;
    const emit = (polys, kind) => polys.forEach((p) => raw.push({ pts: p.pts.map((q) => apply(mm, q)), closed: p.closed, aci, kind }));
    switch (tag) {
      case 'svg': case 'g': case 'a': case 'switch': case 'symbol':
        for (let c = el.firstChild; c; c = c.nextSibling) visit(c, mm, st, depth + 1);
        break;
      case 'use': {
        const href = (el.getAttribute('href') || el.getAttribute('xlink:href') || '').replace(/^#/, '');
        const target = byId[href];
        if (target) visit(target, mul(mm, [1, 0, 0, 1, num(el, 'x'), num(el, 'y')]), st, depth + 1, true);
        break;
      }
      case 'path': emit(pathToPolys(el.getAttribute('d') || ''), 'Path'); break;
      case 'rect': {
        const w = num(el, 'width'), h = num(el, 'height');
        if (w > 0 && h > 0) emit([{ pts: CC.shapes.rect(num(el, 'x'), num(el, 'y'), w, h, num(el, 'rx') || num(el, 'ry')), closed: true }], 'Rectangle');
        break;
      }
      case 'circle': {
        const r = num(el, 'r');
        if (r > 0) emit([{ pts: CC.shapes.ellipse(num(el, 'cx'), num(el, 'cy'), r, r), closed: true }], 'Circle');
        break;
      }
      case 'ellipse': {
        const rx = num(el, 'rx'), ry = num(el, 'ry');
        if (rx > 0 && ry > 0) emit([{ pts: CC.shapes.ellipse(num(el, 'cx'), num(el, 'cy'), rx, ry), closed: true }], 'Ellipse');
        break;
      }
      case 'line': emit([{ pts: [[num(el, 'x1'), num(el, 'y1')], [num(el, 'x2'), num(el, 'y2')]], closed: false }], 'Line'); break;
      case 'polyline': case 'polygon': {
        const n = (el.getAttribute('points') || '').split(/[\s,]+/).filter(Boolean).map(Number);
        const pts = [];
        for (let k = 0; k + 1 < n.length; k += 2) pts.push([n[k], n[k + 1]]);
        emit([{ pts, closed: tag === 'polygon' }], tag === 'polygon' ? 'Polygon' : 'Polyline');
        break;
      }
    }
  };
  visit(svg, root, {}, 0);
  return { raw, yUp: false, skipped: {} };
}

module.exports = { importSvg, pathToPolys };
